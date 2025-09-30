// script.js — HHS-powered chat with reactions, settings, and sync
import { createPeerGroup } from '@hyper-hyper-space/core';

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

// HHS PeerGroup & CRDT state
let peerGroup, chatSpace, chatCRDT;
let localId, nickname = "", nickColor = "#ffffff", status = "online";
let currentRoom = "public";
const users = {};      // peerId -> {nick,color,status}
let chatHistory = [];

// ----------------- Helpers -----------------
function logDebug(msg, obj) {
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  debugPanel.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
  if (obj) console.debug("[Debug]", msg, obj);
}

function timestamp() { return new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function escapeHtml(s='') { return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }

// ----------------- UI & LocalStorage -----------------
function setLocalAccountDefaults() {
  nickname = localStorage.getItem("nickname") || "";
  nickColor = localStorage.getItem("nickColor") || "#ffffff";
  status = localStorage.getItem("status") || "online";

  document.getElementById("meName").textContent = nickname || "Guest";
  document.getElementById("meStatus").textContent = `(${status})`;

  const fontSize = localStorage.getItem("fontSize") || "14";
  fontSizeInput.value = fontSize;
  messagesEl.style.fontSize = fontSize + "px";

  const storedHistory = JSON.parse(localStorage.getItem("chatHistory") || "[]");
  storedHistory.forEach(m => addMsg(m.nick, m.text, m.time, m.color, m.id, false));
  chatHistory = storedHistory;
}

// ----------------- Login -----------------
loginBtn.onclick = async () => {
  const nick = nickInput.value.trim();
  const room = roomInput.value.trim() || "public";
  if (!nick) { alert("Enter a nickname"); return; }
  nickname = nick;
  currentRoom = room;
  localStorage.setItem("nickname", nickname);
  document.getElementById("meName").textContent = nickname;
  login.style.display = 'none';
  addSystem(`Joining room "${currentRoom}" as ${nickname}...`);
  await startHHS();
};

// ----------------- HHS Initialization -----------------
async function startHHS() {
  // create a peer group
  peerGroup = createPeerGroup({
    identity: nickname + "-" + Math.random().toString(36).slice(2,6),
    signalingServer: 'wss://mypeer.net:443'
  });

  localId = peerGroup.identity;
  users[localId] = { nick: nickname, color: nickColor, status };

  chatSpace = peerGroup.createSpace(currentRoom);
  chatCRDT = chatSpace.createCRDT('chat', 'ordered-set'); // ordered list of messages

  // observe CRDT
  chatCRDT.observe(op => {
    if (op.type === 'add') handleIncomingMsg(op.value, false);
  });

  peerGroup.on('peer-connected', peerId => {
    logDebug('Connected to peer: ' + peerId);
    broadcastJoin(peerId);
  });

  peerGroup.on('peer-disconnected', peerId => {
    logDebug('Disconnected from peer: ' + peerId);
    if (users[peerId]) users[peerId].status = 'offline';
    updateUserList();
  });

  await chatSpace.join();
  updateUserList();
  addSystem(`Joined room "${currentRoom}"!`);
}

// ----------------- Broadcast & Join -----------------
function broadcastJoin(peerId = null) {
  const payload = { type:'join', id: localId, nickname, color: nickColor, status };
  if (peerId) chatSpace.sendTo(peerId, payload);
  else chatSpace.broadcast(payload);
}

// ----------------- Chat -----------------
sendBtn.onclick = sendMsg;
input.addEventListener('keypress', e => { if (e.key==='Enter') sendMsg(); });

function sendMsg() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const id = Date.now() + "-" + Math.random().toString(36).slice(2,7);
  const msg = { id, nickname, text, color: nickColor, time: timestamp(), reactions:{} };
  chatCRDT.add(msg);
  addMsg(nickname, text, msg.time, nickColor, id);
}

function handleIncomingMsg(msg, save = true) {
  if (!chatHistory.find(m => m.id === msg.id)) {
    addMsg(msg.nickname, msg.text, msg.time, msg.color, msg.id, save);
    if (save) chatHistory.push(msg);
    localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
  }
}

// ----------------- Reactions -----------------
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

function reactToMsg(id, emoji) {
  const msg = chatHistory.find(m => m.id === id);
  if (!msg) return;
  if (!msg.reactions) msg.reactions = {};
  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
  if (!msg.reactions[emoji].includes(nickname)) msg.reactions[emoji].push(nickname);

  // update CRDT so HHS propagates it
  const crdtMsg = chatCRDT.get(msg.id) || msg;
  crdtMsg.reactions = msg.reactions;
  chatCRDT.update(crdtMsg);

  renderReactions(id, msg.reactions);
}

// ----------------- UI -----------------
function addMsg(nick, text, time, color, id, save = true) {
  if (messagesEl.querySelector(`.msg[data-id="${id}"]`)) return;
  const div = document.createElement('div');
  div.className = 'msg new';
  div.dataset.id = id;
  div.innerHTML = `
    <div class="meta"><span class="nickname" style="color:${escapeHtml(color)}">${escapeHtml(nick)}</span> <span>${escapeHtml(time)}</span></div>
    <div class="text">${escapeHtml(text)}</div>
    <div class="reactions"></div>
    <div class="reactBtns">
      <button class="reactBtn">👍</button>
      <button class="reactBtn">❤️</button>
      <button class="reactBtn">😂</button>
      <button class="reactBtn">😢</button>
      <button class="reactBtn">😡</button>
    </div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  div.querySelectorAll('.reactBtn').forEach(btn => btn.onclick = () => {
    const emoji = btn.textContent;
    reactToMsg(id, emoji);
  });

  if (save) {
    const msg = { id, nickname: nick, text, color, time, reactions: {} };
    chatHistory.push(msg);
    localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
  }
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

// ----------------- System -----------------
function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'system';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  console.log("[SYSTEM]", text);
}

// ----------------- Settings Modal -----------------
settingsBtn.onclick = () => settingsModal.classList.remove("hidden");
closeSettings.onclick = () => settingsModal.classList.add("hidden");

nickInputSettings.value = nickname;
nickColorInput.value = nickColor;
statusSelect.value = status;
fontSizeInput.value = parseInt(localStorage.getItem("fontSize") || "14");
themeSelect.value = localStorage.getItem("theme") || "dark";
msgStyleSelect.value = localStorage.getItem("msgStyle") || "cozy";

nickInputSettings.oninput = () => localStorage.setItem("nickname", nickInputSettings.value);
nickColorInput.oninput = () => { 
  nickColor = nickColorInput.value; 
  localStorage.setItem("nickColor", nickColor); 
  users[localId].color = nickColor;
  updateUserList();
  broadcastJoin();
};

statusSelect.onchange = () => { 
  status = statusSelect.value; 
  localStorage.setItem("status", status); 
  users[localId].status = status;
  updateUserList();
  broadcastJoin();
};

fontSizeInput.oninput = () => { 
  const size = fontSizeInput.value; 
  messagesEl.style.fontSize = size + "px"; 
  localStorage.setItem("fontSize", size); 
};

themeSelect.onchange = () => { 
  const theme = themeSelect.value; 
  document.body.dataset.theme = theme; 
  localStorage.setItem("theme", theme); 
};

msgStyleSelect.onchange = () => { 
  const style = msgStyleSelect.value; 
  document.body.dataset.msgstyle = style; 
  localStorage.setItem("msgStyle", style); 
};

// ----------------- On Load -----------------
window.onload = () => {
  setLocalAccountDefaults();
  addSystem("UI ready. Enter a nickname and room to join the lobby.");
};

