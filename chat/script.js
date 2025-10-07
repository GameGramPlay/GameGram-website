// === DOM ELEMENTS ===
const loginDiv = document.getElementById('login');
const nickInput = document.getElementById('nickInput');
const roomInput = document.getElementById('roomInput');
const loginBtn = document.getElementById('loginBtn');

const messagesDiv = document.getElementById('messages');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');

const userListDiv = document.getElementById('userList');
const meName = document.getElementById('meName');
const meStatus = document.getElementById('meStatus');
const roomLabel = document.getElementById('roomLabel');

const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettings = document.getElementById('closeSettings');

const nickInputSettings = document.getElementById('nickInputSettings');
const nickColor = document.getElementById('nickColor');
const statusSelect = document.getElementById('statusSelect');
const fontSizeInput = document.getElementById('fontSize');
const themeSelect = document.getElementById('themeSelect');
const msgStyleSelect = document.getElementById('msgStyle');

let hc = null;
let nickname = '';
let room = '';
let userColor = '#ffffff';
let status = 'online';

// === LOGIN HANDLER ===
loginBtn.addEventListener('click', () => {
  nickname = nickInput.value.trim() || 'Guest';
  room = roomInput.value.trim() || 'public';
  initHackChat();
  loginDiv.style.display = 'none';
  roomLabel.textContent = room;
});

// === INITIALIZE HACKCHAT ===
function initHackChat() {
  hc = new HackChatEngine({
    nick: nickname,
    room: room,
    color: userColor,
    host: 'wss://hack.chat/chat-ws'
  });

  hc.connect().then(() => {
    addSystemMessage(`Connected as ${nickname}`);
  });

  hc.on('message', (msg) => {
    addChatMessage(msg.nick, msg.text, msg.color || '#fff');
  });

  hc.on('userjoin', (user) => {
    addSystemMessage(`${user.nick} joined the chat`);
    updateUserList();
  });

  hc.on('userleave', (user) => {
    addSystemMessage(`${user.nick} left the chat`);
    updateUserList();
  });

  hc.on('userlist', () => updateUserList());
}

// === SEND MESSAGE ===
sendBtn.addEventListener('click', sendMessage);
input.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
  const msg = input.value.trim();
  if (!msg || !hc) return;
  hc.say(msg);
  input.value = '';
}

// === ADD SYSTEM MESSAGE ===
function addSystemMessage(text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message system';
  msgDiv.textContent = `[${getTime()}] ${text}`;
  messagesDiv.appendChild(msgDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// === ADD CHAT MESSAGE (hack.chat style) ===
function addChatMessage(user, text, color = '#fff') {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message';
  msgDiv.innerHTML = `[<span class="timestamp">${getTime()}</span>] <span class="nick" style="color:${color}">${escapeHtml(user)}</span>: ${linkify(escapeHtml(text))}`;
  messagesDiv.appendChild(msgDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// === UPDATE USER LIST ===
function updateUserList() {
  if (!hc) return;
  userListDiv.innerHTML = '';
  hc.users.forEach(user => {
    const uDiv = document.createElement('div');
    uDiv.textContent = user.nick;
    uDiv.style.color = user.color || '#fff';
    uDiv.title = `Status: ${user.status || 'online'}`;
    userListDiv.appendChild(uDiv);
  });
}

// === SETTINGS MODAL ===
settingsBtn.addEventListener('click', () => {
  settingsModal.classList.remove('hidden');
  nickInputSettings.value = nickname;
  nickColor.value = userColor;
  statusSelect.value = status;
  fontSizeInput.value = parseInt(document.body.style.fontSize || 14);
  themeSelect.value = document.body.dataset.theme || 'dark';
  msgStyleSelect.value = document.body.dataset.msgstyle || 'cozy';
});

closeSettings.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
  applySettings();
});

function applySettings() {
  nickname = nickInputSettings.value.trim() || nickname;
  userColor = nickColor.value;
  status = statusSelect.value;
  document.body.style.fontSize = fontSizeInput.value + 'px';
  document.body.dataset.theme = themeSelect.value;
  document.body.dataset.msgstyle = msgStyleSelect.value;

  meName.textContent = nickname;
  meStatus.textContent = `(${status})`;

  if (hc) hc.nick = nickname;
}

// === UTILITIES ===
function getTime() {
  const d = new Date();
  return d.toTimeString().slice(0,5);
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, function(m) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];
  });
}

function linkify(text) {
  const urlPattern = /(\bhttps?:\/\/[^\s]+)/g;
  return text.replace(urlPattern, '<a href="$1" target="_blank">$1</a>');
}

// === INIT DEFAULT STYLING ===
document.body.style.fontSize = '14px';

// === LOGIN HANDLER ===
function doLogin() {
  nickname = nickInput.value.trim() || 'Guest';
  room = roomInput.value.trim() || 'public';
  loginDiv.style.display = 'none';
  roomLabel.textContent = room;
  initHackChat();
}

// Click login button
loginBtn.addEventListener('click', doLogin);

// Press Enter in nickname or room input
[nickInput, roomInput].forEach(inputEl => {
  inputEl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') doLogin();
  });
});

// === SEND MESSAGE ===
function sendMessage() {
  const msg = input.value.trim();
  if (!msg || !hc) return;
  hc.say(msg);
  input.value = '';
}

// Click send button
sendBtn.addEventListener('click', sendMessage);

// Press Enter / Shift+Enter in message input
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (e.shiftKey) {
      // Shift+Enter → insert newline
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.value = input.value.slice(0, start) + "\n" + input.value.slice(end);
      input.selectionStart = input.selectionEnd = start + 1;
    } else {
      // Enter → send message
      e.preventDefault(); // prevent new line
      sendMessage();
    }
  }
});

