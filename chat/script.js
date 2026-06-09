// ── Config ───────────────────────────────────────────────────
const WS_URL       = 'wss://hack.chat/chat-ws';
const DEFAULT_ROOM = 'gamegram';
const RECONNECT_MS = 4000;

// ── State ────────────────────────────────────────────────────
let ws            = null;
let nick          = '';
let room          = DEFAULT_ROOM;
let nickColor     = '#7c3aed';
let emoji         = '🎮';
let reconnectTimer = null;
let tttState      = null;

// ── DOM ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Profile / Room history ────────────────────────────────────
function loadProfile() {
  const p = JSON.parse(localStorage.getItem('gg-profile') || '{}');
  if (p.nick)  { nick = p.nick;   const ni = $('nickInput'); if (ni) ni.value = p.nick; }
  if (p.color) { nickColor = p.color; const ci = $('nickColor'); if (ci) ci.value = p.color; }
  if (p.emoji) { emoji = p.emoji; }
  if (p.room)  { const ri = $('roomInput'); if (ri) ri.value = p.room; }
  updateSelf();
}

function saveProfile() {
  localStorage.setItem('gg-profile', JSON.stringify({ nick, color: nickColor, emoji, room }));
}

function getRoomHistory() {
  return JSON.parse(localStorage.getItem('gg-rooms') || '["gamegram"]');
}

function saveRoomToHistory(r) {
  let rooms = getRoomHistory();
  rooms = [r, ...rooms.filter(x => x !== r)].slice(0, 8);
  localStorage.setItem('gg-rooms', JSON.stringify(rooms));
}

// ── Utilities ─────────────────────────────────────────────────
function fmtTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function san(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scrollBottom(el) {
  const m = el || $('messages');
  if (m) m.scrollTop = m.scrollHeight;
}

function updateSelf() {
  const me = $('meName');    if (me) me.textContent = nick || 'Guest';
  const em = $('selfEmoji'); if (em) em.textContent = emoji;
}

// ── Rich text renderer ────────────────────────────────────────
function renderText(rawText) {
  const gameRe = /https?:\/\/[^\s<>"]+\/games\/[\w%.+-]+\.html/g;
  const parts = [];
  let last = 0, m;
  while ((m = gameRe.exec(rawText)) !== null) {
    if (m.index > last) parts.push({ type: 'text', val: rawText.slice(last, m.index) });
    parts.push({ type: 'game', url: m[0] });
    last = m.index + m[0].length;
  }
  if (last < rawText.length) parts.push({ type: 'text', val: rawText.slice(last) });

  return parts.map(p => {
    if (p.type === 'text') return `<span>${san(p.val)}</span>`;
    const sUrl  = san(p.url);
    const sName = san(p.url.split('/').pop().replace('.html', '').replace(/[-_]/g, ' '));
    return `<span class="cs-game-card">
      <span class="cs-gc-icon">🎮</span>
      <span class="cs-gc-name">${sName}</span>
      <button class="cs-gc-play" onclick="window.open('${sUrl}','_blank')">▶ Play</button>
      <button class="cs-gc-split" onclick="openPlayChat('${sUrl}','${sName}')">⊞ Here</button>
    </span>`;
  }).join('');
}

// ── Message renderers ─────────────────────────────────────────
function addMessage(fromNick, text, ts, color, targetId) {
  const m = $(targetId || 'messages'); if (!m) return;
  const wrap = document.createElement('div');
  wrap.className = 'message';
  wrap.innerHTML =
    `<span class="time">${fmtTime(ts)}</span>` +
    `<span class="nick" style="color:${san(color||'#9090b0')}">${san(fromNick)}</span>` +
    `<span class="text">${renderText(text)}</span>`;
  m.appendChild(wrap);
  scrollBottom(m);
  if (!targetId) addMessage(fromNick, text, ts, color, 'pcMessages');
}

function addSystem(text, type, targetId) {
  const m = $(targetId || 'messages'); if (!m) return;
  const wrap = document.createElement('div');
  wrap.className = `system-message ${type || ''}`;
  wrap.innerHTML =
    `<span class="time">${fmtTime()}</span>` +
    `<span class="text">${san(text)}</span>`;
  m.appendChild(wrap);
  scrollBottom(m);
  if (!targetId) addSystem(text, type, 'pcMessages');
}

function setStatus(text, ok) {
  const el = $('statusDot'); if (!el) return;
  el.textContent = text;
  el.className = 'status-dot ' + (ok ? 'connected' : 'disconnected');
}

function renderUsers(users) {
  const ul = $('userList'); if (!ul) return;
  ul.innerHTML = '';
  users.slice()
    .sort((a, b) => (a.nick || a).localeCompare(b.nick || b))
    .forEach(u => {
      const d = document.createElement('div');
      d.className = 'user-entry';
      d.innerHTML = `<span class="user-dot"></span><span style="color:${san(u.color||'#9090b0')}">${san(u.nick||u)}</span>`;
      ul.appendChild(d);
    });
}

// ── Room panel ────────────────────────────────────────────────
function buildRoomPanel() {
  const panel = $('roomPanel'); if (!panel) return;
  const rooms = getRoomHistory();
  panel.innerHTML = rooms.map(r =>
    `<button class="room-btn${r === room ? ' active' : ''}" data-room="${san(r)}">${san(r)}</button>`
  ).join('') + `<button class="room-btn room-btn-new" id="newRoomBtn">+ New Room</button>`;

  panel.querySelectorAll('.room-btn[data-room]').forEach(btn =>
    btn.addEventListener('click', () => switchRoom(btn.dataset.room))
  );
  $('newRoomBtn')?.addEventListener('click', () => {
    const name = prompt('Room name (letters, numbers, hyphens):');
    if (name && /^[\w-]+$/.test(name)) switchRoom(name.toLowerCase());
  });
}

function switchRoom(newRoom) {
  if (!newRoom || newRoom === room) return;
  room = newRoom;
  saveRoomToHistory(room);
  const rl = $('roomLabel');        if (rl) rl.textContent = '#' + room;
  const hd = $('chatRoomDisplay'); if (hd) hd.textContent = '#' + room;
  const pl = $('pcRoomLabel');     if (pl) pl.textContent = '#' + room;
  const ml = $('messages');        if (ml) ml.innerHTML = '';
  const ul = $('userList');        if (ul) ul.innerHTML = '';
  buildRoomPanel();
  connect();
}

// ── WebSocket ─────────────────────────────────────────────────
function connect() {
  clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(); } catch (_) {} }
  setStatus('Connecting…', false);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus('Connected', true);
    ws.send(JSON.stringify({ cmd: 'join', nick, channel: room }));
  };

  ws.onmessage = e => {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    switch (data.cmd) {
      case 'onlineSet':
        addSystem(`Joined #${room} · ${(data.users||[]).length} online`);
        renderUsers(data.users || []);
        break;
      case 'chat':
        addMessage(data.nick, data.text, data.time ? data.time * 1000 : null, data.color);
        break;
      case 'emote':
        addSystem(`* ${data.nick} ${data.text}`, 'emote');
        break;
      case 'onlineAdd': {
        addSystem(`→ ${data.nick} joined`);
        const ul = $('userList');
        if (ul) {
          const d = document.createElement('div');
          d.className = 'user-entry';
          d.innerHTML = `<span class="user-dot"></span><span style="color:${san(data.color||'#9090b0')}">${san(data.nick)}</span>`;
          ul.appendChild(d);
        }
        break;
      }
      case 'onlineRemove': {
        addSystem(`← ${data.nick} left`);
        $('userList')?.querySelectorAll('.user-entry').forEach(el => {
          if (el.textContent.trim() === (data.nick || '')) el.remove();
        });
        break;
      }
      case 'warn': addSystem(`⚠ ${data.text}`, 'warn'); break;
      case 'info': addSystem(`ℹ ${data.text}`); break;
    }
  };

  ws.onerror = () => setStatus('Error', false);
  ws.onclose = () => {
    setStatus('Disconnected', false);
    addSystem('Disconnected — reconnecting…');
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  };
}

// ── Chat commands ─────────────────────────────────────────────
function handleCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  switch (cmd) {
    case '/roll': {
      const sides  = parseInt(parts[1]) || 6;
      const result = Math.floor(Math.random() * sides) + 1;
      if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ cmd: 'chat', text: `🎲 rolled a d${sides} and got ${result}!` }));
      else addSystem(`🎲 (offline) d${sides}: ${result}`);
      return;
    }
    case '/flip': {
      const r = Math.random() < 0.5 ? 'Heads 🪙' : 'Tails 🌕';
      if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ cmd: 'chat', text: `🪙 coin flip: ${r}` }));
      else addSystem(`🪙 (offline): ${r}`);
      return;
    }
    case '/ttt':
      startTTT();
      return;
    case '/room':
      if (parts[1]) switchRoom(parts[1].toLowerCase());
      else addSystem('Usage: /room <name>');
      return;
    case '/help':
      addSystem('Commands: /roll [sides] · /flip · /ttt · /room [name] · /help');
      return;
    default:
      addSystem(`Unknown command: ${cmd} — try /help`, 'warn');
  }
}

// ── Send ──────────────────────────────────────────────────────
function sendMessage(source) {
  const inp  = $(source === 'pc' ? 'pcInput' : 'input');
  const text = inp?.value.trim();
  if (!text) return;
  inp.value = '';
  if (text.startsWith('/')) { handleCommand(text); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) { addSystem('Not connected yet.'); return; }
  ws.send(JSON.stringify({ cmd: 'chat', text }));
}

// ── Tic-Tac-Toe ───────────────────────────────────────────────
const TTT_SYM = ['⬜', '❌', '⭕'];

function startTTT() {
  tttState = { board: Array(9).fill(0), turn: 1, winner: 0 };
  renderTTT();
  addSystem('Tic-Tac-Toe started! ❌ goes first. Click a square.');
}

function renderTTT() {
  if (!tttState) return;
  const m = $('messages'); if (!m) return;
  let el = m.querySelector('.cs-ttt');
  if (!el) { el = document.createElement('div'); el.className = 'cs-ttt'; m.appendChild(el); }
  const { board, turn, winner } = tttState;
  const status = winner
    ? (winner === 3 ? "Draw!" : `${TTT_SYM[winner]} wins!`)
    : `${TTT_SYM[turn]}'s turn`;
  el.innerHTML = `
    <div class="ttt-header">Tic-Tac-Toe <span class="ttt-status">${status}</span></div>
    <div class="ttt-board">
      ${board.map((c, i) =>
        `<button class="ttt-cell${c ? ' taken' : ''}" data-i="${i}" ${c || winner ? 'disabled' : ''}>${TTT_SYM[c]}</button>`
      ).join('')}
    </div>
    ${winner ? `<button class="ttt-reset">↺ Play Again</button>` : ''}
  `;
  el.querySelectorAll('.ttt-cell').forEach(b =>
    b.addEventListener('click', () => tttMove(+b.dataset.i))
  );
  el.querySelector('.ttt-reset')?.addEventListener('click', () => {
    tttState = { board: Array(9).fill(0), turn: 1, winner: 0 };
    renderTTT();
  });
  scrollBottom();
}

function tttMove(i) {
  if (!tttState || tttState.board[i] || tttState.winner) return;
  tttState.board[i] = tttState.turn;
  const w = checkTTT(tttState.board);
  if (w) {
    tttState.winner = w;
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ cmd: 'chat', text: w === 3 ? `🎮 TicTacToe: Draw!` : `🎮 TicTacToe: ${TTT_SYM[w]} wins!` }));
  } else {
    tttState.turn = tttState.turn === 1 ? 2 : 1;
  }
  renderTTT();
}

function checkTTT(b) {
  for (const [a, c, d] of [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]])
    if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.every(Boolean) ? 3 : 0;
}

// ── Play & Chat overlay ───────────────────────────────────────
function openPlayChat(url, name) {
  const overlay = $('playChatOverlay');
  const frame   = $('pcGameFrame');
  if (!overlay || !frame) return;
  frame.src = url;
  const t = $('pcGameTitle'); if (t) t.textContent = name || 'Game';
  const a = $('pcOpenTab');   if (a) a.href = url;
  const r = $('pcRoomLabel'); if (r) r.textContent = '#' + room;
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  // Track the game play
  try {
    const clicks = JSON.parse(localStorage.getItem('gg-clicks') || '{}');
    const key = name || 'Game';
    clicks[key] = (clicks[key] || 0) + 1;
    localStorage.setItem('gg-clicks', JSON.stringify(clicks));
    const lt = JSON.parse(localStorage.getItem('gg-stats-lt') || '{}');
    lt.totalGames = (lt.totalGames || 0) + 1;
    localStorage.setItem('gg-stats-lt', JSON.stringify(lt));
  } catch (_) {}
  setTimeout(() => $('pcInput')?.focus(), 150);
}
window.openPlayChat = openPlayChat;

function closePlayChat() {
  $('playChatOverlay')?.classList.add('hidden');
  document.body.style.overflow = '';
  const f = $('pcGameFrame'); if (f) f.src = '';
}

// ── Login ─────────────────────────────────────────────────────
function doLogin() {
  nick = $('nickInput')?.value.trim() || 'Guest' + Math.floor(Math.random() * 9000 + 1000);
  room = $('roomInput')?.value.trim() || DEFAULT_ROOM;
  saveProfile();
  saveRoomToHistory(room);
  $('login')?.classList.add('hidden');
  const rl = $('roomLabel');       if (rl) rl.textContent = '#' + room;
  const hd = $('chatRoomDisplay'); if (hd) hd.textContent = '#' + room;
  updateSelf();
  buildRoomPanel();
  connect();
}

// ── Settings ──────────────────────────────────────────────────
function openSettings() {
  const modal = $('settingsModal'); if (!modal) return;
  const ni = $('nickInputSettings'); if (ni) ni.value = nick;
  const ci = $('nickColor');         if (ci) ci.value = nickColor;
  const ev = $('emojiVal');          if (ev) ev.value = emoji;
  document.querySelectorAll('.emoji-opt').forEach(el =>
    el.classList.toggle('selected', el.textContent === emoji)
  );
  modal.classList.remove('hidden');
}

function saveSettings() {
  const newNick  = $('nickInputSettings')?.value.trim();
  const newColor = $('nickColor')?.value;
  const newEmoji = $('emojiVal')?.value;
  if (newNick)  nick = newNick;
  if (newColor) nickColor = newColor;
  if (newEmoji) emoji = newEmoji;
  updateSelf();
  saveProfile();
  $('settingsModal')?.classList.add('hidden');
}

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadProfile();
  buildRoomPanel();

  // Restore saved UI prefs
  try {
    const saved = JSON.parse(localStorage.getItem('ggChatPrefs') || '{}');
    if (saved.theme)     { document.body.dataset.theme = saved.theme; const ts = $('themeSelect'); if (ts) ts.value = saved.theme; }
    if (saved.msgStyle)  { document.body.dataset.msgstyle = saved.msgStyle; const ms = $('msgStyle'); if (ms) ms.value = saved.msgStyle; }
    if (saved.fontSize)  { document.body.style.fontSize = saved.fontSize + 'px'; const fs = $('fontSize'); if (fs) fs.value = saved.fontSize; }
  } catch (_) {}

  function savePrefs() {
    localStorage.setItem('ggChatPrefs', JSON.stringify({
      nick, room,
      color: nickColor,
      theme: document.body.dataset.theme,
      msgStyle: document.body.dataset.msgstyle,
      fontSize: $('fontSize')?.value,
    }));
  }

  // Login
  $('loginBtn')?.addEventListener('click', doLogin);
  [$('nickInput'), $('roomInput')].forEach(el =>
    el?.addEventListener('keypress', e => { if (e.key === 'Enter') doLogin(); })
  );

  // Send
  $('send')?.addEventListener('click', () => sendMessage('main'));
  $('input')?.addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage('main'); });

  // Settings
  $('settingsBtn')?.addEventListener('click', openSettings);
  $('closeSettings')?.addEventListener('click', saveSettings);
  $('saveSettings')?.addEventListener('click', saveSettings);
  $('nickColor')?.addEventListener('change', savePrefs);
  $('themeSelect')?.addEventListener('change', e => { document.body.dataset.theme = e.target.value; savePrefs(); });
  $('msgStyle')?.addEventListener('change', e => { document.body.dataset.msgstyle = e.target.value; savePrefs(); });
  $('fontSize')?.addEventListener('input', e => { document.body.style.fontSize = e.target.value + 'px'; });
  $('fontSize')?.addEventListener('change', savePrefs);

  // Emoji picker
  const emojiGrid = $('emojiPickGrid');
  if (emojiGrid) {
    const emojis = emojiGrid.textContent.trim().split(/\s+/);
    emojiGrid.innerHTML = emojis.map(e =>
      `<button class="emoji-opt${e === emoji ? ' selected' : ''}" type="button">${e}</button>`
    ).join('');
    emojiGrid.querySelectorAll('.emoji-opt').forEach(btn =>
      btn.addEventListener('click', () => {
        emojiGrid.querySelectorAll('.emoji-opt').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const ev = $('emojiVal'); if (ev) ev.value = btn.textContent;
        emoji = btn.textContent;
        updateSelf();
      })
    );
  }

  // Header buttons
  $('cmdHelpBtn')?.addEventListener('click', () =>
    addSystem('Commands: /roll [sides] · /flip · /ttt · /room [name] · /help')
  );
  $('shareRoomBtn')?.addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?room=${room}`;
    navigator.clipboard?.writeText(url)
      .then(() => addSystem(`Room link copied: ${url}`))
      .catch(() => addSystem(`Room link: ${url}`));
  });

  // Game share button — load game picker from index.json
  let _gamePicker = null;
  $('gameShareBtn')?.addEventListener('click', async () => {
    const inp = $('input'); if (!inp) return;
    if (!_gamePicker) {
      try {
        const res = await fetch('../games/index.json');
        const files = await res.json();
        _gamePicker = files.map(f => {
          const name = f.replace('.html','').replace(/[-_]/g,' ');
          return { name, url: `${location.origin}/games/${f}` };
        });
      } catch (_) {
        addSystem('Could not load game list.'); return;
      }
    }
    const name = prompt('Search a game to share (e.g. slope, 2048):');
    if (!name) return;
    const q = name.toLowerCase().trim();
    const match = _gamePicker.find(g => g.name.toLowerCase().includes(q));
    if (match) {
      inp.value = `🎮 Play "${match.name}": ${match.url}`;
      inp.focus();
    } else {
      addSystem('No matching game found. Try another name.');
    }
  });

  // Play & Chat overlay
  $('pcClose')?.addEventListener('click', closePlayChat);
  $('pcSend')?.addEventListener('click', () => sendMessage('pc'));
  $('pcInput')?.addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage('pc'); });
  $('playChatOverlay')?.addEventListener('click', e => {
    if (e.target === $('playChatOverlay')) closePlayChat();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('playChatOverlay')?.classList.contains('hidden')) closePlayChat();
  });

  // Handle ?room= deep-link
  const params = new URLSearchParams(location.search);
  const rp = params.get('room');
  if (rp && /^[\w-]+$/.test(rp)) {
    const ri = $('roomInput'); if (ri) ri.value = rp;
  }
});
