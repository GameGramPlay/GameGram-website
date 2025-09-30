// ------------------ HHS P2P Chat (single public room) ------------------
// Replaces PeerJS with HyperHyperSpace mesh

import { Space, Identity, Mesh } from 'https://unpkg.com/hyperhyperspace/dist/index.browser.js';

// --- UI Elements ---
const messagesEl = document.getElementById('messages');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const userListEl = document.getElementById('userList');
const login = document.getElementById('login');
const nickInput = document.getElementById('nickInput');
const loginBtn = document.getElementById('loginBtn');

// Settings & Debug
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

// --- Globals ---
let nickname = '', nickColor = '#ffffff', status = 'online';
let chatSpace, myIdentity, mesh;
let chatHistory = [];
const users = {};
const PUBLIC_ROOM = 'public-room';

// ------------------ UI & LocalStorage ----------------
window.onload = async () => {
    nickname = localStorage.getItem("nickname") || "";
    nickColor = localStorage.getItem("nickColor") || "#ffffff";
    status = localStorage.getItem("status") || "online";

    document.getElementById("meName").textContent = nickname || "Guest";
    document.getElementById("meStatus").textContent = `(${status})`;
    document.getElementById("roomLabel").textContent = PUBLIC_ROOM;

    const storedHistory = JSON.parse(localStorage.getItem("chatHistory") || "[]");
    storedHistory.forEach(m => addMsg(m.nick, m.text, m.time, m.color, m.id, false));
    chatHistory = storedHistory;
};

loginBtn.onclick = async () => {
    const nick = nickInput.value.trim();
    if(!nick){ alert("Enter a nickname"); return; }
    nickname = nick;
    localStorage.setItem("nickname", nickname);
    login.style.display = 'none';
    await startHHS();
};

// ------------------ HHS Setup ----------------
async function startHHS() {
    // Load or create identity
    const storedId = localStorage.getItem('hhs-identity');
    if (storedId) {
        myIdentity = Identity.fromJSON(JSON.parse(storedId));
    } else {
        myIdentity = await Identity.createRandom();
        localStorage.setItem('hhs-identity', JSON.stringify(myIdentity.toJSON()));
    }

    // Create or join a space
    chatSpace = new Space(PUBLIC_ROOM, myIdentity);

    // Connect to mesh (with default signalling server)
    mesh = new Mesh(myIdentity, [ 'wss://mypeer.net:443' ]);
    await mesh.joinSpace(chatSpace);

    addSystem(`Connected to HHS mesh as ${nickname}`);

    // Subscribe to incoming operations
    chatSpace.subscribe(obj => {
        if (obj.type === 'chat') {
            handleIncomingMsg(obj);
        } else if (obj.type === 'presence') {
            handlePeerPresence(obj);
        }
    });

    // Broadcast my presence
    broadcastPresence();
}

// ------------------ Presence ----------------
function broadcastPresence() {
    const presence = {
        type: 'presence',
        id: myIdentity.getPublicKey().hash(),
        nickname,
        color: nickColor,
        status
    };
    chatSpace.append(presence);
    users[presence.id] = presence;
    updateUserList();
}

// ------------------ Chat -----------------
sendBtn.onclick = sendMsg;
input.addEventListener('keypress', e=>{ if(e.key==='Enter') sendMsg(); });

async function sendMsg(){
    const text = input.value.trim(); if(!text) return; input.value='';
    const id = Date.now()+"-"+Math.random();
    const msg = { 
        type:'chat', 
        id,
        nickname, 
        text, 
        color:nickColor, 
        time: timestamp() 
    };
    await chatSpace.append(msg);
    addMsg(nickname,text,msg.time,nickColor,id);
}

function handleIncomingMsg(msg){
    if(!chatHistory.find(m=>m.id===msg.id)){ 
        addMsg(msg.nickname,msg.text,msg.time,msg.color,msg.id); 
        chatHistory.push(msg);
        localStorage.setItem("chatHistory",JSON.stringify(chatHistory));
    }
}

function handlePeerPresence(p){
    users[p.id] = { nick:p.nickname, color:p.color, status:p.status };
    updateUserList();
    addSystem(`${p.nickname} is ${p.status}`);
}

// ------------------ UI -----------------
function addMsg(nick,text,time,color,id,save=true){
    if(messagesEl.querySelector(`.msg[data-id="${id}"]`)) return;
    const div = document.createElement('div');
    div.className = 'msg new';
    div.dataset.id=id;
    div.innerHTML=`<div class="meta"><span class="nickname" style="color:${color}">${nick}</span> <span>${time}</span></div><div class="text">${escapeHtml(text)}</div>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if(save){ chatHistory.push({id,nick,text,time,color}); localStorage.setItem("chatHistory",JSON.stringify(chatHistory)); }
}

function updateUserList(){ 
    userListEl.innerHTML="";
    Object.values(users).forEach(u=>{
        const div = document.createElement('div');
        div.className='user';
        div.style.color=u.color;
        div.textContent=`${u.nick} • ${u.status}`;
        userListEl.appendChild(div);
    });
}

function addSystem(text){ 
    const div = document.createElement('div'); 
    div.className='system'; 
    div.textContent=text; 
    messagesEl.appendChild(div); 
    messagesEl.scrollTop=messagesEl.scrollHeight; 
    console.log("[SYSTEM]", text);
}

function timestamp(){ return new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function escapeHtml(s=''){ return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }

function logDebug(msg, obj){
    const line = document.createElement("div");
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    debugPanel.appendChild(line);
    debugPanel.scrollTop = debugPanel.scrollHeight;
    if(obj) console.debug("[Debug]", msg, obj);
}
