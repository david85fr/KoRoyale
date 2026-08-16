// Un salon : la ou les amis se retrouvent avant la partie, puis la boucle de jeu.

import {
  ROOM, MATCH, TICK_DT, TICK_RATE, GOAT_NAMES, GOAT_SKINS, TEAM_MODES, BOT,
} from '../shared/constants.js';
import { S2C, ROOM_STATE, ERR, sanitizeName, sanitizeChat } from '../shared/protocol.js';
import { RNG } from '../shared/rng.js';
import { Match } from './match.js';
import { mapSummary } from './sim/world.js';

let _roomSeq = 0;

export class Room {
  constructor(lobby, opts = {}) {
    this.lobby = lobby;
    this.code = opts.code;
    this.id = `r${++_roomSeq}`;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.rng = new RNG(`${this.code}-${this.createdAt}`);

    this.settings = {
      mode: 'solo',
      lobbySize: MATCH.defaultLobbySize,
      fillWithBots: true,
      botDifficulty: 'biquette',
      friendlyFire: false,
      isPublic: opts.isPublic !== false,
      name: opts.name || 'Salon de chèvres',
    };

    this.members = new Map(); // id -> {id, name, skin, ready, conn, isHost}
    this.hostId = null;
    this.state = ROOM_STATE.LOBBY;
    this.chat = [];
    this.countdown = 0;
    this.match = null;
    this.timer = null;
    this.lastTickAt = 0;
    this.accumulator = 0;
    this.results = null;
    this.endTimer = 0;
    this.botSeq = 0;
    this.manualBots = []; // bots ajoutes explicitement par l'hote
  }

  // -------------------------------------------------------------------------

  get playerCount() { return this.members.size; }
  get totalSlots() { return this.settings.lobbySize; }
  get isFull() { return this.members.size >= this.settings.lobbySize; }
  get inGame() { return this.state === ROOM_STATE.PLAYING || this.state === ROOM_STATE.ENDED; }

  touch() { this.lastActivity = Date.now(); }

  add(conn, profile) {
    if (this.isFull) return { error: ERR.ROOM_FULL };
    if (this.inGame) return { error: ERR.ROOM_IN_GAME };
    const m = {
      id: conn.id,
      name: sanitizeName(profile.name, this.rng.pick(GOAT_NAMES)),
      skin: GOAT_SKINS.some((s) => s.id === profile.skin) ? profile.skin : this.rng.pick(GOAT_SKINS).id,
      ready: false,
      conn,
      isBot: false,
    };
    this.members.set(m.id, m);
    conn.room = this;
    if (!this.hostId) this.hostId = m.id;
    this.touch();
    this.sysChat(`${m.name} rejoint le troupeau.`);
    this.broadcastRoom();
    return { ok: true, member: m };
  }

  remove(connId) {
    const m = this.members.get(connId);
    if (!m) return;
    this.members.delete(connId);
    if (m.conn) m.conn.room = null;
    this.touch();
    if (this.match && this.match.players.has(connId)) {
      // en pleine partie : une IA reprend la chevre pour ne pas fausser le classement
      if (!this.match.convertToBot(connId, this.settings.botDifficulty)) {
        this.match.removePlayer(connId);
      }
    }
    if (this.hostId === connId) {
      const next = [...this.members.values()][0];
      this.hostId = next ? next.id : null;
      if (next) this.sysChat(`${next.name} devient l’hôte.`);
    }
    if (!this.members.size) {
      this.stopLoop();
      this.lobby.destroyRoom(this);
      return;
    }
    this.sysChat(`${m.name} quitte le troupeau.`);
    this.broadcastRoom();
  }

  setProfile(connId, profile) {
    const m = this.members.get(connId);
    if (!m) return;
    if (profile.name) m.name = sanitizeName(profile.name, m.name);
    if (profile.skin && GOAT_SKINS.some((s) => s.id === profile.skin)) m.skin = profile.skin;
    this.broadcastRoom();
  }

  setReady(connId, ready) {
    const m = this.members.get(connId);
    if (!m) return;
    m.ready = !!ready;
    this.touch();
    this.broadcastRoom();
    this.maybeAutoStart();
  }

  updateSettings(connId, s) {
    if (connId !== this.hostId) return { error: ERR.NOT_HOST };
    if (this.inGame) return { error: ERR.ROOM_IN_GAME };
    if (s.mode && TEAM_MODES[s.mode]) this.settings.mode = s.mode;
    if (typeof s.lobbySize === 'number') {
      this.settings.lobbySize = Math.max(2, Math.min(MATCH.maxLobbySize, Math.round(s.lobbySize)));
    }
    if (typeof s.fillWithBots === 'boolean') this.settings.fillWithBots = s.fillWithBots;
    if (s.botDifficulty && BOT.difficulties.includes(s.botDifficulty)) this.settings.botDifficulty = s.botDifficulty;
    if (typeof s.friendlyFire === 'boolean') this.settings.friendlyFire = s.friendlyFire;
    if (typeof s.isPublic === 'boolean') this.settings.isPublic = s.isPublic;
    if (typeof s.name === 'string') this.settings.name = sanitizeChat(s.name).slice(0, 32) || this.settings.name;
    this.touch();
    this.broadcastRoom();
    return { ok: true };
  }

  addBot(connId) {
    if (connId !== this.hostId) return { error: ERR.NOT_HOST };
    if (this.manualBots.length + this.members.size >= this.settings.lobbySize) return { error: ERR.ROOM_FULL };
    this.manualBots.push({
      id: `bot_${this.id}_${++this.botSeq}`,
      name: this.uniqueBotName(),
      skin: this.rng.pick(GOAT_SKINS).id,
      difficulty: this.settings.botDifficulty,
    });
    this.broadcastRoom();
    return { ok: true };
  }

  removeBot(connId) {
    if (connId !== this.hostId) return { error: ERR.NOT_HOST };
    this.manualBots.pop();
    this.broadcastRoom();
    return { ok: true };
  }

  uniqueBotName() {
    const used = new Set([...this.members.values()].map((m) => m.name).concat(this.manualBots.map((b) => b.name)));
    for (let i = 0; i < 80; i++) {
      const n = this.rng.pick(GOAT_NAMES);
      if (!used.has(n)) return n;
    }
    return `${this.rng.pick(GOAT_NAMES)} ${this.rng.int(2, 99)}`;
  }

  kick(connId, targetId) {
    if (connId !== this.hostId) return { error: ERR.NOT_HOST };
    const t = this.members.get(targetId);
    if (!t || t.id === this.hostId) return { error: ERR.NOT_HOST };
    if (t.conn) {
      t.conn.send({ m: S2C.KICKED });
      t.conn.room = null;
    }
    this.members.delete(targetId);
    this.sysChat(`${t.name} a été exclu du troupeau.`);
    this.broadcastRoom();
    return { ok: true };
  }

  chatMessage(connId, text) {
    const m = this.members.get(connId);
    if (!m) return;
    const clean = sanitizeChat(text);
    if (!clean) return;
    const now = Date.now();
    if (m.lastChatAt && now - m.lastChatAt < 600) return;
    m.lastChatAt = now;
    this.pushChat({ from: m.name, id: m.id, text: clean, t: now });
  }

  sysChat(text) {
    this.pushChat({ from: null, text, t: Date.now(), sys: true });
  }

  pushChat(entry) {
    this.chat.push(entry);
    if (this.chat.length > ROOM.chatHistory) this.chat.shift();
    this.broadcast({ m: S2C.CHAT, c: entry });
  }

  // -------------------------------------------------------------------------
  // Demarrage
  // -------------------------------------------------------------------------

  maybeAutoStart() {
    if (this.state !== ROOM_STATE.LOBBY) return;
    if (this.members.size < 1) return;
    const all = [...this.members.values()].every((m) => m.ready);
    if (all && this.members.size >= 1) this.beginCountdown();
  }

  requestStart(connId) {
    if (connId !== this.hostId) return { error: ERR.NOT_HOST };
    if (this.state !== ROOM_STATE.LOBBY) return { error: ERR.ROOM_IN_GAME };
    this.beginCountdown();
    return { ok: true };
  }

  beginCountdown() {
    this.state = ROOM_STATE.COUNTDOWN;
    this.countdown = MATCH.countdownSeconds;
    this.broadcastRoom();
    this.startLoop();
  }

  buildRoster() {
    const roster = [];
    for (const m of this.members.values()) {
      roster.push({ id: m.id, name: m.name, skin: m.skin, isBot: false, conn: m.conn });
    }
    for (const b of this.manualBots) {
      roster.push({ id: b.id, name: b.name, skin: b.skin, isBot: true, difficulty: b.difficulty });
    }
    // remplissage automatique : c'est ce qui permet de jouer meme tout seul
    if (this.settings.fillWithBots) {
      const target = Math.max(MATCH.minPlayers, this.settings.lobbySize);
      while (roster.length < target) {
        roster.push({
          id: `bot_${this.id}_${++this.botSeq}`,
          name: this.uniqueBotName(),
          skin: this.rng.pick(GOAT_SKINS).id,
          isBot: true,
          difficulty: this.rng.weighted([
            { d: 'chevreau', weight: 3 }, { d: 'biquette', weight: 5 },
            { d: 'bouc', weight: 3 }, { d: 'bouquetin', weight: 1 },
          ]).d,
        });
      }
    }
    return roster;
  }

  startMatch() {
    const roster = this.buildRoster();
    this.match = new Match({
      mode: this.settings.mode,
      friendlyFire: this.settings.friendlyFire,
      seed: `${this.code}-${Date.now()}`,
      onEnd: (results) => this.onMatchEnd(results),
    });
    this.match.start(roster);
    this.state = ROOM_STATE.PLAYING;
    this.lastSentTick = new Map();

    const summary = mapSummary();
    for (const m of this.members.values()) {
      if (!m.conn) continue;
      m.conn.send({
        m: S2C.MATCH_START,
        you: m.id,
        map: summary,
        mode: this.settings.mode,
        teamSize: this.match.teamSize,
        players: roster.map((r) => ({ i: r.id, n: r.name, k: r.skin, bot: r.isBot ? 1 : 0 })),
        tickRate: TICK_RATE,
      });
    }
    this.broadcastRoom();
  }

  onMatchEnd(results) {
    this.results = results;
    this.state = ROOM_STATE.ENDED;
    this.endTimer = MATCH.endDelay;
    this.broadcast({ m: S2C.MATCH_END, r: results, sb: this.match.scoreboard() });
  }

  backToLobby() {
    this.match = null;
    this.results = null;
    this.state = ROOM_STATE.LOBBY;
    this.manualBots.length = 0;
    for (const m of this.members.values()) m.ready = false;
    this.stopLoop();
    this.broadcastRoom();
  }

  // -------------------------------------------------------------------------
  // Boucle
  // -------------------------------------------------------------------------

  startLoop() {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.accumulator = 0;
    this.timer = setInterval(() => this.loop(), 1000 / TICK_RATE);
  }

  stopLoop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  loop() {
    const now = Date.now();
    let dt = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    if (dt > 0.5) dt = 0.5; // on ne rattrape pas un gros retard

    if (this.state === ROOM_STATE.COUNTDOWN) {
      this.countdown -= dt;
      this.broadcast({ m: S2C.COUNTDOWN, t: Math.max(0, Math.ceil(this.countdown)) });
      if (this.countdown <= 0) this.startMatch();
      return;
    }

    if (this.state === ROOM_STATE.ENDED) {
      this.endTimer -= dt;
      if (this.endTimer <= 0) this.backToLobby();
      return;
    }

    if (this.state !== ROOM_STATE.PLAYING || !this.match) return;

    // pas fixe : la simulation doit etre reproductible
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= TICK_DT && steps < 5) {
      this.match.update(TICK_DT);
      this.accumulator -= TICK_DT;
      steps++;
    }
    if (steps === 0) return;

    this.sendSnapshots();
    this.match.clearOldEvents();
  }

  sendSnapshots() {
    const match = this.match;
    for (const m of this.members.values()) {
      if (!m.conn || !m.conn.isOpen()) continue;
      const p = match.players.get(m.id);
      if (!p) continue;
      // un joueur mort suit un survivant
      const view = p.alive ? p : (match.players.get(p.spectateTarget) || match.aliveList()[0] || p);
      const snap = match.snapshotFor(view);
      snap.me = p.packSelf();
      snap.spec = view !== p ? view.id : null;
      const since = this.lastSentTick.get(m.id) ?? 0;
      const evs = match.eventsFor(view, since);
      if (evs.length) snap.ev = evs;
      this.lastSentTick.set(m.id, match.tick);
      m.conn.send({ m: S2C.SNAPSHOT, s: snap });
    }
    // tableau des scores : 2 fois par seconde
    if (match.tick % 10 === 0) {
      this.broadcast({ m: S2C.EVENTS, sb: match.scoreboard() });
    }
  }

  // -------------------------------------------------------------------------
  // Reseau
  // -------------------------------------------------------------------------

  broadcast(msg) {
    for (const m of this.members.values()) {
      if (m.conn && m.conn.isOpen()) m.conn.send(msg);
    }
  }

  serialize() {
    return {
      code: this.code,
      name: this.settings.name,
      state: this.state,
      hostId: this.hostId,
      countdown: Math.max(0, Math.ceil(this.countdown)),
      settings: this.settings,
      members: [...this.members.values()].map((m) => ({
        id: m.id, name: m.name, skin: m.skin, ready: m.ready,
        host: m.id === this.hostId, bot: false,
      })),
      bots: this.manualBots.map((b) => ({ id: b.id, name: b.name, skin: b.skin, bot: true, difficulty: b.difficulty })),
      autoFill: this.settings.fillWithBots
        ? Math.max(0, this.settings.lobbySize - this.members.size - this.manualBots.length)
        : 0,
      chat: this.chat.slice(-25),
    };
  }

  broadcastRoom() {
    this.broadcast({ m: S2C.ROOM, r: this.serialize() });
  }
}
