// ── Config ──────────────────────────────────────────────────────────────────
const WS_URL       = 'wss://hack.chat/chat-ws';
const DEFAULT_ROOM = 'gamegram';
const RECONNECT_MS = 4000;

// ── State ────────────────────────────────────────────────────────────────────
let ws        = null;
let nick      = '';
let room      = DEFAULT_ROOM;
let nickColor = '#7c3aed';
let reconnectTimer = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const loginEl       = $('login');
const loginBtn      = $('loginBtn');
const nickInput     = $('nickInput');
const roomInput     = $('roomInput');
const sendBtn       = $('send');
const msgInput      = $('input');
const messages      = $('messages');
const userList      = $('userList');
const meName        = $('meName');
const settingsBtn   = $('settingsBtn');
const settingsModal = $('settingsModal');
const closeSettings = $('closeSettings');
const nickColorPick = $('nickColor');
const roomLabel     = $('roomLabel');
const themeSelect   = $('themeSelect');
const msgStyleSel   = $('msgStyle');
const fontSizeSl    = $('fontSize');
const nickSettInput = $('nickInputSettings');

// ── Utilities ─────────────────────────────────────────────────────────────────
function fmtTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sanitize(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scrollBottom() {
  messages.scrollTop = messages.scrollHeight;
}

// ── Render helpers ────────────────────────────────────────────────────────────
function addMessage(fromNick, text, ts, color) {
  const wrap = document.createElement('div');
  wrap.className = 'message';
  wrap.innerHTML =
    `<span class="time">${fmtTime(ts)}</span>` +
    `<span class="nick" style="color:${sanitize(color || '#9090b0')}">${sanitize(fromNick)}</span>` +
    `<span class="text">${sanitize(text)}</span>`;
  messages.appendChild(wrap);
  scrollBottom();
}

function addSystem(text, type = '') {
  const wrap = document.createElement('div');
  wrap.className = `system-message ${type}`;
  wrap.innerHTML =
    `<span class="time">${fmtTime()}</span>` +
    `<span class="text">${sanitize(text)}</span>`;
  messages.appendChild(wrap);
  scrollBottom();
}

function setStatus(text, ok) {
  const el = $('statusDot');
  if (!el) return;
  el.textContent = text;
  el.className   = 'status-dot ' + (ok ? 'connected' : 'disconnected');
}

function renderUsers(users) {
  userList.innerHTML = '';
  users
    .slice()
    .sort((a, b) => (a.nick || a).localeCompare(b.nick || b))
    .forEach(u => {
      const d = document.createElement('div');
      d.className = 'user-entry';
      const n = u.nick || u;
      const c = u.color || '#9090b0';
      d.innerHTML = `<span class="user-dot"></span><span style="color:${sanitize(c)}">${sanitize(n)}</span>`;
      userList.appendChild(d);
    });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
  clearTimeout(reconnectTimer);

  if (ws) {
    try { ws.close(); } catch (_) {}
  }

  setStatus('Connecting…', false);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus('Connected', true);
    ws.send(JSON.stringify({ cmd: 'join', nick, channel: room }));
  };

  ws.onmessage = e => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }

    switch (data.cmd) {
      case 'onlineSet':
        addSystem(`Joined #${room} · ${(data.users || []).length} online`);
        renderUsers(data.users || []);
        break;

      case 'chat':
        addMessage(data.nick, data.text, data.time ? data.time * 1000 : null, data.color);
        break;

      case 'emote':
        addSystem(`* ${data.nick} ${data.text}`, 'emote');
        break;

      case 'onlineAdd': {
        const existing = [...userList.querySelectorAll('.user-entry')].map(el => el.textContent.trim());
        if (!existing.some(t => t === (data.nick || ''))) {
          const d = document.createElement('div');
          d.className = 'user-entry';
          d.innerHTML = `<span class="user-dot"></span><span style="color:${sanitize(data.color||'#9090b0')}">${sanitize(data.nick)}</span>`;
          userList.appendChild(d);
        }
        addSystem(`→ ${data.nick} joined`);
        break;
      }

      case 'onlineRemove': {
        const entries = userList.querySelectorAll('.user-entry');
        entries.forEach(el => { if (el.textContent.trim() === (data.nick || '')) el.remove(); });
        addSystem(`← ${data.nick} left`);
        break;
      }

      case 'warn':
        addSystem(`⚠ ${data.text}`, 'warn');
        break;

      case 'info':
        addSystem(`ℹ ${data.text}`);
        break;

      default:
        break;
    }
  };

  ws.onerror = () => {
    setStatus('Error', false);
  };

  ws.onclose = () => {
    setStatus('Disconnected', false);
    addSystem('Disconnected — reconnecting in 4 s…');
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  };
}

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ cmd: 'chat', text }));
  msgInput.value = '';
}

// ── Login ─────────────────────────────────────────────────────────────────────
function doLogin() {
  nick = nickInput.value.trim() || 'Guest' + Math.floor(Math.random() * 9000 + 1000);
  room = roomInput.value.trim() || DEFAULT_ROOM;
  loginEl.classList.add('hidden');
  roomLabel.textContent = '#' + room;
  meName.textContent    = nick;
  if (nickSettInput) nickSettInput.value = nick;
  connect();
}

// ── Settings ──────────────────────────────────────────────────────────────────
function openSettings() { settingsModal.classList.remove('hidden'); }
function closeSettingsModal() {
  settingsModal.classList.add('hidden');
  const newNick = nickSettInput?.value.trim();
  if (newNick && newNick !== nick) { nick = newNick; meName.textContent = nick; }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Restore saved prefs
  try {
    const saved = JSON.parse(localStorage.getItem('ggChatPrefs') || '{}');
    if (saved.nick)      { nickInput.value = saved.nick; }
    if (saved.room)      { roomInput.value = saved.room; }
    if (saved.color)     { nickColor = saved.color; if (nickColorPick) nickColorPick.value = saved.color; }
    if (saved.theme)     { document.body.dataset.theme = saved.theme; if (themeSelect) themeSelect.value = saved.theme; }
    if (saved.msgStyle)  { document.body.dataset.msgstyle = saved.msgStyle; if (msgStyleSel) msgStyleSel.value = saved.msgStyle; }
    if (saved.fontSize)  { document.body.style.fontSize = saved.fontSize + 'px'; if (fontSizeSl) fontSizeSl.value = saved.fontSize; }
  } catch (_) {}

  function savePrefs() {
    localStorage.setItem('ggChatPrefs', JSON.stringify({
      nick: nick || nickInput.value,
      room: room || roomInput.value,
      color: nickColor,
      theme: document.body.dataset.theme,
      msgStyle: document.body.dataset.msgstyle,
      fontSize: fontSizeSl?.value,
    }));
  }

  loginBtn?.addEventListener('click', doLogin);
  [nickInput, roomInput].forEach(el => el?.addEventListener('keypress', e => { if (e.key === 'Enter') doLogin(); }));

  sendBtn?.addEventListener('click', sendMessage);
  msgInput?.addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage(); });

  settingsBtn?.addEventListener('click', openSettings);
  closeSettings?.addEventListener('click', closeSettingsModal);

  nickColorPick?.addEventListener('change', e => { nickColor = e.target.value; savePrefs(); });
  themeSelect?.addEventListener('change', e => { document.body.dataset.theme = e.target.value; savePrefs(); });
  msgStyleSel?.addEventListener('change', e => { document.body.dataset.msgstyle = e.target.value; savePrefs(); });
  fontSizeSl?.addEventListener('input', e => { document.body.style.fontSize = e.target.value + 'px'; });
  fontSizeSl?.addEventListener('change', savePrefs);
});
