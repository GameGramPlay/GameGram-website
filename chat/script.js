// script.js — Fully P2P with robust PeerJS public-host fallbacks + verbose connection messages

const messagesEl = document.getElementById('messages');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const userListEl = document.getElementById('userList');
const login = document.getElementById('login');
const nickInput = document.getElementById('nickInput');
const loginBtn = document.getElementById('loginBtn');

const settingsBtn = document.getElementById("settingsBtn");
const settingsModal = document.getElementById("settingsModal");
const closeSettings = document.getElementById("closeSettings");
const nickInputSettings = document.getElementById("nickInputSettings");
const nickColorInput = document.getElementById("nickColor");
const statusSelect = document.getElementById("statusSelect");
const fontSizeInput = document.getElementById("fontSize");
const themeSelect = document.getElementById("themeSelect");
const msgStyleSelect = document.getElementById("msgStyle");

let nickname = "", nickColor = "#ffffff", status = "online";
let peer;                                // PeerJS Peer instance
const peers = new Map();                 // peerId => DataConnection
const knownPeers = new Set();            // discovered peers
let chatHistory = [];
let users = {};

// Public PeerJS cloud host candidates (tries in order)
const PEERJS_HOSTS = ['0.peerjs.com','1.peerjs.com','2.peerjs.com','3.peerjs.com'];

// How long to wait for the Peer to open before trying next host (ms)
const PEER_OPEN_TIMEOUT = 2500;

// ---------- LocalStorage & UI init ----------
window.onload = () => {
  nickname = localStorage.getItem("nickname") || "";
  nickColor = localStorage.getItem("nickColor") || "#ffffff";
  status = localStorage.getItem("status") || "online";

  document.getElementById("meName").textContent = nickname || "Guest";
  document.getElementById("meStatus").textContent = `(${status})`;

  nickColorInput.value = nickColor;
  statusSelect.value = status;

  const theme = localStorage.getItem("theme") || "dark";
  document.body.dataset.theme = theme;
  themeSelect.value = theme;

  const msgStyle = localStorage.getItem("msgStyle") || "cozy";
  document.body.dataset.msgstyle = msgStyle;
  msgStyleSelect.value = msgStyle;

  const fontSize = localStorage.getItem("fontSize") || "14";
  fontSizeInput.value = fontSize;
  messagesEl.style.fontSize = fontSize + "px";

  const storedHistory = JSON.parse(localStorage.getItem("chatHistory") || "[]");
  storedHistory.forEach(m => addMsg(m.nick, m.text, m.time, m.color, m.id, false));
  chatHistory = storedHistory;
  storedHistory.forEach(m => renderReactions(m.id, m.reactions || {}));

  addSystem("UI ready. Please log in.");
};

// ---------- Login ----------
loginBtn.onclick = () => {
  nickname = nickInput.value.trim() || "Guest" + Math.floor(Math.random() * 1000);
  localStorage.setItem("nickname", nickname);
  document.getElementById("meName").textContent = nickname;
  login.style.display = 'none';
  startPeerWithFallbacks();
};

// ---------- Settings ----------
settingsBtn.onclick = () => {
  nickInputSettings.value = nickname;
  settingsModal.classList.remove("hidden");
};
closeSettings.onclick = () => settingsModal.classList.add("hidden");

nickInputSettings.onchange = e => {
  nickname = e.target.value.trim() || nickname;
  localStorage.setItem("nickname", nickname);
  document.getElementById("meName").textContent = nickname;
  broadcastJoin();
};
nickColorInput.oninput = e => {
  nickColor = e.target.value;
  localStorage.setItem("nickColor", nickColor);
  broadcastJoin();
};
statusSelect.onchange = e => {
  status = e.target.value;
  localStorage.setItem("status", status);
  document.getElementById("meStatus").textContent = `(${status})`;
  broadcastJoin();
};
fontSizeInput.oninput = e => {
  messagesEl.style.fontSize = e.target.value + "px";
  localStorage.setItem("fontSize", e.target.value);
};
themeSelect.onchange = e => {
  document.body.dataset.theme = e.target.value;
  localStorage.setItem("theme", e.target.value);
};
msgStyleSelect.onchange = e => {
  document.body.dataset.msgstyle = e.target.value;
  localStorage.setItem("msgStyle", e.target.value);
};

// ---------- PeerJS startup with host fallbacks ----------
function startPeerWithFallbacks() {
  addSystem("Starting PeerJS client — trying public cloud endpoints...");
  tryPeerHostsSequentially(PEERJS_HOSTS.slice(), 0);
}

function tryPeerHostsSequentially(hosts, attemptIndex) {
  if (attemptIndex >= hosts.length) {
    addSystem("All public PeerJS endpoints failed. You can run your own PeerServer and edit the fallback in script.js.");
    console.warn("PeerJS: All public hosts failed to respond.");
    // Optional: You can auto-fallback to a self-hosted server here by calling startPeerWithOptions(...)
    // startPeerWithOptions({ host: 'your.domain', port: 9000, path: '/peerjs', secure: true });
    return;
  }

  const host = hosts[attemptIndex];
  addSystem(`Attempting PeerJS host: ${host}`);
  console.log("PeerJS: attempting host:", host);

  let openHandled = false;
  let errorHandled = false;

  // create peer with this host
  startPeerWithOptions({
    host,
    port: 443,
    path: '/',        // PeerJS cloud uses root path
    secure: true,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
  }, (err) => {
    // callback on failure OR peer error
    if (err) {
      // destroy and try next
      console.warn(`PeerJS host ${host} failed:`, err);
      addSystem(`PeerJS host ${host} failed: ${String(err)}`);
      cleanupPeer();
      setTimeout(()=> tryPeerHostsSequentially(hosts, attemptIndex + 1), 200);
    } else {
      // success: peer open handled in startPeerWithOptions open handler
    }
  });

  // If open doesn't fire in PEER_OPEN_TIMEOUT, treat as failure
  const toId = setTimeout(() => {
    if (!peer || peer.disconnected || peer.destroyed || !peer.id) {
      if (!errorHandled) {
        addSystem(`Peer host ${host} timed out.`);
        console.warn(`PeerJS host ${host} open timed out`);
        cleanupPeer();
        tryPeerHostsSequentially(hosts, attemptIndex + 1);
      }
    }
  }, PEER_OPEN_TIMEOUT);

  // the startPeerWithOptions function sets up peer.on('open') to continue normal flow
}

// startPeerWithOptions creates a Peer and wires standard handlers; callback(err) runs on immediate creation error only
function startPeerWithOptions(opts, callback) {
  try {
    // If there's an existing peer, destroy it — we are starting fresh for this attempt
    if (peer && !peer.destroyed) try { peer.destroy(); } catch(e){}

    // create peer - leave id undefined so server will generate one
    // Peer constructor accepts either (options) or (id, options)
    // We pass options only
    peer = new Peer(undefined, opts);

    peer.on('open', id => {
      console.log("[Peer] open:", id);
      addSystem(`Connected as ${nickname} (${id})`);
      // after open: try reconnecting to known peers and broadcast our presence
      const known = JSON.parse(localStorage.getItem("knownPeers") || "[]");
      known.forEach(pid => { if (pid !== id) connectToPeer(pid); });
      broadcastJoin(); // tell connected peers about us (if any)
      // Normal peer lifecycle handlers:
      peer.on('connection', conn => {
        addSystem(`Incoming connection from ${conn.peer}`);
        console.log('[Peer] incoming connection from', conn.peer);
        setupConn(conn);
      });
      peer.on('disconnected', () => {
        addSystem("Peer disconnected from signaling server.");
        console.warn("[Peer] disconnected");
      });
      peer.on('close', () => {
        addSystem("Peer connection closed.");
        console.warn("[Peer] closed");
      });
      peer.on('error', err => {
        addSystem("Peer error: " + String(err));
        console.error("[Peer] error", err);
      });
      if (callback) callback(null);
    });

    peer.on('error', err => {
      // bubble up to try next host
      console.error("[Peer] constructor-level error", err);
      addSystem("PeerJS error: " + String(err));
      if (callback) callback(err);
      // Note: do not destroy here if callback already handles next step
    });

  } catch (ex) {
    console.error("startPeerWithOptions exception:", ex);
    if (callback) callback(ex);
  }
}

function cleanupPeer() {
  try {
    if (peer && !peer.destroyed) peer.destroy();
  } catch (e) { /* ignore */ }
  peer = null;
}

// ---------- Connect to a peer ----------
function connectToPeer(peerId) {
  if (!peer) { addSystem("Cannot connect: peer not ready."); return; }
  if (peerId === peer.id) return;
  if (peers.has(peerId)) return; // already connected
  try {
    addSystem(`Connecting to peer ${peerId}...`);
    const conn = peer.connect(peerId, { reliable: true });
    setupConn(conn);
  } catch (err) {
    console.warn("connectToPeer error:", err);
    addSystem(`Failed to connect to ${peerId}: ${String(err)}`);
  }
}

// ---------- Connection Setup (both incoming and outgoing) ----------
function setupConn(conn) {
  conn.on('open', () => {
    addSystem(`Data connection open: ${conn.peer}`);
    peers.set(conn.peer, conn);
    knownPeers.add(conn.peer);
    saveKnownPeer(conn.peer);

    // Send join message about ourselves (so remote sees our nickname)
    conn.send({ type: 'join', id: peer.id, nickname, color: nickColor, status });

    // send chat history & known peers to this newly opened connection
    conn.send({ type: 'history', history: chatHistory });
    conn.send({ type: 'peerlist', peers: Array.from(knownPeers) });

    // announce in UI
    addSystem(`Connected to peer ${conn.peer}`);
  });

  conn.on('data', data => {
    // verbose log for debugging
    console.log('[conn data]', conn.peer, data);
    switch (data.type) {
      case 'chat':
        handleIncomingMsg(data);
        break;
      case 'join':
        handlePeerJoin(data);
        break;
      case 'history':
        syncHistory(data.history);
        break;
      case 'peerlist':
        // try connections from peerlist
        (data.peers || []).forEach(p => {
          if (p !== peer.id && !peers.has(p)) {
            addSystem(`Discovered peer ${p} from ${conn.peer}; attempting connect...`);
            connectToPeer(p);
          }
        });
        break;
      case 'reaction':
        handleReaction(data);
        break;
      case 'resync-request':
        // ignoring resync-request in P2P model — history shared on open
        break;
      default:
        console.warn("Unknown data.type:", data.type);
    }
  });

  conn.on('close', () => {
    addSystem(`Connection closed: ${conn.peer}`);
    peers.delete(conn.peer);
    delete users[conn.peer];
    updateUserList();
  });

  conn.on('error', err => {
    addSystem(`Connection error with ${conn.peer}: ${String(err)}`);
    console.warn("Connection error", conn.peer, err);
    peers.delete(conn.peer);
    delete users[conn.peer];
    updateUserList();
  });
}

// ---------- Chat / broadcast ----------
sendBtn.onclick = sendMsg;
input.addEventListener('keypress', e => { if (e.key === 'Enter') sendMsg(); });

function sendMsg() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const id = Date.now() + "-" + Math.random();
  const data = { type: 'chat', nickname, text, color: nickColor, time: timestamp(), id };
  addMsg(nickname, text, data.time, nickColor, id);
  broadcast(data);
}

function handleIncomingMsg(msg) {
  if (!chatHistory.find(m => m.id === msg.id)) {
    addMsg(msg.nickname, msg.text, msg.time, msg.color, msg.id);
    // propagate to others (gossip)
    broadcast(msg);
  }
}

function broadcast(data, except) {
  peers.forEach(conn => {
    try {
      if (conn.open && conn !== except) conn.send(data);
    } catch (e) {
      console.warn("Broadcast send failed to", conn.peer, e);
    }
  });
}

// ---------- Join / Peer management ----------
function broadcastJoin(conn) {
  const data = { type: 'join', id: peer.id, nickname, color: nickColor, status };
  if (conn && conn.open) conn.send(data);
  else broadcast(data);
  users[peer.id] = { nick: nickname, color: nickColor, status };
  updateUserList();
}

function handlePeerJoin(data) {
  users[data.id] = { nick: data.nickname, color: data.color, status: data.status };
  updateUserList();
  addSystem(`Peer joined: ${data.nickname} (${data.id})`);
}

// ---------- History ----------
function syncHistory(history) {
  if (!history || !Array.isArray(history)) return;
  history.forEach(m => {
    if (!chatHistory.find(msg => msg.id === m.id)) {
      addMsg(m.nick, m.text, m.time, m.color, m.id);
    }
  });
}

// ---------- Reactions ----------
function reactToMsg(id, emoji) {
  const msg = chatHistory.find(m => m.id === id);
  if (!msg) return;
  if (!msg.reactions) msg.reactions = {};
  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
  if (!msg.reactions[emoji].includes(nickname)) msg.reactions[emoji].push(nickname);
  renderReactions(id, msg.reactions);
  broadcast({ type: 'reaction', id, emoji, user: nickname });
}

function handleReaction(data) {
  const msg = chatHistory.find(m => m.id === data.id);
  if (!msg) return;
  if (!msg.reactions) msg.reactions = {};
  if (!msg.reactions[data.emoji]) msg.reactions[data.emoji] = [];
  if (!msg.reactions[data.emoji].includes(data.user)) msg.reactions[data.emoji].push(data.user);
  renderReactions(data.id, msg.reactions);
}

// ---------- UI helpers ----------
function addMsg(nick, text, time, color, id, save = true, animate = true) {
  if (messagesEl.querySelector(`.msg[data-id="${id}"]`)) return;
  const div = document.createElement('div');
  div.className = 'msg';
  if (animate) div.classList.add('new');
  div.dataset.id = id;
  div.innerHTML = `
    <div class="meta">
      <span class="nickname" style="color:${color}">${nick}</span> <span>${time}</span>
    </div>
    <div class="text">${escapeHtml(text)}</div>
    <div class="reactions"></div>
    <div class="reaction-bar">
      <span class="reactBtn">😊</span>
      <span class="reactBtn">👍</span>
      <span class="reactBtn">❤️</span>
    </div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  div.querySelectorAll('.reactBtn').forEach(btn => {
    btn.onclick = () => reactToMsg(id, btn.textContent);
  });

  if (animate) {
    setTimeout(()=>div.classList.add('show'), 10);
    setTimeout(()=>div.classList.remove('new'), 500);
  }

  if (save) {
    if (!chatHistory.find(m => m.id === id)) {
      chatHistory.push({ id, nick, text, time, color, reactions: {} });
      localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
    }
  }
}

function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'system';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  console.log("[SYSTEM]", text);
}

function updateUserList() {
  userListEl.innerHTML = "";
  Object.values(users).forEach(u => {
    const div = document.createElement('div');
    div.className = 'user';
    div.style.color = u.color;
    div.textContent = `${u.nick} • ${u.status}`;
    userListEl.appendChild(div);
  });
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

function escapeHtml(s='') {
  return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
}

// ---------- Known peers persistence ----------
function saveKnownPeer(peerId) {
  let known = JSON.parse(localStorage.getItem("knownPeers")||"[]");
  if(!known.includes(peerId)) { known.push(peerId); localStorage.setItem("knownPeers", JSON.stringify(known)); }
}

/* ---------------- Reactions ---------------- */
function reactToMsg(id, emoji) {
    const msg = chatHistory.find(m => m.id === id);
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    if (!msg.reactions[emoji].includes(nickname)) msg.reactions[emoji].push(nickname);
    renderReactions(id, msg.reactions);
    localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
    const data = { type: 'reaction', id, emoji, user: nickname };
    if (role === 'host') broadcast(data);
    else if (conn && conn.open) conn.send(data);
}

function renderReactions(id, reactions) {
    const div = messagesEl.querySelector(`.msg[data-id="${id}"] .reactions`);
    if (!div) return;
    div.innerHTML = "";
    Object.entries(reactions).forEach(([emoji, users]) => {
        const span = document.createElement('span');
        span.textContent = `${emoji} ${users.length}`;
        span.className = "reaction";
        div.appendChild(span);
    });
}

/* ---------------- Join ---------------- */
function sendJoin() {
    const data = { type: 'join', nickname, color: nickColor, status, time: timestamp() };
    if (role === 'host') { 
        users[peer.id] = { nick: nickname, color: nickColor, status }; 
        updateUserList(); 
        broadcast(data); 
    } else if (conn && conn.open) conn.send(data);
}

/* ---------------- Background Resync ---------------- */
setInterval(() => {
    if (role === 'client' && conn && conn.open) {
        conn.send({ type: 'resync-request', lastId: chatHistory.length ? chatHistory[chatHistory.length - 1].id : null });
    }
}, 15000);

/* ---------------- Connection Setup ---------------- */
function setupConn(c) {
    c.on('data', d => {
        switch (d.type) {
            case 'chat':
                if (role === 'host') broadcast(d);
                addMsg(d.nickname, d.text, d.time, d.color, d.id);
                break;
            case 'system':
                addSystem(d.text);
                break;
            case 'join':
                users[c.peer] = { nick: d.nickname, color: d.color, status: d.status };
                updateUserList();
                if (role === 'host') broadcast(d);
                break;
            case 'userlist':
                users = d.users; updateUserList();
                break;
            case 'history':
                d.history.forEach(m => addMsg(m.nick, m.text, m.time, m.color, m.id));
                break;
            case 'reaction':
                const msg = chatHistory.find(m => m.id === d.id);
                if (msg) {
                    if (!msg.reactions[d.emoji]) msg.reactions[d.emoji] = [];
                    if (!msg.reactions[d.emoji].includes(d.user)) msg.reactions[d.emoji].push(d.user);
                    renderReactions(d.id, msg.reactions);
                    localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
                }
                break;
            case 'resync-request':
                if (role === 'host') {
                    c.send({ type: 'userlist', users });
                    const lastIndex = chatHistory.findIndex(m => m.id === d.lastId);
                    const newMessages = lastIndex >= 0 ? chatHistory.slice(lastIndex + 1) : chatHistory;
                    if (newMessages.length) c.send({ type: 'history', history: newMessages });
                }
                break;
        }
    });

    c.on('close', () => { conns.delete(c); delete users[c.peer]; updateUserList(); });
    c.on('error', err => { conns.delete(c); delete users[c.peer]; updateUserList(); console.warn(err); });
}

/* ---------------- Broadcast ---------------- */
function broadcast(data, except) {
    conns.forEach(c => {
        if (c.open && c !== except) c.send(data);
    });
}


 
