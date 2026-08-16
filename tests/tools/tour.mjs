import { chromium } from 'playwright-core';
process.env.PORT = '8801';
const mod = await import('/home/user/KoRoyale/server/index.js');
if (!mod.server.listening) await new Promise(r => mod.server.once('listening', r));

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--mute-audio'],
});
const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
p.on('pageerror', e => console.log('ERREUR:', String(e).slice(0, 200)));
await p.goto('http://127.0.0.1:8801/');
await p.waitForFunction(() => document.body.dataset.screen === 'menu', null, { timeout: 20000 });
await p.evaluate(() => window.KoRoyale.net.createRoom({ lobbySize: 10, fillWithBots: true }, false, 'Visite'));
await p.waitForFunction(() => document.body.dataset.screen === 'room', null, { timeout: 10000 });
await p.evaluate(() => window.KoRoyale.net.startMatch());
await p.waitForFunction(() => document.body.dataset.screen === 'playing', null, { timeout: 45000 });
await p.waitForFunction(() => window.KoRoyale.game?.latest, null, { timeout: 20000 });
await p.waitForTimeout(2000);

// on prend la main sur la camera pour la visite
await p.evaluate(() => {
  const g = window.KoRoyale.game;
  g.updateCamera = () => {};
  document.getElementById('hud').style.display = 'none';
});

const spots = [
  ['circuit-ligne-droite', -425, 30, -40, 0.35, -0.28],
  ['circuit-epingle-fairmont', 86, 55, 430, 0.2, -0.5],
  ['circuit-tunnel', 281, 13.5, 240, 0.02, 0.02],
  ['circuit-tunnel-vue-large', 240, 40, 180, 0.55, -0.22],
  ['place-du-casino', -75, 70, 540, 0.0, -0.3],
  ['port-hercule', -120, 60, 120, 0.05, -0.28],
  ['le-rocher-vieille-ville', -620, 110, 60, 0.0, -0.42],
  ['mont-chevre', -140, 260, -700, 0.0, -0.28],
];

for (const [name, x, y, z, yaw, pitch] of spots) {
  await p.evaluate(([x, y, z, yaw, pitch]) => {
    const g = window.KoRoyale.game;
    g.camera.position.set(x, y, z);
    g.camera.rotation.order = 'YXZ';
    g.camera.rotation.set(pitch, yaw + Math.PI, 0);
    g.camera.fov = 70;
    g.camera.updateProjectionMatrix();
  }, [x, y, z, yaw, pitch]);
  await p.waitForTimeout(1400);
  await p.screenshot({ path: `/home/user/KoRoyale/tests/screenshots/tour-${name}.png` });
  console.log('capture', name);
}

await b.close();
mod.server.close();
process.exit(0);
