// Audit du blocage « le joueur n'envoie jamais d'entrée » (accumulateur du pas fixe en dette).
// Signature : au bout de 2 s de partie, net.inputSeq vaut toujours 0.
// Inutile d'attendre l'atterrissage : le blocage est présent dès le début de la partie.
import { chromium } from 'playwright-core';
process.env.PORT = '8823';
const mod = await import('/home/user/KoRoyale/server/index.js');
if (!mod.server.listening) await new Promise((r) => mod.server.once('listening', r));
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--mute-audio'],
});

const N = Number(process.argv[2]) || 30;
let bad = 0;
for (let run = 1; run <= N; run++) {
  const ctx = await b.newContext({ viewport: { width: 900, height: 600 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e && e.stack ? e.stack : e).split('\n').slice(0, 3).join(' | ')));
  await p.goto('http://127.0.0.1:8823/');
  await p.waitForFunction(() => document.body.dataset.screen === 'menu', null, { timeout: 25000 });
  await p.evaluate(() => window.KoRoyale.net.createRoom({ lobbySize: 4, fillWithBots: true }, false, 'R'));
  await p.waitForFunction(() => document.body.dataset.screen === 'room', null, { timeout: 12000 });
  await p.evaluate(() => window.KoRoyale.net.startMatch());
  await p.waitForFunction(() => document.body.dataset.screen === 'playing', null, { timeout: 45000 });
  await p.waitForFunction(() => window.KoRoyale.game?.latest, null, { timeout: 20000 });
  await p.waitForTimeout(2200);

  const d = await p.evaluate(() => {
    const g = window.KoRoyale.game;
    return {
      seq: g.net.inputSeq, sq: g.latest?.sq,
      acc: g.accumulator, accNaN: Number.isNaN(g.accumulator),
      fps: g.fps, fpsNaN: Number.isNaN(g.fps),
      lastFrame: g.lastFrame, lastFrameNaN: Number.isNaN(g.lastFrame),
      hasLocal: !!g.local, hasLatest: !!g.latest,
      running: g.running, paused: g.paused,
    };
  });
  if (d.seq === 0) {
    bad++;
    console.log(`run ${run}: BLOQUÉ ${JSON.stringify(d)}`);
    if (errs.length) console.log('   erreurs JS :', errs.slice(0, 3).join(' /// '));
  } else {
    console.log(`run ${run}: ok seq=${d.seq} acc=${d.acc.toFixed(3)} fps=${Math.round(d.fps)}`);
  }
  await ctx.close();
}
console.log(`\n${bad}/${N} bloqués`);
await b.close(); mod.server.close(); process.exit(0);
