// Carte « Le Rocher des Chèvres » — generee de facon deterministe a partir d'une graine.
// Serveur et client appellent buildMap() et obtiennent EXACTEMENT le meme monde.
//
// Repere : X est, Z nord, Y haut. Le monde va de -900 a +900 sur X et Z.

import { WORLD_HALF, SEA_LEVEL, SURFACE } from './constants.js';
import { clamp, lerp, smoothstep, fbm2, valueNoise2 } from './math.js';
import { RNG } from './rng.js';
import {
  trackSamples, trackTerrainInfluence, trackEdge, guardrails, trackBounds,
  startingGrid, tunnelSpans, nearTrack, nearestTrackPoint, trackClearance, CORNERS,
} from './track.js';

export const MAP_SEED = 'rocher-des-chevres-v3';
export const MAP_NAME = 'Le Rocher des Chèvres';

// --- Ile ---------------------------------------------------------------------
export const ISLAND = { cx: 0, cz: 80, inner: 600, outer: 820, seaFloor: -22 };

// --- Port Hercule (bassin enferme par le circuit) ----------------------------
export const HARBOUR = { minX: -350, maxX: 175, minZ: 140, maxZ: 370, depth: -7, edge: 16 };

// --- Le Rocher : plateau de la vieille ville ---------------------------------
export const ROCHER = { x: -620, z: 200, r: 118, top: 46, slope: 46 };

// --- Mont Chèvre -------------------------------------------------------------
export const MOUNT = { x: -140, z: -430, r: 300, h: 172 };
export const RIDGE = { x: 360, z: -330, r: 230, h: 86 };

// --- Plage du Larvotto -------------------------------------------------------
export const BEACH = { x: 655, z: 150, r: 150 };

// --- Plaine de l'alpage (aplanie pour la ferme) ------------------------------
export const ALPAGE = { x: 330, z: -250, r: 190, y: 26 };
export const HELIPORT = { x: 470, z: 90, r: 90, y: 9 };

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

// --- Champ d'elevation du circuit -------------------------------------------
// Le relief autour du circuit doit suivre la route : sinon la piste se retrouve
// perchee sur une corniche de 20 m. On precalcule une fois une grille (distance a
// la piste, altitude de la piste la plus proche) par « splat » des echantillons,
// puis on l'interpole bilineairement. C'est ~200x plus rapide qu'une requete large
// par point de terrain.

const FIELD_CELL = 8;
const FIELD_REACH = 190; // portee d'influence du circuit sur le relief
let _field = null;

function buildField() {
  if (_field) return _field;
  const b = trackBounds();
  const minX = b.minX - FIELD_REACH, minZ = b.minZ - FIELD_REACH;
  const cols = Math.ceil((b.maxX - b.minX + FIELD_REACH * 2) / FIELD_CELL) + 1;
  const rows = Math.ceil((b.maxZ - b.minZ + FIELD_REACH * 2) / FIELD_CELL) + 1;
  const dist = new Float32Array(cols * rows).fill(Infinity);
  const elev = new Float32Array(cols * rows);
  const ss = trackSamples();
  const reachCells = Math.ceil(FIELD_REACH / FIELD_CELL);
  for (let i = 0; i < ss.length; i++) {
    const p = ss[i];
    const gx = Math.round((p.x - minX) / FIELD_CELL);
    const gz = Math.round((p.z - minZ) / FIELD_CELL);
    for (let dz = -reachCells; dz <= reachCells; dz++) {
      const cz2 = gz + dz;
      if (cz2 < 0 || cz2 >= rows) continue;
      for (let dx = -reachCells; dx <= reachCells; dx++) {
        const cx2 = gx + dx;
        if (cx2 < 0 || cx2 >= cols) continue;
        const wx = minX + cx2 * FIELD_CELL, wz = minZ + cz2 * FIELD_CELL;
        const d = Math.hypot(wx - p.x, wz - p.z);
        if (d >= FIELD_REACH) continue;
        const k = cz2 * cols + cx2;
        if (d < dist[k]) { dist[k] = d; elev[k] = p.y; }
      }
    }
  }
  _field = { minX, minZ, cols, rows, dist, elev };
  return _field;
}

/** Interpolation bilineaire du champ. Renvoie null hors zone. */
function fieldAt(x, z) {
  const f = buildField();
  const fx = (x - f.minX) / FIELD_CELL;
  const fz = (z - f.minZ) / FIELD_CELL;
  if (fx < 0 || fz < 0 || fx >= f.cols - 1 || fz >= f.rows - 1) return null;
  const ix = fx | 0, iz = fz | 0;
  const tx = fx - ix, tz = fz - iz;
  const k00 = iz * f.cols + ix, k10 = k00 + 1, k01 = k00 + f.cols, k11 = k01 + 1;
  const d00 = f.dist[k00], d10 = f.dist[k10], d01 = f.dist[k01], d11 = f.dist[k11];
  if (d00 === Infinity && d10 === Infinity && d01 === Infinity && d11 === Infinity) return null;
  const cap = (d) => (d === Infinity ? FIELD_REACH : d);
  const d = lerp(lerp(cap(d00), cap(d10), tx), lerp(cap(d01), cap(d11), tx), tz);
  // pour l'altitude on ignore les cases vides en reprenant la plus proche valide
  const w00 = d00 === Infinity ? 0 : 1, w10 = d10 === Infinity ? 0 : 1;
  const w01 = d01 === Infinity ? 0 : 1, w11 = d11 === Infinity ? 0 : 1;
  const a00 = (1 - tx) * (1 - tz) * w00, a10 = tx * (1 - tz) * w10;
  const a01 = (1 - tx) * tz * w01, a11 = tx * tz * w11;
  const sum = a00 + a10 + a01 + a11;
  if (sum <= 0) return null;
  const y = (f.elev[k00] * a00 + f.elev[k10] * a10 + f.elev[k01] * a01 + f.elev[k11] * a11) / sum;
  return { d, y };
}

function baseTerrain(x, z) {
  // relief general : plaine cotiere legerement vallonnee, toujours au dessus de l'eau
  let h = 15
    + (fbm2(x * 0.0016 + 11.3, z * 0.0016 + 7.7, 4) - 0.5) * 24
    + (valueNoise2(x * 0.011 + 3.1, z * 0.011 + 5.9) - 0.5) * 2.2;

  // La Tete de Chien : la falaise qui domine Monte-Carlo au nord
  h += smoothstep(600, 830, z) * 120;
  // Les collines de l'arriere-pays au sud
  h += smoothstep(60, -260, z) * 26;

  // Mont Chèvre : le domaine des chevres
  const dm = Math.hypot(x - MOUNT.x, z - MOUNT.z);
  if (dm < MOUNT.r) {
    const t = 1 - dm / MOUNT.r;
    const cone = Math.pow(t, 1.45);
    const crag = (fbm2(x * 0.012 + 40, z * 0.012 + 40, 3) - 0.5) * 26 * t;
    h += MOUNT.h * cone + crag;
  }

  // Crete de l'est
  const dr = Math.hypot(x - RIDGE.x, z - RIDGE.z);
  if (dr < RIDGE.r) {
    const t = 1 - dr / RIDGE.r;
    h += RIDGE.h * Math.pow(t, 1.7) + (fbm2(x * 0.014 - 20, z * 0.014 + 60, 3) - 0.5) * 14 * t;
  }

  // Plateau du Rocher (falaises abruptes, sommet plat) — la vieille ville
  const dro = Math.hypot(x - ROCHER.x, z - ROCHER.z);
  if (dro < ROCHER.r + 60) {
    const w = 1 - smoothstep(ROCHER.r - 14, ROCHER.r + 34, dro);
    h = lerp(h, ROCHER.top + (fbm2(x * 0.02, z * 0.02, 2) - 0.5) * 1.4, w);
  }

  // Plaine de l'alpage : replat pour la ferme
  const da = Math.hypot(x - ALPAGE.x, z - ALPAGE.z);
  if (da < ALPAGE.r + 70) {
    const w = 1 - smoothstep(ALPAGE.r - 40, ALPAGE.r + 60, da);
    h = lerp(h, ALPAGE.y + (fbm2(x * 0.01 + 90, z * 0.01, 2) - 0.5) * 3.5, w * 0.9);
  }

  // Heliport : plateforme plate au bord de l'eau
  const dh = Math.hypot(x - HELIPORT.x, z - HELIPORT.z);
  if (dh < HELIPORT.r + 40) {
    const w = 1 - smoothstep(HELIPORT.r - 25, HELIPORT.r + 35, dh);
    h = lerp(h, HELIPORT.y, w);
  }

  // Plage : replat sableux, c'est le retrait de l'ile qui creera le rivage
  const db = Math.hypot(x - BEACH.x, z - BEACH.z);
  if (db < BEACH.r + 60) {
    const w = 1 - smoothstep(BEACH.r - 30, BEACH.r + 50, db);
    h = lerp(h, 7 + (fbm2(x * 0.02 + 5, z * 0.02, 2) - 0.5) * 1.6, w);
  }

  return h;
}

function islandFalloff(x, z, h) {
  const r = Math.hypot(x - ISLAND.cx, z - ISLAND.cz);
  const w = smoothstep(ISLAND.inner, ISLAND.outer, r);
  if (w <= 0) return h;
  return lerp(h, ISLAND.seaFloor, w);
}

/** Facteur d'appartenance au bassin du port (1 = pleine eau). */
export function harbourFactor(x, z) {
  const e = HARBOUR.edge;
  const fx = smoothstep(HARBOUR.minX - e, HARBOUR.minX + e, x) * (1 - smoothstep(HARBOUR.maxX - e, HARBOUR.maxX + e, x));
  const fz = smoothstep(HARBOUR.minZ - e, HARBOUR.minZ + e, z) * (1 - smoothstep(HARBOUR.maxZ - e, HARBOUR.maxZ + e, z));
  return fx * fz;
}

/** Altitude du terrain en (x,z). Deterministe, identique serveur/client. */
export function terrainHeight(x, z) {
  let h = baseTerrain(x, z);
  h = islandFalloff(x, z, h);

  // Le relief se cale sur l'altitude du circuit dans tout le quartier
  const f = fieldAt(x, z);
  if (f) {
    const w = 0.86 * (1 - smoothstep(22, FIELD_REACH, f.d));
    if (w > 0) h = lerp(h, f.y, w);
  }

  // ... puis la piste elle meme est parfaitement plane
  if (nearTrack(x, z, 42)) {
    const ti = trackTerrainInfluence(x, z, 26);
    if (ti.w > 0) h = lerp(h, ti.y, ti.w);
  }

  // Creuser le bassin du port en dernier
  const hf = harbourFactor(x, z);
  if (hf > 0) h = lerp(h, HARBOUR.depth, hf);

  return h;
}

/** Nature du sol (pour les bruits de pas, les particules et le grip des vehicules). */
export function surfaceTypeAt(x, z) {
  const y = terrainHeight(x, z);
  if (y < SEA_LEVEL - 0.2) return SURFACE.WATER;
  if (nearTrack(x, z, 20)) {
    const np = nearestTrackPoint(x, z, 20);
    if (np.dist !== Infinity && np.dist <= np.width * 0.5) return SURFACE.ASPHALT;
  }
  const db = Math.hypot(x - BEACH.x, z - BEACH.z);
  if (db < BEACH.r) return SURFACE.SAND;
  const dro = Math.hypot(x - ROCHER.x, z - ROCHER.z);
  if (dro < ROCHER.r) return SURFACE.STONE;
  const dm = Math.hypot(x - MOUNT.x, z - MOUNT.z);
  if (dm < MOUNT.r * 0.62) return SURFACE.ROCK;
  if (harbourFactor(x, z) < 0.02 && y > 4 && y < 12 && x > HARBOUR.minX - 70 && x < HARBOUR.maxX + 70 && z > HARBOUR.minZ - 70 && z < HARBOUR.maxZ + 70) return SURFACE.STONE;
  return SURFACE.GRASS;
}

export function isWaterAt(x, z) {
  return terrainHeight(x, z) < SEA_LEVEL - 0.15;
}

/** Profondeur d'eau (0 si sec). */
export function waterDepth(x, z) {
  return Math.max(0, SEA_LEVEL - terrainHeight(x, z));
}

// ---------------------------------------------------------------------------
// Points d'interet
// ---------------------------------------------------------------------------
export const POIS = [
  { id: 'stands', name: 'Les Stands', x: -425, z: 126, r: 95, kind: 'circuit', loot: 'high' },
  { id: 'devote', name: 'Sainte-Dévote', x: -400, z: 368, r: 70, kind: 'circuit', loot: 'mid' },
  { id: 'casino', name: 'Place du Casino', x: -75, z: 604, r: 120, kind: 'city', loot: 'very-high' },
  { id: 'fairmont', name: 'Épingle du Fairmont', x: 86, z: 466, r: 80, kind: 'city', loot: 'high' },
  { id: 'tunnel', name: 'Le Tunnel', x: 280, z: 282, r: 80, kind: 'circuit', loot: 'mid' },
  { id: 'chicane', name: 'Nouvelle Chicane', x: 176, z: 143, r: 70, kind: 'circuit', loot: 'mid' },
  { id: 'piscine', name: 'La Piscine', x: -37, z: 58, r: 85, kind: 'circuit', loot: 'high' },
  { id: 'rascasse', name: 'La Rascasse', x: -223, z: 52, r: 70, kind: 'circuit', loot: 'mid' },
  { id: 'port', name: 'Port Hercule', x: -90, z: 250, r: 200, kind: 'water', loot: 'high' },
  { id: 'rocher', name: 'Le Rocher', x: -620, z: 200, r: 130, kind: 'oldtown', loot: 'very-high' },
  { id: 'montchevre', name: 'Mont Chèvre', x: -140, z: -430, r: 240, kind: 'mountain', loot: 'mid' },
  { id: 'alpage', name: 'L’Alpage', x: 330, z: -250, r: 170, kind: 'farm', loot: 'high' },
  { id: 'foret', name: 'Forêt de Vintimille', x: -470, z: -180, r: 200, kind: 'forest', loot: 'low' },
  { id: 'heliport', name: 'Héliport', x: 470, z: 90, r: 85, kind: 'industrial', loot: 'high' },
  { id: 'plage', name: 'Plage du Larvotto', x: 655, z: 150, r: 130, kind: 'beach', loot: 'low' },
  { id: 'turbie', name: 'La Turbie', x: 90, z: -120, r: 110, kind: 'village', loot: 'high' },
];

const LOOT_DENSITY = { low: 0.5, mid: 1.0, high: 1.5, 'very-high': 2.1 };

// ---------------------------------------------------------------------------
// Construction du monde
// ---------------------------------------------------------------------------

let _map = null;

function pushBox(list, o) {
  list.push({
    type: 'box',
    x: o.x, y: o.y, z: o.z,
    hx: o.hx, hy: o.hy, hz: o.hz,
    yaw: o.yaw || 0,
    surface: o.surface ?? SURFACE.STONE,
    walkable: o.walkable !== false,
    tag: o.tag || '',
  });
}

function pushCyl(list, o) {
  list.push({
    type: 'cyl',
    x: o.x, y: o.y, z: o.z, r: o.r, h: o.h,
    surface: o.surface ?? SURFACE.WOOD,
    walkable: o.walkable !== false,
    tag: o.tag || '',
  });
}

/**
 * Un batiment : base au sol, hauteur h. Genere aussi son collider.
 * style : monaco | modern | oldtown | industrial | farm | casino | hotel | pit | grandstand | shed
 */
let _ownerSeq = 0;

function addBuilding(map, b) {
  const ground = b.y !== undefined ? b.y : terrainHeight(b.x, b.z);
  const owner = ++_ownerSeq;
  const bld = {
    _owner: owner,
    x: b.x, z: b.z, y: ground,
    w: b.w, d: b.d, h: b.h,
    yaw: b.yaw || 0,
    style: b.style || 'monaco',
    color: b.color ?? null,
    roof: b.roof ?? (b.style === 'oldtown' ? 'tile' : b.style === 'farm' ? 'gable' : 'flat'),
    floors: Math.max(1, Math.round(b.h / 3.4)),
    balcony: b.balcony ?? false,
    name: b.name || '',
    solid: b.solid !== false,
  };
  map.buildings.push(bld);
  if (bld.solid) {
    pushBox(map.colliders, {
      x: b.x, y: ground + b.h / 2, z: b.z,
      hx: b.w / 2, hy: b.h / 2, hz: b.d / 2,
      yaw: b.yaw || 0, surface: SURFACE.STONE, tag: 'building', owner,
    });
  }
  return bld;
}

function addProp(map, kind, x, z, opts = {}) {
  const y = opts.y !== undefined ? opts.y : terrainHeight(x, z);
  const owner = ++_ownerSeq;
  const p = { _owner: owner, kind, x, y, z, yaw: opts.yaw || 0, scale: opts.scale || 1, color: opts.color ?? null, extra: opts.extra || null };
  map.props.push(p);
  if (opts.collider === 'cyl') {
    pushCyl(map.colliders, { x, y, z, r: opts.r, h: opts.ch, surface: opts.surface ?? SURFACE.WOOD, tag: kind, owner });
  } else if (opts.collider === 'box') {
    pushBox(map.colliders, {
      x, y: y + opts.ch / 2, z, hx: opts.hx, hy: opts.ch / 2, hz: opts.hz,
      yaw: opts.yaw || 0, surface: opts.surface ?? SURFACE.WOOD, tag: kind, owner,
    });
  }
  return p;
}

// Elements qui ONT le droit de border la piste.
const TRACK_SIDE_TAGS = new Set(['rail', 'gantry', 'tunnelwall', 'tunnelroof']);

/**
 * Filet de securite : rien ne doit obstruer l'asphalte. On teste l'emprise reelle de chaque
 * collider (coins compris) et on supprime l'objet entier — collider ET rendu — s'il mord
 * sur la piste. Sans ca, un immeuble genere au hasard peut se poser au milieu de Massenet.
 */
function pruneTrackObstructions(map) {
  const doomed = new Set();
  for (const c of map.colliders) {
    if (TRACK_SIDE_TAGS.has(c.tag)) continue;
    let obstructs = false;
    if (c.type === 'box') {
      const ca = Math.cos(c.yaw || 0), sa = Math.sin(c.yaw || 0);
      for (const [sx, sz] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const lx = c.hx * sx, lz = c.hz * sz;
        const px = c.x + lx * ca + lz * sa;
        const pz = c.z - lx * sa + lz * ca;
        if (trackClearance(px, pz, 46) < 1.4) { obstructs = true; break; }
      }
    } else {
      obstructs = trackClearance(c.x, c.z, 46) < c.r + 1.4;
    }
    if (obstructs) doomed.add(c.owner ?? -1);
  }
  doomed.delete(-1);
  if (!doomed.size) return 0;
  map.colliders = map.colliders.filter((c) => !doomed.has(c.owner));
  map.buildings = map.buildings.filter((b) => !doomed.has(b._owner));
  map.props = map.props.filter((p) => !doomed.has(p._owner));
  return doomed.size;
}

// --- Circuit : rails, tribunes, stands, tunnel ------------------------------

function buildCircuit(map, rng) {
  const ss = trackSamples();

  // Rails de securite (armco) des deux cotes, sauf devant les stands
  const rails = guardrails(3);
  for (const rail of rails) {
    const pts = rail.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.2) continue;
      const yaw = Math.atan2(dx, dz);
      const y = (a.y + b.y) / 2;
      map.rails.push({ x: mx, y, z: mz, yaw, len, side: rail.side, tunnel: a.tunnel });
      pushBox(map.colliders, {
        x: mx, y: y + 0.6, z: mz,
        hx: 0.22, hy: 0.6, hz: len / 2 + 0.1,
        yaw, surface: SURFACE.METAL, tag: 'rail',
      });
    }
  }

  // Le tunnel : parois + plafond
  for (const span of tunnelSpans()) {
    for (let i = span.from; i <= span.to; i += 3) {
      const p = ss[i % ss.length];
      const halfW = p.width * 0.5 + 2.6;
      const yaw = Math.atan2(p.tx, p.tz);
      for (const side of [1, -1]) {
        const wx = p.x + p.nx * halfW * side;
        const wz = p.z + p.nz * halfW * side;
        pushBox(map.colliders, {
          x: wx, y: p.y + 4.5, z: wz, hx: 1.2, hy: 4.5, hz: 5.0,
          yaw, surface: SURFACE.STONE, tag: 'tunnelwall',
        });
      }
      pushBox(map.colliders, {
        x: p.x, y: p.y + 9.6, z: p.z, hx: halfW + 1.4, hy: 1.2, hz: 5.0,
        yaw, surface: SURFACE.STONE, tag: 'tunnelroof',
      });
      map.tunnelSegments.push({ x: p.x, y: p.y, z: p.z, yaw, halfW, len: 10 });
    }
  }

  // Voie des stands + garages, le long de la ligne droite
  const pitStart = 4;
  for (let i = 0; i < 12; i++) {
    const si = (pitStart + i * 5) % ss.length;
    const e = trackEdge(si, -1, 13);
    const p = ss[si];
    const yaw = Math.atan2(p.tx, p.tz);
    addBuilding(map, {
      x: e.x, z: e.z, y: p.y, w: 11, d: 13, h: 7.5, yaw,
      style: 'pit', color: i % 2 ? 0xe8e8ea : 0xd6001c, name: i === 0 ? 'Stands' : '',
    });
  }
  // Immeuble de direction de course
  {
    const e = trackEdge(pitStart + 30, -1, 22);
    const p = ss[(pitStart + 30) % ss.length];
    addBuilding(map, {
      x: e.x, z: e.z, y: p.y, w: 26, d: 16, h: 18, yaw: Math.atan2(p.tx, p.tz),
      style: 'modern', color: 0xf0f0f2, name: 'Direction de course',
    });
  }

  // Tribunes : cote exterieur, sur quelques secteurs
  const standSpots = [10, 60, 120, 300, 430, 620, 700, 760];
  for (const si of standSpots) {
    const e = trackEdge(si, 1, 12);
    const p = ss[si % ss.length];
    addBuilding(map, {
      x: e.x, z: e.z, y: p.y, w: 34, d: 14, h: 9, yaw: Math.atan2(p.tx, p.tz),
      style: 'grandstand', color: 0xdfe4ea,
    });
  }

  // Ligne de depart : portique + damier
  {
    const p = ss[0];
    const yaw = Math.atan2(p.tx, p.tz);
    map.startLine = { x: p.x, y: p.y, z: p.z, yaw, width: p.width };
    for (const side of [1, -1]) {
      pushBox(map.colliders, {
        x: p.x + p.nx * (p.width / 2 + 1.2) * side,
        y: p.y + 4, z: p.z + p.nz * (p.width / 2 + 1.2) * side,
        hx: 0.6, hy: 4, hz: 0.6, yaw, surface: SURFACE.METAL, tag: 'gantry',
      });
    }
  }

  // Panneaux publicitaires et pneus dans les degagements
  for (let i = 0; i < ss.length; i += 11) {
    if (ss[i].tunnel) continue;
    const side = rng.bool() ? 1 : -1;
    const e = trackEdge(i, side, 3.2);
    if (rng.bool(0.34)) {
      addProp(map, 'tyrewall', e.x, e.z, {
        y: ss[i].y, yaw: Math.atan2(ss[i].tx, ss[i].tz), scale: rng.float(0.9, 1.3),
        collider: 'box', hx: 2.4, hz: 0.7, ch: 1.1, surface: SURFACE.WOOD,
      });
    } else if (rng.bool(0.4)) {
      addProp(map, 'banner', e.x, e.z, {
        y: ss[i].y, yaw: Math.atan2(ss[i].tx, ss[i].tz), scale: rng.float(0.9, 1.2),
      });
    }
  }
}

// --- Monte-Carlo : la ville entre le port et la colline ---------------------

function buildCity(map, rng) {
  // Le Casino de Monte-Carlo : monument central
  const casinoX = -75, casinoZ = 612;
  addBuilding(map, { x: casinoX, z: casinoZ + 34, w: 62, d: 38, h: 26, yaw: 0.06, style: 'casino', color: 0xe8dfc8, name: 'Casino de Monte-Carlo' });
  addBuilding(map, { x: casinoX - 44, z: casinoZ + 30, w: 26, d: 26, h: 20, yaw: 0.06, style: 'casino', color: 0xe4d9bd });
  addBuilding(map, { x: casinoX + 44, z: casinoZ + 30, w: 26, d: 26, h: 20, yaw: 0.06, style: 'casino', color: 0xe4d9bd });
  // Hotel de Paris, en face
  addBuilding(map, { x: casinoX - 62, z: casinoZ - 22, w: 46, d: 30, h: 30, yaw: -0.1, style: 'hotel', color: 0xf0e7d2, name: 'Hôtel de Paris', balcony: true });
  // Jardins : fontaine + palmiers
  addProp(map, 'fountain', casinoX, casinoZ + 4, { collider: 'cyl', r: 4.2, ch: 1.1, surface: SURFACE.STONE });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    addProp(map, 'palm', casinoX + Math.cos(a) * 26, casinoZ + 4 + Math.sin(a) * 18, {
      yaw: rng.float(0, 6.28), scale: rng.float(0.9, 1.3), collider: 'cyl', r: 0.42, ch: 8,
    });
  }

  // Immeubles du quartier (grille irreguliere, evite la piste et le port)
  const blocks = [];
  for (let gx = -300; gx <= 240; gx += 34) {
    for (let gz = 400; gz <= 640; gz += 34) {
      blocks.push([gx, gz]);
    }
  }
  // + la bande entre le port et la colline
  for (let gx = -330; gx <= 200; gx += 32) {
    for (let gz = 386; gz <= 420; gz += 32) blocks.push([gx, gz]);
  }
  for (const [bx, bz] of blocks) {
    const x = bx + rng.float(-9, 9), z = bz + rng.float(-9, 9);
    if (harbourFactor(x, z) > 0.05) continue;
    if (Math.hypot(x - casinoX, z - casinoZ) < 78) continue;
    if (nearTrack(x, z, 30)) {
      const np = nearestTrackPoint(x, z, 34);
      if (np.dist !== Infinity && np.dist < np.width * 0.5 + 13) continue;
    }
    const y = terrainHeight(x, z);
    if (y < 1) continue;
    const tall = rng.bool(0.28);
    addBuilding(map, {
      x, z, y,
      w: rng.float(15, 26), d: rng.float(15, 26),
      h: tall ? rng.float(34, 62) : rng.float(13, 30),
      yaw: rng.float(-0.35, 0.35),
      style: tall ? 'modern' : 'monaco',
      color: tall ? rng.pick([0xd7dee6, 0xc8d3dd, 0xe2e6ea]) : rng.pick([0xefe3cd, 0xe7d5b6, 0xf2e8d5, 0xdfcdae, 0xead9c0]),
      balcony: !tall && rng.bool(0.6),
    });
  }

  // L'hotel de l'epingle (le Fairmont) : gros volume au dessus du tunnel
  {
    const np = nearestTrackPoint(160, 400, 200);
    addBuilding(map, { x: 196, z: 330, w: 74, d: 96, h: 42, yaw: 0.2, style: 'hotel', color: 0xf3ead8, name: 'Hôtel de l’Épingle', balcony: true });
    void np;
  }

  // Mobilier urbain le long des quais
  for (let i = 0; i < 90; i++) {
    const x = rng.float(HARBOUR.minX - 42, HARBOUR.maxX + 42);
    const z = rng.float(HARBOUR.minZ - 42, HARBOUR.maxZ + 42);
    if (harbourFactor(x, z) > 0.25) continue;
    const y = terrainHeight(x, z);
    if (y < 1) continue;
    const kind = rng.pick(['lamppost', 'palm', 'bench', 'crate', 'bollard']);
    addProp(map, kind, x, z, {
      y, yaw: rng.float(0, 6.28), scale: rng.float(0.85, 1.2),
      collider: kind === 'bench' || kind === 'crate' ? 'box' : 'cyl',
      r: kind === 'palm' ? 0.4 : 0.2, ch: kind === 'palm' ? 8 : kind === 'lamppost' ? 6 : 1.1,
      hx: 1.1, hz: 0.55,
    });
  }
}

// --- Le Rocher : la vieille ville sur son plateau ---------------------------

function buildOldTown(map, rng) {
  const { x: cx, z: cz, r } = ROCHER;
  // Le Palais
  addBuilding(map, { x: cx - 10, z: cz + 34, w: 56, d: 34, h: 20, yaw: 0.15, style: 'oldtown', color: 0xf5e9d0, name: 'Le Palais', roof: 'tile' });
  addBuilding(map, { x: cx - 40, z: cz + 34, w: 12, d: 12, h: 28, yaw: 0.15, style: 'oldtown', color: 0xf0e0c2, roof: 'tower' });
  // Ruelles : anneaux de maisons
  for (let ring = 0; ring < 3; ring++) {
    const rr = 34 + ring * 26;
    const n = 8 + ring * 5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ring * 0.4 + rng.float(-0.09, 0.09);
      const x = cx + Math.cos(a) * (rr + rng.float(-5, 5));
      const z = cz + Math.sin(a) * (rr + rng.float(-5, 5));
      if (Math.hypot(x - cx, z - cz) > r - 8) continue;
      if (Math.hypot(x - (cx - 10), z - (cz + 34)) < 34) continue;
      addBuilding(map, {
        x, z, w: rng.float(9, 15), d: rng.float(9, 15), h: rng.float(9, 17),
        yaw: a + Math.PI / 2 + rng.float(-0.3, 0.3),
        style: 'oldtown', roof: 'tile',
        color: rng.pick([0xf2d7a8, 0xe8bfa0, 0xf0e0c0, 0xdcc9a4, 0xe6c9b0, 0xf5dfc0]),
      });
    }
  }
  // Remparts au bord du plateau
  const wallN = 46;
  for (let i = 0; i < wallN; i++) {
    const a = (i / wallN) * Math.PI * 2;
    const x = cx + Math.cos(a) * (r - 3);
    const z = cz + Math.sin(a) * (r - 3);
    const y = terrainHeight(x, z);
    pushBox(map.colliders, { x, y: y + 1.5, z, hx: 4.4, hy: 1.5, hz: 1.0, yaw: -a, surface: SURFACE.STONE, tag: 'rampart' });
    map.props.push({ kind: 'rampart', x, y, z, yaw: -a, scale: 1, color: 0xcfc3a8, extra: null });
  }
  // Rampe d'acces (les chevres n'en ont pas besoin, les voitures si)
  map.ramps.push({ from: [cx + r + 46, cz - 30], to: [cx + r - 24, cz - 8], width: 12 });
  for (let i = 0; i < 26; i++) {
    const t = i / 25;
    const x = lerp(cx + r + 52, cx + r - 26, t);
    const z = lerp(cz - 40, cz - 6, t);
    const y = lerp(terrainHeight(cx + r + 56, cz - 44), ROCHER.top, smoothstep(0, 1, t));
    pushBox(map.colliders, { x, y: y - 1.2, z, hx: 7, hy: 1.4, hz: 3.2, yaw: Math.atan2(-24, 20), surface: SURFACE.STONE, tag: 'ramp' });
    map.props.push({ kind: 'ramp', x, y, z, yaw: Math.atan2(-24, 20), scale: 1, color: 0xb9ae95, extra: null });
  }
}

// --- Le port : quais, yachts, grues -----------------------------------------

function buildHarbour(map, rng) {
  const yachtCount = 26;
  for (let i = 0; i < yachtCount; i++) {
    const alongTop = i < yachtCount / 2;
    const t = (i % (yachtCount / 2)) / (yachtCount / 2 - 1);
    let x, z, yaw;
    if (alongTop) {
      x = lerp(HARBOUR.minX + 40, HARBOUR.maxX - 40, t);
      z = HARBOUR.maxZ - 26;
      yaw = 0;
    } else {
      x = lerp(HARBOUR.minX + 40, HARBOUR.maxX - 40, t);
      z = HARBOUR.minZ + 26;
      yaw = Math.PI;
    }
    const len = rng.float(16, 40);
    const beam = len * rng.float(0.22, 0.3);
    const yacht = {
      x, y: SEA_LEVEL, z, yaw: yaw + rng.float(-0.05, 0.05), len, beam,
      decks: len > 30 ? 3 : len > 22 ? 2 : 1,
      color: rng.pick([0xffffff, 0xf2f4f6, 0xe8eef4, 0x1c2833]),
    };
    map.yachts.push(yacht);
    // Coque : plateforme praticable
    pushBox(map.colliders, {
      x, y: SEA_LEVEL + 0.9, z, hx: beam / 2, hy: 1.1, hz: len / 2,
      yaw: yacht.yaw, surface: SURFACE.WOOD, tag: 'yacht',
    });
    // Superstructure
    pushBox(map.colliders, {
      x: x - Math.sin(yacht.yaw) * len * 0.12, y: SEA_LEVEL + 2.0 + yacht.decks * 1.4,
      z: z - Math.cos(yacht.yaw) * len * 0.12,
      hx: beam / 2 - 0.8, hy: yacht.decks * 1.4, hz: len * 0.28,
      yaw: yacht.yaw, surface: SURFACE.WOOD, tag: 'yacht',
    });
  }

  // Pontons
  for (let i = 0; i < 7; i++) {
    const x = lerp(HARBOUR.minX + 60, HARBOUR.maxX - 60, i / 6);
    const z = (HARBOUR.minZ + HARBOUR.maxZ) / 2;
    pushBox(map.colliders, { x, y: SEA_LEVEL + 0.5, z, hx: 2.2, hy: 0.6, hz: 40, yaw: 0, surface: SURFACE.WOOD, tag: 'pontoon' });
    map.props.push({ kind: 'pontoon', x, y: SEA_LEVEL, z, yaw: 0, scale: 1, color: 0xa89878, extra: { hz: 40 } });
  }

  // Grues et conteneurs sur le quai est
  for (let i = 0; i < 5; i++) {
    const x = HARBOUR.maxX + 22 + rng.float(-6, 6);
    const z = lerp(HARBOUR.minZ + 30, HARBOUR.maxZ - 30, i / 4);
    const y = terrainHeight(x, z);
    if (y < 1) continue;
    addProp(map, 'crane', x, z, { y, yaw: rng.float(-0.4, 0.4), scale: 1, collider: 'box', hx: 2, hz: 2, ch: 16, surface: SURFACE.METAL });
  }
  for (let i = 0; i < 26; i++) {
    const x = HARBOUR.maxX + rng.float(6, 52);
    const z = rng.float(HARBOUR.minZ + 10, HARBOUR.maxZ - 10);
    const y = terrainHeight(x, z);
    if (y < 1) continue;
    addProp(map, 'container', x, z, {
      y, yaw: rng.bool() ? 0 : Math.PI / 2, scale: 1,
      color: rng.pick([0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x7f8c8d]),
      collider: 'box', hx: 3.0, hz: 1.3, ch: rng.pick([2.6, 5.2]), surface: SURFACE.METAL,
    });
  }
}

// --- La Piscine : le complexe au bord de l'eau ------------------------------

function buildPool(map) {
  const px = -37, pz = 62;
  const y = terrainHeight(px, pz);
  // Bassin (praticable, on peut nager dedans)
  map.pools.push({ x: px, y: y + 0.2, z: pz, w: 52, d: 26, depth: 2.4, yaw: 0.18 });
  pushBox(map.colliders, { x: px, y: y + 0.5, z: pz - 15, hx: 28, hy: 0.5, hz: 1.6, yaw: 0.18, surface: SURFACE.STONE, tag: 'pool' });
  pushBox(map.colliders, { x: px, y: y + 0.5, z: pz + 15, hx: 28, hy: 0.5, hz: 1.6, yaw: 0.18, surface: SURFACE.STONE, tag: 'pool' });
  // Plongeoirs
  addBuilding(map, { x: px - 30, z: pz + 6, w: 8, d: 10, h: 11, yaw: 0.18, style: 'modern', color: 0xe6ebf0, name: 'Plongeoir' });
  addBuilding(map, { x: px + 34, z: pz - 8, w: 20, d: 12, h: 7, yaw: 0.18, style: 'modern', color: 0xdde4ea });
}

// --- L'Alpage : la ferme ----------------------------------------------------

function buildFarm(map, rng) {
  const { x: cx, z: cz } = ALPAGE;
  addBuilding(map, { x: cx, z: cz, w: 30, d: 18, h: 11, yaw: 0.3, style: 'farm', color: 0xa9855c, roof: 'gable', name: 'La Grange' });
  addBuilding(map, { x: cx - 34, z: cz + 16, w: 18, d: 14, h: 8, yaw: -0.2, style: 'farm', color: 0xb59468, roof: 'gable' });
  addBuilding(map, { x: cx + 32, z: cz - 14, w: 14, d: 14, h: 7, yaw: 0.9, style: 'shed', color: 0x8d7350, roof: 'gable' });
  addBuilding(map, { x: cx + 6, z: cz - 40, w: 22, d: 16, h: 9, yaw: 0.1, style: 'farm', color: 0xbfa079, roof: 'gable', name: 'Fromagerie' });
  // Silo
  addProp(map, 'silo', cx - 18, cz - 24, { collider: 'cyl', r: 3.6, ch: 14, surface: SURFACE.METAL });
  // Bottes de foin
  for (let i = 0; i < 22; i++) {
    const a = rng.float(0, 6.28), d = rng.float(24, 110);
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    addProp(map, 'haybale', x, z, { yaw: rng.float(0, 6.28), scale: rng.float(0.85, 1.15), collider: 'cyl', r: 1.5, ch: 2.2 });
  }
  // Clotures
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const rr = 120;
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    addProp(map, 'fence', x, z, { yaw: -a, scale: 1, collider: 'box', hx: 3.2, hz: 0.2, ch: 1.4 });
  }
  // Moulin sur la crete
  addBuilding(map, { x: cx + 130, z: cz - 90, w: 12, d: 12, h: 18, yaw: 0.4, style: 'farm', color: 0xd8cbb0, roof: 'tower', name: 'Le Moulin' });
}

// --- La Turbie : village de montagne ---------------------------------------

function buildVillage(map, rng) {
  const cx = 90, cz = -120;
  addBuilding(map, { x: cx, z: cz, w: 16, d: 16, h: 22, yaw: 0.2, style: 'oldtown', color: 0xe9dcc0, roof: 'tower', name: 'Le Clocher' });
  for (let i = 0; i < 22; i++) {
    const a = rng.float(0, 6.28), d = rng.float(18, 82);
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    const y = terrainHeight(x, z);
    if (y < 2) continue;
    addBuilding(map, {
      x, z, y, w: rng.float(9, 14), d: rng.float(9, 14), h: rng.float(7, 14),
      yaw: rng.float(0, 6.28), style: 'oldtown', roof: 'tile',
      color: rng.pick([0xe8d5b0, 0xdcc8a8, 0xf0e2c6, 0xd8c0a0]),
    });
  }
  for (let i = 0; i < 24; i++) {
    const a = rng.float(0, 6.28), d = rng.float(30, 110);
    addProp(map, 'cypress', cx + Math.cos(a) * d, cz + Math.sin(a) * d, {
      yaw: rng.float(0, 6.28), scale: rng.float(0.9, 1.5), collider: 'cyl', r: 0.6, ch: 9,
    });
  }
}

// --- Heliport ---------------------------------------------------------------

function buildHeliport(map, rng) {
  const { x: cx, z: cz } = HELIPORT;
  map.helipads.push({ x: cx, y: HELIPORT.y, z: cz, r: 16 });
  addBuilding(map, { x: cx - 40, z: cz + 26, w: 30, d: 22, h: 11, yaw: 0.1, style: 'industrial', color: 0xb9c2c9, name: 'Hangar' });
  addBuilding(map, { x: cx - 40, z: cz - 26, w: 26, d: 18, h: 9, yaw: -0.1, style: 'industrial', color: 0xa8b3bb });
  addProp(map, 'helicopter', cx, cz, { y: HELIPORT.y, yaw: 0.6, scale: 1, collider: 'box', hx: 2.2, hz: 6.5, ch: 3.2, surface: SURFACE.METAL });
  for (let i = 0; i < 14; i++) {
    const x = cx + rng.float(-70, 70), z = cz + rng.float(-70, 70);
    const y = terrainHeight(x, z);
    if (y < 2) continue;
    addProp(map, 'barrel', x, z, { y, yaw: rng.float(0, 6.28), collider: 'cyl', r: 0.5, ch: 1.2, surface: SURFACE.METAL });
  }
}

// --- Nature : forets, rochers, cabanes --------------------------------------

function buildNature(map, rng) {
  // Foret
  for (let i = 0; i < 520; i++) {
    const a = rng.float(0, 6.28), d = Math.sqrt(rng.next()) * 230;
    const x = -470 + Math.cos(a) * d, z = -180 + Math.sin(a) * d;
    const y = terrainHeight(x, z);
    if (y < 2.5) continue;
    if (trackClearance(x, z, 30) < 8) continue;
    addProp(map, 'pine', x, z, {
      y, yaw: rng.float(0, 6.28), scale: rng.float(0.8, 1.6),
      collider: 'cyl', r: 0.55, ch: 12,
    });
  }
  // Bosquets epars sur l'ile
  for (let i = 0; i < 340; i++) {
    const x = rng.float(-WORLD_HALF + 60, WORLD_HALF - 60);
    const z = rng.float(-WORLD_HALF + 60, WORLD_HALF - 60);
    const y = terrainHeight(x, z);
    if (y < 3 || y > 130) continue;
    if (trackClearance(x, z, 28) < 7) continue;
    if (harbourFactor(x, z) > 0.02) continue;
    addProp(map, rng.bool(0.6) ? 'olive' : 'pine', x, z, {
      y, yaw: rng.float(0, 6.28), scale: rng.float(0.7, 1.4),
      collider: 'cyl', r: 0.5, ch: 9,
    });
  }
  // Rochers, surtout sur le Mont Chevre
  for (let i = 0; i < 240; i++) {
    const onMount = rng.bool(0.65);
    let x, z;
    if (onMount) {
      const a = rng.float(0, 6.28), d = Math.sqrt(rng.next()) * MOUNT.r * 0.9;
      x = MOUNT.x + Math.cos(a) * d; z = MOUNT.z + Math.sin(a) * d;
    } else {
      x = rng.float(-WORLD_HALF + 60, WORLD_HALF - 60);
      z = rng.float(-WORLD_HALF + 60, WORLD_HALF - 60);
    }
    const y = terrainHeight(x, z);
    if (y < 2) continue;
    if (trackClearance(x, z, 26) < 6) continue;
    const s = rng.float(1.4, 5.2);
    addProp(map, 'rock', x, z, {
      y, yaw: rng.float(0, 6.28), scale: s,
      collider: 'box', hx: s * 0.8, hz: s * 0.7, ch: s * 1.1, surface: SURFACE.ROCK,
    });
  }
  // Cabane du berger au sommet
  {
    const x = MOUNT.x + 12, z = MOUNT.z + 8;
    addBuilding(map, { x, z, w: 12, d: 10, h: 6, yaw: 0.5, style: 'shed', color: 0x7a6448, roof: 'gable', name: 'Cabane du Berger' });
  }
  // Plage : parasols et rochers
  for (let i = 0; i < 26; i++) {
    const a = rng.float(0, 6.28), d = Math.sqrt(rng.next()) * BEACH.r * 0.8;
    const x = BEACH.x + Math.cos(a) * d, z = BEACH.z + Math.sin(a) * d;
    const y = terrainHeight(x, z);
    if (y < 0.6) continue;
    addProp(map, rng.bool(0.6) ? 'parasol' : 'palm', x, z, {
      y, yaw: rng.float(0, 6.28), scale: rng.float(0.9, 1.2),
      collider: 'cyl', r: 0.3, ch: 4,
    });
  }
  // Phare
  {
    const x = 720, z = 300;
    const y = terrainHeight(x, z);
    if (y > -2) addBuilding(map, { x, z, y: Math.max(y, 1), w: 9, d: 9, h: 24, style: 'oldtown', color: 0xf4f4f4, roof: 'tower', name: 'Le Phare' });
  }
}

// --- Coffres, butin au sol, vehicules ---------------------------------------

function placeGroundY(x, z) {
  return terrainHeight(x, z);
}

function buildLoot(map, rng) {
  let chestId = 0, lootId = 0;

  const addChest = (x, z, kind) => {
    const y = placeGroundY(x, z);
    if (y < SEA_LEVEL + 0.3) return null;
    const c = { id: `c${chestId++}`, x, y, z, yaw: rng.float(0, 6.28), kind };
    map.chests.push(c);
    return c;
  };
  const addFloorLoot = (x, z) => {
    const y = placeGroundY(x, z);
    if (y < SEA_LEVEL + 0.3) return null;
    const l = { id: `f${lootId++}`, x, y, z };
    map.lootSpawns.push(l);
    return l;
  };

  for (const poi of POIS) {
    const density = LOOT_DENSITY[poi.loot] ?? 1;
    const nChests = Math.round(4 + density * 5);
    const nFloor = Math.round(6 + density * 9);
    for (let i = 0; i < nChests; i++) {
      const a = rng.float(0, 6.28), d = Math.sqrt(rng.next()) * poi.r * 0.95;
      const x = poi.x + Math.cos(a) * d, z = poi.z + Math.sin(a) * d;
      const kind = poi.loot === 'very-high' && rng.bool(0.3) ? 'gold'
        : poi.kind === 'circuit' && rng.bool(0.35) ? 'pit'
          : rng.bool(0.14) ? 'gold' : 'wood';
      addChest(x, z, kind);
    }
    for (let i = 0; i < nFloor; i++) {
      const a = rng.float(0, 6.28), d = Math.sqrt(rng.next()) * poi.r;
      addFloorLoot(poi.x + Math.cos(a) * d, poi.z + Math.sin(a) * d);
    }
  }

  // Coffres des stands, alignes le long de la voie
  const ss = trackSamples();
  for (let i = 0; i < 10; i++) {
    const e = trackEdge(4 + i * 5, -1, 9);
    addChest(e.x, e.z, 'pit');
  }
  // Un coffre dore par virage nomme
  for (const c of CORNERS) {
    const si = Math.round((c.cp / 62) * ss.length);
    const e = trackEdge(si, rng.bool() ? 1 : -1, 11);
    addChest(e.x, e.z, rng.bool(0.4) ? 'gold' : 'wood');
  }
  // Le coffre du sommet
  addChest(MOUNT.x + 16, MOUNT.z + 12, 'gold');

  // Butin disperse un peu partout
  for (let i = 0; i < 150; i++) {
    const x = rng.float(-WORLD_HALF + 90, WORLD_HALF - 90);
    const z = rng.float(-WORLD_HALF + 90, WORLD_HALF - 90);
    if (harbourFactor(x, z) > 0.1) continue;
    addFloorLoot(x, z);
  }
}

function buildVehicles(map, rng) {
  let vid = 0;
  const add = (type, x, z, yaw) => {
    const y = terrainHeight(x, z);
    if (type !== 'boat' && y < SEA_LEVEL + 0.3) return;
    if (type === 'boat' && y > SEA_LEVEL - 1) return;
    map.vehicleSpawns.push({ id: `v${vid++}`, type, x, y: Math.max(y, SEA_LEVEL), z, yaw });
  };

  // Monoplaces sur la grille de depart
  for (const slot of startingGrid(14)) add('f1', slot.x, slot.z, slot.yaw);
  // Monoplaces eparpillees sur le circuit
  const ss = trackSamples();
  for (let i = 40; i < ss.length; i += 95) {
    const e = trackEdge(i, rng.bool() ? 1 : -1, 3);
    add('f1', e.x, e.z, Math.atan2(ss[i].tx, ss[i].tz));
  }
  // Scooters en ville et sur les quais
  for (let i = 0; i < 26; i++) {
    const x = rng.float(HARBOUR.minX - 60, HARBOUR.maxX + 60);
    const z = rng.float(HARBOUR.minZ - 60, HARBOUR.maxZ + 90);
    if (harbourFactor(x, z) > 0.05) continue;
    add('scooter', x, z, rng.float(0, 6.28));
  }
  for (let i = 0; i < 12; i++) {
    add('scooter', ROCHER.x + rng.float(-90, 90), ROCHER.z + rng.float(-90, 90), rng.float(0, 6.28));
  }
  // Buggys dans la campagne
  const buggySpots = [ALPAGE, MOUNT, RIDGE, { x: -470, z: -180 }, { x: 90, z: -120 }, HELIPORT, BEACH];
  for (const s of buggySpots) {
    for (let i = 0; i < 4; i++) {
      add('buggy', s.x + rng.float(-110, 110), s.z + rng.float(-110, 110), rng.float(0, 6.28));
    }
  }
  for (let i = 0; i < 14; i++) {
    add('buggy', rng.float(-WORLD_HALF + 140, WORLD_HALF - 140), rng.float(-WORLD_HALF + 140, WORLD_HALF - 140), rng.float(0, 6.28));
  }
  // Vedettes dans le port et le long des cotes
  for (let i = 0; i < 10; i++) {
    const x = rng.float(HARBOUR.minX + 30, HARBOUR.maxX - 30);
    const z = rng.float(HARBOUR.minZ + 30, HARBOUR.maxZ - 30);
    add('boat', x, z, rng.float(0, 6.28));
  }
  for (let i = 0; i < 8; i++) {
    const a = rng.float(0, 6.28);
    const d = ISLAND.outer - 40;
    add('boat', ISLAND.cx + Math.cos(a) * d, ISLAND.cz + Math.sin(a) * d, rng.float(0, 6.28));
  }
}

// ---------------------------------------------------------------------------

/** Construit (et met en cache) toute la carte. */
export function buildMap() {
  if (_map) return _map;
  const rng = new RNG(MAP_SEED);
  const map = {
    name: MAP_NAME,
    seed: MAP_SEED,
    size: WORLD_HALF * 2,
    harbour: HARBOUR,
    island: ISLAND,
    pois: POIS,
    buildings: [],
    props: [],
    colliders: [],
    rails: [],
    yachts: [],
    pools: [],
    ramps: [],
    helipads: [],
    tunnelSegments: [],
    chests: [],
    lootSpawns: [],
    vehicleSpawns: [],
    startLine: null,
  };

  buildCircuit(map, rng.fork(1));
  buildCity(map, rng.fork(2));
  buildOldTown(map, rng.fork(3));
  buildHarbour(map, rng.fork(4));
  buildPool(map);
  buildFarm(map, rng.fork(5));
  buildVillage(map, rng.fork(6));
  buildHeliport(map, rng.fork(7));
  buildNature(map, rng.fork(8));
  map.pruned = pruneTrackObstructions(map);
  buildLoot(map, rng.fork(9));
  buildVehicles(map, rng.fork(10));

  _map = map;
  return map;
}

export function resetMapCache() { _map = null; _field = null; _ownerSeq = 0; }

/**
 * Point de depart valide (sur la terre ferme, hors obstacle grossier).
 * Utilise pour placer les joueurs a la sortie du planeur.
 */
export function randomLandPoint(rng, centerX = 0, centerZ = 80, radius = 620) {
  for (let i = 0; i < 60; i++) {
    const a = rng.float(0, Math.PI * 2);
    const d = Math.sqrt(rng.next()) * radius;
    const x = centerX + Math.cos(a) * d;
    const z = centerZ + Math.sin(a) * d;
    const y = terrainHeight(x, z);
    if (y > SEA_LEVEL + 1.5 && y < 150) return { x, y, z };
  }
  return { x: centerX, y: Math.max(terrainHeight(centerX, centerZ), 2), z: centerZ };
}

/** Trajectoire de l'« hélico-chèvre » : une corde traversant l'ile. */
export function flightPath(rng) {
  const a = rng.float(0, Math.PI * 2);
  const r = 780;
  const cx = ISLAND.cx, cz = ISLAND.cz;
  return {
    from: { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r },
    to: { x: cx - Math.cos(a) * r, z: cz - Math.sin(a) * r },
    angle: a,
  };
}

/** Nom de la zone la plus proche (kill-feed, minimap). */
export function zoneNameAt(x, z) {
  let best = null, bestScore = Infinity;
  for (const p of POIS) {
    const d = Math.hypot(x - p.x, z - p.z);
    const score = d - p.r;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  if (best && bestScore < 60) return best.name;
  return 'Les Collines';
}

export default {
  MAP_SEED, MAP_NAME, ISLAND, HARBOUR, ROCHER, MOUNT, BEACH, ALPAGE, HELIPORT, POIS,
  terrainHeight, surfaceTypeAt, isWaterAt, waterDepth, harbourFactor,
  buildMap, resetMapCache, randomLandPoint, flightPath, zoneNameAt,
};
