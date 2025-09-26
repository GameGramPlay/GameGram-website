// script.js — Fully P2P with PeerJS handshake only + TURN/STUN + verbose debug

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
let localPeerId = "", peer;
let peers = {};           // peerId -> RTCPeerConnection
let dataChannels = {};    // peerId -> RTCDataChannel
let knownPeers = new Set(JSON.parse(localStorage.getItem("knownPeers")||"[]"));
let chatHistory = JSON.parse(localStorage.getItem("chatHistory")||"[]");
let users = {};
let debugEnabled = true;
let roomName = "public";

// Connection queue
let connectQueue = [];
let connecting = false;

// ---------------- Helpers ----------------
function logDebug(msg,obj){ if(!debugEnabled) return; const line=document.createElement("div"); line.textContent=`[${new Date().toLocaleTimeString()}] ${msg}`; debugPanel.appendChild(line); debugPanel.scrollTop=debugPanel.scrollHeight; if(obj) console.debug("[Debug]",msg,obj);}
function drawConnectionGraph(){ let graph=`You: ${localPeerId||"?"}\n`; Object.entries(peers).forEach(([pid,pc])=>{ graph+=` ↔ ${pid} (${pc.connectionState||"unknown"})\n`; }); const line=document.createElement("pre"); line.textContent=graph; line.className="mt-2 border-t border-gray-700 pt-2 text-gray-400"; debugPanel.appendChild(line); debugPanel.scrollTop=debugPanel.scrollHeight;}

// ---------- LocalStorage & UI init ----------
window.onload=()=>{
  nickname = localStorage.getItem("nickname")||"";
  nickColor = localStorage.getItem("nickColor")||"#ffffff";
  status = localStorage.getItem("status")||"online";
  roomName = localStorage.getItem("roomName")||"public";

  document.getElementById("meName").textContent=nickname||"Guest";
  document.getElementById("meStatus").textContent=`(${status})`;
  document.getElementById("roomLabel").textContent=roomName;

  nickColorInput.value=nickColor;
  statusSelect.value=status;
  roomInput.value=roomName;

  const theme=localStorage.getItem("theme")||"dark"; document.body.dataset.theme=theme; themeSelect.value=theme;
  const msgStyle=localStorage.getItem("msgStyle")||"cozy"; document.body.dataset.msgstyle=msgStyle; msgStyleSelect.value=msgStyle;
  const fontSize=localStorage.getItem("fontSize")||"14"; fontSizeInput.value=fontSize; messagesEl.style.fontSize=fontSize+"px";

  chatHistory.forEach(m=>addMsg(m.nick,m.text,m.time,m.color,m.id,false));
  chatHistory.forEach(m=>renderReactions(m.id,m.reactions||{}));

  addSystem("UI ready. Please log in.");
};

// ---------- Login ----------
loginBtn.onclick=async()=>{
  const nick=nickInput.value.trim();
  const room=roomInput.value.trim();
  if(!nick||!room){ alert("Enter nickname and room!"); return; }

  nickname=nick; roomName=room;
  localStorage.setItem("nickname",nickname); localStorage.setItem("roomName",roomName);
  document.getElementById("meName").textContent=nickname;
  document.getElementById("roomLabel").textContent=roomName;

  login.style.display='none';
  addSystem(`Joining room ${roomName} as ${nickname}...`);

  // Generate unique sequential localPeerId avoiding collisions
  localPeerId = await generateUniquePeerId();
  localStorage.setItem("localPeerId",localPeerId);

  addSystem("Starting WebRTC P2P client...");
  await initPeerHandshake();
};

// ---------- Settings ----------
settingsBtn.onclick=()=>{ nickInputSettings.value=nickname; settingsModal.classList.remove("hidden"); };
closeSettings.onclick=()=>settingsModal.classList.add("hidden");
nickInputSettings.onchange=e=>{ nickname=e.target.value.trim()||nickname; localStorage.setItem("nickname",nickname); broadcastJoin(); document.getElementById("meName").textContent=nickname; };
nickColorInput.oninput=e=>{ nickColor=e.target.value; localStorage.setItem("nickColor",nickColor); broadcastJoin(); };
statusSelect.onchange=e=>{ status=e.target.value; localStorage.setItem("status",status); document.getElementById("meStatus").textContent=`(${status})`; broadcastJoin(); };
fontSizeInput.oninput=e=>{ messagesEl.style.fontSize=e.target.value+"px"; localStorage.setItem("fontSize",e.target.value); };
themeSelect.onchange=e=>{ document.body.dataset.theme=e.target.value; localStorage.setItem("theme",e.target.value); };
msgStyleSelect.onchange=e=>{ document.body.dataset.msgstyle=e.target.value; localStorage.setItem("msgStyle",e.target.value); };

// ---------- Peer ID auto-increment w/o collisions ----------
async function generateUniquePeerId(){
  let base="gamegramuser"; 
  let counter=parseInt(localStorage.getItem("peerCounter")||"1");
  while(true){
    const candidate=base+counter;
    try{
      const testPeer=new Peer(candidate,{host:'0.peerjs.com',port:443,path:'/',secure:true});
      await new Promise((res,rej)=>{ testPeer.on('open',()=>res()); testPeer.on('error',()=>rej()); });
      testPeer.destroy();
      localStorage.setItem("peerCounter",(counter+1).toString());
      return candidate;
    }catch(e){ counter++; }
  }
}

// ---------- PeerJS handshake ----------
async function initPeerHandshake(){
  peer=new Peer(localPeerId,{host:'0.peerjs.com',port:443,path:'/',secure:true});
  peer.on('open',async id=>{
    logDebug(`Connected to signaling server as ${id}`);
    // Connect to known peers sequentially
    for(let pid of knownPeers){ if(pid!==localPeerId) await createOffer(pid); }
    peer.destroy();
    addSystem("Handshake done. Fully P2P chat enabled.");
  });
  peer.on('connection',conn=>{
    conn.on('data',async data=>{
      if(data.type==="offer") await acceptOffer(conn.peer,data.offer);
      else if(data.type==="answer") await finalizeAnswer(conn.peer,data.answer);
    });
  });
  peer.on('error',err=>{ addSystem("PeerJS error: "+err); });
}

// ---------- Offer/Answer ----------
async function createOffer(peerId){
  if(peers[peerId]) return;
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
  const dc=pc.createDataChannel("chat"); setupDataChannel(peerId,dc);
  peers[peerId]=pc; dataChannels[peerId]=dc;
  pc.onicecandidate=e=>{ if(e.candidate===null){ const offerStr=JSON.stringify(pc.localDescription); const conn=peer.connect(peerId); conn.on('open',()=>conn.send({type:"offer",offer:offerStr})); } };
  const offer=await pc.createOffer(); await pc.setLocalDescription(offer);
}

async function acceptOffer(peerId,offerStr){
  if(peers[peerId]) return;
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
  peers[peerId]=pc;
  pc.ondatachannel=e=>setupDataChannel(peerId,e.channel);
  await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerStr)));
  const answer=await pc.createAnswer(); await pc.setLocalDescription(answer);
  const conn=peer.connect(peerId); conn.on('open',()=>conn.send({type:"answer",answer:JSON.stringify(pc.localDescription)}));
}

async function finalizeAnswer(peerId,answerStr){
  const pc=peers[peerId]; if(!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerStr)));
}

function setupDataChannel(peerId,dc){
  dataChannels[peerId]=dc;
  dc.onopen=()=>{
    addSystem(`Connected P2P with ${peerId}`);
    knownPeers.add(peerId); localStorage.setItem("knownPeers",JSON.stringify([...knownPeers]));
    users[peerId]={nick:peerId,color:"#ccc",status:"online"}; updateUserList();
    broadcastJoin();
    // Send chat history to new peer
    dc.send(JSON.stringify({type:'history',history:chatHistory}));
  };
  dc.onmessage=e=>handleIncomingMsg(JSON.parse(e.data));
  dc.onclose=()=>{ if(users[peerId]) users[peerId].status="offline"; updateUserList(); addSystem(`Disconnected from ${peerId}`); setTimeout(()=>enqueuePeer(peerId),10000); };
}

// ---------- Late-joining history sync ----------
function handleIncomingMsg(msg){
  switch(msg.type){
    case'chat':
      if(!chatHistory.find(m=>m.id===msg.id)){ addMsg(msg.nickname,msg.text,msg.time,msg.color,msg.id); broadcast(msg); }
      break;
    case'join':
      users[msg.id]={nick:msg.nickname,color:msg.color,status:msg.status||"online"}; updateUserList(); break;
    case'history':
      msg.history.forEach(m=>{ if(!chatHistory.find(x=>x.id===m.id)) addMsg(m.nick,m.text,m.time,m.color,m.id); }); break;
    case'reaction':
      const msgObj=chatHistory.find(x=>x.id===msg.id); if(msgObj){ if(!msgObj.reactions) msgObj.reactions={}; if(!msgObj.reactions[msg.emoji]) msgObj.reactions[msg.emoji]=[]; if(!msgObj.reactions[msg.emoji].includes(nickname)) msgObj.reactions[msg.emoji].push(msg.user); renderReactions(msg.id,msgObj.reactions); } break;
  }
}

// ---------- Chat ----------
sendBtn.onclick=sendMsg; input.addEventListener('keypress',e=>{ if(e.key==='Enter') sendMsg(); });
function sendMsg(){ const text=input.value.trim(); if(!text) return; input.value=''; const id=Date.now()+"-"+Math.random(); const data={type:'chat',nickname,text,color:nickColor,time:timestamp(),id}; addMsg(nickname,text,data.time,nickColor,id); broadcast(data); }
function broadcast(data){ Object.values(dataChannels).forEach(dc=>{ if(dc.readyState==="open") dc.send(JSON.stringify(data)); }); }
function broadcastJoin(){ const data={type:'join',id:localPeerId,nickname,color:nickColor,status}; Object.values(dataChannels).forEach(dc=>{ if(dc.readyState==="open") dc.send(JSON.stringify(data)); }); users[localPeerId]={nick:nickname,color:nickColor,status}; updateUserList(); }

// ---------- UI ----------
function addMsg(nick,text,time,color,id,save=true){ if(messagesEl.querySelector(`.msg[data-id="${id}"]`)) return; const div=document.createElement('div'); div.className='msg new'; div.dataset.id=id; div.innerHTML=`<div class="meta"><span class="nickname" style="color:${color}">${nick}</span> <span>${time}</span></div><div class="text">${escapeHtml(text)}</div><div class="reactions"></div><div class="reaction-bar"><span class="reactBtn">😊</span><span class="reactBtn">👍</span><span class="reactBtn">❤️</span></div>`; messagesEl.appendChild(div); messagesEl.scrollTop=messagesEl.scrollHeight; div.querySelectorAll('.reactBtn').forEach(btn=>btn.onclick=()=>reactToMsg(id,btn.textContent)); setTimeout(()=>div.classList.add('show'),10); if(save&&!chatHistory.find(m=>m.id===id)){ chatHistory.push({id,nick,text,time,color,reactions:{}}); localStorage.setItem("chatHistory",JSON.stringify(chatHistory)); } }
function addSystem(text){ const div=document.createElement('div'); div.className='system'; div.textContent=text; messagesEl.appendChild(div); messagesEl.scrollTop=messagesEl.scrollHeight; console.log("[SYSTEM]",text);}
function updateUserList(){ userListEl.innerHTML=""; Object.values(users).forEach(u=>{ const div=document.createElement('div'); div.className='user'; div.style.color=u.color; div.textContent=`${u.nick} • ${u.status}`; userListEl.appendChild(div); }); }
function renderReactions(id,reactions){ const div=messagesEl.querySelector(`.msg[data-id="${id}"] .reactions`); if(!div) return; div.innerHTML=""; Object.entries(reactions).forEach(([emoji,users])=>{ const span=document.createElement("span"); span.textContent=`${emoji} ${users.length}`; span.className="reaction"; div.appendChild(span); }); }
function timestamp(){ return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
function escapeHtml(s=''){ return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }

// ---------- Reconnection ----------
function enqueuePeer(peerId){ if(!peers[peerId] && !connectQueue.includes(peerId)) connectQueue.push(peerId); processQueue(); }
function processQueue(){ if(connecting||connectQueue.length===0) return; connecting=true; const peerId=connectQueue.shift(); createOffer(peerId).finally(()=>{ connecting=false; processQueue(); }); }
setInterval(()=>{ knownPeers.forEach(pid=>{ if(!peers[pid]) enqueuePeer(pid); }); },20000+Math.random()*5000);
