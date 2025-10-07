// script.js — full Hack.Chat client using hackchat-engine Client
import { Client } from 'hackchat-engine';

/* eslint-disable no-console */

// ================= CONFIG =================
const CONFIG = {
  PUBLIC_ROOM: "public",
  HACKCHAT: { ENDPOINT: "wss://hack.chat/chat-ws", CLIENT_OPTIONS: { ws: { gateway: "wss://hack.chat/chat-ws" } } },
  TIMEOUTS: { HANDSHAKE: 2500, RECONNECT: 3000 },
  INTERVALS: { RESYNC: 15000, DEBUG_GRAPH: 10000 },
  DEBUG_VERBOSE: true
};

// ================= STATE =================
class ChatState {
  constructor() {
    this.nickname = "";
    this.nickColor = "#ffffff";
    this.status = "online";
    this.localId = null;
    this.client = null;
    this.users = new Map();
    this.chatHistory = [];
    this.intervals = new Map();
  }
  reset() { this.clearIntervals(); this.users.clear(); this.chatHistory=[]; try{this.client?.close?.()}catch{} this.client=null; }
  clearIntervals(){ this.intervals.forEach(i=>clearInterval(i)); this.intervals.clear(); }
}
const state = new ChatState();

// ================= DOM =================
const elements = {
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  sendBtn: document.getElementById('send'),
  userList: document.getElementById('userList'),
  login: document.getElementById('login'),
  nickInput: document.getElementById('nickInput'),
  loginBtn: document.getElementById('loginBtn'),
  meName: document.getElementById('meName'),
  meStatus: document.getElementById('meStatus')
};

// ================= UTIL =================
const Utils = {
  timestamp: () => new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
  escapeHtml: s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  generateId: ()=>`tmp-${Date.now()}-${Math.random().toString(36).slice(2,9)}`
};

// ================= STORAGE =================
class StorageManager {
  static save(k,v){ try{localStorage.setItem(k,JSON.stringify(v))}catch(e){Logger.error('Storage save failed',{k,e})} }
  static load(k,d=null){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d }catch(e){Logger.error('Storage load failed',{k,e}); return d} }
  static saveUser(){ this.save('nickname',state.nickname); this.save('nickColor',state.nickColor); this.save('status',state.status); }
  static loadUser(){ state.nickname=this.load('nickname','')||''; state.nickColor=this.load('nickColor','#fff')||'#fff'; state.status=this.load('status','online')||'online'; elements.meName&&(elements.meName.textContent=state.nickname); elements.meStatus&&(elements.meStatus.textContent=`(${state.status})`); }
  static saveChat(){ this.save('chatHistory',state.chatHistory); }
  static loadChat(){ const h=this.load('chatHistory',[]); h.forEach(m=>UI.addMessage(m.nick,m.text,m.time,m.color,m.id,false)); state.chatHistory=h; }
}

// ================= LOGGER =================
class Logger {
  static log(l,m,d=null){ console[l==='error'?'error':'log'](`[${l.toUpperCase()}] ${m}`,d||''); }
  static debug(m,d){this.log('debug',m,d);} static info(m,d){this.log('info',m,d);} static warn(m,d){this.log('warn',m,d);} static error(m,d){this.log('error',m,d);}
}

// ================= UI =================
class UI {
  static addMessage(nick,text,time,color,id,save=true){
    if(!id) id=Utils.generateId(); if(!time) time=Utils.timestamp(); if(!elements.messages) return;
    if(elements.messages.querySelector(`.msg[data-id="${id}"]`)) return;
    const div=document.createElement('div'); div.className='msg'; div.dataset.id=id;
    div.innerHTML=`<span class="nick" style="color:${Utils.escapeHtml(color)}">${Utils.escapeHtml(nick)}</span> <span class="time">${Utils.escapeHtml(time)}</span>: ${Utils.escapeHtml(text)}`;
    elements.messages.appendChild(div); elements.messages.scrollTop=elements.messages.scrollHeight;
    if(save){ state.chatHistory.push({id,nick,text,time,color,reactions:{}}); StorageManager.saveChat(); }
  }
  static addSystem(text){ if(elements.messages){ const d=document.createElement('div'); d.className='system'; d.textContent=`[${Utils.timestamp()}] ${text}`; elements.messages.appendChild(d); elements.messages.scrollTop=elements.messages.scrollHeight } Logger.info(text); }
  static updateUserList(){ if(!elements.userList) return; elements.userList.innerHTML=''; Array.from(state.users.values()).sort((a,b)=>a.nick.localeCompare(b.nick)).forEach(u=>{const div=document.createElement('div'); div.textContent=`${u.nick} • ${u.status||'online'}`; elements.userList.appendChild(div);}); }
}

// ================= HACKCHAT CLIENT =================
class HackChatConnector {
  static async createClient(nick){
    if(state.client){ try{ state.client.close(); }catch{} state.client=null; }
    const client=new Client({ ws:{gateway:CONFIG.HACKCHAT.ENDPOINT} }); state.client=client;
    // catch all events for debug
    client.on('*',payload=>{ if(CONFIG.DEBUG_VERBOSE) UI.addSystem(JSON.stringify(payload)); Logger.debug('client-event',payload); });
    client.on('session',()=>{ client.join(nick,'',CONFIG.PUBLIC_ROOM); });
    client.on('channelJoined',payload=>{ UI.addSystem(`Joined ${payload?.channel||CONFIG.PUBLIC_ROOM}`); });
    client.on('message',payload=>HackChatConnector.onMessage(payload));
    // auto reconnect on disconnect
    client.on('disconnect',()=>{ UI.addSystem('Disconnected, retrying...'); setTimeout(()=>HackChatConnector.createClient(nick),CONFIG.TIMEOUTS.RECONNECT); });
    return client;
  }
  static onMessage(payload){
    const nick=payload.nick||payload.user||'anon'; const text=payload.message||payload.text||''; const time=payload.time||Utils.timestamp(); const id=payload.id||Utils.generateId();
    if(!state.chatHistory.find(m=>m.id===id)) UI.addMessage(nick,text,time,payload.color||'#ccc',id,true);
  }
  static async sendChat(text){
    if(!state.client) await HackChatConnector.createClient(state.nickname);
    const tempId=Utils.generateId(); UI.addMessage(state.nickname,text,Utils.timestamp(),state.nickColor,tempId,true);
    state.client.say?.(CONFIG.PUBLIC_ROOM,text);
  }
}

// ================= APP =================
class App {
  static async init(){
    StorageManager.loadUser(); StorageManager.loadChat();
    elements.loginBtn?.addEventListener('click',()=>this.handleLogin());
    elements.nickInput?.addEventListener('keypress',e=>{if(e.key==='Enter') this.handleLogin();});
    elements.sendBtn?.addEventListener('click',()=>this.sendMessage());
    elements.input?.addEventListener('keypress',e=>{if(e.key==='Enter') this.sendMessage();});
  }
  static async handleLogin(){
    const nick=elements.nickInput?.value.trim(); if(!nick){ alert('Enter nickname'); return; }
    state.nickname=nick; StorageManager.saveUser(); await HackChatConnector.createClient(nick);
    UI.addSystem(`Connected as ${nick}`); elements.login.style.display='none'; state.localId=nick;
  }
  static async sendMessage(){
    const text=elements.input?.value.trim(); if(!text) return; elements.input.value=''; await HackChatConnector.sendChat(text);
  }
}

document.addEventListener('DOMContentLoaded',()=>{ App.init().catch(e=>Logger.error('Init failed',e)); });
