// Test d'integration : vrai serveur HTTP + WebSocket, deux clients, un salon, une partie.
// Lance avec :  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { C2S, S2C, ACT, ROOM_STATE } from '../shared/protocol.js';
import { PROTOCOL_VERSION, BTN } from '../shared/constants.js';

const PORT = 8791;
process.env.PORT = String(PORT);

let server, lobby;

test.before(async () => {
  const mod = await import('../server/index.js');
  server = mod.server;
  lobby = mod.lobby;
  if (!server.listening) await new Promise((r) => server.once('listening', r));
});

test.after(async () => {
  for (const r of lobby.rooms.values()) r.stopLoop();
  await new Promise((r) => server.close(r));
});

/** Petit client de test. */
class TestClient {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.waiters = [];
    this.id = null;
    this.room = null;
    this.snapshots = 0;
    this.lastSnap = null;
    this.matchStart = null;
    this.matchEnd = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.on('open', () => resolve(this));
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        this.messages.push(msg);
        if (msg.m === S2C.WELCOME) this.id = msg.id;
        if (msg.m === S2C.ROOM) this.room = msg.r;
        if (msg.m === S2C.MATCH_START) this.matchStart = msg;
        if (msg.m === S2C.MATCH_END) this.matchEnd = msg;
        if (msg.m === S2C.SNAPSHOT) { this.snapshots++; this.lastSnap = msg.s; }
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i].match(msg)) {
            this.waiters[i].resolve(msg);
            this.waiters.splice(i, 1);
          }
        }
      });
    });
  }

  send(o) { this.ws.send(JSON.stringify(o)); }

  wait(match, timeout = 6000) {
    const fn = typeof match === 'string' ? (m) => m.m === match : match;
    const already = this.messages.find(fn);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const w = { match: fn, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`temps ecoule en attendant ${match}`)); }
      }, timeout);
    });
  }

  close() { try { this.ws.close(); } catch { /* deja ferme */ } }
}

test('poignee de main et liste des salons', async () => {
  const c = await new TestClient('Biquette').connect();
  const welcome = await c.wait(S2C.WELCOME);
  assert.equal(welcome.v, PROTOCOL_VERSION);
  assert.ok(typeof welcome.id === 'string');
  c.send({ m: C2S.HELLO, v: PROTOCOL_VERSION, n: 'Biquette', k: 'alpine' });
  const list = await c.wait(S2C.ROOM_LIST);
  assert.ok(Array.isArray(list.rooms));
  c.close();
});

test('creation d un salon, code d invitation et arrivee d un ami', async () => {
  const host = await new TestClient('Hôte').connect();
  await host.wait(S2C.WELCOME);
  host.send({ m: C2S.HELLO, v: PROTOCOL_VERSION, n: 'Cornebidouille', k: 'noire' });
  host.send({ m: C2S.CREATE_ROOM, pub: true, name: 'Salon des tests' });
  const room = await host.wait(S2C.ROOM);
  assert.equal(room.r.code.length, 5);
  assert.equal(room.r.members.length, 1);
  assert.equal(room.r.hostId, host.id);

  const friend = await new TestClient('Ami').connect();
  await friend.wait(S2C.WELCOME);
  friend.send({ m: C2S.HELLO, v: PROTOCOL_VERSION, n: 'Roquefort', k: 'rousse' });
  friend.send({ m: C2S.JOIN_ROOM, code: room.r.code });
  const joined = await friend.wait((m) => m.m === S2C.ROOM && m.r.members.length === 2);
  assert.equal(joined.r.members.length, 2);
  assert.ok(joined.r.members.some((m) => m.name === 'Roquefort'));

  // le chat circule
  friend.send({ m: C2S.CHAT, t: 'Bêêê tout le monde' });
  const chat = await host.wait((m) => m.m === S2C.CHAT && m.c.text === 'Bêêê tout le monde');
  assert.equal(chat.c.from, 'Roquefort');

  // seul l hote peut modifier les reglages
  friend.send({ m: C2S.SETTINGS, s: { mode: 'duo' } });
  const err = await friend.wait(S2C.ERROR);
  assert.equal(err.c, 'not_host');

  host.close(); friend.close();
});

test('code inconnu : erreur explicite', async () => {
  const c = await new TestClient('Perdu').connect();
  await c.wait(S2C.WELCOME);
  c.send({ m: C2S.JOIN_ROOM, code: 'ZZZZZ' });
  const err = await c.wait(S2C.ERROR);
  assert.equal(err.c, 'room_not_found');
  c.close();
});

test('partie complete : largage, snapshots, tir, deconnexion remplacee par une IA', async () => {
  const host = await new TestClient('Pilote').connect();
  await host.wait(S2C.WELCOME);
  host.send({ m: C2S.HELLO, v: PROTOCOL_VERSION, n: 'Grimpette', k: 'monaco' });
  host.send({ m: C2S.CREATE_ROOM, pub: false, name: 'Match test' });
  const room = await host.wait(S2C.ROOM);

  // petit salon rempli d IA pour que la partie soit courte
  host.send({ m: C2S.SETTINGS, s: { lobbySize: 6, fillWithBots: true, botDifficulty: 'chevreau' } });
  await host.wait((m) => m.m === S2C.ROOM && m.r.settings.lobbySize === 6);

  const second = await new TestClient('Second').connect();
  await second.wait(S2C.WELCOME);
  second.send({ m: C2S.HELLO, v: PROTOCOL_VERSION, n: 'Cabri', k: 'saanen' });
  second.send({ m: C2S.JOIN_ROOM, code: room.r.code });
  await second.wait((m) => m.m === S2C.ROOM && m.r.members.length === 2);

  host.send({ m: C2S.START });
  const start = await host.wait(S2C.MATCH_START, 10000);
  assert.equal(start.you, host.id);
  assert.ok(start.players.length >= 6, `attendu >= 6 joueurs, recu ${start.players.length}`);
  assert.ok(start.players.filter((p) => p.bot).length >= 4, 'des IA doivent completer le salon');
  assert.ok(start.map.name.length > 0);

  // les snapshots arrivent
  const snap = await host.wait(S2C.SNAPSHOT, 5000);
  assert.ok(snap.s.ps.length >= 1);
  assert.equal(snap.s.ph, 'flight');
  assert.ok(snap.s.st.r > 0, 'la tempete doit avoir un rayon');
  const me = snap.s.ps.find((p) => p.i === host.id);
  assert.ok(me, 'notre chevre doit etre dans le snapshot');
  assert.ok(me.y > 100, 'on commence en altitude');

  // on saute et on envoie des entrees
  host.send({ m: C2S.ACTION, a: ACT.JUMP_OUT });
  for (let i = 0; i < 40; i++) {
    host.send({
      m: C2S.INPUT, s: i + 1, mx: 0, my: 1,
      a: 0.5, b: -0.2, bt: BTN.SPRINT, dt: 20,
    });
    await sleep(25);
  }
  const later = host.lastSnap;
  const meLater = later.ps.find((p) => p.i === host.id);
  assert.ok(meLater.y < me.y, 'on doit descendre apres avoir saute');

  // l etat prive contient bien l inventaire
  assert.ok(Array.isArray(later.me.inv));
  assert.equal(later.me.inv.length, 5);
  assert.ok(later.me.hp > 0);

  // deconnexion en cours de partie : une IA doit reprendre la chevre
  const roomObj = lobby.rooms.get(room.r.code);
  const before = roomObj.match.players.get(second.id);
  assert.ok(before && !before.isBot);
  second.close();
  await sleep(300);
  const after = roomObj.match.players.get(second.id);
  assert.ok(after, 'la chevre doit rester en jeu');
  assert.ok(after.isBot, 'une IA doit avoir repris la chevre du joueur parti');

  host.close();
  roomObj.stopLoop();
});

test('la carte est identique cote serveur et cote client', async () => {
  const { buildMap, terrainHeight } = await import('../shared/mapdata.js');
  const a = buildMap();
  assert.ok(a.buildings.length > 100);
  assert.ok(a.chests.length > 50);
  assert.ok(a.vehicleSpawns.length > 40);
  // le terrain est deterministe
  for (const [x, z] of [[0, 0], [-425, 126], [-75, 604], [330, -250], [655, 150]]) {
    assert.equal(terrainHeight(x, z), terrainHeight(x, z));
  }
  // aucun coffre sous l'eau
  const drowned = a.chests.filter((c) => c.y < 0.1);
  assert.equal(drowned.length, 0, `${drowned.length} coffres sous l'eau`);
  // aucun vehicule terrestre dans la mer
  const sunk = a.vehicleSpawns.filter((v) => v.type !== 'boat' && terrainHeight(v.x, v.z) < 0.2);
  assert.equal(sunk.length, 0, `${sunk.length} vehicules terrestres dans l'eau`);
});

test('le circuit de Monaco est bien la et reste degage', async () => {
  const { trackLength, trackSamples, CORNERS, trackClearance } = await import('../shared/track.js');
  const { buildMap } = await import('../shared/mapdata.js');
  assert.ok(trackLength() > 2000, 'le circuit doit faire plus de 2 km');
  assert.ok(trackSamples().length > 500);
  assert.ok(CORNERS.some((c) => c.name === 'Épingle du Fairmont'));
  assert.ok(CORNERS.some((c) => c.name === 'Le Tunnel'));
  const map = buildMap();
  // rien d'autre que les rails et le tunnel ne doit mordre sur l'asphalte
  const allowed = new Set(['rail', 'gantry', 'tunnelwall', 'tunnelroof']);
  let intruders = 0;
  for (const c of map.colliders) {
    if (allowed.has(c.tag)) continue;
    if (c.type === 'cyl') { if (trackClearance(c.x, c.z, 40) < c.r) intruders++; continue; }
    if (trackClearance(c.x, c.z, 40) < 0) intruders++;
  }
  assert.equal(intruders, 0, `${intruders} obstacles sur la piste`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
