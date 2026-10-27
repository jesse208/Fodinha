(function () {
  'use strict';

  /* ================= baralho espanhol ================= */
  var RANKS = ['4', '5', '6', '7', '10', '11', '12', '1', '2', '3'];
  var SUITS = [
    { id: 'oro', n: 'ouros', col: '#d9791c' },
    { id: 'copa', n: 'copas', col: '#c8282b' },
    { id: 'basto', n: 'bastos', col: '#3f8a45' },
    { id: 'espada', n: 'espadas', col: '#2f62b0' }
  ];
  var FIGS = { 10: 'sota', 11: 'caballo', 12: 'rey' };
  var PIPS = {
    1: [[50, 75]],
    2: [[50, 38], [50, 112]],
    3: [[50, 32], [50, 75], [50, 118]],
    4: [[30, 40], [70, 40], [30, 110], [70, 110]],
    5: [[30, 40], [70, 40], [50, 75], [30, 110], [70, 110]],
    6: [[30, 34], [70, 34], [30, 75], [70, 75], [30, 116], [70, 116]],
    7: [[30, 34], [70, 34], [50, 54], [30, 75], [70, 75], [30, 116], [70, 116]]
  };
  var SEAT_KEYS = {
    1: ['top'],
    2: ['topL', 'topR'],
    3: ['left', 'top', 'right'],
    4: ['left', 'topL', 'topR', 'right'],
    5: ['left', 'topL', 'top', 'topR', 'right']
  };
  var PV_POS = { me: [50, 84], top: [50, 15], topL: [30, 17], topR: [70, 17], left: [13, 50], right: [87, 50] };
  var EMOJIS = ['🐔', '😂', '👏', '😡', '🔥', '💀', '😎', '🤝', '🙏', '😭'];
  var EMOJI_NAMES = { '🐔': 'Frango', '😂': 'Risada', '👏': 'Palmas', '😡': 'Bravo', '🔥': 'Fogo', '💀': 'Morri', '😎': 'Fácil', '🤝': 'Trégua', '🙏': 'Por favor', '😭': 'Chorando' };

  /* ================= utilidades ================= */
  function $(id) { return document.getElementById(id); }
  function esc(t) {
    return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  function brl(n) { return 'R$ ' + n; }

  /* ================= estado ================= */
  var st = {
    conn: 'connecting', authed: false, resuming: false, me: null,
    token: LS.get('fodinha.token'),
    tab: 'login', form: { name: LS.get('fodinha.name') || '' }, authErr: '', authBusy: false,
    room: null, chat: [], unread: 0, chatOpen: false, confirmExit: false,
    codeInput: '', pendingCode: null,
    bet: { v: null, w: null, round: 0 }, lastWager: null, retry: 0, lastEmojiAt: 0,
    solo: false, soloBots: Math.min(5, Math.max(1, parseInt(LS.get('fodinha.bots'), 10) || 3))
  };
  st.resuming = !!st.token;
  var G = null; // jogo atual (dentro de st.room), atualizado a cada render
  var ws = null, reconnectT = null, toastT = null;

  try {
    var qp = new URLSearchParams(location.search).get('sala');
    if (qp) {
      qp = qp.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (qp.length === 4) { st.pendingCode = qp; st.codeInput = qp; }
    }
  } catch (e) {}

  /* ================= conexao ================= */
  function send(o) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; }
    toast('Sem conexão com o servidor. Tentando de novo...');
    return false;
  }
  function connect() {
    clearTimeout(reconnectT);
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(proto + '//' + location.host + '/ws'); } catch (e) { scheduleReconnect(); return; }
    var mine = ws;
    ws.onopen = function () {
      if (ws !== mine) return;
      st.conn = 'open'; st.retry = 0;
      if (st.token) { st.resuming = true; send({ t: 'resume', token: st.token }); }
      render();
    };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (x) { return; }
      onMsg(m);
    };
    ws.onclose = function () {
      if (ws !== mine) return;
      st.conn = 'closed';
      render();
      scheduleReconnect();
    };
    ws.onerror = function () {};
  }
  function scheduleReconnect() {
    clearTimeout(reconnectT);
    reconnectT = setTimeout(connect, Math.min(8000, Math.round(800 * Math.pow(1.6, st.retry++))));
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && (!ws || ws.readyState > 1)) connect();
  });

  function onMsg(m) {
    switch (m.t) {
      case 'authed':
        st.authed = true; st.resuming = false; st.authBusy = false; st.authErr = '';
        st.me = { name: m.name, guest: !!m.guest, stats: m.stats };
        st.token = m.token; LS.set('fodinha.token', m.token); LS.set('fodinha.name', m.name);
        render();
        if (st.pendingCode) {
          var code = st.pendingCode;
          setTimeout(function () { if (!st.room && st.authed) send({ t: 'join', code: code }); }, 350);
          st.pendingCode = null;
          try { history.replaceState(null, '', location.pathname); } catch (e) {}
        }
        break;
      case 'authfail':
        st.authBusy = false; st.resuming = false;
        if (m.expired) { st.token = null; LS.del('fodinha.token'); st.authed = false; st.authErr = 'Sua sessão expirou. Entre de novo.'; }
        else st.authErr = m.msg || 'Não foi possível entrar.';
        render();
        break;
      case 'room':
        var prev = st.room;
        st.room = m;
        if (m.phase === 'lobby') { st.bet = { v: null, w: st.lastWager, round: 0 }; st.confirmExit = false; }
        if (st.solo) {
          if (m.phase === 'lobby') {
            var want = Math.min(st.soloBots, m.maxBots), S0 = m.settings;
            if (S0.bots !== want) send({ t: 'settings', lives: S0.lives, manilha: S0.manilha, money: S0.money, bots: want });
            else { st.solo = false; send({ t: 'start' }); }
          } else st.solo = false;
        }
        if (prev && prev.phase !== 'game' && m.phase === 'game') { st.chatOpen = false; st.unread = 0; }
        render();
        break;
      case 'chat':
        st.chat.push(m.m);
        if (st.chat.length > 80) st.chat.shift();
        appendChat(m.m);
        if (!m.m.sys && st.room && m.m.from !== st.room.meId && !chatVisible()) { st.unread++; updateBadge(); }
        break;
      case 'chatlog':
        st.chat = m.msgs.slice();
        renderChatList();
        break;
      case 'emoji':
        showEmoji(m.from, m.e);
        break;
      case 'err':
        st.solo = false;
        toast(m.msg);
        break;
      case 'left':
        st.room = null; st.chat = []; st.confirmExit = false; st.unread = 0; st.chatOpen = false;
        renderChatList();
        render();
        break;
      default: break;
    }
  }

  function toast(msg) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.remove('show'); }, 3600);
  }

  /* ================= cartas ================= */
  function isCor(c) { return !!(G && G.manilhaR >= 0 && c && c.r === G.manilhaR); }
  function val(c) { return isCor(c) ? 100 + c.s : c.r; }
  function cancelledIds(table) {
    var counts = {}, out = {};
    table.forEach(function (t) { var v = val(t.card); if (v < 100) counts[v] = (counts[v] || 0) + 1; });
    table.forEach(function (t) { var v = val(t.card); if (v < 100 && counts[v] > 1) out[t.card.id] = true; });
    return out;
  }
  function pipUse(id, cx, cy, sz) {
    return '<use href="#s-' + id + '" x="' + (cx - sz / 2) + '" y="' + (cy - sz / 2) + '" width="' + sz + '" height="' + sz + '"/>';
  }
  function faceSVG(c) {
    var su = SUITS[c.s], rk = RANKS[c.r], num = parseInt(rk, 10), i;
    var h = '<svg viewBox="0 0 100 150" aria-hidden="true" style="color:' + su.col + '">' +
      '<rect x="1" y="1" width="98" height="148" rx="8" fill="#f4ead0" stroke="#2a1f14" stroke-width="1.4"/>' +
      '<rect x="4.5" y="4.5" width="91" height="141" rx="5" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.55"/>';
    if (num === 1) {
      h += '<circle cx="50" cy="75" r="38" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 3.5" opacity="0.55"/>';
      h += pipUse(su.id, 50, 75, 58);
    } else if (num <= 7) {
      for (i = 0; i < PIPS[num].length; i++) h += pipUse(su.id, PIPS[num][i][0], PIPS[num][i][1], 27);
    } else {
      h += '<rect x="19" y="24" width="62" height="102" rx="2" fill="#ecdcab" stroke="#1c1a16" stroke-width="1"/>';
      h += '<use href="#f-' + FIGS[num] + '" x="21" y="27" width="58" height="83" style="color:' + su.col + '"/>';
      h += pipUse(su.id, 30, 38, 15);
    }
    var fs = num > 9 ? 12 : 15;
    function idx(rot) {
      return '<g' + (rot ? ' transform="rotate(180 50 75)"' : '') + '><text x="12" y="20" text-anchor="middle" font-size="' + fs +
        '" font-weight="700" fill="currentColor" style="font-family:var(--f-display),Georgia,serif">' + rk + '</text>' + pipUse(su.id, 12, 29, 10) + '</g>';
    }
    return h + idx(false) + idx(true) + '</svg>';
  }
  function cardEl(c, o) {
    o = o || {};
    var tag = o.tag || 'div', cls = o.cls || '', attrs = o.attrs || '', style = o.style ? ' style="' + o.style + '"' : '';
    if (o.back || !c || c.r === undefined) return '<' + tag + ' class="card back ' + cls + '"' + attrs + style + '></' + tag + '>';
    var su = SUITS[c.s], rk = RANKS[c.r], cor = isCor(c);
    var label = rk + ' de ' + su.n + (cor ? ', coringa' : '');
    return '<' + tag + ' class="card ' + (cor ? 'cor ' : '') + cls + '"' + attrs + style + ' aria-label="' + label + '">' +
      (cor ? '<span class="rib">CORINGA</span>' : '') + faceSVG(c) + '</' + tag + '>';
  }
  function fanStyle(i, n, deg) {
    var t = n > 1 ? i / (n - 1) - 0.5 : 0;
    return '--r:' + (t * deg).toFixed(1) + 'deg;--y:' + (Math.abs(t) * Math.abs(t) * 14).toFixed(1) + 'px';
  }
  function tilt(c) { return (((c.r || 0) * 7 + (c.s || 0) * 13) % 9) - 4; }

  /* ================= telas: entrada ================= */
  function heroHTML() {
    var fan = [{ r: 7, s: 3 }, { r: 6, s: 1 }, { r: 5, s: 2 }, { r: 4, s: 0 }].map(function (c, i) {
      return cardEl({ r: c.r, s: c.s, id: 'x' + i }, { cls: 'xl', style: '--r:' + (-15 + i * 10) + 'deg;--y:' + (Math.abs(i - 1.5) * 6) + 'px' });
    }).join('');
    return '<section class="hero"><h1>Fodinha</h1><p class="sub">Aposte quantas vazas você leva. Errou, perde vida. O último de pé ganha.</p><div class="deck-fan" aria-hidden="true">' + fan + '</div></section>';
  }

  function connectingHTML() {
    return '<p class="boot">' + (st.conn === 'closed' ? 'Sem conexão. Tentando de novo...' : 'Conectando...') + '</p>';
  }

  function authHTML() {
    var tab = st.tab;
    function tb(id, label) { return '<button type="button" role="tab" data-act="tab" data-tab="' + id + '" data-key="tab-' + id + '" aria-selected="' + (tab === id) + '">' + label + '</button>'; }
    var btnLabel = tab === 'login' ? 'Entrar' : tab === 'register' ? 'Criar conta' : 'Jogar como visitante';
    var h = '<div class="app lobby">' + heroHTML() + '<section class="board" aria-label="Entrar">' +
      '<div class="tabs" role="tablist">' + tb('login', 'Entrar') + tb('register', 'Criar conta') + tb('guest', 'Visitante') + '</div>' +
      '<form id="authform" novalidate>' +
      '<div class="field"><label for="f-name">Nome</label><input id="f-name" data-key="f-name" name="username" type="text" maxlength="14" autocomplete="username" autocapitalize="words" value="' + esc(st.form.name) + '"></div>';
    if (tab !== 'guest') {
      h += '<div class="field"><label for="f-pw">Senha</label><input id="f-pw" data-key="f-pw" name="password" type="password" maxlength="64" autocomplete="' + (tab === 'login' ? 'current-password' : 'new-password') + '"></div>';
    }
    h += '<p class="err" role="alert">' + esc(st.authErr) + '</p>' +
      '<button type="submit" class="btn big" data-key="auth-go"' + (st.authBusy ? ' disabled' : '') + '>' + (st.authBusy ? 'Aguarde...' : btnLabel) + '</button></form>' +
      '<p class="note">' + (tab === 'guest'
        ? 'Visitante não precisa de senha, mas não guarda suas vitórias.'
        : tab === 'register' ? 'A conta guarda suas vitórias. O nome vale de 2 a 14 letras, números, espaço, _ ou -.' : 'Entre com o nome e a senha que você criou.') + '</p>' +
      '</section></div>';
    return h;
  }

  function homeHTML() {
    var s = st.me.stats;
    var statsLine = st.me.guest ? 'Entrou como visitante.' : (s ? s.wins + (s.wins === 1 ? ' vitória' : ' vitórias') + ' em ' + s.games + (s.games === 1 ? ' partida' : ' partidas') : '');
    return '<div class="app lobby">' + heroHTML() + '<section class="board" aria-label="Início">' +
      '<p class="who">Olá, ' + esc(st.me.name) + '</p><p class="stats">' + esc(statsLine) + '</p>' +
      '<button type="button" class="btn big" data-act="solo" data-key="solo">Jogar contra bots</button>' +
      '<div class="setrow solorow"><span class="fl">Quantos bots</span><div class="seg" role="group" aria-label="Quantos bots">' +
      [1, 2, 3, 4, 5].map(function (v) { return '<button type="button" data-act="solobots" data-v="' + v + '" data-key="sb' + v + '" aria-pressed="' + (st.soloBots === v) + '">' + v + '</button>'; }).join('') + '</div></div>' +
      '<p class="or">ou jogue com amigos</p>' +
      '<button type="button" class="btn big ghost" data-act="create" data-key="create">Criar sala</button>' +
      '<p class="or">ou entre com o código de um amigo</p>' +
      '<form id="joinform" class="codewrap" novalidate><input id="f-code" data-key="f-code" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD" aria-label="Código da sala" value="' + esc(st.codeInput) + '">' +
      '<button type="submit" class="btn go" data-key="join-go">Entrar</button></form>' +
      '<div class="linkout"><button type="button" class="btn ghost small" data-act="logout" data-key="logout">Sair da conta</button></div>' +
      '</section></div>';
  }

  /* ================= telas: sala ================= */
  function lobbyHTML() {
    var R = st.room, isHost = R.hostId === R.meId, S = R.settings;
    var humans = R.members.length, bots = Math.min(S.bots, R.maxBots);
    var total = humans + bots;
    var link = location.origin + '/?sala=' + R.code;

    var list = R.members.map(function (m) {
      return '<li><span class="dot' + (m.connected ? '' : ' off') + '" title="' + (m.connected ? 'online' : 'desconectado') + '"></span><span class="mn">' + esc(m.name) + (m.id === R.meId ? ' (você)' : '') + '</span>' +
        (m.id === R.hostId ? '<span class="chip">anfitrião</span>' : '') + (m.guest ? '<span class="chip">visitante</span>' : '') + '</li>';
    }).join('');
    for (var b = 0; b < bots; b++) list += '<li class="bot"><span class="dot"></span><span class="mn">Bot</span><span class="chip">bot</span></li>';

    function seg(k, values, fmt) {
      return '<div class="seg" role="group" aria-label="' + k + '">' + values.map(function (v) {
        var on = S[k] === v;
        return '<button type="button" data-act="set" data-k="' + k + '" data-v="' + v + '" data-key="set-' + k + '-' + v + '" aria-pressed="' + on + '">' + fmt(v) + '</button>';
      }).join('') + '</div>';
    }
    var botVals = []; for (var i = 0; i <= R.maxBots; i++) botVals.push(i);
    var settings;
    if (isHost) {
      settings = '<div class="setrow"><span class="fl">Vidas</span>' + seg('lives', [3, 5], String) + '</div>' +
        '<div class="setrow"><span class="fl">Coringa</span>' + seg('manilha', [true, false], function (v) { return v ? 'Ligado' : 'Desligado'; }) + '</div>' +
        '<div class="setrow"><span class="fl">Dinheiro de cada um</span>' + seg('money', [20, 50, 100], brl) + '</div>' +
        '<div class="setrow"><span class="fl">Bots</span>' + seg('bots', botVals, String) + '</div>';
    } else {
      settings = '<p class="ro">' + S.lives + ' vidas · coringa ' + (S.manilha ? 'ligado' : 'desligado') + ' · ' + brl(S.money) + ' para cada um · ' + bots + (bots === 1 ? ' bot' : ' bots') + '</p>';
    }

    // mini mesa
    var seats = R.members.map(function (m) { return { n: m.id === R.meId ? m.name : m.name, me: m.id === R.meId, bot: false }; });
    seats.sort(function (a, b) { return (b.me ? 1 : 0) - (a.me ? 1 : 0); });
    for (var q = 0; q < bots; q++) seats.push({ n: 'Bot', me: false, bot: true });
    var keys = ['me'].concat(SEAT_KEYS[Math.max(1, Math.min(5, seats.length - 1))] || []);
    var pv = seats.slice(0, 6).map(function (s, idx) {
      var k = keys[idx] || 'top';
      return '<span class="pv-seat' + (s.me ? ' me' : '') + (s.bot ? ' bot' : '') + '" style="left:' + PV_POS[k][0] + '%;top:' + PV_POS[k][1] + '%">' + esc(s.n) + '</span>';
    }).join('');

    var action;
    if (isHost) {
      action = '<button type="button" class="btn big" data-act="start" data-key="start"' + (total < 2 ? ' disabled' : '') + '>Começar partida</button>' +
        (total < 2 ? '<p class="hintline">Chame um amigo com o código ou adicione um bot.</p>' : '<p class="hintline">' + total + ' jogadores na mesa.</p>');
    } else {
      action = '<p class="hintline">Aguardando o anfitrião começar a partida...</p>';
    }

    return '<div class="app lobbyroom"><header class="hud"><div class="hud-title">Sala de espera</div>' +
      '<div class="acts"><button type="button" class="btn ghost small" data-act="leave" data-key="leave">Sair da sala</button></div></header>' +
      '<div class="roomgrid"><section class="board" aria-label="Sala">' +
      '<div class="codebox"><span class="lbl">Código da sala</span><span class="code" aria-label="Código ' + esc(R.code.split('').join(' ')) + '">' + esc(R.code) + '</span>' +
      '<div class="linkrow"><input id="linkbox" readonly value="' + esc(link) + '" aria-label="Link da sala"><button type="button" class="btn small" data-act="copylink" data-key="copylink">Copiar link</button></div></div>' +
      '<h3>Na mesa</h3><ul class="members">' + list + '</ul>' + settings +
      '<div class="pv" aria-hidden="true">' + pv + '</div>' + action + '</section>' +
      '<section class="chatcol"><div class="chatslot"></div></section></div></div>';
  }

  /* ================= telas: jogo ================= */
  function lifeDots(p) {
    var total = G.lives, h = '<span class="dots" role="img" aria-label="' + Math.max(p.lives, 0) + ' vidas">';
    for (var i = 0; i < total; i++) h += '<i class="' + (i < p.lives ? 'on' : 'off') + '"></i>';
    return h + '</span>';
  }
  function statText(p) {
    if (!p.alive) return 'fora';
    if (!p.inRound || p.bet === null) return '';
    if (G.phase === 'betting') return 'aposta ' + p.bet;
    if (G.phase === 'playing' || G.phase === 'trickEnd') return 'fez ' + p.won + ' de ' + p.bet;
    return '';
  }
  function plateHTML(p) {
    var stt = statText(p);
    return '<div class="plate"><div class="pn"><span class="nm">' + esc(p.name) + '</span>' +
      (p.id === G.dealer && p.alive ? '<span class="dchip" title="Quem dá as cartas" aria-label="dá as cartas">D</span>' : '') + '</div>' +
      lifeDots(p) + '<span class="mny">' + brl(p.money) + '</span>' + (stt ? '<span class="stat">' + stt + '</span>' : '') +
      (!p.bot && !p.connected ? '<span class="dot off" title="desconectado"></span>' : '') + '</div>';
  }
  function blindNow() { return G.nCards === 1 && (G.phase === 'betting' || G.phase === 'playing'); }

  function seatHTML(p, key) {
    var turn = (G.phase === 'betting' || G.phase === 'playing') && G.turn === p.id && p.inRound;
    var n = p.handCount, cards = '';
    if (p.inRound && n) {
      if (p.hand) {
        cards = p.hand.map(function (c, i) { return cardEl(c, { cls: 'md', style: fanStyle(i, n, 12) }); }).join('');
      } else {
        for (var i = 0; i < n; i++) cards += cardEl(null, { back: true, cls: 'sm', style: fanStyle(i, n, 12) });
      }
    }
    return '<div class="seat s-' + key + (p.alive ? '' : ' out') + (turn ? ' turn' : '') + '" data-pid="' + esc(p.id) + '"><div class="fan' + (cards ? '' : ' empty') + '">' + cards + '</div>' + plateHTML(p) + '</div>';
  }
  function meSeatHTML(p) {
    var turnPlay = G.phase === 'playing' && G.turn === p.id && p.inRound && !G.paused;
    var turn = (G.phase === 'betting' || G.phase === 'playing') && G.turn === p.id && p.inRound;
    var n = p.handCount, cards = '';
    if (p.inRound && n && p.hand) {
      cards = p.hand.map(function (c, i) {
        var attrs = ' type="button" data-act="play" data-id="' + esc(c.id) + '" data-key="c' + esc(c.id) + '"' + (turnPlay ? '' : ' disabled');
        var blind = c.r === undefined;
        if (blind) attrs += ' aria-label="Sua carta, virada para a testa' + (turnPlay ? '. Jogar' : '') + '"';
        return cardEl(blind ? null : c, { tag: 'button', cls: 'lg' + (turnPlay ? ' playable' : ''), back: blind, attrs: attrs, style: fanStyle(i, n, 8) });
      }).join('');
    }
    return '<div class="seat s-me' + (p.alive ? '' : ' out') + (turn ? ' turn' : '') + '" data-pid="' + esc(p.id) + '"><div class="fan mine' + (cards ? '' : ' empty') + '">' + cards + '</div>' + plateHTML(p) + '</div>';
  }
  function viraHTML() {
    if (G.vira && G.manilhaR >= 0) {
      return '<div class="vira">' + cardEl(G.vira, { cls: 'vc' }) + '<span class="vlabel">coringa: ' + RANKS[G.manilhaR] + '</span></div>';
    }
    return '<div class="vira"><div class="stack">' + cardEl(null, { back: true, cls: 'vc' }) + cardEl(null, { back: true, cls: 'vc', style: '--r:5deg' }) + '</div></div>';
  }
  function playedHTML(keyOf) {
    var cx = G.phase === 'trickEnd' ? cancelledIds(G.table) : {};
    return G.table.map(function (t) {
      var win = G.phase === 'trickEnd' && G.trickInfo && G.trickInfo.winner === t.pid;
      var cls = 'md' + (win ? ' win' : '') + (cx[t.card.id] ? ' cx' : '') + (G.fresh === t.card.id ? ' fresh' : '');
      return '<div class="at at-' + (keyOf[t.pid] || 'top') + '">' + cardEl(t.card, { cls: cls, style: '--r:' + tilt(t.card) + 'deg' }) + '</div>';
    }).join('');
  }

  function playerById(id) { return G.players.filter(function (p) { return p.id === id; })[0]; }

  function moneyDelta(n) {
    if (n > 0) return '<span class="plus">+' + brl(n) + '</span>';
    if (n < 0) return '<span class="minus">−' + brl(-n) + '</span>';
    return brl(0);
  }
  function overlayHTML(me) {
    var R = st.room, isHost = R.hostId === R.meId, h;
    if (st.confirmExit) {
      return '<div class="overlay" role="dialog" aria-label="Sair da partida"><h2>Sair da partida?</h2><p class="sub2">Um bot assume o seu lugar e o seu dinheiro na mesa.</p>' +
        '<div class="acts"><button type="button" class="btn ghost" data-act="exit-no" data-key="exit-no">Continuar</button>' +
        '<button type="button" class="btn" data-act="exit-yes" data-key="exit-yes">Sair</button></div></div>';
    }
    if (G.paused) {
      var P = G.paused;
      return '<div class="overlay" role="dialog" aria-label="Jogo pausado"><h2>Jogo pausado</h2>' +
        '<p class="line">' + (P.auto ? 'Todo mundo desconectou. O jogo continua quando alguém voltar.' : esc(P.by) + ' pausou o jogo.') + '</p>' +
        (P.canResume && !P.auto ? '<div class="acts"><button type="button" class="btn" data-act="resume" data-key="resume">Continuar o jogo</button></div>'
          : (P.auto ? '' : '<p class="sub2">Aguardando ' + esc(P.by) + ' continuar.</p>')) + '</div>';
    }
    if (G.phase === 'roundEnd' && G.summary) {
      var s = G.summary;
      h = '<div class="overlay" role="dialog" aria-label="Resultado da rodada"><h2>Fim da rodada ' + G.round + '</h2>';
      if (s.pot > 0) {
        if (s.returned) h += '<p class="line">' + (s.reason === 'all' ? 'Todo mundo acertou.' : 'Ninguém acertou.') + ' Cada um recebe a aposta de volta.</p>';
        else h += '<p class="line">Quem acertou recebeu a aposta de volta e dividiu ' + brl(s.lostPot) + ' de quem errou.</p>';
      }
      h += '<table><thead><tr><th>Jogador</th><th>Apostou</th><th>Fez</th><th>Vidas</th><th>R$</th></tr></thead><tbody>' +
        s.rows.map(function (r) {
          return '<tr><td class="who">' + esc(r.name) + '</td><td>' + r.bet + '</td><td>' + r.won + '</td><td>' +
            (r.lost ? '<span class="lost">−' + r.lost + '</span>' : '<span class="ok">✓</span>') + '</td><td class="num">' + moneyDelta(r.delta) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<div class="acts"><button type="button" class="btn" data-act="next" data-key="next">Próxima rodada</button></div></div>';
      return h;
    }
    if (G.phase === 'gameOver') {
      var names = G.winners.map(function (id) { var p = playerById(id); return p ? p.name : '?'; });
      var youWon = G.winners.indexOf(R.meId) >= 0;
      var sorted = G.players.slice().sort(function (a, b) { return (b.lives - a.lives) || (b.money - a.money); });
      h = '<div class="overlay" role="dialog" aria-label="Fim de jogo"><h2>Fim de jogo</h2><p class="line">' +
        (names.length > 1 ? 'Empate entre ' + esc(names.join(' e ')) + '.' : (youWon ? 'Você ganhou!' : esc(names[0]) + ' ganhou.')) + '</p>' +
        '<table><thead><tr><th>Jogador</th><th>Vidas</th><th>Dinheiro</th></tr></thead><tbody>' +
        sorted.map(function (p) { return '<tr><td class="who">' + esc(p.name) + '</td><td>' + Math.max(p.lives, 0) + '</td><td class="num">' + brl(p.money) + '</td></tr>'; }).join('') +
        '</tbody></table><div class="acts"><button type="button" class="btn ghost" data-act="leave" data-key="leave">Sair</button>' +
        (isHost ? '<button type="button" class="btn" data-act="again" data-key="again">Voltar para a sala</button>' : '') + '</div>' +
        (isHost ? '' : '<p class="sub2">Aguardando o anfitrião voltar para a sala.</p>') + '</div>';
      return h;
    }
    return '';
  }

  function statusLine(me) {
    var cur = playerById(G.turn);
    var meTurn = G.turn === me.id;
    if (!me.alive && (G.phase === 'betting' || G.phase === 'playing')) return { text: 'Você foi eliminado. Pode acompanhar e usar o chat.', dim: true };
    if (G.phase === 'betting') {
      if (meTurn) return { text: blindNow() ? 'Você não vê a sua carta. Você leva?' : 'Quantas vazas você leva?' };
      return { text: 'Aguardando ' + (cur ? cur.name : '') + '...', dim: true };
    }
    if (G.phase === 'playing') {
      if (meTurn) return { text: 'Sua vez. Jogue uma carta.' };
      return { text: (cur ? cur.name : '') + ' joga...', dim: true };
    }
    if (G.phase === 'trickEnd' && G.trickInfo) {
      return { text: G.trickInfo.winner === me.id ? 'Você levou a vaza.' : G.trickInfo.text };
    }
    return null;
  }

  function ensureBetDefaults(me) {
    if (G.phase !== 'betting' || G.turn !== me.id) return;
    var opts = G.wagerOptions || [0];
    if (st.bet.round !== G.round) st.bet = { v: null, w: null, round: G.round };
    if (st.bet.w === null || opts.indexOf(st.bet.w) < 0) {
      st.bet.w = (st.lastWager !== null && opts.indexOf(st.lastWager) >= 0) ? st.lastWager : opts[0];
    }
    if (st.bet.v !== null && st.bet.v === G.forbidden) st.bet.v = null;
  }
  function betHTML(me) {
    var n = G.nCards, f = G.forbidden, opts = G.wagerOptions || [0], b = '', w = '';
    for (var i = 0; i <= n; i++) {
      var label = n === 1 ? (i === 0 ? 'Não levo' : 'Levo') : String(i);
      b += '<button type="button" class="btn opt" data-act="bv" data-v="' + i + '" data-key="bv' + i + '" aria-pressed="' + (st.bet.v === i) + '"' + (i === f ? ' disabled aria-label="' + i + ' não vale"' : '') + '>' + label + '</button>';
    }
    if (opts.length === 1 && opts[0] === 0) {
      w = '<p class="hint">Você está sem dinheiro. Joga só pelas vidas.</p>';
    } else {
      w = '<div class="betrow"><span class="lbl">Aposta</span><div class="bets">' + opts.map(function (v) {
        var all = v === me.money && opts.length > 1;
        return '<button type="button" class="btn opt alt" data-act="bw" data-w="' + v + '" data-key="bw' + v + '" aria-pressed="' + (st.bet.w === v) + '">' + (all ? 'Tudo · ' : '') + brl(v) + '</button>';
      }).join('') + '</div></div>';
    }
    var ready = st.bet.v !== null && st.bet.w !== null;
    var go = ready ? 'Apostar ' + (n === 1 ? (st.bet.v === 1 ? 'que levo' : 'que não levo') : st.bet.v + (st.bet.v === 1 ? ' vaza' : ' vazas')) + (st.bet.w > 0 ? ' · ' + brl(st.bet.w) : '') : 'Escolha a sua aposta';
    return '<div class="betbox"><div class="betrow"><span class="lbl">Vazas</span><div class="bets">' + b + '</div></div>' + w +
      '<button type="button" class="btn go" data-act="confirmbet" data-key="confirmbet"' + (ready ? '' : ' disabled') + '>' + esc(go) + '</button>' +
      (f >= 0 ? '<p class="hint">Você dá por último: não pode apostar ' + f + '.</p>' : '') + '</div>';
  }

  function gameHTML() {
    var R = st.room, n = G.players.length;
    var meIdx = 0;
    G.players.forEach(function (p, i) { if (p.id === R.meId) meIdx = i; });
    var me = G.players[meIdx], keyOf = {}, seats = '';
    keyOf[me.id] = 'me';
    for (var i = 1; i < n; i++) {
      var p = G.players[(meIdx + i) % n], k = SEAT_KEYS[n - 1][i - 1];
      keyOf[p.id] = k;
      seats += seatHTML(p, k);
    }
    ensureBetDefaults(me);
    var showPause = !G.paused && G.phase !== 'gameOver';
    var hud = '<div class="hud"><div class="info">Rodada ' + G.round + ' · ' + G.nCards + (G.nCards > 1 ? ' cartas' : ' carta') +
      (G.blind ? '<span class="chip">cega</span>' : '') + (G.pot > 0 ? '<span class="potchip">Pote ' + brl(G.pot) + '</span>' : '') + '</div>' +
      '<div class="acts">' + (showPause ? '<button type="button" class="btn ghost small" data-act="pause" data-key="pause">Pausar</button>' : '') +
      '<button type="button" class="btn ghost small chatbtn" data-act="chat" data-key="chat">Chat' + (st.unread ? '<span class="badge" id="badge">' + st.unread + '</span>' : '<span class="badge" id="badge" hidden></span>') + '</button>' +
      '<button type="button" class="btn ghost small" data-act="menu" data-key="menu">Sair</button></div></div>';
    var st2 = statusLine(me), dock = '';
    if (G.phase !== 'roundEnd' && G.phase !== 'gameOver') {
      if (st2 && !G.paused) dock += '<p class="status' + (st2.dim ? ' dim' : '') + '" role="status" aria-live="polite">' + esc(st2.text) + '</p>';
      if (G.phase === 'betting' && G.turn === me.id && me.inRound && !G.paused) dock += betHTML(me);
    }
    var emo = '<div class="emobar" role="group" aria-label="Reações">' + EMOJIS.map(function (e) {
      return '<button type="button" data-act="emoji" data-e="' + e + '" title="' + EMOJI_NAMES[e] + '" aria-label="' + EMOJI_NAMES[e] + '">' + e + '</button>';
    }).join('') + '</div>';
    return '<div class="app game">' + hud + '<div class="gamegrid"><div class="stage">' +
      '<div class="arenawrap"><div class="arena" id="arena">' + seats + meSeatHTML(me) + viraHTML() + playedHTML(keyOf) + overlayHTML(me) + '</div><div id="fx"></div></div>' +
      '<div class="dock">' + dock + '</div>' + emo + '</div>' +
      '<aside class="chatcol' + (st.chatOpen ? ' open' : '') + '" id="chatcol"><div class="chatslot"></div></aside></div></div>';
  }

  /* ================= chat ================= */
  var chatEl = null, chatList = null, chatInput = null;
  function buildChat() {
    chatEl = document.createElement('section');
    chatEl.className = 'chat';
    chatEl.setAttribute('aria-label', 'Chat da sala');
    chatEl.innerHTML = '<header class="chathead"><span>Chat</span><button type="button" class="chatclose" data-act="chatclose" aria-label="Fechar o chat">×</button></header>' +
      '<ol class="chatlist" id="chatlist" aria-live="polite"></ol>' +
      '<form class="chatform" id="chatform" autocomplete="off"><input id="chatinput" type="text" maxlength="200" placeholder="Digite uma mensagem" aria-label="Mensagem"><button type="submit" class="btn small">Enviar</button></form>';
    chatList = chatEl.querySelector('#chatlist');
    chatInput = chatEl.querySelector('#chatinput');
    chatEl.querySelector('#chatform').addEventListener('submit', function (e) {
      e.preventDefault();
      var t = chatInput.value.trim();
      if (!t) return;
      if (send({ t: 'chat', text: t })) chatInput.value = '';
    });
  }
  function chatLi(m) {
    var li = document.createElement('li');
    if (m.sys) { li.className = 'sys'; li.textContent = m.text; }
    else {
      if (st.room && m.from === st.room.meId) li.className = 'mine';
      var b = document.createElement('b'); b.textContent = m.name;
      li.appendChild(b); li.appendChild(document.createTextNode(m.text));
    }
    return li;
  }
  function renderChatList() {
    if (!chatList) return;
    chatList.textContent = '';
    st.chat.forEach(function (m) { chatList.appendChild(chatLi(m)); });
    chatList.scrollTop = chatList.scrollHeight;
  }
  function appendChat(m) {
    if (!chatList) return;
    var near = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 60;
    chatList.appendChild(chatLi(m));
    while (chatList.children.length > 80) chatList.removeChild(chatList.firstChild);
    if (near || (st.room && m.from === st.room.meId)) chatList.scrollTop = chatList.scrollHeight;
  }
  function chatVisible() {
    if (!st.room || st.room.phase !== 'game') return true;
    return st.chatOpen || (window.matchMedia && window.matchMedia('(min-width: 1180px)').matches);
  }
  function updateBadge() {
    var b = $('badge');
    if (!b) return;
    b.textContent = st.unread;
    b.hidden = !st.unread;
  }
  function mountChat() {
    var slot = document.querySelector('.chatslot');
    if (!slot || !chatEl) return;
    if (chatEl.parentNode !== slot) {
      slot.appendChild(chatEl);
      chatList.scrollTop = chatList.scrollHeight;
    }
  }

  /* ================= emojis flutuantes ================= */
  function showEmoji(pid, e) {
    var fx = $('fx'), wrap = document.querySelector('.arenawrap');
    if (!fx || !wrap) return;
    var seat = null, seatsEls = wrap.querySelectorAll('.seat');
    for (var i = 0; i < seatsEls.length; i++) if (seatsEls[i].getAttribute('data-pid') === pid) seat = seatsEls[i];
    if (!seat) return;
    var a = seat.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    var span = document.createElement('span');
    span.className = 'emo';
    span.textContent = e;
    span.style.left = (a.left - w.left + a.width / 2 + (Math.random() * 30 - 15)) + 'px';
    span.style.top = (a.top - w.top + a.height * 0.35) + 'px';
    fx.appendChild(span);
    setTimeout(function () { if (span.parentNode) span.parentNode.removeChild(span); }, 2700);
  }

  /* ================= render ================= */
  function bannerHTML() {
    return st.authed && st.conn !== 'open' ? '<div class="banner" role="status">Reconectando...</div>' : '';
  }
  function render() {
    var root = $('root');
    if (!root) return;
    var ak = document.activeElement, key = ak && ak.dataset ? ak.dataset.key : null;
    var selStart = null;
    if (ak && ak.tagName === 'INPUT' && ak.selectionStart !== undefined) selStart = ak.selectionStart;
    G = st.room && st.room.game ? st.room.game : null;
    var h;
    if (st.resuming || (!st.authed && st.conn !== 'open')) h = connectingHTML();
    else if (!st.authed) h = authHTML();
    else if (!st.room) h = homeHTML();
    else if (st.room.phase === 'lobby' || !G) h = lobbyHTML();
    else h = gameHTML();
    root.innerHTML = h + bannerHTML();
    mountChat();
    if (key) {
      var el = document.querySelector('[data-key="' + key + '"]');
      if (el && !el.disabled) {
        el.focus({ preventScroll: true });
        if (selStart !== null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selStart); } catch (e) {} }
      }
    }
  }

  /* ================= eventos ================= */
  function copyText(text, input) {
    function fallback() {
      try {
        if (input) { input.focus(); input.select(); }
        var ok = document.execCommand && document.execCommand('copy');
        toast(ok ? 'Copiado!' : 'Selecione e copie o link.');
      } catch (e) { toast('Selecione e copie o link.'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copiado!'); }, fallback);
    } else fallback();
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    switch (act) {
      case 'tab': st.tab = t.getAttribute('data-tab'); st.authErr = ''; render(); break;
      case 'create': send({ t: 'create' }); break;
      case 'solo': st.solo = true; if (!send({ t: 'create' })) st.solo = false; break;
      case 'solobots': st.soloBots = parseInt(t.getAttribute('data-v'), 10); LS.set('fodinha.bots', String(st.soloBots)); render(); break;
      case 'logout':
        st.token = null; LS.del('fodinha.token'); st.authed = false; st.me = null; st.room = null; st.chat = []; st.authErr = '';
        renderChatList();
        if (ws) { try { ws.close(); } catch (x) {} }
        render();
        break;
      case 'leave': send({ t: 'leave' }); break;
      case 'menu': st.confirmExit = true; render(); break;
      case 'exit-no': st.confirmExit = false; render(); break;
      case 'exit-yes': st.confirmExit = false; send({ t: 'leave' }); break;
      case 'set': {
        var k = t.getAttribute('data-k'), v = t.getAttribute('data-v'), S = st.room.settings;
        var msg = { t: 'settings', lives: S.lives, manilha: S.manilha, money: S.money, bots: S.bots };
        msg[k] = (k === 'manilha') ? v === 'true' : parseInt(v, 10);
        send(msg);
        break;
      }
      case 'copylink': copyText(location.origin + '/?sala=' + st.room.code, $('linkbox')); break;
      case 'start': send({ t: 'start' }); break;
      case 'again': send({ t: 'again' }); break;
      case 'next': send({ t: 'next' }); break;
      case 'pause': send({ t: 'pause' }); break;
      case 'resume': send({ t: 'resume' }); break;
      case 'bv': st.bet.v = parseInt(t.getAttribute('data-v'), 10); render(); break;
      case 'bw': st.bet.w = parseInt(t.getAttribute('data-w'), 10); render(); break;
      case 'confirmbet':
        if (st.bet.v !== null && st.bet.w !== null) {
          st.lastWager = st.bet.w > 0 ? st.bet.w : st.lastWager;
          send({ t: 'bet', vazas: st.bet.v, wager: st.bet.w });
        }
        break;
      case 'play': send({ t: 'play', id: t.getAttribute('data-id') }); break;
      case 'emoji': {
        var now = Date.now();
        if (now - st.lastEmojiAt < 400) break;
        st.lastEmojiAt = now;
        send({ t: 'emoji', e: t.getAttribute('data-e') });
        break;
      }
      case 'chat': st.chatOpen = true; st.unread = 0; render(); setTimeout(function () { if (chatInput) chatInput.focus(); }, 220); break;
      case 'chatclose': st.chatOpen = false; render(); break;
      default: break;
    }
  });

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.id) return;
    if (f.id === 'authform') {
      e.preventDefault();
      var name = ($('f-name') || {}).value || '', pw = ($('f-pw') || {}).value || '';
      st.form.name = name;
      if (name.trim().length < 2) { st.authErr = 'Digite um nome com pelo menos 2 letras.'; render(); return; }
      if (st.tab !== 'guest' && pw.length < 4) { st.authErr = 'A senha precisa ter pelo menos 4 caracteres.'; render(); return; }
      st.authBusy = true; st.authErr = '';
      if (!send({ t: 'auth', mode: st.tab === 'guest' ? 'guest' : st.tab, name: name.trim(), password: pw })) st.authBusy = false;
      render();
    } else if (f.id === 'joinform') {
      e.preventDefault();
      var code = (($('f-code') || {}).value || '').toUpperCase().replace(/[^A-Z]/g, '');
      if (code.length !== 4) { toast('O código tem 4 letras.'); return; }
      send({ t: 'join', code: code });
    }
  });

  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el) return;
    if (el.id === 'f-code') {
      var v = el.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (el.value !== v) el.value = v;
      st.codeInput = v;
    } else if (el.id === 'f-name') {
      st.form.name = el.value;
    }
  });

  buildChat();
  render();
  connect();
})();
