// script.js — Fully P2P using WebRTC DataChannels + TURN/STUN + verbose debug

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
let myId = "";
const rtcPeers = new Map(); // peerId => { pc, dc }
const peers = new Map(); // for broadcast logic reuse
const knownPeers = new Set();
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
  drawConnectionGraph();
}
function drawConnectionGraph() {
  let graph = `You: ${myId || "?"}\n`;
  rtcPeers.forEach((c, pid) => { graph += ` ↔ ${pid} (${c.dc.readyState})\n`; });
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
  if (!nick) { alert("Please enter a nickname!"); return; }
  if (!room) { alert("Please enter a room name!"); return; }

  nickname = nick;
  roomName = room;
  localStorage.setItem("nickname", nickname);
  localStorage.setItem("roomName", roomName);
  document.getElementById("meName").textContent = nickname;
  document.getElementById("roomLabel").textContent = roomName;

  login.style.display = 'none';
  addSystem(`Joining room ${roomName} as ${nickname}...`);

  await startP2P();
};

// ---------- Settings ----------
settingsBtn.onclick = () => {
  nickInputSettings.value = nickname;
  settingsModal.classList.remove("hidden");
};
closeSettings.onclick = () => settingsModal.classList.add("hidden");

nickInputSettings.onchange = e => { nickname = e.target.value.trim() || nickname; localStorage.setItem("nickname", nickname); broadcastJoin(); document.getElementById("meName").textContent = nickname; };
nickColorInput.oninput = e => { nickColor = e.target.value; localStorage.setItem("nickColor", nickColor); broadcastJoin(); };
statusSelect.onchange = e => { status = e.target.value; localStorage.setItem("status", status); document.getElementById("meStatus").textContent = `(${status})`; broadcastJoin(); };
fontSizeInput.oninput = e => { messagesEl.style.fontSize = e.target.value+"px"; localStorage.setItem("fontSize", e.target.value); };
themeSelect.onchange = e => { document.body.dataset.theme = e.target.value; localStorage.setItem("theme", e.target.value); };
msgStyleSelect.onchange = e => { document.body.dataset.msgstyle = e.target.value; localStorage.setItem("msgStyle", e.target.value); };

// ---------- P2P WebRTC ----------
async function startP2P() {
  myId = `gamegramuser${Date.now()}`;
  addSystem(`Starting WebRTC P2P client as ${myId}`);
  discoverPeers();
  broadcastJoin();
}

// Peer discovery (static for demo)
function discoverPeers() { for (let i=1;i<=3;i++){ const pid=`gamegramuser${i}`; if(pid!==myId) enqueuePeer(pid);} }

function enqueuePeer(peerId) { if(!rtcPeers.has(peerId) && !connectQueue.includes(peerId)){ connectQueue.push(peerId); processQueue(); } }
function processQueue() { if(connecting||connectQueue.length===0) return; connecting=true; const pid=connectQueue.shift(); setTimeout(()=>connectToPeer(pid),1000+Math.random()*5000); }

function connectToPeer(peerId) {
  if(rtcPeers.has(peerId)) return;
  const pc=new RTCPeerConnection({iceServers:[
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'turn:openrelay.metered.ca:443',username:'openrelayproject',credential:'openrelayproject'}
  ]});
  const dc=pc.createDataChannel("chat");
  dc.onopen=()=>setupDC(peerId,pc,dc);
  dc.onmessage=e=>handleIncomingData(peerId,JSON.parse(e.data));
  dc.onclose=()=>handlePeerDisconnect(peerId);

  pc.onicecandidate=e=>{ if(!e.candidate && pc.localDescription) { prompt("Send this SDP to remote peer:",JSON.stringify({id:myId,sdp:pc.localDescription})); } };

  pc.createOffer().then(o=>pc.setLocalDescription(o));
}

function setupDC(peerId,pc,dc){
  rtcPeers.set(peerId,{pc,dc});
  peers.set(peerId,dc);
  knownPeers.add(peerId);
  saveKnownPeer(peerId);

  dc.send(JSON.stringify({type:'join',id:myId,nickname,color:nickColor,status}));
  dc.send(JSON.stringify({type:'history',history:chatHistory}));
  dc.send(JSON.stringify({type:'peerlist',peers:Array.from(knownPeers).concat([myId])}));

  connecting=false;
  processQueue();
}

function handleIncomingData(peerId,data){
  switch(data.type){
    case'chat':handleIncomingMsg(data);break;
    case'join':handlePeerJoin(data);break;
    case'history':syncHistory(data.history);break;
    case'peerlist':(data.peers||[]).forEach(p=>{if(p!==myId&&!rtcPeers.has(p))enqueuePeer(p);});break;
    case'reaction':handleReaction(data);break;
  }
}

function handlePeerDisconnect(peerId){
  peers.delete(peerId);
  rtcPeers.delete(peerId);
  if(users[peerId]) users[peerId].status="offline";
  updateUserList();
  addSystem(`Connection closed: ${peerId}`);
}

// ---------- Chat ----------
sendBtn.onclick=sendMsg;
input.addEventListener('keypress',e=>{if(e.key==='Enter')sendMsg();});
function sendMsg(){
  const text=input.value.trim(); if(!text) return; input.value='';
  const id=Date.now()+"-"+Math.random();
  const data={type:'chat',nickname,text,color:nickColor,time:timestamp(),id};
  addMsg(nickname,text,data.time,nickColor,id);
  safeBroadcast(data);
}
function handleIncomingMsg(msg){
  if(!chatHistory.find(m=>m.id===msg.id)){ addMsg(msg.nickname,msg.text,msg.time,msg.color,msg.id); safeBroadcast(msg); }
}
function safeBroadcast(data){
  if(peers.size>0) broadcast(data); else setTimeout(()=>safeBroadcast(data),15000);
}
function broadcast(data,except){ peers.forEach(c=>{try{if(c.readyState==='open'&&c!==except)c.send(JSON.stringify(data));}catch(e){console.warn("Broadcast failed",e);}}); }

// ---------- Join / Peers ----------
function broadcastJoin(){ const data={type:'join',id:myId,nickname,color:nickColor,status}; peers.forEach(c=>{ if(c.readyState==='open')c.send(JSON.stringify(data)); }); users[myId]={nick:nickname,color:nickColor,status}; updateUserList(); }
function handlePeerJoin(data){ if(!users[data.id]) users[data.id]={nick:data.nickname,color:data.color,status:data.status||"online"}; else{users[data.id].nick=data.nickname; users[data.id].color=data.color; users[data.id].status=data.status||"online";} updateUserList(); addSystem(`Peer joined: ${data.nickname} (${data.id})`); }

// ---------- History ----------
function syncHistory(history){ if(!Array.isArray(history)) return; history.forEach(m=>{ if(!chatHistory.find(msg=>msg.id===m.id)) addMsg(m.nick,m.text,m.time,m.color,m.id); }); }

// ---------- Reactions ----------
function reactToMsg(id,emoji){ const msg=chatHistory.find(m=>m.id===id); if(!msg) return; if(!msg.reactions) msg.reactions={}; if(!msg.reactions[emoji]) msg.reactions[emoji]=[]; if(!msg.reactions[emoji].includes(nickname)) msg.reactions[emoji].push(nickname); renderReactions(id,msg.reactions); localStorage.setItem("chatHistory",JSON.stringify(chatHistory)); safeBroadcast({type:'reaction',id,emoji,user:nickname}); }
function handleReaction(data){ const msg=chatHistory.find(m=>m.id===data.id); if(!msg) return; if(!msg.reactions) msg.reactions={}; if(!msg.reactions[data.emoji]) msg.reactions[data.emoji]=[]; if(!msg.reactions[data.emoji].includes(data.user)) msg.reactions[data.emoji].push(data.user); renderReactions(data.id,msg.reactions); }

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
function addSystem(text){ const div=document.createElement('div'); div.className='system'; div.textContent=text; messagesEl.appendChild(div); messagesEl.scrollTop=messagesEl.scrollHeight; console.log("[SYSTEM]",text);}
function updateUserList(){ userListEl.innerHTML=""; Object.values(users).forEach(u=>{ const div=document.createElement('div'); div.className='user'; div.style.color=u.color; div.textContent=`${u.nick} • ${u.status}`; userListEl.appendChild(div); }); }
function renderReactions(id,reactions){ const div=messagesEl.querySelector(`.msg[data-id="${id}"] .reactions`); if(!div) return; div.innerHTML=""; Object.entries(reactions).forEach(([emoji,users])=>{ const span=document.createElement("span"); span.textContent=`${emoji} ${users.length}`; span.className="reaction"; div.appendChild(span); }); }

function timestamp(){ return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
function escapeHtml(s=''){ return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function saveKnownPeer(peerId){ let known=JSON.parse(localStorage.getItem("knownPeers")||"[]"); if(!known.includes(peerId)){known.push(peerId); localStorage.setItem("knownPeers",JSON.stringify(known));}}

// ---------- Periodic Gossip ----------
setInterval(()=>{ if(peers.size>0){ broadcast({type:'peerlist',peers:Array.from(knownPeers).concat([myId])}); }},20000+Math.random()*5000);
setInterval(()=>{ if(peers.size>0){ broadcast({type:'resync-request',lastId:chatHistory.length?chatHistory[chatHistory.length-1].id:null}); }},15000+Math.random()*3000);
