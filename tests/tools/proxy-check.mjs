// Lance le serveur, un proxy devant, et joue une partie a travers le proxy.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

process.env.PORT = '8810';
const mod = await import('/home/user/KoRoyale/server/index.js');
if (!mod.server.listening) await new Promise(r => mod.server.once('listening', r));

const proxy = spawn(process.execPath, ['tests/tools/proxy.mjs', '9090', '8810'], { cwd: '/home/user/KoRoyale', stdio: 'inherit' });
await new Promise(r => setTimeout(r, 800));

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--mute-audio'],
});
const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 160)));
await p.goto('http://127.0.0.1:9090/');
await p.waitForFunction(() => document.body.dataset.screen === 'menu', null, { timeout: 25000 });
console.log('· menu affiché à travers le proxy');
const wsUrl = await p.evaluate(() => window.KoRoyale.net.url);
console.log('· URL WebSocket utilisée :', wsUrl);
await p.evaluate(() => window.KoRoyale.net.createRoom({ lobbySize: 4, fillWithBots: true }, false, 'Proxy'));
await p.waitForFunction(() => document.body.dataset.screen === 'room', null, { timeout: 12000 });
console.log('· salon créé, code', await p.evaluate(() => window.KoRoyale.room.code));
await p.evaluate(() => window.KoRoyale.net.startMatch());
await p.waitForFunction(() => document.body.dataset.screen === 'playing', null, { timeout: 45000 });
await p.waitForFunction(() => window.KoRoyale.game?.snapshots.length > 5, null, { timeout: 25000 });
const st = await p.evaluate(() => ({ snaps: window.KoRoyale.game.snapshots.length, ping: Math.round(window.KoRoyale.game.net.latency), alive: window.KoRoyale.game.latest.al }));
console.log('· partie en cours à travers le proxy :', JSON.stringify(st));
console.log(errs.length ? '· ERREURS : ' + errs.join(' | ') : '· aucune erreur JS');
await b.close(); proxy.kill(); mod.server.close(); process.exit(errs.length ? 1 : 0);
