// script.js — full Hack.Chat client using hackchat-engine Client

// ================= CONFIGURATION =================
const CONFIG = {
    HACKCHAT: {
        ENDPOINT: 'wss://hack.chat/chat-ws'
    },
    PUBLIC_ROOM: 'public',
    DEBUG_VERBOSE: false,
    TIMEOUTS: {
        RECONNECT: 3000
    }
};

// ================= STATE MANAGEMENT =================
const state = {
    client: null,
    nickname: '',
    nickColor: '#00ff00',
    users: new Map(),
    chatHistory: [],
    localId: null
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
    static timestamp() {
        return Date.now();
    }
    
    static generateId() {
        return Math.random().toString(36).substr(2, 9);
    }
    
    static formatTime(timestamp) {
        return new Date(timestamp).toLocaleTimeString();
    }
}

// ================= LOGGER =================
class Logger {
    static debug(type, data) {
        console.log(`[DEBUG] ${type}:`, data);
    }
    
    static error(message, error) {
        console.error(`[ERROR] ${message}:`, error);
    }
}

// ================= STORAGE MANAGER =================
class StorageManager {
    static saveUser() {
        localStorage.setItem('chatUser', JSON.stringify({
            nickname: state.nickname,
            nickColor: state.nickColor
        }));
    }
    
    static loadUser() {
        const userData = localStorage.getItem('chatUser');
        if (userData) {
            const parsed = JSON.parse(userData);
            state.nickname = parsed.nickname || '';
            state.nickColor = parsed.nickColor || '#00ff00';
        }
    }
    
    static saveChat() {
        localStorage.setItem('chatHistory', JSON.stringify(state.chatHistory));
    }
    
    static loadChat() {
        const chatData = localStorage.getItem('chatHistory');
        if (chatData) {
            state.chatHistory = JSON.parse(chatData);
            // Restore chat messages to UI
            state.chatHistory.forEach(msg => {
                UI.addMessage(msg.nick, msg.text, msg.time, msg.color, msg.id, false);
            });
        }
    }
}

// ================= UI MANAGER =================
class UI {
    static addMessage(nick, text, time, color = '#ccc', id = null, save = false) {
        if (!elements.messages) return;
        
        const messageId = id || Utils.generateId();
        const messageData = { nick, text, time, color, id: messageId };
        
        if (save && !state.chatHistory.find(m => m.id === messageId)) {
            state.chatHistory.push(messageData);
            StorageManager.saveChat();
        }
        
        const div = document.createElement('div');
        div.className = 'message';
        div.innerHTML = `
            <span class="time">${Utils.formatTime(time)}</span>
            <span class="nick" style="color: ${color}">${nick}:</span>
            <span class="text">${text}</span>
        `;
        
        elements.messages.appendChild(div);
        elements.messages.scrollTop = elements.messages.scrollHeight;
    }
    
    static addSystem(text) {
        if (!elements.messages) return;
        
        const div = document.createElement('div');
        div.className = 'system-message';
        div.innerHTML = `<span class="time">${Utils.formatTime(Date.now())}</span><span class="text">${text}</span>`;
        
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
    static async createClient(nick) {
        if (state.client) {
            try {
                state.client.close();
            } catch (e) {
                Logger.error('Error closing client', e);
            }
            state.client = null;
        }
        
        // Use the real hackchat-engine Client
        const client = new Client({
            ws: {
                gateway: CONFIG.HACKCHAT.ENDPOINT
            }
        });
        
        state.client = client;
        
        // Set up event listeners
        client.on('*', payload => {
            if (CONFIG.DEBUG_VERBOSE) UI.addSystem(JSON.stringify(payload));
            Logger.debug('client-event', payload);
        });
        
        client.on('session', () => {
            client.join(nick, '', CONFIG.PUBLIC_ROOM);
        });
        
        client.on('channelJoined', payload => {
            UI.addSystem(`Joined ${payload?.channel || CONFIG.PUBLIC_ROOM}`);
        });
        
        client.on('message', payload => HackChatConnector.onMessage(payload));
        
        client.on('onlineSet', payload => {
            // Update user list
            state.users.clear();
            payload.users?.forEach(user => {
                state.users.set(user.nick, user);
            });
            UI.updateUserList();
        });
        
        client.on('onlineAdd', payload => {
            // Add user to list
            state.users.set(payload.nick, payload);
            UI.updateUserList();
            UI.addSystem(`${payload.nick} joined`);
        });
        
        client.on('onlineRemove', payload => {
            // Remove user from list
            state.users.delete(payload.nick);
            UI.updateUserList();
            UI.addSystem(`${payload.nick} left`);
        });
        
        // Auto reconnect on disconnect
        client.on('disconnect', () => {
            UI.addSystem('Disconnected, retrying...');
            setTimeout(() => HackChatConnector.createClient(nick), CONFIG.TIMEOUTS.RECONNECT);
        });
        
        return client;
    }
    
    static onMessage(payload) {
        const nick = payload.nick || payload.user || 'anon';
        const text = payload.text || payload.message || '';
        const time = payload.time || Utils.timestamp();
        const id = payload.id || Utils.generateId();
        
        if (!state.chatHistory.find(m => m.id === id)) {
            UI.addMessage(nick, text, time, payload.color || '#ccc', id, true);
        }
    }
    
    static async sendChat(text) {
        if (!state.client) {
            await HackChatConnector.createClient(state.nickname);
        }
        
        const tempId = Utils.generateId();
        UI.addMessage(state.nickname, text, Utils.timestamp(), state.nickColor, tempId, true);
        
        if (state.client.say) {
            state.client.say(CONFIG.PUBLIC_ROOM, text);
        }
    }
}

// ================= APP =================
class App {
    static async init() {
        StorageManager.loadUser();
        StorageManager.loadChat();
        
        // Event listeners
        elements.loginBtn?.addEventListener('click', () => App.handleLogin());
        elements.nickInput?.addEventListener('keypress', e => {
            if (e.key === 'Enter') App.handleLogin();
        });
        elements.sendBtn?.addEventListener('click', () => App.sendMessage());
        elements.input?.addEventListener('keypress', e => {
            if (e.key === 'Enter') App.sendMessage();
        });
        
        // Settings modal events
        elements.settingsBtn?.addEventListener('click', () => App.openSettings());
        elements.closeSettings?.addEventListener('click', () => App.closeSettings());
        
        // Settings change events
        elements.nickColor?.addEventListener('change', (e) => {
            state.nickColor = e.target.value;
            StorageManager.saveUser();
        });
        
        elements.themeSelect?.addEventListener('change', (e) => {
            document.body.setAttribute('data-theme', e.target.value);
        });
        
        elements.msgStyle?.addEventListener('change', (e) => {
            document.body.setAttribute('data-msgstyle', e.target.value);
        });
        
        elements.fontSize?.addEventListener('input', (e) => {
            document.body.style.fontSize = `${e.target.value}px`;
        });
    }
    
    static async handleLogin() {
        const nick = elements.nickInput?.value.trim();
        if (!nick) {
            alert('Enter nickname');
            return;
        }
        
        state.nickname = nick;
        StorageManager.saveUser();
        
        await HackChatConnector.createClient(nick);
        
        UI.addSystem(`Connected as ${nick}`);
        elements.login.style.display = 'none';
        state.localId = nick;
        
        // Update UI elements
        if (elements.meName) elements.meName.textContent = nick;
        if (elements.nickInputSettings) elements.nickInputSettings.value = nick;
    }
    
    static async sendMessage() {
        const text = elements.input?.value.trim();
        if (!text) return;
        
        elements.input.value = '';
        await HackChatConnector.sendChat(text);
    }
    
    static openSettings() {
        elements.settingsModal?.classList.remove('hidden');
        
        // Populate current settings
        if (elements.nickInputSettings) elements.nickInputSettings.value = state.nickname;
        if (elements.nickColor) elements.nickColor.value = state.nickColor;
    }
    
    static closeSettings() {
        elements.settingsModal?.classList.add('hidden');
        
        // Save any changes
        if (elements.nickInputSettings?.value !== state.nickname) {
            state.nickname = elements.nickInputSettings.value;
            StorageManager.saveUser();
            if (elements.meName) elements.meName.textContent = state.nickname;
        }
    }
}

// ================= INITIALIZATION =================
document.addEventListener('DOMContentLoaded', () => {
    App.init().catch(e => Logger.error('Init failed', e));
});
