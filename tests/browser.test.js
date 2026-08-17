// Test de bout en bout dans un vrai navigateur : on lance le serveur, on ouvre le jeu
// dans Chromium, on cree un salon, on lance une partie et on verifie que ca tourne.
// Les captures d'ecran sont ecrites dans tests/screenshots/.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = 8793;
process.env.PORT = String(PORT);

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let server, lobby, browser, page;
const consoleErrors = [];
const pageErrors = [];

test.before(async () => {
  await fs.mkdir(SHOTS, { recursive: true });
  const mod = await import('../server/index.js');
  server = mod.server; lobby = mod.lobby;
  if (!server.listening) await new Promise((r) => server.once('listening', r));

  browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--disable-gpu-sandbox', '--mute-audio',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
});

test.after(async () => {
  await browser?.close();
  for (const r of lobby.rooms.values()) r.stopLoop();
  await new Promise((r) => server.close(r));
});

test('la page se charge et affiche le menu', async () => {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.screen === 'menu', null, { timeout: 20000 });
  await page.screenshot({ path: path.join(SHOTS, '1-menu.png') });
  const title = await page.title();
  assert.match(title, /KoRoyale/);
  assert.deepEqual(pageErrors, [], `erreurs JS au chargement :\n${pageErrors.join('\n')}`);
});

test('creation d un salon et affichage du code d invitation', async () => {
  await page.evaluate(() => window.KoRoyale.net.createRoom({ lobbySize: 8, fillWithBots: true, botDifficulty: 'chevreau' }, false, 'Salon navigateur'));
  await page.waitForFunction(() => document.body.dataset.screen === 'room', null, { timeout: 10000 });
  const code = await page.evaluate(() => window.KoRoyale.room?.code);
  assert.equal(typeof code, 'string');
  assert.equal(code.length, 5);
  // le code doit etre visible quelque part a l'ecran
  const text = await page.evaluate(() => document.getElementById('ui').innerText);
  assert.ok(text.includes(code), `le code ${code} doit apparaitre dans le salon`);
  await page.screenshot({ path: path.join(SHOTS, '2-salon.png') });
  assert.deepEqual(pageErrors, [], `erreurs JS dans le salon :\n${pageErrors.join('\n')}`);
});

test('lancement de la partie : le monde 3D se construit et tourne', async () => {
  await page.evaluate(() => window.KoRoyale.net.startMatch());
  await page.waitForFunction(() => document.body.dataset.screen === 'playing', null, { timeout: 45000 });

  // on attend que des snapshots arrivent et que le rendu ait demarre
  await page.waitForFunction(
    () => window.KoRoyale.game && window.KoRoyale.game.latest && window.KoRoyale.game.snapshots.length > 3,
    null, { timeout: 25000 },
  );
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(SHOTS, '3-largage.png') });

  const stats = await page.evaluate(() => {
    const g = window.KoRoyale.game;
    return {
      fps: Math.round(g.fps),
      players: g.players.size,
      vehicles: g.vehicles.size,
      snapshots: g.snapshots.length,
      phase: g.latest.ph,
      alive: g.latest.al,
      hasWorld: !!g.world,
      camY: g.camera.position.y,
      renderCalls: g.renderer.info.render.calls,
      triangles: g.renderer.info.render.triangles,
      ping: Math.round(g.net.latency),
      // garde-fou : l'accumulateur du pas fixe doit rester positif. S'il part en dette
      // (horodatage d'image anterieur au demarrage), plus aucune entree n'est envoyee
      // et la chevre reste figee tout le reste de la partie.
      accumulator: g.accumulator,
      inputSeq: g.net.inputSeq,
    };
  });
  console.log('    ', JSON.stringify(stats));
  assert.ok(stats.accumulator >= 0 && stats.accumulator < 1,
    `l accumulateur du pas fixe doit rester sain (${stats.accumulator})`);
  assert.ok(stats.inputSeq > 0, 'le client doit envoyer ses entrees au serveur');
  assert.ok(stats.players >= 1, 'au moins notre chevre doit etre rendue');
  assert.ok(stats.hasWorld, 'le monde doit etre construit');
  assert.ok(stats.triangles > 1000, `le rendu doit produire de la geometrie (${stats.triangles})`);
  assert.ok(stats.renderCalls > 0, 'il doit y avoir des appels de rendu');
  assert.ok(stats.alive >= 6, `le salon doit avoir ete rempli d IA (${stats.alive})`);
});

test('le joueur saute, atterrit et se deplace', async () => {
  // sortir de l'avion
  await page.evaluate(() => window.KoRoyale.net.action('jump'));
  // attendre l'atterrissage (au plus 60 s de jeu)
  await page.waitForFunction(
    () => window.KoRoyale.game?.latest?.me?.gl === 0,
    null, { timeout: 60000 },
  );
  const landed = await page.evaluate(() => {
    const g = window.KoRoyale.game;
    return { x: g.local.x, y: g.local.y, z: g.local.z, onGround: g.local.onGround };
  });
  console.log('     atterrissage :', JSON.stringify(landed));
  assert.ok(landed.y > -2, 'on ne doit pas atterrir sous la mer');

  await page.screenshot({ path: path.join(SHOTS, '4-au-sol.png') });

  // Marcher : on presse Z/W (avant). On atterrit parfois nez contre un mur — un joueur
  // tournerait simplement, donc le test essaie jusqu'à trois caps avant de conclure.
  let moved = 0;
  for (let attempt = 0; attempt < 3 && moved <= 1.5; attempt++) {
    if (attempt > 0) {
      await page.evaluate((a) => window.KoRoyale.input.setYawPitch(a * 2.1, 0), attempt);
      await page.waitForTimeout(200);
    }
    const before = await page.evaluate(() => ({ x: window.KoRoyale.game.local.x, z: window.KoRoyale.game.local.z }));
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    });
    await page.waitForTimeout(1400);
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
    });
    const after = await page.evaluate(() => ({ x: window.KoRoyale.game.local.x, z: window.KoRoyale.game.local.z }));
    moved = Math.hypot(after.x - before.x, after.z - before.z);
    console.log(`     déplacement clavier (cap ${attempt + 1}) : ${moved.toFixed(2)} m`);
  }
  assert.ok(moved > 1.5, `le joueur doit avancer au clavier (${moved.toFixed(2)} m)`);

  await page.screenshot({ path: path.join(SHOTS, '5-en-jeu.png') });
});

test('le HUD affiche les informations vitales', async () => {
  const hudText = await page.evaluate(() => document.getElementById('hud').innerText);
  assert.ok(hudText.length > 0, 'le HUD doit afficher quelque chose');
  const view = await page.evaluate(() => {
    const g = window.KoRoyale.game;
    const v = g.buildView(g._frame);
    return { hp: v.health, slots: v.slots.length, alive: v.aliveCount, storm: v.storm.radius, zone: v.zone, fps: v.fps };
  });
  console.log('     HUD :', JSON.stringify(view));
  assert.equal(view.slots, 5);
  assert.ok(view.hp > 0);
  assert.ok(view.storm > 0);
  assert.ok(typeof view.zone === 'string' && view.zone.length > 0);
});

test('aucune erreur JavaScript pendant toute la session', async () => {
  // on ignore les avertissements connus et sans consequence
  const ignore = [/favicon/i, /AudioContext/i, /WebGL.*deprecat/i, /Automatic fallback to software WebGL/i];
  const real = pageErrors.concat(consoleErrors.filter((e) => !ignore.some((r) => r.test(e))));
  if (real.length) console.log('     erreurs :\n' + real.slice(0, 10).join('\n'));
  assert.equal(real.length, 0, `${real.length} erreur(s) JavaScript`);
});
