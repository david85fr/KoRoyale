import { WebSocket } from 'ws';
import { C2S, S2C, ACT } from '/home/user/KoRoyale/shared/protocol.js';
import { PROTOCOL_VERSION, BTN } from '/home/user/KoRoyale/shared/constants.js';

const PORT = 8803;
process.env.PORT = String(PORT);
const mod = await import('/home/user/KoRoyale/server/index.js');
if (!mod.server.listening) await new Promise(r => mod.server.once('listening', r));
const { lobby, server } = mod;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let id = null, roomCode = null, started = false;
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.m === S2C.WELCOME) { id = m.id; console.log('· connecté', id); }
  if (m.m === S2C.ROOM) { roomCode = m.r.code; }
  if (m.m === S2C.MATCH_START) { started = true; console.log('· partie lancée'); }
  if (m.m === S2C.ERROR) console.log('· ERREUR serveur', m.c);
});
await new Promise(r => ws.on('open', r));
const send = (o) => ws.send(JSON.stringify(o));

send({ m: C2S.HELLO, v: PROTOCOL_VERSION, n: 'Cornu', k: 'monaco' });
send({ m: C2S.CREATE_ROOM, pub: false, name: 'Essais libres' });
await sleep(300);
console.log('· salon', roomCode);
send({ m: C2S.SETTINGS, s: { lobbySize: 2, fillWithBots: true } });
await sleep(200);
send({ m: C2S.START });
for (let i = 0; i < 100 && !started; i++) await sleep(150);
if (!started) { console.log('ÉCHEC : la partie ne démarre pas'); process.exit(1); }
await sleep(400);

const room = lobby.rooms.get(roomCode);
const match = room.match;
const me = match.players.get(id);
console.log('· joueurs', match.players.size, '| véhicules', match.vehicles.size);

const car = [...match.vehicles.values()].find(v => v.type === 'f1' && !v.occupied);
console.log('· voiture', car.id, 'à', car.x.toFixed(0), car.z.toFixed(0));
me.inPlane = false; me.gliding = false;
me.x = car.x + 1.5; me.z = car.z; me.y = car.y; me.vx = me.vy = me.vz = 0;

send({ m: C2S.ACTION, a: ACT.ENTER_VEHICLE });
await sleep(300);
console.log('· au volant ?', me.vehicleId === car.id, '| siège', me.seat);

const start = { x: car.x, z: car.z };
for (let i = 0; i < 90; i++) {
  send({ m: C2S.INPUT, s: 1000 + i, mx: 0, my: 1, a: car.yaw, b: 0, bt: 0, dt: 10 });
  await sleep(22);
}
const dist = Math.hypot(car.x - start.x, car.z - start.z);
console.log(`· parcouru ${dist.toFixed(1)} m à ${(car.speed * 3.6).toFixed(0)} km/h`);
console.log('· pilote solidaire ?', Math.hypot(me.x - car.x, me.z - car.z).toFixed(2), 'm');
send({ m: C2S.ACTION, a: ACT.EXIT_VEHICLE });
await sleep(300);
console.log('· descendu ?', me.vehicleId === null);

ws.close();
for (const r of lobby.rooms.values()) r.stopLoop();
server.close();
process.exit(0);
