'use strict';
/*
 * Fodinha online: servidor HTTP + WebSocket sem dependencias.
 * O servidor e quem embaralha, distribui e valida tudo. Cada jogador recebe so as
 * cartas que pode ver, entao ninguem consegue espiar a mao dos outros.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wsmini = require('./wsmini');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SPEED = Math.max(1, +process.env.FODINHA_SPEED || 1); // so para testes: acelera os tempos dos bots

/* ------------------------------------------------------------------ contas */
let users = {};               // nome em minusculas -> registro
const sessions = new Map();   // token -> { key, name, guest }
const NAME_RE = /^[\p{L}\p{N}_ -]{2,14}$/u;

function loadUsers() {
  try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { users = {}; }
  for (const k of Object.keys(users)) {
    (users[k].tokens || []).forEach((t) => sessions.set(t, { key: 'u:' + k, name: users[k].name, guest: false }));
  }
}
let saveTimer = null;
function saveUsers() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = USERS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(users));
      fs.renameSync(tmp, USERS_FILE);
    } catch (e) { console.error('Nao consegui salvar as contas:', e.message); }
  }, 300);
}
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }
function newToken() { return crypto.randomBytes(24).toString('hex'); }

function authenticate(msg) {
  const name = String(msg.name || '').trim().replace(/\s+/g, ' ');
  if (msg.mode !== 'resume' && !NAME_RE.test(name)) {
    return { error: 'Use de 2 a 14 letras, números, espaço, _ ou -.' };
  }
  if (msg.mode === 'guest') {
    const token = newToken();
    const s = { key: 'g:' + crypto.randomUUID(), name, guest: true };
    sessions.set(token, s);
    return { token, session: s };
  }
  if (msg.mode === 'register') {
    const pw = String(msg.password || '');
    if (pw.length < 4 || pw.length > 64) return { error: 'A senha precisa ter de 4 a 64 caracteres.' };
    const k = name.toLowerCase();
    if (users[k]) return { error: 'Esse nome já tem conta. Entre com a senha.' };
    const salt = crypto.randomBytes(16).toString('hex');
    const token = newToken();
    users[k] = { name, salt, hash: hashPw(pw, salt), tokens: [token], wins: 0, games: 0 };
    saveUsers();
    const s = { key: 'u:' + k, name, guest: false };
    sessions.set(token, s);
    return { token, session: s };
  }
  if (msg.mode === 'login') {
    const k = name.toLowerCase();
    const u = users[k];
    const pw = String(msg.password || '');
    if (!u) return { error: 'Nome ou senha incorretos.' };
    const a = Buffer.from(hashPw(pw, u.salt), 'hex');
    const b = Buffer.from(u.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'Nome ou senha incorretos.' };
    const token = newToken();
    u.tokens = (u.tokens || []).concat(token).slice(-5);
    saveUsers();
    const s = { key: 'u:' + k, name: u.name, guest: false };
    sessions.set(token, s);
    return { token, session: s };
  }
  if (msg.mode === 'resume') {
    const s = sessions.get(String(msg.token || ''));
    if (!s) return { error: 'Sessão expirada. Entre de novo.', expired: true };
    return { token: msg.token, session: s };
  }
  return { error: 'Pedido inválido.' };
}
function statsOf(session) {
  if (session.guest) return null;
  const u = users[session.key.slice(2)];
  return u ? { wins: u.wins || 0, games: u.games || 0 } : null;
}

// limite simples de tentativas de login por IP
const authHits = new Map();
function authAllowed(ip) {
  const now = Date.now();
  const h = authHits.get(ip) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  h.n++;
  authHits.set(ip, h);
  return h.n <= 20;
}

/* ------------------------------------------------------------- baralho/regras */
const DECK = [];
for (let r = 0; r < 10; r++) for (let s = 0; s < 4; s++) DECK.push({ r, s, id: r + '-' + s });
const BOT_POOL = ['Zeca', 'Neca', 'Tonho', 'Cida', 'Bento', 'Juca', 'Lurdes', 'Tião'];
const EMOJIS = ['🐔', '😂', '👏', '😡', '🔥', '💀', '😎', '🤝', '🙏', '😭'];
const MAX_PLAYERS = 6;

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------------------------------------------------------------------- salas */
const rooms = new Map();      // codigo -> Room
const userRoom = new Map();   // chave do usuario -> Room

function newCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += L[crypto.randomInt(L.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

class Room {
  constructor(code) {
    this.code = code;
    this.members = [];
    this.hostId = null;
    this.settings = { lives: 3, manilha: true, money: 50, bots: 0 };
    this.phase = 'lobby';
    this.G = null;
    this.chat = [];
    this.seq = 0;
    this.memberSeq = 0;
    this.gen = 0;
    this.timers = new Set();
    this.paused = null;
    this.lastActive = Date.now();
  }

  /* ---------- membros ---------- */
  touch() { this.lastActive = Date.now(); }
  humans() { return this.members.filter((m) => !m.left); }
  hostMember() { return this.members.find((m) => m.id === this.hostId) || null; }
  maxBots() { return Math.max(0, MAX_PLAYERS - this.humans().length); }

  addMember(session) {
    let name = session.name, i = 2;
    const taken = (n) => this.members.some((m) => !m.left && m.name.toLowerCase() === n.toLowerCase());
    while (taken(name)) name = session.name + ' ' + i++;
    const m = { id: 'u' + (++this.memberSeq), key: session.key, name, guest: session.guest, ws: null, connected: false, left: false, discAt: 0 };
    this.members.push(m);
    if (!this.hostId) this.hostId = m.id;
    if (this.settings.bots > this.maxBots()) this.settings.bots = this.maxBots();
    return m;
  }
  removeMember(m) {
    if (this.phase === 'lobby') this.members = this.members.filter((x) => x !== m);
    else m.left = true;
    if (this.hostId === m.id) {
      const next = this.humans()[0];
      this.hostId = next ? next.id : null;
    }
    if (this.settings.bots > this.maxBots()) this.settings.bots = this.maxBots();
  }

  send(m, obj) { if (m.ws && m.ws.readyState === 1) m.ws.send(JSON.stringify(obj)); }
  broadcast() { this.members.forEach((m) => this.send(m, this.view(m))); }
  pushChat(msg) {
    msg.id = ++this.seq; msg.ts = Date.now();
    this.chat.push(msg);
    if (this.chat.length > 60) this.chat.shift();
    this.members.forEach((m) => this.send(m, { t: 'chat', m: msg }));
  }
  sys(text) { this.pushChat({ sys: true, text }); }

  /* ---------- relogio (respeita a pausa) ---------- */
  later(ms, fn) {
    const t = { ms: Math.max(1, Math.round(ms / SPEED)), fn, id: null, g: this.gen };
    this.timers.add(t);
    if (!this.paused) this._arm(t);
  }
  _arm(t) {
    t.id = setTimeout(() => {
      this.timers.delete(t);
      if (t.g !== this.gen) return;
      try { t.fn(); } catch (e) { console.error('erro no timer da sala', this.code, e); }
    }, t.ms);
  }
  clearTimers() { this.gen++; this.timers.forEach((t) => clearTimeout(t.id)); this.timers.clear(); }

  setPause(info) {
    this.paused = info;
    this.timers.forEach((t) => clearTimeout(t.id));
  }
  clearPause() {
    this.paused = null;
    this.timers.forEach((t) => this._arm(t));
  }
  checkAutoPause() {
    if (this.phase !== 'game' || !this.G || this.G.phase === 'gameOver') return;
    const online = this.humans().filter((m) => m.connected).length;
    if (online === 0 && !this.paused) this.setPause({ auto: true, by: null, byId: null });
    else if (online > 0 && this.paused && this.paused.auto) { this.clearPause(); this.schedule(); }
  }

  /* ---------- visao de cada jogador ---------- */
  view(m) {
    const G = this.G;
    const out = {
      t: 'room', code: this.code, phase: this.phase, hostId: this.hostId, meId: m.id,
      settings: this.settings, maxBots: this.maxBots(),
      members: this.members.filter((x) => !x.left).map((x) => ({ id: x.id, name: x.name, connected: x.connected, guest: x.guest })),
      game: null
    };
    if (this.phase !== 'game' || !G) return out;
    const blindNow = G.nCards === 1 && (G.phase === 'betting' || G.phase === 'playing');
    const meP = G.players.find((p) => p.member === m);
    const curP = G.players[G.turn];
    out.game = {
      round: G.round, nCards: G.nCards, blind: G.nCards === 1,
      vira: G.vira, manilhaR: G.manilha ? G.manilhaR : -1,
      phase: G.phase, turn: curP ? curP.id : null, dealer: G.players[G.dealer].id,
      pot: G.pot, lives: G.lives,
      players: G.players.map((p) => {
        const isMe = p.member === m;
        let hand = null;
        if (p.inRound && p.hand.length) {
          if (isMe) hand = blindNow ? p.hand.map((c) => ({ id: c.id })) : p.hand;
          else if (blindNow) hand = p.hand;
        }
        return {
          id: p.id, name: p.name, bot: p.bot, connected: this.isConnected(p), lives: p.lives, alive: p.alive,
          money: p.money, bet: p.bet, wager: p.wager, won: p.won, inRound: p.inRound,
          handCount: p.hand.length, hand
        };
      }),
      table: G.table.map((t) => ({ pid: G.players[t.pi].id, card: t.card })),
      trickInfo: G.trickInfo, fresh: G.fresh,
      forbidden: (G.phase === 'betting' && meP && curP === meP) ? this.forbiddenBet() : -1,
      wagerOptions: meP ? this.wagerOptions(meP) : [0],
      summary: (G.phase === 'roundEnd' || G.phase === 'gameOver') ? G.summary : null,
      winners: G.winners.map((p) => p.id),
      paused: this.paused ? {
        by: this.paused.by, auto: !!this.paused.auto,
        canResume: !!this.paused.auto || m.id === this.paused.byId || m.id === this.hostId || !this.members.some((x) => x.id === this.paused.byId && x.connected && !x.left)
      } : null
    };
    return out;
  }
  isConnected(p) { return p.bot ? true : !!(p.member && p.member.connected && !p.member.left); }
  botCtl(p) { return p.bot || !p.member || !p.member.connected || p.member.left; }

  /* ---------- sala: acoes do anfitriao ---------- */
  setSettings(m, s) {
    if (m.id !== this.hostId || this.phase !== 'lobby') return 'Só o anfitrião muda isso.';
    if (s.lives === 3 || s.lives === 5) this.settings.lives = s.lives;
    if (typeof s.manilha === 'boolean') this.settings.manilha = s.manilha;
    if ([20, 50, 100].includes(s.money)) this.settings.money = s.money;
    if (Number.isInteger(s.bots)) this.settings.bots = Math.max(0, Math.min(this.maxBots(), s.bots));
    this.broadcast();
    return null;
  }
  start(m) {
    if (m.id !== this.hostId || this.phase !== 'lobby') return 'Só o anfitrião começa a partida.';
    const humans = this.humans();
    const bots = Math.min(this.settings.bots, this.maxBots());
    if (humans.length + bots < 2) return 'Precisa de pelo menos 2 jogadores. Adicione bots ou chame amigos.';
    const used = new Set(humans.map((h) => h.name.toLowerCase()));
    const botNames = BOT_POOL.filter((n) => !used.has(n.toLowerCase())).slice(0, bots);
    const mk = (id, name, bot, member) => ({
      id, name, bot, member, lives: this.settings.lives, alive: true, money: this.settings.money,
      hand: [], bet: null, wager: 0, won: 0, inRound: false, lost: 0, delta: 0
    });
    const players = shuffle([
      ...humans.map((h) => mk(h.id, h.name, false, h)),
      ...botNames.map((n, i) => mk('b' + (i + 1), n, true, null))
    ]);
    this.clearTimers();
    this.paused = null;
    this.phase = 'game';
    this.G = {
      players, manilha: this.settings.manilha, lives: this.settings.lives,
      dealer: crypto.randomInt(players.length), round: 0, nCards: 1, dir: 1, vira: null, manilhaR: -1,
      phase: 'betting', turn: 0, leader: 0, table: [], trickNo: 0, betOrder: [], betIdx: 0,
      trickInfo: null, fresh: null, winners: [], pot: 0, summary: null, sched: ''
    };
    this.sys('A partida começou. Boa sorte!');
    this.startRound(true);
    return null;
  }
  backToLobby(m) {
    if (m.id !== this.hostId || this.phase !== 'game' || !this.G || this.G.phase !== 'gameOver') return 'Só o anfitrião volta para a sala.';
    this.clearTimers();
    this.phase = 'lobby'; this.G = null; this.paused = null;
    this.members = this.members.filter((x) => !x.left);
    this.broadcast();
    return null;
  }
  leave(m) {
    const inGame = this.phase === 'game';
    this.sys(m.name + ' saiu da sala.');
    this.removeMember(m);
    if (!this.humans().length) { this.destroy(); return; }
    if (inGame) { this.checkAutoPause(); this.after(); } else this.broadcast();
  }
  destroy() {
    this.clearTimers();
    this.members.forEach((m) => userRoom.delete(m.key));
    rooms.delete(this.code);
  }

  /* ---------- chat, emoji, pausa ---------- */
  say(m, text) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    this.touch();
    this.pushChat({ from: m.id, name: m.name, text });
  }
  react(m, e) {
    if (!EMOJIS.includes(e)) return;
    this.touch();
    this.members.forEach((x) => this.send(x, { t: 'emoji', from: m.id, name: m.name, e }));
  }
  pause(m) {
    if (this.phase !== 'game' || !this.G || this.G.phase === 'gameOver' || this.paused) return 'Não dá para pausar agora.';
    this.setPause({ by: m.name, byId: m.id, auto: false });
    this.sys(m.name + ' pausou o jogo.');
    this.broadcast();
    return null;
  }
  resume(m) {
    if (!this.paused) return null;
    const v = this.view(m);
    if (!v.game || !v.game.paused || !v.game.paused.canResume) return 'Só quem pausou (ou o anfitrião) continua o jogo.';
    this.sys(m.name + ' continuou o jogo.');
    this.clearPause();
    this.after();
    return null;
  }

  /* ---------- regras ---------- */
  isCor(c) { const G = this.G; return G.manilha && c.r === G.manilhaR; }
  val(c) { return this.isCor(c) ? 100 + c.s : c.r; }
  cancelled(table) {
    const counts = {}, out = new Set();
    table.forEach((t) => { const v = this.val(t.card); if (v < 100) counts[v] = (counts[v] || 0) + 1; });
    table.forEach((t) => { const v = this.val(t.card); if (v < 100 && counts[v] > 1) out.add(t.card.id); });
    return out;
  }
  resolveTable(table) {
    const cx = this.cancelled(table);
    let best = null;
    table.forEach((t) => {
      if (cx.has(t.card.id)) return;
      const v = this.val(t.card);
      if (!best || v > best.v) best = { v, pi: t.pi };
    });
    return best ? best.pi : null;
  }
  nextAliveAfter(i) {
    const P = this.G.players, n = P.length;
    let k = (i + 1) % n;
    while (!P[k].alive) k = (k + 1) % n;
    return k;
  }
  nextInRound(i) {
    const P = this.G.players, n = P.length;
    let k = (i + 1) % n;
    while (!P[k].inRound) k = (k + 1) % n;
    return k;
  }
  maxCards(alive) { return Math.min(5, Math.floor((40 - (this.G.manilha ? 1 : 0)) / alive)); }

  startRound(first) {
    const G = this.G;
    const alive = G.players.filter((p) => p.alive);
    const max = this.maxCards(alive.length);
    if (!first) {
      let n = G.nCards, dir = G.dir;
      if (dir > 0) { if (n + 1 <= max) n++; else if (n - 1 >= 1) { n--; dir = -1; } }
      else if (n - 1 >= 1) n--; else { n = max >= 2 ? 2 : 1; dir = 1; }
      G.nCards = n; G.dir = dir;
      G.dealer = this.nextAliveAfter(G.dealer);
    }
    if (G.nCards > max) G.nCards = max;
    G.round++;
    const deck = shuffle(DECK);
    if (G.manilha) { G.vira = deck.pop(); G.manilhaR = (G.vira.r + 1) % 10; } else { G.vira = null; G.manilhaR = -1; }
    G.players.forEach((p) => {
      p.inRound = p.alive; p.bet = null; p.wager = 0; p.won = 0; p.lost = 0; p.delta = 0;
      p.hand = p.alive ? deck.splice(0, G.nCards) : [];
      p.hand.sort((a, b) => this.val(a) - this.val(b));
    });
    G.betOrder = [];
    for (let k = 1; k <= G.players.length; k++) {
      const idx = (G.dealer + k) % G.players.length;
      if (G.players[idx].alive) G.betOrder.push(idx);
    }
    G.betIdx = 0; G.turn = G.betOrder[0]; G.leader = G.betOrder[0];
    G.table = []; G.trickNo = 0; G.trickInfo = null; G.fresh = null; G.pot = 0; G.summary = null;
    G.phase = 'betting'; G.sched = '';
    this.after();
  }

  forbiddenBet() {
    const G = this.G;
    if (G.betIdx !== G.betOrder.length - 1) return -1;
    let sum = 0;
    G.betOrder.slice(0, -1).forEach((i) => { sum += G.players[i].bet; });
    const f = G.nCards - sum;
    return (f >= 0 && f <= G.nCards) ? f : -1;
  }
  wagerOptions(p) {
    const m = p.money;
    if (m <= 0) return [0];
    const min = Math.min(5, m);
    const set = new Set([min, m]);
    [10, 15, 25, 50].forEach((v) => { if (v >= min && v <= m) set.add(v); });
    return Array.from(set).sort((a, b) => a - b);
  }
  validWager(p, w) {
    if (!Number.isInteger(w)) return false;
    if (p.money <= 0) return w === 0;
    return w >= Math.min(5, p.money) && w <= p.money;
  }

  humanBet(m, vazas, wager) {
    const G = this.G;
    if (this.paused) return 'O jogo está pausado.';
    if (!G || G.phase !== 'betting') return 'Agora não dá para apostar.';
    const p = G.players[G.turn];
    if (p.member !== m) return 'Não é a sua vez.';
    if (!Number.isInteger(vazas) || vazas < 0 || vazas > G.nCards) return 'Aposta inválida.';
    if (vazas === this.forbiddenBet()) return 'Esse número fecha a conta. Escolha outro.';
    if (!this.validWager(p, wager)) return 'Valor da aposta inválido.';
    this.placeBet(p, vazas, wager);
    return null;
  }
  placeBet(p, vazas, wager) {
    const G = this.G;
    p.bet = vazas; p.wager = wager; p.money -= wager; G.pot += wager;
    G.betIdx++;
    if (G.betIdx >= G.betOrder.length) { G.phase = 'playing'; G.turn = G.leader; G.trickNo = 1; }
    else G.turn = G.betOrder[G.betIdx];
    this.after();
  }
  humanPlay(m, cardId) {
    const G = this.G;
    if (this.paused) return 'O jogo está pausado.';
    if (!G || G.phase !== 'playing') return 'Agora não dá para jogar.';
    const p = G.players[G.turn];
    if (p.member !== m) return 'Não é a sua vez.';
    if (!p.hand.some((c) => c.id === cardId)) return 'Carta inválida.';
    this.playCard(G.turn, cardId);
    return null;
  }
  playCard(pi, cardId) {
    const G = this.G, p = G.players[pi];
    const idx = p.hand.findIndex((c) => c.id === cardId);
    if (idx < 0) return;
    const card = p.hand.splice(idx, 1)[0];
    G.table.push({ pi, card });
    G.fresh = card.id;
    if (G.table.length === G.betOrder.length) { this.endTrick(); return; }
    G.turn = this.nextInRound(G.turn);
    this.after();
  }
  endTrick() {
    const G = this.G;
    const w = this.resolveTable(G.table);
    if (w !== null) {
      G.players[w].won++; G.leader = w;
      G.trickInfo = { winner: G.players[w].id, text: G.players[w].name + ' levou a vaza.' };
    } else {
      G.trickInfo = { winner: null, text: 'Cartas iguais se anularam. Ninguém levou.' };
    }
    G.fresh = null; G.phase = 'trickEnd';
    this.broadcast();
    this.later(1800, () => {
      if (this.G !== G) return;
      G.table = []; G.trickInfo = null;
      if (G.betOrder.every((i) => G.players[i].hand.length === 0)) { this.endRound(); return; }
      G.trickNo++; G.phase = 'playing'; G.turn = G.leader;
      this.after();
    });
  }
  endRound() {
    const G = this.G;
    const inR = G.players.filter((p) => p.inRound);
    inR.forEach((p) => {
      p.lost = Math.abs(p.bet - p.won);
      p.lives -= p.lost;
      if (p.lives <= 0) p.alive = false;
      p.delta = -p.wager;
    });
    // dinheiro: quem acertou a aposta recebe de volta o que apostou E divide, na proporcao
    // do que apostou, o que os que erraram colocaram. Se todos acertaram ou ninguem acertou,
    // cada um so recebe a propria aposta de volta.
    const hits = inR.filter((p) => p.won === p.bet);
    const misses = inR.filter((p) => p.won !== p.bet);
    const pot = G.pot;
    let lostPot = 0, reason = null;
    if (pot > 0 && hits.length > 0 && misses.length > 0) {
      lostPot = misses.reduce((a, p) => a + p.wager, 0);
      hits.forEach((p) => { p.money += p.wager; p.delta += p.wager; });
      const totalW = hits.reduce((a, p) => a + p.wager, 0);
      const order = hits.slice().sort((x, y) => y.wager - x.wager);
      let given = 0;
      order.forEach((p) => {
        const sh = totalW > 0 ? Math.floor(lostPot * p.wager / totalW) : Math.floor(lostPot / hits.length);
        p.money += sh; p.delta += sh; given += sh;
      });
      let rem = lostPot - given;
      for (let i = 0; rem > 0; i = (i + 1) % order.length) { order[i].money++; order[i].delta++; rem--; }
    } else if (pot > 0) {
      reason = hits.length === 0 ? 'none' : 'all';
      inR.forEach((p) => { p.money += p.wager; p.delta += p.wager; });
    }
    G.summary = {
      pot, lostPot, winners: hits.map((p) => p.id), returned: pot > 0 && reason !== null, reason,
      rows: inR.map((p) => ({ id: p.id, name: p.name, bet: p.bet, won: p.won, lost: p.lost, wager: p.wager, delta: p.delta, money: p.money, alive: p.alive }))
    };
    G.pot = 0;
    const alive = G.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      if (alive.length === 1) G.winners = [alive[0]];
      else {
        const best = Math.max(...inR.map((p) => p.lives));
        G.winners = inR.filter((p) => p.lives === best);
      }
      G.phase = 'gameOver';
      G.players.forEach((p) => {
        if (!p.member || p.member.guest) return;
        const u = users[p.member.key.slice(2)];
        if (!u) return;
        u.games = (u.games || 0) + 1;
        if (G.winners.includes(p)) u.wins = (u.wins || 0) + 1;
      });
      saveUsers();
      this.sys('Fim de jogo: ' + G.winners.map((p) => p.name).join(' e ') + ' ganhou.');
      this.broadcast();
    } else {
      G.phase = 'roundEnd';
      const round = G.round;
      this.later(25000, () => { if (this.G === G && G.phase === 'roundEnd' && G.round === round) this.startRound(false); });
      this.broadcast();
    }
  }
  nextRound(m) {
    const G = this.G;
    if (this.paused) return 'O jogo está pausado.';
    if (!G || G.phase !== 'roundEnd') return null;
    this.startRound(false);
    return null;
  }

  /* ---------- bots (e jogadores desconectados) ---------- */
  pct(c) {
    const v = this.val(c);
    let lower = 0, eq = 0;
    DECK.forEach((d) => { const dv = this.val(d); if (dv < v) lower++; else if (dv === v && d.id !== c.id) eq++; });
    return (lower + eq * 0.35) / 39;
  }
  blindBot(p) {
    const G = this.G;
    const others = G.players.filter((q) => q.inRound && q !== p).map((q) => ({ pi: G.players.indexOf(q), card: q.hand[0] }));
    const seen = new Set(others.map((o) => o.card.id));
    if (G.vira) seen.add(G.vira.id);
    const unseen = DECK.filter((d) => !seen.has(d.id));
    const me = G.players.indexOf(p);
    let w = 0;
    unseen.forEach((c) => { if (this.resolveTable(others.concat({ pi: me, card: c })) === me) w++; });
    return w / unseen.length > 0.5 ? 1 : 0;
  }
  botBet(p) {
    const G = this.G, n = G.nCards, m = G.betOrder.length;
    let raw, want;
    if (n === 1) { want = this.blindBot(p); raw = want; }
    else {
      let e = 0;
      p.hand.forEach((c) => { e += Math.pow(this.pct(c), (m - 1) * 0.8); });
      e += (Math.random() - 0.5) * 0.7;
      raw = e; want = Math.max(0, Math.min(n, Math.round(e)));
    }
    const f = this.forbiddenBet();
    if (want === f) {
      const up = want + 1, dn = want - 1;
      if (raw >= want) want = up <= n ? up : dn; else want = dn >= 0 ? dn : up;
    }
    return want;
  }
  botWager(p) {
    let opts = this.wagerOptions(p);
    if (opts.length > 1 && Math.random() > 0.06) opts = opts.slice(0, -1);
    const weights = [0.5, 0.3, 0.15, 0.05];
    let r = Math.random(), i = 0;
    for (; i < opts.length - 1; i++) { r -= weights[i] || 0.02; if (r < 0) break; }
    return opts[i];
  }
  botPlay(p) {
    const G = this.G, hand = p.hand;
    if (hand.length === 1) return hand[0];
    const need = p.bet - p.won, rem = hand.length, t = G.table, me = G.players.indexOf(p);
    const asc = hand.slice().sort((a, b) => this.val(a) - this.val(b));
    const wins = (c) => this.resolveTable(t.concat({ pi: me, card: c })) === me;
    if (need <= 0) {
      if (!t.length) return asc[0];
      const losing = asc.filter((c) => !wins(c));
      return losing.length ? losing[losing.length - 1] : asc[0];
    }
    if (need >= rem) return asc[asc.length - 1];
    if (!t.length) return asc[asc.length - 1];
    const winning = asc.filter(wins);
    return winning.length ? winning[0] : asc[0];
  }

  /* agenda a jogada de um bot (ou de quem caiu) quando for a vez dele */
  schedule() {
    const G = this.G;
    if (!G || this.paused) return;
    if (G.phase !== 'betting' && G.phase !== 'playing') return;
    const p = G.players[G.turn];
    if (!this.botCtl(p)) return;
    const key = [G.round, G.phase, G.turn, G.trickNo, G.betIdx, G.table.length].join(':');
    if (G.sched === key) return;
    G.sched = key;
    const delay = p.bot ? (G.phase === 'betting' ? 900 : 1000) : 7000;
    this.later(delay, () => {
      if (this.G !== G || (G.phase !== 'betting' && G.phase !== 'playing')) return;
      const cur = G.players[G.turn];
      const k2 = [G.round, G.phase, G.turn, G.trickNo, G.betIdx, G.table.length].join(':');
      if (cur !== p || k2 !== key || !this.botCtl(p)) { G.sched = ''; return; }
      if (G.phase === 'betting') this.placeBet(p, this.botBet(p), this.botWager(p));
      else this.playCard(G.turn, this.botPlay(p).id);
    });
  }
  after() { this.touch(); this.broadcast(); this.schedule(); }
}

/* ------------------------------------------------------------------ conexoes */
function attachMember(ws, session) {
  const room = userRoom.get(session.key);
  if (!room) return;
  const m = room.members.find((x) => x.key === session.key && !x.left);
  if (!m) { userRoom.delete(session.key); return; }
  if (m.ws && m.ws !== ws) { m.ws.replaced = true; m.ws.close(4000); }
  m.ws = ws; m.connected = true; m.discAt = 0;
  ws.member = m; ws.room = room;
  room.touch();
  room.send(m, { t: 'chatlog', msgs: room.chat });
  room.checkAutoPause();
  room.broadcast();
  room.schedule();
}

function onConnection(ws, req) {
  ws.user = null; ws.member = null; ws.room = null;
  ws.alive = true;
  ws.lastChat = 0; ws.lastEmoji = 0;
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handle(ws, msg, ip); } catch (e) { console.error('erro ao tratar mensagem', msg.t, e); }
  });
  ws.on('close', () => {
    const m = ws.member;
    if (!m || ws.replaced || m.ws !== ws) return;
    m.ws = null; m.connected = false; m.discAt = Date.now();
    const room = ws.room;
    if (!room) return;
    room.touch();
    room.checkAutoPause();
    room.broadcast();
    room.schedule();
  });
}

function handle(ws, msg, ip) {
  if (!ws.user) {
    if (msg.t !== 'auth' && msg.t !== 'resume') return;
    if (!authAllowed(ip)) { ws.send(JSON.stringify({ t: 'authfail', msg: 'Muitas tentativas. Espere um minuto.' })); return; }
    const r = authenticate(msg.t === 'resume' ? { mode: 'resume', token: msg.token } : msg);
    if (r.error) { ws.send(JSON.stringify({ t: 'authfail', msg: r.error, expired: !!r.expired })); return; }
    ws.user = r.session;
    ws.send(JSON.stringify({ t: 'authed', token: r.token, name: r.session.name, guest: r.session.guest, stats: statsOf(r.session) }));
    attachMember(ws, r.session);
    return;
  }
  const err = (text) => ws.send(JSON.stringify({ t: 'err', msg: text }));
  const room = ws.room, m = ws.member;
  switch (msg.t) {
    case 'create': {
      if (room) return err('Você já está em uma sala.');
      const code = newCode();
      if (!code) return err('Não consegui criar a sala. Tente de novo.');
      const r = new Room(code);
      rooms.set(code, r);
      const mem = r.addMember(ws.user);
      userRoom.set(ws.user.key, r);
      mem.ws = ws; mem.connected = true;
      ws.member = mem; ws.room = r;
      r.sys(mem.name + ' criou a sala.');
      r.send(mem, { t: 'chatlog', msgs: r.chat });
      r.broadcast();
      return;
    }
    case 'join': {
      if (room) return err('Você já está em uma sala.');
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      const r = rooms.get(code);
      if (!r) return err('Sala não encontrada. Confira o código.');
      if (r.phase !== 'lobby') return err('Essa partida já começou.');
      if (r.humans().length >= MAX_PLAYERS) return err('A sala está cheia.');
      const mem = r.addMember(ws.user);
      userRoom.set(ws.user.key, r);
      mem.ws = ws; mem.connected = true;
      ws.member = mem; ws.room = r;
      r.sys(mem.name + ' entrou na sala.');
      r.send(mem, { t: 'chatlog', msgs: r.chat });
      r.broadcast();
      return;
    }
    default: break;
  }
  if (!room || !m) return err('Entre em uma sala primeiro.');
  let e = null;
  switch (msg.t) {
    case 'leave':
      room.leave(m);
      userRoom.delete(ws.user.key);
      ws.room = null; ws.member = null;
      ws.send(JSON.stringify({ t: 'left' }));
      return;
    case 'settings': e = room.setSettings(m, msg); break;
    case 'start': e = room.start(m); break;
    case 'again': e = room.backToLobby(m); break;
    case 'bet': e = room.humanBet(m, msg.vazas, msg.wager); break;
    case 'play': e = room.humanPlay(m, String(msg.id || '')); break;
    case 'next': e = room.nextRound(m); break;
    case 'pause': e = room.pause(m); break;
    case 'resume': e = room.resume(m); break;
    case 'chat': {
      const now = Date.now();
      if (now - ws.lastChat < 500) return;
      ws.lastChat = now;
      room.say(m, msg.text);
      return;
    }
    case 'emoji': {
      const now = Date.now();
      if (now - ws.lastEmoji < 350) return;
      ws.lastEmoji = now;
      room.react(m, msg.e);
      return;
    }
    default: return;
  }
  if (e) err(e);
}

/* -------------------------------------------------------------------- http */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json'
};
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(buf);
  });
});
wsmini.attach(server, '/ws', onConnection);

/* ------------------------------------------------------------------ rotinas */
const allConns = () => {
  const list = [];
  rooms.forEach((r) => r.members.forEach((m) => { if (m.ws) list.push(m.ws); }));
  return list;
};
setInterval(() => {
  // detecta conexoes mortas (celular que perdeu sinal)
  allConns().forEach((ws) => {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false; ws.ping();
  });
}, 25000).unref();
setInterval(() => {
  const now = Date.now();
  rooms.forEach((r) => {
    if (r.phase === 'lobby') {
      const gone = r.members.filter((m) => !m.connected && m.discAt && now - m.discAt > 60000);
      gone.forEach((m) => { userRoom.delete(m.key); r.removeMember(m); });
      if (gone.length) r.broadcast();
    }
    const online = r.humans().some((m) => m.connected);
    if ((!online && now - r.lastActive > 10 * 60 * 1000) || !r.humans().length) r.destroy();
  });
}, 30000).unref();

process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

loadUsers();
server.listen(PORT, () => console.log('Fodinha online rodando na porta ' + PORT));
