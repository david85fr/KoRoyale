// =============================================================================
// KoRoyale — client/js/ui/lobby.js
// Toute l'interface HORS PARTIE : connexion, menu, SALON (invitations entre
// amis), chargement, resultats et menu pause.
//
// Contrat (appele par client/js/main.js) :
//   new LobbyUI({ root, actions, skins, maxLobby })
//   setScreen(name) | setConnection(state) | setRooms(list) | setRoom(room)
//   setCountdown(s) | setError(text) | pushChat(entry) | setResults(payload)
//   setPauseMenu(open) | destroy()
//
// Aucun acces au DOM a l'import : tout se passe dans le constructeur/methodes.
// Rien n'est jamais injecte via innerHTML : les pseudos et le chat passent
// exclusivement par textContent.
//
// -----------------------------------------------------------------------------
// LISTE COMPLETE DES CLASSES CSS UTILISEES (pour la feuille de style)
// -----------------------------------------------------------------------------
// La feuille doit au minimum garantir : [hidden] { display: none !important; }
//
// -- Racine, ecrans, elements communs --------------------------------------
// lobby
// lobby__offline  lobby__offline-text  lobby__offline-retry
// lobby__toast  lobby__toast--error  lobby__toast-text  lobby__toast-close
// screen  lobby__screen
// lobby__screen--connecting  lobby__screen--menu  lobby__screen--room
// lobby__screen--loading  lobby__screen--results
// lobby__logo  lobby__logo-title  lobby__logo-ko  lobby__logo-royale
// lobby__logo-sub
// lobby__goat  lobby__goat-body  lobby__goat-belly  lobby__goat-head
// lobby__goat-muzzle  lobby__goat-horn  lobby__goat-ear  lobby__goat-eye
// lobby__goat-beard  lobby__goat-leg
// lobby__card  lobby__card-title  lobby__card-body
// lobby__btn  lobby__btn--primary  lobby__btn--ghost  lobby__btn--danger
// lobby__btn--wide  lobby__btn--small
// lobby__field  lobby__field-label  lobby__field-hint  lobby__input
// lobby__range  lobby__range-row  lobby__range-value
// lobby__select
// lobby__switch  lobby__switch-input  lobby__switch-track  lobby__switch-thumb
// lobby__switch-label
// lobby__skins  lobby__skin  lobby__skin--selected  lobby__skin-swatch
// lobby__skin-swatch--sm  lobby__skin-body  lobby__skin-belly
// lobby__skin-horn  lobby__skin-name
// lobby__badge  lobby__badge--host  lobby__badge--ready  lobby__badge--bot
// lobby__badge--me
// lobby__spinner  lobby__sr-only
// lobby__options  lobby__options-grid  lobby__option
// lobby__countdown  lobby__countdown-number  lobby__countdown-label
// lobby__pause  lobby__pause-panel  lobby__pause-title  lobby__pause-actions
// lobby__connect  lobby__connect-status  lobby__connect-retry
//
// -- Ecran MENU -------------------------------------------------------------
// menu  menu__header  menu__grid  menu__col  menu__col--left  menu__col--right
// menu__profile  menu__name-row  menu__name-input  menu__name-count
// menu__actions  menu__action  menu__action--quick  menu__action--create
// menu__action--join  menu__action-icon  menu__action-title  menu__action-sub
// menu__panel  menu__panel--join  menu__panel--create  menu__panel-row
// menu__code-input  menu__panel-error
// menu__rooms  menu__rooms-head  menu__rooms-count  menu__rooms-list
// menu__rooms-item  menu__room  menu__room-name  menu__room-meta
// menu__room-code  menu__room-mode  menu__room-count  menu__room-state
// menu__room-state--playing  menu__rooms-empty
// menu__details  menu__summary  menu__details-body
// menu__help-group  menu__help-title  menu__help-list  menu__help-row
// menu__help-keys  menu__help-key  menu__help-desc
//
// -- Ecran SALON ------------------------------------------------------------
// room  room__head  room__title  room__name
// room__code-block  room__code-label  room__code  room__code-actions
// room__copy  room__share  room__copied  room__link-field  room__link-input
// room__grid  room__panel  room__panel-title
// room__members  room__count  room__list  room__member  room__member--me
// room__member--bot  room__member-name  room__member-badges  room__member-kick
// room__autofill  room__bot-actions
// room__settings  room__setting  room__readonly
// room__chat  room__chat-log  room__chat-line  room__chat-line--sys
// room__chat-from  room__chat-text  room__chat-form  room__chat-input
// room__chat-send
// room__footer  room__ready  room__ready--on  room__start  room__leave
//
// -- Ecran CHARGEMENT -------------------------------------------------------
// loading  loading__title  loading__bar  loading__bar-fill
// loading__tip  loading__tip-label  loading__tip-text
//
// -- Ecran RESULTATS --------------------------------------------------------
// results  results__banner  results__banner--win  results__place
// results__title  results__subtitle
// results__stats  results__stat  results__stat-value  results__stat-label
// results__board  results__board-title  results__scroll  results__table
// results__th  results__row  results__row--me  results__row--win
// results__cell  results__cell--place  results__cell--name  results__cell--num
// results__cell--state  results__actions
// =============================================================================

import { TEAM_MODES, BOT, MATCH, ROOM } from '/shared/constants.js';
import { ROOM_STATE } from '/shared/protocol.js';

const CODE_ALPHABET = ROOM.codeAlphabet;
const CODE_LENGTH = ROOM.codeLength;
const CHAT_MAX_LINES = 60;

const DIFFICULTY_LABELS = {
  chevreau: 'Chevreau — facile',
  biquette: 'Biquette — normale',
  bouc: 'Bouc — coriace',
  bouquetin: 'Bouquetin — redoutable',
};
const DIFFICULTY_SHORT = {
  chevreau: 'Chevreau',
  biquette: 'Biquette',
  bouc: 'Bouc',
  bouquetin: 'Bouquetin',
};

const STATE_LABELS = {
  [ROOM_STATE.LOBBY]: 'Ouvert',
  [ROOM_STATE.COUNTDOWN]: 'Départ imminent',
  [ROOM_STATE.PLAYING]: 'En partie',
  [ROOM_STATE.ENDED]: 'Fin de partie',
};

const QUALITY_OPTIONS = [
  { value: 'low', label: 'Basse' },
  { value: 'medium', label: 'Moyenne' },
  { value: 'high', label: 'Haute' },
];

const TIPS = [
  'Les chèvres sautent deux fois : une seconde impulsion en plein vol franchit bien des ravins.',
  'Le Casino de Monte-Carlo déborde de coffres dorés… et de chèvres pressées.',
  'Un coup de corne bien placé projette l’adversaire : gardez-le pour les corps à corps.',
  'Le Tunnel est un raccourci royal, mais tout y résonne : lâchez le sprint.',
  'Vos sabots accrochent sur les falaises du Rocher : grimpez là où personne ne vous attend.',
  'La Brume du Rocher pique de plus en plus fort à chaque phase. Ne traînez pas dehors.',
  'La monoplace GP vole en ligne droite et refuse de tourner à l’Épingle du Fairmont.',
  'Le bouclier encaisse avant les points de vie : buvez avant de charger.',
  'Les largages bleus contiennent le meilleur butin — et attirent tout le troupeau.',
  'En Duo ou en Troupeau, une coéquipière à terre se relève en huit secondes.',
  'Le parapente s’ouvre seul à 55 mètres : piquez d’abord, planez ensuite.',
  'Le Port Hercule se traverse en vedette : plus rapide que la nage, et nettement plus chic.',
  'L’Alpage est calme et bien fourni, mais loin du centre : prévoyez un véhicule.',
  'Un marqueur sur la carte prévient tout le troupeau sans dire un mot.',
  'Le klaxon de chèvre ne sert tactiquement à rien. Klaxonnez quand même.',
  'La Piscine et la Nouvelle Chicane font d’excellents postes de tir en fin de partie.',
  'Une chèvre accroupie dans les buissons de la Forêt de Vintimille est presque invisible.',
];

const HELP_SECTIONS = [
  {
    title: 'Clavier et souris',
    rows: [
      [['Z', 'Q', 'S', 'D'], 'Se déplacer'],
      [['Espace'], 'Sauter (deux fois : double saut de chèvre)'],
      [['Maj'], 'Sprinter'],
      [['Ctrl'], 'S’accroupir'],
      [['Clic gauche'], 'Tirer'],
      [['Clic droit'], 'Viser'],
      [['R'], 'Recharger'],
      [['E'], 'Interagir : coffre, butin, véhicule'],
      [['F'], 'Coup de corne'],
      [['H'], 'Klaxon / bêlement'],
      [['1', '…', '5'], 'Changer d’emplacement'],
      [['G'], 'Jeter l’objet courant'],
      [['Tab'], 'Tableau des scores'],
      [['M'], 'Carte'],
      [['I'], 'Inventaire'],
      [['Entrée'], 'Chat'],
      [['Échap'], 'Menu pause'],
    ],
  },
  {
    title: 'Manette',
    rows: [
      [['Stick gauche'], 'Se déplacer'],
      [['Stick droit'], 'Viser'],
      [['RT'], 'Tirer'],
      [['LT'], 'Viser'],
      [['A'], 'Sauter'],
      [['B'], 'S’accroupir'],
      [['X'], 'Recharger'],
      [['Y'], 'Interagir'],
      [['LB', 'RB'], 'Changer d’arme'],
      [['R3'], 'Coup de corne'],
      [['Start'], 'Menu pause'],
      [['Croix dir.'], 'Carte et marqueurs'],
    ],
  },
  {
    title: 'Tactile',
    rows: [
      [['Joystick'], 'Se déplacer (à gauche)'],
      [['Glisser'], 'Viser (moitié droite de l’écran)'],
      [['Tir'], 'Bouton rouge à droite'],
      [['Saut'], 'Deux appuis : double saut'],
      [['Action'], 'Ramasser, ouvrir, monter en voiture'],
      [['Appui long'], 'Poser un marqueur sur la carte'],
    ],
  },
];

// ---------------------------------------------------------------------------
// Petits utilitaires (aucun effet de bord a l'import)
// ---------------------------------------------------------------------------

let _uidSeq = 0;
const uid = (p) => `kr-${p}-${++_uidSeq}`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function svgEl(tag, attrs) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k]));
  return n;
}

/** Ecriture de texte protegee : on ne touche au DOM que si la valeur change. */
function setText(node, value) {
  if (!node) return;
  const v = value == null ? '' : String(value);
  if (node.__krText !== v) {
    node.__krText = v;
    node.textContent = v;
  }
}

function setHidden(node, hidden) {
  if (!node) return;
  const h = !!hidden;
  if (node.hidden !== h) node.hidden = h;
}

function setDisabled(node, disabled) {
  if (!node) return;
  const d = !!disabled;
  if (node.disabled !== d) node.disabled = d;
}

function toggleClass(node, cls, on) {
  if (!node) return;
  if (node.classList.contains(cls) !== !!on) node.classList.toggle(cls, !!on);
}

function hexColor(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '#888888';
  return `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m} min ${String(r).padStart(2, '0')} s` : `${r} s`;
}

/** Couleur stable et lisible derivee d'un identifiant (pseudos du chat). */
function nameColor(id) {
  const s = String(id || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 68%, 68%)`;
}

function modeName(id) {
  return (TEAM_MODES[id] && TEAM_MODES[id].name) || 'Solo';
}

// ---------------------------------------------------------------------------

export class LobbyUI {
  constructor(opts = {}) {
    this.root = opts.root || document.body;
    this.actions = opts.actions || {};
    this.skins = Array.isArray(opts.skins) ? opts.skins.slice() : [];
    this.maxLobby = Number(opts.maxLobby) || MATCH.maxLobbySize;

    this.screen = 'connecting';
    this.connection = 'connecting';
    this.room = null;
    this.rooms = [];
    this.pauseOpen = false;
    this.destroyed = false;

    this._myId = null;
    this._localReady = false;
    this._chatCode = null;
    this._chatLines = [];
    this._memberNodes = new Map();
    this._roomNodes = new Map();
    this._listeners = [];
    this._timers = new Set();
    this._optionPanels = [];
    this._gpRaf = 0;
    this._gpPrev = { up: false, down: false, a: false, b: false };
    this._firstScreen = true;

    const p = this._profile();
    this.playerName = typeof p.name === 'string' ? p.name : '';
    this.skinId = p.skin || (this.skins[0] && this.skins[0].id) || 'alpine';

    this.el = el('div', 'lobby');
    this.el.dataset.screen = 'connecting';

    this._buildOffline();
    this._buildToast();

    this.screens = {};
    this.el.appendChild(this._buildConnecting());
    this.el.appendChild(this._buildMenu());
    this.el.appendChild(this._buildRoom());
    this.el.appendChild(this._buildLoading());
    this.el.appendChild(this._buildResults());
    this._buildCountdown();
    this._buildPause();

    this.root.appendChild(this.el);
    this.setScreen('connecting');
    this.setConnection('connecting');
  }

  // -------------------------------------------------------------------------
  // Outils internes
  // -------------------------------------------------------------------------

  _profile() {
    try {
      const p = this.actions.getProfile ? this.actions.getProfile() : null;
      return p && typeof p === 'object' ? p : {};
    } catch { return {}; }
  }

  _call(name, ...args) {
    const fn = this.actions[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); } catch { return undefined; }
  }

  _on(node, type, fn, opts) {
    node.addEventListener(type, fn, opts);
    this._listeners.push([node, type, fn, opts]);
    return fn;
  }

  _after(fn, ms) {
    const id = setTimeout(() => { this._timers.delete(id); if (!this.destroyed) fn(); }, ms);
    this._timers.add(id);
    return id;
  }

  _clearTimer(id) {
    if (!id) return;
    clearTimeout(id);
    this._timers.delete(id);
  }

  // -------------------------------------------------------------------------
  // Briques d'interface
  // -------------------------------------------------------------------------

  /** Une chevre en SVG inline, coloriee par le CSS (attributs = repli). */
  _goat(cls) {
    const svg = svgEl('svg', {
      class: `lobby__goat${cls ? ` ${cls}` : ''}`,
      viewBox: '0 0 120 120', 'aria-hidden': 'true', focusable: 'false',
    });
    const add = (tag, attrs) => { svg.appendChild(svgEl(tag, attrs)); };

    // pattes
    for (const x of [42, 54, 66, 78]) {
      add('rect', { class: 'lobby__goat-leg', x, y: 84, width: 7, height: 24, rx: 3, fill: '#6b5b4a' });
    }
    add('ellipse', { class: 'lobby__goat-body', cx: 62, cy: 76, rx: 32, ry: 22, fill: '#c9b8a4' });
    add('ellipse', { class: 'lobby__goat-belly', cx: 62, cy: 86, rx: 22, ry: 10, fill: '#e8dfd2' });
    add('rect', { class: 'lobby__goat-leg', x: 90, y: 62, width: 8, height: 5, rx: 2.5, fill: '#6b5b4a' });
    // cornes
    add('path', {
      class: 'lobby__goat-horn', d: 'M32 34 C 22 20, 20 12, 26 8 C 28 16, 34 22, 40 28 Z', fill: '#6b5b4a',
    });
    add('path', {
      class: 'lobby__goat-horn', d: 'M46 30 C 40 16, 40 8, 46 5 C 46 14, 50 22, 54 26 Z', fill: '#6b5b4a',
    });
    // oreille
    add('ellipse', {
      class: 'lobby__goat-ear', cx: 26, cy: 50, rx: 12, ry: 6,
      transform: 'rotate(-18 26 50)', fill: '#c9b8a4',
    });
    // tete + museau
    add('ellipse', { class: 'lobby__goat-head', cx: 42, cy: 46, rx: 19, ry: 17, fill: '#c9b8a4' });
    add('ellipse', { class: 'lobby__goat-muzzle', cx: 30, cy: 54, rx: 12, ry: 9, fill: '#e8dfd2' });
    add('circle', { class: 'lobby__goat-eye', cx: 40, cy: 42, r: 3.2, fill: '#22201d' });
    add('circle', { cx: 24, cy: 53, r: 1.8, fill: '#4a4038' });
    add('path', { class: 'lobby__goat-beard', d: 'M28 62 C 26 72, 30 78, 33 80 C 30 72, 32 66, 34 62 Z', fill: '#e8dfd2' });
    return svg;
  }

  /** Pastille tricolore d'une robe. */
  _swatch(skinId, small) {
    const skin = this.skins.find((s) => s.id === skinId) || this.skins[0] || {};
    const wrap = el('span', `lobby__skin-swatch${small ? ' lobby__skin-swatch--sm' : ''}`);
    wrap.setAttribute('aria-hidden', 'true');
    const body = el('span', 'lobby__skin-body');
    const belly = el('span', 'lobby__skin-belly');
    const horn = el('span', 'lobby__skin-horn');
    wrap.append(body, belly, horn);
    wrap.__apply = (id) => {
      const s = this.skins.find((k) => k.id === id) || {};
      body.style.backgroundColor = hexColor(s.body);
      belly.style.backgroundColor = hexColor(s.belly);
      horn.style.backgroundColor = hexColor(s.horn);
    };
    wrap.__apply(skin.id);
    return wrap;
  }

  _button(label, cls, onClick) {
    const b = el('button', `lobby__btn${cls ? ` ${cls}` : ''}`, label);
    b.type = 'button';
    if (onClick) this._on(b, 'click', onClick);
    return b;
  }

  _field(labelText, control, hintText) {
    const wrap = el('div', 'lobby__field');
    const id = control.id || (control.id = uid('f'));
    const lab = el('label', 'lobby__field-label', labelText);
    lab.htmlFor = id;
    wrap.append(lab, control);
    if (hintText) wrap.appendChild(el('p', 'lobby__field-hint', hintText));
    return wrap;
  }

  _switch(labelText, checked, onChange) {
    const wrap = el('label', 'lobby__switch');
    const input = el('input', 'lobby__switch-input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.checked = !!checked;
    const track = el('span', 'lobby__switch-track');
    track.appendChild(el('span', 'lobby__switch-thumb'));
    const text = el('span', 'lobby__switch-label', labelText);
    wrap.append(input, track, text);
    this._on(input, 'change', () => onChange(input.checked));
    wrap.__input = input;
    return wrap;
  }

  _rangeRow(labelText, { min, max, step, value, format, onInput, onCommit }) {
    const input = el('input', 'lobby__range');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const out = el('output', 'lobby__range-value', format(value));
    const id = (input.id = uid('r'));
    out.htmlFor = id;
    const row = el('div', 'lobby__range-row');
    const lab = el('label', 'lobby__field-label', labelText);
    lab.htmlFor = id;
    row.append(input, out);
    const wrap = el('div', 'lobby__field');
    wrap.append(lab, row);
    this._on(input, 'input', () => {
      const v = Number(input.value);
      setText(out, format(v));
      if (onInput) onInput(v);
    });
    if (onCommit) this._on(input, 'change', () => onCommit(Number(input.value)));
    wrap.__input = input;
    wrap.__out = out;
    wrap.__format = format;
    return wrap;
  }

  _selectRow(labelText, options, value, onChange) {
    const sel = el('select', 'lobby__select');
    for (const o of options) {
      const opt = el('option', null, o.label);
      opt.value = o.value;
      sel.appendChild(opt);
    }
    sel.value = value;
    this._on(sel, 'change', () => onChange(sel.value));
    const wrap = this._field(labelText, sel);
    wrap.__input = sel;
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Bandeau hors ligne + notifications
  // -------------------------------------------------------------------------

  _buildOffline() {
    const bar = el('div', 'lobby__offline');
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    bar.hidden = true;
    this.offlineText = el('span', 'lobby__offline-text', 'Connexion perdue. Tentative de reconnexion…');
    const retry = this._button('Réessayer', 'lobby__offline-retry lobby__btn--small', () => this._retry());
    bar.append(this.offlineText, retry);
    this.offlineBar = bar;
    this.el.appendChild(bar);
  }

  _buildToast() {
    const toast = el('div', 'lobby__toast lobby__toast--error');
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    toast.hidden = true;
    this.toastText = el('p', 'lobby__toast-text');
    const close = this._button('✕', 'lobby__toast-close lobby__btn--small', () => {
      setHidden(this.toastEl, true);
      this._clearTimer(this._toastTimer);
    });
    close.setAttribute('aria-label', 'Fermer le message');
    toast.append(this.toastText, close);
    this.toastEl = toast;
    this.el.appendChild(toast);
  }

  _retry() {
    if (typeof this.actions.reconnect === 'function') { this._call('reconnect'); return; }
    try { location.reload(); } catch { /* environnement sans navigation */ }
  }

  // -------------------------------------------------------------------------
  // 1. Ecran CONNEXION
  // -------------------------------------------------------------------------

  _section(name, extraClass) {
    const s = el('section', `screen lobby__screen lobby__screen--${name}${extraClass ? ` ${extraClass}` : ''}`);
    s.dataset.screen = name;
    s.tabIndex = -1;
    s.hidden = true;
    this.screens[name] = s;
    return s;
  }

  _logo(withSub) {
    const box = el('div', 'lobby__logo');
    const h1 = el('h1', 'lobby__logo-title');
    h1.append(el('span', 'lobby__logo-ko', 'Ko'), el('span', 'lobby__logo-royale', 'Royale'));
    box.appendChild(h1);
    if (withSub) box.appendChild(el('p', 'lobby__logo-sub', 'Battle royale de chèvres — circuit de Monaco'));
    return box;
  }

  _buildConnecting() {
    const s = this._section('connecting');
    const box = el('div', 'lobby__connect');
    box.append(this._logo(true), this._goat());
    this.connectStatus = el('p', 'lobby__connect-status', 'Connexion au troupeau…');
    this.connectStatus.setAttribute('role', 'status');
    this.connectStatus.setAttribute('aria-live', 'polite');
    const spinner = el('div', 'lobby__spinner');
    spinner.setAttribute('aria-hidden', 'true');
    this.connectRetry = this._button('Réessayer', 'lobby__connect-retry lobby__btn--primary', () => this._retry());
    this.connectRetry.hidden = true;
    box.append(spinner, this.connectStatus, this.connectRetry);
    s.appendChild(box);
    return s;
  }

  // -------------------------------------------------------------------------
  // 2. Ecran MENU
  // -------------------------------------------------------------------------

  _buildMenu() {
    const s = this._section('menu', 'menu');

    const head = el('div', 'menu__header');
    head.append(this._logo(true), this._goat());
    s.appendChild(head);

    const grid = el('div', 'menu__grid');
    grid.append(this._buildProfileCard(), this._buildRightColumn());
    s.appendChild(grid);
    return s;
  }

  _buildProfileCard() {
    const col = el('div', 'menu__col menu__col--left');

    // --- carte de profil ---
    const card = el('div', 'lobby__card menu__profile');
    card.appendChild(el('h2', 'lobby__card-title', 'Votre chèvre'));
    const body = el('div', 'lobby__card-body');

    const nameRow = el('div', 'menu__name-row');
    const nameInput = el('input', 'lobby__input menu__name-input');
    nameInput.type = 'text';
    nameInput.maxLength = 16;
    nameInput.autocomplete = 'nickname';
    nameInput.spellcheck = false;
    nameInput.value = this.playerName;
    nameInput.placeholder = 'Nom de votre chèvre';
    this.nameInput = nameInput;
    const count = el('span', 'menu__name-count', `${nameInput.value.length}/16`);
    count.setAttribute('aria-hidden', 'true');
    nameRow.append(nameInput, count);
    this._on(nameInput, 'input', () => {
      setText(count, `${nameInput.value.length}/16`);
      this._clearTimer(this._nameTimer);
      this._nameTimer = this._after(() => this._commitProfile(), 420);
    });
    this._on(nameInput, 'blur', () => { this._clearTimer(this._nameTimer); this._commitProfile(); });
    this._on(nameInput, 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._clearTimer(this._nameTimer); this._commitProfile(); nameInput.blur(); }
    });
    const nameField = el('div', 'lobby__field');
    const nameLabel = el('label', 'lobby__field-label', 'Pseudo (16 caractères max)');
    nameInput.id = uid('name');
    nameLabel.htmlFor = nameInput.id;
    nameField.append(nameLabel, nameRow);
    body.appendChild(nameField);

    // --- robes ---
    const skinsWrap = el('div', 'lobby__field');
    const skinsLabel = el('p', 'lobby__field-label', 'Robe');
    skinsLabel.id = uid('skins');
    const group = el('div', 'lobby__skins');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', skinsLabel.id);
    this.skinButtons = new Map();
    for (const skin of this.skins) {
      const b = el('button', 'lobby__skin');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.skin = skin.id;
      b.title = skin.name;
      b.append(this._swatch(skin.id), el('span', 'lobby__skin-name', skin.name));
      this._on(b, 'click', () => this._selectSkin(skin.id, true));
      this._on(b, 'keydown', (e) => this._skinKeydown(e, skin.id));
      this.skinButtons.set(skin.id, b);
      group.appendChild(b);
    }
    skinsWrap.append(skinsLabel, group);
    body.appendChild(skinsWrap);
    card.appendChild(body);
    col.appendChild(card);
    this._syncSkinButtons();

    // --- trois grands boutons ---
    const actions = el('div', 'menu__actions');
    const mkAction = (cls, icon, title, sub, onClick) => {
      const b = el('button', `lobby__btn menu__action ${cls}`);
      b.type = 'button';
      const ic = el('span', 'menu__action-icon', icon);
      ic.setAttribute('aria-hidden', 'true');
      b.append(ic, el('span', 'menu__action-title', title), el('span', 'menu__action-sub', sub));
      this._on(b, 'click', onClick);
      actions.appendChild(b);
      return b;
    };
    mkAction('menu__action--quick', '⚡', 'Partie rapide', 'On vous trouve un troupeau tout de suite',
      () => this._call('quickPlay'));
    this.createToggle = mkAction('menu__action--create', '🏰', 'Créer un salon',
      'Votre partie, vos règles, vos amis', () => this._togglePanel('create'));
    this.joinToggle = mkAction('menu__action--join', '🔑', 'Rejoindre un salon',
      'Entrez le code à 5 caractères d’un ami', () => this._togglePanel('join'));
    col.appendChild(actions);

    col.appendChild(this._buildJoinPanel());
    col.appendChild(this._buildCreatePanel());
    return col;
  }

  _buildJoinPanel() {
    const panel = el('form', 'menu__panel menu__panel--join');
    panel.hidden = true;
    panel.id = uid('join');
    this.joinToggle.setAttribute('aria-controls', panel.id);
    this.joinToggle.setAttribute('aria-expanded', 'false');
    panel.appendChild(el('h3', 'lobby__card-title', 'Code du salon'));

    const row = el('div', 'menu__panel-row');
    const input = el('input', 'lobby__input menu__code-input');
    input.type = 'text';
    input.maxLength = CODE_LENGTH;
    input.spellcheck = false;
    input.autocapitalize = 'characters';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `Code du salon, ${CODE_LENGTH} caractères`);
    input.placeholder = 'ABCDE';
    this.codeInput = input;
    const submit = el('button', 'lobby__btn lobby__btn--primary', 'Rejoindre');
    submit.type = 'submit';
    row.append(input, submit);

    this.joinError = el('p', 'menu__panel-error');
    this.joinError.setAttribute('role', 'status');
    this.joinError.setAttribute('aria-live', 'polite');

    panel.append(row, this.joinError);

    this._on(input, 'input', () => {
      const clean = String(input.value).toUpperCase().split('')
        .filter((c) => CODE_ALPHABET.includes(c)).join('').slice(0, CODE_LENGTH);
      if (clean !== input.value) input.value = clean;
      if (clean.length === CODE_LENGTH) setText(this.joinError, '');
    });
    this._on(panel, 'submit', (e) => {
      e.preventDefault();
      const code = input.value;
      if (code.length !== CODE_LENGTH) {
        setText(this.joinError, `Il faut ${CODE_LENGTH} caractères (lettres et chiffres, sans I ni O).`);
        input.focus();
        return;
      }
      setText(this.joinError, '');
      this._call('joinRoom', code);
    });
    this._on(panel, 'keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this._togglePanel('join', false); this.joinToggle.focus(); }
    });
    this.joinPanel = panel;
    return panel;
  }

  _buildCreatePanel() {
    const panel = el('form', 'menu__panel menu__panel--create');
    panel.hidden = true;
    panel.id = uid('create');
    this.createToggle.setAttribute('aria-controls', panel.id);
    this.createToggle.setAttribute('aria-expanded', 'false');
    panel.appendChild(el('h3', 'lobby__card-title', 'Nouveau salon'));

    const nameInput = el('input', 'lobby__input');
    nameInput.type = 'text';
    nameInput.maxLength = 32;
    nameInput.value = 'Salon de chèvres';
    nameInput.placeholder = 'Nom du salon';
    panel.appendChild(this._field('Nom du salon', nameInput));

    const mode = this._selectRow('Mode', Object.values(TEAM_MODES).map((m) => ({ value: m.id, label: m.name })),
      'solo', () => {});
    panel.appendChild(mode);

    const size = this._rangeRow('Taille du salon', {
      min: 2, max: this.maxLobby, step: 1, value: Math.min(MATCH.defaultLobbySize, this.maxLobby),
      format: (v) => `${v} chèvres`,
      onInput: () => {},
    });
    panel.appendChild(size);

    const pub = this._switch('Salon public (visible dans la liste)', true, () => {});
    panel.appendChild(pub);

    const submit = el('button', 'lobby__btn lobby__btn--primary lobby__btn--wide', 'Créer le salon');
    submit.type = 'submit';
    panel.appendChild(submit);

    this._on(panel, 'submit', (e) => {
      e.preventDefault();
      const settings = {
        mode: mode.__input.value,
        lobbySize: Number(size.__input.value),
        fillWithBots: true,
        botDifficulty: 'biquette',
        friendlyFire: false,
      };
      this._call('createRoom', settings, pub.__input.checked, nameInput.value.trim() || 'Salon de chèvres');
    });
    this._on(panel, 'keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this._togglePanel('create', false); this.createToggle.focus(); }
    });
    this.createPanel = panel;
    return panel;
  }

  _buildRightColumn() {
    const col = el('div', 'menu__col menu__col--right');

    // --- salons publics ---
    const card = el('section', 'lobby__card menu__rooms');
    const head = el('div', 'menu__rooms-head');
    head.appendChild(el('h2', 'lobby__card-title', 'Salons publics'));
    this.roomsCount = el('span', 'menu__rooms-count', '0 salon');
    head.appendChild(this.roomsCount);
    card.appendChild(head);
    this.roomsList = el('ul', 'menu__rooms-list');
    this.roomsList.setAttribute('aria-label', 'Liste des salons publics');
    this.roomsEmpty = el('p', 'menu__rooms-empty',
      'Aucun salon public pour l’instant. Créez le vôtre : le troupeau suivra !');
    card.append(this.roomsList, this.roomsEmpty);
    col.appendChild(card);

    // --- options ---
    const optDetails = el('details', 'lobby__card menu__details');
    const optSummary = el('summary', 'menu__summary', 'Options');
    const optBody = el('div', 'menu__details-body');
    this.menuOptions = this._buildOptionsPanel();
    optBody.appendChild(this.menuOptions.el);
    optDetails.append(optSummary, optBody);
    col.appendChild(optDetails);

    // --- comment jouer ---
    const helpDetails = el('details', 'lobby__card menu__details');
    const helpSummary = el('summary', 'menu__summary', 'Comment jouer');
    const helpBody = el('div', 'menu__details-body');
    for (const sec of HELP_SECTIONS) {
      const g = el('div', 'menu__help-group');
      g.appendChild(el('h3', 'menu__help-title', sec.title));
      const ul = el('ul', 'menu__help-list');
      for (const [keys, desc] of sec.rows) {
        const li = el('li', 'menu__help-row');
        const kbox = el('span', 'menu__help-keys');
        for (const k of keys) kbox.appendChild(el('kbd', 'menu__help-key', k));
        li.append(kbox, el('span', 'menu__help-desc', desc));
        ul.appendChild(li);
      }
      g.appendChild(ul);
      helpBody.appendChild(g);
    }
    helpDetails.append(helpSummary, helpBody);
    col.appendChild(helpDetails);
    return col;
  }

  /** Panneau d'options reutilise dans le menu ET dans la pause. */
  _buildOptionsPanel() {
    const p = this._profile();
    const box = el('div', 'lobby__options');
    const grid = el('div', 'lobby__options-grid');

    const sens = this._rangeRow('Sensibilité de la visée', {
      min: 0.2, max: 3, step: 0.05, value: clamp(Number(p.sensitivity ?? 1), 0.2, 3),
      format: (v) => `×${Number(v).toFixed(2)}`,
      onInput: (v) => this._option('sensitivity', v, panel),
    });
    const invert = this._switch('Inverser l’axe Y', !!p.invertY, (v) => this._option('invertY', v, panel));
    const vol = this._rangeRow('Volume', {
      min: 0, max: 1, step: 0.05, value: clamp(Number(p.volume ?? 0.7), 0, 1),
      format: (v) => `${Math.round(v * 100)} %`,
      onInput: (v) => this._option('volume', v, panel),
    });
    const sound = this._switch('Son activé', p.sound !== false, (v) => this._option('sound', v, panel));
    const quality = this._selectRow('Qualité graphique', QUALITY_OPTIONS, p.quality || 'medium',
      (v) => this._option('quality', v, panel));

    for (const n of [sens, invert, vol, sound, quality]) {
      const cell = el('div', 'lobby__option');
      cell.appendChild(n);
      grid.appendChild(cell);
    }
    box.appendChild(grid);

    const panel = {
      el: box,
      controls: { sensitivity: sens, invertY: invert, volume: vol, sound, quality },
      apply(key, value) {
        const c = this.controls[key];
        if (!c) return;
        const input = c.__input;
        if (!input || input === document.activeElement) return;
        if (input.type === 'checkbox') input.checked = !!value;
        else {
          input.value = String(value);
          if (c.__out && c.__format) setText(c.__out, c.__format(Number(value)));
        }
      },
    };
    this._optionPanels.push(panel);
    return panel;
  }

  _option(key, value, from) {
    this._call('setOption', key, value);
    for (const p of this._optionPanels) if (p !== from) p.apply(key, value);
  }

  _togglePanel(which, force) {
    const isJoin = which === 'join';
    const panel = isJoin ? this.joinPanel : this.createPanel;
    const toggle = isJoin ? this.joinToggle : this.createToggle;
    const open = force == null ? panel.hidden : !!force;
    setHidden(panel, !open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const other = isJoin ? this.createPanel : this.joinPanel;
      const otherToggle = isJoin ? this.createToggle : this.joinToggle;
      setHidden(other, true);
      otherToggle.setAttribute('aria-expanded', 'false');
      const first = panel.querySelector('input');
      if (first) first.focus();
    }
  }

  _selectSkin(id, commit) {
    if (!this.skins.some((s) => s.id === id)) return;
    this.skinId = id;
    this._syncSkinButtons();
    if (commit) this._commitProfile();
  }

  _syncSkinButtons() {
    if (!this.skinButtons) return;
    for (const [id, b] of this.skinButtons) {
      const on = id === this.skinId;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      toggleClass(b, 'lobby__skin--selected', on);
    }
    if (![...this.skinButtons.values()].some((b) => b.tabIndex === 0)) {
      const first = this.skinButtons.values().next().value;
      if (first) first.tabIndex = 0;
    }
  }

  _skinKeydown(e, id) {
    const ids = this.skins.map((s) => s.id);
    const i = ids.indexOf(id);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this._selectSkin(id, true); return; }
    if (next < 0) return;
    e.preventDefault();
    this._selectSkin(ids[next], true);
    const b = this.skinButtons.get(ids[next]);
    if (b) b.focus();
  }

  _commitProfile() {
    const name = this.nameInput ? this.nameInput.value.trim() : this.playerName;
    if (name === this.playerName && this.skinId === this._sentSkin) return;
    this.playerName = name;
    this._sentSkin = this.skinId;
    this._call('setProfile', { name, skin: this.skinId });
  }

  // -------------------------------------------------------------------------
  // 3. Ecran SALON
  // -------------------------------------------------------------------------

  _buildRoom() {
    const s = this._section('room', 'room');

    // --- entete : code + invitation ---
    const head = el('div', 'room__head');
    const title = el('div', 'room__title');
    this.roomName = el('h2', 'room__name', 'Salon');
    title.appendChild(this.roomName);

    const codeBlock = el('div', 'room__code-block');
    const codeLabel = el('p', 'room__code-label', 'Code du salon');
    codeLabel.id = uid('codelabel');
    this.roomCode = el('strong', 'room__code', '—');
    this.roomCode.setAttribute('aria-describedby', codeLabel.id);
    codeBlock.append(codeLabel, this.roomCode);

    const codeActions = el('div', 'room__code-actions');
    this.copyBtn = this._button('Copier le lien d’invitation', 'room__copy lobby__btn--primary', () => this._copyInvite());
    codeActions.appendChild(this.copyBtn);
    this.shareBtn = this._button('Partager', 'room__share lobby__btn--ghost', () => this._shareInvite());
    if (!(typeof navigator !== 'undefined' && typeof navigator.share === 'function')) this.shareBtn.hidden = true;
    codeActions.appendChild(this.shareBtn);
    this.copiedMsg = el('span', 'room__copied');
    this.copiedMsg.setAttribute('role', 'status');
    this.copiedMsg.setAttribute('aria-live', 'polite');
    codeActions.appendChild(this.copiedMsg);

    this.linkField = el('div', 'room__link-field');
    this.linkField.hidden = true;
    this.linkInput = el('input', 'room__link-input');
    this.linkInput.type = 'text';
    this.linkInput.readOnly = true;
    this.linkInput.setAttribute('aria-label', 'Lien d’invitation à copier');
    this.linkField.appendChild(this.linkInput);

    head.append(title, codeBlock, codeActions, this.linkField);
    s.appendChild(head);

    // --- colonnes ---
    const grid = el('div', 'room__grid');
    grid.append(this._buildMembersPanel(), this._buildSettingsPanel(), this._buildChatPanel());
    s.appendChild(grid);

    // --- pied ---
    const footer = el('div', 'room__footer');
    this.readyBtn = this._button('Je suis prêt', 'room__ready lobby__btn--primary', () => {
      this._localReady = !this._localReady;
      this._call('setReady', this._localReady);
      this._syncReadyButton();
    });
    this.readyBtn.setAttribute('aria-pressed', 'false');
    this.startBtn = this._button('LANCER LA PARTIE', 'room__start lobby__btn--primary lobby__btn--wide',
      () => this._call('start'));
    this.startBtn.hidden = true;
    this.leaveBtn = this._button('Quitter le salon', 'room__leave lobby__btn--ghost', () => {
      this._call('leave');
      this.setRoom(null);
      this.setScreen('menu');
    });
    footer.append(this.readyBtn, this.startBtn, this.leaveBtn);
    s.appendChild(footer);
    return s;
  }

  _buildMembersPanel() {
    const panel = el('section', 'room__panel room__members');
    const head = el('div', 'room__panel-title');
    head.appendChild(el('h3', 'lobby__card-title', 'Participants'));
    this.memberCount = el('span', 'room__count', '0/0');
    head.appendChild(this.memberCount);
    panel.appendChild(head);

    this.memberList = el('ul', 'room__list');
    this.memberList.setAttribute('aria-label', 'Participants du salon');
    panel.appendChild(this.memberList);

    this.autoFillLine = el('p', 'room__autofill');
    this.autoFillLine.hidden = true;
    panel.appendChild(this.autoFillLine);

    this.botActions = el('div', 'room__bot-actions');
    this.botActions.hidden = true;
    this.addBotBtn = this._button('Ajouter une IA', 'lobby__btn--ghost lobby__btn--small', () => this._call('addBot'));
    this.removeBotBtn = this._button('Retirer une IA', 'lobby__btn--ghost lobby__btn--small', () => this._call('removeBot'));
    this.botActions.append(this.addBotBtn, this.removeBotBtn);
    panel.appendChild(this.botActions);
    return panel;
  }

  _buildSettingsPanel() {
    const panel = el('section', 'room__panel room__settings');
    panel.appendChild(el('h3', 'lobby__card-title', 'Réglages'));
    this.readonlyHint = el('p', 'room__readonly', 'Seul l’hôte peut modifier les réglages.');
    this.readonlyHint.hidden = true;
    panel.appendChild(this.readonlyHint);

    const push = (node) => { const c = el('div', 'room__setting'); c.appendChild(node); panel.appendChild(c); return node; };

    this.setMode = push(this._selectRow('Mode de jeu',
      Object.values(TEAM_MODES).map((m) => ({ value: m.id, label: m.name })), 'solo',
      (v) => this._call('setSettings', { mode: v })));

    this.setSize = push(this._rangeRow('Taille du salon', {
      min: 2, max: this.maxLobby, step: 1, value: Math.min(MATCH.defaultLobbySize, this.maxLobby),
      format: (v) => `${v} chèvres`,
      onCommit: (v) => this._call('setSettings', { lobbySize: v }),
    }));

    this.setFill = push(this._switch('Remplir avec des IA', true,
      (v) => this._call('setSettings', { fillWithBots: v })));

    this.setDifficulty = push(this._selectRow('Difficulté des IA',
      BOT.difficulties.map((d) => ({ value: d, label: DIFFICULTY_LABELS[d] || d })), 'biquette',
      (v) => this._call('setSettings', { botDifficulty: v })));

    this.setFriendly = push(this._switch('Tir allié', false,
      (v) => this._call('setSettings', { friendlyFire: v })));

    this.setPublic = push(this._switch('Salon public', true,
      (v) => this._call('setSettings', { isPublic: v })));

    const nameInput = el('input', 'lobby__input');
    nameInput.type = 'text';
    nameInput.maxLength = 32;
    const nameField = this._field('Nom du salon', nameInput);
    nameField.__input = nameInput;
    this.setName = push(nameField);
    this._on(nameInput, 'change', () => {
      const v = nameInput.value.trim();
      if (v) this._call('setSettings', { name: v });
    });
    return panel;
  }

  _buildChatPanel() {
    const panel = el('section', 'room__panel room__chat');
    panel.appendChild(el('h3', 'lobby__card-title', 'Discussion du troupeau'));

    this.chatLog = el('ul', 'room__chat-log');
    this.chatLog.setAttribute('role', 'log');
    this.chatLog.setAttribute('aria-live', 'polite');
    this.chatLog.setAttribute('aria-label', 'Messages du salon');
    panel.appendChild(this.chatLog);

    const form = el('form', 'room__chat-form');
    this.chatInput = el('input', 'lobby__input room__chat-input');
    this.chatInput.type = 'text';
    this.chatInput.maxLength = ROOM.maxChatLength;
    this.chatInput.placeholder = 'Un mot au troupeau…';
    this.chatInput.setAttribute('aria-label', 'Message à envoyer au salon');
    const send = el('button', 'lobby__btn lobby__btn--small room__chat-send', 'Envoyer');
    send.type = 'submit';
    form.append(this.chatInput, send);
    this._on(form, 'submit', (e) => {
      e.preventDefault();
      const t = this.chatInput.value.trim();
      if (!t) return;
      this.chatInput.value = '';
      this._call('chat', t);
    });
    panel.appendChild(form);
    return panel;
  }

  // -- invitation -----------------------------------------------------------

  _inviteLink() {
    const l = this._call('inviteLink');
    if (typeof l === 'string' && l) return l;
    try { return location.href; } catch { return ''; }
  }

  _flashCopied(text) {
    setText(this.copiedMsg, text);
    this._clearTimer(this._copyTimer);
    this._copyTimer = this._after(() => setText(this.copiedMsg, ''), 4000);
  }

  async _copyInvite() {
    const link = this._inviteLink();
    this.linkInput.value = link;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(link);
        setHidden(this.linkField, true);
        this._flashCopied('Lien copié !');
        return;
      }
    } catch { /* repli ci-dessous */ }
    // repli : champ visible, selectionne, prêt pour un Ctrl+C
    setHidden(this.linkField, false);
    this.linkInput.focus();
    this.linkInput.select();
    let ok = false;
    try { ok = document.execCommand && document.execCommand('copy'); } catch { ok = false; }
    this._flashCopied(ok ? 'Lien copié !' : 'Copiez le lien sélectionné ci-dessous.');
  }

  _shareInvite() {
    const link = this._inviteLink();
    const code = this.room ? this.room.code : '';
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      Promise.resolve(navigator.share({
        title: 'KoRoyale',
        text: code ? `Rejoins mon troupeau sur KoRoyale ! Code : ${code}` : 'Rejoins mon troupeau sur KoRoyale !',
        url: link,
      })).catch(() => { /* partage annule */ });
    } else {
      this._copyInvite();
    }
  }

  // -- rendu du salon -------------------------------------------------------

  _resolveMyId(room) {
    if (this._myId && (room.members.some((m) => m.id === this._myId))) return this._myId;
    let id = null;
    if (typeof this.actions.myId === 'function') {
      try { id = this.actions.myId(); } catch { id = null; }
    }
    if (!id && typeof window !== 'undefined' && window.KoRoyale && window.KoRoyale.net) {
      id = window.KoRoyale.net.id || null;
    }
    if (id && room.members.some((m) => m.id === id)) { this._myId = id; return id; }
    if (room.members.length === 1) { this._myId = room.members[0].id; return this._myId; }
    const p = this._profile();
    let cand = room.members.filter((m) => m.name === p.name && m.skin === p.skin);
    if (cand.length !== 1) cand = room.members.filter((m) => m.name === p.name);
    if (cand.length === 1) { this._myId = cand[0].id; return this._myId; }
    return null;
  }

  _createMemberNode() {
    const li = el('li', 'room__member');
    const swatch = this._swatch(this.skinId, true);
    const name = el('span', 'room__member-name');
    const badges = el('span', 'room__member-badges');
    const bHost = el('span', 'lobby__badge lobby__badge--host', 'Hôte');
    const bReady = el('span', 'lobby__badge lobby__badge--ready', 'Prêt');
    const bMe = el('span', 'lobby__badge lobby__badge--me', 'Vous');
    const bBot = el('span', 'lobby__badge lobby__badge--bot', 'IA');
    for (const b of [bMe, bHost, bReady, bBot]) { b.hidden = true; badges.appendChild(b); }
    const kick = this._button('Exclure', 'room__member-kick lobby__btn--small lobby__btn--danger', null);
    kick.hidden = true;
    li.append(swatch, name, badges, kick);
    return { li, swatch, name, kick, bHost, bReady, bMe, bBot, skinId: null, kickId: null };
  }

  _renderMembers(room, isHost, myId) {
    const entries = [];
    for (const m of room.members || []) entries.push({ ...m, isBot: false });
    for (const b of room.bots || []) entries.push({ ...b, isBot: true });

    const list = this.memberList;
    const seen = new Set();
    let index = 0;
    for (const m of entries) {
      seen.add(m.id);
      let node = this._memberNodes.get(m.id);
      if (!node) {
        node = this._createMemberNode();
        this._memberNodes.set(m.id, node);
        this._on(node.kick, 'click', () => { if (node.kickId) this._call('kick', node.kickId); });
      }
      node.kickId = m.id;
      if (node.skinId !== m.skin) { node.skinId = m.skin; node.swatch.__apply(m.skin); }
      setText(node.name, m.name || 'Chèvre');
      const me = !m.isBot && myId && m.id === myId;
      setHidden(node.bMe, !me);
      setHidden(node.bHost, !m.host);
      setHidden(node.bReady, m.isBot || !m.ready);
      setHidden(node.bBot, !m.isBot);
      if (m.isBot) setText(node.bBot, `IA · ${DIFFICULTY_SHORT[m.difficulty] || m.difficulty || 'Biquette'}`);
      toggleClass(node.li, 'room__member--me', !!me);
      toggleClass(node.li, 'room__member--bot', !!m.isBot);
      const canKick = isHost && !m.isBot && !m.host;
      setHidden(node.kick, !canKick);
      if (canKick) node.kick.setAttribute('aria-label', `Exclure ${m.name} du salon`);
      if (list.children[index] !== node.li) list.insertBefore(node.li, list.children[index] || null);
      index++;
    }
    for (const [id, node] of [...this._memberNodes]) {
      if (!seen.has(id)) { node.li.remove(); this._memberNodes.delete(id); }
    }
  }

  _applySettingsControls(room, isHost) {
    const s = room.settings || {};
    const put = (ctrl, value, isCheckbox) => {
      const input = ctrl && ctrl.__input;
      if (!input || input === document.activeElement) return;
      if (isCheckbox) { if (input.checked !== !!value) input.checked = !!value; }
      else if (String(input.value) !== String(value)) {
        input.value = String(value);
        if (ctrl.__out && ctrl.__format) setText(ctrl.__out, ctrl.__format(Number(value)));
      } else if (ctrl.__out && ctrl.__format) setText(ctrl.__out, ctrl.__format(Number(value)));
    };
    put(this.setMode, s.mode || 'solo', false);
    put(this.setSize, s.lobbySize || MATCH.defaultLobbySize, false);
    put(this.setFill, s.fillWithBots !== false, true);
    put(this.setDifficulty, s.botDifficulty || 'biquette', false);
    put(this.setFriendly, !!s.friendlyFire, true);
    put(this.setPublic, s.isPublic !== false, true);
    put(this.setName, s.name || '', false);

    const locked = !isHost || room.state !== ROOM_STATE.LOBBY;
    for (const c of [this.setMode, this.setSize, this.setFill, this.setDifficulty, this.setFriendly, this.setPublic, this.setName]) {
      if (c && c.__input) {
        setDisabled(c.__input, locked);
        c.__input.setAttribute('aria-readonly', locked ? 'true' : 'false');
      }
    }
    setHidden(this.readonlyHint, isHost);
  }

  _syncReadyButton() {
    const on = this._localReady;
    setText(this.readyBtn, on ? 'Prêt ! (cliquez pour annuler)' : 'Je suis prêt');
    this.readyBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    toggleClass(this.readyBtn, 'room__ready--on', on);
  }

  // -------------------------------------------------------------------------
  // 4. Ecran CHARGEMENT
  // -------------------------------------------------------------------------

  _buildLoading() {
    const s = this._section('loading', 'loading');
    s.append(this._logo(false), this._goat());
    const title = el('h2', 'loading__title', 'Préparation du troupeau…');
    title.setAttribute('role', 'status');
    title.setAttribute('aria-live', 'polite');
    const bar = el('div', 'loading__bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Chargement de la partie');
    bar.setAttribute('aria-valuetext', 'Chargement en cours');
    bar.appendChild(el('div', 'loading__bar-fill'));
    const tip = el('p', 'loading__tip');
    tip.appendChild(el('span', 'loading__tip-label', 'Astuce : '));
    this.tipText = el('span', 'loading__tip-text', TIPS[0]);
    tip.appendChild(this.tipText);
    s.append(title, bar, tip);
    return s;
  }

  _rollTip() {
    const t = TIPS[Math.floor(Math.random() * TIPS.length)];
    setText(this.tipText, t);
  }

  // -------------------------------------------------------------------------
  // 5. Ecran RESULTATS
  // -------------------------------------------------------------------------

  _buildResults() {
    const s = this._section('results', 'results');

    const banner = el('div', 'results__banner');
    this.resultsBanner = banner;
    this.resultsPlace = el('p', 'results__place', '#—');
    this.resultsTitle = el('h2', 'results__title', 'Partie terminée');
    this.resultsTitle.setAttribute('role', 'status');
    this.resultsTitle.setAttribute('aria-live', 'polite');
    this.resultsSub = el('p', 'results__subtitle', '');
    banner.append(this.resultsPlace, this.resultsTitle, this.resultsSub);
    s.appendChild(banner);

    this.resultsStats = el('div', 'results__stats');
    s.appendChild(this.resultsStats);

    const board = el('section', 'results__board');
    board.appendChild(el('h3', 'results__board-title', 'Tableau des scores'));
    this.resultsScroll = el('div', 'results__scroll');
    this.resultsScroll.tabIndex = 0;
    this.resultsScroll.setAttribute('role', 'region');
    this.resultsScroll.setAttribute('aria-label', 'Tableau des scores complet');
    board.appendChild(this.resultsScroll);
    s.appendChild(board);

    const actions = el('div', 'results__actions');
    this.resultsBack = this._button('Retour au salon', 'lobby__btn--ghost', () => {
      if (this.room) this.setScreen('room');
      else this._call('backToMenu');
    });
    this.resultsReplay = this._button('Rejouer', 'lobby__btn--primary', () => {
      if (this.room) {
        this._localReady = true;
        this._call('setReady', true);
        this._syncReadyButton();
        this.setScreen('room');
      } else {
        this._call('quickPlay');
      }
    });
    actions.append(this.resultsBack, this.resultsReplay);
    s.appendChild(actions);
    return s;
  }

  _statTile(value, label) {
    const t = el('div', 'results__stat');
    t.append(el('span', 'results__stat-value', value), el('span', 'results__stat-label', label));
    return t;
  }

  // -------------------------------------------------------------------------
  // Compte a rebours et menu pause
  // -------------------------------------------------------------------------

  _buildCountdown() {
    const c = el('div', 'lobby__countdown');
    c.setAttribute('role', 'status');
    c.setAttribute('aria-live', 'assertive');
    c.hidden = true;
    this.countNumber = el('span', 'lobby__countdown-number', '');
    this.countLabel = el('span', 'lobby__countdown-label', 'La partie commence…');
    c.append(this.countNumber, this.countLabel);
    this.countdownEl = c;
    this.el.appendChild(c);
  }

  _buildPause() {
    const overlay = el('div', 'lobby__pause');
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const panel = el('div', 'lobby__pause-panel');
    const title = el('h2', 'lobby__pause-title', 'Pause');
    title.id = uid('pause');
    overlay.setAttribute('aria-labelledby', title.id);
    panel.appendChild(title);

    const acts = el('div', 'lobby__pause-actions');
    const resume = this._button('Reprendre', 'lobby__btn--primary lobby__btn--wide', () => this._resume());
    this.pauseResume = resume;
    const optToggle = this._button('Options', 'lobby__btn--ghost lobby__btn--wide', () => {
      const open = this.pauseOptions.el.hidden;
      setHidden(this.pauseOptions.el, !open);
      optToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    optToggle.setAttribute('aria-expanded', 'false');
    const quit = this._button('Quitter la partie', 'lobby__btn--danger lobby__btn--wide', () => {
      this.setPauseMenu(false);
      this._call('backToMenu');
    });
    acts.append(resume, optToggle, quit);
    panel.appendChild(acts);

    this.pauseOptions = this._buildOptionsPanel();
    this.pauseOptions.el.hidden = true;
    optToggle.setAttribute('aria-controls', (this.pauseOptions.el.id = uid('opts')));
    panel.appendChild(this.pauseOptions.el);

    overlay.appendChild(panel);
    this._on(overlay, 'keydown', (e) => this._pauseKeydown(e));
    this.pauseEl = overlay;
    this.el.appendChild(overlay);
  }

  _pauseFocusables() {
    const sel = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return [...this.pauseEl.querySelectorAll(sel)].filter((n) => !n.hidden && n.offsetParent !== null);
  }

  _pauseKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this._resume(); return; }
    if (e.key !== 'Tab') return;
    const items = this._pauseFocusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  _movePauseFocus(delta) {
    const items = this._pauseFocusables();
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = items[(i < 0 ? 0 : i + delta + items.length) % items.length];
    if (next) next.focus();
  }

  _resume() {
    if (typeof this.actions.resume === 'function') { this._call('resume'); this.setPauseMenu(false); return; }
    const app = typeof window !== 'undefined' ? window.KoRoyale : null;
    if (app && typeof app.toggleMenu === 'function') { app.toggleMenu(); return; }
    this.setPauseMenu(false);
  }

  // -- manette dans le menu pause ------------------------------------------

  _startGamepadLoop() {
    if (this._gpRaf || typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    const step = () => {
      if (!this.pauseOpen || this.destroyed) { this._gpRaf = 0; return; }
      this._pollGamepad();
      this._gpRaf = requestAnimationFrame(step);
    };
    this._gpRaf = requestAnimationFrame(step);
  }

  _stopGamepadLoop() {
    if (this._gpRaf) { cancelAnimationFrame(this._gpRaf); this._gpRaf = 0; }
    this._gpPrev = { up: false, down: false, a: false, b: false };
  }

  _pollGamepad() {
    let pads = [];
    try { pads = navigator.getGamepads() || []; } catch { return; }
    let up = false, down = false, a = false, b = false;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const btn = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
      const ay = p.axes && p.axes.length > 1 ? p.axes[1] : 0;
      up = up || btn(12) || ay < -0.6;
      down = down || btn(13) || ay > 0.6;
      a = a || btn(0);
      b = b || btn(1);
    }
    const prev = this._gpPrev;
    if (up && !prev.up) this._movePauseFocus(-1);
    if (down && !prev.down) this._movePauseFocus(1);
    if (a && !prev.a) {
      const el0 = document.activeElement;
      if (el0 && this.pauseEl.contains(el0) && typeof el0.click === 'function') el0.click();
      else if (this.pauseResume) this.pauseResume.click();
    }
    if (b && !prev.b) this._resume();
    this._gpPrev = { up, down, a, b };
  }

  // -------------------------------------------------------------------------
  // API PUBLIQUE
  // -------------------------------------------------------------------------

  setScreen(name) {
    if (this.destroyed) return;
    const valid = ['connecting', 'menu', 'room', 'loading', 'playing', 'results'];
    const next = valid.includes(name) ? name : 'menu';
    const changed = next !== this.screen;
    this.screen = next;
    this.el.dataset.screen = next;

    for (const key of Object.keys(this.screens)) setHidden(this.screens[key], key !== next);
    if (next !== 'room') setHidden(this.countdownEl, true);
    if (next === 'loading' && changed) this._rollTip();
    setHidden(this.el, next === 'playing' && !this.pauseOpen);
    setHidden(this.offlineBar, this.connection !== 'closed' || next === 'playing');

    const sec = this.screens[next];
    if (sec && changed && !this._firstScreen) {
      const active = document.activeElement;
      if (!active || !sec.contains(active)) {
        try { sec.focus({ preventScroll: true }); } catch { sec.focus(); }
      }
    }
    this._firstScreen = false;
  }

  setConnection(state) {
    if (this.destroyed) return;
    this.connection = state;
    const closed = state === 'closed';
    setHidden(this.offlineBar, !closed || this.screen === 'playing');
    setHidden(this.connectRetry, !closed);
    if (state === 'connecting') setText(this.connectStatus, 'Connexion au troupeau…');
    else if (state === 'open') setText(this.connectStatus, 'Connecté ! Préparation du menu…');
    else setText(this.connectStatus, 'Connexion perdue. Le jeu tente de rejoindre le troupeau…');
    setText(this.offlineText, 'Connexion perdue. Tentative de reconnexion…');
  }

  setRooms(list) {
    if (this.destroyed) return;
    const rooms = Array.isArray(list) ? list : [];
    this.rooms = rooms;
    setText(this.roomsCount, rooms.length === 1 ? '1 salon' : `${rooms.length} salons`);
    setHidden(this.roomsEmpty, rooms.length > 0);

    const seen = new Set();
    let index = 0;
    for (const r of rooms) {
      if (!r || !r.code) continue;
      seen.add(r.code);
      let node = this._roomNodes.get(r.code);
      if (!node) {
        const li = el('li', 'menu__rooms-item');
        const btn = el('button', 'menu__room');
        btn.type = 'button';
        const name = el('span', 'menu__room-name');
        const meta = el('span', 'menu__room-meta');
        const code = el('span', 'menu__room-code');
        const mode = el('span', 'menu__room-mode');
        const count = el('span', 'menu__room-count');
        const state = el('span', 'menu__room-state');
        meta.append(code, mode, count, state);
        btn.append(name, meta);
        li.appendChild(btn);
        node = { li, btn, name, code, mode, count, state, joinCode: r.code };
        this._on(btn, 'click', () => this._call('joinRoom', node.joinCode));
        this._roomNodes.set(r.code, node);
      }
      node.joinCode = r.code;
      const stateLabel = STATE_LABELS[r.state] || 'Ouvert';
      setText(node.name, r.name || 'Salon de chèvres');
      setText(node.code, r.code);
      setText(node.mode, modeName(r.mode));
      setText(node.count, `${r.players ?? 0}/${r.size ?? 0} joueurs`);
      setText(node.state, stateLabel);
      toggleClass(node.state, 'menu__room-state--playing', r.state === ROOM_STATE.PLAYING);
      const full = (r.players ?? 0) >= (r.size ?? 0);
      const busy = r.state === ROOM_STATE.PLAYING || r.state === ROOM_STATE.ENDED;
      setDisabled(node.btn, full || busy);
      node.btn.setAttribute('aria-label',
        `Rejoindre ${r.name || 'le salon'}, code ${String(r.code).split('').join(' ')}, ${modeName(r.mode)}, ${r.players ?? 0} sur ${r.size ?? 0} joueurs, ${stateLabel}`);
      if (this.roomsList.children[index] !== node.li) {
        this.roomsList.insertBefore(node.li, this.roomsList.children[index] || null);
      }
      index++;
    }
    for (const [code, node] of [...this._roomNodes]) {
      if (!seen.has(code)) { node.li.remove(); this._roomNodes.delete(code); }
    }
  }

  setRoom(room) {
    if (this.destroyed) return;
    if (!room) {
      this.room = null;
      this._myId = null;
      this._localReady = false;
      this._chatCode = null;
      this._chatLines.length = 0;
      while (this.chatLog.firstChild) this.chatLog.removeChild(this.chatLog.firstChild);
      for (const [, node] of this._memberNodes) node.li.remove();
      this._memberNodes.clear();
      setHidden(this.countdownEl, true);
      this._syncReadyButton();
      return;
    }
    room.members = Array.isArray(room.members) ? room.members : [];
    room.bots = Array.isArray(room.bots) ? room.bots : [];
    this.room = room;

    const myId = this._resolveMyId(room);
    const isHost = !!(myId && room.hostId === myId);

    setText(this.roomName, (room.settings && room.settings.name) || room.name || 'Salon de chèvres');
    setText(this.roomCode, room.code || '—');
    this.roomCode.setAttribute('aria-label', `Code du salon : ${String(room.code || '').split('').join(' ')}`);

    const size = (room.settings && room.settings.lobbySize) || MATCH.defaultLobbySize;
    setText(this.memberCount, `${room.members.length + room.bots.length}/${size}`);

    this._renderMembers(room, isHost, myId);

    const auto = Number(room.autoFill) || 0;
    setHidden(this.autoFillLine, auto <= 0);
    if (auto > 0) {
      setText(this.autoFillLine, `+ ${auto} chèvre${auto > 1 ? 's' : ''} IA complétera${auto > 1 ? 'ont' : ''} la partie`);
    }

    setHidden(this.botActions, !isHost);
    this._applySettingsControls(room, isHost);

    const me = myId ? room.members.find((m) => m.id === myId) : null;
    if (me) this._localReady = !!me.ready;
    this._syncReadyButton();
    setDisabled(this.readyBtn, room.state !== ROOM_STATE.LOBBY);
    setHidden(this.startBtn, !isHost);
    setDisabled(this.startBtn, room.state !== ROOM_STATE.LOBBY);

    // chat : on ne reconstruit qu'au changement de salon
    if (this._chatCode !== room.code) {
      this._chatCode = room.code;
      this._chatLines.length = 0;
      while (this.chatLog.firstChild) this.chatLog.removeChild(this.chatLog.firstChild);
      for (const c of room.chat || []) this.pushChat(c);
    }
    if (room.state !== ROOM_STATE.COUNTDOWN) setHidden(this.countdownEl, true);
  }

  setCountdown(seconds) {
    if (this.destroyed) return;
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    this._clearTimer(this._countTimer);
    if (s > 0) {
      setHidden(this.countdownEl, false);
      setText(this.countNumber, String(s));
      setText(this.countLabel, s <= 3 ? 'Accrochez vos sabots !' : 'La partie commence…');
    } else {
      setHidden(this.countdownEl, false);
      setText(this.countNumber, 'C’EST PARTI !');
      setText(this.countLabel, '');
      this._countTimer = this._after(() => setHidden(this.countdownEl, true), 1400);
    }
  }

  setError(text) {
    if (this.destroyed) return;
    const t = String(text || 'Erreur').slice(0, 240);
    setText(this.toastText, t);
    setHidden(this.toastEl, false);
    this._clearTimer(this._toastTimer);
    this._toastTimer = this._after(() => setHidden(this.toastEl, true), 7000);
  }

  pushChat(entry) {
    if (this.destroyed || !entry) return;
    const log = this.chatLog;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;

    const li = el('li', `room__chat-line${entry.sys ? ' room__chat-line--sys' : ''}`);
    if (!entry.sys && entry.from) {
      const from = el('span', 'room__chat-from', `${entry.from} : `);
      from.style.color = nameColor(entry.id || entry.from);
      li.appendChild(from);
    }
    li.appendChild(el('span', 'room__chat-text', String(entry.text == null ? '' : entry.text)));
    log.appendChild(li);
    this._chatLines.push(li);
    while (this._chatLines.length > CHAT_MAX_LINES) {
      const old = this._chatLines.shift();
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  setResults(payload) {
    if (this.destroyed || !payload) return;
    const res = payload.results || {};
    const board = Array.isArray(payload.scoreboard) ? payload.scoreboard.slice() : [];
    const me = payload.me || null;
    if (me) this._myId = me;

    const placements = Array.isArray(res.placements) ? res.placements : [];
    const winners = Array.isArray(res.winners) ? res.winners : [];
    const won = !!(me && winners.some((w) => w.id === me));
    const mine = placements.find((p) => p.id === me) || null;
    const mineSb = board.find((p) => p.i === me) || null;

    const place = mine ? mine.place : (mineSb && mineSb.pl) || null;
    const kills = mine ? mine.kills : (mineSb ? mineSb.k : 0);
    const damage = mine ? mine.damage : (mineSb ? mineSb.d : 0);
    const survived = mine && mine.time != null ? mine.time : res.duration;

    toggleClass(this.resultsBanner, 'results__banner--win', won);
    setText(this.resultsPlace, place ? `#${place}` : '#—');
    setText(this.resultsTitle, won ? 'VICTOIRE ROYALE !' : (place ? `#${place}` : 'Partie terminée'));
    if (won) {
      setText(this.resultsSub, 'Le troupeau vous salue : le Rocher est à vous.');
    } else if (place) {
      const name = winners.length ? winners.map((w) => w.name).join(', ') : 'personne';
      setText(this.resultsSub, `${place}ᵉ place sur ${placements.length || board.length} chèvres. Victoire de ${name}.`);
    } else {
      setText(this.resultsSub, 'La partie est terminée.');
    }

    while (this.resultsStats.firstChild) this.resultsStats.removeChild(this.resultsStats.firstChild);
    this.resultsStats.append(
      this._statTile(place ? `#${place}` : '—', 'Classement'),
      this._statTile(String(kills || 0), 'Éliminations'),
      this._statTile(String(Math.round(damage || 0)), 'Dégâts infligés'),
      this._statTile(fmtDuration(survived), 'Temps de survie'),
    );

    // --- tableau des scores ---
    while (this.resultsScroll.firstChild) this.resultsScroll.removeChild(this.resultsScroll.firstChild);
    board.sort((a, b) => (a.pl || 9999) - (b.pl || 9999) || (b.k || 0) - (a.k || 0));
    const teams = new Map();
    for (const r of board) teams.set(r.tm, (teams.get(r.tm) || 0) + 1);
    const showTeams = [...teams.values()].some((n) => n > 1) && teams.size > 1;

    const table = el('table', 'results__table');
    const caption = el('caption', 'lobby__sr-only', 'Classement final de la partie');
    table.appendChild(caption);
    const thead = el('thead');
    const trh = el('tr');
    const cols = ['#', 'Chèvre'];
    if (showTeams) cols.push('Équipe');
    cols.push('Élim.', 'Dégâts', 'État');
    for (const c of cols) {
      const th = el('th', 'results__th', c);
      th.scope = 'col';
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const r of board) {
      const tr = el('tr', 'results__row');
      toggleClass(tr, 'results__row--me', !!(me && r.i === me));
      toggleClass(tr, 'results__row--win', r.pl === 1);
      const cells = [
        el('td', 'results__cell results__cell--place', r.pl ? `#${r.pl}` : '—'),
      ];
      const nameCell = el('td', 'results__cell results__cell--name');
      nameCell.appendChild(el('span', null, r.n || 'Chèvre'));
      if (r.bot) {
        const badge = el('span', 'lobby__badge lobby__badge--bot', 'IA');
        nameCell.appendChild(badge);
      }
      if (me && r.i === me) nameCell.appendChild(el('span', 'lobby__badge lobby__badge--me', 'Vous'));
      cells.push(nameCell);
      if (showTeams) cells.push(el('td', 'results__cell results__cell--num', r.tm != null ? String(r.tm) : '—'));
      cells.push(el('td', 'results__cell results__cell--num', String(r.k || 0)));
      cells.push(el('td', 'results__cell results__cell--num', String(Math.round(r.d || 0))));
      cells.push(el('td', 'results__cell results__cell--state', r.a ? 'Survivante' : 'Éliminée'));
      for (const c of cells) tr.appendChild(c);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    this.resultsScroll.appendChild(table);

    setText(this.resultsBack, this.room ? 'Retour au salon' : 'Retour au menu');
  }

  setPauseMenu(open) {
    if (this.destroyed) return;
    const on = !!open;
    if (on === this.pauseOpen) {
      setHidden(this.pauseEl, !on);
      return;
    }
    this.pauseOpen = on;
    setHidden(this.pauseEl, !on);
    setHidden(this.el, this.screen === 'playing' && !on);
    if (on) {
      this._pauseReturnFocus = document.activeElement;
      const first = this._pauseFocusables()[0];
      if (first) { try { first.focus({ preventScroll: true }); } catch { first.focus(); } }
      this._startGamepadLoop();
    } else {
      this._stopGamepadLoop();
      setHidden(this.pauseOptions.el, true);
      const back = this._pauseReturnFocus;
      this._pauseReturnFocus = null;
      if (back && typeof back.focus === 'function' && document.contains(back)) {
        try { back.focus({ preventScroll: true }); } catch { back.focus(); }
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stopGamepadLoop();
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    for (const [node, type, fn, opts] of this._listeners) {
      try { node.removeEventListener(type, fn, opts); } catch { /* noeud deja libere */ }
    }
    this._listeners.length = 0;
    this._memberNodes.clear();
    this._roomNodes.clear();
    this._chatLines.length = 0;
    this._optionPanels.length = 0;
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
    this.screens = {};
    this.room = null;
  }
}

export default LobbyUI;
