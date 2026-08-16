// KoRoyale — modeles 3D procedureaux des vehicules.
// Monoplace de Grand Prix, buggy des alpages, scooter du port, vedette.
// Tout est genere a la main : primitives, lofts maison, CanvasTexture. Aucun asset externe.
//
// Regles de perf :
//  - une geometrie et un materiau par role, mutualises dans des caches module ;
//  - un prototype de Group par type, clone pour chaque vehicule (geos/mats partages) ;
//  - la carrosserie n'est clonee que si une couleur propre est demandee (ou en cas de degats) ;
//  - aucune allocation dans update() : tous les temporaires sont au niveau module.
//
// Repere local : origine au centre du vehicule au niveau du sol, AVANT vers +Z,
// roues tangentes a y = 0. Budget : moins de 600 triangles par vehicule.

import * as THREE from 'three';
import { VEHICLE_TYPES } from '../../../shared/constants.js';
import { clamp, clamp01, damp, smoothstep } from '../../../shared/math.js';

// ---------------------------------------------------------------------------
// Palette Cote d'Azur
// ---------------------------------------------------------------------------
const C = {
  pneu: 0x1b1c20,
  jante: 0xc6ccd4,
  chrome: 0xa9b2bd,
  metal: 0x6d747f,
  sombre: 0x22242a,
  siege: 0x3b302a,
  verre: 0x9ed7e8,
  feu: 0xff3a1e,
  phare: 0xfff1bd,
  creme: 0xf2e8d5,
  ecume: 0xffffff,
  bidon: 0x4a5a3a,
  teck: 0x9a7448,
  coussin: 0xd8cab0,
};

// Couleurs d'equipe (liseres seulement : on ne repeint pas toute la voiture)
const TEAM_COLORS = [0x2f7bd6, 0xd6483f, 0x2fa06a, 0xd9a127, 0x8b4fd0, 0xe06a2f];

// Roulis en virage, par type (radians a pleine vitesse)
const ROLL_AMOUNT = { f1: 0.045, buggy: 0.13, scooter: -0.45, boat: 0.16 };

// Point d'echappement (fumee de degats), par type
const SMOKE_AT = {
  f1: [0, 0.5, -2.45],
  buggy: [0.5, 0.75, -2.2],
  scooter: [0.18, 0.36, -0.95],
  boat: [0, 0.7, -3.0],
};

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Caches module
// ---------------------------------------------------------------------------
const _geos = new Map();   // cle -> BufferGeometry
const _mats = new Map();   // cle -> Material
const _texs = new Map();   // cle -> Texture
const _protos = new Map(); // type -> Group prototype

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

// Temporaires (jamais d'allocation dans les boucles d'update)
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m4 = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _col = new THREE.Color();
const _col2 = new THREE.Color();

// ---------------------------------------------------------------------------
// Fabriques de geometrie
// ---------------------------------------------------------------------------

/** Descripteur de boite compact pour boxSoup(). */
function B(x, y, z, hx, hy, hz, rx, ry, rz) {
  return { x, y, z, hx, hy, hz, rx: rx || 0, ry: ry || 0, rz: rz || 0 };
}

/**
 * Fusionne une liste de boites en une seule BufferGeometry non indexee
 * (facettes plates). 12 triangles par boite, un seul draw call.
 */
function boxSoup(list) {
  let total = 0;
  const parts = [];
  for (const b of list) {
    const g = new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2).toNonIndexed();
    _e.set(b.rx, b.ry, b.rz, 'XYZ');
    _q.setFromEuler(_e);
    _m4.compose(_v.set(b.x, b.y, b.z), _q, _one);
    g.applyMatrix4(_m4);
    const arr = g.getAttribute('position').array;
    parts.push(arr);
    total += arr.length;
    g.dispose();
  }
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Loft : une suite de sections trapezoidales le long de Z, reliees en tube ferme.
 * Section = { z, y0, y1, w0, w1 } (bas/haut, demi-largeur bas/haut).
 * 8 triangles par intervalle + 2 par bouchon.
 */
function loft(sections, capStart = true, capEnd = true) {
  const s = sections.slice().sort((a, b) => a.z - b.z);
  const n = s.length;
  const ring = new Float32Array(n * 12); // 4 coins * 3 composantes
  for (let i = 0; i < n; i++) {
    const k = i * 12, c = s[i];
    ring[k + 0] = -c.w0; ring[k + 1] = c.y0; ring[k + 2] = c.z;
    ring[k + 3] = c.w0;  ring[k + 4] = c.y0; ring[k + 5] = c.z;
    ring[k + 6] = c.w1;  ring[k + 7] = c.y1; ring[k + 8] = c.z;
    ring[k + 9] = -c.w1; ring[k + 10] = c.y1; ring[k + 11] = c.z;
  }
  const tris = (n - 1) * 8 + (capStart ? 2 : 0) + (capEnd ? 2 : 0);
  const pos = new Float32Array(tris * 9);
  let o = 0;
  const emit = (r, c) => {
    const k = r * 12 + c * 3;
    pos[o++] = ring[k]; pos[o++] = ring[k + 1]; pos[o++] = ring[k + 2];
  };
  for (let i = 0; i < n - 1; i++) {
    for (let c = 0; c < 4; c++) {
      const d = (c + 1) & 3;
      emit(i, c); emit(i, d); emit(i + 1, d);
      emit(i, c); emit(i + 1, d); emit(i + 1, c);
    }
  }
  if (capStart) { emit(0, 0); emit(0, 2); emit(0, 1); emit(0, 0); emit(0, 3); emit(0, 2); }
  if (capEnd) {
    const l = n - 1;
    emit(l, 0); emit(l, 1); emit(l, 2); emit(l, 0); emit(l, 2); emit(l, 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Roue : cylindre d'axe X. `tread` > 0 creuse un pneu crante (rayon alterne).
 * 4 * seg triangles.
 */
function wheelGeo(radius, width, seg, tread = 0) {
  const hw = width * 0.5;
  const pos = new Float32Array(seg * 4 * 9);
  let o = 0;
  const emit = (x, y, z) => { pos[o++] = x; pos[o++] = y; pos[o++] = z; };
  const ry = new Float32Array(seg), rz = new Float32Array(seg);
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * TAU;
    const r = radius * (k & 1 ? 1 - tread : 1);
    ry[k] = Math.cos(a) * r;
    rz[k] = Math.sin(a) * r;
  }
  for (let k = 0; k < seg; k++) {
    const j = (k + 1) % seg;
    // flanc
    emit(-hw, ry[k], rz[k]); emit(-hw, ry[j], rz[j]); emit(hw, ry[j], rz[j]);
    emit(-hw, ry[k], rz[k]); emit(hw, ry[j], rz[j]); emit(hw, ry[k], rz[k]);
    // bouchon gauche (-X) puis droit (+X)
    emit(-hw, 0, 0); emit(-hw, ry[j], rz[j]); emit(-hw, ry[k], rz[k]);
    emit(hw, 0, 0); emit(hw, ry[k], rz[k]); emit(hw, ry[j], rz[j]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Disque de jante, face tournee vers +X. */
function hubGeo(radius, seg) {
  const g = new THREE.CircleGeometry(radius, seg);
  g.rotateY(Math.PI / 2);
  return g;
}

// ---------------------------------------------------------------------------
// Textures paresseuses (jamais au chargement du module : Node n'a pas de DOM)
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

/** Numero peint sur la monoplace (pastille blanche, chiffre noir). */
function numberTex(n) {
  const key = 'num:' + n;
  if (_texs.has(key)) return _texs.get(key);
  const g = ctx2d(64, 64);
  if (!g) { _texs.set(key, null); return null; }
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = '#f6f2e8';
  g.beginPath(); g.arc(32, 32, 30, 0, TAU); g.fill();
  g.fillStyle = '#17181c';
  g.font = 'bold 40px Impact, Haettenschweiler, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 32, 35);
  return finishTex(g, key);
}

/** Calandre du buggy : barres verticales claires sur fond sombre. */
function grilleTex() {
  const key = 'grille';
  if (_texs.has(key)) return _texs.get(key);
  const g = ctx2d(32, 32);
  if (!g) { _texs.set(key, null); return null; }
  g.fillStyle = '#15171a';
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = '#767d87';
  for (let i = 2; i < 32; i += 6) g.fillRect(i, 3, 3, 26);
  return finishTex(g, key);
}

/** Bouffee de fumee : degrade radial doux. */
function smokeTex() {
  const key = 'smoke';
  if (_texs.has(key)) return _texs.get(key);
  const g = ctx2d(64, 64);
  if (!g) { _texs.set(key, null); return null; }
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.45, 'rgba(210,210,214,0.5)');
  grd.addColorStop(1, 'rgba(180,180,186,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return finishTex(g, key);
}

/**
 * Moustache d'ecume : coin blanc, dense et fin a la proue (v = 0),
 * large et estompe vers l'arriere (v = 1).
 */
function foamTex() {
  const key = 'foam';
  if (_texs.has(key)) return _texs.get(key);
  const g = ctx2d(64, 64);
  if (!g) { _texs.set(key, null); return null; }
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 64; i++) {
    const t = i / 63;               // 0 = arriere du sillage, 1 = proue
    const w = 4 + 58 * (1 - t);
    g.globalAlpha = 0.12 + t * 0.88;
    g.fillRect(32 - w * 0.5, i, w, 1);
  }
  g.globalAlpha = 1;
  return finishTex(g, key);
}

// ---------------------------------------------------------------------------
// Materiaux mutualises
// ---------------------------------------------------------------------------
const mPaint = (c) => matOf('paint:' + c, () => new THREE.MeshPhongMaterial({
  color: c, flatShading: true, shininess: 55, specular: 0x2a2a2e,
}));
const mFlat = (c) => matOf('flat:' + c, () => new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
const mGlow = (c) => matOf('glow:' + c, () => new THREE.MeshBasicMaterial({ color: c, fog: true }));
const mGlass = () => matOf('glass', () => new THREE.MeshPhongMaterial({
  color: C.verre, transparent: true, opacity: 0.34, shininess: 90,
  side: THREE.DoubleSide, depthWrite: false,
}));
const mDecal = (tex) => matOf('decal:' + (tex ? tex.uuid : 'plain'), () => new THREE.MeshBasicMaterial({
  map: tex || null, color: 0xffffff, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
}));
const mGrille = () => {
  const t = grilleTex();
  return matOf('grille:' + (t ? t.uuid : 'plain'), () => new THREE.MeshLambertMaterial({
    map: t || null, color: t ? 0xffffff : C.sombre,
  }));
};

// ---------------------------------------------------------------------------
// Petits assembleurs
// ---------------------------------------------------------------------------
function put(parent, geo, mat, role, paint) {
  const m = new THREE.Mesh(geo, mat);
  if (role) m.userData.role = role;
  if (paint) m.userData.paint = true;
  m.castShadow = false;
  m.receiveShadow = false;
  parent.add(m);
  return m;
}

/** Plan vertical (face +Z par defaut) utilise pour les feux et les decalcos. */
function planeGeo(w, h) {
  return geoOf('plane:' + w + 'x' + h, () => new THREE.PlaneGeometry(w, h));
}

/**
 * Train de roues : susp (Group) > steer (Group) > spin (Group : pneu + jante).
 * `track` a 0 signifie une seule roue par essieu (scooter).
 */
function addWheels(root, id, cfg, widthFront, widthRear, seg, tread) {
  const g = new THREE.Group();
  g.name = 'wheels';
  root.add(g);
  const gf = geoOf(`${id}.tireF`, () => wheelGeo(cfg.radius, widthFront, seg, tread));
  const gr = geoOf(`${id}.tireR`, () => wheelGeo(cfg.radius, widthRear, seg, tread));
  const gh = geoOf(`${id}.hub`, () => hubGeo(cfg.radius * 0.46, seg));
  const mTire = mFlat(C.pneu);
  const mHub = mFlat(C.jante);
  let idx = 0;
  for (let axle = 0; axle < 2; axle++) {
    const front = axle === 0;
    const z = front ? cfg.front : cfg.rear;
    const single = Math.abs(cfg.track) < 0.05;
    for (let sideI = 0; sideI < (single ? 1 : 2); sideI++) {
      const sx = single ? 0 : (sideI === 0 ? -1 : 1);
      const susp = new THREE.Group();
      susp.position.set(sx * cfg.track, cfg.radius, z);
      susp.userData.role = 'wheel';
      susp.userData.front = front;
      susp.userData.idx = idx++;
      const steer = new THREE.Group();
      const spin = new THREE.Group();
      const tire = new THREE.Mesh(front ? gf : gr, mTire);
      spin.add(tire);
      const hub = new THREE.Mesh(gh, mHub);
      const hw = (front ? widthFront : widthRear) * 0.5 + 0.012;
      hub.position.x = single ? hw : sx * hw;
      if (single || sx > 0) hub.rotation.y = 0; else hub.rotation.y = Math.PI;
      spin.add(hub);
      steer.add(spin);
      susp.add(steer);
      g.add(susp);
    }
  }
  return g;
}

function addSeats(chassis, type) {
  type.seatOffsets.forEach((o, i) => {
    const a = new THREE.Object3D();
    a.position.set(o[0], o[1], o[2]);
    a.userData.role = 'seat';
    a.userData.idx = i;
    chassis.add(a);
  });
}

// ---------------------------------------------------------------------------
// Prototype : monoplace de Grand Prix (livree rouge Monaco)
// ---------------------------------------------------------------------------
function buildF1() {
  const T = VEHICLE_TYPES.f1;
  const root = new THREE.Group();
  const ch = new THREE.Group();
  ch.name = 'chassis';
  root.add(ch);

  // Monocoque : museau bas et effile, ventre plat, capot moteur pince.
  const hull = put(ch, geoOf('f1.hull', () => loft([
    { z: 2.55, y0: 0.13, y1: 0.25, w0: 0.05, w1: 0.07 },
    { z: 1.90, y0: 0.11, y1: 0.40, w0: 0.10, w1: 0.13 },
    { z: 1.10, y0: 0.09, y1: 0.52, w0: 0.24, w1: 0.26 },
    { z: 0.25, y0: 0.07, y1: 0.62, w0: 0.34, w1: 0.30 },
    { z: -0.35, y0: 0.07, y1: 0.72, w0: 0.36, w1: 0.28 },
    { z: -1.20, y0: 0.09, y1: 0.60, w0: 0.32, w1: 0.20 },
    { z: -2.00, y0: 0.13, y1: 0.44, w0: 0.20, w1: 0.12 },
    { z: -2.45, y0: 0.17, y1: 0.36, w0: 0.12, w1: 0.08 },
  ])), mPaint(T.color), 'hull', true);
  hull.name = 'hull';

  // Airbox au dessus du pilote + derive arriere.
  put(ch, geoOf('f1.airbox', () => loft([
    { z: -0.55, y0: 0.70, y1: 1.02, w0: 0.16, w1: 0.11 },
    { z: -1.05, y0: 0.66, y1: 0.92, w0: 0.14, w1: 0.09 },
    { z: -1.70, y0: 0.58, y1: 0.72, w0: 0.10, w1: 0.05 },
  ], false, true)), mPaint(T.color), null, true);

  // Bouche de la prise d'air.
  const intake = put(ch, planeGeo(0.2, 0.2), mFlat(C.sombre));
  intake.position.set(0, 0.86, -0.53);
  intake.scale.set(1, 1.4, 1);

  // Pontons lateraux (livree) puis bras de suspension et baignoire (sombre).
  put(ch, geoOf('f1.pods', () => boxSoup([
    B(-0.58, 0.32, -0.30, 0.20, 0.20, 0.72),
    B(0.58, 0.32, -0.30, 0.20, 0.20, 0.72),
  ])), mPaint(T.color), null, true);
  put(ch, geoOf('f1.susp', () => boxSoup([
    B(0, 0.66, -0.10, 0.24, 0.05, 0.46),          // baignoire du pilote
    B(0, 0.30, 1.75, 0.30, 0.02, 0.05),           // triangulation avant
    B(-0.60, 0.30, 1.75, 0.31, 0.02, 0.05, 0, 0, 0.12),
    B(0.60, 0.30, 1.75, 0.31, 0.02, 0.05, 0, 0, -0.12),
    B(-0.60, 0.34, -1.70, 0.36, 0.02, 0.05, 0, 0, 0.10),
    B(0.60, 0.34, -1.70, 0.36, 0.02, 0.05, 0, 0, -0.10),
  ])), mFlat(C.sombre));
  // Bouches d'air des pontons.
  put(ch, geoOf('f1.podIntakes', () => boxSoup([
    B(-0.58, 0.34, 0.41, 0.15, 0.14, 0.02),
    B(0.58, 0.34, 0.41, 0.15, 0.14, 0.02),
  ])), mFlat(C.sombre));

  // Aileron avant large, deux plans + derives.
  put(ch, geoOf('f1.wingF', () => boxSoup([
    B(0, 0.13, 2.30, 0.95, 0.02, 0.22, -0.06, 0, 0),
    B(0, 0.23, 2.12, 0.92, 0.02, 0.13, -0.28, 0, 0),
    B(-0.93, 0.21, 2.24, 0.03, 0.14, 0.30),
    B(0.93, 0.21, 2.24, 0.03, 0.14, 0.30),
  ])), mPaint(T.color), null, true);

  // Aileron arriere haut, sur pylone.
  put(ch, geoOf('f1.wingR', () => boxSoup([
    B(0, 0.72, -2.20, 0.05, 0.22, 0.10),
    B(0, 0.94, -2.26, 0.52, 0.025, 0.20, -0.12, 0, 0),
    B(0, 1.07, -2.37, 0.50, 0.02, 0.11, -0.34, 0, 0),
    B(-0.50, 0.97, -2.28, 0.025, 0.20, 0.34),
    B(0.50, 0.97, -2.28, 0.025, 0.20, 0.34),
  ])), mPaint(T.color), null, true);

  // Halo de protection + pilier central.
  const halo = put(ch, geoOf('f1.halo', () => {
    const g = new THREE.TorusGeometry(0.42, 0.035, 3, 6, Math.PI);
    g.translate(0, 0.62, -0.18);
    return g;
  }), mFlat(C.sombre));
  halo.name = 'halo';
  halo.userData.accent = true; // liseré d'equipe
  put(ch, geoOf('f1.haloPillar', () => boxSoup([
    B(0, 0.86, 0.18, 0.04, 0.05, 0.42, 0.42, 0, 0),
  ])), mFlat(C.sombre));

  // Numero peint : flancs de l'airbox + capot.
  const numMat = mDecal(numberTex(16)); // 16 : clin d'oeil monegasque
  const nL = put(ch, planeGeo(0.26, 0.26), numMat, 'number');
  nL.position.set(-0.125, 0.86, -1.02); nL.rotation.y = -Math.PI / 2;
  const nR = put(ch, planeGeo(0.26, 0.26), numMat, 'number');
  nR.position.set(0.125, 0.86, -1.02); nR.rotation.y = Math.PI / 2;
  const nT = put(ch, planeGeo(0.3, 0.3), numMat, 'number');
  nT.position.set(0, 0.5, 1.35); nT.rotation.x = -Math.PI / 2;

  // Feu de pluie (stop) et diodes avant.
  const brake = put(ch, planeGeo(0.16, 0.09), mGlow(C.feu), 'brake');
  brake.position.set(0, 0.72, -2.26);
  brake.rotation.y = Math.PI;
  brake.visible = false;
  const lamp = put(ch, planeGeo(0.5, 0.05), mGlow(C.phare), 'light');
  lamp.position.set(0, 0.28, 2.52);
  lamp.visible = false;

  addSeats(ch, T);
  addWheels(root, 'f1', T.wheel, 0.30, 0.44, 8, 0);
  root.userData.smoke = SMOKE_AT.f1;
  return root;
}

// ---------------------------------------------------------------------------
// Prototype : buggy des alpages
// ---------------------------------------------------------------------------
function buildBuggy() {
  const T = VEHICLE_TYPES.buggy;
  const root = new THREE.Group();
  const ch = new THREE.Group();
  ch.name = 'chassis';
  root.add(ch);

  const hull = put(ch, geoOf('buggy.hull', () => loft([
    { z: 2.10, y0: 0.42, y1: 0.86, w0: 0.55, w1: 0.70 },
    { z: 1.20, y0: 0.38, y1: 0.96, w0: 0.80, w1: 0.92 },
    { z: 0.00, y0: 0.36, y1: 0.90, w0: 0.85, w1: 0.95 },
    { z: -1.20, y0: 0.38, y1: 0.88, w0: 0.82, w1: 0.92 },
    { z: -2.10, y0: 0.44, y1: 0.80, w0: 0.62, w1: 0.72 },
  ])), mPaint(T.color), 'hull', true);
  hull.name = 'hull';

  // Arceau tubulaire (8 tubes) — repere de silhouette a 150 m.
  const cage = put(ch, geoOf('buggy.cage', () => boxSoup([
    B(-0.84, 1.35, 0.55, 0.05, 0.42, 0.05, 0, 0, 0.06),
    B(0.84, 1.35, 0.55, 0.05, 0.42, 0.05, 0, 0, -0.06),
    B(-0.84, 1.35, -1.15, 0.05, 0.42, 0.05, 0, 0, 0.06),
    B(0.84, 1.35, -1.15, 0.05, 0.42, 0.05, 0, 0, -0.06),
    B(-0.81, 1.76, -0.30, 0.05, 0.05, 0.90),
    B(0.81, 1.76, -0.30, 0.05, 0.05, 0.90),
    B(0, 1.76, 0.55, 0.82, 0.05, 0.05),
    B(0, 1.76, -1.15, 0.82, 0.05, 0.05),
  ])), mFlat(C.chrome));
  cage.userData.accent = true;

  // Pare-chocs avant et arriere + protections verticales.
  put(ch, geoOf('buggy.bumpers', () => boxSoup([
    B(0, 0.64, 2.24, 0.86, 0.09, 0.09),
    B(0, 0.64, -2.24, 0.86, 0.09, 0.09),
    B(-0.40, 0.85, 2.22, 0.05, 0.28, 0.05),
    B(0.40, 0.85, 2.22, 0.05, 0.28, 0.05),
  ])), mFlat(C.metal));

  // Calandre : cadre + texture de barreaux.
  put(ch, geoOf('buggy.grillFrame', () => boxSoup([
    B(0, 0.80, 2.06, 0.52, 0.16, 0.04),
  ])), mFlat(C.sombre));
  const grille = put(ch, planeGeo(0.92, 0.26), mGrille());
  grille.position.set(0, 0.80, 2.11);

  // Phares carres + halo.
  put(ch, geoOf('buggy.lampBox', () => boxSoup([
    B(-0.62, 0.86, 2.04, 0.15, 0.11, 0.06),
    B(0.62, 0.86, 2.04, 0.15, 0.11, 0.06),
  ])), mFlat(C.sombre));
  const l1 = put(ch, planeGeo(0.24, 0.17), mGlow(C.phare), 'light');
  l1.position.set(-0.62, 0.86, 2.11);
  const l2 = put(ch, planeGeo(0.24, 0.17), mGlow(C.phare), 'light');
  l2.position.set(0.62, 0.86, 2.11);
  l1.visible = l2.visible = false;

  // Sieges baquets visibles : 4 assises + 2 dossiers de rangee.
  put(ch, geoOf('buggy.seats', () => boxSoup([
    B(-0.55, 0.94, 0.32, 0.24, 0.06, 0.26),
    B(0.55, 0.94, 0.32, 0.24, 0.06, 0.26),
    B(-0.55, 0.94, -0.88, 0.24, 0.06, 0.26),
    B(0.55, 0.94, -0.88, 0.24, 0.06, 0.26),
    B(0, 1.16, 0.02, 0.80, 0.24, 0.06, -0.14, 0, 0),
    B(0, 1.16, -1.18, 0.80, 0.24, 0.06, -0.14, 0, 0),
  ])), mFlat(C.siege));

  // Volant + colonne de direction.
  put(ch, geoOf('buggy.wheelCol', () => boxSoup([
    B(-0.55, 1.10, 0.90, 0.02, 0.02, 0.22, 0.5, 0, 0),
    B(-0.55, 1.22, 0.78, 0.15, 0.03, 0.02, 0.5, 0, 0),
  ])), mFlat(C.sombre));

  // Bidon d'essence sangle a l'arriere.
  put(ch, geoOf('buggy.jerrycan', () => boxSoup([
    B(0.42, 1.02, -1.86, 0.17, 0.22, 0.10),
    B(0.42, 1.26, -1.86, 0.05, 0.04, 0.05),
  ])), mFlat(C.bidon));

  const brake = put(ch, planeGeo(0.7, 0.1), mGlow(C.feu), 'brake');
  brake.position.set(0, 0.86, -2.17);
  brake.rotation.y = Math.PI;
  brake.visible = false;

  addSeats(ch, T);
  addWheels(root, 'buggy', T.wheel, 0.34, 0.34, 8, 0.16);
  root.userData.smoke = SMOKE_AT.buggy;
  return root;
}

// ---------------------------------------------------------------------------
// Prototype : scooter du port
// ---------------------------------------------------------------------------
function buildScooter() {
  const T = VEHICLE_TYPES.scooter;
  const root = new THREE.Group();
  const ch = new THREE.Group();
  ch.name = 'chassis';
  root.add(ch);

  // Coque arriere sous la selle.
  const hull = put(ch, geoOf('scooter.hull', () => loft([
    { z: -0.05, y0: 0.34, y1: 0.62, w0: 0.15, w1: 0.19 },
    { z: -0.55, y0: 0.36, y1: 0.68, w0: 0.18, w1: 0.22 },
    { z: -0.95, y0: 0.42, y1: 0.60, w0: 0.14, w1: 0.16 },
  ])), mPaint(T.color), 'hull', true);
  hull.name = 'hull';

  // Plancher plat + tablier incline + garde-boue.
  put(ch, geoOf('scooter.body', () => boxSoup([
    B(0, 0.31, 0.02, 0.19, 0.03, 0.34),            // plancher
    B(0, 0.70, 0.34, 0.21, 0.32, 0.05, 0.22, 0, 0), // tablier
    B(0, 0.42, 0.46, 0.13, 0.10, 0.05, 0.35, 0, 0), // bas de tablier
  ])), mPaint(T.color), null, true);

  put(ch, geoOf('scooter.trim', () => boxSoup([
    B(0, 0.66, -1.02, 0.13, 0.03, 0.16, 0.22, 0, 0), // garde-boue arriere
  ])), mFlat(C.chrome)).userData.accent = true;

  // Selle longue (deux niveaux).
  put(ch, geoOf('scooter.seat', () => boxSoup([
    B(0, 0.75, -0.28, 0.15, 0.06, 0.28),
    B(0, 0.81, -0.72, 0.14, 0.06, 0.22, -0.10, 0, 0),
  ])), mFlat(C.sombre));

  // Train avant : tout pivote autour de la colonne de direction (z = PIV).
  const PIV = 0.52;
  const front = new THREE.Group();
  front.position.z = PIV;
  front.userData.role = 'steerFront';
  ch.add(front);
  const onFork = (m) => { m.position.z = -PIV; return m; };

  onFork(put(front, geoOf('scooter.mudguard', () => boxSoup([
    B(0, 0.62, 0.62, 0.11, 0.03, 0.16, -0.30, 0, 0),
  ])), mFlat(C.chrome)));

  // Colonne, fourche et guidon.
  onFork(put(front, geoOf('scooter.fork', () => boxSoup([
    B(0, 0.78, 0.52, 0.03, 0.26, 0.03, 0.30, 0, 0),
    B(-0.10, 0.50, 0.66, 0.02, 0.20, 0.02, 0.30, 0, 0),
    B(0.10, 0.50, 0.66, 0.02, 0.20, 0.02, 0.30, 0, 0),
    B(0, 1.02, 0.42, 0.30, 0.02, 0.02),
    B(-0.28, 1.02, 0.42, 0.06, 0.03, 0.03),
    B(0.28, 1.02, 0.42, 0.06, 0.03, 0.03),
    B(-0.25, 1.09, 0.42, 0.015, 0.08, 0.015, 0, 0, -0.22), // tiges de retroviseur
    B(0.25, 1.09, 0.42, 0.015, 0.08, 0.015, 0, 0, 0.22),
    B(-0.29, 1.18, 0.42, 0.055, 0.04, 0.012),              // miroirs
    B(0.29, 1.18, 0.42, 0.055, 0.04, 0.012),
  ])), mFlat(C.sombre)));

  // Phare rond.
  onFork(put(front, geoOf('scooter.lampBody', () => {
    const g = new THREE.CylinderGeometry(0.12, 0.12, 0.07, 8);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0.85, 0.47);
    return g;
  }), mFlat(C.chrome)));
  const lamp = onFork(put(front, geoOf('scooter.lampGlass', () => {
    const g = new THREE.CircleGeometry(0.1, 8);
    g.translate(0, 0.85, 0.512);
    return g;
  }), mGlow(C.phare), 'light'));
  lamp.visible = false;

  const brake = put(ch, planeGeo(0.16, 0.07), mGlow(C.feu), 'brake');
  brake.position.set(0, 0.66, -0.97);
  brake.rotation.y = Math.PI;
  brake.visible = false;

  addSeats(ch, T);
  addWheels(root, 'scooter', T.wheel, 0.12, 0.14, 8, 0);
  root.userData.smoke = SMOKE_AT.scooter;
  return root;
}

// ---------------------------------------------------------------------------
// Prototype : vedette du port (pas de roues)
// ---------------------------------------------------------------------------
function buildBoat() {
  const T = VEHICLE_TYPES.boat;
  const root = new THREE.Group();
  const ch = new THREE.Group();
  ch.name = 'chassis';
  root.add(ch);

  // Coque en V : quille etroite (w0) et livet large (w1). y = 0 est la flottaison.
  const hull = put(ch, geoOf('boat.hull', () => loft([
    { z: 3.00, y0: 0.10, y1: 0.56, w0: 0.03, w1: 0.16 },
    { z: 2.20, y0: -0.12, y1: 0.60, w0: 0.08, w1: 0.55 },
    { z: 1.00, y0: -0.26, y1: 0.62, w0: 0.16, w1: 0.95 },
    { z: -0.40, y0: -0.28, y1: 0.62, w0: 0.22, w1: 1.15 },
    { z: -1.80, y0: -0.26, y1: 0.60, w0: 0.26, w1: 1.20 },
    { z: -2.90, y0: -0.18, y1: 0.58, w0: 0.30, w1: 1.10 },
  ])), mPaint(T.color), 'hull', true);
  hull.name = 'hull';

  // Plancher de cockpit en teck (tres Riva) + liston de protection.
  put(ch, geoOf('boat.sole', () => boxSoup([
    B(0, 0.62, -1.05, 0.84, 0.03, 1.42),
  ])), mFlat(C.teck));
  put(ch, geoOf('boat.rail', () => boxSoup([
    B(-1.14, 0.52, -0.60, 0.06, 0.07, 1.90),
    B(1.14, 0.52, -0.60, 0.06, 0.07, 1.90),
  ])), mFlat(C.sombre));

  // Console de pilotage + cadre de pare-brise.
  put(ch, geoOf('boat.console', () => boxSoup([
    B(0, 0.80, 0.55, 0.42, 0.20, 0.30),
    B(0, 1.02, 0.42, 0.50, 0.03, 0.03, -0.45, 0, 0),
  ])), mFlat(C.creme)).userData.accent = true;

  // Pare-brise incline.
  const glass = put(ch, planeGeo(0.98, 0.42), mGlass());
  glass.position.set(0, 1.04, 0.34);
  glass.rotation.x = -0.45;

  // Banquette arriere + siege pilote + deux coussins de plat-bord.
  put(ch, geoOf('boat.seats', () => boxSoup([
    B(0, 0.86, -1.60, 0.72, 0.07, 0.24),
    B(0, 1.08, -1.86, 0.72, 0.18, 0.06, 0.16, 0, 0),
    B(0, 0.86, -0.45, 0.34, 0.07, 0.24),
    B(-0.62, 0.68, 0.60, 0.20, 0.06, 0.26),
    B(0.62, 0.68, 0.60, 0.20, 0.06, 0.26),
  ])), mFlat(C.coussin));

  // Moteur hors-bord.
  put(ch, geoOf('boat.engine', () => boxSoup([
    B(0, 0.72, -3.15, 0.24, 0.30, 0.22),
    B(0, 0.22, -3.15, 0.09, 0.30, 0.10),
    B(0, -0.14, -3.15, 0.07, 0.12, 0.30),
  ])), mFlat(C.sombre));
  put(ch, geoOf('boat.prop', () => {
    const g = new THREE.CircleGeometry(0.13, 6);
    g.rotateY(Math.PI / 2);
    g.translate(0.02, -0.14, -3.34);
    return g;
  }), mFlat(C.chrome));

  // Feux de navigation (rouge/vert) et projecteur de proue.
  const l1 = put(ch, planeGeo(0.1, 0.07), mGlow(C.phare), 'light');
  l1.position.set(0, 0.66, 2.62);
  const l2 = put(ch, planeGeo(0.09, 0.06), mGlow(0x35ff6a), 'light');
  l2.position.set(0.62, 0.66, 1.55);
  const l3 = put(ch, planeGeo(0.09, 0.06), mGlow(C.feu), 'light');
  l3.position.set(-0.62, 0.66, 1.55);
  l1.visible = l2.visible = l3.visible = false;

  const brake = put(ch, planeGeo(0.5, 0.08), mGlow(C.feu), 'brake');
  brake.position.set(0, 0.62, -2.92);
  brake.rotation.y = Math.PI;
  brake.visible = false;

  // Moustaches d'ecume : deux plans additifs poses sur l'eau.
  const foamGeo = geoOf('boat.foam', () => {
    const g = new THREE.PlaneGeometry(1.0, 2.6);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, -0.6);
    return g;
  });
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? -1 : 1;
    const f = put(ch, foamGeo, matOf('foam', () => new THREE.MeshBasicMaterial({
      map: foamTex() || null, color: C.ecume, transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    })), 'foam');
    f.position.set(s * 0.70, 0.04, 1.65);
    f.rotation.y = s * 0.30;
    f.visible = false;
  }

  addSeats(ch, T);
  root.userData.smoke = SMOKE_AT.boat;
  root.userData.aquatic = true;
  return root;
}

const BUILDERS = { f1: buildF1, buggy: buildBuggy, scooter: buildScooter, boat: buildBoat };

function prototypeOf(id) {
  let p = _protos.get(id);
  if (p === undefined) {
    p = (BUILDERS[id] || BUILDERS.buggy)();
    _protos.set(id, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Pool de sprites de fumee (niveau module, partage par tous les vehicules)
// ---------------------------------------------------------------------------
const SMOKE_POOL_MAX = 28;
const _smokeFree = [];
const _smokeAll = [];

function smokeSprite() {
  const s = _smokeFree.pop();
  if (s) return s;
  if (_smokeAll.length >= SMOKE_POOL_MAX) return null;
  const m = new THREE.SpriteMaterial({
    map: smokeTex() || null, color: 0xbfc3c8, transparent: true,
    opacity: 0.5, depthWrite: false, fog: true,
  });
  const sp = new THREE.Sprite(m);
  sp.matrixAutoUpdate = true;
  _smokeAll.push(sp);
  return sp;
}

function smokeRelease(sp) {
  if (sp.parent) sp.parent.remove(sp);
  if (_smokeFree.indexOf(sp) < 0) _smokeFree.push(sp);
}

// ---------------------------------------------------------------------------
// Bosses de carrosserie : bruit coherent (les sommets dupliques bougent ensemble)
// ---------------------------------------------------------------------------
function dentNoise(x, y, z, salt) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177) ^ Math.imul(salt | 0, 2654435761);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 - 0.5;
}

// ---------------------------------------------------------------------------
// VehicleModel
// ---------------------------------------------------------------------------
class VehicleModel {
  constructor(typeId, opts) {
    const id = VEHICLE_TYPES[typeId] ? typeId : 'buggy';
    this.typeId = id;
    this.type = VEHICLE_TYPES[id];
    this.aquatic = !!this.type.aquatic;

    const proto = prototypeOf(id);
    this.root = proto.clone(true);
    this.root.rotation.order = 'YXZ';

    // Collecte des pieces (une seule traversee).
    this.seatAnchors = [];
    this._wheels = [];
    this._lights = [];
    this._brakes = [];
    this._foam = [];
    this._paint = [];
    this._accent = [];
    this._hull = null;
    this._steerFront = null;
    this.chassis = null;
    this.root.traverse((o) => {
      const u = o.userData;
      if (o.name === 'chassis') this.chassis = o;
      if (!u) return;
      if (u.paint) this._paint.push(o);
      if (u.accent) this._accent.push(o);
      switch (u.role) {
        case 'hull': this._hull = o; break;
        case 'seat': this.seatAnchors.push(o); break;
        case 'light': this._lights.push(o); break;
        case 'brake': this._brakes.push(o); break;
        case 'foam': this._foam.push(o); break;
        case 'wheel': this._wheels.push(o); break;
        case 'steerFront': this._steerFront = o; break;
        default: break;
      }
    });
    this.seatAnchors.sort((a, b) => a.userData.idx - b.userData.idx);
    this._wheels.sort((a, b) => a.userData.idx - b.userData.idx);
    for (const w of this._wheels) {
      w.userData.steer = w.children[0];
      w.userData.spin = w.children[0].children[0];
      w.userData.baseY = w.position.y;
    }
    if (!this.chassis) this.chassis = this.root;

    // Etat d'animation
    this._t = Math.random() * 10;
    this._prevSpeed = 0;
    this._acc = 0;
    this._dive = 0;
    this._roll = 0;
    this._steer = 0;
    this._bounce = 0;
    this._damage = 1;
    this._dentStep = 0;
    this._visible = true;
    this._lightsOn = false;
    this._puffs = [];
    this._puffT = 0.4;
    this._lastX = 0; this._lastY = 0; this._lastZ = 0;
    this._hasPos = false;

    // Ressources propres a cette instance (a liberer dans dispose()).
    this._ownMats = [];
    this._paintMats = [];
    this._paintBase = [];
    this._foamMat = null;
    this._ownGeo = null;
    this._basePos = null;
    this._painted = false;
    this._seed = ((Math.random() * 0x7fffffff) | 0) || 7;

    // Groupe de fumee : contre-rotation pour rester aligne au monde.
    this._smokeGroup = new THREE.Group();
    this._smokeGroup.matrixAutoUpdate = true;
    this.root.add(this._smokeGroup);
    const sm = proto.userData.smoke || [0, 0.5, -2];
    this._exX = sm[0]; this._exY = sm[1]; this._exZ = sm[2];

    // Livree : on ne clone les materiaux que si une couleur est imposee.
    const o = opts || {};
    if (o.color !== undefined && o.color !== null) this._repaint(o.color);
    if (o.team !== undefined && o.team !== null) this._setTeam(o.team);

    // L'ecume a besoin d'une opacite propre par bateau.
    if (this._foam.length) {
      const fm = this._foam[0].material.clone();
      this._ownMats.push(fm);
      for (const f of this._foam) f.material = fm;
      this._foamMat = fm;
    }
  }

  // --- livree -------------------------------------------------------------
  /** Clone les materiaux de carrosserie une seule fois (livree ou degats). */
  _ownPaint() {
    if (this._painted) return;
    this._painted = true;
    const map = new Map();
    for (const m of this._paint) {
      let nm = map.get(m.material);
      if (!nm) {
        nm = m.material.clone();
        map.set(m.material, nm);
        this._ownMats.push(nm);
        this._paintMats.push(nm);
        this._paintBase.push(nm.color.getHex());
      }
      m.material = nm;
    }
  }

  _repaint(hex) {
    this._ownPaint();
    for (let i = 0; i < this._paintMats.length; i++) {
      this._paintMats[i].color.setHex(hex);
      this._paintBase[i] = hex;
    }
  }

  _setTeam(team) {
    if (!this._accent.length) return;
    const hex = TEAM_COLORS[((team | 0) % TEAM_COLORS.length + TEAM_COLORS.length) % TEAM_COLORS.length];
    const map = new Map();
    for (const m of this._accent) {
      let nm = map.get(m.material);
      if (!nm) {
        nm = m.material.clone();
        nm.color.setHex(hex);
        map.set(m.material, nm);
        this._ownMats.push(nm);
      }
      m.material = nm;
    }
  }

  // --- degats -------------------------------------------------------------
  /** 1 = intact, 0 = epave. Noircit la peinture, cabosse la coque, lance la fumee. */
  setDamage(ratio01) {
    const r = clamp01(ratio01);
    if (r === this._damage) return;
    this._damage = r;

    this._ownPaint();
    const soot = (1 - r) * 0.75;
    _col2.setHex(0x14100e);
    for (let i = 0; i < this._paintMats.length; i++) {
      _col.setHex(this._paintBase[i]);
      _col.lerp(_col2, soot);
      this._paintMats[i].color.copy(_col);
    }

    const step = r > 0.65 ? 0 : r > 0.35 ? 1 : 2;
    if (step !== this._dentStep) {
      this._dentStep = step;
      this._applyDents(step * 0.5);
    }
    // Les appendices pendent quand c'est casse.
    const droop = (1 - r) * 0.35;
    const halo = this.root.getObjectByName('halo');
    if (halo) halo.rotation.z = droop * 0.5;
  }

  _applyDents(amount) {
    const hull = this._hull;
    if (!hull) return;
    if (!this._ownGeo) {
      this._ownGeo = hull.geometry.clone();
      hull.geometry = this._ownGeo;
      this._basePos = Float32Array.from(this._ownGeo.getAttribute('position').array);
    }
    const attr = this._ownGeo.getAttribute('position');
    const a = attr.array, b = this._basePos;
    const s = this._seed;
    for (let i = 0; i < a.length; i += 3) {
      if (amount <= 0) { a[i] = b[i]; a[i + 1] = b[i + 1]; a[i + 2] = b[i + 2]; continue; }
      // Cle entiere sur la position de base : les sommets dupliques bougent ensemble.
      const kx = Math.round(b[i] * 40), ky = Math.round(b[i + 1] * 40), kz = Math.round(b[i + 2] * 40);
      a[i] = b[i] + dentNoise(kx, ky, kz, s) * amount * 0.22;
      a[i + 1] = b[i + 1] + dentNoise(ky, kz, kx, s + 11) * amount * 0.16;
      a[i + 2] = b[i + 2] + dentNoise(kz, kx, ky, s + 23) * amount * 0.2;
    }
    attr.needsUpdate = true;
    this._ownGeo.computeVertexNormals();
  }

  // --- feux ---------------------------------------------------------------
  setLights(on) {
    const b = !!on;
    if (b === this._lightsOn) return;
    this._lightsOn = b;
    for (const l of this._lights) l.visible = b;
  }

  setVisible(b) {
    this._visible = !!b;
    this.root.visible = this._visible;
    if (!this._visible) this._clearPuffs();
  }

  // --- animation ----------------------------------------------------------
  update(s, dt) {
    if (!s) return;
    dt = clamp(dt || 0, 0, 0.1);
    this._t += dt;

    const root = this.root;
    const x = s.x || 0, y = s.y || 0, z = s.z || 0;
    root.position.set(x, y, z);
    root.rotation.set(s.pitch || 0, s.yaw || 0, s.roll || 0);
    if (!this._visible) { this._lastX = x; this._lastY = y; this._lastZ = z; return; }

    const T = this.type;
    const sp = s.speed || 0;
    const absSp = Math.abs(sp);

    // Derivee de vitesse -> plongee sur le frein, cabrage a l'acceleration.
    const rawAcc = dt > 1e-4 ? (sp - this._prevSpeed) / dt : 0;
    this._prevSpeed = sp;
    this._acc = damp(this._acc, clamp(rawAcc, -45, 45), 9, dt);
    const grounded = s.grounded !== false;

    const steerIn = clamp(s.steer || 0, -1, 1);
    this._steer = damp(this._steer, steerIn, 14, dt);
    const speedRatio = clamp01(absSp / (T.maxSpeed * 0.65 || 1));

    if (this.aquatic) {
      this._updateBoat(s, dt, sp, absSp, speedRatio);
    } else {
      this._updateCar(s, dt, sp, absSp, speedRatio, grounded);
    }

    // Feux stop.
    const brake = !!s.brake && absSp > 0.2;
    for (const b of this._brakes) b.visible = brake;

    // Fumee de degats.
    this._updatePuffs(dt, x, y, z);
    this._lastX = x; this._lastY = y; this._lastZ = z;
    this._hasPos = true;
  }

  _updateCar(s, dt, sp, absSp, speedRatio, grounded) {
    const T = this.type;
    // Assiette : le nez plonge au freinage (rotation.x > 0 = nez vers le bas).
    const targetDive = clamp(-this._acc * 0.010, -0.09, 0.13);
    this._dive = damp(this._dive, targetDive, 10, dt);
    // Roulis : la voiture penche vers l'exterieur, le scooter s'inscrit dans le virage.
    const targetRoll = this._steer * speedRatio * (ROLL_AMOUNT[this.typeId] || 0.1);
    this._roll = damp(this._roll, targetRoll, 8, dt);

    const ch = this.chassis;
    ch.rotation.x = this._dive;
    ch.rotation.z = this._roll;
    ch.position.y = -Math.abs(this._dive) * 0.06;

    // Suspension : detente en l'air, compression selon l'assiette.
    const air = grounded ? 0 : -0.11;
    this._bounce = damp(this._bounce, air, 12, dt);
    const spin = s.wheelSpin || 0;
    const steerAngle = this._steer * (T.steerAngle || 0.5);
    for (let i = 0; i < this._wheels.length; i++) {
      const w = this._wheels[i];
      const u = w.userData;
      const load = u.front ? this._dive : -this._dive;
      w.position.y = u.baseY + this._bounce + load * 0.12;
      u.spin.rotation.x = spin;
      if (u.front) u.steer.rotation.y = steerAngle;
    }
    // Guidon / fourche du scooter.
    if (this._steerFront) this._steerFront.rotation.y = steerAngle;
  }

  _updateBoat(s, dt, sp, absSp, speedRatio) {
    const ch = this.chassis;
    const t = this._t;
    // Tangage / roulis de houle + cabrage a la vitesse.
    const swell = Math.sin(t * 1.7) * 0.034 + Math.sin(t * 0.93 + 1.3) * 0.021;
    this._dive = damp(this._dive, swell - speedRatio * 0.11, 6, dt);
    const targetRoll = this._steer * speedRatio * (ROLL_AMOUNT.boat) + Math.sin(t * 1.15 + 0.7) * 0.03;
    this._roll = damp(this._roll, targetRoll, 5, dt);
    ch.rotation.x = this._dive;
    ch.rotation.z = this._roll;
    ch.position.y = Math.sin(t * 1.35) * 0.05;

    // Moustaches d'ecume au dela de 2 m/s.
    const k = smoothstep(2, 14, absSp);
    const on = k > 0.01;
    for (let i = 0; i < this._foam.length; i++) {
      const f = this._foam[i];
      f.visible = on;
      if (!on) continue;
      const wob = 1 + Math.sin(t * 9 + i * 2.1) * 0.06;
      f.scale.set(0.55 + k * 0.75, 1, (0.6 + k * 0.8) * wob);
    }
    if (this._foamMat) this._foamMat.opacity = 0.18 + k * 0.55;
  }

  // --- fumee --------------------------------------------------------------
  _updatePuffs(dt, x, y, z) {
    const puffs = this._puffs;
    // Le groupe suit la position mais pas la rotation du vehicule.
    if (puffs.length || this._damage < 0.35) {
      _q.copy(this.root.quaternion).invert();
      this._smokeGroup.quaternion.copy(_q);
    }
    const dx = this._hasPos ? x - this._lastX : 0;
    const dy = this._hasPos ? y - this._lastY : 0;
    const dz = this._hasPos ? z - this._lastZ : 0;

    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.life += dt;
      if (p.life >= p.ttl) {
        smokeRelease(p.sprite);
        puffs[i] = puffs[puffs.length - 1];
        puffs.pop();
        continue;
      }
      const k = p.life / p.ttl;
      const sp = p.sprite;
      sp.position.x += p.vx * dt - dx;
      sp.position.y += p.vy * dt - dy;
      sp.position.z += p.vz * dt - dz;
      const sc = p.size * (0.5 + k * 1.7);
      sp.scale.set(sc, sc, 1);
      sp.material.opacity = (1 - k) * 0.45 * p.alpha;
      sp.material.rotation = p.rot + k * p.spin;
    }

    if (this._damage >= 0.35) return;
    this._puffT -= dt;
    if (this._puffT > 0 || puffs.length >= 6) return;
    const sev = 1 - this._damage / 0.35;
    this._puffT = 0.30 - sev * 0.18;
    const sprite = smokeSprite();
    if (!sprite) return;
    // Le point d'echappement est exprime en repere vehicule : on le tourne dans le groupe monde.
    _v.set(this._exX, this._exY, this._exZ).applyQuaternion(this.root.quaternion);
    sprite.position.copy(_v);
    sprite.material.color.setHex(this._damage < 0.15 ? 0x35322f : 0x9ea3a8);
    this._smokeGroup.add(sprite);
    puffs.push({
      sprite,
      life: 0,
      ttl: 1.1 + Math.random() * 0.8,
      size: 0.5 + sev * 0.5,
      alpha: 0.6 + sev * 0.5,
      rot: Math.random() * TAU,
      spin: (Math.random() - 0.5) * 2.2,
      vx: (Math.random() - 0.5) * 0.6,
      vy: 1.1 + Math.random() * 0.9,
      vz: (Math.random() - 0.5) * 0.6,
    });
  }

  _clearPuffs() {
    for (const p of this._puffs) smokeRelease(p.sprite);
    this._puffs.length = 0;
  }

  // --- liberation ---------------------------------------------------------
  dispose() {
    this._clearPuffs();
    if (this.root.parent) this.root.parent.remove(this.root);
    for (const m of this._ownMats) m.dispose();
    this._ownMats.length = 0;
    if (this._ownGeo) { this._ownGeo.dispose(); this._ownGeo = null; }
    this._basePos = null;
    this._wheels.length = 0;
    this._lights.length = 0;
    this._brakes.length = 0;
    this._foam.length = 0;
    this._paint.length = 0;
    this._accent.length = 0;
    this.seatAnchors.length = 0;
    this._hull = null;
  }
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

/**
 * Cree le modele 3D d'un vehicule.
 * @param {string} type 'f1' | 'buggy' | 'scooter' | 'boat'
 * @param {{color?: number|null, team?: number|null}} [opts]
 */
export function createVehicleModel(type, opts) {
  return new VehicleModel(type, opts);
}

/** Libere geometries, materiaux, textures et prototypes partages. */
export function disposeVehicleCache() {
  for (const g of _geos.values()) if (g) g.dispose();
  for (const m of _mats.values()) if (m) m.dispose();
  for (const t of _texs.values()) if (t) t.dispose();
  for (const s of _smokeAll) { if (s.parent) s.parent.remove(s); s.material.dispose(); }
  _geos.clear();
  _mats.clear();
  _texs.clear();
  _protos.clear();
  _smokeAll.length = 0;
  _smokeFree.length = 0;
}
