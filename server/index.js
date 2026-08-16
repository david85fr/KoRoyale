// Point d'entree : sert le client, expose le WebSocket, tient le hall.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { Lobby } from './lobby.js';
import { getWorld } from './sim/world.js';
import { PROTOCOL_VERSION } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');

// --- fichiers statiques -----------------------------------------------------
const staticOpts = { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, etag: true };
app.use(express.static(path.join(ROOT, 'client'), staticOpts));
app.use('/shared', express.static(path.join(ROOT, 'shared'), staticOpts));
// three.js est servi depuis node_modules : pas de copie dans le depot
app.use('/vendor/three.module.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js'));
});

app.get('/health', (req, res) => {
  res.json({ ok: true, v: PROTOCOL_VERSION, ...lobby.stats(), uptime: Math.round(process.uptime()) });
});

app.get('/api/rooms', (req, res) => {
  res.json({ rooms: lobby.publicRooms() });
});

// toute autre route renvoie le jeu (permet /?room=XXXXX et les liens partages)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.includes('.')) return next();
  res.sendFile(path.join(ROOT, 'client', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const lobby = new Lobby();

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();
  lobby.handleConnection(ws, ip);
});

// ping applicatif : on ferme les sockets muettes
const heartbeat = setInterval(() => {
  for (const conn of lobby.connections.values()) {
    if (!conn.alive) { try { conn.ws.terminate(); } catch { /* deja mort */ } continue; }
    conn.alive = false;
    try { conn.ws.ping(); } catch { /* deja mort */ }
  }
}, 30_000);
heartbeat.unref?.();

// --- prechauffage : on construit la carte avant d'accepter du monde ---------
const world = getWorld();
console.log(`[KoRoyale] carte « ${world.map.name} » construite en ${world.buildMs} ms`);
console.log(`[KoRoyale]   ${world.map.buildings.length} bâtiments, ${world.map.props.length} décors, `
  + `${world.map.colliders.length} colliders, ${world.map.chests.length} coffres, `
  + `${world.map.vehicleSpawns.length} véhicules`);

server.listen(PORT, HOST, () => {
  console.log(`[KoRoyale] à l'écoute sur http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

function shutdown(sig) {
  console.log(`[KoRoyale] arrêt (${sig})`);
  clearInterval(heartbeat);
  for (const r of lobby.rooms.values()) r.stopLoop();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server, lobby };
