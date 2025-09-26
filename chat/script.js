// Optimized P2P Chat Application
// Clean, efficient, and robust peer-to-peer chat using PeerJS

/* eslint-disable no-console */

// ================== CONFIGURATION ==================
const CONFIG = {
  PUBLIC_ROOM: "public",
  PEERJS: {
    HOST: '0.peerjs.com',
    PORT: 443,
    PATH: '/',
  },
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ],
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
    this.peer = null;
    this.localId = null;
    this.peers = new Map();
    this.users = new Map();
    this.knownPeers = new Set();
    this.chatHistory = [];
    this.connectQueue = [];
    this.connecting = false;
    this.bootstrapId = null;
    this.intervals = new Map();
    this.reconnectAttempts = new Map();
  }

  reset() {
    this.clearIntervals();
    this.peers.clear();
    this.users.clear();
    this.connectQueue = [];
    this.connecting = false;
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
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
  }

  static loadUserSettings() {
    state.nickname = this.load("nickname", "");
    state.nickColor = this.load("nickColor", "#ffffff");
    state.status = this.load("status", "online");
    
    // Apply to UI
    document.getElementById("meName").textContent = state.nickname || "Guest";
    document.getElementById("meStatus").textContent = `(${state.status})`;
    elements.nickColorInput.value = state.nickColor;
    elements.statusSelect.value = state.status;
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
    elements.settingsModal.appendChild(debugPanel);
    return debugPanel;
  }

  static log(level, message, data = null) {
    const debugPanel = document.getElementById('debugPanel');
    if (debugPanel) {
      const line = document.createElement("div");
      line.textContent = `[${Utils.timestamp()}] [${level.toUpperCase()}] ${message}`;
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

// ================== ID MANAGEMENT ==================
class IdManager {
  static chooseSequentialId(existingIds) {
    const used = new Set();
    existingIds.forEach(id => {
      const match = String(id).match(/^gamegramuser(\d+)$/i);
      if (match) used.add(Number(match[1]));
    });
    
    let n = 1;
    while (used.has(n)) n++;
    return `gamegramuser${n}`;
  }

  static generateTempId() {
    return `tmp-${Math.random().toString(36).slice(2, 9)}`;
  }
}

// ================== PEER MANAGEMENT ==================
class PeerManager {
  static async createPeer(peerId, temporary = false) {
    return new Promise((resolve, reject) => {
      const options = {
        host: CONFIG.PEERJS.HOST,
        port: CONFIG.PEERJS.PORT,
        path: CONFIG.PEERJS.PATH,
        secure: true,
        config: { iceServers: CONFIG.ICE_SERVERS }
      };

      const peer = new Peer(peerId, options);
      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          try { peer.destroy(); } catch (e) { /* ignore */ }
        }
      };

      peer.on('open', (id) => {
        if (!resolved) {
          resolved = true;
          Logger.debug(`Peer opened: ${id} (temp: ${temporary})`);
          resolve({ peer, id });
        }
      });

      peer.on('error', (err) => {
        Logger.error(`Peer error: ${peerId}`, err);
        cleanup();
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      // Timeout for peer creation
      setTimeout(() => {
        if (!resolved) {
          Logger.warn(`Peer creation timeout: ${peerId}`);
          cleanup();
          reject(new Error('Peer creation timeout'));
        }
      }, 5000);
    });
  }

  static async performHandshake() {
    const tempId = IdManager.generateTempId();
    Logger.info(`Starting handshake with temp ID: ${tempId}`);

    try {
      const { peer: tmpPeer } = await this.createPeer(tempId, true);
      const discoveredPeers = await this.discoverPeers(tmpPeer);
      tmpPeer.destroy();

      const candidateId = IdManager.chooseSequentialId(discoveredPeers);
      const { peer: mainPeer, id: finalId } = await this.claimId(candidateId);
      
      return { peer: mainPeer, id: finalId };
    } catch (error) {
      Logger.error('Handshake failed', error);
      throw error;
    }
  }

  static async discoverPeers(tmpPeer) {
    const discovered = new Set(Array.from(state.knownPeers));
    
    return new Promise((resolve) => {
      // Add likely bootstrap peers
      for (let i = 1; i <= 6; i++) {
        discovered.add(`gamegramuser${i}`);
      }

      const connections = [];
      
      tmpPeer.on('connection', (conn) => {
        connections.push(conn);
        this.setupTempConnection(conn, discovered);
      });

      // Try to connect to known peers
      const peersToTry = Array.from(state.knownPeers).slice(0, 8);
      peersToTry.forEach(peerId => {
        if (peerId && peerId !== tmpPeer.id) {
          try {
            const conn = tmpPeer.connect(peerId, { reliable: true });
            connections.push(conn);
            this.setupTempConnection(conn, discovered);
          } catch (e) {
            Logger.warn(`Failed to connect to ${peerId}`, e);
          }
        }
      });

      // Wait for discovery period
      setTimeout(() => {
        connections.forEach(conn => {
          try { conn.close(); } catch (e) { /* ignore */ }
        });
        discovered.delete(tmpPeer.id);
        resolve(discovered);
      }, CONFIG.TIMEOUTS.HANDSHAKE);
    });
  }

  static setupTempConnection(conn, discovered) {
    conn.on('open', () => {
      conn.send({ type: 'request-peerlist' });
    });

    conn.on('data', (data) => {
      if (data?.type === 'peerlist' && Array.isArray(data.peers)) {
        data.peers.forEach(peer => discovered.add(peer));
      }
    });

    conn.on('error', () => { /* ignore temp connection errors */ });
  }

  static async claimId(candidateId, attempt = 0) {
    if (attempt > 10) {
      throw new Error('Too many ID claim attempts');
    }

    try {
      Logger.debug(`Attempting to claim ID: ${candidateId}`);
      return await this.createPeer(candidateId, false);
    } catch (error) {
      // If ID is taken, try next sequential number
      const nextId = candidateId.replace(/(\d+)$/, (match, num) => 
        `${parseInt(num) + 1}`
      );
      
      await new Promise(resolve => 
        setTimeout(resolve, Utils.randomDelay(300, 300))
      );
      
      return this.claimId(nextId, attempt + 1);
    }
  }
}

// ================== CONNECTION MANAGER ==================
class ConnectionManager {
  static setupMainPeerHandlers(peer) {
    peer.on('connection', (conn) => {
      this.setupConnection(conn);
    });

    peer.on('disconnected', () => {
      UI.addSystemMessage("Disconnected from signaling server");
      setTimeout(() => {
        try { peer.reconnect(); } catch (e) { /* ignore */ }
      }, 2000);
    });

    peer.on('close', () => {
      UI.addSystemMessage("Peer connection closed");
    });

    peer.on('error', (err) => {
      Logger.error('Main peer error', err);
      UI.addSystemMessage(`Peer error: ${err.message}`);
    });
  }

  static setupConnection(conn) {
    const remoteId = conn.peer;
    
    // Avoid duplicate connections
    if (state.peers.has(remoteId)) {
      const existing = state.peers.get(remoteId);
      if (existing?.open) {
        try { conn.close(); } catch (e) { /* ignore */ }
        return;
      }
    }

    conn.on('open', () => this.onConnectionOpen(conn));
    conn.on('data', (data) => this.handleMessage(conn, data));
    conn.on('close', () => this.onConnectionClose(conn));
    conn.on('error', (err) => this.onConnectionError(conn, err));
  }

  static onConnectionOpen(conn) {
    const remoteId = conn.peer;
    Logger.debug(`Connection opened: ${remoteId}`);
    
    state.peers.set(remoteId, conn);
    state.knownPeers.add(remoteId);
    StorageManager.saveKnownPeers();

    // Update user status
    const user = state.users.get(remoteId) || { nick: remoteId, color: "#ccc", status: "online" };
    user.status = "online";
    state.users.set(remoteId, user);
    UI.updateUserList();

    // Send join info and history
    this.safeSend(conn, {
      type: 'join',
      id: state.localId,
      nickname: state.nickname,
      color: state.nickColor,
      status: state.status,
      bootstrapId: state.bootstrapId
    });

    this.safeSend(conn, { type: 'history', history: state.chatHistory });
    this.safeSend(conn, { 
      type: 'peerlist', 
      peers: Array.from(state.knownPeers).concat([state.localId]) 
    });

    // Reset reconnection attempts
    state.reconnectAttempts.delete(remoteId);
  }

  static onConnectionClose(conn) {
    const remoteId = conn.peer;
    Logger.debug(`Connection closed: ${remoteId}`);
    
    state.peers.delete(remoteId);
    const user = state.users.get(remoteId);
    if (user) {
      user.status = "offline";
      state.users.set(remoteId, user);
    }
    UI.updateUserList();

    this.scheduleReconnection(remoteId);
    BootstrapManager.electBootstrap();
  }

  static onConnectionError(conn, error) {
    const remoteId = conn.peer;
    Logger.error(`Connection error: ${remoteId}`, error);
    
    try { conn.close(); } catch (e) { /* ignore */ }
    state.peers.delete(remoteId);
    
    const user = state.users.get(remoteId);
    if (user) {
      user.status = "offline";
      state.users.set(remoteId, user);
    }
    UI.updateUserList();

    this.scheduleReconnection(remoteId);
    BootstrapManager.electBootstrap();
  }

  static scheduleReconnection(peerId) {
    const attempts = state.reconnectAttempts.get(peerId) || 0;
    if (attempts >= 5) return; // Give up after 5 attempts

    const delay = Math.min(CONFIG.TIMEOUTS.RECONNECT * Math.pow(2, attempts), 30000);
    state.reconnectAttempts.set(peerId, attempts + 1);

    setTimeout(() => {
      if (!state.peers.has(peerId)) {
        this.enqueuePeer(peerId);
      }
    }, delay);
  }

  static enqueuePeer(peerId) {
    if (!peerId || peerId === state.localId || state.peers.has(peerId)) return;
    if (!state.connectQueue.includes(peerId)) {
      state.connectQueue.push(peerId);
      this.processQueue();
    }
  }

  static processQueue = Utils.throttle(() => {
    if (state.connecting || state.connectQueue.length === 0) return;
    
    const peerId = state.connectQueue.shift();
    
    // Only initiate connections to peers with higher IDs (prevents duplicate connections)
    if (!(state.localId < peerId)) {
      setTimeout(() => this.processQueue(), 200);
      return;
    }

    state.connecting = true;
    
    setTimeout(() => {
      try {
        const conn = state.peer.connect(peerId, { reliable: true });
        this.setupConnection(conn);
        
        const timeout = setTimeout(() => {
          state.connecting = false;
          this.processQueue();
        }, 10000);

        conn.on('open', () => {
          clearTimeout(timeout);
          state.connecting = false;
          this.processQueue();
        });

        conn.on('error', () => {
          clearTimeout(timeout);
          state.connecting = false;
          this.scheduleReconnection(peerId);
          this.processQueue();
        });

      } catch (e) {
        Logger.error(`Failed to connect to ${peerId}`, e);
        state.connecting = false;
        this.scheduleReconnection(peerId);
        this.processQueue();
      }
    }, Utils.randomDelay(200, 1000));
  }, 100);

  static safeSend(conn, data) {
    try {
      if (conn?.open) {
        conn.send(data);
        return true;
      }
    } catch (e) {
      Logger.warn('Failed to send message', e);
    }
    return false;
  }

  static broadcast(data, excludeConn = null) {
    let sent = 0;
    state.peers.forEach(conn => {
      if (conn !== excludeConn && this.safeSend(conn, data)) {
        sent++;
      }
    });
    return sent;
  }

  static handleMessage(conn, data) {
    if (!data || typeof data !== 'object') return;

    try {
      MessageHandler.handle(conn, data);
    } catch (error) {
      Logger.error('Message handling error', { error, data });
    }
  }
}

// ================== MESSAGE HANDLER ==================
class MessageHandler {
  static handle(conn, data) {
    // Update known peers if provided
    if (data.type === 'peerlist' && Array.isArray(data.peers)) {
      data.peers.forEach(peer => {
        if (peer && peer !== state.localId) {
          state.knownPeers.add(peer);
        }
      });
      StorageManager.saveKnownPeers();
    }

    switch (data.type) {
      case 'chat':
        this.handleChatMessage(conn, data);
        break;
      case 'join':
        this.handleJoinMessage(data);
        break;
      case 'history':
        this.handleHistoryMessage(data);
        break;
      case 'peerlist':
        this.handlePeerlistMessage(data);
        break;
      case 'request-peerlist':
        this.handlePeerlistRequest(conn);
        break;
      case 'bootstrap-update':
        this.handleBootstrapUpdate(data);
        break;
      case 'resync-request':
        this.handleResyncRequest(conn);
        break;
      case 'reaction':
        this.handleReaction(data);
        break;
      default:
        Logger.warn('Unknown message type', data.type);
    }
  }

  static handleChatMessage(conn, data) {
    if (!state.chatHistory.find(msg => msg.id === data.id)) {
      UI.addMessage(data.nickname, data.text, data.time, data.color, data.id);
      ConnectionManager.broadcast(data, conn);
    }
  }

  static handleJoinMessage(data) {
    if (data.id) {
      state.knownPeers.add(data.id);
      state.users.set(data.id, {
        nick: data.nickname || data.id,
        color: data.color || "#ccc",
        status: data.status || "online"
      });
      UI.updateUserList();
      UI.addSystemMessage(`Peer joined: ${data.nickname || data.id}`);
    }

    if (data.bootstrapId) {
      state.bootstrapId = data.bootstrapId;
    }
    BootstrapManager.electBootstrap();
  }

  static handleHistoryMessage(data) {
    if (Array.isArray(data.history)) {
      this.syncHistory(data.history);
    }
  }

  static handlePeerlistMessage(data) {
    if (Array.isArray(data.peers)) {
      data.peers.forEach(peer => {
        if (peer && peer !== state.localId) {
          state.knownPeers.add(peer);
        }
      });
    }
  }

  static handlePeerlistRequest(conn) {
    ConnectionManager.safeSend(conn, {
      type: 'peerlist',
      peers: Array.from(state.knownPeers).concat([state.localId])
    });
  }

  static handleBootstrapUpdate(data) {
    state.bootstrapId = data.bootstrapId;
    UI.addSystemMessage(`Bootstrap updated: ${data.bootstrapId}`);
  }

  static handleResyncRequest(conn) {
    ConnectionManager.safeSend(conn, {
      type: 'history',
      history: state.chatHistory
    });
  }

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

  static syncHistory(history) {
    if (!Array.isArray(history)) return;
    
    history.forEach(msg => {
      if (!state.chatHistory.find(existing => existing.id === msg.id)) {
        UI.addMessage(msg.nick, msg.text, msg.time, msg.color, msg.id);
      }
    });
  }
}

// ================== BOOTSTRAP MANAGER ==================
class BootstrapManager {
  static electBootstrap() {
    const allPeers = new Set([state.localId, ...state.peers.keys()]);
    const sortedPeers = Array.from(allPeers).filter(Boolean).sort();
    const newBootstrap = sortedPeers[0] || state.localId;

    if (state.bootstrapId !== newBootstrap) {
      state.bootstrapId = newBootstrap;
      ConnectionManager.broadcast({ type: 'bootstrap-update', bootstrapId: newBootstrap });
      Logger.info(`Bootstrap elected: ${newBootstrap}`);
    }
  }

  static startBootstrapMonitoring() {
    const interval = setInterval(() => {
      if (state.bootstrapId && 
          state.bootstrapId !== state.localId && 
          !state.peers.has(state.bootstrapId)) {
        ConnectionManager.enqueuePeer(state.bootstrapId);
      }
    }, CONFIG.INTERVALS.BOOTSTRAP_CHECK);
    
    state.intervals.set('bootstrap', interval);
  }
}

// ================== UI MANAGER ==================
class UI {
  static addMessage(nick, text, time, color, id, save = true) {
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
      ConnectionManager.broadcast({ 
        type: 'reaction', 
        id, 
        emoji, 
        user: state.nickname 
      });
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
    document.title = `P2P Chat (${onlineCount} online)`;
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
    content += `Bootstrap: ${state.bootstrapId || "none"}\n`;
    content += `Connections (${state.peers.size}):\n`;
    
    state.peers.forEach((conn, peerId) => {
      content += `  ↔ ${peerId} (${conn.open ? "open" : "closed"})\n`;
    });

    content += `\nKnown Peers (${state.knownPeers.size}):\n`;
    Array.from(state.knownPeers).slice(0, 10).forEach(peer => {
      content += `  • ${peer}\n`;
    });

    graph.textContent = content;
    graph.className = "mt-2 border-t border-gray-700 pt-2 text-gray-400";
    debugPanel.appendChild(graph);
    debugPanel.scrollTop = debugPanel.scrollHeight;
  }
}

// ================== CHAT MANAGER ==================
class ChatManager {
  static sendMessage() {
    const text = elements.input.value.trim();
    if (!text) return;

    elements.input.value = '';
    const id = Utils.generateId();
    const payload = {
      type: 'chat',
      nickname: state.nickname,
      text,
      color: state.nickColor,
      time: Utils.timestamp(),
      id
    };

    UI.addMessage(state.nickname, text, payload.time, state.nickColor, id);
    const sent = ConnectionManager.broadcast(payload);
    
    if (sent === 0) {
      UI.addSystemMessage("No peers connected - message saved locally");
    }
  }

  static broadcastJoin() {
    const payload = {
      type: 'join',
      id: state.localId,
      nickname: state.nickname,
      color: state.nickColor,
      status: state.status,
      bootstrapId: state.bootstrapId
    };

    ConnectionManager.broadcast(payload);
    state.users.set(state.localId, {
      nick: state.nickname || state.localId,
      color: state.nickColor,
      status: state.status
    });
    UI.updateUserList();
    StorageManager.saveKnownPeers();
  }

  static startPeriodicTasks() {
    // Gossip peerlist periodically
    const gossipInterval = setInterval(() => {
      const payload = {
        type: 'peerlist',
        peers: Array.from(state.knownPeers).concat([state.localId])
      };
      ConnectionManager.broadcast(payload);
    }, CONFIG.INTERVALS.GOSSIP + Math.random() * 5000);
    state.intervals.set('gossip', gossipInterval);

    // Periodic resync requests
    const resyncInterval = setInterval(() => {
      if (state.peer && state.localId && state.peers.size > 0) {
        const lastId = state.chatHistory.length > 0 ? 
          state.chatHistory[state.chatHistory.length - 1].id : null;
        ConnectionManager.broadcast({ type: 'resync-request', lastId });
      }
    }, CONFIG.INTERVALS.RESYNC + Math.random() * 3000);
    state.intervals.set('resync', resyncInterval);

    // Debug graph updates
    const debugInterval = setInterval(() => {
      if (state.peer) UI.showConnectionGraph();
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
    elements.loginBtn.onclick = () => this.handleLogin();
    elements.nickInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.handleLogin();
    });

    // Chat
    elements.sendBtn.onclick = () => ChatManager.sendMessage();
    elements.input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') ChatManager.sendMessage();
    });

    // Settings
    elements.settingsBtn.onclick = () => this.showSettings();
    elements.closeSettings.onclick = () => this.hideSettings();
    
    elements.nickInputSettings.onchange = (e) => this.updateNickname(e.target.value);
    elements.nickColorInput.oninput = (e) => this.updateNickColor(e.target.value);
    elements.statusSelect.onchange = (e) => this.updateStatus(e.target.value);
    elements.fontSizeInput.oninput = (e) => this.updateFontSize(e.target.value);
    elements.themeSelect.onchange = (e) => this.updateTheme(e.target.value);
    elements.msgStyleSelect.onchange = (e) => this.updateMessageStyle(e.target.value);

    // Window events
    window.addEventListener('beforeunload', () => this.cleanup());
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
  }

  static async handleLogin() {
    const nick = elements.nickInput.value.trim();
    if (!nick) {
      alert("Please enter a nickname");
      return;
    }

    try {
      elements.loginBtn.disabled = true;
      elements.loginBtn.textContent = "Connecting...";

      state.nickname = nick;
      StorageManager.saveUserSettings();
      document.getElementById("meName").textContent = state.nickname;

      UI.addSystemMessage(`Starting network join as ${state.nickname}...`);

      const { peer, id } = await PeerManager.performHandshake();
      state.peer = peer;
      state.localId = id;

      ConnectionManager.setupMainPeerHandlers(peer);
      this.startMeshNetwork();

      elements.login.style.display = 'none';
      UI.addSystemMessage(`Successfully joined network with ID: ${id}`);

    } catch (error) {
      Logger.error("Login failed", error);
      UI.addSystemMessage(`Login failed: ${error.message}`);
      elements.login.style.display = '';
    } finally {
      elements.loginBtn.disabled = false;
      elements.loginBtn.textContent = "Join Network";
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

    // Connect to known peers (following deterministic connection rules)
    state.knownPeers.forEach(peerId => {
      if (peerId !== state.localId && state.localId < peerId) {
        ConnectionManager.enqueuePeer(peerId);
      }
    });

    // Start periodic tasks
    ChatManager.startPeriodicTasks();
    BootstrapManager.startBootstrapMonitoring();

    // Broadcast join
    ChatManager.broadcastJoin();
    BootstrapManager.electBootstrap();

    Logger.info("Mesh network started successfully");
  }

  static showSettings() {
    elements.nickInputSettings.value = state.nickname;
    elements.settingsModal.classList.remove("hidden");
  }

  static hideSettings() {
    elements.settingsModal.classList.add("hidden");
  }

  static updateNickname(value) {
    const newNick = value.trim();
    if (newNick && newNick !== state.nickname) {
      state.nickname = newNick;
      StorageManager.saveUserSettings();
      document.getElementById("meName").textContent = state.nickname;
      if (state.peer) ChatManager.broadcastJoin();
    }
  }

  static updateNickColor(value) {
    state.nickColor = value;
    StorageManager.saveUserSettings();
    if (state.peer) ChatManager.broadcastJoin();
  }

  static updateStatus(value) {
    state.status = value;
    StorageManager.saveUserSettings();
    document.getElementById("meStatus").textContent = `(${state.status})`;
    if (state.peer) ChatManager.broadcastJoin();
  }

  static updateFontSize(value) {
    elements.messages.style.fontSize = value + "px";
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
    if (state.peer && !state.peer.open) {
      try { state.peer.reconnect(); } catch (e) { /* ignore */ }
    }
  }

  static handleOffline() {
    UI.addSystemMessage("Connection lost");
  }

  static cleanup() {
    Logger.info("App cleanup started");
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
  elements.messages.style.fontSize = fontSize + "px";
  
  if (elements.themeSelect) elements.themeSelect.value = theme;
  if (elements.msgStyleSelect) elements.msgStyleSelect.value = msgStyle;
  if (elements.fontSizeInput) elements.fontSizeInput.value = fontSize;

  // Set room info
  document.getElementById("roomLabel").textContent = CONFIG.PUBLIC_ROOM;

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
// Expose some methods for debugging
window.P2PChat = {
  state: () => ({
    localId: state.localId,
    peers: Array.from(state.peers.keys()),
    users: Object.fromEntries(state.users),
    knownPeers: Array.from(state.knownPeers),
    chatHistory: state.chatHistory.length,
    bootstrapId: state.bootstrapId
  }),
  reconnectAll: () => {
    state.knownPeers.forEach(peerId => {
      if (peerId !== state.localId && !state.peers.has(peerId)) {
        ConnectionManager.enqueuePeer(peerId);
      }
    });
  },
  clearHistory: () => {
    state.chatHistory = [];
    StorageManager.saveChatHistory();
    elements.messages.innerHTML = '';
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
