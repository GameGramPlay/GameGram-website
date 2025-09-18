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
let peer;
const peers = new Map(); // peerId => connection
const knownPeers = new Set(); // discovered peers
let chatHistory = [];
let users = {};

/* ---------------- LocalStorage ---------------- */
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
};

/* ---------------- Login ---------------- */
loginBtn.onclick = () => {
    nickname = nickInput.value.trim() || "Guest" + Math.floor(Math.random() * 1000);
    localStorage.setItem("nickname", nickname);
    document.getElementById("meName").textContent = nickname;
    login.style.display = 'none';
    startPeer();
};

/* ---------------- Settings ---------------- */
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

/* ---------------- PeerJS P2P ---------------- */
function startPeer() {
    peer = new Peer(undefined, {
        host: 'peerjs.com',
        port: 443,
        secure: true,
        config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    peer.on('open', id => {
        addSystem(`Connected as ${nickname} (${id})`);
        // reconnect to known peers
        const known = JSON.parse(localStorage.getItem("knownPeers") || "[]");
        known.forEach(pid => { if (pid !== id) connectToPeer(pid); });
        broadcastJoin();
    });

    peer.on('connection', conn => {
        setupConn(conn);
    });
}

function connectToPeer(peerId) {
    if (peers.has(peerId)) return;
    const conn = peer.connect(peerId, { reliable: true });
    setupConn(conn);
}

function setupConn(conn) {
    conn.on('open', () => {
        peers.set(conn.peer, conn);
        knownPeers.add(conn.peer);
        saveKnownPeer(conn.peer);
        addSystem(`Connected to peer ${conn.peer}`);
        broadcastJoin(conn);
        // send chat history to new peer
        conn.send({ type: 'history', history: chatHistory });
        // share known peers
        conn.send({ type: 'peerlist', peers: Array.from(knownPeers) });
    });

    conn.on('data', data => {
        switch (data.type) {
            case 'chat': handleIncomingMsg(data); break;
            case 'join': handlePeerJoin(data); break;
            case 'history': syncHistory(data.history); break;
            case 'peerlist': data.peers.forEach(p => { if(p !== peer.id && !peers.has(p)) connectToPeer(p); }); break;
            case 'reaction': handleReaction(data); break;
        }
    });

    conn.on('close', () => {
        peers.delete(conn.peer);
        delete users[conn.peer];
        updateUserList();
        addSystem(`Disconnected from ${conn.peer}`);
    });
}

/* ---------------- Chat ---------------- */
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
        broadcast(msg); // propagate to other peers
    }
}

function broadcast(data, except) {
    peers.forEach(conn => { if(conn.open && conn !== except) conn.send(data); });
}

/* ---------------- Join / Peer management ---------------- */
function broadcastJoin(conn) {
    const data = { type: 'join', id: peer.id, nickname, color: nickColor, status };
    if(conn) conn.send(data);
    else broadcast(data);
    users[peer.id] = { nick: nickname, color: nickColor, status };
    updateUserList();
}

function handlePeerJoin(data) {
    users[data.id] = { nick: data.nickname, color: data.color, status: data.status };
    updateUserList();
}

/* ---------------- History ---------------- */
function syncHistory(history) {
    history.forEach(m => {
        if (!chatHistory.find(msg => msg.id === m.id)) {
            addMsg(m.nick, m.text, m.time, m.color, m.id);
        }
    });
}

/* ---------------- Reactions ---------------- */
function reactToMsg(id, emoji) {
    const msg = chatHistory.find(m => m.id === id);
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

/* ---------------- UI ---------------- */
function addMsg(nick, text, time, color, id) {
    if(messagesEl.querySelector(`.msg[data-id="${id}"]`)) return;
    const div = document.createElement('div');
    div.className = 'msg';
    div.dataset.id = id;
    div.innerHTML = `<div class="meta"><span class="nickname" style="color:${color}">${nick}</span> <span>${time}</span></div>
                     <div class="text">${escapeHtml(text)}</div>
                     <div class="reactions"></div>
                     <div class="reaction-bar">
                        <span class="reactBtn">😊</span>
                        <span class="reactBtn">👍</span>
                        <span class="reactBtn">❤️</span>
                     </div>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    div.querySelectorAll('.reactBtn').forEach(btn => btn.onclick = () => reactToMsg(id, btn.textContent));
    chatHistory.push({ id, nick, text, time, color, reactions: {} });
    localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
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

function timestamp() {
    return new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

function escapeHtml(s) {
    return s.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
}

/* ---------------- Save known peers ---------------- */
function saveKnownPeer(peerId) {
    let known = JSON.parse(localStorage.getItem("knownPeers")||"[]");
    if(!known.includes(peerId)){ known.push(peerId); localStorage.setItem("knownPeers", JSON.stringify(known)); }
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


 
