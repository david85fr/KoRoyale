// KoRoyale — modele 3D procedural de la chevre (le personnage joueur).
//
// Tout est genere a la volee : boites effilees, prismes 4 faces, cornes en
// BufferGeometry courbee. Environ 290 triangles par chevre, silhouette tres
// lisible a 150 m (cornes recourbees, oreilles tombantes, barbichette).
//
// Perf : geometries et materiaux sont mutualises dans des caches au niveau
// module, aucune allocation dans update(), un seul Group par chevre.

import * as THREE from 'three';
import { ANIM, GOAT, GOAT_SKINS } from '../../../shared/constants.js';
import { FLAG } from '../../../shared/protocol.js';
import { RARITY, WEAPONS } from '../../../shared/loot.js';
import { clamp, damp, wrapAngle, TAU } from '../../../shared/math.js';

/** Le modele est dessine pour 1.55 m au sommet des cornes. */
export const GOAT_SCALE = GOAT.height / 1.55;

// ---------------------------------------------------------------------------
// Proportions (metres, chevre debout, sabots a y = 0)
// ---------------------------------------------------------------------------
const BODY_Y = 0.86;      // centre du torse
const HIP_Y = 0.79;       // articulation des hanches
const THIGH = 0.36;
const SHIN = 0.34;
const HOOF = 0.09;
const NECK_TILT = 0.55;   // inclinaison de l'encolure au repos (rad)
const TAIL_REST = -0.55;

const HOOF_COLOR = 0x1a1614;
const EYE_COLOR = 0x0d0b0a;
const STEEL_COLOR = 0x2b2b30;

const NAME_H = 0.05;      // hauteur ecran du nom (sprite sans attenuation)
const BAR_W = 0.085;
const BAR_H = 0.011;
const BAR_FILL_H = BAR_H * 0.62;
const BAR_ANCHOR = 1.1;   // le bandeau est pose sous l'ancre
const BAR_FILL_CY = 0.5 + (BAR_ANCHOR - 0.5) * BAR_H / BAR_FILL_H; // meme axe que le fond

// Ordre des pattes : 0 avant-gauche, 1 avant-droite, 2 arriere-gauche, 3 arriere-droite.
// Trot diagonal : AG + ArD ensemble, AD + ArG en opposition.
const LEG_PHASE = [0, Math.PI, Math.PI, 0];
const LEG_FRONT = [true, true, false, false];
const LEG_SIDE = [-1, 1, -1, 1];

// Temporaires module (jamais d'allocation dans les boucles d'update)
const _col = new THREE.Color();
const _hipPose = [0, 0, 0, 0];
const _kneePose = [0, 0, 0, 0];

// ---------------------------------------------------------------------------
// Fabriques de geometrie
// ---------------------------------------------------------------------------

/**
 * Boite effilee le long de Z, centree sur l'origine.
 * Face arriere (z = -len/2) de taille (wb, hb), face avant (z = +len/2) de taille (wf, hf).
 * `open` retire les deux faces d'extremite (8 triangles au lieu de 12).
 */
function taperedBoxZ(wb, hb, wf, hf, len, open = false) {
  const b2 = len * 0.5;
  const xb = wb * 0.5, yb = hb * 0.5, xf = wf * 0.5, yf = hf * 0.5;
  const pos = [
    -xb, -yb, -b2, xb, -yb, -b2, xb, yb, -b2, -xb, yb, -b2,
    -xf, -yf, b2, xf, -yf, b2, xf, yf, b2, -xf, yf, b2,
  ];
  const idx = [
    1, 6, 5, 1, 2, 6,   // +X
    0, 7, 3, 0, 4, 7,   // -X
    3, 6, 2, 3, 7, 6,   // +Y
    0, 1, 5, 0, 5, 4,   // -Y
  ];
  if (!open) idx.push(4, 5, 6, 4, 6, 7, 0, 2, 1, 0, 3, 2); // +Z puis -Z
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Membre effile le long de Y. Face A (large) a l'origine, face B a l'autre bout.
 * `up = false` : descend de 0 a -len (pivot en haut, pratique pour les pattes).
 */
function limbY(wa, da, wb, db, len, up = false, open = true) {
  const g = taperedBoxZ(wa, da, wb, db, len, open);
  g.rotateX(-Math.PI / 2); // la face A part vers +Y, la face B vers -Y
  g.translate(0, up ? len * 0.5 : -len * 0.5, 0);
  return g;
}

/** Corne recourbee vers l'arriere : section triangulaire, 4 anneaux (26 tri). */
function hornGeo() {
  const rings = 4, sides = 3, len = 0.44, bend = 2.35;
  const step = len / rings;
  const pos = [], idx = [];
  let cy = 0, cz = 0;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const th = t * bend;                 // 0 = vertical, puis bascule vers -Z
    const r = 0.05 * (1 - 0.74 * t);
    const ny = -Math.sin(th), nz = -Math.cos(th); // normale de section (dans YZ)
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * TAU + Math.PI * 0.5;
      const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
      pos.push(ca, cy + sa * ny, cz + sa * nz);
    }
    const mid = ((i + 0.5) / rings) * bend;
    cy += Math.cos(mid) * step;
    cz -= Math.sin(mid) * step;
  }
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      const a = i * sides + k, b = i * sides + k1;
      const c = (i + 1) * sides + k, d = (i + 1) * sides + k1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const last = rings * sides;
  idx.push(0, 2, 1, last, last + 1, last + 2); // bouchons base + pointe
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Voilure triangulaire du parapente (4 triangles, double face). */
function canopyGeo() {
  const pos = [
    0, 0.18, 1.05,     // nez
    -0.85, 0.16, 0.15, // mi-gauche
    0.85, 0.16, 0.15,  // mi-droite
    -1.65, -0.30, -0.75,
    1.65, -0.30, -0.75,
    0, 0.02, -0.55,    // arriere centre
  ];
  const idx = [0, 1, 5, 1, 3, 5, 0, 5, 2, 2, 5, 4];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Caches module
// ---------------------------------------------------------------------------
let _geo = null;
const _mats = new Map();
const _tags = new Map();
let _barBack = null;

function geo() {
  if (_geo) return _geo;
  _geo = {
    torso: taperedBoxZ(0.38, 0.38, 0.45, 0.46, 1.02),
    belly: taperedBoxZ(0.30, 0.14, 0.36, 0.17, 0.86),
    spotBody: taperedBoxZ(0.47, 0.32, 0.47, 0.30, 0.34),
    spotFace: taperedBoxZ(0.075, 0.20, 0.06, 0.135, 0.32),
    collar: taperedBoxZ(0.26, 0.26, 0.24, 0.24, 0.09),
    neck: limbY(0.16, 0.17, 0.21, 0.23, 0.34, true),
    head: taperedBoxZ(0.19, 0.21, 0.115, 0.13, 0.28),
    muzzle: taperedBoxZ(0.10, 0.10, 0.095, 0.085, 0.11),
    eye: taperedBoxZ(0.035, 0.045, 0.03, 0.035, 0.03),
    ear: limbY(0.055, 0.13, 0.02, 0.06, 0.19),
    beard: limbY(0.06, 0.055, 0.015, 0.02, 0.15),
    tail: limbY(0.035, 0.03, 0.07, 0.06, 0.18, true),
    horn: hornGeo(),
    thigh: limbY(0.10, 0.11, 0.075, 0.085, THIGH),
    shin: limbY(0.075, 0.085, 0.05, 0.055, SHIN),
    hoof: limbY(0.075, 0.085, 0.085, 0.10, HOOF, false, false),
    canopy: canopyGeo(),
    riser: limbY(0.025, 0.025, 0.025, 0.025, 1.5, true),
    box: new THREE.BoxGeometry(1, 1, 1),
  };
  return _geo;
}

/** Materiau lambert facette, mutualise par couleur. */
function mat(hex, doubleSide = false) {
  const key = doubleSide ? 'd' + hex : hex;
  let m = _mats.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color: hex,
      flatShading: true,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
    _mats.set(key, m);
  }
  return m;
}

function cssColor(c) {
  if (typeof c === 'number') return '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
  return c || '#ffffff';
}

/** Materiau de sprite pour un nom, cache par (texte, couleur). Null si pas de DOM. */
function tagMaterial(text, color) {
  if (typeof document === 'undefined') return null;
  const key = text + '|' + color;
  const hit = _tags.get(key);
  if (hit) return hit;
  const cvs = document.createElement('canvas');
  let ctx = cvs.getContext('2d');
  const font = '700 40px system-ui, "Segoe UI", Arial, sans-serif';
  ctx.font = font;
  const w = Math.min(512, Math.ceil(ctx.measureText(text).width) + 28);
  cvs.width = Math.max(64, w);
  cvs.height = 64;
  ctx = cvs.getContext('2d');
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(8,12,20,0.85)';
  ctx.strokeText(text, cvs.width / 2, 34);
  ctx.fillStyle = cssColor(color);
  ctx.fillText(text, cvs.width / 2, 34);
  const tex = new THREE.CanvasTexture(cvs);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  const entry = {
    mat: new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
      sizeAttenuation: false, toneMapped: false,
    }),
    aspect: cvs.width / cvs.height,
  };
  if (_tags.size > 128) {
    const old = _tags.keys().next().value;
    const e = _tags.get(old);
    _tags.delete(old);
    e.mat.map.dispose();
    e.mat.dispose();
  }
  _tags.set(key, entry);
  return entry;
}

function barBackMat() {
  if (!_barBack) {
    _barBack = new THREE.SpriteMaterial({
      color: 0x0b0f16, transparent: true, opacity: 0.7, depthTest: false,
      depthWrite: false, sizeAttenuation: false, toneMapped: false,
    });
  }
  return _barBack;
}

/** Petites armes abstraites : [largeur, hauteur, longueur]. */
const GUN_SHAPES = {
  pistol: { body: [0.06, 0.08, 0.16], barrel: [0.035, 0.035, 0.10], grip: [0.045, 0.09, 0.05] },
  smg: { body: [0.065, 0.09, 0.23], barrel: [0.04, 0.04, 0.12], grip: [0.05, 0.10, 0.06] },
  ar: { body: [0.065, 0.10, 0.32], barrel: [0.04, 0.04, 0.20], grip: [0.05, 0.12, 0.07] },
  shotgun: { body: [0.075, 0.10, 0.30], barrel: [0.055, 0.055, 0.21], grip: [0.06, 0.10, 0.08] },
  dmr: { body: [0.06, 0.09, 0.35], barrel: [0.035, 0.035, 0.23], grip: [0.05, 0.11, 0.07] },
  sniper: { body: [0.06, 0.095, 0.42], barrel: [0.03, 0.03, 0.29], grip: [0.05, 0.11, 0.07] },
  rpg: { body: [0.10, 0.11, 0.46], barrel: [0.08, 0.08, 0.26], grip: [0.06, 0.10, 0.09] },
};

function skinById(id) {
  for (let i = 0; i < GOAT_SKINS.length; i++) if (GOAT_SKINS[i].id === id) return GOAT_SKINS[i];
  return GOAT_SKINS[0];
}

// ---------------------------------------------------------------------------
// Le modele
// ---------------------------------------------------------------------------
class GoatModel {
  constructor(opts = {}) {
    const skin = skinById(opts.skin);
    this.skinId = skin.id;
    this.isLocal = !!opts.isLocal;
    this.teamColor = typeof opts.teamColor === 'number' ? opts.teamColor : null;

    // horloge et phases propres a l'instance
    this._t = Math.random() * 20;
    this._gait = Math.random() * TAU;
    this._grazeIn = 2 + Math.random() * 6;
    this._grazing = false;
    this._grazeAmt = 0;
    this._bodyYaw = 0;
    this._crouch = 0;
    this._anim = ANIM.IDLE;
    this._animT = 0;
    this._first = true;

    this._skinMeshes = [];   // couleur « body »
    this._bellyMeshes = [];  // couleur « belly »
    this._hornMeshes = [];   // couleur « horn »

    this.root = new THREE.Group();
    this.root.name = 'chevre';
    this.rig = new THREE.Group();
    this.rig.scale.setScalar(GOAT_SCALE);
    this.root.add(this.rig);

    this._buildBody(skin);
    this._buildHead(skin);
    this._buildLegs(skin);
    this._buildChute(skin);

    this._tagHolder = new THREE.Object3D();
    this._tagHolder.position.y = 1.95 * GOAT_SCALE;
    this.root.add(this._tagHolder);
    this.nameTag = null;
    this.barBack = null;
    this.barFill = null;
    this._barFillMat = null;

    this._applySkin(skin);
    if (opts.name && !this.isLocal) this.setNameTag(opts.name, this.teamColor ?? 0xffffff);
  }

  // -- construction --------------------------------------------------------
  _buildBody(skin) {
    const g = geo();
    this.body = new THREE.Group();
    this.body.position.y = BODY_Y;
    this.rig.add(this.body);

    const torso = new THREE.Mesh(g.torso, mat(skin.body));
    torso.position.z = 0.02;
    torso.castShadow = true;
    this.body.add(torso);
    this._skinMeshes.push(torso);

    const belly = new THREE.Mesh(g.belly, mat(skin.belly));
    belly.position.set(0, -0.19, 0.02);
    this.body.add(belly);
    this._bellyMeshes.push(belly);

    // tache distinctive : selle sur le corps ou liste sur le chanfrein
    this.spotBody = new THREE.Mesh(g.spotBody, mat(skin.belly));
    this.body.add(this.spotBody);

    this.collar = new THREE.Mesh(g.collar, mat(this.teamColor ?? 0xffffff));
    this.collar.position.set(0, 0.13, 0.38);
    this.collar.rotation.x = -0.35;
    this.collar.visible = this.teamColor !== null;
    this.body.add(this.collar);

    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.15, -0.50);
    this.tail.rotation.x = TAIL_REST;
    this.body.add(this.tail);
    const tailMesh = new THREE.Mesh(g.tail, mat(skin.body));
    this.tail.add(tailMesh);
    this._skinMeshes.push(tailMesh);
  }

  _buildHead(skin) {
    const g = geo();
    this.neck = new THREE.Group();
    this.neck.position.set(0, 0.15, 0.36);
    this.neck.rotation.x = NECK_TILT;
    this.body.add(this.neck);

    const neckMesh = new THREE.Mesh(g.neck, mat(skin.body));
    neckMesh.castShadow = true;
    this.neck.add(neckMesh);
    this._skinMeshes.push(neckMesh);

    this.head = new THREE.Group();
    this.head.position.y = 0.34;
    this.head.rotation.x = -NECK_TILT;
    this.neck.add(this.head);

    const skull = new THREE.Mesh(g.head, mat(skin.body));
    skull.position.z = 0.10;
    skull.castShadow = true;
    this.head.add(skull);
    this._skinMeshes.push(skull);

    const muzzle = new THREE.Mesh(g.muzzle, mat(skin.belly));
    muzzle.position.set(0, -0.035, 0.29);
    this.head.add(muzzle);
    this._bellyMeshes.push(muzzle);

    this.spotFace = new THREE.Mesh(g.spotFace, mat(skin.belly));
    this.spotFace.position.set(0, 0.035, 0.13);
    this.head.add(this.spotFace);

    const eyeMat = mat(EYE_COLOR);
    for (let i = 0; i < 2; i++) {
      const e = new THREE.Mesh(g.eye, eyeMat);
      e.position.set((i ? 1 : -1) * 0.082, 0.05, 0.12);
      e.rotation.y = (i ? -1 : 1) * 0.25;
      this.head.add(e);
    }

    // cornes recourbees vers l'arriere
    this.horns = [];
    for (let i = 0; i < 2; i++) {
      const h = new THREE.Mesh(g.horn, mat(skin.horn));
      h.position.set((i ? 1 : -1) * 0.055, 0.10, -0.01);
      h.rotation.z = (i ? -1 : 1) * 0.22;
      h.rotation.y = (i ? 1 : -1) * 0.14;
      h.castShadow = true;
      this.head.add(h);
      this.horns.push(h);
      this._hornMeshes.push(h);
    }

    // oreilles tombantes
    this.ears = [];
    for (let i = 0; i < 2; i++) {
      const ear = new THREE.Group();
      ear.position.set((i ? 1 : -1) * 0.10, 0.045, -0.01);
      this.head.add(ear);
      const m = new THREE.Mesh(g.ear, mat(skin.body));
      ear.add(m);
      this.ears.push(ear);
      this._skinMeshes.push(m);
    }

    // barbichette
    const beard = new THREE.Mesh(g.beard, mat(skin.horn));
    beard.position.set(0, -0.10, 0.16);
    beard.rotation.x = -0.25;
    this.head.add(beard);
    this._hornMeshes.push(beard);

    // ancre a hauteur des yeux : suit le pitch de la tete
    this.headAnchor = new THREE.Object3D();
    this.headAnchor.position.set(0, 0.05, 0.14);
    this.head.add(this.headAnchor);

    // arme tenue a la gueule
    this.weapon = new THREE.Group();
    this.weapon.position.set(0.03, -0.125, 0.26);
    this.weapon.rotation.set(0.06, 0.10, 0.05);
    this.weapon.visible = false;
    this.head.add(this.weapon);
    this._gunBody = new THREE.Mesh(g.box, mat(0x9aa0a6));
    this._gunBarrel = new THREE.Mesh(g.box, mat(STEEL_COLOR));
    this._gunGrip = new THREE.Mesh(g.box, mat(0x3a3a42));
    this.weapon.add(this._gunBody, this._gunBarrel, this._gunGrip);
    this._shapeWeapon(GUN_SHAPES.pistol); // taille par defaut : la boite unite deborderait
  }

  _buildLegs(skin) {
    const g = geo();
    const hoofMat = mat(HOOF_COLOR);
    this.legs = [];
    for (let i = 0; i < 4; i++) {
      const front = LEG_FRONT[i], side = LEG_SIDE[i];
      const hip = new THREE.Group();
      hip.position.set(side * (front ? 0.15 : 0.17), HIP_Y - BODY_Y, front ? 0.34 : -0.36);
      this.body.add(hip);

      const thigh = new THREE.Mesh(g.thigh, mat(skin.body));
      hip.add(thigh);
      this._skinMeshes.push(thigh);

      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      hip.add(knee);

      const shin = new THREE.Mesh(g.shin, mat(skin.body));
      knee.add(shin);
      this._skinMeshes.push(shin);

      const hoof = new THREE.Mesh(g.hoof, hoofMat);
      hoof.position.y = -SHIN;
      knee.add(hoof);

      this.legs.push({ hip, knee, front, side });
    }
  }

  _buildChute(skin) {
    const g = geo();
    this.chute = new THREE.Group();
    this.chute.position.y = 1.15;
    this.chute.visible = false;
    this.rig.add(this.chute);

    this.chuteCanopy = new THREE.Mesh(g.canopy, mat(skin.body, true));
    this.chuteCanopy.position.y = 1.25;
    this.chute.add(this.chuteCanopy);

    const stripe = new THREE.Mesh(g.canopy, mat(skin.belly, true));
    stripe.position.y = 1.27;
    stripe.scale.set(0.45, 0.6, 0.9);
    this.chute.add(stripe);
    this._chuteStripe = stripe;

    for (let i = 0; i < 2; i++) {
      const r = new THREE.Mesh(g.riser, mat(0x2e3238));
      r.position.set((i ? 1 : -1) * 0.40, 0, 0.10);
      r.rotation.z = (i ? -1 : 1) * 0.55;
      this.chute.add(r);
    }
  }

  // -- apparence -----------------------------------------------------------
  _applySkin(skin) {
    const body = mat(skin.body), belly = mat(skin.belly), horn = mat(skin.horn);
    for (let i = 0; i < this._skinMeshes.length; i++) this._skinMeshes[i].material = body;
    for (let i = 0; i < this._bellyMeshes.length; i++) this._bellyMeshes[i].material = belly;
    for (let i = 0; i < this._hornMeshes.length; i++) this._hornMeshes[i].material = horn;
    this.chuteCanopy.material = mat(skin.body, true);
    this._chuteStripe.material = mat(skin.belly, true);

    // une tache distinctive par skin : croupe, epaule ou liste de tete
    const style = GOAT_SKINS.indexOf(skin) % 3;
    const markMat = style === 1 ? horn : belly;
    this.spotBody.visible = style !== 2;
    this.spotFace.visible = style === 2;
    this.spotBody.material = markMat;
    this.spotFace.material = markMat;
    if (style === 0) {
      this.spotBody.position.set(0, 0.05, -0.28);
      this.spotBody.scale.set(1, 1, 1);
    } else if (style === 1) {
      this.spotBody.position.set(0, 0.06, 0.26);
      this.spotBody.scale.set(1, 1, 0.72);
    }
  }

  setSkin(skinId) {
    const skin = skinById(skinId);
    if (skin.id === this.skinId) return;
    this.skinId = skin.id;
    this._applySkin(skin);
  }

  _shapeWeapon(s) {
    this._gunBody.scale.set(s.body[0], s.body[1], s.body[2]);
    this._gunBody.position.set(0, 0, s.body[2] * 0.5);
    this._gunBarrel.scale.set(s.barrel[0], s.barrel[1], s.barrel[2]);
    this._gunBarrel.position.set(0, 0.01, s.body[2] + s.barrel[2] * 0.5);
    this._gunGrip.scale.set(s.grip[0], s.grip[1], s.grip[2]);
    this._gunGrip.position.set(0, -s.grip[1] * 0.5 - 0.02, s.grip[2] * 0.5 + 0.02);
  }

  setHeldWeapon(weaponId, rarity) {
    const def = weaponId ? WEAPONS[weaponId] : null;
    if (!def || def.kind === 'melee') { this.weapon.visible = false; return; }
    this._shapeWeapon(GUN_SHAPES[weaponId] || GUN_SHAPES.pistol);
    this._gunBody.material = mat((RARITY[rarity] || RARITY.common).color);
    this.weapon.visible = true;
  }

  setNameTag(text, color = 0xffffff) {
    if (!text) { if (this.nameTag) this.nameTag.visible = false; return; }
    const entry = tagMaterial(String(text), color);
    if (!entry) return; // pas de DOM (chargement sous node)
    if (!this.nameTag) {
      this.nameTag = new THREE.Sprite(entry.mat);
      this.nameTag.center.set(0.5, -0.5);
      this.nameTag.renderOrder = 20;
      this._tagHolder.add(this.nameTag);
    } else {
      this.nameTag.material = entry.mat;
    }
    this.nameTag.scale.set(NAME_H * entry.aspect, NAME_H, 1);
    this.nameTag.visible = true;
  }

  setHealthBar(ratio) {
    if (ratio === null || ratio === undefined) {
      if (this.barBack) { this.barBack.visible = false; this.barFill.visible = false; }
      return;
    }
    const r = clamp(ratio, 0, 1);
    if (!this.barBack) {
      this.barBack = new THREE.Sprite(barBackMat());
      this.barBack.center.set(0.5, BAR_ANCHOR);
      this.barBack.scale.set(BAR_W, BAR_H, 1);
      this.barBack.renderOrder = 19;
      this._tagHolder.add(this.barBack);

      this._barFillMat = new THREE.SpriteMaterial({
        color: 0x5dd15d, transparent: true, depthTest: false, depthWrite: false,
        sizeAttenuation: false, toneMapped: false,
      });
      this.barFill = new THREE.Sprite(this._barFillMat);
      this.barFill.renderOrder = 20;
      this._tagHolder.add(this.barFill);
    }
    // la barre grandit depuis le bord gauche : on decale l'ancre du sprite
    const w = Math.max(0.0015, BAR_W * 0.92 * r);
    this.barFill.scale.set(w, BAR_FILL_H, 1);
    this.barFill.center.set((BAR_W * 0.46) / w, BAR_FILL_CY);
    _col.setHSL(0.34 * r * r, 0.72, 0.48);
    this._barFillMat.color.copy(_col);
    this.barBack.visible = true;
    this.barFill.visible = true;
  }

  setVisible(b) { this.root.visible = !!b; }

  // -- animation -----------------------------------------------------------
  update(s, dt) {
    if (!s) return;
    dt = clamp(dt || 0, 0, 0.12);
    this._t += dt;
    const flags = s.flags | 0;
    const speed = Math.max(0, s.speed || 0);
    let anim = s.anim | 0;
    if (flags & FLAG.DOWNED) anim = ANIM.DOWNED;
    else if (flags & FLAG.SWIMMING) anim = ANIM.SWIM;
    else if ((flags & (FLAG.PARACHUTE | FLAG.GLIDING)) && anim !== ANIM.DRIVE) anim = ANIM.GLIDE;
    if (anim !== this._anim) { this._anim = anim; this._animT = 0; } else this._animT += dt;

    this.root.position.set(s.x || 0, s.y || 0, s.z || 0);

    // le corps suit la tete avec un leger retard
    const aimYaw = s.yaw || 0;
    if (this._first) { this._bodyYaw = aimYaw; this._first = false; }
    const lag = speed > 0.6 ? 13 : 4.5;
    this._bodyYaw += wrapAngle(aimYaw - this._bodyYaw) * (1 - Math.exp(-lag * dt));
    const dYaw = clamp(wrapAngle(aimYaw - this._bodyYaw), -0.9, 0.9);
    this.root.rotation.y = this._bodyYaw;

    const pitch = clamp(s.pitch || 0, -0.7, 0.7);
    const crouched = (flags & FLAG.CROUCH) !== 0;
    this._crouch = damp(this._crouch, crouched ? 1 : 0, 9, dt);

    // pose de base, remplie par l'etat courant
    let bodyY = 0, bodyPitch = 0, bodyRoll = 0;
    let neckPose = 0, headPose = 0, headRoll = 0, tailPose = 0, earPose = 0;
    let legAmp = 0, kneeAmp = 0, spread = 0;
    for (let i = 0; i < 4; i++) { _hipPose[i] = 0; _kneePose[i] = 0; }

    switch (anim) {
      case ANIM.WALK:
      case ANIM.RUN: {
        const run = anim === ANIM.RUN;
        const freq = clamp(0.85 + speed * 0.42, 1.1, 4.4);
        this._gait += dt * freq * TAU;
        legAmp = run ? 0.62 : 0.40;
        kneeAmp = run ? 0.90 : 0.52;
        const bob = run ? 0.05 : 0.024;
        bodyY = (0.5 - 0.5 * Math.cos(this._gait * 2)) * bob;
        bodyRoll = Math.sin(this._gait) * (run ? 0.055 : 0.030);
        bodyPitch = run ? 0.07 : 0.02;
        headPose = Math.sin(this._gait * 2 + 0.6) * 0.05;
        tailPose = Math.sin(this._gait * 2) * 0.22;
        earPose = run ? 0.30 : 0.12;
        this._grazeAmt = damp(this._grazeAmt, 0, 12, dt);
        break;
      }
      case ANIM.JUMP:
      case ANIM.FALL: {
        const flail = anim === ANIM.FALL ? Math.sin(this._t * 9) * 0.18 : 0;
        _hipPose[0] = _hipPose[1] = -0.75 + flail;
        _kneePose[0] = _kneePose[1] = 1.25;
        _hipPose[2] = _hipPose[3] = 0.70 - flail;
        _kneePose[2] = _kneePose[3] = -1.15;
        bodyPitch = anim === ANIM.JUMP ? -0.12 : 0.10;
        tailPose = 0.45;
        earPose = -0.25;
        break;
      }
      case ANIM.GLIDE: {
        const w = Math.sin(this._t * 2.2) * 0.10;
        _hipPose[0] = _hipPose[1] = -0.55 + w;
        _hipPose[2] = _hipPose[3] = 0.55 - w;
        _kneePose[0] = _kneePose[1] = 0.30;
        _kneePose[2] = _kneePose[3] = -0.30;
        spread = 0.42;
        bodyPitch = (flags & FLAG.PARACHUTE) ? -0.10 : 0.22;
        bodyRoll = Math.sin(this._t * 1.4) * 0.09;
        tailPose = 0.40;
        earPose = -0.35;
        break;
      }
      case ANIM.HEADBUTT: {
        // plongee de l'encolure sur ~0.25 s
        const k = Math.sin(clamp(this._animT / 0.25, 0, 1) * Math.PI);
        neckPose = 0.90 * k;
        headPose = 0.35 * k;
        bodyPitch = 0.20 * k;
        bodyY = -0.02 * k;
        _hipPose[0] = _hipPose[1] = -0.45 * k;
        _hipPose[2] = _hipPose[3] = 0.30 * k;
        earPose = 0.40;
        tailPose = 0.25;
        break;
      }
      case ANIM.DOWNED: {
        // couchee sur le flanc, les pattes gigotent dans le vide
        bodyY = -0.52;
        bodyRoll = 1.42;
        neckPose = 0.35;
        for (let i = 0; i < 4; i++) {
          _hipPose[i] = Math.sin(this._t * 4.5 + i * 1.7) * 0.38 + (LEG_FRONT[i] ? -0.2 : 0.2);
          _kneePose[i] = (0.45 + Math.sin(this._t * 5.2 + i) * 0.2) * (LEG_FRONT[i] ? 1 : -1);
        }
        spread = 0; // sinon les pattes traversent le sol une fois le corps roule
        earPose = 0.5;
        break;
      }
      case ANIM.DRIVE: {
        bodyY = -0.14;
        bodyPitch = -0.14;
        _hipPose[0] = _hipPose[1] = -0.95;
        _kneePose[0] = _kneePose[1] = 1.45;
        _hipPose[2] = _hipPose[3] = 1.25;
        _kneePose[2] = _kneePose[3] = -1.45;
        earPose = 0.35 + Math.sin(this._t * 3) * 0.08;
        tailPose = 0.15;
        break;
      }
      case ANIM.CLIMB: {
        const p = this._t * 4.2;
        spread = 0.55;
        for (let i = 0; i < 4; i++) {
          _hipPose[i] = Math.sin(p + LEG_PHASE[i]) * 0.60;
          _kneePose[i] = (0.35 + 0.35 * Math.cos(p + LEG_PHASE[i])) * (LEG_FRONT[i] ? 1 : -1);
        }
        bodyPitch = -0.45;
        bodyY = 0.03;
        neckPose = -0.20;
        tailPose = 0.30;
        break;
      }
      case ANIM.SWIM: {
        const p = this._t * 6.5;
        bodyY = -0.40;
        bodyPitch = -0.14 + Math.sin(p * 0.5) * 0.05;
        bodyRoll = Math.sin(p * 0.33) * 0.08;
        neckPose = -0.45;
        headPose = -0.10;
        for (let i = 0; i < 4; i++) {
          _hipPose[i] = Math.sin(p + LEG_PHASE[i]) * 0.70;
          _kneePose[i] = (0.5 + 0.5 * Math.sin(p + LEG_PHASE[i] + 1.2)) * 0.7 * (LEG_FRONT[i] ? 1 : -1);
        }
        tailPose = 0.20;
        earPose = 0.25;
        break;
      }
      default: { // IDLE
        bodyY = (0.5 - 0.5 * Math.cos(this._t * 1.7)) * 0.022; // respiration
        bodyRoll = Math.sin(this._t * 0.8) * 0.012;
        // la chevre broute de temps en temps (phase propre a l'instance)
        this._grazeIn -= dt;
        if (this._grazeIn <= 0) {
          this._grazing = !this._grazing;
          this._grazeIn = this._grazing ? 1.4 + Math.random() * 2.2 : 3 + Math.random() * 7;
        }
        this._grazeAmt = damp(this._grazeAmt, this._grazing ? 1 : 0, 3.5, dt);
        const gz = this._grazeAmt;
        neckPose = 0.95 * gz;
        headPose = 0.32 * gz + Math.sin(this._t * 5.5) * 0.06 * gz;
        headRoll = Math.sin(this._t * 3.1) * 0.10 * gz;
        tailPose = Math.sin(this._t * 2.2) * 0.10;
        earPose = Math.sin(this._t * 1.3) * 0.08;
        _kneePose[0] = _kneePose[1] = 0.10 * gz;
        break;
      }
    }
    // accroupi : bassin plus bas, pattes repliees (les sabots restent au sol)
    const cr = this._crouch;
    bodyY -= 0.15 * cr;
    for (let i = 0; i < 4; i++) {
      _hipPose[i] += (LEG_FRONT[i] ? -0.62 : 0.62) * cr;
      _kneePose[i] += (LEG_FRONT[i] ? 1.24 : -1.24) * cr;
    }
    // roulis dans les appuis lateraux
    const md = s.moveDir;
    if (md) {
      const c = Math.cos(this._bodyYaw), sn = Math.sin(this._bodyYaw);
      const lat = (md.x || 0) * c - (md.z || 0) * sn;
      bodyRoll -= lat * 0.10 * clamp(speed / GOAT.sprintSpeed, 0, 1);
    }

    // --- application de la pose --------------------------------------------
    this.body.position.y = BODY_Y + bodyY;
    this.body.rotation.set(bodyPitch, 0, bodyRoll);

    for (let i = 0; i < 4; i++) {
      const L = this.legs[i];
      let hipX = _hipPose[i];
      let kneeX = _kneePose[i];
      if (legAmp > 0) {
        const ph = this._gait + LEG_PHASE[i];
        const sw = Math.sin(ph);
        hipX += sw * legAmp;
        kneeX += Math.max(0, -sw) * kneeAmp * (L.front ? 1 : -1);
      }
      L.hip.rotation.x = hipX;
      L.hip.rotation.z = L.side * spread;
      L.knee.rotation.x = kneeX;
    }

    this.neck.rotation.x = NECK_TILT + neckPose - pitch * 0.25;
    this.neck.rotation.y = dYaw * 0.4;
    this.head.rotation.x = -pitch * 0.75 + headPose - this.neck.rotation.x;
    this.head.rotation.y = dYaw * 0.55;
    this.head.rotation.z = headRoll;

    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1;
      const ear = this.ears[i];
      ear.rotation.z = side * (0.55 + Math.sin(this._t * 1.6 + i * 2.1) * 0.10);
      ear.rotation.x = earPose + Math.sin(this._t * 2.4 + i) * 0.07;
    }
    this.tail.rotation.x = TAIL_REST + tailPose * 0.6;
    this.tail.rotation.z = Math.sin(this._t * 5 + this._gait) * 0.18 * (0.3 + tailPose);

    // parapente : seulement en chute libre / sous voile
    const chute = (flags & FLAG.PARACHUTE) !== 0 && anim === ANIM.GLIDE;
    this.chute.visible = chute;
    if (chute) {
      this.chute.rotation.z = Math.sin(this._t * 1.1) * 0.06;
      this.chute.rotation.x = Math.sin(this._t * 0.9 + 1) * 0.05;
    }

    // etiquettes : plus bas quand la chevre est a terre
    this._tagHolder.position.y = (anim === ANIM.DOWNED ? 0.95 : 1.95) * GOAT_SCALE;
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    if (this._barFillMat) { this._barFillMat.dispose(); this._barFillMat = null; }
    this.barBack = this.barFill = this.nameTag = null;
    this.root.clear();
  }
}

/** Cree une chevre. opts = { skin, isLocal, name, teamColor }. */
export function createGoatModel(opts) {
  return new GoatModel(opts || {});
}

/** Libere geometries, materiaux et textures partages. */
export function disposeGoatCache() {
  if (_geo) {
    for (const k in _geo) _geo[k].dispose();
    _geo = null;
  }
  _mats.forEach((m) => m.dispose());
  _mats.clear();
  _tags.forEach((e) => { if (e.mat.map) e.mat.map.dispose(); e.mat.dispose(); });
  _tags.clear();
  if (_barBack) { _barBack.dispose(); _barBack = null; }
}
