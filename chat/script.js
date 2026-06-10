// ══════════════════════════════════════════════════════
//   GameGram Chat — Discord-like features
// ══════════════════════════════════════════════════════

const WS_URL       = 'wss://hack.chat/chat-ws';
const DEFAULT_ROOM = 'gamegram';
const RECONNECT_MS = 4000;
const MAX_HISTORY  = 100;

let ws            = null;
let nick          = '';
let room          = DEFAULT_ROOM;
let nickColor     = '#8b5cf6';
let emoji         = '🎮';
let reconnectTimer = null;
let tttState      = null;
let messageId     = 0;
let replyTo       = null;
let unreadCount   = 0;
let isAtBottom    = true;
let lastMsgTime   = 0;
let lastSender    = '';
let usersOnline   = [];
let _gamePicker   = null;
const _recentHashes = [];  // dedup recent sent messages

const $ = id => document.getElementById(id);

// ══ Chat history ═════════════════════════════════════════════════════════════

function chatHistoryKey() { return 'gg-chat-' + room; }

function loadChatHistory() {
  const container = $('messages');
  if (!container) return;
  let hist;
  try { hist = JSON.parse(localStorage.getItem(chatHistoryKey()) || '[]'); } catch { hist = []; }
  if (!hist.length) return;
  container.innerHTML = '';
  lastSender = '';
  lastMsgTime = 0;
  hist.forEach(h => {
    if (h.type === 'system') {
      _renderSystemRaw(h.text, h.subType, h.ts);
    } else {
      _renderMessageRaw(h.id, h.from, h.text, h.ts, h.color, h.replyTo);
    }
  });
  scrollBottom();
}

function saveChatHistory() {
  const container = $('messages');
  if (!container) return;
  const items = [];
  container.querySelectorAll('.msg-wrap').forEach(el => {
    const type = el.dataset.type;
    if (type === 'system') {
      items.push({ type: 'system', text: el.dataset.text, subType: el.dataset.subtype || '', ts: +el.dataset.ts });
    } else {
      items.push({ type: 'msg', id: +el.dataset.id, from: el.dataset.from, text: el.dataset.text, color: el.dataset.color, ts: +el.dataset.ts, replyTo: el.dataset.replyto || null });
    }
  });
  const trimmed = items.slice(-MAX_HISTORY);
  localStorage.setItem(chatHistoryKey(), JSON.stringify(trimmed));
}

function clearChatHistory() {
  localStorage.removeItem(chatHistoryKey());
  const container = $('messages');
  if (container) container.innerHTML = '';
  lastSender = ''; lastMsgTime = 0;
}

// ══ Profile / Room history ═════════════════════════════════════════════════════════════════

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

// ══ Utilities ════════════════════════════════════════════════════════════════════════════════

function normalizeTimestamp(ts) {
  if (!ts) return null;
  const num = Number(ts);
  if (!isFinite(num) || num < 0) return null;
  // hack.chat sends seconds (< 1e11), but some servers may send milliseconds
  if (num < 1e11) return num * 1000;
  return num;
}
function fmtTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(ts) {
  return new Date(ts || Date.now()).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtFullTime(ts) {
  return new Date(ts || Date.now()).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function san(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scrollBottom(el) {
  const m = el || $('messages');
  if (m) m.scrollTop = m.scrollHeight;
  isAtBottom = true;
  unreadCount = 0;
  updateTitle();
  $('scrollDown').style.display = 'none';
}

function updateTitle() {
  const base = 'GameGram Chat';
  document.title = unreadCount ? `(${unreadCount}) ${base}` : base;
}

function updateSelf() {
  const me = $('meName');    if (me) me.textContent = nick || 'Guest';
  const em = $('selfEmoji'); if (em) em.textContent = emoji;
}

function playPing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.value = 0.03;
    o.start(); o.stop(ctx.currentTime + 0.08);
  } catch (_) {}
}

// ══ Emoji map ═══════════════════════════════════════════════════════════════════════════════════

const EMOJIS = [
  '😀','😂','😅','🥰','😉','😘','😎','🤔','😐','😒',
  '😔','😢','😭','😡','😤','🤬','😱','🤯','😳','🤐',
  '🎮','🎯','🏆','🚀','⚔️','🛡️','🐉','👾','🎲','🃏',
  '🔥','⚡','💎','🌟','🎭','🦊','🐺','🐸','🤖','👻',
  '💀','🧙','🥷','🎸','🌈','🌙','☄️','🍄','🏴','🎃',
  '🐦','🦁','👑','🏁','💯','💜','💚','💛','💙','💝',
  '👍','👎','👏','👌','👊','👋','👏','👍','👌','💩',
  '🎵','🎶','🎧','📺','📱','💻','📚','📖','✅','❌',
  '❗','❓','⭐','🎉','🎊','🎁','💋','💞','💕','💖'
];

// ══ Markdown & Link detection ═════════════════════════════════════════════════════════════════

const URL_RE = /https?:\/\/[^\s<>"]+/g;
const MENTION_RE = /@([a-zA-Z0-9_-]+)/g;

function renderMarkdown(text) {
  let html = san(text);

  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre class="code-block"><code>${code}</code></pre>`);
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Strikethrough
  html = html.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  // Underline
  html = html.replace(/__([^_]+)__/g, '<u>$1</u>');

  // Mentions
  html = html.replace(MENTION_RE, (m, name) => {
    const isMe = name.toLowerCase() === (nick || '').toLowerCase();
    return `<span class="mention${isMe ? ' mention-me' : ''}">@${san(name)}</span>`;
  });

  // URLs
  html = html.replace(URL_RE, url => {
    const sUrl = san(url);
    return `<a href="${sUrl}" target="_blank" rel="noopener" class="msg-link">${sUrl}</a>`;
  });

  return html;
}

// ══ Link preview (cached) ═══════════════════════════════════════════════════════════════════════════

const _linkCache = {};
const _linkPending = new Set();

function getCachedPreview(url) {
  const cached = localStorage.getItem('gg-link-previews');
  if (cached) {
    try {
      const all = JSON.parse(cached);
      if (all[url]) return all[url];
    } catch {}
  }
  return null;
}

function setCachedPreview(url, data) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem('gg-link-previews') || '{}'); } catch {}
  all[url] = { ...data, cachedAt: Date.now() };
  const keys = Object.keys(all).slice(-50);
  const trimmed = {};
  keys.forEach(k => trimmed[k] = all[k]);
  localStorage.setItem('gg-link-previews', JSON.stringify(trimmed));
}

async function fetchPreview(url) {
  if (_linkPending.has(url)) return;
  const cached = getCachedPreview(url);
  if (cached) return cached;
  _linkPending.add(url);
  try {
    const res = await fetch(`https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`, { method: 'GET', mode: 'cors' });
    if (res.ok) {
      const text = await res.text();
      const lines = text.split('\n').filter(l => l.trim());
      const title = lines[0]?.replace(/^Title:\s*/, '') || url;
      const desc = lines[1]?.replace(/^Description:\s*/, '') || '';
      const data = { title, desc, url };
      setCachedPreview(url, data);
      return data;
    }
  } catch {}
  _linkPending.delete(url);
  return null;
}

function renderLinkPreview(url) {
  const cached = getCachedPreview(url);
  if (!cached) {
    fetchPreview(url).then(data => {
      if (data) {
        const el = document.querySelector(`[data-preview-url="${san(url)}"]`);
        if (el) el.innerHTML = buildPreviewHTML(data);
      }
    });
    return `<div class="link-preview" data-preview-url="${san(url)}"><div class="link-preview-loading">Loading preview...</div></div>`;
  }
  return `<div class="link-preview" data-preview-url="${san(url)}">${buildPreviewHTML(cached)}</div>`;
}

function buildPreviewHTML(data) {
  const domain = new URL(data.url).hostname.replace(/^www\./, '');
  return `<a href="${san(data.url)}" target="_blank" rel="noopener" class="link-preview-inner">
    <div class="link-preview-domain">${san(domain)}</div>
    <div class="link-preview-title">${san(data.title || data.url)}</div>
    ${data.desc ? `<div class="link-preview-desc">${san(data.desc).slice(0, 120)}${data.desc.length > 120 ? '...' : ''}</div>` : ''}
  </a>`;
}

function hasLinks(text) {
  return URL_RE.test(text);
}

// ══ Rich text renderer (includes game cards + link previews) ════════════════════════════════

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

  let html = '';
  const urls = [];
  parts.forEach(p => {
    if (p.type === 'text') {
      html += renderMarkdown(p.val);
      const found = p.val.match(URL_RE);
      if (found) urls.push(...found);
    } else {
      const sUrl  = san(p.url);
      const sName = san(p.url.split('/').pop().replace('.html', '').replace(/[-_]/g, ' '));
      html += `<span class="cs-game-card">
        <span class="cs-gc-icon">🎮</span>
        <span class="cs-gc-name">${sName}</span>
        <button class="cs-gc-play" onclick="window.open('${sUrl}','_blank')">▶ Play</button>
        <button class="cs-gc-split" onclick="openPlayChat('${sUrl}','${sName}')">⊞ Here</button>
      </span>`;
    }
  });

  // Append link previews
  urls.forEach(url => {
    html += renderLinkPreview(url);
  });

  return html;
}

// ══ Message rendering ═════════════════════════════════════════════════════════════════════════════════════

function _addDateSeparator(ts) {
  const container = $('messages');
  if (!container) return;
  const d = fmtDate(ts);
  const el = document.createElement('div');
  el.className = 'date-separator';
  el.innerHTML = `<span class="date-sep-line"></span><span class="date-sep-text">${d}</span><span class="date-sep-line"></span>`;
  container.appendChild(el);
}

function _renderMessageRaw(id, fromNick, text, ts, color, replyToId) {
  const container = $('messages');
  if (!container) return;
  const now = ts || Date.now();
  const isGrouped = fromNick === lastSender && (now - lastMsgTime) < 5 * 60 * 1000;

  if (!isGrouped && lastMsgTime && fmtDate(now) !== fmtDate(lastMsgTime)) {
    _addDateSeparator(now);
  }

  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap' + (isGrouped ? ' grouped' : '');
  wrap.dataset.id = id;
  wrap.dataset.from = fromNick;
  wrap.dataset.text = text;
  wrap.dataset.color = color || '#9090b0';
  wrap.dataset.ts = now;
  wrap.dataset.type = 'msg';
  wrap.dataset.replyto = replyToId || '';

  const isMe = fromNick.toLowerCase() === (nick || '').toLowerCase();

  let replyHTML = '';
  if (replyToId) {
    const replyEl = container.querySelector(`[data-id="${replyToId}"]`);
    if (replyEl) {
      const rFrom = replyEl.dataset.from;
      const rText = replyEl.dataset.text;
      replyHTML = `<div class="msg-reply" onclick="scrollToMsg(${replyToId})">
        <div class="msg-reply-bar"></div>
        <div class="msg-reply-info">
          <span class="msg-reply-name" style="color:${replyEl.dataset.color}">${san(rFrom)}</span>
          <span class="msg-reply-text">${san(rText).slice(0, 60)}${rText.length > 60 ? '...' : ''}</span>
        </div>
      </div>`;
    }
  }

  const reactionsHTML = `<div class="msg-reactions" id="reactions-${id}"></div>`;
  const hoverActions = `<div class="msg-actions">
    <button class="msg-action-btn" onclick="setReply(${id})" title="Reply">↩️</button>
    <button class="msg-action-btn" onclick="showReactionMenu(${id}, this)" title="React">😀</button>
  </div>`;

  wrap.innerHTML =
    (isGrouped ? '' : `<div class="msg-avatar" style="background:${san(color || '#9090b0')}">${san(fromNick[0]?.toUpperCase() || '?')}</div>`) +
    `<div class="msg-body">
      ${replyHTML}
      ${isGrouped ? '' : `<div class="msg-meta">
        <span class="msg-name" style="color:${san(color || '#9090b0')}">${san(fromNick)}</span>
        <span class="msg-time" title="${fmtFullTime(now)}">${fmtTime(now)}</span>
        ${isMe ? '<span class="msg-badge me">ME</span>' : ''}
      </div>`}
      <div class="msg-text">${renderText(text)}</div>
      ${reactionsHTML}
    </div>` +
    hoverActions;

  container.appendChild(wrap);
  lastSender = fromNick;
  lastMsgTime = now;

  if (!isAtBottom) {
    unreadCount++;
    updateTitle();
    $('scrollDown').style.display = 'flex';
    $('scrollDownCount').textContent = unreadCount;
  } else {
    scrollBottom();
  }
}

function addMessage(fromNick, text, ts, color) {
  messageId++;
  const id = messageId;
  // Parse inline reply tag from other GameGram clients
  let replyToId = replyTo;
  let cleanText = text;
  const replyMatch = text.match(/^\[reply:(\d+)\](.*)$/s);
  if (replyMatch) {
    replyToId = parseInt(replyMatch[1], 10);
    cleanText = replyMatch[2];
  }
  replyTo = null;
  hideReplyBar();
  _renderMessageRaw(id, fromNick, cleanText, ts || Date.now(), color, replyToId);
  if (!ts) saveChatHistory();
  if (!document.hasFocus() && fromNick !== nick) playPing();
  if (!document.hasFocus()) {
    unreadCount++;
    updateTitle();
  }
}

function _renderSystemRaw(text, type, ts) {
  const container = $('messages');
  if (!container) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap system-msg';
  wrap.dataset.text = text;
  wrap.dataset.subtype = type || '';
  const normTs = normalizeTimestamp(ts) || Date.now();
  wrap.dataset.ts = normTs;
  wrap.dataset.type = 'system';
  wrap.innerHTML = `<span class="time">${fmtTime(normTs)}</span><span class="text">${san(text)}</span>`;
  container.appendChild(wrap);
  if (isAtBottom) scrollBottom();
}

function addSystem(text, type) {
  _renderSystemRaw(text, type);
  saveChatHistory();
}

function scrollToMsg(id) {
  const el = document.querySelector(`[data-id="${id}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-highlight');
    setTimeout(() => el.classList.remove('msg-highlight'), 1500);
  }
}

function setReply(id) {
  const el = document.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  replyTo = id;
  $('replyBar').style.display = 'flex';
  $('replyBarName').textContent = el.dataset.from;
  $('replyBarName').style.color = el.dataset.color;
  $('replyBarText').textContent = el.dataset.text.slice(0, 40);
  $('input').focus();
}

function hideReplyBar() {
  $('replyBar').style.display = 'none';
  replyTo = null;
}

// ══ Reactions ═══════════════════════════════════════════════════════════════════════════════════════════

function getReactions(msgId) {
  const all = JSON.parse(localStorage.getItem('gg-reactions') || '{}');
  return all[msgId] || {};
}

function setReaction(msgId, emojiChar) {
  const all = JSON.parse(localStorage.getItem('gg-reactions') || '{}');
  if (!all[msgId]) all[msgId] = {};
  const current = all[msgId][emojiChar] || 0;
  all[msgId][emojiChar] = current + 1;
  localStorage.setItem('gg-reactions', JSON.stringify(all));
  renderReactions(msgId);
}

function renderReactions(msgId) {
  const el = document.getElementById(`reactions-${msgId}`);
  if (!el) return;
  const rx = getReactions(msgId);
  const entries = Object.entries(rx).filter(([,n]) => n > 0);
  if (!entries.length) { el.innerHTML = ''; return; }
  el.innerHTML = entries.map(([e, n]) =>
    `<span class="reaction-chip" onclick="setReaction(${msgId}, '${e}')">${e} <span class="reaction-count">${n}</span></span>`
  ).join('');
}

function showReactionMenu(msgId, btn) {
  const quick = ['👍','👎','😂','😱','❤️','🔥','👏','🎮'];
  const menu = document.createElement('div');
  menu.className = 'reaction-menu';
  menu.innerHTML = quick.map(e => `<button class="reaction-menu-item" onclick="setReaction(${msgId}, '${e}'); this.parentElement.remove()">${e}</button>`).join('');
  const rect = btn.getBoundingClientRect();
  menu.style.cssText = `position:fixed;z-index:9000;top:${rect.top - 44}px;left:${rect.left}px;`;
  document.body.appendChild(menu);
  const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 10);
}

// ══ Status / User list ══════════════════════════════════════════════════════════════════════════════════════

function setStatus(text, ok) {
  const el = $('statusDot'); if (!el) return;
  el.textContent = text;
  el.className = 'status-dot ' + (ok ? 'connected' : 'disconnected');
}

function renderUsers(users) {
  const ul = $('userList'); if (!ul) return;
  ul.innerHTML = '';
  usersOnline = users;
  users.slice()
    .sort((a, b) => (a.nick || a).localeCompare(b.nick || b))
    .forEach(u => {
      const d = document.createElement('div');
      d.className = 'user-entry';
      const nickName = u.nick || u;
      const isMe = nickName.toLowerCase() === (nick || '').toLowerCase();
      d.innerHTML = `<span class="user-dot" style="background:${san(u.color || '#22c55e')}"></span>
        <span class="user-name" style="color:${san(u.color || '#9090b0')}">${san(nickName)}</span>
        ${isMe ? '<span class="user-badge">YOU</span>' : ''}`;
      d.addEventListener('click', () => {
        const inp = $('input');
        if (inp) { inp.value += ` @${nickName} `; inp.focus(); }
      });
      ul.appendChild(d);
    });
}

// ══ Typing indicator ═════════════════════════════════════════════════════════════════════════════════════

let typingTimer = null;
function showTyping() {
  const el = $('typingIndicator');
  if (el) el.style.display = 'flex';
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { if (el) el.style.display = 'none'; }, 3000);
}

// ══ Room panel ══════════════════════════════════════════════════════════════════════════════════════════

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
  lastSender = ''; lastMsgTime = 0;
  buildRoomPanel();
  loadChatHistory();
  connect();
}

// ══ WebSocket ═════════════════════════════════════════════════════════════════════════════════════════════════

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
        // Dedup: if this chat is from us and we recently sent the same text, skip
        const isSelf = (data.nick || '').toLowerCase() === (nick || '').toLowerCase();
        const hash = `${data.nick}:${data.text}:${Math.floor(normalizeTimestamp(data.time) / 1000)}`;
        if (isSelf) {
          if (_recentHashes.includes(hash)) break;
          _recentHashes.push(hash);
          if (_recentHashes.length > 10) _recentHashes.shift();
        }
        addMessage(data.nick, data.text, normalizeTimestamp(data.time), data.color);
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
          d.innerHTML = `<span class="user-dot" style="background:${san(data.color || '#22c55e')}"></span><span style="color:${san(data.color || '#9090b0')}">${san(data.nick)}</span>`;
          ul.appendChild(d);
        }
        break;
      }
      case 'onlineRemove': {
        addSystem(`← ${data.nick} left`);
        $('userList')?.querySelectorAll('.user-entry').forEach(el => {
          if (el.textContent.trim().startsWith(data.nick || '')) el.remove();
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

// ══ Chat commands ═══════════════════════════════════════════════════════════════════════════════════════════════

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
    case '/clear':
      clearChatHistory();
      addSystem('Chat history cleared for this room.');
      return;
    case '/help':
      addSystem('Commands: /roll [sides] · /flip · /ttt · /room [name] · /clear · /help');
      return;
    default:
      addSystem(`Unknown command: ${cmd} — try /help`, 'warn');
  }
}

// ══ Send ═════════════════════════════════════════════════════════════════════════════════════════════════

function sendMessage(source) {
  const inp  = $(source === 'pc' ? 'pcInput' : 'input');
  const text = inp?.value.trim();
  if (!text) return;
  inp.value = '';
  if (text.startsWith('/me ')) {
    const emoteText = text.slice(4);
    if (!ws || ws.readyState !== WebSocket.OPEN) { addSystem('Not connected yet.'); return; }
    ws.send(JSON.stringify({ cmd: 'emote', text: emoteText }));
    addSystem(`* ${nick || 'You'} ${emoteText}`, 'emote');
    return;
  }
  if (text.startsWith('/')) { handleCommand(text); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) { addSystem('Not connected yet.'); return; }
  // Embed reply context for other GameGram clients to parse
  let finalText = text;
  if (replyTo) {
    const replyEl = document.querySelector(`[data-id="${replyTo}"]`);
    if (replyEl) {
      finalText = `[reply:${replyTo}]${text}`;
    }
  }
  ws.send(JSON.stringify({ cmd: 'chat', text: finalText }));
  // Track outgoing hash for dedup of echo
  const now = Date.now();
  const hash = `${nick}:${finalText}:${Math.floor(now / 1000)}`;
  _recentHashes.push(hash);
  if (_recentHashes.length > 10) _recentHashes.shift();
}

// ══ Tic-Tac-Toe ══════════════════════════════════════════════════════════════════════════════════════

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

// ══ Play & Chat overlay ═════════════════════════════════════════════════════════════════════════════════════

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

// ══ Emoji picker ═══════════════════════════════════════════════════════════════════════════════════════════

function buildEmojiPicker() {
  const grid = $('emojiPickerGrid');
  if (!grid) return;
  grid.innerHTML = EMOJIS.map(e => `<button class="emoji-picker-item" type="button">${e}</button>`).join('');
  grid.querySelectorAll('.emoji-picker-item').forEach(btn => {
    btn.addEventListener('click', () => insertEmoji(btn.textContent));
  });
}

function insertEmoji(emojiChar) {
  const inp = $('input');
  if (!inp) return;
  const start = inp.selectionStart;
  const end = inp.selectionEnd;
  const val = inp.value;
  inp.value = val.slice(0, start) + emojiChar + val.slice(end);
  inp.selectionStart = inp.selectionEnd = start + emojiChar.length;
  inp.focus();
}

function toggleEmojiPicker() {
  const picker = $('emojiPicker');
  if (!picker) return;
  const isHidden = picker.style.display === 'none';
  picker.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    // Close when clicking outside
    const close = e => {
      if (!picker.contains(e.target) && e.target.id !== 'emojiBtn') {
        picker.style.display = 'none';
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 10);
  }
}

// ══ Login ══════════════════════════════════════════════════════════════════════════════════════════════════

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
  loadChatHistory();
  connect();
}

// ══ Settings ═════════════════════════════════════════════════════════════════════════════════════════════

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

// ══ Boot ═════════════════════════════════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  loadProfile();
  buildRoomPanel();
  buildEmojiPicker();

  // Restore UI prefs
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

  // Scroll detection
  const msgContainer = $('messages');
  if (msgContainer) {
    msgContainer.addEventListener('scroll', () => {
      const thresh = 60;
      const nearBottom = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight < thresh;
      isAtBottom = nearBottom;
      if (nearBottom) {
        unreadCount = 0;
        updateTitle();
        $('scrollDown').style.display = 'none';
      }
    });
  }

  // Visibility
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      unreadCount = 0;
      updateTitle();
    }
  });

  // Login
  $('loginBtn')?.addEventListener('click', doLogin);
  [$('nickInput'), $('roomInput')].forEach(el =>
    el?.addEventListener('keypress', e => { if (e.key === 'Enter') doLogin(); })
  );

  // Send
  $('send')?.addEventListener('click', () => sendMessage('main'));
  $('input')?.addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage('main'); });

  // Emoji
  $('emojiBtn')?.addEventListener('click', e => { e.stopPropagation(); toggleEmojiPicker(); });
  $('emojiPickerClose')?.addEventListener('click', () => { $('emojiPicker').style.display = 'none'; });

  // Reply
  $('replyBarClose')?.addEventListener('click', hideReplyBar);

  // Scroll down
  $('scrollDown')?.addEventListener('click', () => scrollBottom());

  // Settings
  $('settingsBtn')?.addEventListener('click', openSettings);
  $('closeSettings')?.addEventListener('click', saveSettings);
  $('saveSettings')?.addEventListener('click', saveSettings);
  $('nickColor')?.addEventListener('change', savePrefs);
  $('themeSelect')?.addEventListener('change', e => { document.body.dataset.theme = e.target.value; savePrefs(); });
  $('msgStyle')?.addEventListener('change', e => { document.body.dataset.msgstyle = e.target.value; savePrefs(); });
  $('fontSize')?.addEventListener('input', e => { document.body.style.fontSize = e.target.value + 'px'; });
  $('fontSize')?.addEventListener('change', savePrefs);

  // Emoji picker grid in settings
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
    addSystem('Commands: /roll [sides] · /flip · /ttt · /room [name] · /clear · /help')
  );
  $('shareRoomBtn')?.addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?room=${room}`;
    navigator.clipboard?.writeText(url)
      .then(() => addSystem(`Room link copied: ${url}`))
      .catch(() => addSystem(`Room link: ${url}`));
  });

  // Game share
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

  // Deep-link
  const params = new URLSearchParams(location.search);
  const rp = params.get('room');
  if (rp && /^[\w-]+$/.test(rp)) {
    const ri = $('roomInput'); if (ri) ri.value = rp;
  }
});
