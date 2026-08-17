#!/usr/bin/env node
// Superviseur de serveur pour Codespace (ou n'importe quel hote long-duree).
//
//   - lance le serveur de jeu et le relance s'il tombe ;
//   - interroge GitHub toutes les 30 s ; des qu'un commit arrive sur la branche
//     suivie, il le recupere, reinstalle les dependances si elles ont bouge,
//     et redemarre le serveur ;
//   - reaffirme reguliegrement la visibilite publique du port redirige.
//
// Reglages par variables d'environnement :
//   PORT                  port du serveur           (defaut 8080)
//   KOROYALE_POLL_MS      intervalle de scrutation  (defaut 30000)
//   KOROYALE_BRANCH       branche suivie            (defaut : la branche courante)
//   KOROYALE_CMD          commande du serveur       (defaut « node server/index.js »)
//   KOROYALE_NO_PULL=1    ne met pas a jour depuis git
//   KOROYALE_NO_PORT=1    ne touche pas a la visibilite du port

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLL_MS = Number(process.env.KOROYALE_POLL_MS) || 30_000;
const PORT = process.env.PORT || '8080';
const CMD = process.env.KOROYALE_CMD || 'node server/index.js';
const PULL = process.env.KOROYALE_NO_PULL !== '1';
const PORTS = process.env.KOROYALE_NO_PORT !== '1';
const PORT_REASSERT_MS = 120_000;

let child = null;
let stopping = false;
let restarting = false;
let lastPortAssert = 0;
let consecutiveCrashes = 0;

const log = (...a) => console.log(`[superviseur ${new Date().toLocaleTimeString('fr-FR')}]`, ...a);

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function currentBranch() {
  if (process.env.KOROYALE_BRANCH) return process.env.KOROYALE_BRANCH;
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok && r.out !== 'HEAD' ? r.out : 'main';
}

const BRANCH = currentBranch();

// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------

function startServer() {
  const [bin, ...args] = CMD.split(' ');
  child = spawn(bin, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PORT },
  });
  const started = Date.now();
  log(`serveur lancé (${CMD}) sur le port ${PORT}`);

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping || restarting) return;
    // un arret immediat = probablement une erreur de code : on ralentit les tentatives
    const alive = Date.now() - started;
    consecutiveCrashes = alive < 5000 ? consecutiveCrashes + 1 : 0;
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(consecutiveCrashes, 5));
    log(`serveur arrêté (code ${code ?? signal}) — relance dans ${Math.round(wait / 1000)} s`);
    setTimeout(() => { if (!stopping) startServer(); }, wait);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const c = child;
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* deja mort */ } }, 4000);
    c.once('exit', done);
    try { c.kill('SIGTERM'); } catch { done(); }
  });
}

async function restartServer(reason) {
  restarting = true;
  log(`redémarrage — ${reason}`);
  await stopServer();
  restarting = false;
  consecutiveCrashes = 0;
  startServer();
}

// ---------------------------------------------------------------------------
// Mise a jour depuis GitHub
// ---------------------------------------------------------------------------

function checksum(file) {
  try { return fs.statSync(path.join(ROOT, file)).mtimeMs + ':' + fs.statSync(path.join(ROOT, file)).size; }
  catch { return ''; }
}

async function checkForUpdates() {
  if (!PULL) return;
  const fetched = git(['fetch', '--quiet', 'origin', BRANCH]);
  if (!fetched.ok) { log(`git fetch a échoué : ${fetched.err.split('\n')[0]}`); return; }

  const local = git(['rev-parse', 'HEAD']).out;
  const remote = git(['rev-parse', `origin/${BRANCH}`]).out;
  if (!local || !remote || local === remote) return;

  // On ne veut pas écraser du travail non commité. En revanche on ignore les fichiers
  // NON SUIVIS : `git reset --hard` ne les touche pas, et un package-lock.json généré
  // par npm bloquerait sinon toutes les mises à jour pour toujours.
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).out;
  if (dirty) {
    log('nouveaux commits disponibles, mais des modifications locales non commitées '
      + 'bloquent la mise à jour :\n' + dirty.split('\n').slice(0, 5).join('\n'));
    return;
  }

  const count = git(['rev-list', '--count', `HEAD..origin/${BRANCH}`]).out || '?';
  const subject = git(['log', '-1', '--pretty=%s', `origin/${BRANCH}`]).out;
  log(`${count} nouveau(x) commit(s) sur ${BRANCH} — « ${subject} »`);

  const lockBefore = checksum('package-lock.json') + checksum('package.json');
  const reset = git(['reset', '--hard', `origin/${BRANCH}`]);
  if (!reset.ok) { log(`git reset a échoué : ${reset.err.split('\n')[0]}`); return; }
  log(`code mis à jour → ${remote.slice(0, 8)}`);

  if (checksum('package-lock.json') + checksum('package.json') !== lockBefore) {
    log('les dépendances ont changé — npm install…');
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) log('npm install a échoué, on redémarre quand même avec ce qui est en place');
  }

  await restartServer('nouveau code récupéré');
  assertPortPublic(true);
}

// ---------------------------------------------------------------------------
// Visibilite du port (Codespaces)
// ---------------------------------------------------------------------------

function assertPortPublic(force = false) {
  if (!PORTS) return;
  const name = process.env.CODESPACE_NAME;
  if (!name) return; // pas dans un Codespace : rien a faire
  const now = Date.now();
  if (!force && now - lastPortAssert < PORT_REASSERT_MS) return;
  lastPortAssert = now;

  const r = spawnSync('gh', ['codespace', 'ports', 'visibility', `${PORT}:public`, '-c', name],
    { encoding: 'utf8', timeout: 20_000 });
  if (r.status === 0) {
    if (force) log(`port ${PORT} rendu public`);
    return;
  }
  const msg = ((r.stderr || '') + (r.stdout || '')).trim().split('\n')[0];
  if (!assertPortPublic._warned) {
    assertPortPublic._warned = true;
    log(`impossible de forcer la visibilité du port via gh (${msg || 'commande indisponible'}).`);
    log('Le devcontainer demande déjà "visibility": "public" ; sinon onglet PORTS → '
      + `clic droit sur ${PORT} → Port Visibility → Public.`);
  }
}

// ---------------------------------------------------------------------------

function banner() {
  const name = process.env.CODESPACE_NAME;
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  log('KoRoyale — superviseur');
  log(`branche suivie : ${BRANCH} | scrutation : ${POLL_MS / 1000} s`);
  if (name && domain) log(`adresse publique : https://${name}-${PORT}.${domain}`);
  else log(`adresse locale : http://localhost:${PORT}`);
}

async function main() {
  banner();
  assertPortPublic(true);
  startServer();

  const tick = async () => {
    if (stopping) return;
    try { await checkForUpdates(); } catch (e) { log('erreur de mise à jour :', e.message); }
    assertPortPublic(false);
  };
  setInterval(tick, POLL_MS);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    stopping = true;
    log('arrêt demandé');
    await stopServer();
    process.exit(0);
  });
}

main();
