// KoRoyale — construction de tout le decor statique (« Le Rocher des Chevres »).
//
// Tout sort de shared/mapdata.js et shared/track.js : le rendu ne fait qu'habiller
// des donnees deja partagees avec le serveur. Rien n'est charge depuis le reseau :
// geometries primitives, BufferGeometry maison et CanvasTexture paresseuses.
//
// Regles de perf tenues ici :
//  - un materiau par « famille » de surface, jamais un par objet ; les couleurs
//    propres passent par les couleurs de sommets ou par instanceColor ;
//  - InstancedMesh pour tout ce qui se repete a l'identique (rails, props, helipads) ;
//    fusion en une seule BufferGeometry quand les tailles varient (batiments, yachts,
//    tunnel) : c'est le meme nombre de draw calls, sans le cout d'une matrice par piece ;
//  - aucune allocation dans update() : tous les temporaires sont au niveau module ;
//  - le DOM n'est touche qu'a l'interieur des fonctions (le module se charge sous Node).
//
// Note : quand un objet possede un collider dans mapdata, le rendu epouse le collider
// (orientation et demi-dimensions comprises) — dans un jeu de tir, ce qu'on voit doit
// etre exactement ce qui arrete les balles et les chevres.

import * as THREE from 'three';
import {
  buildMap, terrainHeight, harbourFactor,
  HARBOUR, ROCHER, MOUNT, BEACH,
} from '../../../shared/mapdata.js';
import { trackSamples, startingGrid } from '../../../shared/track.js';
import { WORLD_HALF, SEA_LEVEL } from '../../../shared/constants.js';
import { clamp, clamp01, lerp, smoothstep, fbm2 } from '../../../shared/math.js';

/** Pas du maillage de terrain en qualite moyenne/haute (metres). */
export const TERRAIN_STEP = 5;
/** Pas degrade sur mobile / qualite basse. */
const TERRAIN_STEP_LOW = 8;

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Palette Cote d'Azur
// ---------------------------------------------------------------------------
const C = {
  sable: 0xe6d7ad,
  sableMouille: 0xc9b78e,
  fondMarin: 0x2f6a6a,
  herbe: 0x7d9152,
  herbeClaire: 0x94a763,
  herbeSeche: 0xb0a874,
  roche: 0x8b8377,
  rocheClaire: 0x9e9689,
  pierre: 0xcabfa4,
  neige: 0xeef2f7,
  asphalte: 0x4d545c,
  ligneBlanche: 0xf2f2ee,
  vibreurRouge: 0xd6001c,
  vibreurBlanc: 0xf4f4f0,
  beton: 0xd8d4c8,
  betonSombre: 0xa9a496,
  metal: 0x9aa3ab,
  metalSombre: 0x5b636c,
  terracotta: 0xb75b3a,
  terracottaSombre: 0x9c4a2e,
  creme: 0xf0e4cc,
  bois: 0x8a6b47,
  boisClair: 0xa98a5f,
  vertPin: 0x33562f,
  vertOlive: 0x74854f,
  vertSauge: 0x8b9a6b,
  vertCypres: 0x2c4a2c,
  vertPalme: 0x4a7c46,
  tronc: 0x5a452f,
  eauPiscine: 0x2fb3d9,
  orange: 0xff9c3a,
};

// ---------------------------------------------------------------------------
// Caches module (liberes par World.dispose)
// ---------------------------------------------------------------------------
const _geos = new Map();
const _mats = new Map();
const _texs = new Map();
const _lin = new Map(); // hex -> [r,g,b] dans l'espace de travail lineaire

let _aniso = 1;

function geoOf(key, make) {
  let g = _geos.get(key);
  if (g === undefined) { g = make(); _geos.set(key, g); }
  return g;
}

function matOf(key, make) {
  let m = _mats.get(key);
  if (m === undefined) { m = make(); _mats.set(key, m); }
  return m;
}

/** Conversion sRGB -> espace de travail, mise en cache (les attributs ne sont pas convertis). */
function linCol(hex) {
  let c = _lin.get(hex);
  if (c === undefined) {
    _tmpCol.setHex(hex);
    c = [_tmpCol.r, _tmpCol.g, _tmpCol.b];
    _lin.set(hex, c);
  }
  return c;
}

// Temporaires : jamais d'allocation dans les boucles
const _tmpCol = new THREE.Color();
const _colA = new THREE.Color();
const _colB = new THREE.Color();
const _colT = new THREE.Color();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _m4 = new THREE.Matrix4();

// ---------------------------------------------------------------------------
// Mesher : accumulateur de geometrie (positions, uv, couleurs, index)
// ---------------------------------------------------------------------------

// Les 6 faces d'une boite unitaire, sommets en sens trigonometrique vu de l'exterieur.
// Chaque entree : signes (x,y,z) des 4 coins, puis les axes locaux servant aux uv.
const BOX_FACES = [
  { c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], ua: 2, va: 1 }, // +X
  { c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], ua: 2, va: 1 }, // -X
  { c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], ua: 0, va: 2 }, // +Y
  { c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], ua: 0, va: 2 }, // -Y
  { c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], ua: 0, va: 1 }, // +Z
  { c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], ua: 0, va: 1 }, // -Z
];

class Mesher {
  constructor() {
    this.p = []; this.u = []; this.c = []; this.i = [];
    this._r = 1; this._g = 1; this._b = 1;
    this._lu = -1; this._lv = 0;
  }

  get empty() { return this.p.length === 0; }

  /** Force toutes les uv suivantes sur un point precis de la texture (-1 = libre). */
  lockUv(u, v) { this._lu = u; this._lv = v; return this; }

  /** Fixe la couleur courante (hex sRGB). */
  col(hex) {
    const c = linCol(hex);
    this._r = c[0]; this._g = c[1]; this._b = c[2];
    return this;
  }

  vert(x, y, z, u, v) {
    this.p.push(x, y, z);
    if (this._lu >= 0) this.u.push(this._lu, this._lv);
    else this.u.push(u, v);
    this.c.push(this._r, this._g, this._b);
  }

  /** Quadrilatere a,b,c,d (sens trigo vu de la face visible). */
  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, u1 = 1, v1 = 1) {
    const n = this.p.length / 3;
    this.vert(ax, ay, az, 0, 0);
    this.vert(bx, by, bz, u1, 0);
    this.vert(cx, cy, cz, u1, v1);
    this.vert(dx, dy, dz, 0, v1);
    this.i.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }

  tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    const n = this.p.length / 3;
    this.vert(ax, ay, az, 0, 0);
    this.vert(bx, by, bz, 1, 0);
    this.vert(cx, cy, cz, 0.5, 1);
    this.i.push(n, n + 1, n + 2);
  }

  /**
   * Boite orientee (yaw) centree en (cx,cy,cz).
   * tu/tv : metres couverts par une repetition de texture (0 = uv 0..1).
   */
  box(cx, cy, cz, hx, hy, hz, yaw = 0, tu = 0, tv = 0) {
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const h = [hx, hy, hz];
    for (let f = 0; f < 6; f++) {
      const face = BOX_FACES[f];
      const n = this.p.length / 3;
      const su = tu > 0 ? (h[face.ua] * 2) / tu : 1;
      const sv = tv > 0 ? (h[face.va] * 2) / tv : 1;
      for (let k = 0; k < 4; k++) {
        const s3 = face.c[k];
        const lx = s3[0] * hx, ly = s3[1] * hy, lz = s3[2] * hz;
        // rotation autour de Y : local +X -> (cos, -sin), local +Z -> (sin, cos)
        const wx = cx + lx * ca + lz * sa;
        const wz = cz - lx * sa + lz * ca;
        const uu = (k === 1 || k === 2) ? su : 0;
        const vv = (k >= 2) ? sv : 0;
        this.vert(wx, cy + ly, wz, uu, vv);
      }
      this.i.push(n, n + 1, n + 2, n, n + 2, n + 3);
    }
    return this;
  }

  /**
   * Toit : ridgeFrac = 1 (deux pans, pignons), 0.35 (croupe), 0 (pyramide).
   * Base rectangulaire (hx,hz) au niveau cy, faitage a cy+height.
   */
  roof(cx, cy, cz, hx, hz, height, yaw, ridgeFrac) {
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const along = hx >= hz;
    const rr = (along ? hx : hz) * ridgeFrac;
    const wx = (x, z) => cx + x * ca + z * sa;
    const wz = (x, z) => cz - x * sa + z * ca;
    // 4 coins de base, puis les 2 extremites du faitage
    const bx = [-hx, hx, hx, -hx], bz = [-hz, -hz, hz, hz];
    const r0x = along ? -rr : 0, r0z = along ? 0 : -rr;
    const r1x = along ? rr : 0, r1z = along ? 0 : rr;
    const P = [];
    for (let k = 0; k < 4; k++) P.push([wx(bx[k], bz[k]), cy, wz(bx[k], bz[k])]);
    const R0 = [wx(r0x, r0z), cy + height, wz(r0x, r0z)];
    const R1 = [wx(r1x, r1z), cy + height, wz(r1x, r1z)];
    const pan = (a, b, p, q) => this.quad(
      P[a][0], P[a][1], P[a][2], P[b][0], P[b][1], P[b][2],
      p[0], p[1], p[2], q[0], q[1], q[2], 1, 1,
    );
    const cap = (a, b, r) => this.tri(P[a][0], P[a][1], P[a][2], P[b][0], P[b][1], P[b][2], r[0], r[1], r[2]);
    if (ridgeFrac <= 0.001) {
      for (let k = 0; k < 4; k++) cap((k + 1) % 4, k, R0);
      return this;
    }
    if (along) {
      pan(1, 0, R0, R1); pan(3, 2, R1, R0);
      cap(2, 1, R1); cap(0, 3, R0);
    } else {
      pan(2, 1, R0, R1); pan(0, 3, R1, R0);
      cap(1, 0, R0); cap(3, 2, R1);
    }
    return this;
  }

  /** Prisme vertical a `seg` cotes (cylindre facette). rTop = 0 -> cone. */
  cyl(cx, cy, cz, rBot, rTop, h, seg, capTop = true, capBot = false, yaw = 0) {
    for (let k = 0; k < seg; k++) {
      const a0 = yaw + (k / seg) * TAU, a1 = yaw + ((k + 1) / seg) * TAU;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      if (rTop <= 0.0001) {
        this.tri(cx + c1 * rBot, cy, cz + s1 * rBot, cx + c0 * rBot, cy, cz + s0 * rBot, cx, cy + h, cz);
      } else {
        this.quad(
          cx + c1 * rBot, cy, cz + s1 * rBot,
          cx + c0 * rBot, cy, cz + s0 * rBot,
          cx + c0 * rTop, cy + h, cz + s0 * rTop,
          cx + c1 * rTop, cy + h, cz + s1 * rTop, 1, 1,
        );
      }
    }
    if (capTop && rTop > 0.0001) this.disc(cx, cy + h, cz, rTop, seg, true);
    if (capBot) this.disc(cx, cy, cz, rBot, seg, false);
    return this;
  }

  /** Disque horizontal (up = normale vers +Y). */
  disc(cx, cy, cz, r, seg, up = true) {
    const n = this.p.length / 3;
    this.vert(cx, cy, cz, 0.5, 0.5);
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * TAU;
      this.vert(cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    for (let k = 0; k < seg; k++) {
      if (up) this.i.push(n, n + 2 + k, n + 1 + k);
      else this.i.push(n, n + 1 + k, n + 2 + k);
    }
    return this;
  }

  geometry(flat = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeVertexNormals();
    if (flat) g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Textures paresseuses (aucun acces au DOM au chargement du module)
// ---------------------------------------------------------------------------
function ctx2d(w, h) {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv.getContext('2d');
}

function finishTex(g, key, repeat = true) {
  const t = new THREE.CanvasTexture(g.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = _aniso;
  if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
  _texs.set(key, t);
  return t;
}

function texOf(key, make) {
  if (_texs.has(key)) return _texs.get(key);
  const t = make();
  if (t === null) _texs.set(key, null);
  return t;
}

/** Facade claire a petites fenetres (4x4 cellules) — multipliee par la couleur du batiment. */
function facadeTex() {
  return texOf('facade', () => {
    const g = ctx2d(128, 128);
    if (!g) return null;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 128, 128);
    for (let r = 0; r < 4; r++) {
      // bandeau d'etage
      g.fillStyle = 'rgba(150,138,118,0.55)';
      g.fillRect(0, r * 32 + 29, 128, 3);
      for (let c = 0; c < 4; c++) {
        const x = c * 32 + 9, y = r * 32 + 7;
        g.fillStyle = '#3d4a55';
        g.fillRect(x, y, 14, 17);
        g.fillStyle = 'rgba(255,255,255,0.30)';
        g.fillRect(x, y, 14, 5);
        g.fillStyle = 'rgba(90,70,50,0.5)';
        g.fillRect(x - 2, y + 17, 18, 2);
      }
    }
    return finishTex(g, 'facade');
  });
}

/** Bandes vitrees horizontales : les tours modernes. */
function glassTex() {
  return texOf('glass', () => {
    const g = ctx2d(128, 128);
    if (!g) return null;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 128, 128);
    for (let r = 0; r < 4; r++) {
      const y = r * 32 + 6;
      g.fillStyle = '#4e6a7d';
      g.fillRect(0, y, 128, 20);
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillRect(0, y, 128, 6);
      g.fillStyle = 'rgba(230,235,240,0.9)';
      for (let c = 0; c < 8; c++) g.fillRect(c * 16 + 6, y, 2, 20);
    }
    return finishTex(g, 'glass');
  });
}

/** Bardage metallique ondule : hangars, stands, cabanons. */
function corrugTex() {
  return texOf('corrug', () => {
    const g = ctx2d(64, 64);
    if (!g) return null;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 64; i += 8) {
      g.fillStyle = 'rgba(90,100,110,0.30)';
      g.fillRect(i, 0, 3, 64);
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillRect(i + 4, 0, 2, 64);
    }
    g.fillStyle = 'rgba(70,80,90,0.35)';
    g.fillRect(0, 60, 64, 4);
    return finishTex(g, 'corrug');
  });
}

/** Damier de la ligne de depart. */
function checkerTex() {
  return texOf('checker', () => {
    const g = ctx2d(64, 64);
    if (!g) return null;
    g.fillStyle = '#f4f4f0';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#17181c';
    g.fillRect(0, 0, 32, 32);
    g.fillRect(32, 32, 32, 32);
    return finishTex(g, 'checker');
  });
}

/** Emplacement de grille : rectangle blanc ouvert vers l'avant. */
function gridSlotTex() {
  return texOf('gridslot', () => {
    const g = ctx2d(64, 128);
    if (!g) return null;
    g.clearRect(0, 0, 64, 128);
    g.strokeStyle = '#f4f4f0';
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(5, 4); g.lineTo(5, 124); g.lineTo(59, 124); g.lineTo(59, 4);
    g.stroke();
    return finishTex(g, 'gridslot', false);
  });
}

/** Cercle de l'helipad : anneau blanc + H peint. */
function helipadTex() {
  return texOf('helipad', () => {
    const g = ctx2d(128, 128);
    if (!g) return null;
    g.fillStyle = '#4a4f55';
    g.beginPath(); g.arc(64, 64, 63, 0, TAU); g.fill();
    g.strokeStyle = '#f2f2ee';
    g.lineWidth = 6;
    g.beginPath(); g.arc(64, 64, 50, 0, TAU); g.stroke();
    g.fillStyle = '#f2f2ee';
    g.fillRect(42, 36, 11, 56);
    g.fillRect(75, 36, 11, 56);
    g.fillRect(42, 58, 44, 11);
    return finishTex(g, 'helipad', false);
  });
}

/** Banderole de bord de piste. */
function bannerTex() {
  return texOf('banner', () => {
    const g = ctx2d(256, 64);
    if (!g) return null;
    g.fillStyle = '#d6001c';
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#f6f6f2';
    g.fillRect(0, 48, 256, 16);
    g.fillStyle = '#f6f6f2';
    g.font = 'bold 34px Impact, Haettenschweiler, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('KoRoyale', 128, 24);
    return finishTex(g, 'banner', false);
  });
}

/** Nuage : tache douce. */
function cloudTex() {
  return texOf('cloud', () => {
    const g = ctx2d(128, 64);
    if (!g) return null;
    g.clearRect(0, 0, 128, 64);
    for (const b of [[38, 40, 22], [64, 32, 26], [92, 42, 20], [52, 34, 18], [78, 36, 17]]) {
      const grd = g.createRadialGradient(b[0], b[1], 1, b[0], b[1], b[2]);
      grd.addColorStop(0, 'rgba(255,255,255,0.92)');
      grd.addColorStop(0.6, 'rgba(250,252,255,0.5)');
      grd.addColorStop(1, 'rgba(245,250,255,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(b[0], b[1], b[2], 0, TAU); g.fill();
    }
    return finishTex(g, 'cloud', false);
  });
}

// ---------------------------------------------------------------------------
// Materiaux mutualises
// ---------------------------------------------------------------------------
const mOpaque = (key, opts) => matOf(key, () => new THREE.MeshLambertMaterial(opts));

const mTerrain = () => mOpaque('terrain', { vertexColors: true, flatShading: true });
const mPlain = () => mOpaque('plain', { vertexColors: true });
const mPlainFlat = () => mOpaque('plainFlat', { vertexColors: true, flatShading: true });
const mPlainDS = () => mOpaque('plainDS', { vertexColors: true, side: THREE.DoubleSide });
const mFacade = () => mOpaque('mFacade', { vertexColors: true, map: facadeTex() });
const mGlass = () => mOpaque('mGlass', { vertexColors: true, map: glassTex() });
const mCorrug = () => mOpaque('mCorrug', { vertexColors: true, map: corrugTex() });
const mBanner = () => mOpaque('mBanner', { vertexColors: true, map: bannerTex(), side: THREE.DoubleSide });

/** Decalcomanie posee sur l'asphalte (polygonOffset pour tuer le z-fighting). */
function mDecal(key, opts) {
  return matOf(key, () => new THREE.MeshLambertMaterial({
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...opts,
  }));
}

// ---------------------------------------------------------------------------
// 1. Terrain
// ---------------------------------------------------------------------------

/** Couleur d'un sommet : altitude, pente et zones remarquables (une seule requete de hauteur). */
function terrainColorAt(x, z, y, slope, out) {
  if (y < -0.35) {
    _colA.setHex(C.sableMouille); _colB.setHex(C.fondMarin);
    out.copy(_colA).lerp(_colB, smoothstep(-1, -13, y));
    return out;
  }
  const n = fbm2(x * 0.013 + 3.1, z * 0.013 - 2.4, 2);
  _colA.setHex(C.herbe); _colB.setHex(C.herbeClaire);
  out.copy(_colA).lerp(_colB, n);
  if (y > 40 && y < 130) { _colB.setHex(C.herbeSeche); out.lerp(_colB, smoothstep(45, 110, y) * 0.5); }

  // rivage sableux
  const shore = smoothstep(2.6, 0.1, y);
  const db = Math.hypot(x - BEACH.x, z - BEACH.z);
  const beach = 1 - smoothstep(BEACH.r - 30, BEACH.r + 16, db);
  const sand = Math.max(shore, beach);
  if (sand > 0) { _colB.setHex(C.sable); out.lerp(_colB, sand); }

  // pente : la roche perce
  if (slope > 0.42) {
    _colB.setHex(n > 0.5 ? C.roche : C.rocheClaire);
    out.lerp(_colB, smoothstep(0.42, 1.05, slope));
  }

  // Mont Chevre : caillasse
  const dm = Math.hypot(x - MOUNT.x, z - MOUNT.z);
  if (dm < MOUNT.r * 0.72) { _colB.setHex(C.roche); out.lerp(_colB, 1 - smoothstep(MOUNT.r * 0.5, MOUNT.r * 0.72, dm)); }

  // plateau du Rocher + quais du port : pierre creme
  const dro = Math.hypot(x - ROCHER.x, z - ROCHER.z);
  if (dro < ROCHER.r + 8) { _colB.setHex(C.pierre); out.lerp(_colB, 1 - smoothstep(ROCHER.r - 12, ROCHER.r + 8, dro)); }
  if (y > 3 && y < 13 && harbourFactor(x, z) < 0.04
    && x > HARBOUR.minX - 60 && x < HARBOUR.maxX + 60 && z > HARBOUR.minZ - 60 && z < HARBOUR.maxZ + 60) {
    _colB.setHex(C.pierre); out.lerp(_colB, 0.85);
  }

  // neige des sommets
  if (y > 138) { _colB.setHex(C.neige); out.lerp(_colB, smoothstep(146, 168, y)); }
  return out;
}

/** Grille d'altitudes + maillage indexe flatShading, une seule requete terrainHeight par sommet. */
function buildTerrain(step) {
  const n = Math.round((WORLD_HALF * 2) / step) + 1;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -WORLD_HALF + j * step;
    for (let i = 0; i < n; i++) h[j * n + i] = terrainHeight(-WORLD_HALF + i * step, z);
  }

  const pos = new Float32Array(n * n * 3);
  const nor = new Float32Array(n * n * 3);
  const col = new Float32Array(n * n * 3);
  const inv = 1 / (2 * step);
  for (let j = 0; j < n; j++) {
    const z = -WORLD_HALF + j * step;
    for (let i = 0; i < n; i++) {
      const k = j * n + i, k3 = k * 3;
      const x = -WORLD_HALF + i * step;
      const y = h[k];
      const hx0 = h[k - (i > 0 ? 1 : 0)], hx1 = h[k + (i < n - 1 ? 1 : 0)];
      const hz0 = h[k - (j > 0 ? n : 0)], hz1 = h[k + (j < n - 1 ? n : 0)];
      const dx = (hx1 - hx0) * inv, dz = (hz1 - hz0) * inv;
      pos[k3] = x; pos[k3 + 1] = y; pos[k3 + 2] = z;
      const l = Math.hypot(dx, 1, dz) || 1;
      nor[k3] = -dx / l; nor[k3 + 1] = 1 / l; nor[k3 + 2] = -dz / l;
      terrainColorAt(x, z, y, Math.hypot(dx, dz), _colT);
      col[k3] = _colT.r; col[k3 + 1] = _colT.g; col[k3 + 2] = _colT.b;
    }
  }

  const quads = (n - 1) * (n - 1);
  const idx = new Uint32Array(quads * 6);
  let o = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return { geo: g, heights: h, n, step };
}

// ---------------------------------------------------------------------------
// 2. Mer
// ---------------------------------------------------------------------------
// La houle est calculee en coordonnees MONDE : le plan peut suivre la camera sans
// que les vagues ne glissent avec elle.
const SEA_VERT = `
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNrm;
varying float vCrest;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float a1 = wp.x * 0.055 + uTime * 1.05;
  float a2 = wp.z * 0.041 - uTime * 0.85;
  float a3 = (wp.x + wp.z) * 0.021 + uTime * 0.55;
  float w1 = sin(a1), w2 = sin(a2), w3 = sin(a3);
  wp.y += w1 * 0.20 + w2 * 0.17 + w3 * 0.30;
  vCrest = (w1 + w2 + w3) * 0.333;
  float dx = 0.055 * 0.20 * cos(a1) + 0.021 * 0.30 * cos(a3);
  float dz = 0.041 * 0.17 * cos(a2) + 0.021 * 0.30 * cos(a3);
  vNrm = normalize(vec3(-dx, 1.0, -dz));
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  #include <fog_vertex>
  gl_Position = projectionMatrix * mvPosition;
}`;

const SEA_FRAG = `
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSky;
uniform vec3 uSunCol;
uniform vec3 uSunDir;
uniform float uOpacity;
varying vec3 vWorld;
varying vec3 vNrm;
varying float vCrest;
#include <fog_pars_fragment>
void main() {
  vec3 view = normalize(cameraPosition - vWorld);
  vec3 nrm = normalize(vNrm);
  float fres = pow(1.0 - clamp(dot(nrm, view), 0.0, 1.0), 4.0);
  vec3 col = mix(uDeep, uShallow, clamp(vCrest * 0.9 + 0.5, 0.0, 1.0));
  col = mix(col, uSky, fres * 0.55);
  float spec = pow(max(dot(reflect(-uSunDir, nrm), view), 0.0), 60.0);
  col += uSunCol * spec * 0.9;
  col += uShallow * smoothstep(0.55, 0.95, vCrest) * 0.25;
  gl_FragColor = vec4(col, uOpacity + fres * 0.2);
  #include <fog_fragment>
}`;

/** Cote du plan de mer et taille d'une maille (sert au « snap » du suivi camera). */
const SEA_SIZE = 2600;

function buildSea(quality) {
  const seg = quality === 'low' ? 80 : quality === 'medium' ? 128 : 160;
  const geo = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(0x3fd0d8) },
        uDeep: { value: new THREE.Color(0x0d5f80) },
        uSky: { value: new THREE.Color(0xa8d8ef) },
        uSunCol: { value: new THREE.Color(0xfff4dc) },
        uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.55) },
        uOpacity: { value: 0.82 },
      },
    ]),
    vertexShader: SEA_VERT,
    fragmentShader: SEA_FRAG,
    fog: true,
    transparent: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = SEA_LEVEL;
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  mesh.name = 'mer';
  mesh.userData.cell = SEA_SIZE / seg;
  return mesh;
}

// ---------------------------------------------------------------------------
// 3. Circuit
// ---------------------------------------------------------------------------

/** Courbure locale (rad) autour de l'echantillon i. */
function curvatureAt(ss, i, span) {
  const n = ss.length;
  const a = ss[(i - span + n) % n], b = ss[(i + span) % n];
  return Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz);
}

/** Ruban ferme le long de la ligne centrale, entre deux offsets lateraux. */
function pushRibbon(m, ss, latA, latB, yOff) {
  const n = ss.length;
  const base = m.p.length / 3;
  for (let i = 0; i < n; i++) {
    const p = ss[i];
    const a = latA(p), b = latB(p);
    m.vert(p.x + p.nx * a, p.y + yOff, p.z + p.nz * a, 0, 0);
    m.vert(p.x + p.nx * b, p.y + yOff, p.z + p.nz * b, 1, 0);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const i0 = base + i * 2, i1 = i0 + 1, j0 = base + j * 2, j1 = j0 + 1;
    m.i.push(i0, j1, i1, i0, j0, j1);
  }
}

function buildTrack(map) {
  const ss = trackSamples();
  const n = ss.length;
  const road = new Mesher().col(C.asphalte);
  pushRibbon(road, ss, (p) => p.width * 0.5, () => 0, 0.06);
  pushRibbon(road, ss, () => 0, (p) => -p.width * 0.5, 0.06);

  // lignes blanches de rive
  const lines = new Mesher().col(C.ligneBlanche);
  pushRibbon(lines, ss, (p) => p.width * 0.5 - 0.12, (p) => p.width * 0.5 - 0.40, 0.075);
  pushRibbon(lines, ss, (p) => -p.width * 0.5 + 0.40, (p) => -p.width * 0.5 + 0.12, 0.075);

  // vibreurs : la ou ca tourne
  const kerb = new Mesher();
  for (let i = 0; i < n; i++) {
    const k = curvatureAt(ss, i, 4);
    const mag = Math.abs(k);
    if (mag < 0.05) continue;
    const inner = k > 0 ? 1 : -1;
    const sides = mag > 0.13 ? [inner, -inner] : [inner];
    const j = (i + 1) % n;
    const a = ss[i], b = ss[j];
    if (a.tunnel && b.tunnel) continue;
    kerb.col((i >> 1) % 2 === 0 ? C.vibreurRouge : C.vibreurBlanc);
    for (const side of sides) {
      const l0 = a.width * 0.5 - 0.15, l1 = a.width * 0.5 + 0.72;
      const m0 = b.width * 0.5 - 0.15, m1 = b.width * 0.5 + 0.72;
      const ax0 = a.x + a.nx * l0 * side, az0 = a.z + a.nz * l0 * side;
      const ax1 = a.x + a.nx * l1 * side, az1 = a.z + a.nz * l1 * side;
      const bx0 = b.x + b.nx * m0 * side, bz0 = b.z + b.nz * m0 * side;
      const bx1 = b.x + b.nx * m1 * side, bz1 = b.z + b.nz * m1 * side;
      const y0 = a.y + 0.07, y1 = a.y + 0.13, y2 = b.y + 0.13, y3 = b.y + 0.07;
      // l'ordre depend du cote : la normale doit toujours regarder le ciel
      if (side > 0) kerb.quad(ax0, y0, az0, ax1, y1, az1, bx1, y2, bz1, bx0, y3, bz0);
      else kerb.quad(ax1, y1, az1, ax0, y0, az0, bx0, y3, bz0, bx1, y2, bz1);
    }
  }

  const group = new THREE.Group();
  group.name = 'circuit';
  const gRoad = road.geometry();
  group.add(new THREE.Mesh(gRoad, mOpaque('asphalte', { vertexColors: true })));
  const gLines = lines.geometry();
  group.add(new THREE.Mesh(gLines, mDecal('marquage', { vertexColors: true })));
  const own = [gRoad, gLines];
  if (!kerb.empty) {
    const gk = kerb.geometry();
    own.push(gk);
    group.add(new THREE.Mesh(gk, mDecal('vibreur', { vertexColors: true })));
  }

  // damier de la ligne de depart
  if (map.startLine) {
    const sl = map.startLine;
    const g = geoOf('startPlane', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    const tex = checkerTex();
    const mat = mDecal('damier', { color: 0xffffff, map: tex });
    if (tex) { tex.repeat.set(6, 1); tex.needsUpdate = true; }
    const q = new THREE.Mesh(g, mat);
    q.scale.set(sl.width, 1, 2.6);
    q.position.set(sl.x, sl.y + 0.09, sl.z);
    q.rotation.y = sl.yaw;
    group.add(q);
  }

  // emplacements de la grille de depart
  const slots = startingGrid(20);
  const slotGeo = geoOf('slotPlane', () => new THREE.PlaneGeometry(2.6, 5.4).rotateX(-Math.PI / 2));
  const slotMat = mDecal('gridslot', { color: 0xffffff, map: gridSlotTex(), alphaTest: 0.4 });
  const inst = new THREE.InstancedMesh(slotGeo, slotMat, slots.length);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    _e.set(0, s.yaw, 0); _q.setFromEuler(_e);
    _m4.compose(_v.set(s.x, s.y + 0.085, s.z), _q, _s.set(1, 1, 1));
    inst.setMatrixAt(i, _m4);
  }
  inst.instanceMatrix.needsUpdate = true;
  group.add(inst);

  return { group, own };
}

// ---------------------------------------------------------------------------
// 4. Rails de securite
// ---------------------------------------------------------------------------
function buildRails(map, group) {
  const rails = map.rails;
  if (!rails.length) return;
  const bandGeo = geoOf('railBand', () => {
    const m = new Mesher().col(C.metal);
    m.box(0, 0.88, 0, 0.18, 0.26, 0.5);
    m.col(C.metalSombre).box(0, 0.62, 0, 0.13, 0.06, 0.5);
    return m.geometry();
  });
  const postGeo = geoOf('railPost', () => {
    const m = new Mesher().col(C.metalSombre);
    m.box(0, 0.45, 0, 0.09, 0.45, 0.09);
    return m.geometry();
  });
  const mat = mPlain();
  const band = new THREE.InstancedMesh(bandGeo, mat, rails.length);
  const posts = new THREE.InstancedMesh(postGeo, mat, rails.length);
  for (let i = 0; i < rails.length; i++) {
    const r = rails[i];
    _e.set(0, r.yaw, 0); _q.setFromEuler(_e);
    _m4.compose(_v.set(r.x, r.y, r.z), _q, _s.set(1, 1, Math.max(0.4, r.len)));
    band.setMatrixAt(i, _m4);
    _m4.compose(_v, _q, _s.set(1, 1, 1));
    posts.setMatrixAt(i, _m4);
  }
  band.instanceMatrix.needsUpdate = true;
  posts.instanceMatrix.needsUpdate = true;
  band.name = 'rails';
  posts.name = 'railsPoteaux';
  group.add(band, posts);
}

// ---------------------------------------------------------------------------
// 5. Tunnel
// ---------------------------------------------------------------------------
function buildTunnel(map) {
  const segs = map.tunnelSegments;
  if (!segs.length) return null;
  const walls = new Mesher();
  const lamps = new Mesher().col(C.orange);
  const ARC = 7;
  for (const s of segs) {
    const ca = Math.cos(s.yaw), sa = Math.sin(s.yaw);
    // repere local : +X = (cos, -sin), +Z = (sin, cos)
    const wx = (lx, lz) => s.x + lx * ca + lz * sa;
    const wz = (lx, lz) => s.z - lx * sa + lz * ca;
    walls.col(C.beton);
    walls.box(wx(s.halfW, 0), s.y + 4.5, wz(s.halfW, 0), 1.2, 4.5, 5.0, s.yaw, 6, 6);
    walls.box(wx(-s.halfW, 0), s.y + 4.5, wz(-s.halfW, 0), 1.2, 4.5, 5.0, s.yaw, 6, 6);
    // voute : coque polygonale opaque (DoubleSide), du haut d'un mur a l'autre
    const R = s.halfW + 1.4;
    const y0 = s.y + 8.4, rise = 2.4;
    walls.col(C.betonSombre);
    for (let k = 0; k < ARC; k++) {
      const t0 = k / ARC, t1 = (k + 1) / ARC;
      const x0 = -R + 2 * R * t0, x1 = -R + 2 * R * t1;
      const h0 = y0 + Math.sin(t0 * Math.PI) * rise, h1 = y0 + Math.sin(t1 * Math.PI) * rise;
      walls.quad(
        wx(x1, -5), h1, wz(x1, -5),
        wx(x0, -5), h0, wz(x0, -5),
        wx(x0, 5), h0, wz(x0, 5),
        wx(x1, 5), h1, wz(x1, 5),
      );
    }
    // lampe orange sous la voute (plan emissif, pas de lumiere dynamique)
    lamps.quad(
      wx(-0.7, -1.3), s.y + 8.3, wz(-0.7, -1.3),
      wx(0.7, -1.3), s.y + 8.3, wz(0.7, -1.3),
      wx(0.7, 1.3), s.y + 8.3, wz(0.7, 1.3),
      wx(-0.7, 1.3), s.y + 8.3, wz(-0.7, 1.3),
    );
  }
  const group = new THREE.Group();
  group.name = 'tunnel';
  const gw = walls.geometry();
  group.add(new THREE.Mesh(gw, mOpaque('tunnelBeton', { vertexColors: true, side: THREE.DoubleSide })));
  const gl = lamps.geometry();
  const lm = matOf('tunnelLampe', () => new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false }));
  group.add(new THREE.Mesh(gl, lm));
  return { group, own: [gw, gl] };
}

// ---------------------------------------------------------------------------
// 6. Batiments
// ---------------------------------------------------------------------------

// Metres couverts par une repetition de texture (les uv sont calcules par face).
const TILE_FACADE = [12.8, 13.6];
const TILE_GLASS = [12.8, 13.6];
const TILE_CORRUG = [5.0, 5.0];

/** Bandeau de balcons sur les faces longues. */
function addBalconies(m, b, hx, hz, floors) {
  m.col(0xe9e4d6);
  const top = Math.min(floors, 8);
  for (let f = 1; f < top; f++) {
    const y = b.y + (b.h / floors) * f;
    m.box(b.x, y, b.z, hx + 0.45, 0.09, hz + 0.45, b.yaw);
    m.col(0xcfc8b6);
    m.box(b.x, y + 0.34, b.z, hx + 0.45, 0.26, hz + 0.45, b.yaw);
    m.col(0xe9e4d6);
  }
}

/** Corniche / acrotere d'un toit plat. */
function addParapet(m, b, hx, hz, color) {
  m.col(color);
  m.box(b.x, b.y + b.h + 0.28, b.z, hx + 0.32, 0.28, hz + 0.32, b.yaw);
}

function roofOf(m, b, hx, hz, style) {
  const tile = style === 'farm' || style === 'shed' ? C.bois : C.terracotta;
  if (b.roof === 'tile') {
    m.col(tile);
    m.roof(b.x, b.y + b.h, b.z, hx + 0.5, hz + 0.5, Math.min(4.5, 1.4 + Math.max(hx, hz) * 0.28), b.yaw, 0.35);
  } else if (b.roof === 'gable') {
    m.col(tile);
    m.roof(b.x, b.y + b.h, b.z, hx + 0.4, hz + 0.4, 2.2 + Math.min(hx, hz) * 0.32, b.yaw, 1);
  } else if (b.roof === 'tower') {
    m.col(C.terracottaSombre);
    m.roof(b.x, b.y + b.h, b.z, hx + 0.6, hz + 0.6, Math.max(hx, hz) * 1.9, b.yaw, 0);
  } else {
    addParapet(m, b, hx, hz, 0xe4dccb);
  }
}

/** Un generateur par style ; chacun ecrit dans le mesher de sa famille de materiau. */
const BUILDING_STYLES = {
  monaco(fam, b, hx, hz) {
    const m = fam.facade;
    m.col(b.color ?? C.creme);
    m.box(b.x, b.y + b.h / 2, b.z, hx, b.h / 2, hz, b.yaw, TILE_FACADE[0], TILE_FACADE[1]);
    if (b.balcony) addBalconies(fam.plain, b, hx, hz, b.floors);
    roofOf(fam.plain, b, hx, hz, b.style);
  },
  modern(fam, b, hx, hz) {
    const m = fam.glass;
    m.col(b.color ?? 0xd7dee6);
    m.box(b.x, b.y + b.h / 2, b.z, hx, b.h / 2, hz, b.yaw, TILE_GLASS[0], TILE_GLASS[1]);
    const p = fam.plain;
    if (b.h > 24) { // edicule technique sur le toit
      p.col(0xb4bcc4);
      p.box(b.x, b.y + b.h + 1.6, b.z, hx * 0.4, 1.4, hz * 0.4, b.yaw);
    }
    roofOf(p, b, hx, hz, b.style);
  },
  oldtown(fam, b, hx, hz) {
    const m = fam.facade;
    m.col(b.color ?? 0xefe0c4);
    m.box(b.x, b.y + b.h / 2, b.z, hx, b.h / 2, hz, b.yaw, 9.6, 10.2);
    if (b.roof === 'tower') {
      const p = fam.plain;
      p.col(b.color ?? 0xefe0c4);
      p.box(b.x, b.y + b.h + 0.6, b.z, hx * 0.9, 0.6, hz * 0.9, b.yaw);
    }
    roofOf(fam.plain, b, hx, hz, b.style);
  },
  industrial(fam, b, hx, hz) {
    const m = fam.corrug;
    m.col(b.color ?? 0xb9c2c9);
    m.box(b.x, b.y + b.h / 2, b.z, hx, b.h / 2, hz, b.yaw, TILE_CORRUG[0], TILE_CORRUG[1]);
    const p = fam.plain;
    p.col(0x6f7880);
    p.box(b.x, b.y + b.h + 0.25, b.z, hx + 0.5, 0.25, hz + 0.5, b.yaw);
    if (b.roof === 'gable') roofOf(p, b, hx, hz, b.style);
  },
  farm(fam, b, hx, hz) {
    const m = fam.plain;
    m.col(b.color ?? C.bois);
    m.box(b.x, b.y + b.h / 2, b.z, hx, b.h / 2, hz, b.yaw);
    // planches croisees de la grande porte, cote local -Z
    const ca = Math.cos(b.yaw), sa = Math.sin(b.yaw);
    m.col(0x6f5637);
    m.box(b.x + (-hz - 0.06) * sa, b.y + b.h * 0.3, b.z + (-hz - 0.06) * ca,
      Math.min(hx * 0.5, 2.6), b.h * 0.3, 0.08, b.yaw);
    roofOf(m, b, hx, hz, b.style);
  },
  casino(fam, b, hx, hz) {
    const m = fam.facade;
    m.col(b.color ?? 0xe8dfc8);
    m.box(b.x, b.y + b.h / 2, b.z, hx, b.h / 2, hz, b.yaw, 10.5, 12);
    const p = fam.plain;
    p.col(0xf2ecd8);
    // colonnade sur la facade avant (local -Z)
    const ca = Math.cos(b.yaw), sa = Math.sin(b.yaw);
    const nCol = Math.max(4, Math.round(hx / 3));
    for (let k = 0; k < nCol; k++) {
      const lx = -hx + (2 * hx) * ((k + 0.5) / nCol), lz = -hz - 1.1;
      p.cyl(b.x + lx * ca + lz * sa, b.y, b.z - lx * sa + lz * ca, 0.5, 0.42, b.h * 0.62, 6);
    }
    p.box(b.x + (-hz - 1.1) * sa, b.y + b.h * 0.62 + 0.4, b.z + (-hz - 1.1) * ca, hx, 0.4, 1.4, b.yaw);
    // cornice + coupoles d'angle
    p.col(0xdcd2b8);
    p.box(b.x, b.y + b.h + 0.5, b.z, hx + 0.7, 0.5, hz + 0.7, b.yaw);
    p.col(0x9fb0a4);
    for (const sx of [-1, 1]) {
      const lx = sx * (hx - 2.4), lz = -hz + 2.4;
      const dx = b.x + lx * ca + lz * sa, dz = b.z - lx * sa + lz * ca;
      p.cyl(dx, b.y + b.h + 1, dz, 3, 2.2, 2.4, 8);
      p.cyl(dx, b.y + b.h + 3.4, dz, 2.2, 0, 3.4, 8);
    }
  },
  hotel(fam, b, hx, hz) {
    const m = fam.facade;
    m.col(b.color ?? 0xf0e7d2);
    m.box(b.x, b.y + b.h / 2, b.z, hx, b.h / 2, hz, b.yaw, TILE_FACADE[0], TILE_FACADE[1]);
    addBalconies(fam.plain, b, hx, hz, Math.max(3, b.floors));
    const p = fam.plain;
    p.col(0xe0d6bd);
    p.box(b.x, b.y + b.h + 0.45, b.z, hx + 0.8, 0.45, hz + 0.8, b.yaw);
    p.col(0xc8bda2);
    p.box(b.x, b.y + b.h + 1.7, b.z, hx * 0.55, 0.8, hz * 0.55, b.yaw);
  },
  pit(fam, b, hx, hz) {
    const m = fam.corrug;
    m.col(b.color ?? 0xe8e8ea);
    m.box(b.x, b.y + b.h / 2, b.z, hx, b.h / 2, hz, b.yaw, TILE_CORRUG[0], TILE_CORRUG[1]);
    const p = fam.plain;
    const ca = Math.cos(b.yaw), sa = Math.sin(b.yaw);
    // rideau du garage + auvent, cote piste (local -X)
    p.col(0x2b2f36);
    p.box(b.x + (-hx - 0.05) * ca, b.y + b.h * 0.34, b.z - (-hx - 0.05) * sa, 0.08, b.h * 0.34, hz * 0.7, b.yaw);
    p.col(0xd6001c);
    p.box(b.x + (-hx - 1.6) * ca, b.y + b.h * 0.78, b.z - (-hx - 1.6) * sa, 1.6, 0.16, hz, b.yaw);
    p.col(0xe4e4e6);
    p.box(b.x, b.y + b.h + 0.2, b.z, hx + 0.3, 0.2, hz + 0.3, b.yaw);
  },
  grandstand(fam, b, hx, hz) {
    const p = fam.plain;
    const ca = Math.cos(b.yaw), sa = Math.sin(b.yaw);
    const rows = 7;
    // gradins : ils montent en s'eloignant de la piste (piste vers local +X)
    for (let k = 0; k < rows; k++) {
      const t = k / rows;
      const lx = hx - (2 * hx) * ((k + 0.5) / rows);
      const y = b.y + b.h * 0.18 + t * b.h * 0.62;
      p.col(k % 2 ? 0xdfe4ea : 0xcdd5de);
      p.box(b.x + lx * ca, y, b.z - lx * sa, hx / rows, b.h * 0.09 + t * b.h * 0.3, hz, b.yaw);
      p.col(0x2f7bd6);
      p.box(b.x + lx * ca, y + b.h * 0.09 + t * b.h * 0.3 + 0.22, b.z - lx * sa, hx / rows * 0.8, 0.22, hz * 0.94, b.yaw);
    }
    // portique + toiture
    p.col(0xb9c2c9);
    for (const sz of [-1, 1]) {
      const lz = sz * (hz - 0.4);
      p.box(b.x + (-hx + 0.4) * ca + lz * sa, b.y + b.h * 0.7, b.z - (-hx + 0.4) * sa + lz * ca, 0.3, b.h * 0.7, 0.3, b.yaw);
    }
    p.col(0xe6ebf0);
    p.box(b.x - hx * 0.25 * ca, b.y + b.h * 1.42, b.z + hx * 0.25 * sa, hx * 0.8, 0.22, hz + 0.6, b.yaw);
  },
  shed(fam, b, hx, hz) {
    const m = fam.plain;
    m.col(b.color ?? 0x8d7350);
    m.box(b.x, b.y + b.h / 2, b.z, hx, b.h / 2, hz, b.yaw);
    roofOf(m, b, hx, hz, b.style);
  },
};

function buildBuildings(map, quality) {
  const fam = {
    facade: new Mesher(), glass: new Mesher(), corrug: new Mesher(), plain: new Mesher(),
  };
  for (const b of map.buildings) {
    const gen = BUILDING_STYLES[b.style] || BUILDING_STYLES.monaco;
    gen(fam, b, b.w / 2, b.d / 2);
  }
  const group = new THREE.Group();
  group.name = 'batiments';
  const own = [];
  const add = (mesher, mat) => {
    if (mesher.empty) return;
    const g = mesher.geometry();
    own.push(g);
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = quality === 'high';
    mesh.receiveShadow = quality === 'high';
    group.add(mesh);
  };
  add(fam.facade, mFacade());
  add(fam.glass, mGlass());
  add(fam.corrug, mCorrug());
  add(fam.plain, mPlainFlat());
  return { group, own };
}

// ---------------------------------------------------------------------------
// 7. Props (un InstancedMesh par kind)
// ---------------------------------------------------------------------------

/** Petits objets sautes en qualite basse. */
const PROP_SMALL = new Set(['bench', 'crate', 'bollard', 'barrel', 'parasol', 'banner', 'haybale', 'fence', 'lamppost']);
/** Kinds dont la couleur vient de l'instance (geometrie neutre + instanceColor). */
const PROP_TINTED = new Set(['container', 'rampart', 'ramp', 'pontoon']);
/** Kinds rendus avec un materiau double face (feuillages plats). */
const PROP_DOUBLE = new Set(['palm', 'parasol']);

const PROP_BUILDERS = {
  pine(m) {
    m.col(C.tronc).cyl(0, 0, 0, 0.28, 0.16, 3.2, 5);
    m.col(C.vertPin);
    m.cyl(0, 2.2, 0, 2.0, 0, 3.4, 6);
    m.cyl(0, 4.4, 0, 1.6, 0, 3.0, 6);
    m.cyl(0, 6.4, 0, 1.05, 0, 2.6, 6);
  },
  olive(m) {
    m.col(C.tronc).cyl(0, 0, 0, 0.32, 0.22, 1.9, 5);
    m.col(C.vertOlive);
    m.cyl(0, 1.6, 0, 1.5, 1.1, 1.5, 7);
    m.cyl(0, 3.1, 0, 1.15, 0, 1.5, 7);
    m.col(C.vertSauge);
    m.cyl(-1.0, 2.0, 0.4, 0.9, 0, 1.4, 6);
    m.cyl(1.0, 2.2, -0.5, 0.85, 0, 1.3, 6);
  },
  palm(m) {
    m.col(0x9b8460);
    for (let k = 0; k < 5; k++) {
      const t = k / 5, tn = (k + 1) / 5;
      const bend = 0.55;
      m.box(bend * t * t * 5, 0.9 + k * 1.5, 0, 0.24 - t * 0.07, 0.78, 0.24 - t * 0.07, 0);
      void tn;
    }
    const topX = bendTip(0.55, 5), topY = 8.1;
    m.col(C.vertPalme);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const L = 2.9, drop = -1.5;
      m.quad(
        topX - sa * 0.22, topY, -ca * 0.22,
        topX + sa * 0.22, topY, ca * 0.22,
        topX + ca * L + sa * 0.5, topY + drop, sa * L - ca * 0.5,
        topX + ca * L - sa * 0.5, topY + drop, sa * L + ca * 0.5,
      );
    }
    m.col(0x7a5a3a).cyl(topX, topY - 0.4, 0, 0.3, 0.2, 0.5, 6);
  },
  cypress(m) {
    m.col(C.tronc).cyl(0, 0, 0, 0.2, 0.16, 1.0, 5);
    m.col(C.vertCypres);
    m.cyl(0, 0.6, 0, 0.85, 0.55, 4.6, 6);
    m.cyl(0, 5.2, 0, 0.62, 0, 2.6, 6);
  },
  rock(m) {
    // caillou facette : icosaedre bosselé, flatShading assume
    const g = new THREE.IcosahedronGeometry(1, 0);
    const p = g.getAttribute('position');
    m.col(C.roche);
    for (let i = 0; i < p.count; i += 3) {
      const vs = [];
      for (let k = 0; k < 3; k++) {
        const x = p.getX(i + k), y = p.getY(i + k), z = p.getZ(i + k);
        const j = 0.72 + ((Math.abs(Math.sin(x * 12.9 + y * 78.2 + z * 37.7)) * 43758.5) % 1) * 0.5;
        vs.push([x * j, Math.max(y * j * 0.78, -0.08), z * j]);
      }
      m.tri(vs[0][0], vs[0][1], vs[0][2], vs[1][0], vs[1][1], vs[1][2], vs[2][0], vs[2][1], vs[2][2]);
    }
    g.dispose();
  },
  lamppost(m) {
    m.col(C.metalSombre);
    m.cyl(0, 0, 0, 0.16, 0.09, 5.4, 6);
    m.box(0.5, 5.5, 0, 0.55, 0.08, 0.08);
    m.col(0xfff0c0);
    m.box(1.0, 5.3, 0, 0.24, 0.14, 0.24);
  },
  bench(m) {
    m.col(C.boisClair);
    m.box(0, 0.44, 0, 1.1, 0.05, 0.24);
    m.box(0, 0.78, -0.22, 1.1, 0.24, 0.05);
    m.col(C.metalSombre);
    m.box(-0.9, 0.22, 0, 0.06, 0.22, 0.22);
    m.box(0.9, 0.22, 0, 0.06, 0.22, 0.22);
  },
  crate(m) {
    m.col(C.bois).box(0, 0.55, 0, 1.1, 0.55, 0.55);
    m.col(0x6a5134);
    m.box(0, 0.55, 0.57, 1.1, 0.06, 0.02);
    m.box(0, 1.06, 0, 1.12, 0.05, 0.57);
  },
  bollard(m) {
    m.col(C.metalSombre).cyl(0, 0, 0, 0.2, 0.17, 0.95, 8);
    m.cyl(0, 0.95, 0, 0.24, 0.12, 0.18, 8);
  },
  container(m) {
    // hauteur unique 2.6 m (mapdata empile parfois 5.2 m cote collider)
    m.col(0xffffff).box(0, 1.3, 0, 3.0, 1.3, 1.3, 0, 1.2, 1.2);
    m.col(0xdadada);
    m.box(0, 2.62, 0, 3.02, 0.04, 1.32);
    m.box(3.02, 1.3, 0, 0.03, 1.2, 1.2);
  },
  barrel(m) {
    m.col(0xb8562f).cyl(0, 0, 0, 0.5, 0.5, 1.2, 8, true, true);
    m.col(0x8a3f22);
    m.cyl(0, 0.32, 0, 0.53, 0.53, 0.08, 8, false);
    m.cyl(0, 0.8, 0, 0.53, 0.53, 0.08, 8, false);
  },
  haybale(m) {
    m.col(0xd9c179).cyl(0, 0, 0, 1.5, 1.5, 2.2, 9, true, false);
    m.col(0xc0a75f);
    m.cyl(0, 0.7, 0, 1.53, 1.53, 0.1, 9, false);
    m.cyl(0, 1.5, 0, 1.53, 1.53, 0.1, 9, false);
  },
  fence(m) {
    // le collider s'etend sur l'axe local X (hx = 3.2)
    m.col(C.boisClair);
    m.box(0, 1.05, 0, 3.2, 0.07, 0.05);
    m.box(0, 0.62, 0, 3.2, 0.07, 0.05);
    m.col(C.bois);
    for (const sx of [-3.1, -1, 1, 3.1]) m.box(sx, 0.7, 0, 0.09, 0.7, 0.09);
  },
  silo(m) {
    m.col(0xc8cdd2).cyl(0, 0, 0, 3.6, 3.6, 12, 10, false);
    m.col(0xaeb5bb).cyl(0, 12, 0, 3.7, 0, 3.2, 10);
    m.col(0x8f979e);
    for (let k = 0; k < 4; k++) m.cyl(0, 3 * k, 0, 3.66, 3.66, 0.14, 10, false);
  },
  crane(m) {
    m.col(0xf0a020);
    for (const sx of [-1.8, 1.8]) {
      for (const sz of [-1.8, 1.8]) m.box(sx, 6.5, sz, 0.22, 6.5, 0.22);
    }
    m.box(0, 13.2, 0, 2.1, 0.5, 2.1);
    m.col(0xd88c14);
    m.box(0, 14.4, 5.5, 0.6, 0.5, 8.0);
    m.box(0, 14.4, -3.4, 0.5, 0.4, 2.4);
    m.col(C.metalSombre);
    m.box(0, 13.0, 11.4, 0.18, 1.6, 0.18);
    m.box(0, 11.4, 11.4, 0.5, 0.4, 0.5);
  },
  helicopter(m) {
    m.col(0x2b6fbf);
    m.box(0, 1.5, 0.4, 1.0, 0.85, 2.6);
    m.col(0x1f5490);
    m.box(0, 1.7, 3.0, 0.75, 0.6, 0.8);
    m.col(0x9ed7e8);
    m.box(0, 1.85, 2.3, 0.72, 0.5, 0.7);
    m.col(0x2b6fbf);
    m.box(0, 1.9, -2.6, 0.22, 0.22, 3.0);
    m.box(0, 2.6, -3.9, 0.12, 0.7, 0.5);
    m.col(C.metalSombre);
    m.box(0, 3.05, 0.4, 0.16, 0.35, 0.16);
    m.box(0, 3.42, 0.4, 3.2, 0.05, 0.16);   // pales croisees
    m.box(0, 3.46, 0.4, 0.16, 0.05, 3.2);
    for (const sx of [-1.0, 1.0]) m.box(sx, 0.15, 0.4, 0.07, 0.15, 2.2);
    m.box(-0.55, 0.7, 0.4, 0.5, 0.06, 0.06);
    m.box(0.55, 0.7, 0.4, 0.5, 0.06, 0.06);
  },
  parasol(m) {
    m.col(0xb0a288).cyl(0, 0, 0, 0.07, 0.06, 2.6, 5);
    for (let k = 0; k < 8; k++) {
      m.col(k % 2 ? 0xf4f2ea : 0xd6001c);
      const a0 = (k / 8) * TAU, a1 = ((k + 1) / 8) * TAU;
      m.tri(0, 3.1, 0, Math.cos(a0) * 2.1, 2.35, Math.sin(a0) * 2.1, Math.cos(a1) * 2.1, 2.35, Math.sin(a1) * 2.1);
    }
  },
  pontoon(m) {
    // extra.hz = demi-longueur (40 m par defaut) ; la longueur est mise a l'echelle en Z
    m.col(0xffffff);
    m.box(0, 0.5, 0, 2.2, 0.55, 1.0, 0, 2, 2);
    m.col(0xe6e6e2);
    for (let k = -1; k <= 1; k += 2) m.box(k * 2.25, 1.15, 0, 0.06, 0.14, 1.0);
  },
  rampart(m) {
    // le collider est un bloc de 8.8 x 3 x 2 aligne sur l'axe local X : on colle dessus
    m.col(0xffffff).box(0, 1.5, 0, 4.4, 1.5, 1.0, 0, 4, 3);
    m.col(0xefe9d8);
    for (let k = -3; k <= 3; k += 2) m.box(k * 1.25, 3.3, 0, 0.6, 0.35, 1.0);
  },
  ramp(m) {
    m.col(0xffffff).box(0, -1.2, 0, 7, 1.4, 3.2, 0, 5, 3);
    m.col(0xd8d2c0);
    m.box(0, 0.3, 3.05, 7, 0.35, 0.16);
    m.box(0, 0.3, -3.05, 7, 0.35, 0.16);
  },
  fountain(m) {
    m.col(C.pierre);
    m.cyl(0, 0, 0, 4.2, 4.2, 0.85, 12, false);
    m.cyl(0, 0.85, 0, 4.2, 3.7, 0.25, 12, false);
    m.col(0x2fb3d9).disc(0, 0.78, 0, 3.7, 12, true);
    m.col(C.pierre);
    m.cyl(0, 0.78, 0, 0.6, 0.4, 2.0, 8);
    m.disc(0, 2.8, 0, 1.5, 10, true);
  },
  tyrewall(m) {
    // 4 x 2 pneus dans l'emprise du collider (4.8 x 1.4 x 1.1)
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < 4; k++) {
        m.col(k % 2 ? 0x1b1c20 : 0x24262c);
        m.cyl(-1.8 + k * 1.2, r * 0.55, (r % 2 ? 0.18 : -0.18), 0.58, 0.58, 0.52, 8, true, false);
      }
    }
    m.col(0xd6001c);
    m.box(0, 1.18, 0, 2.4, 0.06, 0.7);
  },
  banner(m) {
    // les poteaux echantillonnent la bande blanche de la texture, le panneau la prend entiere
    m.col(C.metalSombre).lockUv(0.5, 0.06);
    m.box(-2.0, 1.1, 0, 0.08, 1.1, 0.08);
    m.box(2.0, 1.1, 0, 0.08, 1.1, 0.08);
    m.col(0xffffff).lockUv(-1, 0);
    m.quad(-2.1, 1.3, 0.06, 2.1, 1.3, 0.06, 2.1, 2.5, 0.06, -2.1, 2.5, 0.06);
    m.quad(2.1, 1.3, -0.06, -2.1, 1.3, -0.06, -2.1, 2.5, -0.06, 2.1, 2.5, -0.06);
  },
};

/** Position du sommet du tronc de palmier (meme courbure que les segments). */
function bendTip(bend, n) {
  return bend * ((n - 1) / n) * ((n - 1) / n) * 5;
}

function buildProps(map, quality, group) {
  const byKind = new Map();
  for (const p of map.props) {
    if (!PROP_BUILDERS[p.kind]) continue;
    if (quality === 'low' && PROP_SMALL.has(p.kind)) continue;
    let list = byKind.get(p.kind);
    if (!list) { list = []; byKind.set(p.kind, list); }
    list.push(p);
  }
  for (const [kind, list] of byKind) {
    const geo = geoOf('prop:' + kind, () => {
      const m = new Mesher();
      PROP_BUILDERS[kind](m);
      return m.geometry();
    });
    const mat = kind === 'banner' ? mBanner() : PROP_DOUBLE.has(kind) ? mPlainDS() : mPlain();
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    inst.name = 'props:' + kind;
    const tinted = PROP_TINTED.has(kind);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const sc = p.scale || 1;
      _e.set(0, p.yaw || 0, 0); _q.setFromEuler(_e);
      const sz = kind === 'pontoon' && p.extra && p.extra.hz ? p.extra.hz : sc;
      _m4.compose(_v.set(p.x, p.y, p.z), _q, _s.set(sc, sc, kind === 'pontoon' ? sz : sc));
      inst.setMatrixAt(i, _m4);
      if (tinted) {
        _tmpCol.setHex(p.color ?? 0xbfb8a8);
        inst.setColorAt(i, _tmpCol);
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = quality === 'high' && !PROP_SMALL.has(kind);
    inst.receiveShadow = quality === 'high';
    group.add(inst);
  }
}

// ---------------------------------------------------------------------------
// 8. Yachts (le rendu epouse les colliders : coque hy 1.1 centree a y 0.9)
// ---------------------------------------------------------------------------
function buildYachts(map) {
  if (!map.yachts.length) return null;
  const m = new Mesher();
  for (const y of map.yachts) {
    const ca = Math.cos(y.yaw), sa = Math.sin(y.yaw);
    const wx = (lx, lz) => y.x + lx * ca + lz * sa;
    const wz = (lx, lz) => y.z - lx * sa + lz * ca;
    const L = y.len / 2, B = y.beam / 2;
    const keel = y.y - 0.2, deck = y.y + 2.0;
    // sections de coque : poupe large, etrave effilee
    const sec = [
      [-L, B * 0.86], [-L * 0.45, B], [L * 0.25, B], [L * 0.72, B * 0.62], [L, B * 0.1],
    ];
    m.col(y.color ?? 0xffffff);
    for (let k = 0; k < sec.length - 1; k++) {
      const [z0, w0] = sec[k], [z1, w1] = sec[k + 1];
      // flanc tribord puis babord
      m.quad(wx(w1, z1), keel, wz(w1, z1), wx(w0, z0), keel, wz(w0, z0), wx(w0, z0), deck, wz(w0, z0), wx(w1, z1), deck, wz(w1, z1));
      m.quad(wx(-w0, z0), keel, wz(-w0, z0), wx(-w1, z1), keel, wz(-w1, z1), wx(-w1, z1), deck, wz(-w1, z1), wx(-w0, z0), deck, wz(-w0, z0));
      // fond
      m.quad(wx(w0, z0), keel, wz(w0, z0), wx(w1, z1), keel, wz(w1, z1), wx(-w1, z1), keel, wz(-w1, z1), wx(-w0, z0), keel, wz(-w0, z0));
    }
    // tableau arriere
    const b0 = sec[0][1];
    m.quad(wx(b0, -L), keel, wz(b0, -L), wx(-b0, -L), keel, wz(-b0, -L), wx(-b0, -L), deck, wz(-b0, -L), wx(b0, -L), deck, wz(b0, -L));
    // pont teck
    m.col(0xd9c8a6);
    for (let k = 0; k < sec.length - 1; k++) {
      const [z0, w0] = sec[k], [z1, w1] = sec[k + 1];
      m.quad(wx(-w1, z1), deck, wz(-w1, z1), wx(w1, z1), deck, wz(w1, z1), wx(w0, z0), deck, wz(w0, z0), wx(-w0, z0), deck, wz(-w0, z0));
    }
    // superstructure (meme centre que le collider)
    const off = -y.len * 0.12;
    const sh = y.decks * 1.4;
    const sx = wx(0, off), sz = wz(0, off);
    m.col(0xf6f6f2);
    m.box(sx, deck + sh, sz, Math.max(0.6, B - 0.8), sh, y.len * 0.28, y.yaw);
    m.col(0x2c3a44);
    m.box(sx, deck + sh * 1.1, sz, Math.max(0.6, B - 0.72), sh * 0.34, y.len * 0.281, y.yaw);
    if (y.decks > 1) {
      m.col(0xf6f6f2);
      m.box(sx, deck + sh * 2 + 0.7, sz, Math.max(0.5, B - 1.5), 0.7, y.len * 0.17, y.yaw);
    }
    m.col(C.metal);
    m.box(sx, deck + sh * 2 + 2.2, sz, 0.07, 1.5, 0.07, y.yaw);
  }
  const g = m.geometry();
  const mesh = new THREE.Mesh(g, mPlainFlat());
  mesh.name = 'yachts';
  return { mesh, own: [g] };
}

// ---------------------------------------------------------------------------
// 9. Piscines et helipads
// ---------------------------------------------------------------------------
function buildPools(map) {
  if (!map.pools.length) return null;
  const stone = new Mesher();
  const water = new Mesher();
  for (const p of map.pools) {
    const hx = p.w / 2, hz = p.d / 2, cw = 1.6;
    const ca = Math.cos(p.yaw), sa = Math.sin(p.yaw);
    const wx = (lx, lz) => p.x + lx * ca + lz * sa;
    const wz = (lx, lz) => p.z - lx * sa + lz * ca;
    // margelle : deux long-pans (les colliders) + les deux petits cotes
    stone.col(0xe8e2d2);
    for (const sz of [-1, 1]) stone.box(wx(0, sz * (hz + cw * 0.5)), p.y + 0.5, wz(0, sz * (hz + cw * 0.5)), hx + cw, 0.5, cw * 0.5, p.yaw, 3, 3);
    for (const sx of [-1, 1]) stone.box(wx(sx * (hx + cw * 0.5), 0), p.y + 0.5, wz(sx * (hx + cw * 0.5), 0), cw * 0.5, 0.5, hz, p.yaw, 3, 3);
    // parois interieures et fond du bassin (normales tournees vers l'interieur)
    stone.col(0xdfe9ee);
    const d = p.depth;
    const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
    for (let k = 0; k < 4; k++) {
      const c0 = corners[k], c1 = corners[(k + 1) % 4];
      stone.quad(
        wx(c0[0], c0[1]), p.y - d, wz(c0[0], c0[1]),
        wx(c1[0], c1[1]), p.y - d, wz(c1[0], c1[1]),
        wx(c1[0], c1[1]), p.y, wz(c1[0], c1[1]),
        wx(c0[0], c0[1]), p.y, wz(c0[0], c0[1]),
      );
    }
    stone.col(0x9fd8e8);
    stone.quad(
      wx(-hx, hz), p.y - d, wz(-hx, hz), wx(hx, hz), p.y - d, wz(hx, hz),
      wx(hx, -hz), p.y - d, wz(hx, -hz), wx(-hx, -hz), p.y - d, wz(-hx, -hz),
    );
    water.col(C.eauPiscine);
    water.quad(
      wx(-hx, hz), p.y - 0.12, wz(-hx, hz), wx(hx, hz), p.y - 0.12, wz(hx, hz),
      wx(hx, -hz), p.y - 0.12, wz(hx, -hz), wx(-hx, -hz), p.y - 0.12, wz(-hx, -hz),
    );
  }
  const group = new THREE.Group();
  group.name = 'piscines';
  const gs = stone.geometry();
  group.add(new THREE.Mesh(gs, mPlainFlat()));
  const gw = water.geometry();
  const wm = matOf('eauPiscine', () => new THREE.MeshLambertMaterial({
    vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false,
  }));
  const wmesh = new THREE.Mesh(gw, wm);
  wmesh.renderOrder = 1;
  group.add(wmesh);
  return { group, own: [gs, gw] };
}

function buildHelipads(map, group) {
  if (!map.helipads.length) return;
  const geo = geoOf('helipadDisc', () => new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2));
  const mat = mDecal('helipad', { color: 0xffffff, map: helipadTex() });
  const inst = new THREE.InstancedMesh(geo, mat, map.helipads.length);
  for (let i = 0; i < map.helipads.length; i++) {
    const h = map.helipads[i];
    _q.identity();
    _m4.compose(_v.set(h.x, h.y + 0.06, h.z), _q, _s.set(h.r, 1, h.r));
    inst.setMatrixAt(i, _m4);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.name = 'helipads';
  group.add(inst);
}

// ---------------------------------------------------------------------------
// 10. Ciel, lumieres, nuages
// ---------------------------------------------------------------------------
const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunCol;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y * 1.15 + 0.06, -1.0, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.62));
  col = mix(col, uHorizon * 0.86, clamp(-h * 2.2, 0.0, 1.0));
  float sun = pow(max(dot(d, normalize(uSunDir)), 0.0), 220.0);
  float glow = pow(max(dot(d, normalize(uSunDir)), 0.0), 7.0);
  col += uSunCol * (sun * 1.6 + glow * 0.22);
  gl_FragColor = vec4(col, 1.0);
}`;

// Palette du ciel : aube / midi / crepuscule
const SKY_KEYS = [
  { top: 0x2d4a7c, hor: 0xf3ab7c, sun: 0xffc48f, int: 0.75, amb: 0.42, fog: 0xe7b795, deep: 0x14536f, shal: 0x2fa8bf },
  { top: 0x1f6fd0, hor: 0xa9daf0, sun: 0xfff4dc, int: 1.35, amb: 0.66, fog: 0xc2e2f2, deep: 0x0d5f80, shal: 0x3fd0d8 },
  { top: 0x1d3a70, hor: 0xef8b5c, sun: 0xff9a5c, int: 0.62, amb: 0.38, fog: 0xdda07f, deep: 0x123f5c, shal: 0x2a94b0 },
];

function buildSky() {
  // Rayon volontairement modeste : la sphere est recentree sur la camera et
  // dessinee sans test de profondeur, donc elle ne depend pas du plan lointain.
  const geo = new THREE.SphereGeometry(600, 24, 16);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(SKY_KEYS[1].top) },
      uHorizon: { value: new THREE.Color(SKY_KEYS[1].hor) },
      uSunCol: { value: new THREE.Color(SKY_KEYS[1].sun) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.5) },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ciel';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

function buildClouds(quality) {
  const n = quality === 'low' ? 10 : 22;
  const geo = geoOf('cloudQuad', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const tex = cloudTex();
  const mat = matOf('nuage', () => new THREE.MeshBasicMaterial({
    color: 0xffffff, map: tex, transparent: true, opacity: 0.75,
    depthWrite: false, fog: false,
  }));
  const inst = new THREE.InstancedMesh(geo, mat, n);
  inst.name = 'nuages';
  inst.frustumCulled = false;
  inst.renderOrder = -1;
  return inst;
}

// ---------------------------------------------------------------------------
// Le monde
// ---------------------------------------------------------------------------
class World {
  constructor(scene, opts) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    console.time('[world] construction');
    this.scene = scene;
    this.quality = opts.quality === 'low' || opts.quality === 'high' ? opts.quality : 'medium';
    this.renderer = opts.renderer || null;
    _aniso = this.renderer && this.renderer.capabilities
      ? Math.min(4, this.renderer.capabilities.getMaxAnisotropy())
      : 1;

    this.group = new THREE.Group();
    this.group.name = 'monde';
    this._own = [];        // geometries et materiaux propres a ce monde
    this._time = 0;
    this._tod = 0.42;

    const map = buildMap();
    this.map = map;

    // --- terrain
    const step = this.quality === 'low' ? TERRAIN_STEP_LOW : TERRAIN_STEP;
    const t = buildTerrain(step);
    this._heights = t.heights; this._hn = t.n; this._hstep = t.step;
    this.terrain = new THREE.Mesh(t.geo, mTerrain());
    this.terrain.name = 'terrain';
    this.terrain.receiveShadow = this.quality === 'high';
    this._own.push(t.geo);
    this.group.add(this.terrain);

    // --- mer
    this.sea = buildSea(this.quality);
    this._own.push(this.sea.geometry, this.sea.material);
    this.group.add(this.sea);

    // --- circuit, rails, tunnel
    const track = buildTrack(map);
    this._own.push(...track.own);
    this.group.add(track.group);
    buildRails(map, this.group);
    const tun = buildTunnel(map);
    if (tun) { this._own.push(...tun.own); this.group.add(tun.group); }

    // --- batiments, props, yachts, piscines, helipads
    const bld = buildBuildings(map, this.quality);
    this._own.push(...bld.own);
    this.group.add(bld.group);
    buildProps(map, this.quality, this.group);
    const yachts = buildYachts(map);
    if (yachts) { this._own.push(...yachts.own); this.group.add(yachts.mesh); }
    const pools = buildPools(map);
    if (pools) { this._own.push(...pools.own); this.group.add(pools.group); }
    buildHelipads(map, this.group);

    // --- ciel, nuages
    this.sky = buildSky();
    this._own.push(this.sky.geometry, this.sky.material);
    this.group.add(this.sky);
    this.clouds = buildClouds(this.quality);
    this._cloudSeed = [];
    for (let i = 0; i < this.clouds.count; i++) {
      this._cloudSeed.push({
        x: (Math.random() - 0.5) * 2400,
        z: (Math.random() - 0.5) * 2400,
        y: 190 + Math.random() * 130,
        s: 140 + Math.random() * 220,
        v: 1.6 + Math.random() * 2.4,
      });
    }
    this.group.add(this.clouds);

    // --- lumieres
    this.sun = new THREE.DirectionalLight(0xfff4dc, 1.35);
    this.sun.name = 'soleil';
    this.sun.position.set(300, 420, 220);
    this.sun.target.position.set(0, 0, 0);
    if (this.quality === 'high') {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      const c = this.sun.shadow.camera;
      c.left = -95; c.right = 95; c.top = 95; c.bottom = -95;
      c.near = 20; c.far = 900;
      c.updateProjectionMatrix();
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.08;
      if (this.renderer) {
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      }
    } else if (this.renderer) {
      this.renderer.shadowMap.enabled = false;
    }
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfe0f2, 0x6f7a4a, 0.66);
    scene.add(this.hemi);

    scene.fog = new THREE.Fog(SKY_KEYS[1].fog,
      this.quality === 'low' ? 260 : 340,
      this.quality === 'low' ? 1050 : 1450);
    this._fog = scene.fog;

    scene.add(this.group);
    this.setTimeOfDay(this._tod);
    this.update(0, null, null); // place les nuages avant la premiere image
    console.timeEnd('[world] construction');
    this.buildMs = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
  }

  /** t01 : 0 = aube, 0.5 = plein midi, 1 = crepuscule. */
  setTimeOfDay(t01) {
    const t = clamp01(t01);
    this._tod = t;
    const k = t < 0.5 ? 0 : 1;
    const f = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const a = SKY_KEYS[k], b = SKY_KEYS[k + 1];

    const el = lerp(4, 68, Math.sin(t * Math.PI)) * (Math.PI / 180);
    const az = lerp(1.9, -1.2, t);
    _v.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
    this._sunDir = this._sunDir || new THREE.Vector3();
    this._sunDir.copy(_v);

    const su = this.sky.material.uniforms;
    su.uTop.value.copy(_colA.setHex(a.top)).lerp(_colB.setHex(b.top), f);
    su.uHorizon.value.copy(_colA.setHex(a.hor)).lerp(_colB.setHex(b.hor), f);
    su.uSunCol.value.copy(_colA.setHex(a.sun)).lerp(_colB.setHex(b.sun), f);
    su.uSunDir.value.copy(_v);

    const wu = this.sea.material.uniforms;
    wu.uDeep.value.copy(_colA.setHex(a.deep)).lerp(_colB.setHex(b.deep), f);
    wu.uShallow.value.copy(_colA.setHex(a.shal)).lerp(_colB.setHex(b.shal), f);
    wu.uSky.value.copy(su.uHorizon.value);
    wu.uSunCol.value.copy(su.uSunCol.value);
    wu.uSunDir.value.copy(_v);

    // hors qualite « high » la lumiere ne bouge plus dans update() : on la cale ici
    this.sun.position.copy(_v).multiplyScalar(420);
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.copy(su.uSunCol.value);
    this.sun.intensity = lerp(a.int, b.int, f);
    this.hemi.intensity = lerp(a.amb, b.amb, f);
    this.hemi.color.copy(su.uHorizon.value);
    if (this._fog) this._fog.color.copy(_colA.setHex(a.fog)).lerp(_colB.setHex(b.fog), f);
  }

  /** Altitude interpolee depuis la grille de terrain (bien plus rapide que terrainHeight). */
  heightAt(x, z) {
    const n = this._hn, st = this._hstep;
    const fx = clamp((x + WORLD_HALF) / st, 0, n - 1.001);
    const fz = clamp((z + WORLD_HALF) / st, 0, n - 1.001);
    const ix = fx | 0, iz = fz | 0;
    const tx = fx - ix, tz = fz - iz;
    const h = this._heights;
    const k = iz * n + ix;
    return lerp(lerp(h[k], h[k + 1], tx), lerp(h[k + n], h[k + n + 1], tx), tz);
  }

  update(dt, camera, playerPos) {
    this._time += dt;
    this.sea.material.uniforms.uTime.value = this._time;

    if (camera) {
      this.sky.position.copy(camera.position);
      // la mer suit la camera, calee sur la maille pour ne pas scintiller
      const cell = this.sea.userData.cell;
      this.sea.position.x = Math.round(camera.position.x / cell) * cell;
      this.sea.position.z = Math.round(camera.position.z / cell) * cell;
    }

    // nuages : derive lente, enroules en tore autour de la camera (jamais de bord visible)
    const cx = camera ? camera.position.x : 0;
    const cz = camera ? camera.position.z : 0;
    const W = 2600, H = W * 0.5;
    for (let i = 0; i < this._cloudSeed.length; i++) {
      const c = this._cloudSeed[i];
      c.x += c.v * dt;
      const x = cx + (((c.x - cx + H) % W) + W) % W - H;
      const z = cz + (((c.z - cz + H) % W) + W) % W - H;
      _q.identity();
      _m4.compose(_v.set(x, c.y, z), _q, _s.set(c.s, 1, c.s * 0.6));
      this.clouds.setMatrixAt(i, _m4);
    }
    this.clouds.instanceMatrix.needsUpdate = true;

    // la carte d'ombre suit le joueur
    if (this.sun.castShadow && playerPos) {
      _v2.copy(this._sunDir).multiplyScalar(320);
      this.sun.position.set(playerPos.x + _v2.x, playerPos.y + _v2.y, playerPos.z + _v2.z);
      this.sun.target.position.set(playerPos.x, playerPos.y, playerPos.z);
      this.sun.target.updateMatrixWorld();
      this.sun.updateMatrixWorld();
    }
  }

  dispose() {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    this.group.clear();
    if (this.sun) {
      if (this.sun.shadow && this.sun.shadow.map) this.sun.shadow.map.dispose();
      this.scene.remove(this.sun, this.sun.target);
    }
    if (this.hemi) this.scene.remove(this.hemi);
    if (this.scene.fog === this._fog) this.scene.fog = null;
    for (const r of this._own) if (r && r.dispose) r.dispose();
    this._own.length = 0;
    for (const g of _geos.values()) if (g) g.dispose();
    for (const m of _mats.values()) if (m) m.dispose();
    for (const t of _texs.values()) if (t) t.dispose();
    _geos.clear(); _mats.clear(); _texs.clear();
    this._heights = null;
  }
}

/**
 * Construit tout le decor statique et l'ajoute a la scene.
 * opts = { quality: 'low'|'medium'|'high', renderer }
 */
export function buildWorld(scene, opts) {
  return new World(scene, opts || {});
}

export default { buildWorld, TERRAIN_STEP };
