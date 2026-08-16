import { chromium } from 'playwright-core';
process.env.PORT = '8802';
const mod = await import('/home/user/KoRoyale/server/index.js');
if (!mod.server.listening) await new Promise(r => mod.server.once('listening', r));
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--mute-audio'],
});
const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await p.goto('http://127.0.0.1:8802/');
await p.waitForFunction(() => document.body.dataset.screen === 'menu', null, { timeout: 20000 });
await p.evaluate(() => window.KoRoyale.net.createRoom({ lobbySize: 6 }, false, 'T'));
await p.waitForFunction(() => document.body.dataset.screen === 'room', null, { timeout: 10000 });
await p.evaluate(() => window.KoRoyale.net.startMatch());
await p.waitForFunction(() => document.body.dataset.screen === 'playing', null, { timeout: 45000 });
await p.waitForFunction(() => window.KoRoyale.game?.latest, null, { timeout: 20000 });
await p.waitForTimeout(2500);

const shots = await p.evaluate(async () => {
  const { trackSamples, tunnelSpans } = await import('/shared/track.js');
  const g = window.KoRoyale.game;
  g.updateCamera = () => {};
  document.getElementById('hud').style.display = 'none';
  const ss = trackSamples();
  const span = tunnelSpans()[0];
  const out = [];
  for (const [name, idx, off] of [
    ['entree', span.from - 6, 0],
    ['dedans', Math.round((span.from + span.to) / 2), 0],
    ['sortie', span.to + 4, 0],
  ]) {
    const s = ss[((idx % ss.length) + ss.length) % ss.length];
    out.push([name, s.x, s.y + 1.6, s.z, Math.atan2(s.tx, s.tz) + off]);
  }
  window.__shots = out;
  return out.map(o => [o[0], o[1].toFixed(0), o[2].toFixed(0), o[3].toFixed(0)]);
});
console.log('positions :', JSON.stringify(shots));

for (let i = 0; i < shots.length; i++) {
  await p.evaluate((i) => {
    const g = window.KoRoyale.game;
    const [, x, y, z, yaw] = window.__shots[i];
    g.camera.position.set(x, y, z);
    g.camera.rotation.order = 'YXZ';
    g.camera.rotation.set(-0.02, yaw + Math.PI, 0);
    g.camera.fov = 78;
    g.camera.updateProjectionMatrix();
  }, i);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `/home/user/KoRoyale/tests/screenshots/tunnel-${shots[i][0]}.png` });
}
await b.close(); mod.server.close(); process.exit(0);
