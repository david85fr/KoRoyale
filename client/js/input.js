// KoRoyale — couche d'entree unifiee : clavier/souris, manette et tactile.
//
// Le jeu doit se jouer indifferemment au clavier/souris, a la manette et au
// doigt. Tout converge ici vers UN SEUL objet InputFrame, reutilise a chaque
// poll() : aucune allocation dans la boucle de rendu.
//
// Conventions du monde (voir shared/math.js) :
//   avant = (sin yaw, cos yaw) — donc regarder a droite fait CROITRE yaw ;
//   moveY > 0 = avancer, moveX > 0 = pas de cote a droite ;
//   pitch > 0 = regarder vers le haut, borne a +-1.45 rad.
//
// Rien ne touche au DOM a l'import : le constructeur pose les ecouteurs, et la
// surcouche tactile n'est construite qu'au premier VRAI touchstart.

import { BTN, INVENTORY_SLOTS } from '../../shared/constants.js';
import { ACT } from '../../shared/protocol.js';
import { clamp, wrapAngle } from '../../shared/math.js';

// ---------------------------------------------------------------------------
// Reglages
// ---------------------------------------------------------------------------

const PITCH_LIMIT = 1.45;
const MOUSE_UNIT = 0.0022;   // rad par pixel de souris, a sensibilite 1
const TOUCH_UNIT = 0.0042;   // rad par pixel de glissement du pouce
const PAD_LOOK = 3.4;        // rad/s max au stick droit
const PAD_DEAD = 0.18;       // zone morte radiale des sticks
const PAD_TRIGGER = 0.3;     // seuil de declenchement des gachettes
const AIM_SENS = 0.42;       // facteur de sensibilite a fond de zoom
const TAP_MS = 220;          // duree max d'un tap tactile
const TAP_MOVE = 16;         // deplacement max (px) d'un tap tactile
const DOUBLE_TAP_MS = 300;
const FIRE_PULSE_MS = 110;   // duree du tir declenche par un tap
const HOLD_MS = 450;         // seuil d'« appui long » (relever un coequipier)
const GRENADE_MAX = 1.2;     // duree de charge max d'une grenade (s)
const SPRINT_STICK = 0.92;   // pousser le stick a fond = sprint

/** Classes DOM de la surcouche tactile (stylees par client/css/style.css). */
export const TOUCH_CLASSES = Object.freeze({
  layer: 'touch-layer',
  stick: 'touch-stick',
  stickBase: 'touch-stick__base',
  stickKnob: 'touch-stick__knob',
  look: 'touch-look',
  btn: 'touch-btn',
  active: 'is-active',
  slots: 'touch-slots',
  slot: 'touch-slot',
  slotSelected: 'is-selected',
  mod: Object.freeze({
    fire: 'touch-btn--fire', aim: 'touch-btn--aim', jump: 'touch-btn--jump',
    sprint: 'touch-btn--sprint', crouch: 'touch-btn--crouch', use: 'touch-btn--use',
    reload: 'touch-btn--reload', melee: 'touch-btn--melee', grenade: 'touch-btn--grenade',
    enter: 'touch-btn--enter', exit: 'touch-btn--exit', horn: 'touch-btn--horn',
    brake: 'touch-btn--brake', map: 'touch-btn--map', inventory: 'touch-btn--inventory',
    emote: 'touch-btn--emote', deploy: 'touch-btn--deploy',
  }),
});

// ---------------------------------------------------------------------------
// Tables clavier — tout passe par event.code, donc INDEPENDANT de la disposition.
// Le code 'KeyW' designe la touche physique en haut a gauche : W en QWERTY,
// Z en AZERTY. ZQSD et WASD marchent donc tous les deux sans rien declarer.
// ---------------------------------------------------------------------------

/** Touches maintenues -> bit BTN (Espace est traite a part : il depend du mode). */
const KEY_HOLD = {
  ShiftLeft: BTN.SPRINT, ShiftRight: BTN.SPRINT,
  ControlLeft: BTN.CROUCH, ControlRight: BTN.CROUCH, KeyC: BTN.CROUCH,
  KeyR: BTN.RELOAD,
  KeyE: BTN.USE,
  KeyV: BTN.MELEE,
  KeyH: BTN.HORN,
  KeyX: BTN.PING,
};
const KEY_HOLD_LIST = Object.keys(KEY_HOLD).map((code) => [code, KEY_HOLD[code]]);

/** Emplacements : rangee de chiffres et pave numerique. */
const KEY_SLOT = {
  Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4,
  Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3, Numpad5: 4,
};

/** Touches dont on bloque le comportement navigateur en partie. */
const KEY_SWALLOW = new Set([
  'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Slash', 'Quote', 'Backquote',
]);

/** Index des boutons de manette en « standard mapping ». */
const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  SELECT: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

// ---------------------------------------------------------------------------
// Boutons tactiles. Un bouton par role ; ceux qui ne concernent pas le mode
// courant sont simplement masques. Le CSS peut cibler la classe modificatrice
// ou l'attribut data-action.
// ---------------------------------------------------------------------------

const TOUCH_BUTTONS = [
  // --- a pied ---
  { act: 'fire', mod: 'fire', hold: BTN.FIRE, modes: ['foot'], label: 'Tir' },
  { act: 'aim', mod: 'aim', hold: BTN.AIM, modes: ['foot'], label: 'Visée' },
  { act: 'jump', mod: 'jump', hold: BTN.JUMP, modes: ['foot'], label: 'Saut' },
  { act: 'sprint', mod: 'sprint', hold: BTN.SPRINT, modes: ['foot'], label: 'Sprint', toggle: true },
  { act: 'crouch', mod: 'crouch', hold: BTN.CROUCH, modes: ['foot'], label: 'Accroupi' },
  { act: 'use', mod: 'use', hold: BTN.USE, modes: ['foot'], label: 'Action' },
  { act: 'reload', mod: 'reload', hold: BTN.RELOAD, modes: ['foot'], label: 'Recharger' },
  { act: 'melee', mod: 'melee', hold: BTN.MELEE, modes: ['foot'], label: 'Corne' },
  { act: 'grenade', mod: 'grenade', hold: 0, modes: ['foot'], label: 'Grenade' },
  { act: 'enter', mod: 'enter', hold: 0, modes: ['foot'], label: 'Monter' },
  { act: 'inventory', mod: 'inventory', hold: 0, modes: ['foot'], label: 'Sac' },
  { act: 'emote', mod: 'emote', hold: 0, modes: ['foot'], label: 'Émote' },
  // --- au volant : gaz et frein a droite, klaxon, frein a main, sortir ---
  { act: 'throttle', mod: 'sprint', hold: 0, modes: ['vehicle'], label: 'Gaz' },
  { act: 'brake', mod: 'brake', hold: 0, modes: ['vehicle'], label: 'Frein' },
  { act: 'handbrake', mod: 'crouch', hold: BTN.HANDBRAKE, modes: ['vehicle'], label: 'Frein à main' },
  { act: 'horn', mod: 'horn', hold: BTN.HORN, modes: ['vehicle'], label: 'Klaxon' },
  { act: 'exit', mod: 'exit', hold: 0, modes: ['vehicle'], label: 'Sortir' },
  // --- en vol : rien d'autre que le parapente et la carte ---
  { act: 'deploy', mod: 'deploy', hold: 0, modes: ['glide'], label: 'Parapente' },
  // --- spectateur ---
  { act: 'next', mod: 'use', hold: 0, modes: ['spectate'], label: 'Suivant' },
  // --- commun ---
  { act: 'map', mod: 'map', hold: 0, modes: ['foot', 'vehicle', 'glide', 'spectate'], label: 'Carte' },
];

const TOUCH_BY_ACT = new Map(TOUCH_BUTTONS.map((b) => [b.act, b]));

// ---------------------------------------------------------------------------
// Temporaires au niveau module : zero allocation dans poll().
// ---------------------------------------------------------------------------

const _stick = { x: 0, y: 0, m: 0 };
const _acc = { mx: 0, my: 0, btn: 0, zoom: 0, lookX: 0, lookY: 0 };

/** Zone morte radiale + courbe quadratique. Ecrit dans `out`, renvoie l'amplitude. */
function readStick(x, y, out) {
  const len = Math.hypot(x, y);
  if (!(len > PAD_DEAD)) { out.x = 0; out.y = 0; out.m = 0; return 0; }
  const n = Math.min(1, (len - PAD_DEAD) / (1 - PAD_DEAD));
  const c = n * n; // reponse quadratique : fin au centre, franc au bord
  out.x = (x / len) * c;
  out.y = (y / len) * c;
  out.m = c;
  return c;
}

function padButton(pad, i) {
  const b = pad.buttons[i];
  if (!b) return 0;
  return typeof b === 'number' ? b : (b.value || (b.pressed ? 1 : 0));
}

function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  const n = t.tagName;
  return n === 'INPUT' || n === 'TEXTAREA' || n === 'SELECT' || t.isContentEditable === true;
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------

export class InputManager {
  constructor(opts = {}) {
    this.canvas = opts.canvas || null;
    this.touchRoot = opts.touchRoot || null;
    this._onActionCb = typeof opts.onAction === 'function' ? opts.onAction : null;
    this._onDeviceCb = typeof opts.onDeviceChange === 'function' ? opts.onDeviceChange : null;

    this.mode = 'menu';
    this.sensitivity = 1;
    this.invertY = false;
    this.slotCount = INVENTORY_SLOTS;
    this.touchLayout = 'default';

    /** L'unique InputFrame, recycle a chaque poll(). */
    this.frame = {
      moveX: 0, moveY: 0,
      yaw: 0, pitch: 0,
      lookDeltaX: 0, lookDeltaY: 0,
      buttons: 0, slot: -1, zoom: 0,
    };

    // --- clavier / souris ---
    this._keys = new Set();
    this._mouseBtn = 0;
    this._mouseDX = 0;
    this._mouseDY = 0;
    this._locked = false;

    // --- etat partage ---
    this._slot = 0;
    this._frameSlot = -1;
    this._grenadeAt = 0;   // horodatage du debut de charge (0 = pas de charge)
    this._useAt = 0;       // debut d'appui sur « interagir »
    this._useLong = false;
    this._emote = 0;
    this._leftPlane = false; // a-t-on deja saute du planeur ?
    this._device = 'keyboard';

    // --- manette ---
    this._padIndex = -1;
    this._padSeen = false;
    this._padPrev = new Uint8Array(20);
    this._padRamp = 0;
    this._padUseAt = 0;
    this._padUseLong = false;

    // --- tactile ---
    this._canTouch = this._detectTouch();
    this._coarse = this._detectCoarse();
    this._touchUsed = false;
    this._dom = null;
    this._pointers = new Map();
    this._stickId = -1;
    this._stickX = 0; this._stickY = 0;
    this._stickOX = 0; this._stickOY = 0;
    this._stickR = 54;
    this._touchHold = 0;
    this._touchToggle = 0;
    this._touchThrottle = false;
    this._touchBrake = false;
    this._touchAim = false;
    this._touchLookX = 0;
    this._touchLookY = 0;
    this._touchFireUntil = 0;
    this._lastTapAt = 0;

    this._bind();
  }

  // -------------------------------------------------------------------------
  // Accesseurs publics
  // -------------------------------------------------------------------------

  get pointerLocked() { return this._locked; }

  /**
   * Vrai si l'on doit jouer au doigt : soit un vrai toucher a eu lieu, soit
   * l'appareil n'a QUE des pointeurs grossiers (telephone, tablette). Un PC
   * a ecran tactile garde donc le verrouillage de souris.
   */
  get isTouch() { return this._touchUsed || (this._canTouch && this._coarse); }

  get hasGamepad() { return this._padSeen; }

  get lastDevice() { return this._device; }

  // -------------------------------------------------------------------------
  // Reglages
  // -------------------------------------------------------------------------

  setMode(mode) {
    const m = (mode === 'foot' || mode === 'vehicle' || mode === 'glide'
      || mode === 'spectate' || mode === 'menu') ? mode : 'foot';
    if (m === this.mode) return;
    this.mode = m;
    if (m === 'glide') this._leftPlane = false;
    if (m === 'menu') this._releaseAll();
    this._resetTouchHolds();
    this._applyMode();
  }

  setSensitivity(v) {
    const n = Number(v);
    this.sensitivity = Number.isFinite(n) ? clamp(n, 0.05, 8) : 1;
  }

  setInvertY(b) { this.invertY = !!b; }

  setTouchLayout(name) {
    this.touchLayout = name === 'lefty' ? 'lefty' : 'default';
    if (this._dom) this._dom.layer.dataset.layout = this.touchLayout;
    this._releaseStick();
  }

  setSlotCount(n) {
    const c = clamp(Math.round(Number(n) || 0), 1, 10);
    if (c === this.slotCount) return;
    this.slotCount = c;
    if (this._slot >= c) this._slot = c - 1;
    this._buildSlots();
  }

  setYawPitch(yaw, pitch) {
    if (Number.isFinite(yaw)) this.frame.yaw = wrapAngle(yaw);
    if (Number.isFinite(pitch)) this.frame.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  // -------------------------------------------------------------------------
  // Verrouillage du pointeur
  // -------------------------------------------------------------------------

  requestPointerLock() {
    if (!this.canvas || this.isTouch || this._locked) return;
    if (typeof this.canvas.requestPointerLock !== 'function') return;
    try {
      // Chrome renvoie desormais une promesse : sans .catch(), un refus (verrouillage
      // demande hors geste utilisateur) remonte en erreur non capturee dans la console.
      const r = this.canvas.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* refus du navigateur */ }
  }

  exitPointerLock() {
    if (typeof document === 'undefined' || !document.exitPointerLock) return;
    if (document.pointerLockElement) { try { document.exitPointerLock(); } catch { /* rien */ } }
  }

  // -------------------------------------------------------------------------
  // Vibration (manette, sinon moteur du telephone)
  // -------------------------------------------------------------------------

  vibrate(strong = 0.5, weak = 0.4, ms = 120) {
    const dur = clamp(Math.round(ms) || 0, 10, 1200);
    const pad = this._pad();
    const act = pad && (pad.vibrationActuator
      || (pad.hapticActuators && pad.hapticActuators[0]));
    if (act && typeof act.playEffect === 'function') {
      try {
        act.playEffect('dual-rumble', {
          startDelay: 0, duration: dur,
          strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1),
        });
        return;
      } catch { /* type d'effet non supporte */ }
    }
    if (this._touchUsed && typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(Math.min(200, dur)); } catch { /* refus */ }
    }
  }

  // -------------------------------------------------------------------------
  // Boucle : une seule lecture par frame
  // -------------------------------------------------------------------------

  poll(dt) {
    const f = this.frame;
    const d = clamp(Number(dt) || 0, 0, 0.1);
    const t = nowMs();

    _acc.mx = 0; _acc.my = 0; _acc.btn = 0; _acc.zoom = 0;
    _acc.lookX = 0; _acc.lookY = 0;

    if (this.mode === 'menu') {
      this._mouseDX = 0; this._mouseDY = 0;
      this._touchLookX = 0; this._touchLookY = 0;
      f.moveX = 0; f.moveY = 0; f.buttons = 0; f.zoom = 0;
      f.slot = -1; f.lookDeltaX = 0; f.lookDeltaY = 0;
      return f;
    }

    this._pollKeyboard(_acc, t);
    this._pollMouse(_acc);
    this._pollGamepad(_acc, d, t);
    this._pollTouch(_acc, t);

    // --- deplacement : norme au plus 1 ---
    let mx = clamp(_acc.mx, -1, 1);
    let my = clamp(_acc.my, -1, 1);
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    f.moveX = mx; f.moveY = my;

    // --- visee : la sensibilite fond quand on zoome ---
    const zoom = clamp(_acc.zoom, 0, 1);
    const soft = 1 + (AIM_SENS - 1) * zoom;
    const dx = _acc.lookX * soft;
    const dy = (this.invertY ? -_acc.lookY : _acc.lookY) * soft;
    f.yaw = wrapAngle(f.yaw + dx);
    f.pitch = clamp(f.pitch + dy, -PITCH_LIMIT, PITCH_LIMIT);
    f.lookDeltaX = dx;
    f.lookDeltaY = dy;

    // --- boutons ---
    let btn = _acc.btn;
    if (zoom > 0.2) btn |= BTN.AIM;
    f.buttons = btn;
    f.zoom = zoom;

    // --- emplacement demande ce frame ---
    f.slot = this._frameSlot;
    this._frameSlot = -1;
    return f;
  }

  // -------------------------------------------------------------------------
  // Clavier
  // -------------------------------------------------------------------------

  _pollKeyboard(acc, t) {
    const k = this._keys;
    if (!k.size) return;

    let x = 0, y = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    acc.mx += x; acc.my += y;

    for (let i = 0; i < KEY_HOLD_LIST.length; i++) {
      const e = KEY_HOLD_LIST[i];
      if (k.has(e[0])) acc.btn |= e[1];
    }
    // Espace : saut a pied / en vol, frein a main au volant.
    if (k.has('Space')) acc.btn |= this.mode === 'vehicle' ? BTN.HANDBRAKE : BTN.JUMP;
    if (this._mouseBtn & BTN.AIM) acc.zoom = Math.max(acc.zoom, 1);

    // « Interagir » maintenu longtemps = relever un coequipier a terre.
    if (this._useAt && !this._useLong && t - this._useAt > HOLD_MS) {
      this._useLong = true;
      this._send({ type: ACT.REVIVE });
    }
  }

  // -------------------------------------------------------------------------
  // Souris
  // -------------------------------------------------------------------------

  _pollMouse(acc) {
    acc.btn |= this._mouseBtn;
    if (this._mouseDX || this._mouseDY) {
      const s = MOUSE_UNIT * this.sensitivity;
      acc.lookX += this._mouseDX * s;
      acc.lookY += -this._mouseDY * s; // ecran vers le bas = regarder plus bas
      this._mouseDX = 0; this._mouseDY = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Manette
  // -------------------------------------------------------------------------

  _pad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    let pads;
    try { pads = navigator.getGamepads(); } catch { return null; }
    if (!pads) return null;
    const cur = this._padIndex >= 0 ? pads[this._padIndex] : null;
    if (cur && cur.connected) return cur;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected) { this._padIndex = i; return p; }
    }
    this._padIndex = -1;
    return null;
  }

  _pollGamepad(acc, d, t) {
    const pad = this._pad();
    if (!pad) {
      if (this._padSeen) { this._padSeen = false; this._padPrev.fill(0); }
      return;
    }
    this._padSeen = true;
    const veh = this.mode === 'vehicle';
    const ax = pad.axes;
    let active = false;

    // --- stick gauche : deplacement (ou direction au volant) ---
    readStick(ax[0] || 0, ax[1] || 0, _stick);
    if (_stick.m > 0) {
      active = true;
      acc.mx += _stick.x;
      if (!veh) acc.my += -_stick.y;
      if (!veh && _stick.m > SPRINT_STICK) acc.btn |= BTN.SPRINT;
    }

    // --- stick droit : visee, acceleration progressive ---
    readStick(ax[2] || 0, ax[3] || 0, _stick);
    if (_stick.m > 0) {
      active = true;
      this._padRamp = Math.min(1, this._padRamp + d * 2.4);
    } else {
      this._padRamp = 0;
    }
    if (_stick.m > 0) {
      const boost = 0.55 + 0.75 * this._padRamp * this._padRamp;
      const s = PAD_LOOK * this.sensitivity * boost * d;
      acc.lookX += _stick.x * s;
      acc.lookY += -_stick.y * s;
    }

    // --- gachettes analogiques ---
    const rt = padButton(pad, PAD.RT);
    const lt = padButton(pad, PAD.LT);
    if (veh) {
      if (rt > 0.05) acc.my += rt;
      if (lt > 0.05) acc.my -= lt;
    } else {
      if (rt > PAD_TRIGGER) acc.btn |= BTN.FIRE;
      acc.zoom = Math.max(acc.zoom, lt);
    }
    if (rt > PAD_TRIGGER || lt > PAD_TRIGGER) active = true;

    // --- boutons maintenus ---
    const a = padButton(pad, PAD.A) > 0.5;
    const b = padButton(pad, PAD.B) > 0.5;
    const x = padButton(pad, PAD.X) > 0.5;
    if (veh) {
      if (a) acc.btn |= BTN.HANDBRAKE;
      if (padButton(pad, PAD.RB) > 0.5) acc.btn |= BTN.HORN;
    } else {
      if (a && this.mode === 'foot') acc.btn |= BTN.JUMP;
      if (b) acc.btn |= BTN.CROUCH;
      if (padButton(pad, PAD.RB) > 0.5) acc.btn |= BTN.MELEE;
    }
    if (x) acc.btn |= BTN.USE;
    if (padButton(pad, PAD.L3) > 0.5) acc.btn |= BTN.SPRINT;
    if (a || b || x) active = true;

    // --- fronts montants / descendants ---
    this._padEdges(pad, t, veh);

    if (active) this._setDevice('gamepad');
  }

  _padEdges(pad, t, veh) {
    const prev = this._padPrev;
    const n = Math.min(prev.length, pad.buttons.length);
    for (let i = 0; i < n; i++) {
      const down = padButton(pad, i) > 0.5 ? 1 : 0;
      const was = prev[i];
      prev[i] = down;
      if (down === was) continue;
      if (down) this._padDown(i, t, veh);
      else this._padUp(i, t);
    }
    // appui long sur « interagir » = relever
    if (this._padUseAt && !this._padUseLong && t - this._padUseAt > HOLD_MS) {
      this._padUseLong = true;
      this._send({ type: ACT.REVIVE });
    }
  }

  _padDown(i, t, veh) {
    this._setDevice('gamepad');
    switch (i) {
      case PAD.A:
        if (this.mode === 'glide') this._glideAction();
        else if (this.mode === 'spectate') this._send({ type: ACT.SPECTATE_NEXT });
        break;
      case PAD.X:
        this._padUseAt = t; this._padUseLong = false;
        if (veh) this._send({ type: ACT.EXIT_VEHICLE });
        else this._send({ type: ACT.USE });
        break;
      case PAD.Y:
        if (!veh) this._cycleSlot(1);
        break;
      case PAD.LB:
        if (!veh) this._grenadeAt = t;
        break;
      case PAD.R3:
        this._send({ type: ACT.MARK });
        break;
      case PAD.START:
        this._send({ type: 'ui', name: 'menu' });
        break;
      case PAD.SELECT:
        this._send({ type: 'ui', name: 'map' });
        break;
      case PAD.UP: veh ? this._send({ type: ACT.SEAT, seat: 0 }) : this._selectSlot(0); break;
      case PAD.DOWN: veh ? this._send({ type: ACT.SEAT, seat: 2 }) : this._selectSlot(this.slotCount - 1); break;
      case PAD.LEFT: veh ? this._send({ type: ACT.SEAT, seat: 3 }) : this._cycleSlot(-1); break;
      case PAD.RIGHT: veh ? this._send({ type: ACT.SEAT, seat: 1 }) : this._cycleSlot(1); break;
      default: break;
    }
  }

  _padUp(i, t) {
    if (i === PAD.LB) this._throwGrenade(t);
    if (i === PAD.X) { this._padUseAt = 0; this._padUseLong = false; }
  }

  // -------------------------------------------------------------------------
  // Tactile (lecture par frame)
  // -------------------------------------------------------------------------

  _pollTouch(acc, t) {
    if (!this._touchUsed) return;
    if (this.mode === 'vehicle') {
      acc.mx += this._stickX;
      if (this._touchThrottle) acc.my += 1;
      if (this._touchBrake) acc.my -= 1;
    } else {
      acc.mx += this._stickX;
      acc.my += this._stickY;
      if (Math.hypot(this._stickX, this._stickY) > SPRINT_STICK) acc.btn |= BTN.SPRINT;
    }
    acc.btn |= this._touchHold | this._touchToggle;
    if (t < this._touchFireUntil) acc.btn |= BTN.FIRE;
    if (this._touchAim) acc.zoom = Math.max(acc.zoom, 1);
    if (this._touchLookX || this._touchLookY) {
      const s = TOUCH_UNIT * this.sensitivity;
      acc.lookX += this._touchLookX * s;
      acc.lookY += -this._touchLookY * s;
      this._touchLookX = 0; this._touchLookY = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Actions communes
  // -------------------------------------------------------------------------

  _send(obj) {
    if (!this._onActionCb) return;
    try { this._onActionCb(obj); } catch (err) { console.error('[input] action', err); }
  }

  _setDevice(d) {
    if (d === this._device) return;
    this._device = d;
    if (this._onDeviceCb) {
      try { this._onDeviceCb(d); } catch (err) { console.error('[input] device', err); }
    }
  }

  _selectSlot(n) {
    const s = clamp(Math.round(n) || 0, 0, this.slotCount - 1);
    this._slot = s;
    this._frameSlot = s;
    this._send({ type: ACT.SLOT, slot: s });
    this._paintSlots();
  }

  _cycleSlot(delta) {
    const c = this.slotCount;
    this._selectSlot(((this._slot + delta) % c + c) % c);
  }

  _throwGrenade(t) {
    if (!this._grenadeAt) return;
    const charge = clamp((t - this._grenadeAt) / (GRENADE_MAX * 1000), 0.15, 1);
    this._grenadeAt = 0;
    this._send({ type: ACT.THROW, charge });
  }

  /** En vol : premier appui = sauter du planeur, ensuite = ouvrir le parapente. */
  _glideAction() {
    if (!this._leftPlane) { this._leftPlane = true; this._send({ type: ACT.JUMP_OUT }); }
    else this._send({ type: ACT.DEPLOY });
  }

  _emoteNext() {
    const id = this._emote;
    this._emote = (this._emote + 1) % 4;
    this._send({ type: ACT.EMOTE, id });
  }

  // -------------------------------------------------------------------------
  // Ecouteurs
  // -------------------------------------------------------------------------

  _bind() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const w = window, d = document;

    this._h = {
      keydown: (e) => this._onKeyDown(e),
      keyup: (e) => this._onKeyUp(e),
      blur: () => this._releaseAll(),
      visibility: () => { if (d.hidden) this._releaseAll(); },
      mousemove: (e) => this._onMouseMove(e),
      mousedown: (e) => this._onMouseDown(e),
      mouseup: (e) => this._onMouseUp(e),
      wheel: (e) => this._onWheel(e),
      context: (e) => { if (this.mode !== 'menu') e.preventDefault(); },
      lock: () => this._onLockChange(),
      padOn: (e) => { this._padIndex = e.gamepad ? e.gamepad.index : this._padIndex; this._padSeen = true; },
      padOff: () => { this._padIndex = -1; this._padSeen = false; this._padPrev.fill(0); },
      tstart: (e) => this._onTouchStart(e),
      tmove: (e) => this._onTouchMove(e),
      tend: (e) => this._onTouchEnd(e, false),
      tcancel: (e) => this._onTouchEnd(e, true),
    };

    w.addEventListener('keydown', this._h.keydown);
    w.addEventListener('keyup', this._h.keyup);
    w.addEventListener('blur', this._h.blur);
    d.addEventListener('visibilitychange', this._h.visibility);
    w.addEventListener('mousemove', this._h.mousemove);
    w.addEventListener('mousedown', this._h.mousedown);
    w.addEventListener('mouseup', this._h.mouseup);
    w.addEventListener('wheel', this._h.wheel, { passive: false });
    d.addEventListener('pointerlockchange', this._h.lock);
    d.addEventListener('pointerlockerror', this._h.lock);
    w.addEventListener('gamepadconnected', this._h.padOn);
    w.addEventListener('gamepaddisconnected', this._h.padOff);
    if (this.canvas) this.canvas.addEventListener('contextmenu', this._h.context);

    if (this._canTouch) {
      // On ecoute la fenetre (capture) : la surcouche peut avoir
      // pointer-events:none dans le CSS, on ne veut pas en dependre.
      w.addEventListener('touchstart', this._h.tstart, { passive: false, capture: true });
      w.addEventListener('touchmove', this._h.tmove, { passive: false, capture: true });
      w.addEventListener('touchend', this._h.tend, { passive: false, capture: true });
      w.addEventListener('touchcancel', this._h.tcancel, { passive: false, capture: true });
    }
  }

  _detectTouch() {
    if (typeof window === 'undefined') return false;
    if ('ontouchstart' in window) return true;
    return typeof navigator !== 'undefined' && (navigator.maxTouchPoints | 0) > 0;
  }

  _detectCoarse() {
    if (typeof window === 'undefined' || !window.matchMedia) return this._canTouch;
    try { return !window.matchMedia('(pointer: fine)').matches; } catch { return false; }
  }

  // -------------------------------------------------------------------------
  // Clavier : evenements
  // -------------------------------------------------------------------------

  _onKeyDown(e) {
    if (isTypingTarget(e.target)) return;
    const code = e.code;
    if (this.mode !== 'menu' && KEY_SWALLOW.has(code)) e.preventDefault();
    this._setDevice('keyboard');

    if (code === 'Escape') { this._send({ type: 'ui', name: 'menu' }); return; }
    if (this.mode === 'menu') return;
    if (e.repeat) return;
    if (this._keys.has(code)) return;
    this._keys.add(code);

    const veh = this.mode === 'vehicle';
    switch (code) {
      case 'Space':
        if (this.mode === 'glide') this._glideAction();
        else if (this.mode === 'spectate') this._send({ type: ACT.SPECTATE_NEXT });
        break;
      case 'KeyE':
        this._useAt = nowMs(); this._useLong = false;
        if (this.mode === 'spectate') this._send({ type: ACT.SPECTATE_NEXT });
        else this._send({ type: ACT.USE });
        break;
      case 'KeyF':
        if (this.mode === 'glide') this._glideAction();
        else this._send({ type: veh ? ACT.EXIT_VEHICLE : ACT.ENTER_VEHICLE });
        break;
      case 'KeyG': this._grenadeAt = nowMs(); break;
      case 'KeyJ': this._send({ type: ACT.DROP }); break; // « jeter »
      case 'KeyB': this._emoteNext(); break;
      case 'KeyX': this._send({ type: ACT.MARK }); break;
      case 'KeyZ': this._send({ type: ACT.USE_ITEM, id: 'bandage' }); break;
      case 'KeyU': this._send({ type: ACT.USE_ITEM, id: 'shieldSmall' }); break;
      case 'Tab': this._send({ type: 'ui', name: 'scoreboard', down: true }); break;
      case 'KeyM': this._send({ type: 'ui', name: 'map' }); break;
      case 'KeyI': this._send({ type: 'ui', name: 'inventory' }); break;
      case 'Enter': case 'NumpadEnter': this._send({ type: 'ui', name: 'chat' }); break;
      default: {
        const slot = KEY_SLOT[code];
        if (slot !== undefined) {
          if (veh) this._send({ type: ACT.SEAT, seat: slot });
          else this._selectSlot(slot);
        }
        break;
      }
    }
  }

  _onKeyUp(e) {
    const code = e.code;
    if (!this._keys.delete(code)) return;
    if (this.mode !== 'menu' && KEY_SWALLOW.has(code)) e.preventDefault();
    if (code === 'KeyG') this._throwGrenade(nowMs());
    if (code === 'KeyE') { this._useAt = 0; this._useLong = false; }
    if (code === 'Tab') this._send({ type: 'ui', name: 'scoreboard', down: false });
  }

  // -------------------------------------------------------------------------
  // Souris : evenements
  // -------------------------------------------------------------------------

  _onMouseMove(e) {
    if (!this._locked || this.mode === 'menu') return;
    this._mouseDX += e.movementX || 0;
    this._mouseDY += e.movementY || 0;
    if (e.movementX || e.movementY) this._setDevice('keyboard');
  }

  _onMouseDown(e) {
    if (isTypingTarget(e.target)) return;
    if (this.mode === 'menu') return;
    const onCanvas = !this.canvas || e.target === this.canvas;
    if (onCanvas && !this._locked) { this.requestPointerLock(); }
    if (!this._locked && !onCanvas) return;
    this._setDevice('keyboard');
    if (e.button === 0) {
      this._mouseBtn |= BTN.FIRE;
      if (this.mode === 'spectate') this._send({ type: ACT.SPECTATE_NEXT });
    } else if (e.button === 2) {
      this._mouseBtn |= BTN.AIM;
      e.preventDefault();
    }
  }

  _onMouseUp(e) {
    if (e.button === 0) this._mouseBtn &= ~BTN.FIRE;
    else if (e.button === 2) this._mouseBtn &= ~BTN.AIM;
  }

  _onWheel(e) {
    if (this.mode !== 'foot') return;
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    const dy = e.deltaY || 0;
    if (dy > 0) this._cycleSlot(1);
    else if (dy < 0) this._cycleSlot(-1);
    this._setDevice('keyboard');
  }

  _onLockChange() {
    const locked = typeof document !== 'undefined'
      && document.pointerLockElement === (this.canvas || document.pointerLockElement);
    this._locked = !!(typeof document !== 'undefined' && document.pointerLockElement) && locked;
    if (!this._locked) { this._mouseBtn = 0; this._mouseDX = 0; this._mouseDY = 0; }
  }

  // -------------------------------------------------------------------------
  // Tactile : evenements
  // -------------------------------------------------------------------------

  _touchOK(target) {
    if (this.mode === 'menu') return false;
    if (!target || !target.closest) return true;
    // on laisse passer l'interface hors partie et les vrais controles HTML
    const ui = target.closest('button, input, select, textarea, a, #ui');
    if (ui && !(this._dom && this._dom.layer.contains(ui))) return false;
    return true;
  }

  _onTouchStart(e) {
    if (!this._touchOK(e.target)) return;
    this._setDevice('touch');
    if (!this._touchUsed) { this._touchUsed = true; this._buildTouch(); }
    const list = e.changedTouches;
    for (let i = 0; i < list.length; i++) this._beginTouch(list[i]);
    e.preventDefault();
  }

  _beginTouch(t) {
    const el = t.target && t.target.closest ? t.target : null;
    const btn = el ? el.closest('.' + TOUCH_CLASSES.btn) : null;
    if (btn && this._dom && this._dom.layer.contains(btn)) {
      const desc = TOUCH_BY_ACT.get(btn.dataset.action);
      if (desc) { this._pointers.set(t.identifier, { kind: 'btn', el: btn, desc }); this._pressBtn(desc, btn); }
      return;
    }
    const slot = el ? el.closest('.' + TOUCH_CLASSES.slot) : null;
    if (slot && this._dom && this._dom.layer.contains(slot)) {
      this._pointers.set(t.identifier, { kind: 'slot' });
      this._selectSlot(Number(slot.dataset.slot) || 0);
      return;
    }
    // zones libres : moitie gauche = joystick flottant, moitie droite = visee
    const w = (typeof window !== 'undefined' ? window.innerWidth : 800) || 800;
    const leftHalf = t.clientX < w * 0.5;
    const stickSide = this.touchLayout === 'lefty' ? !leftHalf : leftHalf;
    if (stickSide && this._stickId < 0) this._beginStick(t);
    else this._pointers.set(t.identifier, {
      kind: 'look', x: t.clientX, y: t.clientY, t0: nowMs(), moved: 0,
    });
  }

  _beginStick(t) {
    this._stickId = t.identifier;
    this._stickOX = t.clientX; this._stickOY = t.clientY;
    this._stickX = 0; this._stickY = 0;
    this._pointers.set(t.identifier, { kind: 'stick' });
    const dom = this._dom;
    if (!dom) return;
    const w = (typeof window !== 'undefined' ? window.innerWidth : 800) || 800;
    const h = (typeof window !== 'undefined' ? window.innerHeight : 600) || 600;
    this._stickR = clamp(Math.min(w, h) * 0.13, 38, 72);
    dom.stick.style.display = '';
    dom.stick.style.left = t.clientX + 'px';
    dom.stick.style.top = t.clientY + 'px';
    dom.knob.style.transform = 'translate(0px, 0px)';
  }

  _onTouchMove(e) {
    if (!this._pointers.size) return;
    const list = e.changedTouches;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const p = this._pointers.get(t.identifier);
      if (!p) continue;
      if (p.kind === 'stick') this._moveStick(t);
      else if (p.kind === 'look') {
        const dx = t.clientX - p.x, dy = t.clientY - p.y;
        p.x = t.clientX; p.y = t.clientY;
        p.moved += Math.abs(dx) + Math.abs(dy);
        this._touchLookX += dx;
        this._touchLookY += dy;
      }
    }
    e.preventDefault();
  }

  _moveStick(t) {
    let dx = t.clientX - this._stickOX;
    let dy = t.clientY - this._stickOY;
    const R = this._stickR;
    const len = Math.hypot(dx, dy);
    if (len > R) {
      // le centre suit le pouce : on ne « perd » jamais le joystick
      const over = len - R;
      this._stickOX += (dx / len) * over;
      this._stickOY += (dy / len) * over;
      dx = (dx / len) * R; dy = (dy / len) * R;
      const dom = this._dom;
      if (dom) {
        dom.stick.style.left = this._stickOX + 'px';
        dom.stick.style.top = this._stickOY + 'px';
      }
    }
    this._stickX = clamp(dx / R, -1, 1);
    this._stickY = clamp(-dy / R, -1, 1);
    if (this._dom) {
      this._dom.knob.style.transform = 'translate(' + dx.toFixed(1) + 'px, ' + dy.toFixed(1) + 'px)';
    }
  }

  _onTouchEnd(e, cancelled) {
    const list = e.changedTouches;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const p = this._pointers.get(t.identifier);
      if (!p) continue;
      this._pointers.delete(t.identifier);
      if (p.kind === 'stick') this._releaseStick();
      else if (p.kind === 'btn') this._releaseBtn(p.desc, p.el);
      else if (p.kind === 'look' && !cancelled) this._endLook(p);
    }
    if (this._pointers.size || !cancelled) e.preventDefault();
  }

  /** Tap court = tir ; double tap = bascule de visee. */
  _endLook(p) {
    const t = nowMs();
    if (t - p.t0 > TAP_MS || p.moved > TAP_MOVE) return;
    if (this.mode === 'spectate') { this._send({ type: ACT.SPECTATE_NEXT }); return; }
    if (this.mode !== 'foot') return;
    if (t - this._lastTapAt < DOUBLE_TAP_MS) {
      this._lastTapAt = 0;
      this._touchAim = !this._touchAim;
      this._paintBtn('aim', this._touchAim);
      return;
    }
    this._lastTapAt = t;
    this._touchFireUntil = t + FIRE_PULSE_MS;
  }

  _releaseStick() {
    this._stickId = -1;
    this._stickX = 0; this._stickY = 0;
    if (this._dom) {
      this._dom.stick.style.display = 'none';
      this._dom.knob.style.transform = 'translate(0px, 0px)';
    }
  }

  // -------------------------------------------------------------------------
  // Boutons tactiles
  // -------------------------------------------------------------------------

  _pressBtn(desc, el) {
    if (desc.toggle) {
      this._touchToggle ^= desc.hold;
      if (el) el.classList.toggle(TOUCH_CLASSES.active, (this._touchToggle & desc.hold) !== 0);
      return;
    }
    if (el) el.classList.add(TOUCH_CLASSES.active);
    if (desc.hold) this._touchHold |= desc.hold;
    switch (desc.act) {
      case 'aim': this._touchAim = true; break;
      case 'throttle': this._touchThrottle = true; break;
      case 'brake': this._touchBrake = true; break;
      case 'grenade': this._grenadeAt = nowMs(); break;
      case 'use': this._send({ type: ACT.USE }); break;
      case 'enter': this._send({ type: ACT.ENTER_VEHICLE }); break;
      case 'exit': this._send({ type: ACT.EXIT_VEHICLE }); break;
      case 'emote': this._emoteNext(); break;
      case 'deploy': this._glideAction(); break;
      case 'next': this._send({ type: ACT.SPECTATE_NEXT }); break;
      case 'map': this._send({ type: 'ui', name: 'map' }); break;
      case 'inventory': this._send({ type: 'ui', name: 'inventory' }); break;
      default: break;
    }
  }

  _releaseBtn(desc, el) {
    if (desc.toggle) return;
    if (el) el.classList.remove(TOUCH_CLASSES.active);
    if (desc.hold) this._touchHold &= ~desc.hold;
    switch (desc.act) {
      case 'aim': this._touchAim = false; break;
      case 'throttle': this._touchThrottle = false; break;
      case 'brake': this._touchBrake = false; break;
      case 'grenade': this._throwGrenade(nowMs()); break;
      default: break;
    }
  }

  _paintBtn(act, on) {
    const dom = this._dom;
    if (!dom) return;
    const el = dom.btns.get(act);
    if (el) el.classList.toggle(TOUCH_CLASSES.active, !!on);
  }

  _resetTouchHolds() {
    this._touchHold = 0;
    this._touchToggle = 0;
    this._touchThrottle = false;
    this._touchBrake = false;
    this._touchAim = false;
    this._touchFireUntil = 0;
    if (!this._dom) return;
    for (const el of this._dom.btns.values()) el.classList.remove(TOUCH_CLASSES.active);
  }

  // -------------------------------------------------------------------------
  // Surcouche tactile : construction paresseuse
  // -------------------------------------------------------------------------

  _buildTouch() {
    if (this._dom || !this.touchRoot || typeof document === 'undefined') return;
    const d = document;
    const layer = d.createElement('div');
    layer.className = TOUCH_CLASSES.layer;
    layer.dataset.mode = this.mode;
    layer.dataset.layout = this.touchLayout;
    // pose en dur : le blocage du defilement et du zoom ne doit pas dependre du CSS
    layer.style.touchAction = 'none';
    layer.style.userSelect = 'none';
    layer.style.webkitUserSelect = 'none';
    layer.style.webkitTapHighlightColor = 'transparent';

    const stick = d.createElement('div');
    stick.className = TOUCH_CLASSES.stick;
    stick.style.position = 'fixed';           // le joystick flotte sous le pouce
    stick.style.transform = 'translate(-50%, -50%)';
    stick.style.display = 'none';
    const base = d.createElement('div');
    base.className = TOUCH_CLASSES.stickBase;
    const knob = d.createElement('div');
    knob.className = TOUCH_CLASSES.stickKnob;
    base.appendChild(knob);
    stick.appendChild(base);
    layer.appendChild(stick);

    const look = d.createElement('div');
    look.className = TOUCH_CLASSES.look;
    layer.appendChild(look);

    const btns = new Map();
    for (let i = 0; i < TOUCH_BUTTONS.length; i++) {
      const desc = TOUCH_BUTTONS[i];
      const el = d.createElement('div');
      el.className = TOUCH_CLASSES.btn + ' ' + TOUCH_CLASSES.mod[desc.mod];
      el.dataset.action = desc.act;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', desc.label);
      el.textContent = desc.label;
      layer.appendChild(el);
      btns.set(desc.act, el);
    }

    const slots = d.createElement('div');
    slots.className = TOUCH_CLASSES.slots;
    layer.appendChild(slots);

    this.touchRoot.appendChild(layer);
    this._dom = { layer, stick, base, knob, look, btns, slots, slotEls: [] };
    this._buildSlots();
    this._applyMode();
  }

  _buildSlots() {
    const dom = this._dom;
    if (!dom) return;
    dom.slots.textContent = '';
    dom.slotEls.length = 0;
    for (let i = 0; i < this.slotCount; i++) {
      const el = document.createElement('div');
      el.className = TOUCH_CLASSES.slot;
      el.dataset.slot = String(i);
      el.textContent = String(i + 1);
      dom.slots.appendChild(el);
      dom.slotEls.push(el);
    }
    this._paintSlots();
  }

  _paintSlots() {
    const dom = this._dom;
    if (!dom) return;
    for (let i = 0; i < dom.slotEls.length; i++) {
      dom.slotEls[i].classList.toggle(TOUCH_CLASSES.slotSelected, i === this._slot);
    }
  }

  /** Montre les seuls boutons utiles au mode courant. */
  _applyMode() {
    const dom = this._dom;
    if (!dom) return;
    dom.layer.dataset.mode = this.mode;
    dom.layer.style.display = this.mode === 'menu' ? 'none' : '';
    for (let i = 0; i < TOUCH_BUTTONS.length; i++) {
      const desc = TOUCH_BUTTONS[i];
      const el = dom.btns.get(desc.act);
      if (el) el.style.display = desc.modes.indexOf(this.mode) >= 0 ? '' : 'none';
    }
    dom.slots.style.display = this.mode === 'foot' ? '' : 'none';
    this._releaseStick();
  }

  // -------------------------------------------------------------------------
  // Relachement global (blur, onglet cache, sortie de verrouillage)
  // -------------------------------------------------------------------------

  _releaseAll() {
    this._keys.clear();
    this._mouseBtn = 0;
    this._mouseDX = 0; this._mouseDY = 0;
    this._grenadeAt = 0;
    this._useAt = 0; this._useLong = false;
    this._padUseAt = 0; this._padUseLong = false;
    this._padPrev.fill(0);
    this._padRamp = 0;
    this._pointers.clear();
    this._touchLookX = 0; this._touchLookY = 0;
    this._releaseStick();
    this._resetTouchHolds();
  }

  // -------------------------------------------------------------------------

  destroy() {
    this._releaseAll();
    if (typeof window !== 'undefined' && this._h) {
      const w = window, d = document;
      w.removeEventListener('keydown', this._h.keydown);
      w.removeEventListener('keyup', this._h.keyup);
      w.removeEventListener('blur', this._h.blur);
      d.removeEventListener('visibilitychange', this._h.visibility);
      w.removeEventListener('mousemove', this._h.mousemove);
      w.removeEventListener('mousedown', this._h.mousedown);
      w.removeEventListener('mouseup', this._h.mouseup);
      w.removeEventListener('wheel', this._h.wheel, { passive: false });
      d.removeEventListener('pointerlockchange', this._h.lock);
      d.removeEventListener('pointerlockerror', this._h.lock);
      w.removeEventListener('gamepadconnected', this._h.padOn);
      w.removeEventListener('gamepaddisconnected', this._h.padOff);
      if (this.canvas) this.canvas.removeEventListener('contextmenu', this._h.context);
      w.removeEventListener('touchstart', this._h.tstart, { capture: true });
      w.removeEventListener('touchmove', this._h.tmove, { capture: true });
      w.removeEventListener('touchend', this._h.tend, { capture: true });
      w.removeEventListener('touchcancel', this._h.tcancel, { capture: true });
    }
    this._h = null;
    if (this._dom && this._dom.layer.parentNode) this._dom.layer.parentNode.removeChild(this._dom.layer);
    this._dom = null;
    this._onActionCb = null;
    this._onDeviceCb = null;
    this.exitPointerLock();
  }
}
