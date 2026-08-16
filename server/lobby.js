// Le hall : connexions WebSocket, annuaire des salons, aiguillage des messages.

import { PROTOCOL_VERSION, ROOM, MATCH } from '../shared/constants.js';
import {
  C2S, S2C, ERR, ERR_TEXT, ROOM_STATE, sanitizeName,
} from '../shared/protocol.js';
import { Room } from './room.js';

let _connSeq = 0;

class Connection {
  constructor(ws, ip) {
    this.id = `u${(++_connSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.ws = ws;
    this.ip = ip;
    this.room = null;
    this.profile = { name: 'Chèvre', skin: 'alpine' };
    this.alive = true;
    this.msgCount = 0;
    this.msgWindow = Date.now();
    this.joinedAt = Date.now();
  }

  isOpen() { return this.ws.readyState === 1; }

  send(obj) {
    if (!this.isOpen()) return;
    try { this.ws.send(JSON.stringify(obj)); } catch { /* socket ferme entre temps */ }
  }

  fail(code) {
    this.send({ m: S2C.ERROR, c: code, t: ERR_TEXT[code] || code });
  }
}

export class Lobby {
  constructor(opts = {}) {
    this.connections = new Map();
    this.rooms = new Map();
    this.maxConnections = opts.maxConnections || 400;
    setInterval(() => this.sweep(), 30_000).unref?.();
  }

  // -------------------------------------------------------------------------

  makeCode() {
    for (let attempt = 0; attempt < 500; attempt++) {
      let c = '';
      for (let i = 0; i < ROOM.codeLength; i++) {
        c += ROOM.codeAlphabet[Math.floor(Math.random() * ROOM.codeAlphabet.length)];
      }
      if (!this.rooms.has(c)) return c;
    }
    return null;
  }

  createRoom(opts = {}) {
    if (this.rooms.size >= ROOM.maxRooms) return null;
    const code = this.makeCode();
    if (!code) return null;
    const room = new Room(this, { code, ...opts });
    this.rooms.set(code, room);
    return room;
  }

  destroyRoom(room) {
    room.stopLoop();
    this.rooms.delete(room.code);
  }

  publicRooms() {
    const out = [];
    for (const r of this.rooms.values()) {
      if (!r.settings.isPublic) continue;
      out.push({
        code: r.code, name: r.settings.name, mode: r.settings.mode,
        players: r.members.size, size: r.settings.lobbySize, state: r.state,
      });
    }
    return out.sort((a, b) => b.players - a.players).slice(0, 30);
  }

  sweep() {
    const now = Date.now();
    for (const r of [...this.rooms.values()]) {
      const empty = r.members.size === 0;
      const stale = now - r.lastActivity > ROOM.idleTimeoutMs;
      if (empty || stale) this.destroyRoom(r);
    }
  }

  // -------------------------------------------------------------------------

  handleConnection(ws, ip) {
    if (this.connections.size >= this.maxConnections) {
      try { ws.send(JSON.stringify({ m: S2C.ERROR, c: ERR.SERVER_FULL, t: ERR_TEXT[ERR.SERVER_FULL] })); ws.close(); } catch { /* deja ferme */ }
      return;
    }
    const conn = new Connection(ws, ip);
    this.connections.set(conn.id, conn);

    ws.on('message', (data) => {
      if (!this.rateLimit(conn)) return;
      let msg;
      try { msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')); }
      catch { return; }
      if (!msg || typeof msg.m !== 'string') return;
      try { this.route(conn, msg); }
      catch (err) { console.error('[koroyale] erreur de traitement', msg.m, err); }
    });

    ws.on('close', () => this.dropConnection(conn));
    ws.on('error', () => this.dropConnection(conn));
    ws.on('pong', () => { conn.alive = true; });

    conn.send({
      m: S2C.WELCOME,
      id: conn.id,
      v: PROTOCOL_VERSION,
      rooms: this.publicRooms(),
      maxLobby: MATCH.maxLobbySize,
    });
  }

  dropConnection(conn) {
    if (!this.connections.has(conn.id)) return;
    this.connections.delete(conn.id);
    if (conn.room) conn.room.remove(conn.id);
  }

  rateLimit(conn) {
    const now = Date.now();
    if (now - conn.msgWindow > 1000) { conn.msgWindow = now; conn.msgCount = 0; }
    conn.msgCount++;
    // 40 inputs/s + actions + marge
    if (conn.msgCount > 180) {
      if (conn.msgCount === 181) conn.fail(ERR.RATE_LIMIT);
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------

  route(conn, msg) {
    switch (msg.m) {
      case C2S.HELLO:
        if (msg.v !== PROTOCOL_VERSION) { conn.fail(ERR.VERSION); return; }
        conn.profile.name = sanitizeName(msg.n, 'Chèvre');
        if (typeof msg.k === 'string') conn.profile.skin = msg.k;
        conn.send({ m: S2C.ROOM_LIST, rooms: this.publicRooms() });
        break;

      case C2S.PROFILE:
        conn.profile.name = sanitizeName(msg.n, conn.profile.name);
        if (typeof msg.k === 'string') conn.profile.skin = msg.k;
        if (conn.room) conn.room.setProfile(conn.id, conn.profile);
        break;

      case C2S.CREATE_ROOM: {
        if (conn.room) conn.room.remove(conn.id);
        const room = this.createRoom({ isPublic: msg.pub !== false, name: msg.name });
        if (!room) { conn.fail(ERR.SERVER_FULL); return; }
        const res = room.add(conn, conn.profile);
        if (res.error) { conn.fail(res.error); return; }
        if (msg.settings) room.updateSettings(conn.id, msg.settings);
        conn.send({ m: S2C.ROOM, r: room.serialize() });
        break;
      }

      case C2S.JOIN_ROOM: {
        const code = String(msg.code || '').toUpperCase().trim();
        const room = this.rooms.get(code);
        if (!room) { conn.fail(ERR.ROOM_NOT_FOUND); return; }
        if (conn.room === room) { conn.send({ m: S2C.ROOM, r: room.serialize() }); return; }
        if (conn.room) conn.room.remove(conn.id);
        const res = room.add(conn, conn.profile);
        if (res.error) { conn.fail(res.error); return; }
        conn.send({ m: S2C.ROOM, r: room.serialize() });
        break;
      }

      case C2S.QUICK_PLAY: {
        if (conn.room) conn.room.remove(conn.id);
        let room = null;
        for (const r of this.rooms.values()) {
          if (r.settings.isPublic && r.state === ROOM_STATE.LOBBY && !r.isFull) { room = r; break; }
        }
        if (!room) {
          room = this.createRoom({ isPublic: true, name: 'Partie rapide' });
          if (!room) { conn.fail(ERR.SERVER_FULL); return; }
        }
        const res = room.add(conn, conn.profile);
        if (res.error) { conn.fail(res.error); return; }
        conn.send({ m: S2C.ROOM, r: room.serialize() });
        break;
      }

      case C2S.LEAVE_ROOM:
        if (conn.room) conn.room.remove(conn.id);
        conn.send({ m: S2C.ROOM_LIST, rooms: this.publicRooms() });
        break;

      case C2S.READY:
        conn.room?.setReady(conn.id, !!msg.r);
        break;

      case C2S.SETTINGS: {
        const res = conn.room?.updateSettings(conn.id, msg.s || {});
        if (res?.error) conn.fail(res.error);
        break;
      }

      case C2S.ADD_BOT: {
        const res = conn.room?.addBot(conn.id);
        if (res?.error) conn.fail(res.error);
        break;
      }

      case C2S.REMOVE_BOT: {
        const res = conn.room?.removeBot(conn.id);
        if (res?.error) conn.fail(res.error);
        break;
      }

      case C2S.KICK: {
        const res = conn.room?.kick(conn.id, msg.id);
        if (res?.error) conn.fail(res.error);
        break;
      }

      case C2S.CHAT:
        conn.room?.chatMessage(conn.id, msg.t);
        break;

      case C2S.START: {
        const res = conn.room?.requestStart(conn.id);
        if (res?.error) conn.fail(res.error);
        break;
      }

      case C2S.INPUT:
        if (conn.room?.match) conn.room.match.applyInput(conn.id, msg);
        break;

      case C2S.ACTION:
        if (conn.room?.match) conn.room.match.applyAction(conn.id, msg);
        break;

      case C2S.RESPAWN_SPECTATE:
        if (conn.room?.match) conn.room.match.cycleSpectate(conn.room.match.players.get(conn.id));
        break;

      case C2S.PING:
        conn.send({ m: S2C.PONG, t: msg.t, s: Date.now() });
        break;

      default:
        break;
    }
  }

  stats() {
    return {
      connections: this.connections.size,
      rooms: this.rooms.size,
      playing: [...this.rooms.values()].filter((r) => r.state === ROOM_STATE.PLAYING).length,
      players: [...this.rooms.values()].reduce((a, r) => a + r.members.size, 0),
    };
  }
}
