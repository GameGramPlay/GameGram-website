// DOM elements
const nickInput = document.getElementById('nickInput');
const roomInput = document.getElementById('roomInput');
const loginBtn = document.getElementById('loginBtn');
const loginDiv = document.getElementById('login');
const messagesDiv = document.getElementById('messages');
const chatDiv = document.querySelector('.chat');
const sendBtn = document.getElementById('send');
const inputField = document.getElementById('input');
const roomLabel = document.getElementById('roomLabel');

// State
let client = null;
let nickname = '';
let room = 'public';

// ================= UI =================
const UI = {
  addMessage(nick, text) {
    const div = document.createElement('div');
    div.className = 'message';
    div.innerHTML = `<span class="nick">${nick}:</span> <span>${text}</span>`;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  },
  addSystem(text) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = text;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
};

// ================= LOGIN =================
async function doLogin() {
  nickname = nickInput.value.trim() || 'Guest';
  room = roomInput.value.trim() || 'public';
  loginDiv.style.display = 'none';
  chatDiv.style.display = 'block';
  roomLabel.textContent = room;

  UI.addSystem('Attempting login...');

  try {
    client = new Client({ ws: { gateway: 'wss://hack.chat/chat-ws' } });

    client.on('session', () => {
      client.join(nickname, '', room);
    });

    client.on('channelJoined', () => {
      UI.addSystem(`Joined room "${room}" as ${nickname}`);
    });

    client.on('message', payload => {
      const nick = payload.nick || 'anon';
      const text = payload.text || '';
      UI.addMessage(nick, text);
    });

    client.on('onlineAdd', payload => {
      UI.addSystem(`${payload.nick} joined`);
    });

    client.on('onlineRemove', payload => {
      UI.addSystem(`${payload.nick} left`);
    });

    client.on('disconnect', () => {
      UI.addSystem('Disconnected. Retrying in 3s...');
      setTimeout(() => doLogin(), 3000);
    });

  } catch (e) {
    UI.addSystem('Login failed: ' + e.message);
    loginDiv.style.display = 'block';
    chatDiv.style.display = 'none';
  }
}

// ================= EVENTS =================
loginBtn.addEventListener('click', doLogin);

[nickInput, roomInput].forEach(inputEl => {
  inputEl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') doLogin();
  });
});

sendBtn.addEventListener('click', async () => {
  const text = inputField.value.trim();
  if (!text || !client) return;
  inputField.value = '';
  client.say(room, text);
  UI.addMessage(nickname, text);
});

inputField.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendBtn.click();
});
