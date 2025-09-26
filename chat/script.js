// script.js
// Fully P2P single public room — PeerJS used for initial handshake/signaling only,
// sequential IDs (gamegramuser1,2,3...), collision-safe, bootstrap election, gossip peerlist,
// perfect-negotiation-inspired deterministic connector (localId < remoteId initiates).
//
// Requirements:
//  - index.html must include PeerJS client library (peerjs) loaded before this script
//  - This script keeps PeerJS DataConnections as its P2P transport (simple and reliable).

/* eslint-disable no-console */
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

// Debug panel
const debugPanel = document.createElement("div");
debugPanel.id = "debugPanel";
debugPanel.className = "hidden p-2 border-t mt-2 text-xs font-mono bg-black text-green-400 max-h-64 overflow-y-auto";
settingsModal.appendChild(debugPanel);

// --- Config & state ---
const PUBLIC_ROOM = "public";
const PEERJS_HOST = '0.peerjs.com';
const PEERJS_PORT = 443;
const PEERJS_PATH = '/';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
];

let nickname = "", nickColor = "#ffffff", status = "online";
let peer = null;                // main PeerJS instance after the temporary handshake
let tmpPeer = null;             // temporary PeerJS used only for handshake/id claim
let localId = null;             // "gamegramuserN" final ID
const peers = new Map();        // peerId => DataConnection
const users = {};               // peerId => {nick,color,status}
const knownPeers = new Set();   // gossip-discovered peers (persisted)
let chatHistory = [];
let connectQueue = [];
let connecting = false;
let bootstrapId = null;         // elected bootstrap peer
let handshakeTimeout = 2500;    // time to collect peerlists during handshake
let reconnectAttempts = {};

// --- Helpers ---
function logDebug(msg, obj) {
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  debugPanel.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
  if (obj) console.debug("[Debug]", msg, obj);
}
function drawConnectionGraph() {
  const line = document.createElement("pre");
  let graph = `You: ${localId || "?"}\n`;
  peers.forEach((c, pid) => { graph += ` ↔ ${pid} (${c.open ? "open" : "closed"})\n`; });
  line.textContent = graph;
  line.className = "mt-2 border-t border-gray-700 pt-2 text-gray-400";
  debugPanel.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
}
function timestamp() { return new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
function escapeHtml(s='') { return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function saveKnownPeer(id) {
  if (!id) return;
  knownPeers.add(id);
  const arr = Array.from(knownPeers);
  localStorage.setItem("knownPeers", JSON.stringify(arr));
}
function loadKnownPeers() {
  try {
    const arr = JSON.parse(localStorage.getItem("knownPeers") || "[]");
    arr.forEach(id => knownPeers.add(id));
  } catch (e) { /* ignore */ }
}
function setLocalAccountDefaults() {
  nickname = localStorage.getItem("nickname") || "";
  nickColor = localStorage.getItem("nickColor") || "#ffffff";
  status = localStorage.getItem("status") || "online";
  document.getElementById("meName").textContent = nickname || "Guest";
  document.getElementById("meStatus").textContent = `(${status})`;
  document.getElementById("roomLabel").textContent = PUBLIC_ROOM;
  nickColorInput.value = nickColor;
  statusSelect.value = status;
  const fontSize = localStorage.getItem("fontSize") || "14";
  fontSizeInput.value = fontSize; messagesEl.style.fontSize = fontSize + "px";
  const storedHistory = JSON.parse(localStorage.getItem("chatHistory") || "[]");
  storedHistory.forEach(m => addMsg(m.nick, m.text, m.time, m.color, m.id, false));
  chatHistory = storedHistory;
  storedHistory.forEach(m => renderReactions(m.id, m.reactions || {}));
}
function chooseSmallestFreeSequentialId(existingIds) {
  // existingIds is a Set or array; find smallest positive integer not used
  const used = new Set();
  existingIds.forEach(id => {
    const m = String(id).match(/^gamegramuser(\d+)$/i);
    if (m) used.add(Number(m[1]));
  });
  let n = 1;
  while (used.has(n)) n++;
  return `gamegramuser${n}`;
}

// ---------------- UI init ----------------
window.onload = () => {
  setLocalAccountDefaults();
  loadKnownPeers();
  addSystem("UI ready. Please log in.");
};

// ---------- Login ----------
loginBtn.onclick = async () => {
  const nick = nickInput.value.trim();
  if (!nick) { alert("Please enter a nickname"); return; }
  nickname = nick; localStorage.setItem("nickname", nickname);
  document.getElementById("meName").textContent = nickname;
  login.style.display = 'none';
  addSystem(`Starting handshake to join public network as ${nickname}...`);
  try {
    await startHandshakeAndClaimSequentialId();
    addSystem(`Final local ID: ${localId}`);
    // start mesh logic (peer already created in handshake)
    startMeshAfterHandshake();
  } catch (err) {
    addSystem("Handshake failed: " + String(err));
    console.error(err);
    login.style.display = '';
  }
};

// ---------- Settings ----------
settingsBtn.onclick = () => { nickInputSettings.value = nickname; settingsModal.classList.remove("hidden"); };
closeSettings.onclick = () => settingsModal.classList.add("hidden");
nickInputSettings.onchange = e => { nickname = e.target.value.trim() || nickname; localStorage.setItem("nickname", nickname); document.getElementById("meName").textContent = nickname; broadcastJoin(); };
nickColorInput.oninput = e => { nickColor = e.target.value; localStorage.setItem("nickColor", nickColor); broadcastJoin(); };
statusSelect.onchange = e => { status = e.target.value; localStorage.setItem("status", status); document.getElementById("meStatus").textContent = `(${status})`; broadcastJoin(); };
fontSizeInput.oninput = e => { messagesEl.style.fontSize = e.target.value + "px"; localStorage.setItem("fontSize", e.target.value); };
themeSelect.onchange = e => { document.body.dataset.theme = e.target.value; localStorage.setItem("theme", e.target.value); };
msgStyleSelect.onchange = e => { document.body.dataset.msgstyle = e.target.value; localStorage.setItem("msgStyle", e.target.value); };

// ---------------- Handshake (temporary PeerJS for ID claim) ----------------
function genRandomSuffix() { return Math.random().toString(36).slice(2,9); }

async function startHandshakeAndClaimSequentialId() {
  // 1) create temporary peer with unique tmp id
  const tmpId = `tmp-${genRandomSuffix()}`;
  tmpPeer = new Peer(tmpId, {
    host: PEERJS_HOST, port: PEERJS_PORT, path: PEERJS_PATH, secure: true,
    config: { iceServers: ICE_SERVERS }
  });

  addSystem(`Connecting to PeerJS for handshake as ${tmpId}...`);
  logDebug("tmpPeer created " + tmpId);

  // Collect peerlists for a short window, then decide ID
  const discovered = new Set(Array.from(knownPeers)); // start with local known
  const responses = []; // store peerlists

  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;

    function finish(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // cleanup tmpPeer after we either succeeded or failed
      try { tmpPeer?.destroy(); } catch(e) { /* ignore */ }
      tmpPeer = null;
      if (err) return reject(err);
      // choose smallest available sequential id
      const candidate = chooseSmallestFreeSequentialId(discovered);
      (async function claimLoop(candidateId, attempt) {
        try {
          // create the final PeerJS with this id (main peer)
          await createMainPeerWithId(candidateId);
          // success
          resolve();
        } catch (e) {
          // if PeerJS refused the id (already taken) try the next number
          logDebug("Claim failed for " + candidateId + " (" + e + ")");
          const next = (() => {
            const m = candidateId.match(/^gamegramuser(\d+)$/i);
            if (!m) return candidateId + "-1";
            return `gamegramuser${Number(m[1]) + 1}`;
          })();
          if (attempt > 20) return reject(new Error("Too many id claim retries"));
          setTimeout(() => claimLoop(next, attempt + 1), 300 + Math.random() * 300);
        }
      })(candidate, 0);
    }

    // tmpPeer events
    tmpPeer.on('open', id => {
      logDebug("tmpPeer open " + id);
      // connect to some known peers (if any) to request their peerlists
      const known = Array.from(knownPeers);
      if (known.length === 0) {
        // no known peers — we will pick gamegramuser1
        discovered.add("gamegramuser1");
        discovered.delete(undefined);
      }
      // Also attach listener for incoming connections (others may connect and reply)
      tmpPeer.on('connection', conn => {
        conn.on('data', data => {
          if (data && data.type === 'peerlist' && Array.isArray(data.peers)) {
            data.peers.forEach(p => discovered.add(p));
          }
          if (data && data.type === 'join' && data.id) {
            discovered.add(data.id);
          }
        });
        // respond to request-peerlist
        conn.on('open', () => {
          conn.send({ type: 'peerlist', peers: Array.from(knownPeers).concat([tmpId]) });
        });
      });

      // attempt to connect to the known list (also try small numbers up to some limit)
      const toTry = new Set(known);
      // also try likely early ids to find peers: 1..6
      for (let i = 1; i <= 6; i++) toTry.add(`gamegramuser${i}`);
      const tries = Array.from(toTry).slice(0, 12);
      tries.forEach(pid => {
        if (!pid || pid === tmpId) return;
        try {
          const c = tmpPeer.connect(pid, { reliable: true });
          c.on('open', () => {
            // request peerlist
            try { c.send({ type: 'request-peerlist', id: tmpId }); } catch(e) {}
            // ask for their peerlist
            c.on('data', d => {
              if (d && d.type === 'peerlist' && Array.isArray(d.peers)) d.peers.forEach(p => discovered.add(p));
              if (d && d.type === 'join' && d.id) discovered.add(d.id);
            });
            // close this tmp connection after short time
            setTimeout(() => {
              try { c.close(); } catch(e) {}
            }, 800 + Math.random() * 400);
          });
          c.on('error', () => {});
          c.on('close', () => {});
        } catch(e) { /* ignore */ }
      });

      // set timer to finish collection
      timer = setTimeout(() => {
        // merge discovered with locally known
        knownPeers.forEach(k => discovered.add(k));
        // we also must ensure we don't claim an id equal to tmpId
        discovered.delete(tmpId);
        // finish -> attempt claim
        finish();
      }, handshakeTimeout);
    });

    tmpPeer.on('error', err => {
      logDebug("tmpPeer error " + err);
      // still try to finish with whatever we have
      // short-circuit: finish but mark error if peer couldn't open
      timer = setTimeout(() => finish(), 300);
    });
  });
}

// ---------------- Create main Peer with chosen ID ----------------
async function createMainPeerWithId(candidateId) {
  return new Promise((resolve, reject) => {
    // create PeerJS with candidateId — PeerJS will throw if ID already taken
    const opts = {
      host: PEERJS_HOST, port: PEERJS_PORT, path: PEERJS_PATH, secure: true,
      config: { iceServers: ICE_SERVERS }
    };
    const p = new Peer(candidateId, opts);
    let opened = false;

    function onOpen(id) {
      opened = true;
      logDebug("Main peer open: " + id);
      peer = p;
      localId = id;
      saveKnownPeer(localId);
      setupMainPeerHandlers();
      resolve();
    }

    function onErr(err) {
      try { p.destroy(); } catch(e) {}
      if (!opened) reject(err || new Error("PeerJS create error"));
    }

    p.on('open', onOpen);
    p.on('error', onErr);
    // catch the case when PeerJS signals id already taken (PeerJS error)
    setTimeout(() => {
      if (!opened) {
        // give a small chance; if not opened after 4s, reject
        onErr(new Error("timeout creating main peer"));
      }
    }, 4000);
  });
}

function setupMainPeerHandlers() {
  // respond to incoming connections
  peer.on('connection', conn => {
    // On incoming connection we follow deterministic peer-open handling below
    setupConn(conn);
  });

  // nice debug hooks
  peer.on('disconnected', () => {
    addSystem("Disconnected from PeerJS signalling server.");
    // try to reconnect gently
    setTimeout(() => {
      try { peer.reconnect(); } catch (e) { /* ignore */ }
    }, 2000);
  });
  peer.on('close', () => { addSystem("PeerJS connection closed."); });
  peer.on('error', err => addSystem("PeerJS error: " + String(err)));
}

// ---------------- After handshake: mesh formation ----------------
function startMeshAfterHandshake() {
  // load known peers and enqueue connections
  loadKnownPeers();
  // add self to users
  users[localId] = { nick: nickname || localId, color: nickColor, status: 'online' };
  updateUserList();
  // start connecting to known peers — obey deterministic rule: only initiate when local < remote
  knownPeers.forEach(id => {
    if (typeof id !== 'string') return;
    // don't connect to self
    if (id === localId) return;
    // prefer connecting only to peers > localId (to avoid double connect)
    if (localId < id) enqueuePeer(id);
  });
  // periodic gossip & peerlist broadcast
  setInterval(() => {
    gossipPeerlist();
  }, 20000 + Math.random()*5000);

  // periodic try to connect to bootstrap if missing
  setInterval(() => {
    if (bootstrapId && bootstrapId !== localId && !peers.has(bootstrapId)) {
      enqueuePeer(bootstrapId);
    }
  }, 10000 + Math.random()*4000);
  // broadcast join so others learn about us
  broadcastJoin();
}

// ---------------- Queue & connections (deterministic initiation) ----------------
function enqueuePeer(peerId) {
  if (!peerId || peerId === localId) return;
  // avoid self or existing
  if (peers.has(peerId)) return;
  if (!connectQueue.includes(peerId)) {
    connectQueue.push(peerId);
    processQueue();
  }
}
function processQueue() {
  if (connecting || connectQueue.length === 0) return;
  connecting = true;
  const peerId = connectQueue.shift();
  // ensure we only initiate to peerId when localId < peerId to avoid double connect
  if (!(localId < peerId)) {
    // someone else should connect to them — skip for now
    connecting = false;
    setTimeout(processQueue, 200);
    return;
  }
  const delay = 200 + Math.random()*1200;
  setTimeout(() => {
    try {
      const conn = peer.connect(peerId, { reliable: true });
      setupConn(conn);
      conn.on('open', () => {
        connecting = false;
        processQueue();
      });
      conn.on('error', () => { connecting = false; setTimeout(() => enqueuePeer(peerId), 5000); processQueue(); });
      conn.on('close', () => { connecting = false; processQueue(); });
    } catch (e) {
      connecting = false;
      setTimeout(() => enqueuePeer(peerId), 3000);
      processQueue();
    }
  }, delay);
}

// ---------------- Connection setup & message handling ----------------
function setupConn(conn) {
  const remote = conn.peer;
  // avoid duplicate connection objects for same peer: keep one (prefer incoming)
  if (peers.has(remote)) {
    // if we already have a connection and this one is an incoming duplicate, close the duplicate
    const existing = peers.get(remote);
    // if existing is open, close this new one; otherwise replace
    if (existing && existing.open) {
      try { conn.close(); } catch(e) {}
      return;
    } else {
      peers.delete(remote);
    }
  }

  conn.on('open', () => {
    logDebug(`Data connection open: ${remote}`);
    peers.set(remote, conn);
    knownPeers.add(remote);
    saveKnownPeer(remote);

    if (!users[remote]) users[remote] = { nick: remote, color: "#ccc", status: "online" };
    else users[remote].status = "online";
    updateUserList();

    // send minimal join + history + our known list
    safeSend(conn, { type: 'join', id: localId, nickname, color: nickColor, status, bootstrapId });
    safeSend(conn, { type: 'history', history: chatHistory });
    safeSend(conn, { type: 'peerlist', peers: Array.from(knownPeers).concat([localId]) });
  });

  conn.on('data', data => {
    try { handleData(conn, data); } catch(e) { console.error("data handler", e); }
  });

  conn.on('close', () => {
    logDebug(`Connection closed: ${remote}`);
    peers.delete(remote);
    if (users[remote]) users[remote].status = "offline";
    updateUserList();
    // try to reconnect later
    setTimeout(() => enqueuePeer(remote), 3000 + Math.random()*4000);
    // re-elect bootstrap if necessary
    electBootstrap();
  });

  conn.on('error', (err) => {
    logDebug(`Connection error with ${remote}: ${err}`);
    try { conn.close(); } catch(e) {}
    peers.delete(remote);
    if (users[remote]) users[remote].status = "offline";
    updateUserList();
    setTimeout(() => enqueuePeer(remote), 4000 + Math.random()*4000);
    electBootstrap();
  });
}

function safeSend(conn, data) {
  try {
    if (conn && conn.open) conn.send(data);
  } catch (e) { /* swallow */ }
}

function handleData(conn, data) {
  if (!data || typeof data !== 'object') return;
  // update knownPeers if the sender gave us info
  if (data.type === 'peerlist' && Array.isArray(data.peers)) {
    data.peers.forEach(p => { if (p && p !== localId) knownPeers.add(p); });
    // store to localStorage
    saveKnownPeer(localId);
  }
  switch (data.type) {
    case 'chat':
      if (!chatHistory.find(m => m.id === data.id)) {
        addMsg(data.nickname, data.text, data.time, data.color, data.id);
        // propagate (gossip)
        broadcast(data, conn);
      }
      break;
    case 'join':
      if (data.id) {
        saveKnownPeer(data.id);
        users[data.id] = { nick: data.nickname || data.id, color: data.color || "#ccc", status: data.status || "online" };
        updateUserList();
        addSystem(`Peer joined: ${data.nickname || data.id} (${data.id})`);
      }
      if (data.bootstrapId) bootstrapId = data.bootstrapId;
      electBootstrap();
      break;
    case 'history':
      if (Array.isArray(data.history)) {
        syncHistory(data.history);
      }
      break;
    case 'peerlist':
      if (Array.isArray(data.peers)) {
        data.peers.forEach(p => { if (p && p !== localId) knownPeers.add(p); });
      }
      break;
    case 'request-peerlist':
      safeSend(conn, { type: 'peerlist', peers: Array.from(knownPeers).concat([localId]) });
      break;
    case 'bootstrap-update':
      bootstrapId = data.bootstrapId;
      addSystem(`Bootstrap updated: ${bootstrapId}`);
      break;
    case 'resync-request':
      // a peer asked for resync — send history since last known if available
      safeSend(conn, { type: 'history', history: chatHistory });
      break;
    case 'reaction':
      handleReaction(data);
      break;
    default:
      // ignore unknown
      break;
  }
}

// ---------------- Chat operations ----------------
sendBtn.onclick = sendMsg;
input.addEventListener('keypress', e => { if (e.key === 'Enter') sendMsg(); });

function sendMsg() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const id = Date.now() + "-" + Math.random().toString(36).slice(2,7);
  const payload = { type: 'chat', nickname, text, color: nickColor, time: timestamp(), id };
  addMsg(nickname, text, payload.time, nickColor, id);
  broadcast(payload);
}

function handleReaction(data) {
  const msg = chatHistory.find(m => m.id === data.id);
  if (!msg) return;
  if (!msg.reactions) msg.reactions = {};
  if (!msg.reactions[data.emoji]) msg.reactions[data.emoji] = [];
  if (!msg.reactions[data.emoji].includes(data.user)) msg.reactions[data.emoji].push(data.user);
  renderReactions(data.id, msg.reactions);
}

// broadcast to all peers except an optional exceptConn
function broadcast(data, exceptConn = null) {
  peers.forEach(c => {
    if (c && c.open && c !== exceptConn) {
      try { c.send(data); } catch (e) { /* ignore */ }
    }
  });
}

// safeBroadcast with retry if no peers right now
function safeBroadcast(data, tries = 0) {
  if (peers.size > 0) {
    broadcast(data);
  } else if (tries < 10) {
    setTimeout(() => safeBroadcast(data, tries + 1), 1500 + Math.random() * 1000);
  } else {
    // persist to local history; will be distributed when peers arrive
    addSystem("No peers to broadcast to right now; message saved locally.");
  }
}

// ---------- Join / Gossip ----------
function broadcastJoin() {
  const d = { type: 'join', id: localId, nickname, color: nickColor, status, bootstrapId };
  broadcast(d);
  users[localId] = { nick: nickname || localId, color: nickColor, status };
  updateUserList();
  saveKnownPeer(localId);
}

function gossipPeerlist() {
  const payload = { type: 'peerlist', peers: Array.from(knownPeers).concat([localId]) };
  broadcast(payload);
}

// ---------- History sync ----------
function syncHistory(history) {
  if (!Array.isArray(history)) return;
  history.forEach(m => {
    if (!chatHistory.find(x => x.id === m.id)) addMsg(m.nick, m.text, m.time, m.color, m.id);
  });
}

// ---------- Bootstrap election ----------------
function electBootstrap() {
  // choose lexicographically smallest available ID among connected peers + self
  const set = new Set([localId, ...peers.keys()]);
  const arr = Array.from(set).filter(Boolean).sort();
  const newBoot = arr[0] || localId;
  if (bootstrapId !== newBoot) {
    bootstrapId = newBoot;
    broadcast({ type: 'bootstrap-update', bootstrapId });
  }
}

// ---------- UI & persistence -------------
function addMsg(nick, text, time, color, id, save = true) {
  if (messagesEl.querySelector(`.msg[data-id="${id}"]`)) return;
  const div = document.createElement('div');
  div.className = 'msg new'; div.dataset.id = id;
  div.innerHTML = `
    <div class="meta"><span class="nickname" style="color:${escapeHtml(color)}">${escapeHtml(nick)}</span> <span>${escapeHtml(time)}</span></div>
    <div class="text">${escapeHtml(text)}</div>
    <div class="reactions"></div>
    <div class="reaction-bar"><span class="reactBtn">😊</span><span class="reactBtn">👍</span><span class="reactBtn">❤️</span></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  div.querySelectorAll('.reactBtn').forEach(btn => btn.onclick = () => {
    const emoji = btn.textContent;
    reactToMsg(id, emoji);
  });
  setTimeout(() => div.classList.add('show'), 10);
  if (save && !chatHistory.find(m => m.id === id)) {
    chatHistory.push({ id, nick, text, time, color, reactions: {} });
    localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
  }
}
function reactToMsg(id, emoji) {
  const msg = chatHistory.find(m => m.id === id);
  if (!msg) return;
  if (!msg.reactions) msg.reactions = {};
  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
  if (!msg.reactions[emoji].includes(nickname)) msg.reactions[emoji].push(nickname);
  renderReactions(id, msg.reactions);
  localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
  broadcast({ type: 'reaction', id, emoji, user: nickname });
}
function renderReactions(id, reactions) {
  const div = messagesEl.querySelector(`.msg[data-id="${id}"] .reactions`);
  if (!div) return;
  div.innerHTML = "";
  Object.entries(reactions).forEach(([emoji, users]) => {
    const span = document.createElement("span");
    span.textContent = `${emoji} ${users.length}`;
    span.className = "reaction";
    div.appendChild(span);
  });
}

function updateUserList() {
  userListEl.innerHTML = "";
  Object.entries(users).forEach(([id, u]) => {
    const div = document.createElement('div');
    div.className = 'user';
    div.style.color = u.color || "#ccc";
    div.textContent = `${u.nick || id} • ${u.status || "offline"}`;
    userListEl.appendChild(div);
  });
}

function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'system';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  console.log("[SYSTEM]", text);
}

// ----------------- Periodic tasks -----------------
setInterval(() => {
  // resync-request so late joiners can ask for history
  if (peer && localId && peers.size > 0) {
    broadcast({ type: 'resync-request', lastId: chatHistory.length ? chatHistory[chatHistory.length - 1].id : null });
  }
}, 15000 + Math.random() * 3000);

// show connection graph occasionally in debug
setInterval(() => { if (debugPanel && peer) drawConnectionGraph(); }, 10000);

// ----------------- End of script -----------------
