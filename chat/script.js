// script.js — Fully P2P chat, sequential IDs, initial PeerJS handshake only + TURN/STUN + verbose debug

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

// Debug panel
const debugPanel = document.createElement("div");
debugPanel.id = "debugPanel";
debugPanel.className = "hidden p-2 border-t mt-2 text-xs font-mono bg-black text-green-400 max-h-64 overflow-y-auto";
settingsModal.appendChild(debugPanel);

let nickname = "", nickColor = "#ffffff", status = "online";
let peer; // PeerJS peer
const peers = new Map(); // peerId => DataConnection
const knownPeers = new Set(); // discovered peers
let chatHistory = [];
let users = {};
let debugEnabled = true;

// Connection queue
let connectQueue = [];
let connecting = false;

// Session peer counter (sequential IDs)
let globalPeerCounter = 0;

// ---------------- Helpers ----------------
function logDebug(msg, obj) {
  if (!debugEnabled) return;
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  debugPanel.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
  if (obj) console.debug("[Debug]", msg, obj);
  drawConnectionGraph();
}

function drawConnectionGraph() {
  let graph = `You: ${peer?.id || "?"}\n`;
  peers.forEach((c, pid) => { graph += ` ↔ ${pid} (${c.open ? "open" : "closed"})\n`; });
  const line = document.createElement("pre");
  line.textContent = graph;
  line.className = "mt-2 border-t border-gray-700 pt-2 text-gray-400";
  debugPanel.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
}

// ----------------- LocalStorage & UI Init -----------------
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

// ----------------- Login -----------------
loginBtn.onclick = async () => {
  const nick = nickInput.value.trim();
  const room = roomInput.value.trim();
  if (!nick || !room) { alert("Please enter a nickname and room!"); return; }

  nickname = nick;
  roomName = room;
  localStorage.setItem("nickname", nickname);
  localStorage.setItem("roomName", roomName);

  document.getElementById("meName").textContent = nickname;
  document.getElementById("roomLabel").textContent = roomName;
  login.style.display = 'none';
  addSystem(`Joining room ${roomName} as ${nickname}...`);

  try {
    await startPeerWithFallbacks();
  } catch (err) {
    addSystem("Failed to join: " + err);
    login.style.display = 'block';
  }
};

// ----------------- Settings -----------------
settingsBtn.onclick = () => { nickInputSettings.value = nickname; settingsModal.classList.remove("hidden"); };
closeSettings.onclick = () => settingsModal.classList.add("hidden");

nickInputSettings.onchange = e => { nickname = e.target.value.trim() || nickname; localStorage.setItem("nickname", nickname); broadcastJoin(); updateUIName(); };
nickColorInput.oninput = e => { nickColor = e.target.value; localStorage.setItem("nickColor", nickColor); broadcastJoin(); };
statusSelect.onchange = e => { status = e.target.value; localStorage.setItem("status", status); broadcastJoin(); updateUIStatus(); };
fontSizeInput.oninput = e => { messagesEl.style.fontSize = e.target.value + "px"; localStorage.setItem("fontSize", e.target.value); };
themeSelect.onchange = e => { document.body.dataset.theme = e.target.value; localStorage.setItem("theme", e.target.value); };
msgStyleSelect.onchange = e => { document.body.dataset.msgstyle = e.target.value; localStorage.setItem("msgStyle", e.target.value); };

function updateUIName() { document.getElementById("meName").textContent = nickname; }
function updateUIStatus() { document.getElementById("meStatus").textContent = `(${status})`; }

// ----------------- PeerJS & Sequential IDs -----------------
const PEERJS_HOSTS = ['0.peerjs.com'];
const PEER_OPEN_TIMEOUT = 20000;

async function generateSequentialPeerId() {
  let newId;
  let attempts = 0;
  while (true) {
    globalPeerCounter++;
    newId = `gamegramuser${globalPeerCounter}`;
    attempts++;
    if (!Array.from(knownPeers).includes(newId) || attempts > 10) break;
  }
  return newId;
}

function startPeerWithFallbacks() {
  addSystem("Starting PeerJS handshake...");
  tryPeerHostsSequentially(PEERJS_HOSTS.slice(), 0);
}

function tryPeerHostsSequentially(hosts, index) {
  if (index >= hosts.length) { addSystem("All PeerJS hosts failed"); return; }
  const host = hosts[index];
  addSystem(`Attempting PeerJS host: ${host}`);
  startPeerWithOptions({
    host, port: 443, path: '/', secure: true,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:443', username:'openrelayproject', credential:'openrelayproject' }
      ]
    }
  }, (err) => {
    if (err) { cleanupPeer(); setTimeout(() => tryPeerHostsSequentially(hosts, index+1), 500); }
  });
  setTimeout(() => { if (!peer?.id) { cleanupPeer(); tryPeerHostsSequentially(hosts, index+1); }}, PEER_OPEN_TIMEOUT);
}

async function startPeerWithOptions(opts, callback) {
  try { if (peer && !peer.destroyed) peer.destroy(); } catch {}
  const id = await generateSequentialPeerId();
  peer = new Peer(id, opts);

  peer.on('open', id => {
    addSystem(`Handshake done. PeerJS ID: ${id}`);
    discoverPeers(); // Discover other peers sequentially
    broadcastJoin(); // Notify join
    peer.on('connection', conn => setupConn(conn));
    if (callback) callback(null);
  });

  peer.on('error', err => { if (callback) callback(err); });
}

function cleanupPeer() { try { if (peer && !peer.destroyed) peer.destroy(); } catch {} peer = null; }

// ----------------- Peer Discovery & Queue -----------------
function discoverPeers() {
  for (let i = 1; i <= 10; i++) {
    const targetId = `gamegramuser${i}`;
    enqueuePeer(targetId);
  }
}

function enqueuePeer(peerId) {
  if (!peers.has(peerId) && peerId !== peer.id && !connectQueue.includes(peerId)) {
    connectQueue.push(peerId);
    processQueue();
  }
}

function processQueue() {
  if (connecting || connectQueue.length === 0) return;
  connecting = true;
  const peerId = connectQueue.shift();
  const delay = 1000 + Math.random()*4000;
  setTimeout(() => {
    const conn = peer.connect(peerId, { reliable:true });
    setupConn(conn);
    conn.on('open', () => { connecting = false; processQueue(); });
    conn.on('error', () => { connecting=false; setTimeout(()=>enqueuePeer(peerId),15000); processQueue(); });
    conn.on('close', () => { connecting=false; processQueue(); });
  }, delay);
}

// ----------------- Connections -----------------
function setupConn(conn) {
  conn.on('open', () => {
    peers.set(conn.peer, conn);
    knownPeers.add(conn.peer);
    saveKnownPeer(conn.peer);

    if (!users[conn.peer]) users[conn.peer] = { nick: conn.peer, color: "#ccc", status:"online" };
    else users[conn.peer].status = "online";
    updateUserList();

    // Send join, history, peers
    conn.send({ type:'join', id:peer.id, nickname, color:nickColor, status });
    conn.send({ type:'history', history:chatHistory });
    conn.send({ type:'peerlist', peers:Array.from(knownPeers).concat([peer.id]) });
  });

  conn.on('data', data => {
    logDebug(`Data from ${conn.peer}`, data);
    switch(data.type){
      case 'chat': handleIncomingMsg(data); break;
      case 'join': handlePeerJoin(data); break;
      case 'history': syncHistory(data.history); break;
      case 'peerlist': (data.peers||[]).forEach(p=>{if(p!==peer.id&&!peers.has(p)) enqueuePeer(p);}); break;
      case 'reaction': handleReaction(data); break;
    }
  });

  conn.on('close', () => { peers.delete(conn.peer); if(users[conn.peer]) users[conn.peer].status="offline"; updateUserList(); addSystem(`Connection closed: ${conn.peer}`); });
  conn.on('error', err => { peers.delete(conn.peer); if(users[conn.peer]) users[conn.peer].status="offline"; updateUserList(); addSystem(`Connection error with ${conn.peer}: ${err}`); });
}

// ----------------- Chat -----------------
sendBtn.onclick = sendMsg;
input.addEventListener('keypress', e => { if(e.key==='Enter') sendMsg(); });

function sendMsg() {
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  const id = Date.now()+"-"+Math.random();
  const data = { type:'chat', nickname, text, color:nickColor, time:timestamp(), id };
  addMsg(nickname,text,data.time,nickColor,id);
  safeBroadcast(data);
}

function handleIncomingMsg(msg) {
  if(!chatHistory.find(m=>m.id===msg.id)) { addMsg(msg.nickname,msg.text,msg.time,msg.color,msg.id); safeBroadcast(msg); }
}

function safeBroadcast(data) {
  if(peers.size>0) broadcast(data);
  else setTimeout(()=>safeBroadcast(data),15000);
}

function broadcast(data, except) { peers.forEach(c=>{try{if(c.open && c!==except) c.send(data);}catch(e){console.warn("Broadcast failed", c.peer,e);}}); }

// ----------------- Join / Peers -----------------
function broadcastJoin(conn) {
  const data = { type:'join', id:peer.id, nickname, color:nickColor, status };
  if(conn?.open) conn.send(data); else safeBroadcast(data);
  users[peer.id] = { nick:nickname, color:nickColor, status };
  updateUserList();
}

function handlePeerJoin(data) {
  if(!users[data.id]) users[data.id]={nick:data.nickname,color:data.color,status:data.status||"online"};
  else { users[data.id].nick=data.nickname; users[data.id].color=data.color; users[data.id].status=data.status||"online"; }
  updateUserList();
  addSystem(`Peer joined: ${data.nickname} (${data.id})`);
}

// ----------------- History -----------------
function syncHistory(history) { if(!Array.isArray(history)) return; history.forEach(m=>{if(!chatHistory.find(msg=>msg.id===m.id)) addMsg(m.nick,m.text,m.time,m.color,m.id);}); }

// ----------------- Reactions -----------------
function reactToMsg(id,emoji) {
  const msg = chatHistory.find(m=>m.id===id);
  if(!msg) return;
  msg.reactions = msg.reactions||{};
  msg.reactions[emoji] = msg.reactions[emoji]||[];
  if(!msg.reactions[emoji].includes(nickname)) msg.reactions[emoji].push(nickname);
  renderReactions(id,msg.reactions);
  localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
  safeBroadcast({type:'reaction',id,emoji,user:nickname});
}

function handleReaction(data) {
  const msg = chatHistory.find(m=>m.id===data.id);
  if(!msg) return;
  msg.reactions = msg.reactions||{};
  msg.reactions[data.emoji] = msg.reactions[data.emoji]||[];
  if(!msg.reactions[data.emoji].includes(data.user)) msg.reactions[data.emoji].push(data.user);
  renderReactions(data.id,msg.reactions);
}

// ----------------- UI -----------------
function addMsg(nick,text,time,color,id,save=true){
  if(messagesEl.querySelector(`.msg[data-id="${id}"]`)) return;
  const div = document.createElement('div');
  div.className='msg new';
  div.dataset.id=id;
  div.innerHTML = `<div class="meta"><span class="nickname" style="color:${color}">${nick}</span> <span>${time}</span></div><div class="text">${escapeHtml(text)}</div><div class="reactions"></div><div class="reaction-bar"><span class="reactBtn">😊</span><span class="reactBtn">👍</span><span class="reactBtn">❤️</span></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop=messagesEl.scrollHeight;
  div.querySelectorAll('.reactBtn').forEach(btn=>btn.onclick=()=>reactToMsg(id,btn.textContent));
  setTimeout(()=>div.classList.add('show'),10);
  if(save && !chatHistory.find(m=>m.id===id)){
    chatHistory.push({id,nick,text,time,color,reactions:{}});
    localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
  }
}

function addSystem(text){ const div=document.createElement('div'); div.className='system'; div.textContent=text; messagesEl.appendChild(div); messagesEl.scrollTop=messagesEl.scrollHeight; console.log("[SYSTEM]", text);}
function updateUserList(){ userListEl.innerHTML=""; Object.values(users).forEach(u=>{ const div=document.createElement('div'); div.className='user'; div.style.color=u.color; div.textContent=`${u.nick} • ${u.status}`; userListEl.appendChild(div); }); }
function renderReactions(id,reactions){ const div=messagesEl.querySelector(`.msg[data-id="${id}"] .reactions`); if(!div)return; div.innerHTML=""; Object.entries(reactions).forEach(([emoji,users])=>{ const span=document.createElement("span"); span.textContent=`${emoji} ${users.length}`; span.className="reaction"; div.appendChild(span); }); }
function timestamp(){ return new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}
function escapeHtml(s=''){ return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function saveKnownPeer(peerId){ let known=JSON.parse(localStorage.getItem("knownPeers")||"[]"); if(!known.includes(peerId)){ known.push(peerId); localStorage.setItem("knownPeers", JSON.stringify(known)); }}

// ----------------- Periodic Gossip -----------------
setInterval(()=>{ if(peer && peer.open && peers.size>0){ broadcast({type:'peerlist',peers:Array.from(knownPeers).concat([peer.id])}); }}, 20000 + Math.random()*5000);
setInterval(()=>{ if(peer && peer.open && peers.size>0){ broadcast({type:'resync-request',lastId:chatHistory.length?chatHistory[chatHistory.length-1].id:null}); }},15000 + Math.random()*3000);
