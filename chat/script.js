// ================== script.js (hack.chat engine / WebSocket replacement) ==================
// Replaces P2P PeerJS networking with a hackchat-engine-compatible WebSocket connector.
// Keeps UI, reactions, storage, and DOM wiring identical to your original file.
// Based on hackchat-engine conventions (cmd: 'join', 'message', 'history', etc.). See repo README.
// Source/info: hackchat-engine README (default gateway wss://hack.chat/chat-ws). :contentReference[oaicite:1]{index=1}

/* eslint-disable no-console */

// ================== CONFIGURATION ==================
const CONFIG = {
  PUBLIC_ROOM: "public",
  HACKCHAT: {
    // Set this to your hackchat-engine server WebSocket endpoint.
    // Default commonly used by the engine is: wss://hack.chat/chat-ws
    ENDPOINT: "wss://hack.chat/chat-ws",
    // Channel query param is not used by engine; channel is sent as 'channel' in cmd payloads
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
  }
};

// ================== STATE MANAGEMENT ==================
class ChatState {
  constructor() {
    this.nickname = "";
    this.nickColor = "#ffffff";
    this.status = "online";
    this.localId = null;               // in hack.chat, we'll use nickname as localId (or generate one)
    this.peers = new Map();            // retained for UI compatibility (not P2P)
    this.users = new Map();            // presence map (nick -> {nick,color,status})
    this.knownPeers = new Set();       // used as a local store of seen nicks (optional)
    this.chatHistory = [];
    this.intervals = new Map();
    this.reconnectAttempts = new Map();
  }

  reset() {
    this.clearIntervals();
    this.peers.clear();
    this.users.clear();
    this.knownPeers.clear();
    this.chatHistory = [];
    this.intervals.clear();
    this.reconnectAttempts.clear();
    // No peer.destroy() here (we use WebSocket via HackChatConnector.disconnect)
  }

  clearIntervals() {
    this.intervals.forEach(interval => clearInterval(interval));
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

// ================== UTILITY FUNCTIONS ==================
const Utils = {
  timestamp: () => new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
  
  escapeHtml: (str = '') => String(str).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]),
  
  generateId: () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
  
  randomDelay: (base, variance) => base + Math.random() * variance,
  
  debounce: (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func.apply(this, args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  throttle: (func, limit) => {
    let inThrottle;
    return function executedFunction(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }
};

// ================== STORAGE MANAGER ==================
class StorageManager {
  static save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      Logger.error('Storage save failed', { key, error: e.message });
    }
  }

  static load(key, defaultValue = null) {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch (e) {
      Logger.error('Storage load failed', { key, error: e.message });
      return defaultValue;
    }
  }

  static saveUserSettings() {
    this.save("nickname", state.nickname);
    this.save("nickColor", state.nickColor);
    this.save("status", state.status);
    this.save("theme", document.body.dataset.theme || "dark");
    this.save("msgStyle", document.body.dataset.msgstyle || "modern");
    this.save("fontSize", elements.messages.style.fontSize || "14");
  }

  static loadUserSettings() {
    state.nickname = this.load("nickname", "") || "";
    state.nickColor = this.load("nickColor", "#ffffff") || "#ffffff";
    state.status = this.load("status", "online") || "online";
    
    // Apply to UI
    if (elements.meName) elements.meName.textContent = state.nickname || "Guest";
    if (elements.meStatus) elements.meStatus.textContent = `(${state.status})`;
    if (elements.nickColorInput) elements.nickColorInput.value = state.nickColor;
    if (elements.statusSelect) elements.statusSelect.value = state.status;
  }

  static saveChatHistory() {
    this.save("chatHistory", state.chatHistory);
  }

  static loadChatHistory() {
    const history = this.load("chatHistory", []);
    history.forEach(msg => UI.addMessage(msg.nick, msg.text, msg.time, msg.color, msg.id, false));
    state.chatHistory = history;
    history.forEach(msg => UI.renderReactions(msg.id, msg.reactions || {}));
  }

  static saveKnownPeers() {
    this.save("knownPeers", Array.from(state.knownPeers));
  }

  static loadKnownPeers() {
    const peers = this.load("knownPeers", []);
    peers.forEach(peer => state.knownPeers.add(peer));
  }
}

// ================== LOGGING SYSTEM ==================
class Logger {
  static createDebugPanel() {
    const debugPanel = document.createElement("div");
    debugPanel.id = "debugPanel";
    debugPanel.className = "hidden p-2 border-t mt-2 text-xs font-mono bg-black text-green-400 max-h-64 overflow-y-auto";
    if (elements.settingsModal) elements.settingsModal.appendChild(debugPanel);
    return debugPanel;
  }

  static log(level, message, data = null) {
    const debugPanel = document.getElementById('debugPanel');
    if (debugPanel) {
      const line = document.createElement("div");
      line.textContent = `[${Utils.timestamp()}] [${level.toUpperCase()}] ${message}`;
      if (data) {
        try { line.textContent += ` ${JSON.stringify(data)}`; } catch (e) { /* ignore */ }
      }
      debugPanel.appendChild(line);
      debugPanel.scrollTop = debugPanel.scrollHeight;
      
      // Keep only last 100 log entries
      while (debugPanel.children.length > 100) {
        debugPanel.removeChild(debugPanel.firstChild);
      }
    }
    
    console[level === 'error' ? 'error' : 'log'](`[${level.toUpperCase()}]`, message, data || '');
  }

  static debug(message, data) { this.log('debug', message, data); }
  static info(message, data) { this.log('info', message, data); }
  static warn(message, data) { this.log('warn', message, data); }
  static error(message, data) { this.log('error', message, data); }
}

// ================== UI MANAGER (unchanged behaviour) ==================
class UI {
  static addMessage(nick, text, time, color, id, save = true) {
    if (!id) id = Utils.generateId();
    if (!time) time = Utils.timestamp();
    if (elements.messages.querySelector(`.msg[data-id="${id}"]`)) return;

    const div = document.createElement('div');
    div.className = 'msg new';
    div.dataset.id = id;
    
    div.innerHTML = `
      <div class="meta">
        <span class="nickname" style="color:${Utils.escapeHtml(color)}">${Utils.escapeHtml(nick)}</span>
        <span>${Utils.escapeHtml(time)}</span>
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

    if (save && !state.chatHistory.find(msg => msg.id === id)) {
      state.chatHistory.push({ id, nick, text, time, color, reactions: {} });
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
      // Send reaction via connector
      HackChatConnector.sendReaction(id, emoji);
    }
  }

  static renderReactions(id, reactions) {
    const reactionsEl = elements.messages.querySelector(`.msg[data-id="${id}"] .reactions`);
    if (!reactionsEl) return;

    reactionsEl.innerHTML = "";
    Object.entries(reactions).forEach(([emoji, users]) => {
      if (users.length > 0) {
        const span = document.createElement("span");
        span.textContent = `${emoji} ${users.length}`;
        span.className = "reaction";
        span.title = users.join(', ');
        reactionsEl.appendChild(span);
      }
    });
  }

  static updateUserList() {
    if (!elements.userList) return;
    elements.userList.innerHTML = "";
    
    // Sort users: online first, then by name
    const sortedUsers = Array.from(state.users.entries()).sort(([, a], [, b]) => {
      if (a.status === 'online' && b.status !== 'online') return -1;
      if (a.status !== 'online' && b.status === 'online') return 1;
      return (a.nick || '').localeCompare(b.nick || '');
    });

    sortedUsers.forEach(([id, user]) => {
      const div = document.createElement('div');
      div.className = `user ${user.status === 'online' ? 'online' : 'offline'}`;
      div.style.color = user.color || "#ccc";
      div.textContent = `${user.nick || id} • ${user.status || "offline"}`;
      elements.userList.appendChild(div);
    });

    // Update connection count
    const onlineCount = sortedUsers.filter(([, user]) => user.status === 'online').length;
    document.title = `HackChat (${onlineCount} online)`;
  }

  static addSystemMessage(text) {
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
    let content = `Local ID: ${state.localId || "?"}\n`;
    content += `Room: ${CONFIG.PUBLIC_ROOM}\n`;
    content += `Known Users (${state.users.size}):\n`;
    Array.from(state.users.keys()).slice(0, 50).forEach(u => {
      content += `  • ${u}\n`;
    });

    graph.textContent = content;
    graph.className = "mt-2 border-t border-gray-700 pt-2 text-gray-400";
    debugPanel.appendChild(graph);
    debugPanel.scrollTop = debugPanel.scrollHeight;
  }
}

// ================== HACKCHAT CONNECTOR (uses hackchat-engine style cmd messages) ==================
class HackChatConnector {
  static ws = null;
  static connected = false;
  static reconnectTimer = null;
  static heartbeatTimer = null;
  static queue = [];
  static reconnectAttempts = 0;
  static MAX_RECONNECT = 10;

  // Connect to the hackchat server and join the channel
  static async connect({ nick, channel = CONFIG.PUBLIC_ROOM, pass = null }) {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(CONFIG.HACKCHAT.ENDPOINT);
        Logger.info(`Connecting to hackchat server: ${url.toString()}`);

        this.ws = new WebSocket(url.toString());
        this.ws.onopen = () => {
          Logger.info('WebSocket open to hackchat server');
          this.connected = true;
          this.reconnectAttempts = 0;

          // send join command per hackchat-engine style
          const joinCmd = {
            cmd: 'join',
            channel: channel,
            nick: nick
          };
          if (pass) joinCmd.pass = pass;

          try { this.ws.send(JSON.stringify(joinCmd)); } catch (e) { Logger.warn('Join send failed', e); }

          // flush any queued outgoing messages
          this.flushQueue();

          // start heartbeat
          this.startHeartbeat();

          // update local state id
          state.localId = nick || Utils.generateId();
          resolve();
        };

        this.ws.onmessage = (ev) => {
          this.onRawMessage(ev.data);
        };

        this.ws.onclose = (ev) => {
          Logger.warn('WebSocket closed', { code: ev.code, reason: ev.reason });
          this.connected = false;
          this.stopHeartbeat();
          UI.addSystemMessage('Disconnected from server');
          this.scheduleReconnect();
        };

        this.ws.onerror = (err) => {
          Logger.error('WebSocket error', err);
        };

        // handshake timeout
        const TO = setTimeout(() => {
          if (!this.connected) {
            reject(new Error('WebSocket connection timeout'));
            try { this.ws.close(); } catch(e) { /* ignore */ }
          }
        }, Math.max(5000, CONFIG.TIMEOUTS.HANDSHAKE));
      } catch (error) {
        reject(error);
      }
    });
  }

  static startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.connected && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ cmd: 'ping', ts: Date.now() })); } catch (e) { /* ignore */ }
      }
    }, 25000);
  }

  static stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  static scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.MAX_RECONNECT) {
      Logger.warn('Max reconnect attempts reached, not reconnecting automatically.');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    Logger.info(`Scheduling reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (state.nickname) {
        try {
          await this.connect({ nick: state.nickname, channel: CONFIG.PUBLIC_ROOM });
          UI.addSystemMessage('Reconnected to hackchat server');
        } catch (e) {
          Logger.warn('Reconnect attempt failed', e);
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  static enqueueOutgoing(obj) {
    this.queue.push(obj);
    if (this.connected) this.flushQueue();
  }

  static flushQueue() {
    while (this.queue.length && this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const obj = this.queue.shift();
      try {
        this.ws.send(JSON.stringify(obj));
      } catch (e) {
        Logger.warn('Failed to send queued message, requeueing', e);
        this.queue.unshift(obj);
        break;
      }
    }
  }

  // decode incoming messages and adapt to UI/message handling
  static onRawMessage(raw) {
    let msgText = raw;
    if (raw instanceof ArrayBuffer) {
      try { msgText = new TextDecoder().decode(new Uint8Array(raw)); } catch (e) { Logger.warn('Decode failed', e); return; }
    }

    let data;
    try {
      data = JSON.parse(msgText);
    } catch (e) {
      // Non-JSON — display as system line
      UI.addSystemMessage(String(msgText));
      return;
    }

    // The hackchat-engine uses `cmd` for command name
    const cmd = data.cmd;

    switch (cmd) {
      case 'message':
      case 'msg':
      case 'say': {
        // typical server event: { cmd: 'message', channel, nick, message, time, id }
        const nick = data.nick || data.from || data.user || 'anon';
        const text = data.message || data.msg || data.text || '';
        const time = data.time || Utils.timestamp();
        const id = data.id || Utils.generateId();
        if (!state.chatHistory.find(m => m.id === id)) {
          UI.addMessage(nick, text, time, data.color || '#ccc', id);
        }
        break;
      }

      case 'history': {
        // expected: { cmd: 'history', msgs: [...] } or { cmd:'history', history: [...] }
        const arr = data.msgs || data.history || [];
        if (Array.isArray(arr)) {
          arr.forEach(msg => {
            const nick = msg.nick || msg.user || msg.author || 'anon';
            const text = msg.message || msg.msg || msg.text || '';
            const time = msg.time || Utils.timestamp();
            const id = msg.id || Utils.generateId();
            if (!state.chatHistory.find(m => m.id === id)) {
              UI.addMessage(nick, text, time, msg.color || '#ccc', id);
              if (msg.reactions) UI.renderReactions(id, msg.reactions);
            }
          });
        }
        break;
      }

      case 'session': {
        // hackchat-engine may send session info after connecting
        // store if server provides any session ID
        if (data.sid) {
          state.localId = data.sid;
        }
        break;
      }

      case 'channelJoined': {
        // server confirms join, may send user list
        if (Array.isArray(data.users)) {
          data.users.forEach(u => {
            const nick = (typeof u === 'string') ? u : (u.nick || u.nickname || u.id);
            state.users.set(nick, {
              nick,
              color: (u && u.color) || '#ccc',
              status: 'online'
            });
          });
        }
        UI.addSystemMessage(`Joined channel: ${data.channel || CONFIG.PUBLIC_ROOM}`);
        UI.updateUserList();
        // ask for history explicitly if server doesn't send it
        this.requestHistory();
        break;
      }

      case 'join': {
        const nick = data.nick || data.user;
        if (nick) {
          state.users.set(nick, { nick, color: data.color || '#ccc', status: 'online' });
          UI.addSystemMessage(`${nick} joined`);
          UI.updateUserList();
        }
        break;
      }

      case 'part':
      case 'leave': {
        const nick = data.nick || data.user;
        if (nick && state.users.has(nick)) {
          const u = state.users.get(nick);
          u.status = 'offline';
          state.users.set(nick, u);
          UI.addSystemMessage(`${nick} left`);
          UI.updateUserList();
        }
        break;
      }

      case 'reaction': {
        // adapt server reaction to local model
        try {
          MessageHandler.handleReaction({
            id: data.id,
            emoji: data.emoji,
            user: data.nick || data.user
          });
        } catch (e) {
          Logger.warn('Reaction handling failed', e);
        }
        break;
      }

      case 'ping': {
        // reply with pong (if server expects)
        try { this.ws.send(JSON.stringify({ cmd: 'pong' })); } catch (e) { /* ignore */ }
        break;
      }

      case 'sys':
      case 'system':
      default: {
        // Unknown / misc system messages
        if (data.message || data.msg) {
          UI.addSystemMessage(data.message || data.msg);
        } else {
          Logger.debug('Unhandled server message', data);
        }
        break;
      }
    }
  }

  // send a chat message to the server
  static sendChat(text) {
    const payload = {
      cmd: 'message',           // 'message' is a safe general cmd; server may accept 'msg' too
      channel: CONFIG.PUBLIC_ROOM,
      message: text,
      nick: state.nickname,
      time: Utils.timestamp(),
      id: Utils.generateId()
    };

    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        Logger.warn('Failed to send chat, enqueueing', e);
        this.enqueueOutgoing(payload);
      }
    } else {
      this.enqueueOutgoing(payload);
    }

    // locals: add immediately to UI to preserve original behavior
    UI.addMessage(state.nickname, text, payload.time, state.nickColor, payload.id);
  }

  static sendReaction(id, emoji) {
    const payload = {
      cmd: 'reaction',
      channel: CONFIG.PUBLIC_ROOM,
      id,
      emoji,
      nick: state.nickname
    };
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        Logger.warn('Failed to send reaction, enqueueing', e);
        this.enqueueOutgoing(payload);
      }
    } else {
      this.enqueueOutgoing(payload);
    }
  }

  static requestHistory() {
    const payload = { cmd: 'history', channel: CONFIG.PUBLIC_ROOM };
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(payload)); } catch (e) { Logger.warn('History request failed', e); }
    } else {
      this.enqueueOutgoing(payload);
    }
  }

  static disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
    this.ws = null;
    this.connected = false;
  }
}

// ================== MESSAGE HANDLER (reaction handler preserved) ==================
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

// ================== CHAT MANAGER (uses HackChatConnector) ==================
class ChatManager {
  static sendMessage() {
    const text = elements.input.value.trim();
    if (!text) return;

    elements.input.value = '';
    if (HackChatConnector) {
      HackChatConnector.sendChat(text);
    } else {
      // fallback to local UI only
      const id = Utils.generateId();
      const time = Utils.timestamp();
      UI.addMessage(state.nickname, text, time, state.nickColor, id);
      state.chatHistory.push({ id, nick: state.nickname, text, time, color: state.nickColor, reactions: {} });
      StorageManager.saveChatHistory();
    }
  }

  static broadcastJoin() {
    // hack.chat server receives the join via HackChatConnector.connect()'s initial join cmd.
    // Still update local users map and persist known peers.
    state.users.set(state.localId || state.nickname, {
      nick: state.nickname || state.localId,
      color: state.nickColor,
      status: state.status
    });
    UI.updateUserList();
    StorageManager.saveKnownPeers();
  }

  static startPeriodicTasks() {
    // Periodic history/resync requests
    const resyncInterval = setInterval(() => {
      if (HackChatConnector && HackChatConnector.connected) {
        HackChatConnector.requestHistory();
      }
    }, CONFIG.INTERVALS.RESYNC + Math.random() * 3000);
    state.intervals.set('resync', resyncInterval);

    // Debug graph updates
    const debugInterval = setInterval(() => {
      UI.showConnectionGraph();
    }, CONFIG.INTERVALS.DEBUG_GRAPH);
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
      
      UI.addSystemMessage("Application initialized. Please log in to join the network.");
      Logger.info("App initialized successfully");
    } catch (error) {
      Logger.error("App initialization failed", error);
      UI.addSystemMessage("Initialization failed. Please refresh the page.");
    }
  }

  static setupEventListeners() {
    // Login
    if (elements.loginBtn) elements.loginBtn.onclick = () => this.handleLogin();
    if (elements.nickInput) elements.nickInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.handleLogin();
    });

    // Chat
    if (elements.sendBtn) elements.sendBtn.onclick = () => ChatManager.sendMessage();
    if (elements.input) elements.input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') ChatManager.sendMessage();
    });

    // Settings
    if (elements.settingsBtn) elements.settingsBtn.onclick = () => this.showSettings();
    if (elements.closeSettings) elements.closeSettings.onclick = () => this.hideSettings();
    
    if (elements.nickInputSettings) elements.nickInputSettings.onchange = (e) => this.updateNickname(e.target.value);
    if (elements.nickColorInput) elements.nickColorInput.oninput = (e) => this.updateNickColor(e.target.value);
    if (elements.statusSelect) elements.statusSelect.onchange = (e) => this.updateStatus(e.target.value);
    if (elements.fontSizeInput) elements.fontSizeInput.oninput = (e) => this.updateFontSize(e.target.value);
    if (elements.themeSelect) elements.themeSelect.onchange = (e) => this.updateTheme(e.target.value);
    if (elements.msgStyleSelect) elements.msgStyleSelect.onchange = (e) => this.updateMessageStyle(e.target.value);

    // Window events
    window.addEventListener('beforeunload', () => this.cleanup());
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
  }

  static async handleLogin() {
    const nick = (elements.nickInput && elements.nickInput.value.trim()) || state.nickname || '';
    if (!nick) {
      alert("Please enter a nickname");
      return;
    }

    try {
      if (elements.loginBtn) {
        elements.loginBtn.disabled = true;
        elements.loginBtn.textContent = "Connecting...";
      }

      state.nickname = nick;
      StorageManager.saveUserSettings();
      if (elements.meName) elements.meName.textContent = state.nickname;

      UI.addSystemMessage(`Joining ${CONFIG.PUBLIC_ROOM} as ${state.nickname}...`);

      // Connect to hack.chat server
      await HackChatConnector.connect({ nick: state.nickname, channel: CONFIG.PUBLIC_ROOM });

      // Set local ID (use nick by default)
      state.localId = state.nickname || Utils.generateId();

      // Start periodic tasks & broadcast join locally
      this.startMeshNetwork();

      if (elements.login) elements.login.style.display = 'none';
      UI.addSystemMessage(`Connected as ${state.localId}`);

    } catch (error) {
      Logger.error("Login failed", error);
      UI.addSystemMessage(`Login failed: ${error.message || String(error)}`);
      if (elements.login) elements.login.style.display = '';
    } finally {
      if (elements.loginBtn) {
        elements.loginBtn.disabled = false;
        elements.loginBtn.textContent = "Join Network";
      }
    }
  }

  static startMeshNetwork() {
    // Add self to users
    state.users.set(state.localId, {
      nick: state.nickname || state.localId,
      color: state.nickColor,
      status: 'online'
    });
    UI.updateUserList();

    // Start periodic tasks (history resync, debug)
    ChatManager.startPeriodicTasks();

    // Broadcast join (local update)
    ChatManager.broadcastJoin();

    Logger.info("Connected client network started");
  }

  static showSettings() {
    if (elements.nickInputSettings) elements.nickInputSettings.value = state.nickname;
    if (elements.settingsModal) elements.settingsModal.classList.remove("hidden");
  }

  static hideSettings() {
    if (elements.settingsModal) elements.settingsModal.classList.add("hidden");
  }

  static updateNickname(value) {
    const newNick = value.trim();
    if (newNick && newNick !== state.nickname) {
      state.nickname = newNick;
      StorageManager.saveUserSettings();
      if (elements.meName) elements.meName.textContent = state.nickname;
      // Re-join server under new nick if connected
      if (HackChatConnector && HackChatConnector.connected) {
        // quick strategy: disconnect and reconnect with new nick
        HackChatConnector.disconnect();
        HackChatConnector.connect({ nick: state.nickname, channel: CONFIG.PUBLIC_ROOM }).catch(e => {
          Logger.warn('Rejoin with new nick failed', e);
        });
      }
    }
  }

  static updateNickColor(value) {
    state.nickColor = value;
    StorageManager.saveUserSettings();
  }

  static updateStatus(value) {
    state.status = value;
    StorageManager.saveUserSettings();
    if (elements.meStatus) elements.meStatus.textContent = `(${state.status})`;
  }

  static updateFontSize(value) {
    if (elements.messages) elements.messages.style.fontSize = value + "px";
    StorageManager.save("fontSize", value);
  }

  static updateTheme(value) {
    document.body.dataset.theme = value;
    StorageManager.save("theme", value);
  }

  static updateMessageStyle(value) {
    document.body.dataset.msgstyle = value;
    StorageManager.save("msgStyle", value);
  }

  static handleOnline() {
    UI.addSystemMessage("Connection restored");
    if (HackChatConnector && !HackChatConnector.connected && state.nickname) {
      HackChatConnector.connect({ nick: state.nickname, channel: CONFIG.PUBLIC_ROOM }).catch(e => Logger.warn('Reconnect failed', e));
    }
  }

  static handleOffline() {
    UI.addSystemMessage("Connection lost");
  }

  static cleanup() {
    Logger.info("App cleanup started");
    try {
      HackChatConnector.disconnect();
    } catch (e) { /* ignore */ }
    state.reset();
  }
}

// ================== ERROR HANDLING ==================
window.addEventListener('error', (event) => {
  Logger.error('Global error', {
    message: event.error?.message,
    stack: event.error?.stack,
    filename: event.filename,
    lineno: event.lineno
  });
});

window.addEventListener('unhandledrejection', (event) => {
  Logger.error('Unhandled promise rejection', event.reason);
  event.preventDefault();
});

// ================== INITIALIZATION ==================
document.addEventListener('DOMContentLoaded', () => {
  // Apply stored theme and settings
  const theme = StorageManager.load("theme", "dark");
  const msgStyle = StorageManager.load("msgStyle", "modern");
  const fontSize = StorageManager.load("fontSize", "14");

  document.body.dataset.theme = theme;
  document.body.dataset.msgstyle = msgStyle;
  if (elements.messages) elements.messages.style.fontSize = fontSize + "px";
  
  if (elements.themeSelect) elements.themeSelect.value = theme;
  if (elements.msgStyleSelect) elements.msgStyleSelect.value = msgStyle;
  if (elements.fontSizeInput) elements.fontSizeInput.value = fontSize;

  // Set room info
  if (elements.roomLabel) elements.roomLabel.textContent = CONFIG.PUBLIC_ROOM;

  // Initialize the application
  App.initialize().catch(error => {
    console.error("Failed to initialize app:", error);
    document.body.innerHTML = `
      <div style="text-align: center; padding: 50px; color: red;">
        <h2>Application Failed to Load</h2>
        <p>Please refresh the page and try again.</p>
        <p>Error: ${error.message}</p>
      </div>
    `;
  });
});

// ================== PUBLIC API ==================
window.HackChatApp = {
  state: () => ({
    localId: state.localId,
    users: Object.fromEntries(state.users),
    knownPeers: Array.from(state.knownPeers),
    chatHistory: state.chatHistory.length
  }),
  reconnect: () => {
    if (state.nickname) HackChatConnector.connect({ nick: state.nickname, channel: CONFIG.PUBLIC_ROOM }).catch(e => Logger.warn('Reconnect failed', e));
  },
  clearHistory: () => {
    state.chatHistory = [];
    StorageManager.saveChatHistory();
    if (elements.messages) elements.messages.innerHTML = '';
    UI.addSystemMessage("Chat history cleared");
  },
  exportData: () => ({
    nickname: state.nickname,
    knownPeers: Array.from(state.knownPeers),
    chatHistory: state.chatHistory
  }),
  importData: (data) => {
    if (data.knownPeers) {
      data.knownPeers.forEach(peer => state.knownPeers.add(peer));
      StorageManager.saveKnownPeers();
    }
    if (data.chatHistory) {
      data.chatHistory.forEach(msg => {
        if (!state.chatHistory.find(m => m.id === msg.id)) {
          UI.addMessage(msg.nick, msg.text, msg.time, msg.color, msg.id);
        }
      });
    }
    UI.addSystemMessage("Data imported successfully");
  }
};
