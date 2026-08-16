// KoRoyale — effets de combat, tempete et meteo.
//
// Tout est genere proceduralement : quads face camera (BufferGeometry unique
// par famille d'effet), nuages de points, ShaderMaterial pour la Brume du Rocher.
// Aucune texture externe : les CanvasTexture sont fabriquees paresseusement a la
// premiere construction (le module se charge donc sans DOM, sous Node).
//
// Regles de perf :
//  - un seul Mesh par famille (tracers, halos, fumee, anneaux, decals, pings) ;
//  - pools de taille fixe : aucune geometrie allouee apres le constructeur ;
//  - aucun Vector3 / Color / tableau alloue dans les boucles d'update ;
//  - pas de PointLight : les explosions sont des sprites additifs.
//
// Repere : X est, Z nord, Y haut. 1 unite = 1 metre.

import * as THREE from 'three';
import { SURFACE, STORM_PHASES } from '../../../shared/constants.js';
import { clamp, clamp01, lerp, TAU } from '../../../shared/math.js';
import { RNG } from '../../../shared/rng.js';

// ---------------------------------------------------------------------------
// Reglages
// ---------------------------------------------------------------------------

/** Presets de densite. Les pools « lisibles » (tracers, decals) bougent peu. */
const QUALITY = {
  low:    { tracers: 80,  glows: 40, puffs: 40,  particles: 170, rain: 420,  mul: 0.45 },
  medium: { tracers: 120, glows: 64, puffs: 72,  particles: 380, rain: 1000, mul: 0.75 },
  high:   { tracers: 120, glows: 96, puffs: 110, particles: 700, rain: 2000, mul: 1.0 },
};

const DECAL_COUNT = 60;   // pool de decals (impacts + brulures)
const DECAL_LIFE = 8;     // secondes
const RING_COUNT = 20;    // ondes de choc + gerbes d'eau
const PING_COUNT = 8;     // colonnes de marquage
const PING_LIFE = 10;     // secondes
const NUM_COUNT = 24;     // nombres de degats simultanes
const NUM_LIFE = 1;       // secondes

const STORM_HEIGHT = 400; // hauteur du mur de brume
const STORM_Y = 150;      // centre du cylindre : le mur va de -50 a +350

// Meteo : parametres des segments (pluie battante ou souffle de poussiere)
const WEATHER = {
  rain: { part: 1.0,  len: 0.95, fall: [26, 36], color: 0xbfe6ff, opacity: 0.42, gust: 4,  box: 26 },
  wind: { part: 0.35, len: 2.30, fall: [1.5, 4], color: 0xe9dfc6, opacity: 0.15, gust: 17, box: 34 },
};

// Couleurs des nombres de degats
const NUM_WHITE = 0xffffff;
const NUM_CRIT = 0xffd23f;
const NUM_SHIELD = 0x7ec8ff;

/**
 * Reponse visuelle par surface.
 * spark = gerbe additive (etincelles, ecume), sinon particules opaques.
 */
const IMPACT = {};
IMPACT[SURFACE.GRASS] =
  { n: 10, spread: 0.95, speed: 4.4, grav: 15, drag: 1.4, ttl: 0.6, spark: false,
    a: 0x6d7c3c, b: 0x4a3b28, flash: 0, decal: 0x2b2417, decalSize: 0.5, decalA: 0.5 };
IMPACT[SURFACE.ASPHALT] =
  { n: 9, spread: 1.0, speed: 5.2, grav: 12, drag: 1.6, ttl: 0.55, spark: false,
    a: 0x9aa1a8, b: 0x6b7076, flash: 0.22, decal: 0x1b1d21, decalSize: 0.44, decalA: 0.55 };
IMPACT[SURFACE.STONE] =
  { n: 10, spread: 1.0, speed: 5.0, grav: 13, drag: 1.5, ttl: 0.6, spark: false,
    a: 0xd8cdb6, b: 0xa8977c, flash: 0.22, decal: 0x3a3327, decalSize: 0.46, decalA: 0.55 };
IMPACT[SURFACE.ROCK] =
  { n: 10, spread: 1.0, speed: 5.0, grav: 14, drag: 1.5, ttl: 0.6, spark: false,
    a: 0xbdb6a6, b: 0x8a8274, flash: 0.2, decal: 0x33302a, decalSize: 0.5, decalA: 0.5 };
IMPACT[SURFACE.WOOD] =
  { n: 9, spread: 0.85, speed: 5.6, grav: 16, drag: 1.2, ttl: 0.65, spark: false,
    a: 0xb98b4e, b: 0x6d4c26, flash: 0, decal: 0x2e2013, decalSize: 0.36, decalA: 0.6 };
IMPACT[SURFACE.WATER] =
  { n: 14, spread: 0.55, speed: 6.6, grav: 19, drag: 0.6, ttl: 0.7, spark: true,
    a: 0xffffff, b: 0xd2f2fb, flash: 0.18, decal: 0, decalSize: 0, decalA: 0 };
IMPACT[SURFACE.SAND] =
  { n: 12, spread: 1.05, speed: 4.2, grav: 13, drag: 2.0, ttl: 0.7, spark: false,
    a: 0xe8d9ac, b: 0xc4ab74, flash: 0, decal: 0x6b5c3a, decalSize: 0.55, decalA: 0.35 };
IMPACT[SURFACE.METAL] =
  { n: 12, spread: 1.15, speed: 8.5, grav: 17, drag: 1.1, ttl: 0.5, spark: true,
    a: 0xffe3a8, b: 0xff8a3c, flash: 0.34, decal: 0x22242a, decalSize: 0.3, decalA: 0.5 };

// ---------------------------------------------------------------------------
// Temporaires module (jamais d'allocation dans les boucles d'update)
// ---------------------------------------------------------------------------
const _col = new THREE.Color();
const _v = new THREE.Vector3();
const _camPos = new THREE.Vector3(0, 0, 0);
const _camRight = new THREE.Vector3(1, 0, 0);
const _camUp = new THREE.Vector3(0, 1, 0);
const _camDir = new THREE.Vector3(0, 0, 1);
let _dx = 0, _dy = 0, _dz = 0; // direction tiree par coneDir()

const rnd = (a, b) => a + Math.random() * (b - a);

/** 'low' | 'medium' | 'high', ou 0 | 1 | 2. */
function resolveQuality(q) {
  if (typeof q === 'number') return q <= 0 ? QUALITY.low : q === 1 ? QUALITY.medium : QUALITY.high;
  return QUALITY[q] || QUALITY.medium;
}

/** Direction unitaire dans un cone autour de (nx,ny,nz). Resultat dans _dx/_dy/_dz. */
function coneDir(nx, ny, nz, spread) {
  let hx = 0, hy = 1, hz = 0;
  if (ny > 0.92 || ny < -0.92) { hx = 1; hy = 0; }
  let tx = hy * nz - hz * ny, ty = hz * nx - hx * nz, tz = hx * ny - hy * nx;
  const l = Math.hypot(tx, ty, tz) || 1;
  tx /= l; ty /= l; tz /= l;
  const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
  const a = Math.random() * TAU;
  const r = Math.tan(clamp(spread, 0, 1.3)) * Math.sqrt(Math.random());
  const cx = Math.cos(a) * r, cy = Math.sin(a) * r;
  _dx = nx + tx * cx + bx * cy;
  _dy = ny + ty * cx + by * cy;
  _dz = nz + tz * cx + bz * cy;
  const m = Math.hypot(_dx, _dy, _dz) || 1;
  _dx /= m; _dy /= m; _dz /= m;
}

// ---------------------------------------------------------------------------
// Textures procedurales (canvas cree paresseusement : pas de DOM au chargement)
// ---------------------------------------------------------------------------
function newCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toTexture(canvas, mips = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 1;
  if (!mips) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
  return t;
}

/** Halo radial neutre : sert aux tracers, aux etincelles et aux boules de feu. */
function buildGlowTex() {
  const c = newCanvas(128, 128);
  if (!c) return null;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0.00, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.42, 'rgba(255,255,255,0.28)');
  grd.addColorStop(0.72, 'rgba(255,255,255,0.06)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return toTexture(c);
}

/** Bouffee irreguliere (fumee, poussiere) : quelques blobs puis masque circulaire. */
function buildPuffTex(seed, blobs, hardness) {
  const c = newCanvas(128, 128);
  if (!c) return null;
  const g = c.getContext('2d');
  const rng = new RNG(seed);
  for (let i = 0; i < blobs; i++) {
    const a = rng.float(0, TAU), d = rng.float(0, 26);
    const x = 64 + Math.cos(a) * d, y = 64 + Math.sin(a) * d;
    const r = rng.float(26, 46);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.55)');
    grd.addColorStop(hardness, 'rgba(255,255,255,0.30)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }
  // masque : bords toujours propres
  g.globalCompositeOperation = 'destination-in';
  const m = g.createRadialGradient(64, 64, 8, 64, 64, 63);
  m.addColorStop(0, 'rgba(255,255,255,1)');
  m.addColorStop(0.7, 'rgba(255,255,255,0.9)');
  m.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = m;
  g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'source-over';
  return toTexture(c);
}

/** Anneau doux : onde de choc, gerbe d'eau. */
function buildRingTex() {
  const c = newCanvas(128, 128);
  if (!c) return null;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0.00, 'rgba(255,255,255,0)');
  grd.addColorStop(0.56, 'rgba(255,255,255,0)');
  grd.addColorStop(0.74, 'rgba(255,255,255,0.28)');
  grd.addColorStop(0.87, 'rgba(255,255,255,1)');
  grd.addColorStop(0.95, 'rgba(255,255,255,0.22)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return toTexture(c);
}

/** Colonne de marquage : base large et lumineuse, fondu vers le haut. */
function buildColumnTex() {
  const c = newCanvas(64, 256);
  if (!c) return null;
  const g = c.getContext('2d');
  const gx = g.createLinearGradient(0, 0, 64, 0);
  gx.addColorStop(0.00, 'rgba(255,255,255,0)');
  gx.addColorStop(0.30, 'rgba(255,255,255,0.35)');
  gx.addColorStop(0.50, 'rgba(255,255,255,1)');
  gx.addColorStop(0.70, 'rgba(255,255,255,0.35)');
  gx.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = gx;
  g.fillRect(0, 0, 64, 256);
  // v = 0 est en bas de l'image (flipY par defaut) : on garde la base opaque
  g.globalCompositeOperation = 'destination-in';
  const gy = g.createLinearGradient(0, 256, 0, 0);
  gy.addColorStop(0.00, 'rgba(255,255,255,1)');
  gy.addColorStop(0.12, 'rgba(255,255,255,0.95)');
  gy.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  gy.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = gy;
  g.fillRect(0, 0, 64, 256);
  g.globalCompositeOperation = 'source-over';
  return toTexture(c);
}

/** Croix de touche (hitmarker). */
function buildHitTex() {
  const c = newCanvas(64, 64);
  if (!c) return null;
  const g = c.getContext('2d');
  const seg = [[16, 16, 26, 26], [48, 16, 38, 26], [16, 48, 26, 38], [48, 48, 38, 38]];
  g.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    g.lineWidth = pass === 0 ? 8 : 4;
    g.strokeStyle = pass === 0 ? 'rgba(6,10,16,0.75)' : '#ffffff';
    for (const s of seg) {
      g.beginPath();
      g.moveTo(s[0], s[1]);
      g.lineTo(s[2], s[3]);
      g.stroke();
    }
  }
  return toTexture(c, false);
}

/** Nombre de degats : texte blanc cerne de sombre (la teinte vient du materiau). */
function buildNumberTex(value) {
  const label = String(value);
  const font = '800 64px system-ui, "Segoe UI", Arial, sans-serif';
  const probe = newCanvas(8, 8);
  if (!probe) return null;
  let g = probe.getContext('2d');
  g.font = font;
  const w = Math.max(48, Math.ceil(g.measureText(label).width) + 28);
  const c = newCanvas(w, 96);
  g = c.getContext('2d');
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 11;
  g.strokeStyle = 'rgba(8,12,20,0.9)';
  g.strokeText(label, w / 2, 50);
  g.fillStyle = '#ffffff';
  g.fillText(label, w / 2, 50);
  return { tex: toTexture(c, false), aspect: w / 96 };
}

// ---------------------------------------------------------------------------
// QuadBatch : un seul Mesh, N quads, couleur + alpha par sommet.
// Aucune allocation : les positions sont recalculees a la volee.
// ---------------------------------------------------------------------------
class QuadBatch {
  constructor(count, material, renderOrder = 0) {
    this.count = count;
    this.pos = new Float32Array(count * 12);
    this.col = new Float32Array(count * 16);
    const uv = new Float32Array(count * 8);
    const idx = new Uint16Array(count * 6);
    for (let i = 0; i < count; i++) {
      const u = i * 8;
      uv[u] = 0; uv[u + 1] = 0;
      uv[u + 2] = 1; uv[u + 3] = 0;
      uv[u + 4] = 1; uv[u + 5] = 1;
      uv[u + 6] = 0; uv[u + 7] = 1;
      const v = i * 4, q = i * 6;
      idx[q] = v; idx[q + 1] = v + 1; idx[q + 2] = v + 2;
      idx[q + 3] = v; idx[q + 4] = v + 2; idx[q + 5] = v + 3;
    }
    this.aPos = new THREE.BufferAttribute(this.pos, 3);
    this.aCol = new THREE.BufferAttribute(this.col, 4);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('color', this.aCol);
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
    this.dirty = true;
  }

  /** Ecrit un quad a partir de son centre et de ses deux demi-axes. */
  quad(i, x, y, z, ax, ay, az, bx, by, bz, r, g, b, a) {
    const p = this.pos, o = i * 12;
    p[o] = x - ax - bx; p[o + 1] = y - ay - by; p[o + 2] = z - az - bz;
    p[o + 3] = x + ax - bx; p[o + 4] = y + ay - by; p[o + 5] = z + az - bz;
    p[o + 6] = x + ax + bx; p[o + 7] = y + ay + by; p[o + 8] = z + az + bz;
    p[o + 9] = x - ax + bx; p[o + 10] = y - ay + by; p[o + 11] = z - az + bz;
    const c = this.col, k = i * 16;
    for (let v = 0; v < 4; v++) {
      const q = k + v * 4;
      c[q] = r; c[q + 1] = g; c[q + 2] = b; c[q + 3] = a;
    }
    this.dirty = true;
  }

  /** Quad face camera, tourne de `rot` autour de l'axe de vue. */
  billboard(i, x, y, z, w, h, rot, r, g, b, a) {
    const co = Math.cos(rot), si = Math.sin(rot);
    const hw = w * 0.5, hh = h * 0.5;
    const ax = (_camRight.x * co + _camUp.x * si) * hw;
    const ay = (_camRight.y * co + _camUp.y * si) * hw;
    const az = (_camRight.z * co + _camUp.z * si) * hw;
    const bx = (-_camRight.x * si + _camUp.x * co) * hh;
    const by = (-_camRight.y * si + _camUp.y * co) * hh;
    const bz = (-_camRight.z * si + _camUp.z * co) * hh;
    this.quad(i, x, y, z, ax, ay, az, bx, by, bz, r, g, b, a);
  }

  /** Quad plaque sur une surface, oriente par sa normale (decals, anneaux). */
  planar(i, x, y, z, w, h, nx, ny, nz, rot, r, g, b, a) {
    let hx = 0, hy = 1, hz = 0;
    if (ny > 0.92 || ny < -0.92) { hx = 1; hy = 0; }
    let tx = hy * nz - hz * ny, ty = hz * nx - hx * nz, tz = hx * ny - hy * nx;
    const l = Math.hypot(tx, ty, tz) || 1;
    tx /= l; ty /= l; tz /= l;
    const ux = ny * tz - nz * ty, uy = nz * tx - nx * tz, uz = nx * ty - ny * tx;
    const co = Math.cos(rot), si = Math.sin(rot), hw = w * 0.5, hh = h * 0.5;
    this.quad(
      i, x, y, z,
      (tx * co + ux * si) * hw, (ty * co + uy * si) * hw, (tz * co + uz * si) * hw,
      (-tx * si + ux * co) * hh, (-ty * si + uy * co) * hh, (-tz * si + uz * co) * hh,
      r, g, b, a,
    );
  }

  /** Segment epais oriente vers la camera (tracers). */
  segment(i, x1, y1, z1, x2, y2, z2, w, r, g, b, a) {
    const mx = (x1 + x2) * 0.5, my = (y1 + y2) * 0.5, mz = (z1 + z2) * 0.5;
    const ax = (x2 - x1) * 0.5, ay = (y2 - y1) * 0.5, az = (z2 - z1) * 0.5;
    const vx = mx - _camPos.x, vy = my - _camPos.y, vz = mz - _camPos.z;
    let sx = ay * vz - az * vy, sy = az * vx - ax * vz, sz = ax * vy - ay * vx;
    let l = Math.hypot(sx, sy, sz);
    if (l < 1e-6) { sx = _camRight.x; sy = _camRight.y; sz = _camRight.z; l = 1; }
    const k = (w * 0.5) / l;
    this.quad(i, mx, my, mz, ax, ay, az, sx * k, sy * k, sz * k, r, g, b, a);
  }

  /** Quad vertical qui pivote autour de Y pour faire face a la camera (colonnes). */
  column(i, x, y, z, w, h, r, g, b, a) {
    let dx = x - _camPos.x, dz = z - _camPos.z;
    let l = Math.hypot(dx, dz);
    if (l < 1e-5) { dx = 0; dz = 1; l = 1; }
    dx /= l; dz /= l;
    // demi-axe horizontal = perpendiculaire a la direction de vue
    this.quad(i, x, y + h * 0.5, z, -dz * w * 0.5, 0, dx * w * 0.5, 0, h * 0.5, 0, r, g, b, a);
  }

  hide(i) {
    const p = this.pos, o = i * 12;
    for (let k = 0; k < 12; k++) p[o + k] = 0;
    const c = this.col, q = i * 16;
    for (let k = 0; k < 16; k++) c[q + k] = 0;
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.dirty = false;
  }

  dispose() {
    this.geo.dispose();
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// PuffSystem : bouffees face camera qui grossissent et s'estompent
// (halos additifs, fumee, flashs de bouche).
// ---------------------------------------------------------------------------
class PuffSystem {
  constructor(batch) {
    const n = batch.count;
    this.batch = batch;
    this.n = n;
    this.head = 0;
    this.on = new Uint8Array(n);
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.s0 = new Float32Array(n); this.s1 = new Float32Array(n);
    this.life = new Float32Array(n); this.ttl = new Float32Array(n);
    this.r = new Float32Array(n); this.g = new Float32Array(n); this.b = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.rot = new Float32Array(n); this.spin = new Float32Array(n);
    this.grav = new Float32Array(n); this.drag = new Float32Array(n);
    this.wind = new Float32Array(n);
  }

  spawn(x, y, z, vx, vy, vz, s0, s1, ttl, r, g, b, a, spin, grav, drag, wind) {
    const i = this.head;
    this.head = (this.head + 1) % this.n;
    this.on[i] = 1; this.life[i] = 0; this.ttl[i] = ttl;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.s0[i] = s0; this.s1[i] = s1;
    this.r[i] = r; this.g[i] = g; this.b[i] = b; this.a0[i] = a;
    this.rot[i] = Math.random() * TAU; this.spin[i] = spin;
    this.grav[i] = grav; this.drag[i] = drag; this.wind[i] = wind;
    return i;
  }

  update(dt, wx, wz) {
    const b = this.batch;
    for (let i = 0; i < this.n; i++) {
      if (!this.on[i]) continue;
      const t = (this.life[i] += dt);
      const ttl = this.ttl[i];
      if (t >= ttl) { this.on[i] = 0; b.hide(i); continue; }
      const k = t / ttl;
      const d = 1 - this.drag[i] * dt;
      const df = d < 0 ? 0 : d;
      const w = this.wind[i] * dt;
      this.vx[i] = this.vx[i] * df + wx * w;
      this.vy[i] = (this.vy[i] - this.grav[i] * dt) * df;
      this.vz[i] = this.vz[i] * df + wz * w;
      const x = (this.x[i] += this.vx[i] * dt);
      const y = (this.y[i] += this.vy[i] * dt);
      const z = (this.z[i] += this.vz[i] * dt);
      const grow = 1 - (1 - k) * (1 - k);
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * grow;
      const fin = k < 0.1 ? k / 0.1 : 1;
      const fout = 1 - k;
      const a = this.a0[i] * fin * fout * fout;
      b.billboard(i, x, y, z, s, s, this.rot[i] + this.spin[i] * t, this.r[i], this.g[i], this.b[i], a);
    }
  }

  clear() {
    for (let i = 0; i < this.n; i++) if (this.on[i]) { this.on[i] = 0; this.batch.hide(i); }
  }
}

// ---------------------------------------------------------------------------
// RingSystem : anneaux horizontaux qui s'ouvrent (ondes de choc, gerbes d'eau).
// ---------------------------------------------------------------------------
class RingSystem {
  constructor(batch) {
    const n = batch.count;
    this.batch = batch;
    this.n = n;
    this.head = 0;
    this.on = new Uint8Array(n);
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n);
    this.r0 = new Float32Array(n); this.r1 = new Float32Array(n);
    this.life = new Float32Array(n); this.ttl = new Float32Array(n);
    this.r = new Float32Array(n); this.g = new Float32Array(n); this.b = new Float32Array(n);
    this.a0 = new Float32Array(n);
  }

  spawn(x, y, z, r0, r1, ttl, r, g, b, a) {
    const i = this.head;
    this.head = (this.head + 1) % this.n;
    this.on[i] = 1; this.life[i] = 0; this.ttl[i] = ttl;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.r0[i] = r0; this.r1[i] = r1;
    this.r[i] = r; this.g[i] = g; this.b[i] = b; this.a0[i] = a;
  }

  update(dt) {
    const b = this.batch;
    for (let i = 0; i < this.n; i++) {
      if (!this.on[i]) continue;
      const t = (this.life[i] += dt);
      const ttl = this.ttl[i];
      if (t >= ttl) { this.on[i] = 0; b.hide(i); continue; }
      const k = t / ttl;
      const grow = 1 - (1 - k) * (1 - k) * (1 - k);
      const d = (this.r0[i] + (this.r1[i] - this.r0[i]) * grow) * 2;
      const a = this.a0[i] * (1 - k) * (1 - k);
      b.planar(i, this.x[i], this.y[i], this.z[i], d, d, 0, 1, 0, 0, this.r[i], this.g[i], this.b[i], a);
    }
  }

  clear() {
    for (let i = 0; i < this.n; i++) if (this.on[i]) { this.on[i] = 0; this.batch.hide(i); }
  }
}

// ---------------------------------------------------------------------------
// DecalSystem : taches sombres plaquees sur les surfaces touchees.
// ---------------------------------------------------------------------------
class DecalSystem {
  constructor(batch, life) {
    const n = batch.count;
    this.batch = batch;
    this.n = n;
    this.head = 0;
    this.life = life;
    this.on = new Uint8Array(n);
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n);
    this.nx = new Float32Array(n); this.ny = new Float32Array(n); this.nz = new Float32Array(n);
    this.size = new Float32Array(n); this.rot = new Float32Array(n);
    this.t = new Float32Array(n); this.ttl = new Float32Array(n);
    this.r = new Float32Array(n); this.g = new Float32Array(n); this.b = new Float32Array(n);
    this.a0 = new Float32Array(n);
  }

  spawn(x, y, z, nx, ny, nz, size, r, g, b, a, ttl) {
    const i = this.head;
    this.head = (this.head + 1) % this.n;
    this.on[i] = 1; this.t[i] = 0; this.ttl[i] = ttl || this.life;
    // legerement decolle de la surface pour eviter le z-fighting
    this.x[i] = x + nx * 0.02; this.y[i] = y + ny * 0.02; this.z[i] = z + nz * 0.02;
    this.nx[i] = nx; this.ny[i] = ny; this.nz[i] = nz;
    this.size[i] = size; this.rot[i] = Math.random() * TAU;
    this.r[i] = r; this.g[i] = g; this.b[i] = b; this.a0[i] = a;
  }

  update(dt) {
    const b = this.batch;
    for (let i = 0; i < this.n; i++) {
      if (!this.on[i]) continue;
      const t = (this.t[i] += dt);
      const ttl = this.ttl[i];
      if (t >= ttl) { this.on[i] = 0; b.hide(i); continue; }
      const k = t / ttl;
      // opaque puis effacement sur le dernier tiers
      const a = this.a0[i] * (k < 0.66 ? 1 : 1 - (k - 0.66) / 0.34);
      const s = this.size[i] * (k < 0.08 ? 0.65 + (k / 0.08) * 0.35 : 1);
      b.planar(i, this.x[i], this.y[i], this.z[i], s, s,
        this.nx[i], this.ny[i], this.nz[i], this.rot[i],
        this.r[i], this.g[i], this.b[i], a);
    }
  }

  clear() {
    for (let i = 0; i < this.n; i++) if (this.on[i]) { this.on[i] = 0; this.batch.hide(i); }
  }
}

// ---------------------------------------------------------------------------
// PingSystem : colonnes lumineuses de marquage, ~10 s, avec battement.
// ---------------------------------------------------------------------------
class PingSystem {
  constructor(batch) {
    const n = batch.count;
    this.batch = batch;
    this.n = n;
    this.head = 0;
    this.on = new Uint8Array(n);
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n);
    this.t = new Float32Array(n); this.ttl = new Float32Array(n);
    this.r = new Float32Array(n); this.g = new Float32Array(n); this.b = new Float32Array(n);
  }

  spawn(x, y, z, r, g, b, ttl) {
    const i = this.head;
    this.head = (this.head + 1) % this.n;
    this.on[i] = 1; this.t[i] = 0; this.ttl[i] = ttl;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.r[i] = r; this.g[i] = g; this.b[i] = b;
  }

  update(dt, time) {
    const b = this.batch;
    for (let i = 0; i < this.n; i++) {
      if (!this.on[i]) continue;
      const t = (this.t[i] += dt);
      const ttl = this.ttl[i];
      if (t >= ttl) { this.on[i] = 0; b.hide(i); continue; }
      const k = t / ttl;
      const fin = t < 0.25 ? t / 0.25 : 1;                  // jaillissement
      const fout = k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1;    // effacement
      const puls = 0.72 + 0.28 * Math.sin(time * 5 + i * 1.7);
      const h = 60 * (0.35 + 0.65 * fin);
      b.column(i, this.x[i], this.y[i], this.z[i], 2.6, h,
        this.r[i], this.g[i], this.b[i], 0.9 * fin * fout * puls);
    }
  }

  clear() {
    for (let i = 0; i < this.n; i++) if (this.on[i]) { this.on[i] = 0; this.batch.hide(i); }
  }
}

// ---------------------------------------------------------------------------
// ParticlePool : nuage de points (etincelles additives ou poussieres opaques).
// Compaction par echange : les particules vivantes restent contigues.
// ---------------------------------------------------------------------------
class ParticlePool {
  constructor(max, material, renderOrder = 0) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max); this.vz = new Float32Array(max);
    this.life = new Float32Array(max); this.ttl = new Float32Array(max);
    this.grav = new Float32Array(max); this.drag = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.aPos = new THREE.BufferAttribute(this.pos, 3);
    this.aCol = new THREE.BufferAttribute(this.col, 4);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('color', this.aCol);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geo = geo;
    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.renderOrder = renderOrder;
    this._wasEmpty = true;
  }

  spawn(x, y, z, vx, vy, vz, r, g, b, a, ttl, grav, drag) {
    let i;
    if (this.n < this.max) i = this.n++;
    else i = (Math.random() * this.max) | 0; // pool plein : on recycle
    const p = i * 3, c = i * 4;
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
    this.col[c] = r; this.col[c + 1] = g; this.col[c + 2] = b; this.col[c + 3] = a;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = 0; this.ttl[i] = ttl;
    this.grav[i] = grav; this.drag[i] = drag; this.a0[i] = a;
  }

  _swap(i, j) {
    if (i === j) return;
    const pi = i * 3, pj = j * 3, ci = i * 4, cj = j * 4;
    this.pos[pi] = this.pos[pj]; this.pos[pi + 1] = this.pos[pj + 1]; this.pos[pi + 2] = this.pos[pj + 2];
    this.col[ci] = this.col[cj]; this.col[ci + 1] = this.col[cj + 1];
    this.col[ci + 2] = this.col[cj + 2]; this.col[ci + 3] = this.col[cj + 3];
    this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
    this.life[i] = this.life[j]; this.ttl[i] = this.ttl[j];
    this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j]; this.a0[i] = this.a0[j];
  }

  update(dt, wx, wz) {
    for (let i = 0; i < this.n; i++) {
      const t = (this.life[i] += dt);
      if (t >= this.ttl[i]) {
        this.n--;
        this._swap(i, this.n);
        i--;
        continue;
      }
      const d = 1 - this.drag[i] * dt;
      const df = d < 0 ? 0 : d;
      this.vx[i] = this.vx[i] * df + wx * dt * 0.35;
      this.vy[i] = (this.vy[i] - this.grav[i] * dt) * df;
      this.vz[i] = this.vz[i] * df + wz * dt * 0.35;
      const p = i * 3;
      this.pos[p] += this.vx[i] * dt;
      this.pos[p + 1] += this.vy[i] * dt;
      this.pos[p + 2] += this.vz[i] * dt;
      const k = 1 - t / this.ttl[i];
      this.col[i * 4 + 3] = this.a0[i] * k * k;
    }
    const empty = this.n === 0;
    this.geo.setDrawRange(0, this.n);
    if (!empty || !this._wasEmpty) {
      this.aPos.needsUpdate = true;
      this.aCol.needsUpdate = true;
    }
    this._wasEmpty = empty;
  }

  clear() {
    this.n = 0;
    this.geo.setDrawRange(0, 0);
  }

  dispose() {
    this.geo.dispose();
    if (this.points.parent) this.points.parent.remove(this.points);
  }
}

// ---------------------------------------------------------------------------
// Shaders de la tempete (« la Brume du Rocher »)
// ---------------------------------------------------------------------------
const STORM_VERT = /* glsl */`
  varying vec3 vWorld;
  varying vec2 vUvS;
  varying vec3 vNrm;
  void main() {
    vUvS = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vNrm = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const STORM_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uBands;
  uniform float uOpacity;
  uniform float uBase;
  uniform vec2 uFade;
  uniform vec3 uColA;
  uniform vec3 uColB;
  varying vec3 vWorld;
  varying vec2 vUvS;
  varying vec3 vNrm;

  void main() {
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - abs(dot(normalize(vNrm), V)), 2.5);
    float u = vUvS.x;
    float v = vUvS.y;
    float t = uTime;
    // trois trains de bandes verticales qui defilent a des vitesses differentes
    float b1 = sin(u * uBands * 6.2831 + t * 0.85 + v * 3.0);
    float b2 = sin(u * uBands * 2.7 * 6.2831 - t * 1.9 + v * 11.0);
    float b3 = sin(u * uBands * 0.55 * 6.2831 + t * 0.32 - v * 2.0);
    float band = (b1 * 0.45 + b2 * 0.28 + b3 * 0.27) * 0.5 + 0.5;
    float haut = 1.0 - smoothstep(uFade.x, uFade.y, v);
    float bas = smoothstep(0.0, uBase, v);
    float dens = haut * bas;
    float a = uOpacity * dens * (0.16 + band * 0.55 + fres * 0.75);
    vec3 col = mix(uColA, uColB, clamp(band * 0.65 + fres * 0.4, 0.0, 1.0));
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------
export class Effects {
  /**
   * @param {THREE.Scene} scene
   * @param {{quality?: string|number, camera?: THREE.Camera}} [opts]
   */
  constructor(scene, opts = {}) {
    const o = opts || {};
    this.scene = scene || null;
    this.q = resolveQuality(o.quality);
    this.camera = o.camera || null;
    this.enabled = true;

    this._time = 0;
    this._weather = 'clear';
    this._windAng = Math.random() * TAU;
    this._windX = 0;
    this._windZ = 0;
    this._texs = new Map();
    this._numTexs = new Map();
    this._mats = [];

    this.group = new THREE.Group();
    this.group.name = 'effets';
    this.group.matrixAutoUpdate = false;
    if (this.scene && this.scene.add) this.scene.add(this.group);

    this._buildBatches();
    this._buildParticles();
    this._buildTracers();
    this._buildNumbers();
    this._buildHitMarker();
    this._buildStorm();
    this._buildRain();
  }

  // --- construction --------------------------------------------------------

  _tex(key) {
    let t = this._texs.get(key);
    if (t !== undefined) return t;
    if (key === 'glow') t = buildGlowTex();
    else if (key === 'smoke') t = buildPuffTex(0x5eed, 7, 0.45);
    else if (key === 'dust') t = buildPuffTex(0xd451, 5, 0.3);
    else if (key === 'ring') t = buildRingTex();
    else if (key === 'decal') t = buildPuffTex(0xdeca1, 6, 0.72);
    else if (key === 'column') t = buildColumnTex();
    else if (key === 'hit') t = buildHitTex();
    else t = null;
    this._texs.set(key, t);
    return t;
  }

  _keep(mat) {
    this._mats.push(mat);
    return mat;
  }

  _batch(count, mat, order) {
    const b = new QuadBatch(count, mat, order);
    this.group.add(b.mesh);
    return b;
  }

  _buildBatches() {
    const glowTex = this._tex('glow');
    const add = {
      map: glowTex, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    };
    this._tracerBatch = this._batch(this.q.tracers, this._keep(new THREE.MeshBasicMaterial(add)), 6);
    this._glowBatch = this._batch(this.q.glows, this._keep(new THREE.MeshBasicMaterial(add)), 6);

    this._ringBatch = this._batch(RING_COUNT, this._keep(new THREE.MeshBasicMaterial({
      map: this._tex('ring'), vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    })), 5);

    this._pingBatch = this._batch(PING_COUNT, this._keep(new THREE.MeshBasicMaterial({
      map: this._tex('column'), vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    })), 7);

    this._smokeBatch = this._batch(this.q.puffs, this._keep(new THREE.MeshBasicMaterial({
      map: this._tex('smoke'), vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    })), 4);

    this._decalBatch = this._batch(DECAL_COUNT, this._keep(new THREE.MeshBasicMaterial({
      map: this._tex('decal'), vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    })), 3);

    this._glow = new PuffSystem(this._glowBatch);
    this._smoke = new PuffSystem(this._smokeBatch);
    this._rings = new RingSystem(this._ringBatch);
    this._decals = new DecalSystem(this._decalBatch, DECAL_LIFE);
    this._pings = new PingSystem(this._pingBatch);
  }

  _buildParticles() {
    const n = this.q.particles;
    this._sparks = new ParticlePool(Math.round(n * 0.45), this._keep(new THREE.PointsMaterial({
      size: 0.16, sizeAttenuation: true, map: this._tex('glow'), vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    })), 5);
    this._dust = new ParticlePool(Math.round(n * 0.55), this._keep(new THREE.PointsMaterial({
      size: 0.3, sizeAttenuation: true, map: this._tex('dust'), vertexColors: true,
      transparent: true, depthWrite: false, toneMapped: false,
    })), 4);
    this.group.add(this._sparks.points);
    this.group.add(this._dust.points);
  }

  _buildTracers() {
    const n = this.q.tracers;
    this._trN = n;
    this._trHead = 0;
    this._trOn = new Uint8Array(n);
    this._trAx = new Float32Array(n); this._trAy = new Float32Array(n); this._trAz = new Float32Array(n);
    this._trBx = new Float32Array(n); this._trBy = new Float32Array(n); this._trBz = new Float32Array(n);
    this._trLife = new Float32Array(n); this._trTtl = new Float32Array(n);
    this._trTail = new Float32Array(n); this._trW = new Float32Array(n);
    this._trR = new Float32Array(n); this._trG = new Float32Array(n); this._trB = new Float32Array(n);
  }

  _buildNumbers() {
    this._nums = [];
    this._numHead = 0;
    for (let i = 0; i < NUM_COUNT; i++) {
      const mat = this._keep(new THREE.SpriteMaterial({
        transparent: true, depthTest: false, depthWrite: false,
        sizeAttenuation: false, toneMapped: false,
      }));
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.renderOrder = 20;
      sp.matrixAutoUpdate = true;
      this.group.add(sp);
      this._nums.push({ sp, on: 0, t: 0, x: 0, y: 0, z: 0, h: 0.055, aspect: 1, vy: 1 });
    }
  }

  _buildHitMarker() {
    const mat = this._keep(new THREE.SpriteMaterial({
      map: this._tex('hit'), transparent: true, depthTest: false, depthWrite: false,
      sizeAttenuation: false, toneMapped: false, opacity: 0,
    }));
    this._hit = new THREE.Sprite(mat);
    this._hit.visible = false;
    this._hit.renderOrder = 21;
    this.group.add(this._hit);
    this._hitT = 0;
    this._hitTtl = 0.34;
    this._hitSize = 0.05;
  }

  _stormMaterial(colA, colB, opacity, fade0, fade1, base) {
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBands: { value: 40 },
        uOpacity: { value: opacity },
        uBase: { value: base },
        uFade: { value: new THREE.Vector2(fade0, fade1) },
        uColA: { value: new THREE.Color(colA) },
        uColB: { value: new THREE.Color(colB) },
      },
      vertexShader: STORM_VERT,
      fragmentShader: STORM_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    return this._keep(m);
  }

  _buildStorm() {
    // Rayon 1 : setStorm() ne fera que deplacer et redimensionner ces deux mailles.
    this._stormGeo = new THREE.CylinderGeometry(1, 1, STORM_HEIGHT, 56, 1, true);
    this._nextGeo = new THREE.CylinderGeometry(1, 1, 3, 48, 1, true);

    this.stormWall = new THREE.Mesh(this._stormGeo, this._stormMaterial(0x5b32c8, 0x2f9bff, 1.0, 0.30, 0.66, 0.02));
    this.stormWall.frustumCulled = false;
    this.stormWall.renderOrder = 2;
    this.stormWall.visible = false;
    this.group.add(this.stormWall);

    this.stormNext = new THREE.Mesh(this._nextGeo, this._stormMaterial(0x7ee0ff, 0xffffff, 0.55, 0.55, 1.0, 0.05));
    this.stormNext.frustumCulled = false;
    this.stormNext.renderOrder = 2;
    this.stormNext.visible = false;
    this.group.add(this.stormNext);

    this._stormPhase = -1;
  }

  _buildRain() {
    const n = this.q.rain;
    this._rainN = n;
    this._rainPos = new Float32Array(n * 6);
    this._rainOff = new Float32Array(n * 3);
    this._rainSpd = new Float32Array(n);
    const box = WEATHER.rain.box;
    for (let i = 0; i < n; i++) {
      this._rainOff[i * 3] = rnd(-box, box);
      this._rainOff[i * 3 + 1] = rnd(-box * 0.6, box * 0.8);
      this._rainOff[i * 3 + 2] = rnd(-box, box);
      this._rainSpd[i] = Math.random();
    }
    this._rainAttr = new THREE.BufferAttribute(this._rainPos, 3);
    this._rainAttr.setUsage(THREE.DynamicDrawUsage);
    this._rainGeo = new THREE.BufferGeometry();
    this._rainGeo.setAttribute('position', this._rainAttr);
    this._rainGeo.setDrawRange(0, 0);
    this._rainGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this._rainMat = this._keep(new THREE.LineBasicMaterial({
      color: WEATHER.rain.color, transparent: true, opacity: WEATHER.rain.opacity,
      depthWrite: false, toneMapped: false,
    }));
    this.rain = new THREE.LineSegments(this._rainGeo, this._rainMat);
    this.rain.frustumCulled = false;
    this.rain.matrixAutoUpdate = false;
    this.rain.visible = false;
    this.rain.renderOrder = 8;
    this.group.add(this.rain);
    this._rainHasCam = false;
    this._rainCamX = 0; this._rainCamY = 0; this._rainCamZ = 0;
  }

  // --- API : tracers -------------------------------------------------------

  /**
   * Trainee lumineuse d'un projectile.
   * @param {{x,y,z}} from @param {{x,y,z}} to
   * @param {{color?: number|string, width?: number, life?: number}} [opts]
   */
  tracer(from, to, opts) {
    if (!this.enabled || !from || !to) return;
    const o = opts || {};
    const i = this._trHead;
    this._trHead = (this._trHead + 1) % this._trN;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz) || 0.001;
    this._trAx[i] = from.x; this._trAy[i] = from.y; this._trAz[i] = from.z;
    this._trBx[i] = to.x; this._trBy[i] = to.y; this._trBz[i] = to.z;
    this._trW[i] = o.width || 0.07;
    this._trTtl[i] = o.life || clamp(len / 430, 0.05, 0.3);
    this._trTail[i] = clamp(26 / len, 0.14, 0.95); // ~26 m de trainee visible
    _col.set(o.color === undefined || o.color === null ? 0xfff0c0 : o.color);
    this._trR[i] = _col.r; this._trG[i] = _col.g; this._trB[i] = _col.b;
    this._trOn[i] = 1;
    this._trLife[i] = 0;
  }

  _updateTracers(dt) {
    const b = this._tracerBatch;
    for (let i = 0; i < this._trN; i++) {
      if (!this._trOn[i]) continue;
      const t = (this._trLife[i] += dt);
      const ttl = this._trTtl[i];
      if (t >= ttl) { this._trOn[i] = 0; b.hide(i); continue; }
      const k = t / ttl;
      const tail = this._trTail[i];
      const head = k * (1 + tail) > 1 ? 1 : k * (1 + tail);
      const back = head - tail < 0 ? 0 : head - tail;
      const fade = k < 0.5 ? 1 : 1 - (k - 0.5) / 0.5;
      const ax = this._trAx[i], ay = this._trAy[i], az = this._trAz[i];
      const dx = this._trBx[i] - ax, dy = this._trBy[i] - ay, dz = this._trBz[i] - az;
      b.segment(i,
        ax + dx * back, ay + dy * back, az + dz * back,
        ax + dx * head, ay + dy * head, az + dz * head,
        this._trW[i], this._trR[i], this._trG[i], this._trB[i], fade);
    }
  }

  // --- API : tirs et impacts ----------------------------------------------

  /** Eclair de bouche : halo court + gerbe d'etincelles dans l'axe du canon. */
  muzzleFlash(pos, dir, scale) {
    if (!this.enabled || !pos) return;
    const s = scale || 1;
    let dx = dir ? dir.x : 0, dy = dir ? dir.y : 0, dz = dir ? dir.z : 1;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    const x = pos.x + dx * 0.12, y = pos.y + dy * 0.12, z = pos.z + dz * 0.12;
    _col.set(0xfff3d0);
    this._glow.spawn(x, y, z, dx * 1.2, dy * 1.2, dz * 1.2,
      0.5 * s, 0.86 * s, 0.07, _col.r, _col.g, _col.b, 1.6, rnd(-6, 6), 0, 6, 0);
    _col.set(0xffb347);
    this._glow.spawn(x, y, z, 0, 0, 0,
      0.95 * s, 1.5 * s, 0.055, _col.r, _col.g, _col.b, 0.7, rnd(-4, 4), 0, 8, 0);
    const n = Math.round(4 * this.q.mul);
    for (let i = 0; i < n; i++) {
      coneDir(dx, dy, dz, 0.5);
      const sp = rnd(5, 13) * s;
      _col.set(Math.random() < 0.5 ? 0xffd9a0 : 0xff9a3c);
      this._sparks.spawn(x, y, z, _dx * sp, _dy * sp + 0.6, _dz * sp,
        _col.r, _col.g, _col.b, 1, rnd(0.06, 0.18), 12, 3.5);
    }
    // fine fumee de canon
    if (this.q.mul > 0.5) {
      _col.set(0xd9d4c8);
      this._smoke.spawn(x + dx * 0.2, y + dy * 0.2, z + dz * 0.2, dx * 1.6, dy * 1.6 + 0.4, dz * 1.6,
        0.16 * s, 0.75 * s, 0.5, _col.r, _col.g, _col.b, 0.2, rnd(-1, 1), -0.4, 2.2, 1);
    }
  }

  /**
   * Impact d'une balle : particules selon la surface + decal.
   * @param {{x,y,z}} pos @param {{x,y,z}} normal @param {number} surface valeur de SURFACE
   */
  impact(pos, normal, surface) {
    if (!this.enabled || !pos) return;
    const s = IMPACT[surface] || IMPACT[SURFACE.STONE];
    let nx = normal ? normal.x : 0, ny = normal ? normal.y : 1, nz = normal ? normal.z : 0;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-5) { nx = 0; ny = 1; nz = 0; } else { nx /= l; ny /= l; nz /= l; }
    const x = pos.x + nx * 0.03, y = pos.y + ny * 0.03, z = pos.z + nz * 0.03;

    const pool = s.spark ? this._sparks : this._dust;
    const n = Math.max(2, Math.round(s.n * this.q.mul));
    for (let i = 0; i < n; i++) {
      coneDir(nx, ny, nz, s.spread);
      const sp = rnd(s.speed * 0.35, s.speed);
      _col.set(Math.random() < 0.5 ? s.a : s.b);
      pool.spawn(x, y, z, _dx * sp, _dy * sp, _dz * sp,
        _col.r, _col.g, _col.b, s.spark ? 1 : 0.85,
        rnd(s.ttl * 0.6, s.ttl), s.grav, s.drag);
    }

    if (s.flash > 0) {
      _col.set(s.a);
      this._glow.spawn(x, y, z, 0, 0, 0, 0.16, 0.5, 0.09,
        _col.r, _col.g, _col.b, s.flash * 2, rnd(-3, 3), 0, 4, 0);
    }

    if (surface === SURFACE.WATER) {
      // gerbe blanche : anneau a la surface + petite colonne d'ecume
      _col.set(0xdff5ff);
      this._rings.spawn(pos.x, pos.y + 0.05, pos.z, 0.15, 1.5, 0.55, _col.r, _col.g, _col.b, 0.55);
      this._smoke.spawn(x, y + 0.3, z, 0, 1.6, 0, 0.25, 0.9, 0.45,
        _col.r, _col.g, _col.b, 0.45, rnd(-1, 1), 3, 1.5, 0.4);
      return;
    }

    if (s.decal) {
      _col.set(s.decal);
      this._decals.spawn(pos.x, pos.y, pos.z, nx, ny, nz,
        s.decalSize * rnd(0.8, 1.25), _col.r, _col.g, _col.b, s.decalA, DECAL_LIFE);
    }
  }

  /** Explosion : boule, onde de choc annulaire, fumee, eclats. Aucun PointLight. */
  explosion(pos, radius) {
    if (!this.enabled || !pos) return;
    const r = radius > 0 ? radius : 6;
    const x = pos.x, y = pos.y, z = pos.z;
    const mul = this.q.mul;

    // boule de feu : trois couches qui grossissent
    _col.set(0xfff2c4);
    this._glow.spawn(x, y, z, 0, 0, 0, r * 0.45, r * 1.15, 0.22, _col.r, _col.g, _col.b, 2.2, rnd(-2, 2), 0, 3, 0);
    _col.set(0xffa63c);
    this._glow.spawn(x, y, z, 0, 1.2, 0, r * 0.7, r * 1.9, 0.42, _col.r, _col.g, _col.b, 1.5, rnd(-2, 2), -1, 2.5, 0.3);
    _col.set(0xff5a1e);
    this._glow.spawn(x, y + 0.4, z, 0, 2.2, 0, r * 0.4, r * 2.4, 0.62, _col.r, _col.g, _col.b, 0.9, rnd(-2, 2), -1.5, 2.2, 0.5);

    // onde de choc au sol
    _col.set(0xffd9a0);
    this._rings.spawn(x, y + 0.12, z, r * 0.3, r * 1.9, 0.5, _col.r, _col.g, _col.b, 1.1);
    _col.set(0xffffff);
    this._rings.spawn(x, y + 0.1, z, r * 0.2, r * 1.3, 0.28, _col.r, _col.g, _col.b, 0.8);

    // fumee
    const nf = Math.max(2, Math.round(7 * mul));
    for (let i = 0; i < nf; i++) {
      const a = (i / nf) * TAU + rnd(-0.4, 0.4);
      const sp = rnd(1.5, 4.5);
      _col.set(Math.random() < 0.6 ? 0x4a4440 : 0x8d8781);
      this._smoke.spawn(
        x + Math.cos(a) * r * 0.25, y + rnd(0.2, 1.2), z + Math.sin(a) * r * 0.25,
        Math.cos(a) * sp, rnd(1.2, 3.4), Math.sin(a) * sp,
        r * 0.4, r * 1.5, rnd(1.4, 2.6), _col.r, _col.g, _col.b, 0.55,
        rnd(-1.2, 1.2), -0.35, 1.1, 1);
    }

    // eclats
    const ns = Math.max(4, Math.round(26 * mul));
    for (let i = 0; i < ns; i++) {
      coneDir(0, 1, 0, 1.25);
      const sp = rnd(6, 22);
      _col.set(Math.random() < 0.6 ? 0xffc46b : 0xff7a2a);
      this._sparks.spawn(x, y + 0.3, z, _dx * sp, _dy * sp + 3, _dz * sp,
        _col.r, _col.g, _col.b, 1, rnd(0.3, 0.9), 16, 0.9);
    }

    // trace de brulure
    _col.set(0x14100c);
    this._decals.spawn(x, y + 0.02, z, 0, 1, 0, r * 1.1, _col.r, _col.g, _col.b, 0.6, DECAL_LIFE * 1.6);
  }

  /** Poils de chevre qui volent (et un peu de poussiere) quand une chevre est touchee. */
  bloodPuff(pos, amount) {
    if (!this.enabled || !pos) return;
    const a = amount > 0 ? amount : 10;
    const n = Math.max(3, Math.round(clamp(3 + a * 0.22, 3, 16) * this.q.mul));
    for (let i = 0; i < n; i++) {
      coneDir(0, 1, 0, 1.2);
      const sp = rnd(1.4, 4.6);
      const t = Math.random();
      _col.set(t < 0.45 ? 0xe8dfd2 : t < 0.8 ? 0x8b7355 : 0x8d2f2a);
      this._dust.spawn(pos.x, pos.y, pos.z, _dx * sp, _dy * sp + 1.2, _dz * sp,
        _col.r, _col.g, _col.b, 0.95, rnd(0.5, 1.1), 8.5, 1.8);
    }
    // petite bouffee claire : la touche reste lisible a 150 m
    _col.set(0xf0e4d4);
    this._smoke.spawn(pos.x, pos.y, pos.z, 0, 0.6, 0, 0.25, 0.85, 0.3,
      _col.r, _col.g, _col.b, 0.5, rnd(-2, 2), -0.3, 3, 0.5);
  }

  // --- API : retours d'information ----------------------------------------

  /**
   * Nombre de degats flottant.
   * @param {{x,y,z}} pos @param {number} amount
   * @param {{crit?: boolean, shield?: boolean}} [opts]
   */
  damageNumber(pos, amount, opts) {
    if (!this.enabled || !pos) return;
    const v = Math.max(1, Math.round(amount || 0));
    const e = this._numberTex(v);
    if (!e) return;
    const o = opts || {};
    const slot = this._nums[this._numHead];
    this._numHead = (this._numHead + 1) % this._nums.length;
    const mat = slot.sp.material;
    if (!mat.map) mat.needsUpdate = true;
    mat.map = e.tex;
    mat.color.set(o.crit ? NUM_CRIT : o.shield ? NUM_SHIELD : NUM_WHITE);
    mat.opacity = 1;
    slot.aspect = e.aspect;
    slot.h = o.crit ? 0.072 : 0.056;
    slot.x = pos.x + rnd(-0.25, 0.25);
    slot.y = pos.y + rnd(0, 0.2);
    slot.z = pos.z + rnd(-0.25, 0.25);
    slot.vy = rnd(0.85, 1.2);
    slot.t = 0;
    slot.on = 1;
    slot.sp.visible = true;
    slot.sp.position.set(slot.x, slot.y, slot.z);
  }

  _numberTex(v) {
    let e = this._numTexs.get(v);
    if (e !== undefined) return e;
    e = buildNumberTex(v);
    if (this._numTexs.size > 140) {
      const oldKey = this._numTexs.keys().next().value;
      const old = this._numTexs.get(oldKey);
      this._numTexs.delete(oldKey);
      if (old && old.tex) old.tex.dispose();
    }
    this._numTexs.set(v, e);
    return e;
  }

  _updateNumbers(dt) {
    for (let i = 0; i < this._nums.length; i++) {
      const s = this._nums[i];
      if (!s.on) continue;
      const t = (s.t += dt);
      if (t >= NUM_LIFE) { s.on = 0; s.sp.visible = false; continue; }
      const k = t / NUM_LIFE;
      s.y += s.vy * (1 - k) * dt * 1.6;
      s.sp.position.set(s.x, s.y, s.z);
      const pop = 1 + 0.3 * Math.exp(-k * 14);
      const h = s.h * pop;
      s.sp.scale.set(h * s.aspect, h, 1);
      s.sp.material.opacity = 1 - k * k;
    }
  }

  /** Croix de touche devant la camera (rouge sur une touche a la tete). */
  hitMarker(headshot) {
    if (!this.enabled) return;
    this._hitT = 0;
    this._hitTtl = headshot ? 0.46 : 0.32;
    this._hitSize = headshot ? 0.072 : 0.05;
    this._hit.material.color.set(headshot ? 0xff5f3c : 0xffffff);
    this._hit.material.opacity = 1;
    this._hit.visible = true;
  }

  _updateHitMarker(dt) {
    if (!this._hit.visible) return;
    const t = (this._hitT += dt);
    if (t >= this._hitTtl) { this._hit.visible = false; return; }
    const k = t / this._hitTtl;
    _v.copy(_camPos).addScaledVector(_camDir, 3);
    this._hit.position.copy(_v);
    const s = this._hitSize * (1 + 0.35 * (1 - Math.min(1, k * 5)));
    this._hit.scale.set(s, s, 1);
    this._hit.material.opacity = 1 - k * k;
  }

  /** Colonne lumineuse de marquage, visible une dizaine de secondes. */
  ping(pos, color) {
    if (!this.enabled || !pos) return;
    _col.set(color === undefined || color === null ? 0x7ee0ff : color);
    this._pings.spawn(pos.x, pos.y, pos.z, _col.r, _col.g, _col.b, PING_LIFE);
  }

  /** Bouffee de fumee d'une trainee (roquette, vehicule en feu). */
  smokeTrail(pos) {
    if (!this.enabled || !pos) return;
    _col.set(0xbfb9b0);
    this._smoke.spawn(pos.x, pos.y, pos.z, rnd(-0.3, 0.3), rnd(0.4, 1.1), rnd(-0.3, 0.3),
      0.45, 2.3, rnd(1.1, 1.8), _col.r, _col.g, _col.b, 0.35, rnd(-1, 1), -0.25, 1.3, 1);
  }

  // --- API : tempete -------------------------------------------------------

  /**
   * Position des cercles. Appele 20 fois par seconde : on ne touche
   * jamais a la geometrie, seulement position, echelle et uniformes.
   * @param {{cx,cz,radius,nextCx,nextCz,nextRadius,phase}} state
   */
  setStorm(state) {
    if (!state) {
      this.stormWall.visible = false;
      this.stormNext.visible = false;
      return;
    }
    const r = state.radius || 0;
    const w = this.stormWall;
    if (r > 0.5) {
      w.position.set(state.cx || 0, STORM_Y, state.cz || 0);
      w.scale.set(r, 1, r);
      w.material.uniforms.uBands.value = clamp(r * 0.09, 8, 96);
      w.visible = true;
    } else {
      w.visible = false;
    }

    const nr = state.nextRadius || 0;
    const nx = state.nextCx === undefined ? state.cx : state.nextCx;
    const nz = state.nextCz === undefined ? state.cz : state.nextCz;
    const n = this.stormNext;
    if (nr > 0.5 && nr < r - 0.5) {
      n.position.set(nx || 0, 1.5, nz || 0);
      n.scale.set(nr, 1, nr);
      n.material.uniforms.uBands.value = clamp(nr * 0.12, 6, 96);
      n.visible = true;
    } else {
      n.visible = false;
    }

    const phase = state.phase | 0;
    if (phase !== this._stormPhase) {
      this._stormPhase = phase;
      // plus la partie avance, plus la brume est violette et dense
      const k = clamp01(phase / Math.max(1, STORM_PHASES.length - 1));
      const u = w.material.uniforms;
      u.uColA.value.setHex(0x5b32c8).lerp(_col.set(0xb02cff), k * 0.85);
      u.uColB.value.setHex(0x2f9bff).lerp(_col.set(0xff4fd0), k * 0.6);
      u.uOpacity.value = 0.75 + k * 0.35;
    }
  }

  _updateStorm(dt) {
    if (this.stormWall.visible) this.stormWall.material.uniforms.uTime.value += dt;
    if (this.stormNext.visible) this.stormNext.material.uniforms.uTime.value += dt * 0.6;
  }

  // --- API : meteo ---------------------------------------------------------

  /** @param {'clear'|'rain'|'wind'} kind */
  setWeather(kind) {
    const k = kind === 'rain' || kind === 'wind' ? kind : 'clear';
    if (k === this._weather) return;
    this._weather = k;
    if (k === 'clear') {
      this.rain.visible = false;
      this._rainGeo.setDrawRange(0, 0);
      return;
    }
    const w = WEATHER[k];
    this._rainMat.color.set(w.color);
    this._rainMat.opacity = w.opacity;
    const drawn = Math.max(1, Math.round(this._rainN * w.part));
    this._rainGeo.setDrawRange(0, drawn * 2);
    this.rain.visible = true;
    this._rainHasCam = false;
  }

  _updateWind(dt) {
    // rafales lentes : la brise tourne un peu autour de son axe
    const base = this._weather === 'wind' ? WEATHER.wind.gust : this._weather === 'rain' ? WEATHER.rain.gust : 1.2;
    const g = base * (0.7 + 0.3 * Math.sin(this._time * 0.37) + 0.15 * Math.sin(this._time * 1.31));
    const ang = this._windAng + Math.sin(this._time * 0.21) * 0.35;
    this._windX = Math.sin(ang) * g;
    this._windZ = Math.cos(ang) * g;
  }

  _updateRain(dt) {
    if (this._weather === 'clear' || !this.rain.visible) return;
    const w = WEATHER[this._weather];
    const n = Math.max(1, Math.round(this._rainN * w.part));
    const box = w.box;
    const cx = _camPos.x, cy = _camPos.y, cz = _camPos.z;
    let mx = 0, my = 0, mz = 0;
    if (this._rainHasCam) { mx = cx - this._rainCamX; my = cy - this._rainCamY; mz = cz - this._rainCamZ; }
    this._rainCamX = cx; this._rainCamY = cy; this._rainCamZ = cz;
    this._rainHasCam = true;

    const wx = this._windX * 0.5, wz = this._windZ * 0.5;
    const two = box * 2;
    const off = this._rainOff, pos = this._rainPos;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const fall = lerp(w.fall[0], w.fall[1], this._rainSpd[i]);
      let ox = off[o] + wx * dt - mx;
      let oy = off[o + 1] - fall * dt - my;
      let oz = off[o + 2] + (wz * dt - mz);
      // repositionnement modulo dans la boite qui suit la camera
      if (ox > box) ox -= two; else if (ox < -box) ox += two;
      if (oz > box) oz -= two; else if (oz < -box) oz += two;
      if (oy < -box * 0.6) oy += box * 1.4; else if (oy > box * 0.8) oy -= box * 1.4;
      off[o] = ox; off[o + 1] = oy; off[o + 2] = oz;

      // segment oriente par la vitesse (chute + vent)
      let sx = wx, sy = -fall, sz = wz;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const k = w.len / sl;
      sx *= k; sy *= k; sz *= k;
      const p = i * 6;
      pos[p] = cx + ox; pos[p + 1] = cy + oy; pos[p + 2] = cz + oz;
      pos[p + 3] = cx + ox - sx; pos[p + 4] = cy + oy - sy; pos[p + 5] = cz + oz - sz;
    }
    this._rainAttr.needsUpdate = true;
  }

  // --- boucle --------------------------------------------------------------

  /**
   * @param {number} dt secondes
   * @param {THREE.Camera} [camera]
   */
  update(dt, camera) {
    const cam = camera || this.camera;
    if (cam) {
      this.camera = cam;
      cam.updateMatrixWorld();
      const e = cam.matrixWorld.elements;
      _camRight.set(e[0], e[1], e[2]).normalize();
      _camUp.set(e[4], e[5], e[6]).normalize();
      _camDir.set(-e[8], -e[9], -e[10]).normalize();
      _camPos.set(e[12], e[13], e[14]);
    }
    const d = clamp(dt || 0, 0, 0.1);
    this._time += d;
    this._updateWind(d);

    const wx = this._windX, wz = this._windZ;
    this._updateTracers(d);
    this._glow.update(d, wx * 0.2, wz * 0.2);
    this._smoke.update(d, wx, wz);
    this._rings.update(d);
    this._decals.update(d);
    this._pings.update(d, this._time);
    this._sparks.update(d, wx, wz);
    this._dust.update(d, wx, wz);
    this._updateNumbers(d);
    this._updateHitMarker(d);
    this._updateStorm(d);
    this._updateRain(d);

    this._tracerBatch.flush();
    this._glowBatch.flush();
    this._smokeBatch.flush();
    this._ringBatch.flush();
    this._decalBatch.flush();
    this._pingBatch.flush();
  }

  /** Efface tous les effets en cours (fin de manche, changement de carte). */
  clear() {
    this._glow.clear();
    this._smoke.clear();
    this._rings.clear();
    this._decals.clear();
    this._pings.clear();
    this._sparks.clear();
    this._dust.clear();
    for (let i = 0; i < this._trN; i++) if (this._trOn[i]) { this._trOn[i] = 0; this._tracerBatch.hide(i); }
    for (const s of this._nums) { s.on = 0; s.sp.visible = false; }
    this._hit.visible = false;
  }

  // --- liberation ----------------------------------------------------------

  dispose() {
    this.clear();
    this._tracerBatch.dispose();
    this._glowBatch.dispose();
    this._smokeBatch.dispose();
    this._ringBatch.dispose();
    this._decalBatch.dispose();
    this._pingBatch.dispose();
    this._sparks.dispose();
    this._dust.dispose();
    this._rainGeo.dispose();
    this._stormGeo.dispose();
    this._nextGeo.dispose();
    for (const m of this._mats) m.dispose();
    this._mats.length = 0;
    for (const t of this._texs.values()) if (t) t.dispose();
    this._texs.clear();
    for (const e of this._numTexs.values()) if (e && e.tex) e.tex.dispose();
    this._numTexs.clear();
    for (const s of this._nums) s.sp.material.map = null;
    this._nums.length = 0;
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.clear();
    this.scene = null;
    this.camera = null;
  }
}

export default Effects;
