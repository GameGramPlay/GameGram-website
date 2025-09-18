const messagesEl=document.getElementById('messages');
const input=document.getElementById('input');
const sendBtn=document.getElementById('send');
const userListEl=document.getElementById('userList');
const login=document.getElementById('login');
const nickInput=document.getElementById('nickInput');
const loginBtn=document.getElementById('loginBtn');

const settingsBtn=document.getElementById("settingsBtn");
const settingsModal=document.getElementById("settingsModal");
const closeSettings=document.getElementById("closeSettings");
const nickInputSettings=document.getElementById("nickInputSettings");
const nickColorInput=document.getElementById("nickColor");
const statusSelect=document.getElementById("statusSelect");
const fontSizeInput=document.getElementById("fontSize");
const themeSelect=document.getElementById("themeSelect");
const msgStyleSelect=document.getElementById("msgStyle");

let nickname="", nickColor="#ffffff", status="online";
let peer, conn, role;
const conns=new Set();
let users={};
let chatHistory=[];

const hostId="public-lobby-host";

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
  messagesEl.style.fontSize = fontSize+"px";

  // Load stored chat history
  const storedHistory = JSON.parse(localStorage.getItem("chatHistory") || "[]");
  storedHistory.forEach(m => addMsg(m.nick, m.text, m.time, m.color, m.id, false));
  chatHistory = storedHistory;

  // Render reactions
  storedHistory.forEach(m => renderReactions(m.id, m.reactions || {}));
};

/* ---------------- Login ---------------- */
loginBtn.onclick = () => {
  nickname = nickInput.value.trim() || "Guest"+Math.floor(Math.random()*1000);
  localStorage.setItem("nickname", nickname);
  document.getElementById("meName").textContent = nickname;
  login.style.display='none';
  startAsRandomPeerAndTryConnectToHost();
};

/* ---------------- Settings modal ---------------- */
settingsBtn.onclick = () => {
  nickInputSettings.value = nickname;
  settingsModal.classList.remove("hidden");
};
closeSettings.onclick = () => settingsModal.classList.add("hidden");

nickInputSettings.onchange = e => {
  nickname = e.target.value.trim() || nickname;
  localStorage.setItem("nickname", nickname);
  document.getElementById("meName").textContent = nickname;
  sendJoin();
};
nickColorInput.oninput = e => {
  nickColor = e.target.value;
  localStorage.setItem("nickColor", nickColor);
  sendJoin();
};
statusSelect.onchange = e => {
  status = e.target.value;
  localStorage.setItem("status", status);
  document.getElementById("meStatus").textContent = `(${status})`;
  sendJoin();
};
fontSizeInput.oninput = e => {
  messagesEl.style.fontSize = e.target.value+"px";
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

/* ---------------- Networking ---------------- */
function startAsRandomPeerAndTryConnectToHost(){
  peer = new Peer();
  peer.on('open', id => {
    addSystem(`Connected as ${nickname}`);
    tryConnectToHost();
  });
  peer.on('connection', incoming => {
    conns.add(incoming);
    setupConn(incoming);
  });
}

function tryConnectToHost(){
  let connected=false;
  const attempt = peer.connect(hostId,{reliable:true});
  attempt.on('open', ()=>{
    connected=true;
    role='client';
    conn=attempt;
    conns.add(conn);
    setupConn(conn);
    sendJoin();
  });
  setTimeout(()=>{
    if(!connected){ try{attempt.close();}catch(e){} try{peer.destroy();}catch(e){} startAsHost(); }
  }, 2000);
}

function startAsHost(){
  role='host';
  peer = new Peer(hostId);
  peer.on('open',()=>{ addSystem(`Hosting lobby as ${nickname}`); sendJoin(); });
  peer.on('connection', c => {
    conns.add(c);
    setupConn(c);
    // send user list + full chat history
    c.send({ type: 'userlist', users });
    c.send({ type: 'history', history: chatHistory });
  });
}

function setupConn(c){
  c.on('data', d => {
    switch(d.type){
      case 'chat':
        // host receives, then broadcasts to all (including sender)
        if(role==='host') broadcast(d);
        addMsg(d.nickname, d.text, d.time, d.color, d.id);
        break;
      case 'system':
        addSystem(d.text);
        break;
      case 'join':
        users[c.peer] = {nick:d.nickname,color:d.color,status:d.status};
        updateUserList();
        if(role==='host') broadcast(d);
        break;
      case 'userlist':
        users=d.users; updateUserList();
        break;
      case 'history':
        d.history.forEach(m=>addMsg(m.nick, m.text, m.time, m.color, m.id));
        break;
      case 'reaction':
        const msg=chatHistory.find(m=>m.id===d.id);
        if(msg){
          if(!msg.reactions[d.emoji]) msg.reactions[d.emoji]=[];
          if(!msg.reactions[d.emoji].includes(d.user)) msg.reactions[d.emoji].push(d.user);
          renderReactions(d.id,msg.reactions);
          localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
        }
        break;
      case 'resync-request':
        if(role==='host'){
          c.send({ type:'userlist', users });
          const lastIndex = chatHistory.findIndex(m=>m.id===d.lastId);
          const newMessages = lastIndex>=0 ? chatHistory.slice(lastIndex+1) : chatHistory;
          if(newMessages.length) c.send({ type:'history', history:newMessages });
        }
        break;
    }
  });

  c.on('close', ()=>{conns.delete(c); delete users[c.peer]; updateUserList();});
  c.on('error', err => {conns.delete(c); delete users[c.peer]; updateUserList(); console.warn(err);});
}

function broadcast(data, except){
  conns.forEach(c=>{if(c.open) c.send(data);});
}

/* ---------------- Chat ---------------- */
function sendMsg(){
  const text=input.value.trim(); if(!text) return; input.value='';
  const id=Date.now()+"-"+Math.random();
  const data={type:'chat', nickname, text, time:timestamp(), color:nickColor, id};
  addMsg(nickname, text, data.time, nickColor, id);
  if(role==='host') broadcast(data); else if(conn && conn.open) conn.send(data);
}
sendBtn.onclick=sendMsg;
input.addEventListener('keypress', e=>{if(e.key==='Enter') sendMsg();});

function addMsg(nick, text, time, color, id, save=true){
  let div = messagesEl.querySelector(`.msg[data-id="${id}"]`);
  if(!div){
    div = document.createElement('div');
    div.className='msg';
    div.dataset.id=id;
    div.innerHTML=`
      <div class="meta">
        <span class="nickname" style="color:${color}">${nick}</span> <span>${time}</span>
      </div>
      <div class="text">${escapeHtml(text)}</div>
      <div class="reactions"></div>
      <div class="reaction-bar">
        <span class="reactBtn">😊</span>
        <span class="reactBtn">👍</span>
        <span class="reactBtn">❤️</span>
      </div>`;
    setTimeout(()=>div.classList.add('show'),10); // fade-in animation
    messagesEl.appendChild(div);
    messagesEl.scrollTop=messagesEl.scrollHeight;

    div.querySelectorAll('.reactBtn').forEach(btn=>{
      btn.onclick=()=>reactToMsg(id, btn.textContent);
    });
  } else {
    // If message already exists, just update text/nick/color if needed
    div.querySelector('.nickname').style.color = color;
    div.querySelector('.nickname').textContent = nick;
    div.querySelector('.text').innerHTML = escapeHtml(text);
  }

  if(save){
    // Avoid duplicating in chatHistory
    if(!chatHistory.find(m=>m.id===id)){
      chatHistory.push({id,nick,text,time,color,reactions:{}});
      localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
    }
  }
}

function addSystem(text){
  const div=document.createElement('div');
  div.className='system';
  div.textContent=text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop=messagesEl.scrollHeight;
}

function updateUserList(){
  userListEl.innerHTML="";
  Object.values(users).forEach(u=>{
    const div=document.createElement('div');
    div.className='user';
    div.style.color=u.color;
    div.textContent=`${u.nick} • ${u.status}`;
    userListEl.appendChild(div);
  });
}

function timestamp(){
  const d=new Date();
  return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

function escapeHtml(s){ return s.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }

/* ---------------- Reactions ---------------- */
function reactToMsg(id,emoji){
  const msg=chatHistory.find(m=>m.id===id);
  if(!msg.reactions[emoji]) msg.reactions[emoji]=[];
  if(!msg.reactions[emoji].includes(nickname)) msg.reactions[emoji].push(nickname);
  renderReactions(id,msg.reactions);
  localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
  if(role==='host') broadcast({type:'reaction',id,emoji,user:nickname});
  else if(conn && conn.open) conn.send({type:'reaction',id,emoji,user:nickname});
}

function renderReactions(id,reactions){
  const div=messagesEl.querySelector(`.msg[data-id="${id}"] .reactions`);
  div.innerHTML="";
  Object.entries(reactions).forEach(([emoji,users])=>{
    const span=document.createElement('span');
    span.textContent=`${emoji} ${users.length}`;
    span.className="reaction";
    div.appendChild(span);
  });
}

/* ---------------- Join ---------------- */
function sendJoin(){
  const data={type:'join',nickname,color:nickColor,status,time:timestamp()};
  if(role==='host'){ users[peer.id]={nick:nickname,color:nickColor,status}; updateUserList(); broadcast(data);}
  else if(conn && conn.open) conn.send(data);
}

/* ---------------- Background Resync ---------------- */
setInterval(() => {
  if(role==='client' && conn && conn.open){
    conn.send({ type:'resync-request', lastId: chatHistory.length ? chatHistory[chatHistory.length-1].id : null });
  }
}, 15000);
