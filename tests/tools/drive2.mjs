import { WebSocket } from 'ws';
import { C2S, S2C, ACT } from '/home/user/KoRoyale/shared/protocol.js';
import { PROTOCOL_VERSION } from '/home/user/KoRoyale/shared/constants.js';
const PORT = 8804; process.env.PORT = String(PORT);
const mod = await import('/home/user/KoRoyale/server/index.js');
if (!mod.server.listening) await new Promise(r => mod.server.once('listening', r));
const { lobby, server } = mod;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let id, roomCode, started = false;
ws.on('message', d => { const m = JSON.parse(d.toString());
  if (m.m === S2C.WELCOME) id = m.id; if (m.m === S2C.ROOM) roomCode = m.r.code; if (m.m === S2C.MATCH_START) started = true; });
await new Promise(r => ws.on('open', r));
const send = o => ws.send(JSON.stringify(o));
send({ m: C2S.HELLO, v: PROTOCOL_VERSION, n: 'Cornu', k: 'monaco' });
send({ m: C2S.CREATE_ROOM, pub: false, name: 'T' });
await sleep(300);
send({ m: C2S.SETTINGS, s: { lobbySize: 2, fillWithBots: true } });
await sleep(200); send({ m: C2S.START });
for (let i = 0; i < 100 && !started; i++) await sleep(150);
await sleep(400);
const room = lobby.rooms.get(roomCode), match = room.match, me = match.players.get(id);
const cars = [...match.vehicles.values()];
for (const type of ['f1', 'buggy', 'scooter']) {
  const car = cars.find(v => v.type === type && !v.occupied && !cars.some(o => o !== v && Math.hypot(o.x - v.x, o.z - v.z) < 40));
  if (!car) { console.log(type, ': aucune isolée'); continue; }
  me.inPlane = false; me.gliding = false;
  me.x = car.x + 1.2; me.z = car.z; me.y = car.y; me.vx = me.vy = me.vz = 0;
  send({ m: C2S.ACTION, a: ACT.ENTER_VEHICLE }); await sleep(250);
  const s0 = { x: car.x, z: car.z };
  let peak = 0;
  for (let i = 0; i < 140; i++) {
    send({ m: C2S.INPUT, s: Date.now() % 100000 + i, mx: 0, my: 1, a: car.yaw, b: 0, bt: 0, dt: 10 });
    await sleep(22); peak = Math.max(peak, car.speed);
  }
  console.log(`${type.padEnd(8)} : ${Math.hypot(car.x - s0.x, car.z - s0.z).toFixed(0)} m parcourus, pointe ${(peak * 3.6).toFixed(0)} km/h, pilote à ${Math.hypot(me.x - car.x, me.z - car.z).toFixed(2)} m`);
  send({ m: C2S.ACTION, a: ACT.EXIT_VEHICLE }); await sleep(250);
}
ws.close(); for (const r of lobby.rooms.values()) r.stopLoop(); server.close(); process.exit(0);
