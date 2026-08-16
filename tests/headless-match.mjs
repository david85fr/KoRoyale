// Simule une partie complete de bots, sans reseau, et verifie qu'elle se termine.
import { Match } from '../server/match.js';
import { GOAT_NAMES, GOAT_SKINS, TICK_DT, PSTATE } from '../shared/constants.js';

const N = Number(process.argv[2] || 30);
const MODE = process.argv[3] || 'solo';
const MAX_SECONDS = Number(process.argv[4] || 900);

const roster = [];
for (let i = 0; i < N; i++) {
  roster.push({
    id: `b${i}`, name: GOAT_NAMES[i % GOAT_NAMES.length] + (i >= GOAT_NAMES.length ? i : ''),
    skin: GOAT_SKINS[i % GOAT_SKINS.length].id, isBot: true,
    difficulty: ['chevreau', 'biquette', 'bouc', 'bouquetin'][i % 4],
  });
}

let ended = null;
const match = new Match({ mode: MODE, seed: 'test-headless', onEnd: (r) => { ended = r; } });
const t0 = Date.now();
match.start(roster);
console.log(`Partie ${MODE} : ${N} chèvres, carte ${match.world.map.name}`);

let ticks = 0;
const stats = { shots: 0, kills: 0, chests: 0, pickups: 0, vehEnter: 0, explosions: 0, downs: 0 };
let lastReport = 0;
let maxTickMs = 0;

while (!ended && match.time < MAX_SECONDS) {
  const ts = process.hrtime.bigint();
  match.update(TICK_DT);
  const ms = Number(process.hrtime.bigint() - ts) / 1e6;
  if (ms > maxTickMs) maxTickMs = ms;
  ticks++;
  for (const e of match.events) {
    if (e.k !== match.tick) continue;
    if (e.e === 'shot') stats.shots++;
    else if (e.e === 'kill') stats.kills++;
    else if (e.e === 'chest') stats.chests++;
    else if (e.e === 'pick') stats.pickups++;
    else if (e.e === 'vin') stats.vehEnter++;
    else if (e.e === 'boom') stats.explosions++;
    else if (e.e === 'down') stats.downs++;
  }
  match.clearOldEvents();
  if (match.time - lastReport >= 60) {
    lastReport = match.time;
    const inVeh = [...match.players.values()].filter((p) => p.vehicleId).length;
    const armed = [...match.players.values()].filter((p) => p.alive && p.weapon).length;
    console.log(`  t=${Math.round(match.time)}s  vivants=${match.aliveList().length}  armées=${armed}`
      + `  au volant=${inVeh}  cercle=${Math.round(match.storm.radius)}m  tirs=${stats.shots}  éliminations=${stats.kills}`);
  }
}

const wall = Date.now() - t0;
console.log('---');
console.log(ended ? `Fin de partie à t=${Math.round(match.time)}s` : `PAS DE FIN après ${MAX_SECONDS}s`);
if (ended) {
  console.log('Vainqueur(s) :', ended.winners.map((w) => `${w.name} (${w.kills} élim.)`).join(', '));
  console.log('Top 5 :', ended.placements.slice(0, 5).map((p) => `#${p.place} ${p.name}`).join('  '));
}
console.log('Stats :', JSON.stringify(stats));
console.log(`Perf : ${ticks} ticks en ${wall} ms → ${(wall / ticks).toFixed(2)} ms/tick (budget ${(TICK_DT * 1000).toFixed(0)} ms), pic ${maxTickMs.toFixed(1)} ms`);
const survivors = [...match.players.values()].filter((p) => p.state !== PSTATE.DEAD);
console.log('Survivants :', survivors.length, '| butin restant :', match.loot.loot.size, '| coffres ouverts :',
  [...match.loot.chests.values()].filter((c) => c.opened).length, '/', match.loot.chests.size);
console.log('Véhicules restants :', match.vehicles.size, '| détruits :', 101 - match.vehicles.size);
if (!ended) process.exitCode = 1;
