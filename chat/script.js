// script.js — Fully P2P with PeerJS fallback hosts + TURN/STUN + throttled connections

const messagesEl = document.getElementById('messages');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const userListEl = document.getElementById('userList');
const login = document.getElementById('login');
const nickInput = document.getElementById('nickInput');
const roomInput = document.getElementById('roomInput'); 
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

const debugPanel = document.createElement("div");
debugPanel.id = "debugPanel";
debugPanel.className = "hidden p-2 border-t mt-2 text-xs font-mono bg-black text-green-400 max-h-64 overflow-y-auto";
settingsModal.appendChild(debugPanel);

let nickname = "", nickColor = "#ffffff", status = "online";
let peer; 
const peers = new Map(); 
const knownPeers = new Set(); 
let chatHistory = [];
let users = {};
let debugEnabled = false;

// ---------------- Helpers ----------------
function logDebug(msg, obj) {
  if (!debugEnabled) return;
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  debugPanel.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
  if (obj) console.debug("[Debug]", msg, obj);
}

const PEERJS_HOSTS = ['0.peerjs.com','1.peerjs.com','2.peerjs.com','3.peerjs.com'];
const PEER_OPEN_TIMEOUT = 2500;

let roomName = "public"; 

// ---------- LocalStorage & UI init ----------
window.onload = () => {
  nickname = localStorage.getItem("nickname") || "";
  nickColor = localStorage.getItem("nickColor") || "#ffffff";
  status = localStorage.getItem("status") || "online";
  roomName = localStorage.getItem("roomName") || "public";

  document.getElementById("meName").textContent = nickname || "Guest";
  document.getElementById("meStatus").textContent = `(${status})`;
  document.getElementById("roomLabel").textContent = roomName;

  nickColorInput.value = nickColor;
  statusSelect.value = status;
  roomInput.value = roomName;

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
  roomName = roomInput.value.trim() || "public";
  localStorage.setItem("nickname", nickname);
  localStorage.setItem("roomName", roomName);

  document.getElementById("meName").textContent = nickname;
  document.getElementById("roomLabel").textContent = roomName;

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

// ---------- PeerJS startup ----------
function makePeerId() {
  return `${roomName}-${Math.random().toString(36).substr(2, 9)}`;
}

function startPeerWithFallbacks() {
  tryPeerHostsSequentially(PEERJS_HOSTS.slice(), 0);
}

function tryPeerHostsSequentially(hosts, attemptIndex) {
  if (attemptIndex >= hosts.length) {
    addSystem("All public PeerJS endpoints failed. Run your own PeerServer.");
    return;
  }
  const host = hosts[attemptIndex];
  startPeerWithOptions({
    host, port: 443, path: '/', secure: true,
    config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username:'openrelayproject', credential:'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username:'openrelayproject', credential:'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username:'openrelayproject', credential:'openrelayproject' }
    ]}
  }, (err) => {
    if (err) setTimeout(() => tryPeerHostsSequentially(hosts, attemptIndex + 1), 500);
  });
  setTimeout(() => { if (!peer?.id) tryPeerHostsSequentially(hosts, attemptIndex + 1); }, PEER_OPEN_TIMEOUT);
}

function startPeerWithOptions(opts, callback) {
  try { if (peer && !peer.destroyed) peer.destroy(); } catch {}
  peer = new Peer(makePeerId(), opts);

  peer.on('open', id => {
    addSystem(`Connected as ${nickname} (${id}) in room [${roomName}]`);
    const known = JSON.parse(localStorage.getItem("knownPeers") || "[]");
    known.forEach(pid => { if (pid !== id) connectToPeer(pid); });
    broadcastJoin();
    peer.on('connection', conn => setupConn(conn));
    if (callback) callback(null);
  });
  peer.on('error', err => { if (callback) callback(err); });
}

// ---------- Connections (Throttled) ----------
const pendingPeers = [];
const failedPeers = new Map();
const MAX_RETRIES = 5;
const CONNECTIONS_PER_TICK = 3;

function scheduleConnections() {
  if (!peer || !peer.open) return;

  const newPeers = Array.from(knownPeers).filter(p => p !== peer.id && !peers.has(p) && !pendingPeers.includes(p));
  pendingPeers.push(...newPeers);

  const interval = setInterval(() => {
    if (!peer || !peer.open) { clearInterval(interval); return; }

    let attempts = 0;
    while (attempts < CONNECTIONS_PER_TICK && pendingPeers.length > 0) {
      const pid = pendingPeers.shift();
      if (peers.has(pid)) continue;

      const retries = failedPeers.get(pid) || 0;
      if (retries >= MAX_RETRIES) {
        failedPeers.delete(pid);
        knownPeers.delete(pid);
        delete users[pid];
        updateUserList();
        addSystem(`Peer ${pid} does not exist. Removed from known peers.`);
        continue;
      }

      connectToPeer(pid);
      failedPeers.set(pid, retries + 1);
      attempts++;
    }
  }, 1000);
}

function connectToPeer(peerId) {
  if (!peer || peerId === peer.id || peers.has(peerId)) return;
  const conn = peer.connect(peerId, { reliable: true });
  setupConn(conn);
}

function setupConn(conn) {
  conn.on('open', () => {
    peers.set(conn.peer, conn);
    failedPeers.delete(conn.peer);
    users[conn.peer] = users[conn.peer] || { nick: conn.peer, color: "#aaa", status: "online" };
    updateUserList();

    conn.send({ type: 'join', id: peer.id, nickname, color: nickColor, status });
    conn.send({ type: 'history', history: chatHistory });
    conn.send({ type: 'peerlist', peers: Array.from(knownPeers).concat([peer.id]) });
  });

  conn.on('data', data => handleData(conn, data));
  conn.on('close', () => { peers.delete(conn.peer); delete users[conn.peer]; updateUserList(); });
  conn.on('error', () => { peers.delete(conn.peer); delete users[conn.peer]; updateUserList(); });
}

// ---------- Data Handlers ----------
function handleData(conn, data) {
  switch (data.type) {
    case 'chat': handleIncomingMsg(data); break;
    case 'join': handlePeerJoin(data); break;
    case 'history': syncHistory(data.history); break;
    case 'peerlist': (data.peers||[]).forEach(p => { if (p!==peer.id && !peers.has(p)) { knownPeers.add(p); pendingPeers.push(p); } }); break;
    case 'reaction': handleReaction(data); break;
  }
}

// ---------- Chat ----------
sendBtn.onclick = sendMsg;
input.addEventListener('keypress', e => { if (e.key==='Enter') sendMsg(); });
function sendMsg() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const id = Date.now()+"-"+Math.random();
  const data = { type:'chat', nickname, text, color:nickColor, time:timestamp(), id };
  addMsg(nickname, text, data.time, nickColor, id);
  broadcast(data);
}

function handleIncomingMsg(msg) {
  if (!chatHistory.find(m => m.id===msg.id)) {
    addMsg(msg.nickname, msg.text, msg.time, msg.color, msg.id);
    broadcast(msg);
  }
}

function broadcast(data, except) {
  peers.forEach(c => { if (c.open && c !== except) try { c.send(data); } catch{} });
}

// ---------- Join / Peers ----------
function broadcastJoin(conn) {
  const data = { type:'join', id:peer.id, nickname, color:nickColor, status };
  if (conn?.open) conn.send(data); else broadcast(data);
  users[peer.id] = { nick:nickname, color:nickColor, status };
  updateUserList();
}

function handlePeerJoin(data) {
  users[data.id] = { nick:data.nickname, color:data.color, status:data.status };
  updateUserList();
}

// ---------- History ----------
function syncHistory(history) {
  if (!Array.isArray(history)) return;
  history.forEach(m => { if (!chatHistory.find(msg=>msg.id===m.id)) addMsg(m.nick, m.text, m.time, m.color, m.id); });
}

// ---------- Reactions ----------
function reactToMsg(id, emoji) {
  const msg = chatHistory.find(m=>m.id===id); if (!msg) return;
  if (!msg.reactions) msg.reactions={};
  if (!msg.reactions[emoji]) msg.reactions[emoji]=[];
  if (!msg.reactions[emoji].includes(nickname)) msg.reactions[emoji].push(nickname);
  renderReactions(id, msg.reactions);
  localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
  broadcast({type:'reaction',id,emoji,user:nickname});
}
function handleReaction(data) {
  const msg = chatHistory.find(m=>m.id===data.id); if(!msg) return;
  if(!msg.reactions) msg.reactions={};
  if(!msg.reactions[data.emoji]) msg.reactions[data.emoji]=[];
  if(!msg.reactions[data.emoji].includes(data.user)) msg.reactions[data.emoji].push(data.user);
  renderReactions(data.id,msg.reactions);
}

// ---------- UI ----------
function addMsg(nick,text,time,color,id,save=true){
  if(messagesEl.querySelector(`.msg[data-id="${id}"]`)) return;
  const div=document.createElement('div'); div.className='msg new'; div.dataset.id=id;
  div.innerHTML=`<div class="meta"><span class="nickname" style="color:${color}">${nick}</span> <span>${time}</span></div>
  <div class="text">${escapeHtml(text)}</div>
  <div class="reactions"></div>
  <div class="reaction-bar"><span class="reactBtn">😊</span><span class="reactBtn">👍</span><span class="reactBtn">❤️</span></div>`;
  messagesEl.appendChild(div); messagesEl.scrollTop=messagesEl.scrollHeight;
  div.querySelectorAll('.reactBtn').forEach(btn=>btn.onclick=()=>reactToMsg(id,btn.textContent));
  setTimeout(()=>div.classList.add('show'),10);
  if(save && !chatHistory.find(m=>m.id===id)) { chatHistory.push({id,nick,text,time,color,reactions:{}}); localStorage.setItem("chatHistory",JSON.stringify(chatHistory)); }
}

function addSystem(text){ const div=document.createElement('div'); div.className='system'; div.textContent=text; messagesEl.appendChild(div); messagesEl.scrollTop=messagesEl.scrollHeight; }

function updateUserList(){ userListEl.innerHTML=""; Object.values(users).forEach(u=>{ const div=document.createElement('div'); div.className='user'; div.style.color=u.color; div.textContent=`${u.nick} • ${u.status}`; userListEl.appendChild(div); }); }

function renderReactions(id,reactions){ const div=messagesEl.querySelector(`.msg[data-id="${id}"] .reactions`); if(!div)return; div.innerHTML=""; Object.entries(reactions).forEach(([emoji,users])=>{ const span=document.createElement('span'); span.textContent=`${emoji} ${users.length}`; span.className="reaction"; div.appendChild(span); }); }

function timestamp(){ return new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function escapeHtml(s=''){ return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function saveKnownPeer(peerId){ let known=JSON.parse(localStorage.getItem("knownPeers")||"[]"); if(!known.includes(peerId)) { known.push(peerId); localStorage.setItem("knownPeers",JSON.stringify(known)); } }

// ---------- Periodic Gossip ----------
setInterval(() => { if(peer && peer.open){ broadcast({type:'peerlist',peers:Array.from(knownPeers).concat([peer.id])}); } },20000);
setInterval(() => { if(peer && peer.open){ broadcast({type:'resync-request',lastId:chatHistory.length?chatHistory[chatHistory.length-1].id:null}); } },15000);
