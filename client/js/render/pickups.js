// KoRoyale — rendu des coffres, du butin au sol et des largages.
//
// Tout est procedural : soupes de boites/prismes a couleurs de sommets, InstancedMesh
// par forme, sprites d'icones fabriques a la premiere utilisation (CanvasTexture).
// Le module se charge donc sans DOM (test Node) : aucune texture au niveau module.
//
// Regles de perf :
//  - une geometrie et un materiau par role, mutualises dans des caches module ;
//  - le butin au sol (250 max) passe par des InstancedMesh : 1 draw call par forme ;
//  - les coffres sont des clones de prototypes (geometries et materiaux partages),
//    leurs colonnes lumineuses tiennent dans un seul InstancedMesh ;
//  - pool fixe de sprites pour les icones et pour les particules ;
//  - aucune allocation de Vector3 / Color / tableau dans les boucles d'update.
//
// Repere : X est, Z nord, Y haut. 1 unite = 1 metre. yaw = atan2(dirX, dirZ).

import * as THREE from 'three';
import { CHEST_KINDS, ITEMS, WEAPONS, lootIcon, lootColor } from '../../../shared/loot.js';
import { clamp, clamp01, damp, smoothstep, TAU } from '../../../shared/math.js';

// ---------------------------------------------------------------------------
// Reglages
// ---------------------------------------------------------------------------
const QUALITY = {
  low: { parts: 24, icons: 12, seg: 6, smoke: 0.26 },
  medium: { parts: 48, icons: 20, seg: 8, smoke: 0.18 },
  high: { parts: 76, icons: 28, seg: 10, smoke: 0.13 },
};

const LOOT_MAX = 250;     // budget d'objets au sol simultanes
const ICON_RANGE = 12;    // distance a laquelle l'icone emoji apparait (m)
const LID_TIME = 0.6;     // duree d'ouverture d'un couvercle (s)
const BEAM_H = 5.2;       // hauteur de la colonne lumineuse d'un coffre
const BEAM_R = 0.46;

// Silhouettes des coffres. `dome` = couvercle bombe, `lid` = epaisseur du couvercle.
const CHEST_SPEC = {
  wood: {
    w: 1.10, h: 0.60, d: 0.72, lid: 0.24, dome: true,
    body: 0x8a6a45, trim: 0x767f8a, accent: 0xc9a227,
  },
  gold: {
    w: 1.10, h: 0.60, d: 0.72, lid: 0.24, dome: true, shiny: true,
    body: 0xd7a521, trim: 0xf6e08a, accent: 0xfff3bd,
  },
  pit: {
    w: 1.26, h: 0.52, d: 0.64, lid: 0.16, dome: false, drawers: true,
    body: 0xc4102a, trim: 0xb9c0c8, accent: 0x2a2d33,
  },
  supply: {
    w: 1.02, h: 0.74, d: 0.80, lid: 0.18, dome: false, stripes: true, chute: true,
    body: 0x2f86ff, trim: 0xf2f4f6, accent: 0x1d4f9c,
  },
};

// Objets -> forme flottante + echelle (les couleurs viennent de instanceColor).
const ITEM_SHAPE = {
  bandage: ['trousse', 0.72],
  medkit: ['trousse', 1.0],
  grass: ['foin', 1.0],
  shieldSmall: ['fiole', 0.82],
  shieldBig: ['fiole', 1.05],
  cheese: ['fromage', 1.0],
  grenade: ['grenade', 0.95],
  fuel: ['jerrican', 1.0],
  repair: ['outils', 1.0],
};

// Armes : la forme porte le nom de l'arme, l'echelle rattrape les petits calibres.
const WEAPON_SCALE = { pistol: 1.18, smg: 1.08, shotgun: 1.0, ar: 1.0, dmr: 0.98, sniper: 0.94, rpg: 1.02 };

// Palette des maquettes d'armes (claire : instanceColor la teinte par rarete)
const GUN = { metal: 0x9aa3ab, dark: 0x4a5058, wood: 0x9c7a50, glass: 0xcfe9ff };

// ---------------------------------------------------------------------------
// Caches module (liberes par PickupRenderer.dispose)
// ---------------------------------------------------------------------------
const _geos = new Map();
const _mats = new Map();
const _texs = new Map();
const _protos = new Map();
const _lin = new Map();   // hex -> [r,g,b] dans l'espace de travail lineaire

const geoOf = (key, make) => {
  let g = _geos.get(key);
  if (g === undefined) { g = make(); _geos.set(key, g); }
  return g;
};

const matOf = (key, make) => {
  let m = _mats.get(key);
  if (m === undefined) { m = make(); _mats.set(key, m); }
  return m;
};

// Temporaires d'update (jamais d'allocation dans les boucles)
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m4 = new THREE.Matrix4();
const _col = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _entry = { type: 'item', id: 'bandage', rarity: 'common' }; // sonde pour lootColor/lootIcon

// Temporaires de construction (separes : la construction est paresseuse)
const _bv = new THREE.Vector3();
const _bm = new THREE.Matrix4();
const _be = new THREE.Euler();
const _bc = new THREE.Color();

/** Conversion sRGB -> espace de travail, mise en cache (les attributs ne sont pas convertis). */
function linCol(hex) {
  let c = _lin.get(hex);
  if (c === undefined) {
    _bc.setHex(hex);
    c = [_bc.r, _bc.g, _bc.b];
    _lin.set(hex, c);
  }
  return c;
}

/** 0..1 stable a partir d'un identifiant : sert de dephasage d'animation. */
function hashId(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 997) / 997;
}

// ---------------------------------------------------------------------------
// Soup : accumulateur de boites, prismes et quads a couleurs de sommets
// ---------------------------------------------------------------------------

// Les 6 faces d'une boite unitaire, coins en sens trigonometrique vus de l'exterieur.
const FACES = [
  [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],
  [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
  [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],
  [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
  [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
  [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
];

class Soup {
  constructor() {
    this.p = []; this.c = []; this.i = [];
    this._r = 1; this._g = 1; this._b = 1;
    this._rot = false;
  }

  /** Couleur courante (hex sRGB). */
  col(hex) {
    const c = linCol(hex);
    this._r = c[0]; this._g = c[1]; this._b = c[2];
    return this;
  }

  _rotate(rx, ry, rz) {
    this._rot = !!(rx || ry || rz);
    if (this._rot) {
      _be.set(rx || 0, ry || 0, rz || 0, 'XYZ');
      _bm.makeRotationFromEuler(_be);
    }
    return this;
  }

  /** Ajoute un sommet local (lx,ly,lz) autour du centre (cx,cy,cz). */
  _vert(cx, cy, cz, lx, ly, lz) {
    if (this._rot) {
      _bv.set(lx, ly, lz).applyMatrix4(_bm);
      this.p.push(cx + _bv.x, cy + _bv.y, cz + _bv.z);
    } else {
      this.p.push(cx + lx, cy + ly, cz + lz);
    }
    this.c.push(this._r, this._g, this._b);
  }

  /** Boite centree, demi-dimensions (hx,hy,hz), rotation Euler XYZ optionnelle. */
  box(cx, cy, cz, hx, hy, hz, rx, ry, rz) {
    this._rotate(rx, ry, rz);
    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const n = this.p.length / 3;
      for (let k = 0; k < 4; k++) {
        const c3 = face[k];
        this._vert(cx, cy, cz, c3[0] * hx, c3[1] * hy, c3[2] * hz);
      }
      this.i.push(n, n + 1, n + 2, n, n + 2, n + 3);
    }
    return this;
  }

  /** Prisme d'axe Y (rayon bas r0, rayon haut r1, hauteur h), rotation optionnelle. */
  prism(cx, cy, cz, r0, r1, h, sides = 8, rx, ry, rz) {
    this._rotate(rx, ry, rz);
    const y0 = -h * 0.5, y1 = h * 0.5;
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * TAU, a1 = ((k + 1) / sides) * TAU;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const n = this.p.length / 3;
      this._vert(cx, cy, cz, c0 * r0, y0, s0 * r0);
      this._vert(cx, cy, cz, c0 * r1, y1, s0 * r1);
      this._vert(cx, cy, cz, c1 * r1, y1, s1 * r1);
      this._vert(cx, cy, cz, c1 * r0, y0, s1 * r0);
      this.i.push(n, n + 1, n + 2, n, n + 2, n + 3);
    }
    for (let cap = 0; cap < 2; cap++) {
      const r = cap === 0 ? r1 : r0;
      if (r <= 1e-4) continue;
      const y = cap === 0 ? y1 : y0;
      for (let k = 0; k < sides; k++) {
        const a0 = (k / sides) * TAU, a1 = ((k + 1) / sides) * TAU;
        const n = this.p.length / 3;
        this._vert(cx, cy, cz, 0, y, 0);
        if (cap === 0) {
          this._vert(cx, cy, cz, Math.cos(a1) * r, y, Math.sin(a1) * r);
          this._vert(cx, cy, cz, Math.cos(a0) * r, y, Math.sin(a0) * r);
        } else {
          this._vert(cx, cy, cz, Math.cos(a0) * r, y, Math.sin(a0) * r);
          this._vert(cx, cy, cz, Math.cos(a1) * r, y, Math.sin(a1) * r);
        }
        this.i.push(n, n + 1, n + 2);
      }
    }
    return this;
  }

  /** Quadrilatere libre a,b,c,d (sens trigo vu de la face visible). */
  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
    this._rot = false;
    const n = this.p.length / 3;
    this._vert(0, 0, 0, ax, ay, az);
    this._vert(0, 0, 0, bx, by, bz);
    this._vert(0, 0, 0, cx, cy, cz);
    this._vert(0, 0, 0, dx, dy, dz);
    this.i.push(n, n + 1, n + 2, n, n + 2, n + 3);
    return this;
  }

  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    g.setIndex(this.i);
    g.computeVertexNormals();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Textures paresseuses (aucune au chargement : Node n'a pas de DOM)
// ---------------------------------------------------------------------------
function ctx2d(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c.getContext('2d');
}

function finishTex(g, key) {
  const t = new THREE.CanvasTexture(g.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 1;
  _texs.set(key, t);
  return t;
}

/** Halo rond doux : gerbes, socles de butin, fumee. */
function glowTex(key, hardness) {
  if (_texs.has(key)) return _texs.get(key);
  const g = ctx2d(64, 64);
  if (!g) { _texs.set(key, null); return null; }
  const grd = g.createRadialGradient(32, 32, 1, 32, 32, 31);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(hardness, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return finishTex(g, key);
}

/** Bouffee de fumee : halo un peu grumeleux. */
function smokeTex() {
  const key = 'smoke';
  if (_texs.has(key)) return _texs.get(key);
  const g = ctx2d(64, 64);
  if (!g) { _texs.set(key, null); return null; }
  const grd = g.createRadialGradient(30, 34, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.42)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return finishTex(g, key);
}

/** Degrade vertical de la colonne lumineuse : dense en bas, evanoui en haut. */
function beamTex() {
  const key = 'beam';
  if (_texs.has(key)) return _texs.get(key);
  const g = ctx2d(8, 64);
  if (!g) { _texs.set(key, null); return null; }
  const grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  grd.addColorStop(1, 'rgba(255,255,255,0.85)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 8, 64);
  return finishTex(g, key);
}

/** Icone emoji sur pastille sombre (une texture par icone). */
function iconTex(emoji) {
  const key = 'icon:' + emoji;
  if (_texs.has(key)) return _texs.get(key);
  const g = ctx2d(64, 64);
  if (!g) { _texs.set(key, null); return null; }
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(16,20,28,0.62)';
  g.beginPath(); g.arc(32, 32, 29, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 2.5;
  g.beginPath(); g.arc(32, 32, 28, 0, TAU); g.stroke();
  g.font = '38px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.fillText(emoji, 32, 35);
  return finishTex(g, key);
}

// ---------------------------------------------------------------------------
// Materiaux mutualises
// ---------------------------------------------------------------------------
// NB : instanceColor n'est multiplie dans le shader que si vertexColors est actif
// (three definit alors USE_COLOR) ; l'attribut `color` manquant vaut (1,1,1).
const mSolid = () => matOf('solid', () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
const mShiny = () => matOf('shiny', () => new THREE.MeshPhongMaterial({
  vertexColors: true, flatShading: true, shininess: 80, specular: 0x6b5a20,
}));
const mCloth = () => matOf('cloth', () => new THREE.MeshLambertMaterial({
  vertexColors: true, flatShading: true, side: THREE.DoubleSide,
}));
const mBeam = () => matOf('beam', () => new THREE.MeshBasicMaterial({
  map: beamTex() || null, vertexColors: true, transparent: true, opacity: 0.85,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
}));
const mPad = () => matOf('pad', () => new THREE.MeshBasicMaterial({
  map: glowTex('pad', 0.45) || null, vertexColors: true, transparent: true, opacity: 0.85,
  blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
}));
const mRing = () => matOf('ring', () => new THREE.MeshBasicMaterial({
  color: 0xfff4cf, transparent: true, opacity: 0.9,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
}));
const mIcon = (emoji) => matOf('icon:' + emoji, () => new THREE.SpriteMaterial({
  map: iconTex(emoji) || null, transparent: true, depthWrite: false, depthTest: true, fog: false,
}));

// ---------------------------------------------------------------------------
// Geometries : coffres
// ---------------------------------------------------------------------------

/** Caisse du coffre (le couvercle est a part, il pivote). */
function chestBaseGeo(kind) {
  const S = CHEST_SPEC[kind];
  const hw = S.w * 0.5, hd = S.d * 0.5, h = S.h;
  const s = new Soup();
  s.col(S.body).box(0, h * 0.5, 0, hw, h * 0.5, hd);

  // Cerclage : deux sangles verticales + une ceinture haute.
  s.col(S.trim);
  s.box(-hw * 0.56, h * 0.5, 0, 0.035, h * 0.5 + 0.004, hd + 0.010);
  s.box(hw * 0.56, h * 0.5, 0, 0.035, h * 0.5 + 0.004, hd + 0.010);
  s.box(0, h - 0.045, 0, hw + 0.010, 0.028, hd + 0.010);

  if (S.drawers) {
    // Caisse a outils de stand : deux tiroirs et des poignees.
    s.col(S.accent);
    s.box(0, h * 0.62, hd + 0.012, hw * 0.86, 0.016, 0.006);
    s.box(0, h * 0.30, hd + 0.012, hw * 0.86, 0.016, 0.006);
    s.col(S.trim);
    s.box(0, h * 0.46, hd + 0.026, 0.14, 0.022, 0.022);
    s.box(0, h * 0.14, hd + 0.026, 0.14, 0.022, 0.022);
  }
  if (S.stripes) {
    // Bandes de reperage du largage.
    s.col(S.trim);
    s.box(0, h * 0.62, 0, hw + 0.012, 0.05, hd + 0.012);
    s.box(0, h * 0.22, 0, hw + 0.012, 0.05, hd + 0.012);
  }

  // Pieds et serrure.
  s.col(S.accent);
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 1 : -1, sz = i & 2 ? 1 : -1;
    s.box(sx * (hw - 0.06), 0.035, sz * (hd - 0.06), 0.055, 0.038, 0.055);
  }
  s.box(0, h - 0.10, hd + 0.014, 0.062, 0.048, 0.018);
  return s.geo();
}

/**
 * Couvercle, construit dans le repere de la charniere :
 * charniere a l'origine, le couvercle s'etend vers +Z.
 */
function chestLidGeo(kind) {
  const S = CHEST_SPEC[kind];
  const hw = S.w * 0.5, hd = S.d * 0.5, lh = S.lid;
  const s = new Soup();
  if (S.dome) {
    s.col(S.body).box(0, lh * 0.30, hd, hw, lh * 0.30, hd);
    s.col(S.body).box(0, lh * 0.74, hd, hw * 0.90, lh * 0.20, hd * 0.84);
  } else {
    s.col(S.body).box(0, lh * 0.5, hd, hw, lh * 0.5, hd);
  }
  s.col(S.trim);
  s.box(-hw * 0.56, lh * 0.42, hd, 0.035, lh * 0.46, hd + 0.010);
  s.box(hw * 0.56, lh * 0.42, hd, 0.035, lh * 0.46, hd + 0.010);
  s.col(S.accent).box(0, lh * 0.30, hd * 2 + 0.012, 0.075, 0.055, 0.020);
  return s.geo();
}

/** Voilure de parachute a fuseaux (rouge et blanche), rayon 1.55 m. */
function chuteGeo() {
  const s = new Soup();
  const sides = 12;
  const R = [0.0, 0.62, 1.34, 1.55];
  const Y = [0.98, 0.86, 0.42, 0.0];
  for (let k = 0; k < sides; k++) {
    const a0 = (k / sides) * TAU, a1 = ((k + 1) / sides) * TAU;
    const c0 = Math.cos(a0), n0 = Math.sin(a0), c1 = Math.cos(a1), n1 = Math.sin(a1);
    s.col(k & 1 ? 0xf4f6f8 : 0xd6001c);
    for (let r = 0; r < 3; r++) {
      const ra = R[r], rb = R[r + 1], ya = Y[r], yb = Y[r + 1];
      s.quad(
        c0 * ra, ya, n0 * ra,
        c0 * rb, yb, n0 * rb,
        c1 * rb, yb, n1 * rb,
        c1 * ra, ya, n1 * ra,
      );
    }
  }
  // Suspentes : quatre sangles fines qui convergent vers la caisse.
  s.col(0x3a3f46);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU + 0.4;
    const x = Math.cos(a) * 0.75, z = Math.sin(a) * 0.75;
    s.box(x, -0.6, z, 0.02, 0.62, 0.02, Math.atan2(-z, 1.2) * 0.55, 0, Math.atan2(x, 1.2) * -0.55);
  }
  return s.geo();
}

/** Caisse d'un largage en vol (plus compacte qu'un coffre pose). */
function dropCrateGeo() {
  const s = new Soup();
  s.col(0x2f86ff).box(0, 0.34, 0, 0.46, 0.34, 0.40);
  s.col(0xf2f4f6);
  s.box(0, 0.50, 0, 0.47, 0.05, 0.41);
  s.box(0, 0.18, 0, 0.47, 0.05, 0.41);
  s.col(0x1d4f9c);
  s.box(0, 0.70, 0, 0.34, 0.03, 0.30);
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 1 : -1, sz = i & 2 ? 1 : -1;
    s.box(sx * 0.44, 0.34, sz * 0.38, 0.045, 0.35, 0.045);
  }
  return s.geo();
}

/** Prototype de coffre : caisse + pivot de couvercle (+ voilure affalee). */
function chestProto(kind) {
  let p = _protos.get(kind);
  if (p !== undefined) return p;
  const S = CHEST_SPEC[kind];
  const mat = S.shiny ? mShiny() : mSolid();
  p = new THREE.Group();
  p.add(new THREE.Mesh(geoOf('chest:' + kind, () => chestBaseGeo(kind)), mat));

  const hinge = new THREE.Group();
  hinge.name = 'lid';
  hinge.position.set(0, S.h, -S.d * 0.5);
  hinge.add(new THREE.Mesh(geoOf('lid:' + kind, () => chestLidGeo(kind)), mat));
  p.add(hinge);

  if (S.chute) {
    // Voilure affalee derriere la caisse.
    const drape = new THREE.Mesh(geoOf('chute', chuteGeo), mCloth());
    drape.position.set(-0.15, 0.06, -0.85);
    drape.scale.set(0.62, 0.20, 0.62);
    drape.rotation.set(0.12, 0.7, 0.22);
    p.add(drape);
  }
  _protos.set(kind, p);
  return p;
}

// ---------------------------------------------------------------------------
// Geometries : formes flottantes du butin
// ---------------------------------------------------------------------------
const SHAPES = {
  // --- armes : silhouettes abstraites en boites -----------------------------
  pistol() {
    const s = new Soup();
    s.col(GUN.metal).box(0.02, 0.05, 0, 0.14, 0.042, 0.028);
    s.col(GUN.dark).box(0.19, 0.04, 0, 0.06, 0.020, 0.020);
    s.col(GUN.wood).box(-0.09, -0.07, 0, 0.042, 0.085, 0.026, 0, 0, 0.24);
    s.col(GUN.dark).box(-0.03, -0.03, 0, 0.045, 0.026, 0.018);
    return s;
  },
  smg() {
    const s = new Soup();
    s.col(GUN.dark).box(0, 0.04, 0, 0.13, 0.048, 0.032);
    s.col(GUN.metal).box(0.18, 0.04, 0, 0.06, 0.020, 0.020);
    s.col(GUN.dark).box(-0.02, -0.10, 0, 0.035, 0.085, 0.024);
    s.col(GUN.dark).box(-0.10, -0.05, 0, 0.032, 0.055, 0.024, 0, 0, 0.30);
    s.col(GUN.metal).box(-0.19, 0.04, 0, 0.06, 0.018, 0.018);
    return s;
  },
  ar() {
    const s = new Soup();
    s.col(GUN.dark).box(0, 0.03, 0, 0.16, 0.048, 0.034);
    s.col(GUN.metal).box(0.24, 0.03, 0, 0.10, 0.020, 0.020);
    s.col(GUN.dark).box(0.31, 0.07, 0, 0.018, 0.024, 0.016);
    s.col(GUN.dark).box(-0.21, 0.02, 0, 0.075, 0.045, 0.028);
    s.col(GUN.dark).box(-0.02, -0.11, 0, 0.038, 0.090, 0.026, 0, 0, -0.14);
    s.col(GUN.dark).box(-0.10, -0.07, 0, 0.030, 0.060, 0.026, 0, 0, 0.30);
    s.col(GUN.metal).box(0.02, 0.09, 0, 0.11, 0.016, 0.020);
    return s;
  },
  shotgun() {
    const s = new Soup();
    s.col(GUN.wood).box(-0.16, 0.02, 0, 0.11, 0.048, 0.030);
    s.col(GUN.dark).box(0.06, 0.05, 0.020, 0.20, 0.024, 0.020);
    s.col(GUN.dark).box(0.06, 0.05, -0.020, 0.20, 0.024, 0.020);
    s.col(GUN.metal).box(-0.02, 0.02, 0, 0.07, 0.045, 0.032);
    s.col(GUN.wood).box(0.10, -0.02, 0, 0.06, 0.030, 0.032);
    return s;
  },
  sniper() {
    const s = new Soup();
    s.col(GUN.dark).box(0, 0.02, 0, 0.13, 0.042, 0.030);
    s.col(GUN.metal).box(0.28, 0.02, 0, 0.16, 0.018, 0.018);
    s.col(GUN.dark).prism(0.03, 0.11, 0, 0.030, 0.030, 0.20, 8, 0, 0, Math.PI * 0.5);
    s.col(GUN.glass).prism(0.14, 0.11, 0, 0.026, 0.026, 0.02, 8, 0, 0, Math.PI * 0.5);
    s.col(GUN.wood).box(-0.22, 0.00, 0, 0.10, 0.055, 0.028);
    s.col(GUN.dark).box(-0.06, -0.06, 0, 0.028, 0.055, 0.024, 0, 0, 0.26);
    s.col(GUN.metal).box(0.30, -0.05, 0, 0.012, 0.055, 0.012, 0, 0, 0.35);
    return s;
  },
  dmr() {
    const s = new Soup();
    s.col(GUN.wood).box(-0.16, 0.01, 0, 0.12, 0.050, 0.030);
    s.col(GUN.dark).box(0.02, 0.03, 0, 0.10, 0.044, 0.032);
    s.col(GUN.metal).box(0.22, 0.03, 0, 0.11, 0.018, 0.018);
    s.col(GUN.dark).prism(0.02, 0.10, 0, 0.026, 0.026, 0.14, 8, 0, 0, Math.PI * 0.5);
    s.col(GUN.dark).box(0.01, -0.08, 0, 0.032, 0.062, 0.024);
    return s;
  },
  rpg() {
    const s = new Soup();
    s.col(GUN.dark).prism(-0.02, 0.02, 0, 0.052, 0.052, 0.44, 8, 0, 0, Math.PI * 0.5);
    s.col(GUN.metal).prism(0.30, 0.02, 0, 0.088, 0.020, 0.14, 8, 0, 0, -Math.PI * 0.5);
    s.col(GUN.dark).box(-0.26, 0.02, 0, 0.03, 0.075, 0.075);
    s.col(GUN.wood).box(-0.04, -0.08, 0, 0.030, 0.062, 0.026, 0, 0, 0.20);
    s.col(GUN.metal).box(0.06, 0.09, 0, 0.10, 0.014, 0.014);
    return s;
  },

  // --- objets ---------------------------------------------------------------
  fiole() {
    const s = new Soup();
    s.col(0xf6fbff).prism(0, -0.02, 0, 0.086, 0.076, 0.20, 8);
    s.col(0xeef5fb).prism(0, 0.11, 0, 0.048, 0.036, 0.07, 8);
    s.col(0xbfd4e2).box(0, 0.155, 0, 0.040, 0.020, 0.040);
    s.col(0xdfe9f2).box(0, -0.02, 0, 0.090, 0.030, 0.090);
    return s;
  },
  foin() {
    const s = new Soup();
    s.col(0xf0e6c4).prism(0, 0, 0, 0.145, 0.145, 0.34, 8, 0, 0, Math.PI * 0.5);
    s.col(0x7a6a44);
    s.box(-0.09, 0, 0, 0.016, 0.150, 0.150);
    s.box(0.09, 0, 0, 0.016, 0.150, 0.150);
    s.col(0xfdf6dd).box(0, 0.15, 0, 0.16, 0.020, 0.030, 0, 0.5, 0);
    return s;
  },
  trousse() {
    const s = new Soup();
    s.col(0xf7f7f4).box(0, 0, 0, 0.155, 0.105, 0.095);
    s.col(0xe9e9e4).box(0, 0.09, 0, 0.158, 0.020, 0.098);
    s.col(0xffffff);
    s.box(0, 0.02, 0.100, 0.085, 0.024, 0.006);
    s.box(0, 0.02, 0.100, 0.024, 0.070, 0.006);
    s.col(0x8d9299).box(0, 0.135, 0, 0.045, 0.030, 0.014);
    return s;
  },
  fromage() {
    const s = new Soup();
    s.col(0xfff0c4).prism(0, 0, 0, 0.170, 0.170, 0.135, 12);
    s.col(0xe8cf94).prism(0, 0, 0, 0.176, 0.176, 0.045, 12);
    s.col(0xfff8e0).box(0.10, 0.09, 0.10, 0.055, 0.010, 0.055, 0, 0.6, 0);
    return s;
  },
  grenade() {
    const s = new Soup();
    s.col(0xe8e4dc).prism(0, -0.03, 0, 0.070, 0.098, 0.11, 8);
    s.col(0xe8e4dc).prism(0, 0.07, 0, 0.098, 0.062, 0.09, 8);
    s.col(0x9aa0a6).prism(0, 0.13, 0, 0.038, 0.038, 0.04, 6);
    s.col(0xbfc4c9).box(0.045, 0.11, 0, 0.014, 0.055, 0.026, 0, 0, -0.18);
    return s;
  },
  jerrican() {
    const s = new Soup();
    s.col(0xf2ede4).box(0, 0, 0, 0.105, 0.140, 0.062);
    s.col(0xdcd6cb).box(0, 0.03, 0, 0.110, 0.030, 0.066);
    s.col(0x9aa0a6);
    s.box(0, 0.155, 0, 0.070, 0.018, 0.045);
    s.box(0.055, 0.185, 0, 0.026, 0.028, 0.026);
    s.box(-0.045, 0.185, 0, 0.045, 0.014, 0.030);
    return s;
  },
  outils() {
    const s = new Soup();
    s.col(0xeceff1).box(0, -0.02, 0, 0.150, 0.075, 0.080);
    s.col(0xd6dade).box(0, 0.06, 0, 0.155, 0.020, 0.085);
    s.col(0x878d94);
    s.box(0, 0.125, 0, 0.055, 0.014, 0.016);
    s.box(-0.050, 0.095, 0, 0.014, 0.045, 0.016);
    s.box(0.050, 0.095, 0, 0.014, 0.045, 0.016);
    s.col(0xb9bfc5).box(0, -0.04, 0.085, 0.060, 0.022, 0.010);
    return s;
  },

  // --- munitions ------------------------------------------------------------
  caisse() {
    const s = new Soup();
    s.col(0xefe7d6).box(0, 0, 0, 0.135, 0.090, 0.090);
    s.col(0xd9cfb8).box(0, 0.085, 0, 0.140, 0.018, 0.094);
    s.col(0x8d9299);
    s.box(-0.11, 0, 0, 0.014, 0.092, 0.092);
    s.box(0.11, 0, 0, 0.014, 0.092, 0.092);
    s.col(0xfefaf0).box(0, 0.01, 0.094, 0.070, 0.030, 0.006);
    return s;
  },
};

const shapeGeo = (key) => geoOf('shape:' + key, () => (SHAPES[key] || SHAPES.caisse)().geo());

// ---------------------------------------------------------------------------
// InstPool : un InstancedMesh a capacite extensible, reecrit a chaque image
// ---------------------------------------------------------------------------
class InstPool {
  constructor(parent, geo, mat, cap) {
    this.parent = parent;
    this.geo = geo;
    this.mat = mat;
    this.n = 0;
    this.mesh = null;
    this._alloc(cap);
  }

  _alloc(cap) {
    const old = this.mesh;
    if (old && cap <= this.cap) return;
    const m = new THREE.InstancedMesh(this.geo, this.mat, cap);
    m.frustumCulled = false; // les instances bougent : la sphere englobante serait fausse
    m.count = 0;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, _white);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    if (old) {
      m.instanceMatrix.array.set(old.instanceMatrix.array);
      m.instanceColor.array.set(old.instanceColor.array);
      this.parent.remove(old);
      old.dispose();
    }
    this.cap = cap;
    this.mesh = m;
    this.parent.add(m);
  }

  begin() { this.n = 0; }

  /** Ajoute une instance : position, echelle, rotations Y puis X ; teinte dans _col. */
  pushCol(x, y, z, sx, sy, sz, rotY, rotX) {
    if (this.n >= this.cap) this._alloc(Math.min(this.cap * 2, LOOT_MAX + 8));
    if (this.n >= this.cap) return;
    _e.set(rotX || 0, rotY || 0, 0, 'YXZ');
    _q.setFromEuler(_e);
    _m4.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
    const i = this.n++;
    this.mesh.setMatrixAt(i, _m4);
    this.mesh.setColorAt(i, _col);
  }

  end() {
    const m = this.mesh;
    m.count = this.n;
    if (this.n > 0) {
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    if (this.mesh) {
      this.parent.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Description d'une entree de butin (calculee une fois a la creation)
// ---------------------------------------------------------------------------
function describeLoot(l) {
  const type = l.type === 'weapon' || l.type === 'ammo' ? l.type : 'item';
  const id = l.itemId;
  _entry.type = type;
  _entry.id = id;
  _entry.rarity = l.rarity || 'common';

  let shape = 'caisse';
  let scale = 1;
  if (type === 'weapon') {
    shape = WEAPONS[id] && SHAPES[id] ? id : 'ar';
    scale = WEAPON_SCALE[shape] || 1;
  } else if (type === 'item') {
    const m = ITEM_SHAPE[id];
    if (m) { shape = m[0]; scale = m[1]; }
    else {
      // Objet inconnu : on retombe sur une forme coherente avec sa famille.
      const kind = ITEMS[id] ? ITEMS[id].kind : 'heal';
      shape = kind === 'shield' ? 'fiole' : kind === 'throwable' ? 'grenade' : 'trousse';
      scale = 0.9;
    }
  } else {
    scale = (l.count || 0) > 24 ? 1.1 : 0.92;
  }

  const base = lootColor(_entry);
  // Teinte d'instance eclaircie : elle multiplie la couleur des sommets.
  _col.setHex(base).lerp(_white, 0.34);
  return {
    shape,
    scale,
    padHex: base,
    tint: _col.getHex(),
    icon: lootIcon(_entry),
  };
}

// ---------------------------------------------------------------------------
// PickupRenderer
// ---------------------------------------------------------------------------
export class PickupRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {{quality?: string}} [opts]
   */
  constructor(scene, opts = {}) {
    const o = opts || {};
    this.scene = scene || null;
    this.quality = o.quality === 'low' || o.quality === 'high' ? o.quality : 'medium';
    this.q = QUALITY[this.quality];

    this._t = 0;
    this._highlight = null;

    this._chests = new Map();
    this._loot = new Map();
    this._drops = new Map();

    this.group = new THREE.Group();
    this.group.name = 'ramassables';
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    if (this.scene && this.scene.add) this.scene.add(this.group);

    // Sous-groupes : instances, sprites, particules.
    this._instGroup = new THREE.Group();
    this._instGroup.matrixAutoUpdate = false;
    this._spriteGroup = new THREE.Group();
    this._spriteGroup.matrixAutoUpdate = false;
    this.group.add(this._instGroup, this._spriteGroup);

    this._shapePools = new Map();
    this._padPool = new InstPool(this._instGroup, geoOf('pad', () => {
      const g = new THREE.PlaneGeometry(1, 1);
      g.rotateX(-Math.PI * 0.5);
      return g;
    }), mPad(), 48);
    this._beamPool = new InstPool(this._instGroup, geoOf('beam:' + this.q.seg, () => {
      const g = new THREE.CylinderGeometry(1, 1, 1, this.q.seg, 1, true);
      g.translate(0, 0.5, 0);
      return g;
    }), mBeam(), 24);

    // Anneau de surbrillance : une seule instance, deplacee au besoin.
    this._ring = new THREE.Mesh(geoOf('ring', () => {
      const g = new THREE.RingGeometry(0.52, 0.70, 24);
      g.rotateX(-Math.PI * 0.5);
      return g;
    }), mRing());
    this._ring.frustumCulled = false;
    this._ring.visible = false;
    this.group.add(this._ring);

    // Pools de sprites (icones et particules).
    this._icons = [];
    this._parts = [];
    this._partLive = [];
    this._partFree = [];
  }

  // --- diff des coffres ----------------------------------------------------
  syncChests(list) {
    this._mark(this._chests);
    for (let i = 0; list && i < list.length; i++) {
      const c = list[i];
      let e = this._chests.get(c.id);
      if (!e) {
        e = this._makeChest(c);
        if (!e) continue;
        this._chests.set(c.id, e);
      }
      e.keep = true;
      e.x = c.x; e.y = c.y; e.z = c.z;
      e.root.position.set(c.x, c.y, c.z);
      e.root.rotation.y = c.yaw || 0;
      const op = !!c.opened;
      if (op && !e.opened) {
        e.opened = true;
        if (e.born) this._burst(c.x, c.y + 0.55, c.z, CHEST_KINDS[e.kind]?.color ?? 0xffc107);
        else e.open01 = 1; // deja ouvert a l'apparition : pas de gerbe
      } else if (!op && e.opened) {
        e.opened = false;
      }
      e.born = true;
    }
    this._sweep(this._chests, true);
  }

  _makeChest(c) {
    const kind = CHEST_SPEC[c.kind] ? c.kind : 'wood';
    const root = chestProto(kind).clone(true);
    root.rotation.order = 'YXZ';
    const lid = root.getObjectByName('lid');
    this.group.add(root);
    return {
      id: c.id, kind, root, lid,
      x: c.x, y: c.y, z: c.z,
      opened: false, open01: 0, beam01: 1, born: false, keep: true,
      phase: hashId(c.id) * TAU,
    };
  }

  // --- diff du butin -------------------------------------------------------
  syncLoot(list) {
    this._mark(this._loot);
    for (let i = 0; list && i < list.length; i++) {
      const l = list[i];
      let e = this._loot.get(l.id);
      if (!e) {
        if (this._loot.size >= LOOT_MAX) continue; // budget atteint
        const d = describeLoot(l);
        e = {
          id: l.id, x: l.x, y: l.y, z: l.z,
          shape: d.shape, scale: d.scale, padHex: d.padHex, tint: d.tint, icon: d.icon,
          phase: hashId(l.id) * TAU,
        };
        this._loot.set(l.id, e);
      }
      e.keep = true;
      e.x = l.x; e.y = l.y; e.z = l.z;
    }
    this._sweep(this._loot, false);
  }

  // --- diff des largages ---------------------------------------------------
  syncDrops(list) {
    this._mark(this._drops);
    for (let i = 0; list && i < list.length; i++) {
      const d = list[i];
      let e = this._drops.get(d.id);
      if (!e) {
        e = this._makeDrop(d);
        this._drops.set(d.id, e);
      }
      e.keep = true;
      e.x = d.x; e.y = d.y; e.z = d.z;
      e.root.position.set(d.x, d.y, d.z);
      const f = d.falling !== false;
      if (e.falling && !f && e.born) {
        // Touche du sol : la voilure s'affale, un nuage de poussiere part.
        this._burst(d.x, d.y + 0.2, d.z, 0xe8dcc0, 0.6);
      }
      e.falling = f;
      e.born = true;
    }
    this._sweep(this._drops, true);
  }

  _makeDrop(d) {
    const root = new THREE.Group();
    root.position.set(d.x, d.y, d.z);
    const crate = new THREE.Mesh(geoOf('dropCrate', dropCrateGeo), mSolid());
    root.add(crate);
    const chute = new THREE.Group();
    chute.position.y = 2.4;
    const canopy = new THREE.Mesh(geoOf('chute', chuteGeo), mCloth());
    chute.add(canopy);
    root.add(chute);
    this.group.add(root);
    return {
      id: d.id, root, chute, crate,
      x: d.x, y: d.y, z: d.z,
      falling: d.falling !== false, born: false, keep: true,
      fade: d.falling !== false ? 1 : 0,
      smokeT: 0, phase: hashId(d.id) * TAU,
    };
  }

  // --- helpers de diff (jamais de reconstruction totale) -------------------
  _mark(map) {
    for (const e of map.values()) e.keep = false;
  }

  /** Retire les entites absentes du dernier snapshot. */
  _sweep(map, hasRoot) {
    for (const [id, e] of map) {
      if (e.keep) continue;
      if (hasRoot) this.group.remove(e.root);
      map.delete(id);
    }
  }

  setHighlight(id) {
    this._highlight = id === undefined ? null : id;
  }

  // --- boucle d'animation --------------------------------------------------
  update(dt, camera, playerPos) {
    dt = clamp(dt || 0, 0, 0.1);
    this._t += dt;
    const t = this._t;
    const ref = playerPos || (camera && camera.position) || null;
    const rx = ref ? ref.x : 0, ry = ref ? ref.y : 0, rz = ref ? ref.z : 0;

    this._updateChests(dt, t);
    this._updateDrops(dt, t);
    this._updateLoot(t, rx, ry, rz);
    this._updateParts(dt);
    this._updateRing(t);
  }

  _updateChests(dt, t) {
    const beams = this._beamPool;
    beams.begin();
    for (const e of this._chests.values()) {
      // Couvercle : 0.6 s, avec un rebond leger en fin de course.
      const target = e.opened ? 1 : 0;
      if (e.open01 !== target) {
        e.open01 = clamp01(e.open01 + (target - e.open01 > 0 ? dt / LID_TIME : -dt / LID_TIME));
      }
      if (e.lid) {
        const k = smoothstep(0, 1, e.open01);
        e.lid.rotation.x = -1.95 * (k + Math.sin(k * Math.PI) * 0.07);
      }
      // Colonne lumineuse : eteinte des l'ouverture.
      e.beam01 = damp(e.beam01, e.opened ? 0 : 1, 5, dt);
      if (e.beam01 < 0.02) continue;
      const kind = CHEST_KINDS[e.kind] || CHEST_KINDS.wood;
      const pulse = 0.78 + Math.sin(t * 1.9 + e.phase) * 0.16;
      // En additif, moduler la couleur revient a moduler l'intensite.
      _col.setHex(kind.color).multiplyScalar(e.beam01 * pulse * 0.85);
      const hi = this._highlight !== null && e.id === this._highlight ? 1.25 : 1;
      beams.pushCol(e.x, e.y + 0.15, e.z, BEAM_R * hi, BEAM_H, BEAM_R * hi, t * 0.25 + e.phase, 0);
    }
    beams.end();
  }

  _updateDrops(dt, t) {
    for (const e of this._drops.values()) {
      // Balancement de la caisse sous la voilure.
      const sw = e.falling ? 1 : 0;
      const a = Math.sin(t * 1.15 + e.phase);
      const b = Math.cos(t * 0.87 + e.phase * 1.7);
      e.root.rotation.z = a * 0.10 * sw;
      e.root.rotation.x = b * 0.08 * sw;
      if (e.falling) e.root.rotation.y = t * 0.25 + e.phase; // fige au posé

      // Le parachute disparait quand la chute est finie.
      e.fade = damp(e.fade, e.falling ? 1 : 0, 7, dt);
      const vis = e.fade > 0.03;
      e.chute.visible = vis;
      if (vis) {
        const k = 0.55 + e.fade * 0.45;
        e.chute.scale.set(k, e.fade * 0.6 + 0.4, k);
        e.chute.rotation.z = a * 0.07;
        e.chute.rotation.x = b * 0.06;
      }

      // Fumigene colore : trainee en vol, colonne plus dense au sol.
      e.smokeT -= dt;
      if (e.smokeT <= 0) {
        e.smokeT = this.q.smoke * (e.falling ? 1.4 : 1);
        this._smoke(e.x, e.y + (e.falling ? 0.25 : 0.55), e.z, CHEST_KINDS.supply.color, e.falling ? 0.6 : 1);
      }
    }
  }

  _updateLoot(t, rx, ry, rz) {
    const pads = this._padPool;
    pads.begin();
    for (const p of this._shapePools.values()) p.begin();

    const hiId = this._highlight;
    let icons = 0;
    const iconMax = this.q.icons;
    const r2 = ICON_RANGE * ICON_RANGE;

    for (const e of this._loot.values()) {
      const bob = Math.sin(t * 1.8 + e.phase) * 0.07;
      const hi = hiId !== null && e.id === hiId;
      const sc = e.scale * (hi ? 1.18 : 1);

      // Socle lumineux, pose au sol, jamais tourne.
      _col.setHex(e.padHex).multiplyScalar(hi ? 1.0 : 0.72);
      pads.pushCol(e.x, e.y + 0.03, e.z, 1.05, 1, 1.05, 0, 0);

      // Forme flottante : rotation lente + bobbing.
      const pool = this._shapePool(e.shape);
      _col.setHex(e.tint);
      pool.pushCol(e.x, e.y + 0.52 + bob, e.z, sc, sc, sc, t * (hi ? 1.6 : 0.9) + e.phase, 0.10);

      // Icone emoji : seulement dans les 12 derniers metres.
      if (icons >= iconMax) continue;
      const dx = e.x - rx, dy = e.y - ry, dz = e.z - rz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const sp = this._iconSprite(icons++);
      if (!sp) continue;
      const mat = mIcon(e.icon);
      if (sp.material !== mat) sp.material = mat;
      sp.visible = true;
      sp.position.set(e.x, e.y + 1.12 + bob * 0.5, e.z);
      const k = 0.30 + Math.sqrt(d2) * 0.024; // taille a l'ecran quasi constante
      sp.scale.set(k, k, 1);
    }

    for (let i = icons; i < this._icons.length; i++) this._icons[i].visible = false;
    pads.end();
    for (const p of this._shapePools.values()) p.end();
  }

  _updateRing(t) {
    const id = this._highlight;
    const ring = this._ring;
    if (id === null) { ring.visible = false; return; }
    let x = 0, y = 0, z = 0, r = 1;
    const c = this._chests.get(id);
    const l = c ? null : this._loot.get(id);
    const d = c || l ? null : this._drops.get(id);
    if (c) { x = c.x; y = c.y; z = c.z; r = 1.0; }
    else if (l) { x = l.x; y = l.y; z = l.z; r = 0.62; }
    else if (d) { x = d.x; y = d.y; z = d.z; r = 1.0; }
    else { ring.visible = false; return; }
    const pulse = 1 + Math.sin(t * 5.5) * 0.06;
    ring.visible = true;
    ring.position.set(x, y + 0.05, z);
    ring.scale.set(r * pulse, 1, r * pulse);
    ring.rotation.y = t * 0.9;
    ring.material.opacity = 0.55 + Math.sin(t * 5.5) * 0.2;
  }

  // --- pools ---------------------------------------------------------------
  _shapePool(key) {
    let p = this._shapePools.get(key);
    if (p === undefined) {
      p = new InstPool(this._instGroup, shapeGeo(key), mSolid(), 16);
      this._shapePools.set(key, p);
    }
    return p;
  }

  _iconSprite(i) {
    let sp = this._icons[i];
    if (sp === undefined) {
      if (this._icons.length >= this.q.icons) return null;
      sp = new THREE.Sprite(mIcon('📦'));
      sp.frustumCulled = false;
      this._spriteGroup.add(sp);
      this._icons.push(sp);
    }
    return sp;
  }

  // --- particules ----------------------------------------------------------
  _takePart() {
    let p = this._partFree.pop();
    if (!p) {
      if (this._parts.length >= this.q.parts) return null;
      const mat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: true });
      const sp = new THREE.Sprite(mat);
      sp.frustumCulled = false;
      p = { sp, mat, life: 0, ttl: 1, s0: 1, s1: 1, a: 1, vx: 0, vy: 0, vz: 0, g: 0, drag: 0 };
      this._parts.push(p);
    }
    this._spriteGroup.add(p.sp);
    this._partLive.push(p);
    return p;
  }

  /** Gerbe : petites etincelles additives qui retombent. */
  _burst(x, y, z, hex, scale = 1) {
    const n = this.quality === 'low' ? 8 : this.quality === 'high' ? 18 : 13;
    for (let i = 0; i < n; i++) {
      const p = this._takePart();
      if (!p) return;
      const a = Math.random() * TAU;
      const r = Math.random() * 2.4 + 0.5;
      p.mat.map = glowTex('spark', 0.3);
      p.mat.blending = THREE.AdditiveBlending;
      p.mat.color.setHex(hex);
      p.mat.rotation = Math.random() * TAU;
      p.sp.position.set(x, y, z);
      p.vx = Math.cos(a) * r * 0.6;
      p.vz = Math.sin(a) * r * 0.6;
      p.vy = 2.6 + Math.random() * 3.4;
      p.g = 9.5; p.drag = 1.1;
      p.life = 0; p.ttl = 0.65 + Math.random() * 0.55;
      p.s0 = 0.26 * scale; p.s1 = 0.06 * scale; p.a = 0.95;
    }
  }

  /** Fumigene : bouffee opaque qui monte et grossit. */
  _smoke(x, y, z, hex, strength = 1) {
    const p = this._takePart();
    if (!p) return;
    p.mat.map = smokeTex();
    p.mat.blending = THREE.NormalBlending;
    p.mat.color.setHex(hex);
    p.mat.rotation = Math.random() * TAU;
    p.sp.position.set(x + (Math.random() - 0.5) * 0.4, y, z + (Math.random() - 0.5) * 0.4);
    p.vx = (Math.random() - 0.5) * 0.7;
    p.vz = (Math.random() - 0.5) * 0.7;
    p.vy = 1.5 + Math.random() * 1.4;
    p.g = -0.6; p.drag = 0.55;
    p.life = 0; p.ttl = 1.6 + Math.random() * 1.2;
    p.s0 = 0.6 * strength; p.s1 = 2.4 * strength; p.a = 0.5 * strength;
  }

  _updateParts(dt) {
    const live = this._partLive;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.life += dt;
      if (p.life >= p.ttl) {
        this._spriteGroup.remove(p.sp);
        live[i] = live[live.length - 1];
        live.pop();
        this._partFree.push(p);
        continue;
      }
      const k = p.life / p.ttl;
      const f = 1 - clamp01(p.drag * dt);
      p.vx *= f; p.vz *= f;
      p.vy = p.vy * f - p.g * dt;
      const sp = p.sp;
      sp.position.x += p.vx * dt;
      sp.position.y += p.vy * dt;
      sp.position.z += p.vz * dt;
      const s = p.s0 + (p.s1 - p.s0) * k;
      sp.scale.set(s, s, 1);
      p.mat.opacity = p.a * (1 - k * k);
    }
  }

  // --- liberation ----------------------------------------------------------
  dispose() {
    for (const e of this._chests.values()) this.group.remove(e.root);
    for (const e of this._drops.values()) this.group.remove(e.root);
    this._chests.clear();
    this._loot.clear();
    this._drops.clear();

    for (const p of this._shapePools.values()) p.dispose();
    this._shapePools.clear();
    this._padPool.dispose();
    this._beamPool.dispose();

    for (const sp of this._icons) this._spriteGroup.remove(sp);
    this._icons.length = 0;
    for (const p of this._parts) {
      this._spriteGroup.remove(p.sp);
      p.mat.dispose();
    }
    this._parts.length = 0;
    this._partLive.length = 0;
    this._partFree.length = 0;

    if (this.group.parent) this.group.parent.remove(this.group);

    // Caches partages : un seul PickupRenderer vit a la fois, on les rend au systeme.
    for (const g of _geos.values()) if (g) g.dispose();
    for (const m of _mats.values()) if (m) m.dispose();
    for (const t of _texs.values()) if (t) t.dispose();
    _geos.clear();
    _mats.clear();
    _texs.clear();
    _protos.clear();
    _lin.clear();
  }
}
