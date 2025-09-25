// script.js — Fully P2P PeerJS Chat (optimized)

// ------------------ DOM Elements ------------------
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

// ------------------ Variables ------------------
let nickname = "", nickColor = "#ffffff", status = "online";
let peer;                               // PeerJS Peer instance
const peers = new Map();                // peerId => DataConnection
const knownPeers = new Set();           // discovered peers
let chatHistory = [];
let users = {};
let debugEnabled = true;

// Connection queue for throttling
let connectQueue = [];
let connecting = false;

let roomName = "public";

// ------------------ Helpers ------------------
function logDebug(msg, obj) {
  if (!debugEnabled) return;
  if (typeof msg === "string" && msg.startsWith("Connecting to peer")) return;
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  debugPanel.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
  if (obj) console.debug("[Debug]", msg, obj);
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

function escapeHtml(s='') {
  return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
}

function saveKnownPeer(peerId) {
  let known = JSON.parse(localStorage.getItem("knownPeers")||"[]");
  if(!known.includes(peerId)) { known.push(peerId); localStorage.setItem("knownPeers", JSON.stringify(known)); }
}

// ------------------ UI ------------------
function addMsg(nick, text, time, color, id, save = true) {
  if (messagesEl.querySelector(`.msg[data-id="${id}"]`)) return;
  const div = document.createElement('div');
  div.className = 'msg new'; div.dataset.id = id;
  div.innerHTML = `
    <div class="meta"><span class="nickname" style="color:${color}">${nick}</span> <span>${time}</span></div>
    <div class="text">${escapeHtml(text)}</div>
    <div class="reactions"></div>
    <div class="reaction-bar"><span class="reactBtn">😊</span><span class="reactBtn">👍</span><span class="reactBtn">❤️</span></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  div.querySelectorAll('.reactBtn').forEach(btn => btn.onclick = () => reactToMsg(id, btn.textContent));
  setTimeout(()=>div.classList.add('show'), 10);
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

// ------------------ PeerJS ------------------
const PEERJS_HOSTS = ['0.peerjs.com','1.peerjs.com','2.peerjs.com','3.peerjs.com'];
const PEER_OPEN_TIMEOUT = 2500;

// Generate sequential global ID
function makePeerId() {
  let counter = parseInt(localStorage.getItem("peerCounter") || "1");
  localStorage.setItem("peerCounter", counter + 1);
  return `gamegramuser${counter}`;
}

// ------------------ Peer connection ------------------
function startPeerWithFallbacks() {
  addSystem("Starting PeerJS client...");
  tryPeerHostsSequentially(PEERJS_HOSTS.slice(), 0);
}

function tryPeerHostsSequentially(hosts, index) {
  if (index >= hosts.length) { addSystem("All public PeerJS endpoints failed."); return; }
  const host = hosts[index];
  startPeerWithOptions({
    host, port: 443, path: '/', secure: true,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:443', username:'openrelayproject', credential:'openrelayproject' }
      ]
    }
  }, (err)=>{
    if (err) setTimeout(()=> tryPeerHostsSequentially(hosts, index+1), 500);
  });
  setTimeout(()=>{ if(!peer?.id) tryPeerHostsSequentially(hosts, index+1); }, PEER_OPEN_TIMEOUT);
}

function startPeerWithOptions(opts, callback) {
  try { if(peer && !peer.destroyed) peer.destroy(); } catch{}
  peer = new Peer(makePeerId(), opts);

  peer.on('open', id=>{
    addSystem(`Connected as ${nickname} (${id}) in room [${roomName}]`);
    const known = JSON.parse(localStorage.getItem("knownPeers")||"[]");
    known.forEach(pid=> enqueuePeer(pid));
    broadcastJoin();
    peer.on('connection', setupConn);
    if(callback) callback(null);
  });

  peer.on('error', err => { if(callback) callback(err); });
}

// ------------------ Connections queue ------------------
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
  const delay = 1000 + Math.random()*4000; // 1-5 seconds randomized
  setTimeout(() => {
    const conn = peer.connect(peerId, { reliable:true });
    setupConn(conn);
    connecting = false;
    processQueue();
  }, delay);
}

function setupConn(conn) {
  conn.on('open', ()=>{
    peers.set(conn.peer, conn);
    knownPeers.add(conn.peer);
    saveKnownPeer(conn.peer);
    conn.send({ type:'join', id:peer.id, nickname, color:nickColor, status });
    conn.send({ type:'history', history:chatHistory });
    conn.send({ type:'peerlist', peers:Array.from(knownPeers).concat([peer.id]) });
  });
  conn.on('data', handleData);
  conn.on('close', ()=>{ peers.delete(conn.peer); delete users[conn.peer]; updateUserList(); });
  conn.on('error', ()=>{ peers.delete(conn.peer); delete users[conn.peer]; updateUserList(); });
}

function handleData(data){
  switch(data.type){
    case 'chat': handleIncomingMsg(data); break;
    case 'join': handlePeerJoin(data); break;
    case 'history': syncHistory(data.history); break;
    case 'peerlist': (data.peers||[]).forEach(p=>enqueuePeer(p)); break;
    case 'reaction': handleReaction(data); break;
    case 'resync-request': handleResyncRequest(data); break;
  }
}

// ------------------ Chat ------------------
sendBtn.onclick = sendMsg;
input.addEventListener('keypress', e => { if(e.key==='Enter') sendMsg(); });

function sendMsg(){
  const text = input.value.trim();
  if(!text) return;
  input.value='';
  const id = Date.now()+"-"+Math.random();
  const data = {type:'chat', nickname, text, color:nickColor, time:timestamp(), id};
  addMsg(nickname, text, data.time, nickColor, id);
  broadcast(data);
}

function handleIncomingMsg(msg){
  if(!chatHistory.find(m=>m.id===msg.id)){
    addMsg(msg.nickname,msg.text,msg.time,msg.color,msg.id);
    broadcast(msg);
  }
}

function broadcast(data, except){
  peers.forEach(c=>{
    try{ if(c.open && c!==except) c.send(data); } catch{}
  });
}

// ------------------ Join / Peers ------------------
function broadcastJoin(conn){
  const data={type:'join',id:peer.id,nickname,color:nickColor,status};
  if(conn?.open) conn.send(data); else broadcast(data);
  users[peer.id]={nick:nickname,color:nickColor,status};
  updateUserList();
  // Retry broadcast after short random delay
  setTimeout(()=>broadcast(data),2000+Math.random()*3000);
}

function handlePeerJoin(data){
  users[data.id]={nick:data.nickname,color:data.color,status:data.status};
  updateUserList();
}

// ------------------ History ------------------
function syncHistory(history){
  if(!Array.isArray(history)) return;
  history.forEach(m=>{ if(!chatHistory.find(msg=>msg.id===m.id)) addMsg(m.nick,m.text,m.time,m.color,m.id); });
}

// ------------------ Reactions ------------------
function reactToMsg(id, emoji){
  const msg = chatHistory.find(m=>m.id===id);
  if(!msg) return;
  if(!msg.reactions) msg.reactions={};
  if(!msg.reactions[emoji]) msg.reactions[emoji]=[];
  if(!msg.reactions[emoji].includes(nickname)) msg.reactions[emoji].push(nickname);
  renderReactions(id,msg.reactions);
  localStorage.setItem("chatHistory",JSON.stringify(chatHistory));
  broadcast({type:'reaction',id,emoji,user:nickname});
}

function handleReaction(data){
  const msg = chatHistory.find(m=>m.id===data.id);
  if(!msg) return;
  if(!msg.reactions) msg.reactions={};
  if(!msg.reactions[data.emoji]) msg.reactions[data.emoji]=[];
  if(!msg.reactions[data.emoji].includes(data.user)) msg.reactions[data.emoji].push(data.user);
  renderReactions(data.id,msg.reactions);
}

// ------------------ Peer discovery ------------------
function discoverPeers(){
  for(let i=1;i<=50;i++){ enqueuePeer(`gamegramuser${i}`); }
}

setInterval(()=>{ if(peer && peer.open) discoverPeers(); },20000);

// ------------------ Login & Settings ------------------
window.onload = ()=>{
  nickname=localStorage.getItem("nickname")||"";
  nickColor=localStorage.getItem("nickColor")||"#ffffff";
  status=localStorage.getItem("status")||"online";
  roomName=localStorage.getItem("roomName")||"public";
  document.getElementById("meName").textContent=nickname||"Guest";
  document.getElementById("meStatus").textContent=`(${status})`;
  document.getElementById("roomLabel").textContent=roomName;
  nickColorInput.value=nickColor;
  statusSelect.value=status;
  roomInput.value=roomName;
  const storedHistory=JSON.parse(localStorage.getItem("chatHistory")||"[]");
  storedHistory.forEach(m=>addMsg(m.nick,m.text,m.time,m.color,m.id,false));
  chatHistory=storedHistory;
  storedHistory.forEach(m=>renderReactions(m.id,m.reactions||{}));
  addSystem("UI ready. Please log in.");
};

loginBtn.onclick=()=>{
  nickname=nickInput.value.trim()||"Guest"+Math.floor(Math.random()*1000);
  roomName=roomInput.value.trim()||"public";
  localStorage.setItem("nickname",nickname);
  localStorage.setItem("roomName",roomName);
  document.getElementById("meName").textContent=nickname;
  document.getElementById("roomLabel").textContent=roomName;
  login.style.display='none';
  startPeerWithFallbacks();
};

settingsBtn.onclick=()=>{ nickInputSettings.value=nickname; settingsModal.classList.remove("hidden"); };
closeSettings.onclick=()=>settingsModal.classList.add("hidden");
nickInputSettings.onchange=e=>{ nickname=e.target.value.trim()||nickname; localStorage.setItem("nickname", nickname); document.getElementById("meName").textContent = nickname; broadcastJoin(); };
nickColorInput.oninput = e => { nickColor = e.target.value; localStorage.setItem("nickColor", nickColor); broadcastJoin(); };
statusSelect.onchange = e => { status = e.target.value; localStorage.setItem("status", status); document.getElementById("meStatus").textContent = `(${status})`; broadcastJoin(); };
fontSizeInput.oninput = e => { messagesEl.style.fontSize = e.target.value + "px"; localStorage.setItem("fontSize", e.target.value); };
themeSelect.onchange = e => { document.body.dataset.theme = e.target.value; localStorage.setItem("theme", e.target.value); };
msgStyleSelect.onchange = e => { document.body.dataset.msgstyle = e.target.value; localStorage.setItem("msgStyle", e.target.value); };

// ------------------ Periodic Gossip ------------------
setInterval(() => {
  if (peer && peer.open) {
    setTimeout(() => {
      broadcast({ type: 'peerlist', peers: Array.from(knownPeers).concat([peer.id]) });
    }, Math.random()*2000);
  }
}, 20000);

setInterval(() => {
  if (peer && peer.open) {
    setTimeout(() => {
      broadcast({ type: 'resync-request', lastId: chatHistory.length ? chatHistory[chatHistory.length - 1].id : null });
    }, Math.random()*1500);
  }
}, 15000);

// ------------------ Resync handler ------------------
function handleResyncRequest(data) {
  if (!data.lastId) return;
  const index = chatHistory.findIndex(m => m.id === data.lastId);
  const missing = index >= 0 ? chatHistory.slice(index + 1) : chatHistory;
  if (missing.length && peers.has(data.sender)) {
    peers.get(data.sender).send({ type: 'history', history: missing });
  }
}
