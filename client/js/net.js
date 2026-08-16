// Couche reseau du client : WebSocket, reconnexion, mesure de latence.

import { PROTOCOL_VERSION } from '/shared/constants.js';
import { C2S, S2C, ACT } from '/shared/protocol.js';

export class Net {
  constructor(opts = {}) {
    this.url = opts.url || defaultUrl();
    this.handlers = new Map();
    this.ws = null;
    this.state = 'closed'; // closed | connecting | open
    this.latency = 0;
    this.serverOffset = 0;
    this.reconnectDelay = 500;
    this.wantOpen = false;
    this.queue = [];
    this.inputSeq = 0;
    this.id = null;
    this.pingTimer = null;
    this.bytesIn = 0;
    this.bytesOut = 0;
  }

  on(type, cb) {
    let list = this.handlers.get(type);
    if (!list) this.handlers.set(type, (list = []));
    list.push(cb);
    return this;
  }

  emit(type, payload) {
    const list = this.handlers.get(type);
    if (list) for (const cb of list) cb(payload);
  }

  connect() {
    this.wantOpen = true;
    if (this.ws && (this.state === 'open' || this.state === 'connecting')) return;
    this.state = 'connecting';
    this.emit('state', 'connecting');
    let ws;
    try { ws = new WebSocket(this.url); }
    catch { this.scheduleReconnect(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this.state = 'open';
      this.reconnectDelay = 500;
      this.emit('state', 'open');
      this.flush();
      this.startPing();
    };

    ws.onmessage = (ev) => {
      this.bytesIn += ev.data.length || 0;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.dispatch(msg);
    };

    ws.onclose = () => {
      this.state = 'closed';
      this.stopPing();
      this.emit('state', 'closed');
      if (this.wantOpen) this.scheduleReconnect();
    };

    ws.onerror = () => { /* onclose suit toujours */ };
  }

  disconnect() {
    this.wantOpen = false;
    this.stopPing();
    if (this.ws) { try { this.ws.close(); } catch { /* deja ferme */ } }
    this.ws = null;
    this.state = 'closed';
  }

  scheduleReconnect() {
    this.stopPing();
    setTimeout(() => { if (this.wantOpen) this.connect(); }, this.reconnectDelay);
    this.reconnectDelay = Math.min(8000, this.reconnectDelay * 1.8);
  }

  dispatch(msg) {
    switch (msg.m) {
      case S2C.WELCOME:
        this.id = msg.id;
        if (msg.v !== PROTOCOL_VERSION) this.emit('versionMismatch', msg.v);
        this.emit('welcome', msg);
        break;
      case S2C.PONG: {
        const rtt = performance.now() - msg.t;
        this.latency = this.latency ? this.latency * 0.7 + rtt * 0.3 : rtt;
        this.serverOffset = msg.s - (Date.now() - rtt / 2);
        break;
      }
      default:
        this.emit(msg.m, msg);
        break;
    }
    this.emit('*', msg);
  }

  startPing() {
    this.stopPing();
    const tick = () => this.send({ m: C2S.PING, t: performance.now() });
    tick();
    this.pingTimer = setInterval(tick, 2000);
  }

  stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  send(obj) {
    if (this.state !== 'open') {
      if (this.queue.length < 40) this.queue.push(obj);
      return;
    }
    const s = JSON.stringify(obj);
    this.bytesOut += s.length;
    try { this.ws.send(s); } catch { /* socket ferme */ }
  }

  flush() {
    const q = this.queue;
    this.queue = [];
    for (const m of q) this.send(m);
  }

  // -------------------------------------------------------------------------
  // Raccourcis
  // -------------------------------------------------------------------------

  hello(name, skin) { this.send({ m: C2S.HELLO, v: PROTOCOL_VERSION, n: name, k: skin }); }
  setProfile(name, skin) { this.send({ m: C2S.PROFILE, n: name, k: skin }); }
  createRoom(settings, isPublic = true, name) { this.send({ m: C2S.CREATE_ROOM, settings, pub: isPublic, name }); }
  joinRoom(code) { this.send({ m: C2S.JOIN_ROOM, code }); }
  quickPlay() { this.send({ m: C2S.QUICK_PLAY }); }
  leaveRoom() { this.send({ m: C2S.LEAVE_ROOM }); }
  setReady(r) { this.send({ m: C2S.READY, r }); }
  setSettings(s) { this.send({ m: C2S.SETTINGS, s }); }
  addBot() { this.send({ m: C2S.ADD_BOT }); }
  removeBot() { this.send({ m: C2S.REMOVE_BOT }); }
  kick(id) { this.send({ m: C2S.KICK, id }); }
  chat(t) { this.send({ m: C2S.CHAT, t }); }
  startMatch() { this.send({ m: C2S.START }); }
  action(a, extra) { this.send({ m: C2S.ACTION, a, ...extra }); }

  /**
   * Envoi d'une trame d'entree. Appele une fois par pas de simulation (20 Hz) : c'est
   * l'appelant qui fixe la cadence, pas nous — sinon deux pas dans la meme image
   * partageraient le meme numero de sequence et la reconciliation deraillerait.
   */
  sendInput(frame) {
    this.inputSeq++;
    this.send({
      m: C2S.INPUT,
      s: this.inputSeq,
      mx: Math.round(frame.moveX * 100) / 100,
      my: Math.round(frame.moveY * 100) / 100,
      a: Math.round(frame.yaw * 1000) / 1000,
      b: Math.round(frame.pitch * 1000) / 1000,
      bt: frame.buttons,
      dt: Math.round(this.latency),
    });
    return true;
  }
}

function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export { ACT, C2S, S2C };
