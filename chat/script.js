// script.js — hack.chat client using hackchat-engine Client
// Requires bundling (npm i hackchat-engine) or making Client available globally.
// This file is written as an ES module and expects the bundler to resolve the
// `hackchat-engine` package. It preserves your UI, storage, reactions and logging
// and replaces the P2P networking with the official Client class.

import { Client } from 'hackchat-engine'; // bundler must provide this

/* eslint-disable no-console */

// ================== CONFIGURATION ==================
const CONFIG = {
  PUBLIC_ROOM: "public",
  HACKCHAT: {
    // Default gateway used by the library; you can override it here.
    ENDPOINT: "wss://hack.chat/chat-ws",
    // Optional: pass in client options (for example ws.gateway override)
    CLIENT_OPTIONS: {
      ws: {
        gateway: "wss://hack.chat/chat-ws"
      }
    }
  },
  TIMEOUTS: {
    HANDSHAKE: 2500,
    RECONNECT: 3000,
    CONNECTION_RETRY: 5000,
  },
  INTERVALS: {
    GOSSIP: 20000,
    BOOTSTRAP_CHECK: 10000,
    RESYNC: 15000,
    DEBUG_GRAPH: 10000,
  },
  DEBUG_VERBOSE: true // when true, send every debug payload to debug panel
};

// ================== STATE MANAGEMENT ==================
class ChatState {
  constructor() {
    this.nickname = "";
    this.nickColor = "#ffffff";
    this.status = "online";
    this.localId = null;
    this.client = null; // hackchat-engine Client instance
    this.users = new Map();
    this.knownPeers = new Set();
    this.chatHistory = [];
    this.intervals = new Map();
  }

  reset() {
    this.clearIntervals();
    this.users.clear();
    this.knownPeers.clear();
    this.chatHistory = [];
    try { if (this.client) this.client.close && this.client.close(); } catch(e) {}
    this.client = null;
  }

  clearIntervals() {
    this.intervals.forEach(i => clearInterval(i));
    this.intervals.clear();
  }
}

const state = new ChatState();

// ================== DOM ELEMENTS ==================
const elements = {
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  sendBtn: document.getElementById('send'),
  userList: document.getElementById('userList'),
  login: document.getElementById('login'),
  nickInput: document.getElementById('nickInput'),
  loginBtn: document.getElementById('loginBtn'),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsModal: document.getElementById("settingsModal"),
  closeSettings: document.getElementById("closeSettings"),
  nickInputSettings: document.getElementById("nickInputSettings"),
  nickColorInput: document.getElementById("nickColor"),
  statusSelect: document.getElementById("statusSelect"),
  fontSizeInput: document.getElementById("fontSize"),
  themeSelect: document.getElementById("themeSelect"),
  msgStyleSelect: document.getElementById("msgStyle"),
  meName: document.getElementById("meName"),
  meStatus: document.getElementById("meStatus"),
  roomLabel: document.getElementById("roomLabel")
};

// ================== UTILITIES ==================
const Utils = {
  timestamp: () => new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
  escapeHtml: (str = '') => String(str).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]),
  generateId: () => `tmp-${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
  randomDelay: (base, variance) => base + Math.random() * variance,
  debounce: (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn.apply(this,a), wait); }; },
  throttle: (fn, limit) => { let inThrottle; return (...a) => { if (!inThrottle) { fn.apply(this,a); inThrottle = true; setTimeout(() => inThrottle = false, limit); } }; }
};

// ================== STORAGE MANAGER ==================
class StorageManager {
  static save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { Logger.error('Storage save failed', { key, error: e?.message }); }
  }
  static load(key, defaultValue = null) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : defaultValue; } catch (e) { Logger.error('Storage load failed', { key, error: e?.message }); return defaultValue; }
  }
  static saveUserSettings() {
    this.save('nickname', state.nickname);
    this.save('nickColor', state.nickColor);
    this.save('status', state.status);
    this.save('theme', document.body.dataset.theme || 'dark');
    this.save('msgStyle', document.body.dataset.msgstyle || 'modern');
    this.save('fontSize', elements.messages?.style?.fontSize || '14');
  }
  static loadUserSettings() {
    state.nickname = this.load('nickname','') || '';
    state.nickColor = this.load('nickColor','#ffffff') || '#ffffff';
    state.status = this.load('status','online') || 'online';
    if (elements.meName) elements.meName.textContent = state.nickname || 'Guest';
    if (elements.meStatus) elements.meStatus.textContent = `(${state.status})`;
    if (elements.nickColorInput) elements.nickColorInput.value = state.nickColor;
    if (elements.statusSelect) elements.statusSelect.value = state.status;
  }
  static saveChatHistory() { this.save('chatHistory', state.chatHistory); }
  static loadChatHistory() {
    const history = this.load('chatHistory', []);
    history.forEach(msg => UI.addMessage(msg.nick, msg.text, msg.time, msg.color, msg.id, false));
    state.chatHistory = history;
    history.forEach(msg => UI.renderReactions(msg.id, msg.reactions || {}));
  }
  static saveKnownPeers() { this.save('knownPeers', Array.from(state.knownPeers)); }
  static loadKnownPeers() { (this.load('knownPeers', []) || []).forEach(p => state.knownPeers.add(p)); }
}

// ================== LOGGING SYSTEM ==================
class Logger {
  static createDebugPanel() {
    let debugPanel = document.getElementById('debugPanel');
    if (!debugPanel) {
      debugPanel = document.createElement('div');
      debugPanel.id = 'debugPanel';
      debugPanel.className = 'p-2 border-t mt-2 text-xs font-mono bg-black text-green-400 max-h-60 overflow-y-auto';
      if (elements.settingsModal) elements.settingsModal.appendChild(debugPanel);
    }
    return debugPanel;
  }

  static log(level, message, data = null) {
    const debugPanel = Logger.createDebugPanel();
    if (debugPanel) {
      const line = document.createElement('div');
      const ts = Utils.timestamp();
      try {
        line.textContent = `[${ts}] [${level.toUpperCase()}] ${message}` + (data ? ` -- ${JSON.stringify(data, Logger._safeReplacer(), 2)}` : '');
      } catch (e) { line.textContent = `[${ts}] [${level.toUpperCase()}] ${message} -- (unserializable data)`; }
      debugPanel.appendChild(line);
      debugPanel.scrollTop = debugPanel.scrollHeight;
      while (debugPanel.children.length > 500) debugPanel.removeChild(debugPanel.firstChild);
    }

    // Always show in console as well
    if (data) console[level === 'error' ? 'error' : 'log'](`[${level.toUpperCase()}] ${message}`, data); else console.log(`[${level.toUpperCase()}] ${message}`);
  }

  static _safeReplacer() {
    const seen = new WeakSet();
    return function(key, val) {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      // don't stringify large binary blobs
      if (val instanceof ArrayBuffer) return '[ArrayBuffer]';
      return val;
    };
  }

  static debug(msg, d) { this.log('debug', msg, d); }
  static info(msg, d) { this.log('info', msg, d); }
  static warn(msg, d) { this.log('warn', msg, d); }
  static error(msg, d) { this.log('error', msg, d); }
}

// ================== UI MANAGER ==================
class UI {
  static addMessage(nick, text, time, color, id, save = true) {
    if (!id) id = Utils.generateId();
    if (!time) time = Utils.timestamp();
    if (!elements.messages) return;

    // prevent duplicates by id
    if (elements.messages.querySelector(`.msg[data-id="${id}"]`)) return;

    const div = document.createElement('div');
    div.className = 'msg new';
    div.dataset.id = id;

    div.innerHTML = `
      <div class="meta">
        <span class="nickname" style="color:${Utils.escapeHtml(color)}">${Utils.escapeHtml(nick)}</span>
        <span class="time">${Utils.escapeHtml(time)}</span>
      </div>
      <div class="text">${Utils.escapeHtml(text)}</div>
      <div class="reactions"></div>
      <div class="reaction-bar">
        <span class="reactBtn">😊</span>
        <span class="reactBtn">👍</span>
        <span class="reactBtn">❤️</span>
      </div>
    `;

    elements.messages.appendChild(div);
    elements.messages.scrollTop = elements.messages.scrollHeight;

    // Setup reaction buttons
    div.querySelectorAll('.reactBtn').forEach(btn => {
      btn.onclick = () => this.reactToMessage(id, btn.textContent);
    });

    setTimeout(() => div.classList.add('show'), 10);

    if (save && !state.chatHistory.find(m => m.id === id)) {
      state.chatHistory.push({ id, nick, text, time, color, reactions: {}, pending: false });
      StorageManager.saveChatHistory();
    }
  }

  static reactToMessage(id, emoji) {
    const message = state.chatHistory.find(msg => msg.id === id);
    if (!message) return;

    if (!message.reactions) message.reactions = {};
    if (!message.reactions[emoji]) message.reactions[emoji] = [];

    if (!message.reactions[emoji].includes(state.nickname)) {
      message.reactions[emoji].push(state.nickname);
      this.renderReactions(id, message.reactions);
      StorageManager.saveChatHistory();
      // send reaction via client if available
      if (state.client && state.client.say) {
        try {
          // The engine doesn't define a standard reaction API; we send a cmd 'reaction' packet
          state.client.ws && Logger.debug('sendReaction via raw ws (if available)');
          state.client.emit && state.client.emit('debug-send-reaction', { id, emoji, nick: state.nickname });
        } catch (e) { Logger.warn('reaction emit failed', e); }
      }
    }
  }

  static renderReactions(id, reactions) {
    if (!elements.messages) return;
    const reactionsEl = elements.messages.querySelector(`.msg[data-id="${id}"] .reactions`);
    if (!reactionsEl) return;

    reactionsEl.innerHTML = '';
    Object.entries(reactions).forEach(([emoji, users]) => {
      if (users.length > 0) {
        const span = document.createElement('span');
        span.textContent = `${emoji} ${users.length}`;
        span.className = 'reaction';
        span.title = users.join(', ');
        reactionsEl.appendChild(span);
      }
    });
  }

  static updateUserList() {
    if (!elements.userList) return;
    elements.userList.innerHTML = '';

    const sorted = Array.from(state.users.entries()).sort(([,a],[,b]) => {
      if (a.status === 'online' && b.status !== 'online') return -1;
      if (a.status !== 'online' && b.status === 'online') return 1;
      return (a.nick || '').localeCompare(b.nick || '');
    });

    sorted.forEach(([id, user]) => {
      const div = document.createElement('div');
      div.className = `user ${user.status === 'online' ? 'online' : 'offline'}`;
      div.style.color = user.color || '#ccc';
      div.textContent = `${user.nick || id} • ${user.status || 'offline'}`;
      elements.userList.appendChild(div);
    });

    const onlineCount = sorted.filter(([,u]) => u.status === 'online').length;
    document.title = `HackChat (${onlineCount} online)`;
  }

  static addSystemMessage(text) {
    if (!elements.messages) return;
    const div = document.createElement('div');
    div.className = 'system';
    div.textContent = `[${Utils.timestamp()}] ${text}`;
    elements.messages.appendChild(div);
    elements.messages.scrollTop = elements.messages.scrollHeight;
    Logger.info(text);
  }

  static showConnectionGraph() {
    const debugPanel = document.getElementById('debugPanel');
    if (!debugPanel) return;
    const graph = document.createElement('pre');
    let content = `Local ID: ${state.localId || '?'}\n`;
    content += `Room: ${CONFIG.PUBLIC_ROOM}\n`;
    content += `Users (${state.users.size}):\n`;
    Array.from(state.users.keys()).slice(0,50).forEach(u => content += `  • ${u}\n`);
    graph.textContent = content;
    graph.className = 'mt-2 border-t border-gray-700 pt-2 text-gray-400';
    debugPanel.appendChild(graph);
    debugPanel.scrollTop = debugPanel.scrollHeight;
  }
}

// ================== HACKCHAT CLIENT WRAPPER (official Client) ==================
class HackChatConnector {
  static async createClient(nick, channel = CONFIG.PUBLIC_ROOM, pass = null) {
    // Clean up existing
    if (state.client) {
      try { state.client.close && state.client.close(); } catch (e) { /* ignore */ }
      state.client = null;
    }

    Logger.info('Creating hackchat-engine Client', { gateway: CONFIG.HACKCHAT.CLIENT_OPTIONS?.ws?.gateway });

    // instantiate Client with options to override gateway
    const clientOptions = Object.assign({}, CONFIG.HACKCHAT.CLIENT_OPTIONS || {}, { ws: { gateway: CONFIG.HACKCHAT.CLIENT_OPTIONS?.ws?.gateway || CONFIG.HACKCHAT.ENDPOINT } });

    let client;
    try {
      client = new Client(clientOptions);
    } catch (err) {
      Logger.error('Failed to instantiate Client', err);
      throw err;
    }

    state.client = client;

    // Generic catch-all logging for every event from the client
    const known = ['connected','session','channelJoined','message','error','disconnect','close','reconnect','connect'];
    known.forEach(evt => client.on(evt, payload => {
      Logger.debug(`client.event:${evt}`, payload);
      if (CONFIG.DEBUG_VERBOSE) {
        UI.addSystemMessage(`DEBUG: ${evt} ${JSON.stringify(payload)}`);
      }
    }));

    // MESSAGE handling (central for updating UI)
    client.on('message', payload => {
      try { HackChatConnector.onServerMessage(payload); } catch (e) { Logger.error('onServerMessage failed', e); }
    });

    // When session is given, join
    client.on('session', payload => {
      Logger.debug('session payload', payload);
      try {
        // join using provided nick
        client.join(nick, pass || '', channel);
      } catch (e) {
        Logger.warn('client.join failed, will retry after small delay', e);
        setTimeout(() => { try { client.join(nick, pass || '', channel); } catch (err){ Logger.error('rejoin failed', err); } }, 500);
      }
    });

    // When channel is joined, server may provide user list — map to state.users
    client.on('channelJoined', payload => {
      Logger.info('channelJoined', payload);
      try {
        const usersArr = payload?.users || payload?.nicks || [];
        if (Array.isArray(usersArr)) {
          usersArr.forEach(u => {
            const nick = (typeof u === 'string') ? u : (u.nick || u.nickname || u.id);
            state.users.set(nick, { nick, color: (u && u.color) || '#ccc', status: 'online' });
          });
        }
        UI.updateUserList();
        UI.addSystemMessage(`Joined channel ${payload?.channel || channel || CONFIG.PUBLIC_ROOM}`);

        // Request history explicitly after join
        try { client.emit && client.emit('request-history', { channel }); } catch(e) { /* ignore */ }
        try { client.say && client.say(channel, ""); } catch(e) { /* no-op */ }
      } catch (e) { Logger.error('channelJoined handler failed', e); }
    });

    // Attach raw websocket logging if possible (the client exposes ws/socket in many builds)
    const attachRawSocketLogging = () => {
      try {
        const sock = client.ws || client.socket || client._ws || client._socket;
        if (!sock) return false;
        // browser WebSocket API
        if (sock.addEventListener) {
          sock.addEventListener('open', () => Logger.debug('rawsocket: open'));
          sock.addEventListener('message', (ev) => {
            let data = ev.data;
            // try to present readable JSON for debug
            try { const j = JSON.parse(data); Logger.debug('rawsocket: message', j); } catch (e) { Logger.debug('rawsocket: message (raw)', data); }
          });
          sock.addEventListener('close', (ev) => Logger.debug('rawsocket: close', { code: ev.code, reason: ev.reason }));
          sock.addEventListener('error', (ev) => Logger.debug('rawsocket: error', ev));
        } else if (sock.on) {
          // some libs use .on
          sock.on('message', d => { try { Logger.debug('rawsocket: message', JSON.parse(d)); } catch(e) { Logger.debug('rawsocket: message (raw)', d); } });
          sock.on('open', () => Logger.debug('rawsocket: open'));
          sock.on('close', c => Logger.debug('rawsocket: close', c));
          sock.on('error', e => Logger.debug('rawsocket: error', e));
        }
        return true;
      } catch (e) { Logger.warn('attachRawSocketLogging failed', e); return false; }
    };

    // Sometimes the socket is attached after a small delay — poll for it for a short window
    let probes = 0; const probeMax = 40;
    const probe = setInterval(() => {
      probes++; if (attachRawSocketLogging()) { clearInterval(probe); return; }
      if (probes > probeMax) clearInterval(probe);
    }, 150);

    // Build a helper for sending outgoing if client exposes say
    const sendOutgoing = async (text) => {
      if (!client) return;
      try {
        // client.say usually returns nothing; we still attempt
        client.say && client.say(CONFIG.PUBLIC_ROOM, text);
        Logger.debug('outgoing.say', { channel: CONFIG.PUBLIC_ROOM, text });
      } catch (e) { Logger.warn('client.say failed', e); }
    };

    return client;
  }

  // called by client 'message' handler
  static onServerMessage(payload) {
    // payload typically: { channel, nick, message, time, id }
    Logger.debug('server.message', payload);

    const nick = payload.nick || payload.user || payload.from || 'anon';
    const text = payload.message || payload.msg || payload.text || '';
    const time = payload.time || payload.ts || Utils.timestamp();
    const id = payload.id || payload.mid || Utils.generateId();

    // If we have a locally pending message that matches nick+text, replace it
    const pendingIdx = state.chatHistory.findIndex(m => m.pending && m.nick === nick && m.text === text);
    if (pendingIdx !== -1) {
      const pending = state.chatHistory[pendingIdx];
      const tempId = pending.id;
      // update state entry
      pending.id = id;
      pending.time = time;
      pending.pending = false;
      StorageManager.saveChatHistory();

      // Update DOM element data-id and time (if present)
      const el = elements.messages && elements.messages.querySelector(`.msg[data-id="${tempId}"]`);
      if (el) {
        el.dataset.id = id;
        const timeEl = el.querySelector('.meta .time') || el.querySelector('.meta span:nth-child(2)');
        if (timeEl) timeEl.textContent = time;
      }

      // Render reactions if server sent any
      if (payload.reactions) UI.renderReactions(id, payload.reactions);

      Logger.debug('replaced pending message', { tempId, finalId: id });
      return;
    }

    // No pending match — add new message if not duplicate
    if (!state.chatHistory.find(m => m.id === id)) {
      UI.addMessage(nick, text, time, payload.color || '#ccc', id, true);
      if (payload.reactions) UI.renderReactions(id, payload.reactions);
    } else {
      Logger.debug('duplicate message ignored', { id });
    }
  }

  static async sendChat(text) {
    if (!state.client) {
      Logger.warn('No client instance; attempting to create one before sending');
      try { await HackChatConnector.createClient(state.nickname, CONFIG.PUBLIC_ROOM); } catch (e) { Logger.error('createClient failed', e); }
    }

    // create a pending local message so user sees the message immediately
    const tempId = Utils.generateId();
    const time = Utils.timestamp();
    UI.addMessage(state.nickname, text, time, state.nickColor, tempId, true);
    const entry = state.chatHistory.find(m => m.id === tempId);
    if (entry) { entry.pending = true; StorageManager.saveChatHistory(); }

    try {
      if (state.client && state.client.say) {
        state.client.say(CONFIG.PUBLIC_ROOM, text);
        Logger.debug('sent via client.say', { channel: CONFIG.PUBLIC_ROOM, text });
      } else if (state.client && state.client.ws && state.client.ws.send) {
        // fallback raw send packet in engine format
        const pkt = { cmd: 'message', channel: CONFIG.PUBLIC_ROOM, message: text, nick: state.nickname };
        try { state.client.ws.send(JSON.stringify(pkt)); Logger.debug('sent raw ws message', pkt); } catch (e) { Logger.warn('raw send failed', e); }
      } else {
        Logger.warn('No available send method on client');
      }
    } catch (e) {
      Logger.error('sendChat failed', e);
    }
  }

  static async requestHistory() {
    try {
      if (state.client && state.client.emit) {
        // library doesn't document request history method; try known event
        state.client.emit('history', { channel: CONFIG.PUBLIC_ROOM });
        Logger.debug('requested history via emit');
      } else if (state.client && state.client.ws && state.client.ws.send) {
        const pkt = { cmd: 'history', channel: CONFIG.PUBLIC_ROOM };
        state.client.ws.send(JSON.stringify(pkt));
        Logger.debug('requested history via raw WS', pkt);
      }
    } catch (e) { Logger.warn('requestHistory failed', e); }
  }

  static disconnect() {
    try {
      if (state.client) {
        try { state.client.close && state.client.close(); } catch (e) { /* ignore */ }
      }
    } catch (e){ Logger.warn('disconnect error', e); }
    state.client = null; this.connected = false;
  }
}

// ================== MESSAGE HANDLER (preserve reactions behavior) ==================
class MessageHandler {
  static handleReaction(data) {
    const message = state.chatHistory.find(msg => msg.id === data.id);
    if (!message) return;
    if (!message.reactions) message.reactions = {};
    if (!message.reactions[data.emoji]) message.reactions[data.emoji] = [];
    if (!message.reactions[data.emoji].includes(data.user)) {
      message.reactions[data.emoji].push(data.user);
      UI.renderReactions(data.id, message.reactions);
      StorageManager.saveChatHistory();
    }
  }
}

// ================== CHAT MANAGER ==================
class ChatManager {
  static sendMessage() {
    const text = elements.input?.value?.trim();
    if (!text) return;
    if (elements.input) elements.input.value = '';

    // Use client wrapper which creates client as needed
    HackChatConnector.sendChat(text);
  }

  static broadcastJoin() {
    state.users.set(state.localId || state.nickname, { nick: state.nickname || state.localId, color: state.nickColor, status: state.status });
    UI.updateUserList();
    StorageManager.saveKnownPeers();
  }

  static startPeriodicTasks() {
    const resync = setInterval(() => {
      if (state.client) HackChatConnector.requestHistory();
    }, CONFIG.INTERVALS.RESYNC + Math.random() * 3000);
    state.intervals.set('resync', resync);

    const debugInterval = setInterval(() => UI.showConnectionGraph(), CONFIG.INTERVALS.DEBUG_GRAPH);
    state.intervals.set('debug', debugInterval);
  }
}

// ================== APPLICATION CONTROLLER ==================
class App {
  static async initialize() {
    try {
      StorageManager.loadUserSettings();
      StorageManager.loadKnownPeers();
      StorageManager.loadChatHistory();
      Logger.createDebugPanel();
      this.setupEventListeners();
      UI.addSystemMessage('Application initialized. Please log in to join the network.');
      Logger.info('App initialized');
    } catch (e) {
      Logger.error('App initialization failed', e);
      UI.addSystemMessage('Initialization failed. Please refresh.');
    }
  }

  static setupEventListeners() {
    if (elements.loginBtn) elements.loginBtn.onclick = () => this.handleLogin();
    if (elements.nickInput) elements.nickInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.handleLogin(); });
    if (elements.sendBtn) elements.sendBtn.onclick = () => ChatManager.sendMessage();
    if (elements.input) elements.input.addEventListener('keypress', (e) => { if (e.key === 'Enter') ChatManager.sendMessage(); });
    if (elements.settingsBtn) elements.settingsBtn.onclick = () => this.showSettings();
    if (elements.closeSettings) elements.closeSettings.onclick = () => this.hideSettings();
    if (elements.nickInputSettings) elements.nickInputSettings.onchange = (e) => this.updateNickname(e.target.value);
    if (elements.nickColorInput) elements.nickColorInput.oninput = (e) => this.updateNickColor(e.target.value);
    if (elements.statusSelect) elements.statusSelect.onchange = (e) => this.updateStatus(e.target.value);
    if (elements.fontSizeInput) elements.fontSizeInput.oninput = (e) => this.updateFontSize(e.target.value);
    if (elements.themeSelect) elements.themeSelect.onchange = (e) => this.updateTheme(e.target.value);
    if (elements.msgStyleSelect) elements.msgStyleSelect.onchange = (e) => this.updateMessageStyle(e.target.value);
    window.addEventListener('beforeunload', () => this.cleanup());
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
  }

  static async handleLogin() {
    const nick = (elements.nickInput && elements.nickInput.value.trim()) || state.nickname || '';
    if (!nick) { alert('Please enter a nickname'); return; }

    try {
      if (elements.loginBtn) { elements.loginBtn.disabled = true; elements.loginBtn.textContent = 'Connecting...'; }
      state.nickname = nick; StorageManager.saveUserSettings(); if (elements.meName) elements.meName.textContent = state.nickname;
      UI.addSystemMessage(`Joining ${CONFIG.PUBLIC_ROOM} as ${state.nickname}...`);

      // create client & join (client will auto-join in session handler)
      await HackChatConnector.createClient(state.nickname, CONFIG.PUBLIC_ROOM);
      // set localId
      state.localId = state.nickname;
      this.startMeshNetwork();
      if (elements.login) elements.login.style.display = 'none';
      UI.addSystemMessage(`Connected as ${state.localId}`);
    } catch (e) {
      Logger.error('Login failed', e);
      UI.addSystemMessage(`Login failed: ${e?.message || String(e)}`);
      if (elements.login) elements.login.style.display = '';
    } finally {
      if (elements.loginBtn) { elements.loginBtn.disabled = false; elements.loginBtn.textContent = 'Join Network'; }
    }
  }

  static startMeshNetwork() {
    state.users.set(state.localId, { nick: state.nickname || state.localId, color: state.nickColor, status: 'online' });
    UI.updateUserList();
    ChatManager.startPeriodicTasks();
    ChatManager.broadcastJoin();
    Logger.info('Client network started');
  }

  static showSettings() { if (elements.nickInputSettings) elements.nickInputSettings.value = state.nickname; if (elements.settingsModal) elements.settingsModal.classList.remove('hidden'); }
  static hideSettings() { if (elements.settingsModal) elements.settingsModal.classList.add('hidden'); }
  static updateNickname(v) { const newNick = v.trim(); if (newNick && newNick !== state.nickname) { state.nickname = newNick; StorageManager.saveUserSettings(); if (elements.meName) elements.meName.textContent = state.nickname; if (state.client) { try { state.client.close && state.client.close(); } catch(e){} HackChatConnector.createClient(state.nickname, CONFIG.PUBLIC_ROOM).catch(e=>Logger.warn('rejoin failed', e)); } } }
  static updateNickColor(v) { state.nickColor = v; StorageManager.saveUserSettings(); }
  static updateStatus(v) { state.status = v; StorageManager.saveUserSettings(); if (elements.meStatus) elements.meStatus.textContent = `(${state.status})`; }
  static updateFontSize(v) { if (elements.messages) elements.messages.style.fontSize = v + 'px'; StorageManager.save('fontSize', v); }
  static updateTheme(v) { document.body.dataset.theme = v; StorageManager.save('theme', v); }
  static updateMessageStyle(v) { document.body.dataset.msgstyle = v; StorageManager.save('msgStyle', v); }
  static handleOnline() { UI.addSystemMessage('Connection restored'); if (!state.client) HackChatConnector.createClient(state.nickname, CONFIG.PUBLIC_ROOM).catch(e=>Logger.warn('reconnect failed', e)); }
  static handleOffline() { UI.addSystemMessage('Connection lost'); }
  static cleanup() { Logger.info('App cleanup started'); try { HackChatConnector.disconnect(); } catch(e){} state.reset(); }
}

// ================== ERROR HANDLING ==================
window.addEventListener('error', event => { Logger.error('Global error', { message: event.error?.message, stack: event.error?.stack, filename: event.filename, lineno: event.lineno }); });
window.addEventListener('unhandledrejection', event => { Logger.error('Unhandled promise rejection', event.reason); event.preventDefault(); });

// ================== INITIALIZATION ==================
document.addEventListener('DOMContentLoaded', () => {
  const theme = StorageManager.load('theme','dark');
  const msgStyle = StorageManager.load('msgStyle','modern');
  const fontSize = StorageManager.load('fontSize','14');
  document.body.dataset.theme = theme;
  document.body.dataset.msgstyle = msgStyle;
  if (elements.messages) elements.messages.style.fontSize = fontSize + 'px';
  if (elements.themeSelect) elements.themeSelect.value = theme;
  if (elements.msgStyleSelect) elements.msgStyleSelect.value = msgStyle;
  if (elements.fontSizeInput) elements.fontSizeInput.value = fontSize;
  if (elements.roomLabel) elements.roomLabel.textContent = CONFIG.PUBLIC_ROOM;
  App.initialize().catch(e => { console.error('Failed to initialize app:', e); document.body.innerHTML = `<div style="text-align:center;padding:50px;color:red;"><h2>Application Failed to Load</h2><p>Please refresh the page and try again.</p><p>Error: ${e?.message}</p></div>`; });
});

// ================== PUBLIC API ==================
window.HackChatApp = {
  state: () => ({ localId: state.localId, users: Object.fromEntries(state.users), knownPeers: Array.from(state.knownPeers), chatHistory: state.chatHistory.length }),
  reconnect: () => { if (state.nickname) HackChatConnector.createClient(state.nickname, CONFIG.PUBLIC_ROOM).catch(e=>Logger.warn('reconnect failed', e)); },
  clearHistory: () => { state.chatHistory = []; StorageManager.saveChatHistory(); if (elements.messages) elements.messages.innerHTML = ''; UI.addSystemMessage('Chat history cleared'); },
  exportData: () => ({ nickname: state.nickname, knownPeers: Array.from(state.knownPeers), chatHistory: state.chatHistory }),
  importData: (data) => { if (data.knownPeers) data.knownPeers.forEach(p => state.knownPeers.add(p)); StorageManager.saveKnownPeers(); if (data.chatHistory) data.chatHistory.forEach(msg => { if (!state.chatHistory.find(m => m.id === msg.id)) UI.addMessage(msg.nick, msg.text, msg.time, msg.color, msg.id); }); UI.addSystemMessage('Data imported successfully'); }
};

// End of file
