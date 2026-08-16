// Circuit de Monaco — trace partage serveur / client.
//
// Le trace est defini par des points de controle (x, z, y, largeur) parcourus dans
// l'ordre d'une boucle fermee, puis lisses par une spline Catmull-Rom et re-echantillonnes
// a intervalle constant. Serveur et client construisent donc EXACTEMENT la meme geometrie.
//
// Repere : X vers l'est, Z vers le nord, Y vers le haut. Le circuit occupe la moitie
// nord de la carte ; le port Hercule est le bassin enferme par la boucle.

import { catmullRom, clamp, closestPointOnSegment, smoothstep } from './math.js';

/** Echelle appliquee aux coordonnees horizontales des points de controle. */
export const TRACK_SCALE = 1.55;
/** Decalage monde applique apres mise a l'echelle. */
export const TRACK_OFFSET = { x: 40, z: 80 };

/**
 * Points de controle du circuit, dans l'ordre de la course (sens horaire vu du ciel).
 * [x, z, y, largeur, drapeaux]
 * drapeaux : 't' = tunnel, 'p' = ligne des stands, 's' = ligne de depart/arrivee
 */
export const CONTROL_POINTS = [
  // --- Ligne droite des stands, quai Albert Ier, le long du port ---
  [-300, -70, 7.0, 15, 's'],
  [-301, -20, 7.0, 15, 'p'],
  [-300, 30, 7.2, 15, 'p'],
  [-299, 80, 7.6, 15, 'p'],
  [-297, 130, 8.6, 14, ''],
  // --- Sainte-Devote (droite serree) ---
  [-293, 164, 10.4, 12, ''],
  [-284, 186, 12.6, 10, ''],
  [-268, 202, 15.0, 11, ''],
  // --- Montee Beau Rivage ---
  [-248, 220, 18.4, 12, ''],
  [-228, 246, 22.6, 12, ''],
  [-208, 272, 27.2, 12, ''],
  [-188, 296, 31.6, 12, ''],
  // --- Massenet (gauche) ---
  [-166, 316, 35.4, 11, ''],
  [-140, 330, 38.6, 11, ''],
  // --- Place du Casino (droite) ---
  [-108, 337, 41.0, 13, ''],
  [-74, 338, 42.0, 13, ''],
  [-44, 333, 41.6, 12, ''],
  // --- Mirabeau Haute (droite) ---
  [-22, 322, 40.0, 10, ''],
  [-6, 306, 37.0, 10, ''],
  [4, 290, 34.0, 10, ''],
  // --- Descente vers l'epingle ---
  [10, 274, 31.4, 9, ''],
  [13, 262, 29.6, 8, ''],
  // --- Epingle du Fairmont (180 deg, la plus lente du championnat) ---
  [19, 252, 28.4, 8, ''],
  [30, 249, 28.0, 8, ''],
  [39, 257, 27.8, 8, ''],
  [43, 268, 27.4, 9, ''],
  // --- Mirabeau Bas ---
  [50, 282, 26.2, 10, ''],
  [62, 294, 24.6, 10, ''],
  [80, 299, 22.6, 10, ''],
  // --- Portier (droite en deux temps, sortie vers la mer) ---
  [102, 293, 20.0, 10, ''],
  [120, 279, 17.6, 10, ''],
  [133, 260, 15.4, 10, ''],
  [140, 238, 13.6, 11, ''],
  // --- Tunnel sous l'hotel (longue courbe a droite, plein gaz) ---
  [147, 212, 12.4, 12, 't'],
  [153, 186, 11.6, 12, 't'],
  [156, 158, 11.0, 12, 't'],
  [155, 130, 10.4, 12, 't'],
  [149, 106, 9.8, 12, 't'],
  [140, 86, 9.2, 12, ''],
  // --- Sortie du tunnel, descente vers la mer ---
  [128, 68, 8.6, 13, ''],
  [113, 54, 8.0, 13, ''],
  // --- Nouvelle chicane (gauche-droite) ---
  [99, 47, 7.6, 10, ''],
  [88, 41, 7.4, 9, ''],
  [76, 38, 7.2, 9, ''],
  [62, 32, 7.0, 11, ''],
  // --- Tabac (gauche) ---
  [44, 22, 7.0, 11, ''],
  [26, 12, 7.0, 11, ''],
  [8, 4, 7.0, 11, ''],
  // --- Piscine : entree (gauche-droite) ---
  [-12, -2, 7.0, 10, ''],
  [-30, -8, 7.0, 10, ''],
  [-50, -14, 7.0, 10, ''],
  // --- Piscine : sortie (droite-gauche) ---
  [-72, -20, 7.0, 10, ''],
  [-94, -24, 7.0, 10, ''],
  [-116, -27, 7.0, 11, ''],
  // --- La Rascasse (epingle a droite autour du bar) ---
  [-140, -30, 7.0, 10, ''],
  [-158, -27, 7.0, 8, ''],
  [-170, -18, 7.0, 8, ''],
  [-180, -26, 7.0, 8, ''],
  [-188, -38, 7.0, 9, ''],
  // --- Virage Anthony Noghes, retour sur la ligne droite ---
  [-206, -50, 7.0, 10, ''],
  [-228, -58, 7.0, 11, ''],
  [-252, -63, 7.0, 12, ''],
  [-276, -68, 7.0, 14, ''],
];

/** Secteurs nommes, pour l'affichage et pour le nommage des zones de la carte. */
export const CORNERS = [
  { name: 'Ligne de départ', cp: 0 },
  { name: 'Sainte-Dévote', cp: 6 },
  { name: 'Beau Rivage', cp: 9 },
  { name: 'Massenet', cp: 12 },
  { name: 'Place du Casino', cp: 15 },
  { name: 'Mirabeau Haute', cp: 18 },
  { name: 'Épingle du Fairmont', cp: 23 },
  { name: 'Mirabeau Bas', cp: 27 },
  { name: 'Portier', cp: 30 },
  { name: 'Le Tunnel', cp: 35 },
  { name: 'Nouvelle Chicane', cp: 42 },
  { name: 'Tabac', cp: 45 },
  { name: 'La Piscine', cp: 50 },
  { name: 'La Rascasse', cp: 55 },
  { name: 'Anthony Noghès', cp: 59 },
];

const SAMPLE_STEP = 3.0; // metres entre deux echantillons de la ligne centrale

function applyTransform(p) {
  return [p[0] * TRACK_SCALE + TRACK_OFFSET.x, p[1] * TRACK_SCALE + TRACK_OFFSET.z, p[2], p[3], p[4]];
}

let _samples = null;
let _index = null;
let _bounds = null;

/**
 * Ligne centrale echantillonnee.
 * Chaque echantillon : {x, y, z, tx, tz, nx, nz, width, s, tunnel, start, cornerIdx}
 * (t = tangente normalisee en 2D, n = normale gauche)
 */
export function trackSamples() {
  if (_samples) return _samples;
  const cps = CONTROL_POINTS.map(applyTransform);
  const n = cps.length;
  const raw = [];
  // Densifier la spline fermee
  for (let i = 0; i < n; i++) {
    const p0 = cps[(i - 1 + n) % n], p1 = cps[i], p2 = cps[(i + 1) % n], p3 = cps[(i + 2) % n];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(2, Math.ceil(segLen / SAMPLE_STEP));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      raw.push({
        x: catmullRom(p0[0], p1[0], p2[0], p3[0], t),
        z: catmullRom(p0[1], p1[1], p2[1], p3[1], t),
        y: catmullRom(p0[2], p1[2], p2[2], p3[2], t),
        width: catmullRom(p0[3], p1[3], p2[3], p3[3], t),
        tunnel: p1[4] === 't' && p2[4] === 't' ? 1 : (p1[4] === 't' || p2[4] === 't') ? (t < 0.5 ? (p1[4] === 't' ? 1 : 0) : (p2[4] === 't' ? 1 : 0)) : 0,
        start: i === 0 && k === 0 ? 1 : 0,
        cpIndex: i,
      });
    }
  }
  // Tangentes, normales, abscisse curviligne
  const m = raw.length;
  let s = 0;
  for (let i = 0; i < m; i++) {
    const a = raw[(i - 1 + m) % m], b = raw[(i + 1) % m], c = raw[i];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    c.tx = tx; c.tz = tz;
    c.nx = -tz; c.nz = tx; // normale « gauche »
    c.s = s;
    s += Math.hypot(raw[(i + 1) % m].x - c.x, raw[(i + 1) % m].z - c.z);
  }
  raw.length && (raw.totalLength = s);
  _samples = raw;
  _samples.totalLength = s;
  return _samples;
}

/** Longueur totale du circuit (metres). */
export function trackLength() {
  return trackSamples().totalLength;
}

/** Boite englobante du circuit {minX, maxX, minZ, maxZ}. */
export function trackBounds() {
  if (_bounds) return _bounds;
  const ss = trackSamples();
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ss) {
    const w = p.width * 0.5 + 6;
    minX = Math.min(minX, p.x - w); maxX = Math.max(maxX, p.x + w);
    minZ = Math.min(minZ, p.z - w); maxZ = Math.max(maxZ, p.z + w);
  }
  _bounds = { minX, maxX, minZ, maxZ };
  return _bounds;
}

const GRID_CELL = 24;

function buildIndex() {
  if (_index) return _index;
  const ss = trackSamples();
  const b = trackBounds();
  const originX = b.minX - 64, originZ = b.minZ - 64;
  const cols = Math.ceil((b.maxX - b.minX + 128) / GRID_CELL);
  const rows = Math.ceil((b.maxZ - b.minZ + 128) / GRID_CELL);
  const cells = new Array(cols * rows);
  for (let i = 0; i < ss.length; i++) {
    const p = ss[i];
    const cx = Math.floor((p.x - originX) / GRID_CELL);
    const cz = Math.floor((p.z - originZ) / GRID_CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx, gz = cz + dz;
        if (gx < 0 || gz < 0 || gx >= cols || gz >= rows) continue;
        const k = gz * cols + gx;
        (cells[k] || (cells[k] = [])).push(i);
      }
    }
  }
  _index = {
    originX, originZ, cols, rows, cells,
    // marquage sans allocation : evite un Set par requete (terrainHeight est appele
    // des centaines de milliers de fois a la construction de la carte)
    stamp: new Uint32Array(ss.length),
    stampGen: 0,
  };
  return _index;
}

/** Vrai si (x,z) est assez proche du circuit pour qu'une requete vaille le coup. */
export function nearTrack(x, z, margin = 40) {
  const b = trackBounds();
  return x >= b.minX - margin && x <= b.maxX + margin && z >= b.minZ - margin && z <= b.maxZ + margin;
}

/**
 * Point du circuit le plus proche de (x,z).
 * Renvoie {dist, lateral, sample, index, y, width, onTrack}
 * `lateral` est signe (positif = cote gauche de la trajectoire).
 * Renvoie dist = Infinity si le point est loin du circuit (recherche limitee a ~1 cellule).
 */
const NO_HIT = Object.freeze({ dist: Infinity, lateral: Infinity, sample: null, index: -1, y: 0, width: 0, onTrack: false, tunnel: false });

export function nearestTrackPoint(x, z, maxRadius = 70) {
  if (!nearTrack(x, z, maxRadius)) return NO_HIT;
  const ss = trackSamples();
  const idx = buildIndex();
  const cx = Math.floor((x - idx.originX) / GRID_CELL);
  const cz = Math.floor((z - idx.originZ) / GRID_CELL);
  const span = Math.max(1, Math.ceil(maxRadius / GRID_CELL));
  let best = null, bestD = Infinity, bestT = 0, bestI = -1;
  const gen = ++idx.stampGen;
  const stamp = idx.stamp;
  for (let dz = -span; dz <= span; dz++) {
    for (let dx = -span; dx <= span; dx++) {
      const gx = cx + dx, gz = cz + dz;
      if (gx < 0 || gz < 0 || gx >= idx.cols || gz >= idx.rows) continue;
      const list = idx.cells[gz * idx.cols + gx];
      if (!list) continue;
      for (let n = 0; n < list.length; n++) {
        const i = list[n];
        if (stamp[i] === gen) continue;
        stamp[i] = gen;
        const a = ss[i], b = ss[(i + 1) % ss.length];
        const cp = closestPointOnSegment(x, z, a.x, a.z, b.x, b.z);
        if (cp.d < bestD) { bestD = cp.d; best = a; bestT = cp.t; bestI = i; }
      }
    }
  }
  if (!best) return NO_HIT;
  const b2 = ss[(bestI + 1) % ss.length];
  const y = best.y + (b2.y - best.y) * bestT;
  const width = best.width + (b2.width - best.width) * bestT;
  const px = best.x + (b2.x - best.x) * bestT;
  const pz = best.z + (b2.z - best.z) * bestT;
  const lateral = (x - px) * best.nx + (z - pz) * best.nz;
  return {
    dist: bestD,
    lateral: bestD * Math.sign(lateral || 1),
    sample: best,
    index: bestI,
    x: px, z: pz, y, width,
    tx: best.tx, tz: best.tz, nx: best.nx, nz: best.nz,
    tunnel: best.tunnel === 1,
    onTrack: bestD <= width * 0.5,
  };
}

/**
 * Influence du circuit sur le terrain en (x,z) : {w, y, onTrack, tunnel}
 * w = 1 sur la piste, decroit jusqu'a 0 a `blend` metres du bord.
 */
export function trackTerrainInfluence(x, z, blend = 26) {
  const np = nearestTrackPoint(x, z, blend + 14);
  if (np.dist === Infinity) return { w: 0, y: 0, onTrack: false, tunnel: false, dist: Infinity, width: 0 };
  const half = np.width * 0.5;
  const edge = Math.max(0, np.dist - half);
  const w = 1 - smoothstep(0, blend, edge);
  return { w, y: np.y, onTrack: np.dist <= half, tunnel: np.tunnel, dist: np.dist, width: np.width, np };
}

/**
 * Distance au BORD de la piste (negative si on est dessus).
 * Renvoie Infinity au dela de `max`.
 */
export function trackClearance(x, z, max = 60) {
  const np = nearestTrackPoint(x, z, max);
  if (np.dist === Infinity) return Infinity;
  return np.dist - np.width * 0.5;
}

/** Position au bord exterieur/interieur du circuit, pour poser rails et decor. */
export function trackEdge(sampleIndex, side, extra = 0) {
  const ss = trackSamples();
  const p = ss[((sampleIndex % ss.length) + ss.length) % ss.length];
  const off = (p.width * 0.5 + extra) * side;
  return { x: p.x + p.nx * off, z: p.z + p.nz * off, y: p.y, sample: p };
}

/**
 * Rails de securite : deux polylignes (gauche et droite) le long du circuit.
 * Renvoie [{side, points:[{x,y,z}], tunnel:[bool]}]
 */
export function guardrails(step = 4) {
  const ss = trackSamples();
  const out = [];
  for (const side of [1, -1]) {
    const points = [];
    for (let i = 0; i < ss.length; i += step) {
      const e = trackEdge(i, side, 0.9);
      points.push({ x: e.x, y: e.y, z: e.z, tunnel: ss[i].tunnel === 1 });
    }
    points.push({ ...points[0] });
    out.push({ side, points });
  }
  return out;
}

/** Position/rotation de la grille de depart (20 emplacements en quinconce). */
export function startingGrid(count = 20) {
  const ss = trackSamples();
  const slots = [];
  for (let i = 0; i < count; i++) {
    const back = 8 + i * 8;
    const si = (ss.length - Math.round(back / SAMPLE_STEP) + ss.length * 2) % ss.length;
    const p = ss[si];
    const lat = (i % 2 === 0 ? 1 : -1) * p.width * 0.22;
    slots.push({
      x: p.x + p.nx * lat,
      y: p.y,
      z: p.z + p.nz * lat,
      yaw: Math.atan2(p.tx, p.tz),
    });
  }
  return slots;
}

/** Nom du secteur le plus proche (pour le kill-feed et la minimap). */
export function cornerNameAt(x, z) {
  const np = nearestTrackPoint(x, z, 120);
  if (np.dist === Infinity || !np.sample) return null;
  const cp = np.sample.cpIndex;
  let best = CORNERS[0], bestD = Infinity;
  for (const c of CORNERS) {
    const d = Math.min(Math.abs(c.cp - cp), CONTROL_POINTS.length - Math.abs(c.cp - cp));
    if (d < bestD) { bestD = d; best = c; }
  }
  return best.name;
}

/** Reinitialise les caches (tests). */
export function _resetTrackCache() {
  _samples = null; _index = null; _bounds = null;
}

/** Le tunnel : segments couverts, pour construire le plafond cote client et occulter la pluie. */
export function tunnelSpans() {
  const ss = trackSamples();
  const spans = [];
  let cur = null;
  for (let i = 0; i < ss.length; i++) {
    if (ss[i].tunnel === 1) {
      if (!cur) cur = { from: i, to: i };
      else cur.to = i;
    } else if (cur) { spans.push(cur); cur = null; }
  }
  if (cur) spans.push(cur);
  return spans;
}

export function isInsideTunnel(x, z, y) {
  const np = nearestTrackPoint(x, z, 40);
  if (!np.tunnel || np.dist > np.width * 0.5 + 3) return false;
  return y < np.y + 9;
}

/** Hauteur de piste + booleen, utilitaire pratique pour la physique des vehicules. */
export function trackSurfaceAt(x, z) {
  const np = nearestTrackPoint(x, z, 60);
  if (np.dist === Infinity) return null;
  if (np.dist > np.width * 0.5 + 1.5) return null;
  return { y: np.y, tx: np.tx, tz: np.tz, nx: np.nx, nz: np.nz };
}

export default {
  CONTROL_POINTS, CORNERS, TRACK_SCALE, TRACK_OFFSET,
  trackSamples, trackLength, trackBounds, nearestTrackPoint,
  trackTerrainInfluence, trackEdge, guardrails, startingGrid,
  cornerNameAt, tunnelSpans, isInsideTunnel, trackSurfaceAt,
};
