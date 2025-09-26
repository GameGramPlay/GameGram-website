// script.js — Fully P2P with PeerJS for initial handshake only + TURN/STUN + verbose debug

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
let localPeerId = "", peer;                 // PeerJS Peer instance for handshake
const peers = new Map();                    // peerId => RTCPeerConnection
const knownPeers = new Set();               // discovered peers
let chatHistory = [];
let users = {};
let debugEnabled = true;

// --- Connection queue ---
let connectQueue = [];
let connecting = false;

// ---------------- Helpers ----------------
function logDebug(msg, obj) {
  if (!debugEnabled) return;
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  debugPanel.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
  if (obj) console.debug("[Debug]", msg, obj);
}

function drawConnectionGraph() {
  let graph = `You: ${localPeerId || "?"}\n`;
  peers.forEach((pc, pid) => { graph += ` ↔ ${pid} (${pc.connectionState || "unknown"})\n`; });
  const line = document.createElement("pre");
  line.textContent = graph;
  line.className = "mt-2 border-t border-gray-700 pt-2 text-gray-400";
  debugPanel.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
}

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
loginBtn.onclick = async () => {
  const nick = nickInput.value.trim();
  const room = roomInput.value.trim();

  if (!nick || !room) {
    alert("Please enter a nickname and room name!");
    return;
  }

  nickname = nick;
  roomName = room;
  localStorage.setItem("nickname", nickname);
  localStorage.setItem("roomName", roomName);

  document.getElementById("meName").textContent = nickname;
  document.getElementById("roomLabel").textContent = roomName;

  login.style.display = 'none';
  addSystem(`Joining room ${roomName} as ${nickname}...`);
  
  // Assign local sequential ID
  localPeerId = localStorage.getItem("localPeerId") || `gamegramuser${Date.now()}`;
  localStorage.setItem("localPeerId", localPeerId);
  
  addSystem("Starting WebRTC P2P client...");
  
  await initPeerHandshake();
};

// ---------- Settings ----------
settingsBtn.onclick = () => { nickInputSettings.value = nickname; settingsModal.classList.remove("hidden"); };
closeSettings.onclick = () => settingsModal.classList.add("hidden");

nickInputSettings.onchange = e => { nickname = e.target.value.trim() || nickname; localStorage.setItem("nickname", nickname); broadcastJoin(); document.getElementById("meName").textContent = nickname; };
nickColorInput.oninput = e => { nickColor = e.target.value; localStorage.setItem("nickColor", nickColor); broadcastJoin(); };
statusSelect.onchange = e => { status = e.target.value; localStorage.setItem("status", status); document.getElementById("meStatus").textContent = `(${status})`; broadcastJoin(); };
fontSizeInput.oninput = e => { messagesEl.style.fontSize = e.target.value + "px"; localStorage.setItem("fontSize", e.target.value); };
themeSelect.onchange = e => { document.body.dataset.theme = e.target.value; localStorage.setItem("theme", e.target.value); };
msgStyleSelect.onchange = e => { document.body.dataset.msgstyle = e.target.value; localStorage.setItem("msgStyle", e.target.value); };

// ------------------- WebRTC P2P -------------------
const peerConnections = {}; // peerId => RTCPeerConnection
const dataChannels = {};   // peerId => RTCDataChannel

async function initPeerHandshake() {
  addSystem("Connecting to signaling PeerJS server for initial handshake...");

  peer = new Peer(localPeerId, { host: '0.peerjs.com', port: 443, path: '/', secure: true });

  peer.on('open', async id => {
    logDebug(`Connected to signaling server as ${id}`);

    // Discover known peers
    let known = JSON.parse(localStorage.getItem("knownPeers")||"[]");
    for (let i=1;i<=3;i++) { // connect sequentially
      const targetId = `gamegramuser${i}`;
      if (targetId !== localPeerId && !known.includes(targetId)) {
        await createOffer(targetId);
      }
    }

    peer.destroy();
    addSystem("Initial handshake done. Now fully P2P chat.");
  });

  peer.on('connection', conn => {
    conn.on('data', async data => {
      if (data.type === "offer") {
        await acceptOffer(conn.peer, data.offer);
      } else if (data.type === "answer") {
        await finalizeAnswer(conn.peer, data.answer);
      }
    });
  });

  peer.on('error', err => { addSystem("PeerJS error: "+err); });
}

// ---------------- Offer/Answer ----------------
async function createOffer(targetId) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const dc = pc.createDataChannel("chat");
  
  setupDataChannel(targetId, dc);
  
  pc.onicecandidate = e => {
    if (e.candidate === null) { // ICE gathering done
      const offerStr = JSON.stringify(pc.localDescription);
      const conn = peer.connect(targetId);
      conn.on('open', ()=> conn.send({ type: "offer", offer: offerStr }));
    }
  };
  
  peerConnections[targetId] = pc;
  dataChannels[targetId] = dc;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
}

async function acceptOffer(peerId, offerStr) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  peerConnections[peerId] = pc;

  pc.ondatachannel = e => { setupDataChannel(peerId, e.channel); };

  await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerStr)));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  const conn = peer.connect(peerId);
  conn.on('open', ()=> conn.send({ type: "answer", answer: JSON.stringify(pc.localDescription) }));
}

async function finalizeAnswer(peerId, answerStr) {
  const pc = peerConnections[peerId];
  await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerStr)));
}

function setupDataChannel(peerId, dc) {
  dataChannels[peerId] = dc;
  dc.onopen = () => {
    addSystem(`Connected P2P with ${peerId}`);
    knownPeers.add(peerId);
    localStorage.setItem("knownPeers", JSON.stringify(Array.from(knownPeers)));
    users[peerId] = { nick: peerId, color:"#ccc", status:"online" };
    updateUserList();
    broadcastJoin();
  };
  dc.onmessage = e => handleIncomingMsg(JSON.parse(e.data));
  dc.onclose = () => { users[peerId].status="offline"; updateUserList(); addSystem(`Disconnected from ${peerId}`); };
}

// ---------- Chat ----------
sendBtn.onclick = sendMsg;
input.addEventListener('keypress', e => { if(e.key==='Enter') sendMsg(); });

function sendMsg() {
  const text = input.value.trim(); if(!text) return; input.value='';
  const id = Date.now()+"-"+Math.random();
  const data = { type:'chat', nickname, text, color:nickColor, time: timestamp(), id };
  addMsg(nickname,text,data.time,nickColor,id);
  broadcast(data);
}

function handleIncomingMsg(msg) {
  if(!chatHistory.find(m=>m.id===msg.id)){
    addMsg(msg.nickname,msg.text,msg.time,msg.color,msg.id);
  }
}

function broadcast(data) {
  Object.values(dataChannels).forEach(dc=>{ if(dc.readyState==="open") dc.send(JSON.stringify(data)); });
}

// ---------- Join ----------
function broadcastJoin() {
  const data = { type:'join', id: localPeerId, nickname, color: nickColor, status };
  Object.values(dataChannels).forEach(dc=>{ if(dc.readyState==="open") dc.send(JSON.stringify(data)); });
  users[localPeerId] = { nick: nickname, color:nickColor, status };
  updateUserList();
}

// ---------- UI ----------
function addMsg(nick,text,time,color,id,save=true){
  if(messagesEl.querySelector(`.msg[data-id="${id}"]`)) return;
  const div=document.createElement('div'); div.className='msg new'; div.dataset.id=id;
  div.innerHTML=`<div class="meta"><span class="nickname" style="color:${color}">${nick}</span> <span>${time}</span></div><div class="text">${escapeHtml(text)}</div><div class="reactions"></div><div class="reaction-bar"><span class="reactBtn">😊</span><span class="reactBtn">👍</span><span class="reactBtn">❤️</span></div>`;
  messagesEl.appendChild(div); messagesEl.scrollTop=messagesEl.scrollHeight;
  div.querySelectorAll('.reactBtn').forEach(btn=>btn.onclick=()=>reactToMsg(id,btn.textContent));
  setTimeout(()=>div.classList.add('show'),10);
  if(save&&!chatHistory.find(m=>m.id===id)){ chatHistory.push({id,nick,text,time,color,reactions:{}}); localStorage.setItem("chatHistory",JSON.stringify(chatHistory)); }
}

function addSystem(text){ const div=document.createElement('div'); div.className='system'; div.textContent=text; messagesEl.appendChild(div); messagesEl.scrollTop=messagesEl.scrollHeight; console.log("[SYSTEM]",text); }
function updateUserList(){ userListEl.innerHTML=""; Object.values(users).forEach(u=>{ const div=document.createElement('div'); div.className='user'; div.style.color=u.color; div.textContent=`${u.nick} • ${u.status}`; userListEl.appendChild(div); }); }
function renderReactions(id,reactions){ const div=messagesEl.querySelector(`.msg[data-id="${id}"] .reactions`); if(!div) return; div.innerHTML=""; Object.entries(reactions).forEach(([emoji,users])=>{ const span=document.createElement("span"); span.textContent=`${emoji} ${users.length}`; span.className="reaction"; div.appendChild(span); }); }
function timestamp(){ return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
function escapeHtml(s=''){ return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
