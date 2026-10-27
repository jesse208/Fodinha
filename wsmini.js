'use strict';
// Servidor WebSocket minimo (RFC 6455), sem dependencias. So frames de texto, ping/pong e close.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 16 * 1024;

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  return Buffer.concat([head, payload]);
}

class Conn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.readyState = 1; // 1 aberto, 2 fechando, 3 fechado
    this.frag = null;
    this.fragOp = 0;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => {});
  }
  send(str) {
    if (this.readyState !== 1) return;
    this.socket.write(frame(0x1, Buffer.from(str, 'utf8')));
  }
  ping() {
    if (this.readyState !== 1) return;
    this.socket.write(frame(0x9, Buffer.alloc(0)));
  }
  close(code) {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code || 1000, 0);
    try { this.socket.write(frame(0x8, p)); this.socket.end(); } catch (e) {}
    setTimeout(() => { try { this.socket.destroy(); } catch (e) {} }, 1500).unref();
  }
  terminate() { this.readyState = 3; try { this.socket.destroy(); } catch (e) {} }
  _closed() {
    if (this.readyState === 3 && this._emittedClose) return;
    this.readyState = 3;
    if (!this._emittedClose) { this._emittedClose = true; this.emit('close'); }
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) !== 0) return this.close(1009);
        len = this.buf.readUInt32BE(6); off = 10;
      }
      if (!masked) return this.close(1002);
      if (len > MAX_PAYLOAD) return this.close(1009);
      const total = off + 4 + len;
      if (this.buf.length < total) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, total));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(total);
      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { if (this.readyState === 1) this.socket.write(frame(0xA, payload)); continue; }
      if (op === 0xA) { this.emit('pong'); continue; }
      if (op === 0x1 || op === 0x2) { this.frag = [payload]; this.fragOp = op; }
      else if (op === 0x0 && this.frag) { this.frag.push(payload); }
      else return this.close(1002);
      if (fin) {
        const whole = Buffer.concat(this.frag);
        this.frag = null;
        if (this.fragOp === 0x1) this.emit('message', whole.toString('utf8'));
      }
    }
  }
}

function attach(server, path, onConnection) {
  server.on('upgrade', (req, socket) => {
    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (url !== path || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    onConnection(new Conn(socket), req);
  });
}

module.exports = { attach };
