// ================= CONFIGURATION =================
const CONFIG = {
    HACKCHAT: {
        ENDPOINT: 'wss://hack.chat/chat-ws'
    },
    PUBLIC_ROOM: 'programming',
    DEBUG_VERBOSE: true,
    TIMEOUTS: {
        RECONNECT: 3000
    }
};

// ================= STATE =================
const state = {
    client: null,
    nickname: '',
    nickColor: '#00ff00',
    users: new Map(),
    chatHistory: [],
    localId: null,
    room: CONFIG.PUBLIC_ROOM
};

// ================= DOM ELEMENTS =================
const elements = {
    login: document.getElementById('login'),
    loginBtn: document.getElementById('loginBtn'),
    nickInput: document.getElementById('nickInput'),
    roomInput: document.getElementById('roomInput'),
    sendBtn: document.getElementById('send'),
    input: document.getElementById('input'),
    messages: document.getElementById('messages'),
    userList: document.getElementById('userList'),
    meName: document.getElementById('meName'),
    meStatus: document.getElementById('meStatus'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    closeSettings: document.getElementById('closeSettings'),
    nickInputSettings: document.getElementById('nickInputSettings'),
    nickColor: document.getElementById('nickColor'),
    statusSelect: document.getElementById('statusSelect'),
    fontSize: document.getElementById('fontSize'),
    themeSelect: document.getElementById('themeSelect'),
    msgStyle: document.getElementById('msgStyle'),
    roomLabel: document.getElementById('roomLabel')
};

// ================= UTILITIES =================
class Utils {
    static timestamp() { return Date.now(); }
    static generateId() { return Math.random().toString(36).slice(2, 11); } // slightly longer ID
    static formatTime(ts) { return new Date(ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}); }
}

// ================= LOGGER =================
class Logger {
    static debug(type, data) {
        if (CONFIG.DEBUG_VERBOSE) UI.addSystem(`[DEBUG] ${type}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    }
    static error(msg, err) {
        const e = err ? (err.message || JSON.stringify(err)) : '';
        UI.addSystem(`[ERROR] ${msg}${e ? ': ' + e : ''}`);
    }
}

// ================= STORAGE =================
class StorageManager {
    static saveUser() {
        localStorage.setItem('chatUser', JSON.stringify({
            nickname: state.nickname,
            nickColor: state.nickColor
        }));
    }

    static loadUser() {
        const data = localStorage.getItem('chatUser');
        if (!data) return;
        try {
            const parsed = JSON.parse(data);
            state.nickname = parsed.nickname || '';
            state.nickColor = parsed.nickColor || '#00ff00';
        } catch { console.warn('Invalid user data'); }
    }

    static saveChat() {
        localStorage.setItem('chatHistory', JSON.stringify(state.chatHistory));
    }

    static loadChat() {
        const data = localStorage.getItem('chatHistory');
        if (!data) return;
        try {
            const history = JSON.parse(data);
            history.forEach(msg => UI.addMessage(msg.nick, msg.text, msg.time, msg.color, msg.id, false));
            state.chatHistory = history;
        } catch { console.warn('Invalid chat history'); }
    }
}

// ================= UI =================
class UI {
    static addMessage(nick, text, time, color = '#ccc', id = null, save = false) {
        if (!elements.messages) return;
        const msgId = id || Utils.generateId();
        if (save && !state.chatHistory.find(m => m.id === msgId)) {
            state.chatHistory.push({ nick, text, time, color, id: msgId });
            StorageManager.saveChat();
        }
        const div = document.createElement('div');
        div.className = 'message';
        div.innerHTML = `<span class="time">${Utils.formatTime(time)}</span>
                         <span class="nick" style="color:${color}">${nick}:</span>
                         <span class="text">${text}</span>`;
        elements.messages.appendChild(div);
        elements.messages.scrollTop = elements.messages.scrollHeight;
    }

    static addSystem(text) {
        if (!elements.messages) return;
        const div = document.createElement('div');
        div.className = 'system-message';
        div.innerHTML = `<span class="time">${Utils.formatTime(Date.now())}</span>
                         <span class="text">${text}</span>`;
        elements.messages.appendChild(div);
        elements.messages.scrollTop = elements.messages.scrollHeight;
    }

    static updateUserList() {
        if (!elements.userList) return;
        elements.userList.innerHTML = '';
        Array.from(state.users.values())
            .sort((a, b) => a.nick.localeCompare(b.nick))
            .forEach(u => {
                const div = document.createElement('div');
                div.textContent = `${u.nick} • ${u.status || 'online'}`;
                elements.userList.appendChild(div);
            });
    }
}

// ================= HACKCHAT CLIENT =================
class HackChatConnector {
    static async createClient(nick, room = CONFIG.PUBLIC_ROOM) {
        if (!window.Client) {
            UI.addSystem('❌ hackchat-engine Client not found.');
            return;
        }

        if (state.client) try { state.client.close(); } catch(e) { Logger.error('Closing old client failed', e); }
        const client = new Client({ ws: { gateway: CONFIG.HACKCHAT.ENDPOINT } });
        state.client = client;
        state.room = room;

        client.on('*', payload => Logger.debug('event', payload));
        client.on('session', () => client.join(nick, '', room));
        client.on('channelJoined', payload => UI.addSystem(`✅ Joined room: ${payload.channel || room}`));
        client.on('message', HackChatConnector.onMessage);
        client.on('onlineSet', p => {
            state.users.clear();
            (p.users || []).forEach(u => state.users.set(u.nick, u));
            UI.updateUserList();
        });
        client.on('onlineAdd', p => { state.users.set(p.nick, p); UI.updateUserList(); UI.addSystem(`👋 ${p.nick} joined`); });
        client.on('onlineRemove', p => { state.users.delete(p.nick); UI.updateUserList(); UI.addSystem(`🚪 ${p.nick} left`); });
        client.on('disconnect', () => { UI.addSystem('⚠️ Disconnected. Reconnecting...'); setTimeout(() => HackChatConnector.createClient(nick, room), CONFIG.TIMEOUTS.RECONNECT); });

        return client;
    }

    static onMessage(payload) {
        const nick = payload.nick || 'anon';
        const text = payload.text || '';
        const time = payload.time || Utils.timestamp();
        const id = payload.id || Utils.generateId();
        if (!state.chatHistory.find(m => m.id === id)) UI.addMessage(nick, text, time, payload.color || '#ccc', id, true);
    }

    static async sendChat(text) {
        if (!state.client) await HackChatConnector.createClient(state.nickname, state.room);
        const tempId = Utils.generateId();
        UI.addMessage(state.nickname, text, Utils.timestamp(), state.nickColor, tempId, true);
        state.client?.say?.(state.room, text);
    }
}

// ================= LOGIN =================
async function doLogin() {
    const nick = elements.nickInput.value.trim() || 'Guest';
    const room = elements.roomInput.value.trim() || CONFIG.PUBLIC_ROOM;
    elements.login?.classList.add('hidden');
    elements.roomLabel.textContent = room;
    state.nickname = nick;
    StorageManager.saveUser();
    UI.addSystem(`🔌 Connecting as ${nick}...`);
    try {
        await HackChatConnector.createClient(nick, room);
        UI.addSystem(`✅ Connected as ${nick}`);
        elements.meName.textContent = nick;
        elements.nickInputSettings.value = nick;
    } catch (e) { Logger.error('Login failed', e); elements.login?.classList.remove('hidden'); }
}

// ================= APP =================
class App {
    static async init() {
        StorageManager.loadUser();
        StorageManager.loadChat();

        elements.loginBtn?.addEventListener('click', doLogin);
        [elements.nickInput, elements.roomInput].forEach(el => el?.addEventListener('keypress', e => { if (e.key === 'Enter') doLogin(); }));

        elements.sendBtn?.addEventListener('click', () => App.sendMessage());
        elements.input?.addEventListener('keypress', e => { if (e.key === 'Enter') App.sendMessage(); });

        elements.settingsBtn?.addEventListener('click', App.openSettings);
        elements.closeSettings?.addEventListener('click', App.closeSettings);

        elements.nickColor?.addEventListener('change', e => { state.nickColor = e.target.value; StorageManager.saveUser(); });
        elements.themeSelect?.addEventListener('change', e => { document.body.dataset.theme = e.target.value; });
        elements.msgStyle?.addEventListener('change', e => { document.body.dataset.msgstyle = e.target.value; });
        elements.fontSize?.addEventListener('input', e => { document.body.style.fontSize = `${e.target.value}px`; });
    }

    static async sendMessage() {
        const text = elements.input?.value.trim();
        if (!text) return;
        elements.input.value = '';
        await HackChatConnector.sendChat(text);
    }

    static openSettings() {
        elements.settingsModal?.classList.remove('hidden');
        elements.nickInputSettings.value = state.nickname;
        elements.nickColor.value = state.nickColor;
    }

    static closeSettings() {
        elements.settingsModal?.classList.add('hidden');
        const newNick = elements.nickInputSettings.value.trim();
        if (newNick && newNick !== state.nickname) {
            state.nickname = newNick;
            StorageManager.saveUser();
            elements.meName.textContent = newNick;
        }
    }
}

// ================= INIT =================
document.addEventListener('DOMContentLoaded', () => {
    App.init().catch(e => Logger.error('Init failed', e));
});
