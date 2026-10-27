'use strict';
/*
 * Simulacao ponta a ponta: sobe o servidor de verdade, conecta 3 jogadores por WebSocket
 * (2 com conta, 1 visitante) mais 2 bots, joga uma partida inteira e confere:
 *  - ninguem enxerga cartas que nao deveria (mao dos outros / a propria carta na rodada cega)
 *  - o dinheiro total (carteiras + pote) nunca muda
 *  - login errado e sala inexistente dao erro
 *  - chat, pausa e reconexao funcionam
 * Uso: node test/sim.js   (precisa do Node 22+ por causa do WebSocket embutido)
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3100 + Math.floor(Math.random() * 800);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fodinha-test-'));
const failures = [];
const fail = (m) => { failures.push(m); console.log('  FALHOU:', m); };
const ok = (m) => console.log('  ok:', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(15); }
  fail('tempo esgotado esperando: ' + what);
  return false;
}

class Client {
  constructor(name) {
    this.name = name; this.view = null; this.chat = []; this.emojis = []; this.errs = [];
    this.authed = false; this.authErr = null; this.token = null; this.auto = false;
    this.lastKey = ''; this.rounds = new Set(); this.checks = 0; this.summaries = [];
  }
  connect() {
    return new Promise((res) => {
      this.ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
      this.ws.onopen = () => res();
      this.ws.onmessage = (e) => this.onmsg(JSON.parse(e.data));
    });
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  async auth(msg) {
    this.authed = false; this.authErr = null;
    this.send(Object.assign({ t: 'auth', name: this.name }, msg));
    await until(() => this.authed || this.authErr, 3000, 'resposta do login de ' + this.name);
    return this.authed;
  }
  onmsg(m) {
    if (m.t === 'authed') { this.authed = true; this.token = m.token; this.guest = m.guest; }
    else if (m.t === 'authfail') this.authErr = m.msg;
    else if (m.t === 'room') { this.view = m; this.check(); this.act(); }
    else if (m.t === 'chat') this.chat.push(m.m);
    else if (m.t === 'chatlog') this.chat = m.msgs.slice();
    else if (m.t === 'emoji') this.emojis.push(m);
    else if (m.t === 'err') { this.errs.push(m.msg); this.lastKey = ''; setTimeout(() => this.act(), 60); }
    else if (m.t === 'left') this.view = null;
  }
  check() {
    const v = this.view, G = v && v.game;
    if (!G) return;
    this.checks++;
    this.rounds.add(G.round);
    const me = G.players.find((p) => p.id === v.meId);
    if (!me) { fail(this.name + ': nao achei a si mesmo na lista de jogadores'); return; }
    const blindNow = G.nCards === 1 && (G.phase === 'betting' || G.phase === 'playing');
    G.players.forEach((p) => {
      if (p.id === me.id) {
        if (p.handCount > 0 && p.hand) {
          p.hand.forEach((c) => {
            if (blindNow && ('r' in c || 's' in c)) fail(this.name + ': recebeu a propria carta na rodada cega');
            if (!blindNow && !('r' in c)) fail(this.name + ': mao propria sem valores fora da rodada cega');
          });
        } else if (p.handCount > 0 && p.inRound) fail(this.name + ': mao propria ausente');
      } else if (!blindNow && p.hand) {
        fail(this.name + ': enxergou a mao de ' + p.name + ' fora da rodada cega (rodada ' + G.round + ')');
      } else if (blindNow && p.inRound && p.handCount > 0 && !(p.hand && 'r' in p.hand[0])) {
        fail(this.name + ': na rodada cega nao viu a carta de ' + p.name);
      }
    });
    const total = G.players.reduce((s, p) => s + p.money, 0) + G.pot;
    const expect = G.players.length * v.settings.money;
    if (total !== expect) fail(this.name + ': dinheiro total mudou: ' + total + ' em vez de ' + expect + ' (rodada ' + G.round + ', ' + G.phase + ')');
    if (G.summary && !this.summaries.includes(G.round)) {
      this.summaries.push(G.round);
      const s = G.summary, sum = s.rows.reduce((a, r) => a + r.delta, 0);
      if (sum !== 0) fail('resultado da rodada ' + G.round + ' nao fecha em zero: ' + sum);
      const hits = s.rows.filter((r) => r.bet === r.won), miss = s.rows.filter((r) => r.bet !== r.won);
      if (s.pot > 0) {
        if (hits.length && miss.length) {
          if (s.returned) fail('rodada ' + G.round + ': tinha quem acertou e quem errou, mas devolveu as apostas');
          miss.forEach((r) => { if (r.delta !== -r.wager) fail('quem errou deveria perder a aposta (rodada ' + G.round + ')'); });
          hits.forEach((r) => { if (r.delta < 0) fail('quem acertou nao pode perder dinheiro (rodada ' + G.round + ')'); });
          const lostSum = miss.reduce((a, r) => a + r.wager, 0);
          if (lostSum > 0 && !hits.some((r) => r.delta > 0)) fail('quem acertou nao recebeu nada de quem errou (rodada ' + G.round + ')');
        } else {
          if (!s.returned) fail('todos acertaram ou ninguem acertou: deveria devolver (rodada ' + G.round + ')');
          if (s.rows.some((r) => r.delta !== 0)) fail('apostas nao foram devolvidas na rodada ' + G.round);
        }
      }
      s.rows.forEach((r) => {
        if (r.lost !== Math.abs(r.bet - r.won)) fail('vidas perdidas erradas na rodada ' + G.round);
      });
    }
  }
  act() {
    if (!this.auto) return;
    const v = this.view, G = v && v.game;
    if (!G || G.paused) return;
    const key = [G.round, G.phase, G.turn, G.table.length, G.players.map((p) => p.bet + ':' + p.handCount + ':' + p.won).join(',')].join('|');
    if (G.phase === 'roundEnd') {
      if (this.lastKey !== key) { this.lastKey = key; setTimeout(() => this.send({ t: 'next' }), 20); }
      return;
    }
    if (G.turn !== v.meId || this.lastKey === key) return;
    this.lastKey = key;
    const me = G.players.find((p) => p.id === v.meId);
    if (G.phase === 'betting') {
      let vazas = Math.floor(Math.random() * (G.nCards + 1));
      if (vazas === G.forbidden) vazas = (vazas + 1) % (G.nCards + 1);
      const opts = G.wagerOptions;
      this.send({ t: 'bet', vazas, wager: opts[Math.floor(Math.random() * opts.length)] });
    } else if (G.phase === 'playing' && me.hand && me.hand.length) {
      this.send({ t: 'play', id: me.hand[Math.floor(Math.random() * me.hand.length)].id });
    }
  }
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, FODINHA_SPEED: '30' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOut = '';
  srv.stdout.on('data', (d) => { serverOut += d; });
  srv.stderr.on('data', (d) => { serverOut += d; process.stdout.write('[servidor] ' + d); });
  await until(() => /rodando/.test(serverOut), 5000, 'servidor subir');

  console.log('Contas');
  const ana = new Client('Ana'), beto = new Client('Beto'), caio = new Client('Caio');
  for (const c of [ana, beto, caio]) await c.connect();
  (await ana.auth({ mode: 'register', password: 'senha1' })) ? ok('Ana criou conta') : fail('Ana nao conseguiu criar conta');
  (await beto.auth({ mode: 'register', password: 'senha2' })) ? ok('Beto criou conta') : fail('Beto nao conseguiu criar conta');
  (await caio.auth({ mode: 'guest' })) ? ok('Caio entrou como visitante') : fail('visitante nao entrou');
  const dup = new Client('ana'); await dup.connect();
  await dup.auth({ mode: 'register', password: 'qualquer' });
  dup.authErr ? ok('nome repetido (sem diferenciar maiusculas) foi recusado') : fail('aceitou nome repetido');
  const bad = new Client('Ana'); await bad.connect();
  await bad.auth({ mode: 'login', password: 'errada' });
  bad.authErr ? ok('senha errada foi recusada') : fail('aceitou senha errada');
  const good = new Client('Ana'); await good.connect();
  (await good.auth({ mode: 'login', password: 'senha1' })) ? ok('login com a senha certa funcionou') : fail('login certo falhou');
  good.ws.close();

  console.log('Salas');
  const ghost = new Client('Caio'); ghost.authed = false;
  ana.send({ t: 'create' });
  await until(() => ana.view && ana.view.code, 3000, 'sala criada');
  const code = ana.view.code;
  ok('sala criada com codigo ' + code);
  beto.send({ t: 'join', code: 'ZZZZ' });
  await until(() => beto.errs.length, 2000, 'erro de sala inexistente');
  beto.errs.length ? ok('codigo inexistente deu erro: "' + beto.errs[0] + '"') : 0;
  beto.errs = [];
  beto.send({ t: 'join', code: code.toLowerCase() });
  caio.send({ t: 'join', code });
  await until(() => ana.view && ana.view.members.length === 3, 3000, '3 jogadores na sala');
  ok('3 jogadores na sala');
  beto.send({ t: 'settings', lives: 5, bots: 2 });
  await until(() => beto.errs.length, 1000, 'recusar configuracao de quem nao e anfitriao');
  ok('quem nao e anfitriao nao muda configuracoes');
  ana.send({ t: 'settings', lives: 3, manilha: true, money: 50, bots: 2 });
  await until(() => ana.view.settings.bots === 2, 2000, 'bots configurados');

  console.log('Chat e emojis');
  beto.send({ t: 'chat', text: '  oi   pessoal  ' });
  await until(() => ana.chat.some((m) => m.text === 'oi pessoal' && m.name === 'Beto'), 2000, 'chat chegar para a Ana');
  ok('mensagem do chat chegou limpa para os outros');
  beto.send({ t: 'chat', text: 'x'.repeat(500) });
  await sleep(700);
  const long = ana.chat.filter((m) => m.name === 'Beto').pop();
  long && long.text.length <= 200 ? ok('mensagem longa foi cortada em 200 caracteres') : fail('mensagem longa nao foi cortada');

  console.log('Partida');
  ana.send({ t: 'start' });
  await until(() => ana.view && ana.view.game, 3000, 'partida comecar');
  ana.send({ t: 'emoji', e: '🐔' });
  ana.send({ t: 'emoji', e: 'hack' });
  await until(() => beto.emojis.length, 2000, 'emoji chegar');
  await sleep(200);
  beto.emojis.length === 1 && beto.emojis[0].e === '🐔' ? ok('emoji valido chegou e o invalido foi ignorado') : fail('emojis recebidos: ' + JSON.stringify(beto.emojis));
  [ana, beto, caio].forEach((c) => { c.auto = true; c.act(); });

  let pauseDone = false, dropDone = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const G = ana.view && ana.view.game;
    if (G && G.phase === 'gameOver') break;
    if (G && !pauseDone && G.round >= 2 && G.phase === 'playing') {
      pauseDone = true;
      console.log('Pausa');
      beto.send({ t: 'pause' });
      await until(() => beto.view.game.paused, 2000, 'pausa aparecer');
      const snap = () => JSON.stringify([ana.view.game.round, ana.view.game.phase, ana.view.game.turn, ana.view.game.table.length, ana.view.game.players.map((p) => p.bet + ':' + p.won)]);
      await sleep(150);
      const before = snap();
      await sleep(900);
      snap() === before ? ok('o jogo ficou parado durante a pausa') : fail('o jogo andou durante a pausa');
      caio.errs = [];
      caio.send({ t: 'resume' });
      await sleep(150);
      caio.errs.length ? ok('quem nao pausou nao consegue continuar: "' + caio.errs[0] + '"') : fail('outro jogador conseguiu continuar a pausa');
      beto.send({ t: 'resume' });
      await until(() => !beto.view.game.paused, 2000, 'pausa terminar');
      ok('quem pausou conseguiu continuar');
    }
    if (G && !dropDone && G.round >= 3 && G.phase === 'betting') {
      dropDone = true;
      console.log('Queda e volta de um jogador');
      const tok = caio.token;
      caio.ws.close();
      await sleep(500);
      const alive = ana.view.members.find((m) => m.name === 'Caio');
      alive && alive.connected === false ? ok('os outros viram o Caio desconectado') : fail('desconexao nao apareceu para os outros');
      await caio.connect();
      caio.authed = false;
      caio.send({ t: 'resume', token: tok });
      await until(() => caio.authed && caio.view && caio.view.game, 3000, 'Caio voltar para a mesa');
      caio.view && caio.view.meId ? ok('Caio voltou para a mesma partida sem fazer login de novo') : fail('Caio nao voltou');
    }
    await sleep(40);
  }

  const G = ana.view && ana.view.game;
  console.log('Fim');
  if (!G || G.phase !== 'gameOver') {
    fail('a partida nao terminou no tempo esperado (fase: ' + (G && G.phase) + ', rodada ' + (G && G.round) + ')');
    if (G) {
      console.log('  estado final visto pela Ana: turno=' + G.turn + ' pausa=' + JSON.stringify(G.paused) + ' mesa=' + G.table.length +
        ' jogadores=' + G.players.map((p) => p.id + ':' + p.name + (p.bot ? '(bot)' : '') + ' viva=' + p.alive + ' naRodada=' + p.inRound + ' maos=' + p.handCount + ' conectado=' + p.connected + ' aposta=' + p.bet).join(' | '));
      [ana, beto, caio].forEach((c) => console.log('  ' + c.name + ' meId=' + (c.view && c.view.meId) + ' erros=' + JSON.stringify(c.errs.slice(-3))));
    }
  }
  else {
    ok('partida terminou na rodada ' + G.round + ' com vencedor: ' + G.winners.map((id) => G.players.find((p) => p.id === id).name).join(', '));
    const rich = G.players.map((p) => p.name + ' R$' + p.money).join(', ');
    console.log('  carteiras finais: ' + rich);
  }
  console.log('  verificacoes de visao feitas: ' + [ana, beto, caio].map((c) => c.name + '=' + c.checks).join(' '));
  if (!pauseDone) fail('o teste de pausa nao chegou a rodar');
  if (!dropDone) fail('o teste de queda nao chegou a rodar');

  ana.send({ t: 'again' });
  await until(() => ana.view && ana.view.phase === 'lobby', 2000, 'voltar para a sala');
  ok('anfitriao voltou para a sala depois do fim');
  beto.send({ t: 'leave' });
  await until(() => beto.view === null, 2000, 'Beto sair');
  ok('jogador saiu da sala');

  srv.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(failures.length ? '\n' + failures.length + ' FALHA(S)' : '\nTUDO CERTO');
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
