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
  // server.close() attend la fermeture de chaque connexion : on coupe court
  for (const c of lobby.connections.values()) { try { c.ws.terminate(); } catch { /* deja mort */ } }
  await new Promise((r) => { server.close(r); setTimeout(r, 1500); });
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

test('un joueur monte dans une monoplace et la conduit', async () => {
  const host = await new TestClient('Pilote').connect();
  await host.wait(S2C.WELCOME);
  host.send({ m: C2S.HELLO, v: PROTOCOL_VERSION, n: 'Cornu', k: 'monaco' });
  host.send({ m: C2S.CREATE_ROOM, pub: false, name: 'Essais libres' });
  const room = await host.wait(S2C.ROOM);
  host.send({ m: C2S.SETTINGS, s: { lobbySize: 2, fillWithBots: true } });
  await host.wait((m) => m.m === S2C.ROOM && m.r.settings.lobbySize === 2);
  host.send({ m: C2S.START });
  await host.wait(S2C.MATCH_START, 12000);
  await host.wait(S2C.SNAPSHOT, 5000);

  const roomObj = lobby.rooms.get(room.r.code);
  const match = roomObj.match;
  const me = match.players.get(host.id);

  // on pose la chèvre au pied d'une monoplace sur la grille de départ
  // une monoplace bien seule : sur la grille de depart, on tamponnerait celle de devant
  const cars = [...match.vehicles.values()];
  const car = cars.find((v) => v.type === 'f1' && !v.occupied
    && !cars.some((o) => o !== v && Math.hypot(o.x - v.x, o.z - v.z) < 40));
  assert.ok(car, 'il doit y avoir une monoplace isolee');
  me.inPlane = false;
  me.gliding = false;
  me.x = car.x + 1.5; me.z = car.z; me.y = car.y;
  me.vx = me.vy = me.vz = 0;

  host.send({ m: C2S.ACTION, a: ACT.ENTER_VEHICLE });
  await sleep(250);
  assert.equal(me.vehicleId, car.id, 'la chèvre doit être montée dans la voiture');
  assert.equal(me.seat, 0, 'elle doit être au volant');

  // plein gaz, tout droit
  const start = { x: car.x, z: car.z };
  let peak = 0;
  for (let i = 0; i < 140; i++) {
    host.send({ m: C2S.INPUT, s: 1000 + i, mx: 0, my: 1, a: car.yaw, b: 0, bt: 0, dt: 10 });
    await sleep(22);
    peak = Math.max(peak, Math.abs(car.speed));
  }
  const dist = Math.hypot(car.x - start.x, car.z - start.z);
  console.log(`     la monoplace a parcouru ${dist.toFixed(1)} m, pointe ${(peak * 3.6).toFixed(0)} km/h`);
  // la voiture apparait en pleine campagne : arbres et rochers la freinent, et elle peut
  // finir arretee contre un obstacle — c'est la vitesse de pointe qui prouve qu'elle roule
  assert.ok(dist > 15, `la voiture doit rouler (${dist.toFixed(1)} m parcourus)`);
  assert.ok(peak > 6, `elle doit prendre de la vitesse (pointe ${peak.toFixed(1)} m/s)`);
  // le pilote suit son véhicule
  assert.ok(Math.hypot(me.x - car.x, me.z - car.z) < 3, 'le pilote doit rester dans la voiture');

  // et on en ressort
  host.send({ m: C2S.ACTION, a: ACT.EXIT_VEHICLE });
  await sleep(250);
  assert.equal(me.vehicleId, null, 'la chèvre doit pouvoir descendre');

  host.close();
  roomObj.stopLoop();
});

test('un coffre s ouvre et libère du butin', async () => {
  const host = await new TestClient('Fouilleur').connect();
  await host.wait(S2C.WELCOME);
  host.send({ m: C2S.HELLO, v: PROTOCOL_VERSION, n: 'Broutille', k: 'or' });
  host.send({ m: C2S.CREATE_ROOM, pub: false, name: 'Chasse au coffre' });
  const room = await host.wait(S2C.ROOM);
  host.send({ m: C2S.SETTINGS, s: { lobbySize: 2, fillWithBots: true } });
  await host.wait((m) => m.m === S2C.ROOM && m.r.settings.lobbySize === 2);
  host.send({ m: C2S.START });
  await host.wait(S2C.MATCH_START, 12000);
  await host.wait(S2C.SNAPSHOT, 5000);

  const roomObj = lobby.rooms.get(room.r.code);
  const match = roomObj.match;
  const me = match.players.get(host.id);
  const chest = [...match.loot.chests.values()].find((c) => !c.opened);
  assert.ok(chest, 'il doit y avoir des coffres');

  me.inPlane = false; me.gliding = false;
  me.x = chest.x + 1; me.z = chest.z; me.y = chest.y;
  const lootBefore = match.loot.loot.size;

  // maintenir la touche d'interaction ouvre le coffre
  for (let i = 0; i < 45; i++) {
    host.send({ m: C2S.INPUT, s: 2000 + i, mx: 0, my: 0, a: 0, b: 0, bt: BTN.USE, dt: 10 });
    me.x = chest.x + 1; me.z = chest.z; me.y = chest.y; // on reste collé au coffre
    await sleep(22);
  }
  assert.ok(chest.opened, 'le coffre doit s’être ouvert');
  const gained = match.loot.loot.size - lootBefore;
  console.log(`     le coffre a libéré ${gained} objets`);
  assert.ok(gained >= 2, `le coffre doit libérer du butin (${gained})`);

  // et on ramasse
  host.send({ m: C2S.ACTION, a: ACT.USE });
  await sleep(250);
  const hasSomething = me.slots.some(Boolean) || Object.values(me.ammo).some((n) => n > 0);
  assert.ok(hasSomething, 'la chèvre doit avoir ramassé quelque chose');

  host.close();
  roomObj.stopLoop();
});
