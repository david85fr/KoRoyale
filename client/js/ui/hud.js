// KoRoyale — HUD de partie.
//
// Interface affichee pendant le match : vie/bouclier, inventaire, munitions,
// reticule, minimap, tempete, kill-feed, invites d'interaction, vehicule,
// largage, tableau des scores, grande carte et chat.
//
// Contraintes respectees :
//  - le DOM est construit UNE seule fois (constructeur) ; update() ne fait que
//    comparer/ecrire les valeurs qui ont change (setText / css / attr memorisent
//    la derniere valeur ecrite sur le noeud lui-meme) ;
//  - les canvas (minimap + grande carte) ne se redessinent que si la vue a bouge
//    (> 0.5 m, > 0.01 rad) ou si la tempete / les marqueurs ont change ;
//  - aucun innerHTML avec du contenu reseau : pseudos, noms d'armes et messages
//    passent exclusivement par textContent ;
//  - rien ne touche au DOM a l'import : tout se passe dans le constructeur.
//
// -----------------------------------------------------------------------------
// LISTE COMPLETE DES CLASSES CSS UTILISEES (prefixe hud__, stables)
// -----------------------------------------------------------------------------
// Racine / calques plein ecran :
//   hud__root, hud__root--touch, hud__root--scoped
//   hud__banner
//   hud__toast, hud__toast--show
//   hud__flash
//   hud__scope, hud__scope-vignette, hud__scope-lens, hud__scope-cross,
//   hud__scope-cross--v, hud__scope-cross--h, hud__scope-ticks, hud__scope-tick,
//   hud__scope-tick--major
//
// Centre de l'ecran (reticule, anneaux, degats) :
//   hud__center, hud__crosshair,
//   hud__cross-line, hud__cross-line--top, hud__cross-line--right,
//   hud__cross-line--bottom, hud__cross-line--left,
//   hud__cross-dot, hud__cross-label,
//   hud__hit, hud__hit--head, hud__hit-bar, hud__hit-bar--a, hud__hit-bar--b,
//   hud__ring, hud__ring-track, hud__ring-arc,
//   hud__ring--reload, hud__ring--item, hud__ring--chest,
//   hud__dmg, hud__dmg-arc
//
// Minimap (haut gauche) :
//   hud__minimap, hud__minimap-canvas, hud__minimap-ring, hud__zone
//
// Compteurs / tempete / kill-feed (haut droite) :
//   hud__topright, hud__counters, hud__count, hud__count--alive,
//   hud__count--teams, hud__count-value, hud__count-label,
//   hud__stats, hud__stat, hud__stat--kills, hud__stat--damage,
//   hud__stat-value, hud__stat-label, hud__net,
//   hud__storm, hud__storm--shrinking, hud__storm-icon, hud__storm-text,
//   hud__storm-warn,
//   hud__killfeed, hud__kf, hud__kf--mine, hud__kf--me,
//   hud__kf-killer, hud__kf-arrow, hud__kf-victim, hud__kf-info
//
// Vie et bouclier (bas gauche) :
//   hud__vitals, hud__bar, hud__bar--health, hud__bar--shield,
//   hud__bar-icon, hud__bar-track, hud__bar-lag, hud__bar-fill, hud__bar-text
//
// Inventaire et munitions (bas droite) :
//   hud__inventory, hud__inventory--open, hud__slots, hud__slot,
//   hud__slot--active, hud__slot--empty, hud__slot-num, hud__slot-icon,
//   hud__slot-name, hud__slot-line, hud__slot-ammo, hud__slot-count,
//   hud__ammo, hud__ammo-mag, hud__ammo-sep, hud__ammo-reserve, hud__ammo-type,
//   hud__reserves, hud__reserve, hud__reserve-name, hud__reserve-count
//
// Invite d'interaction (bas centre) :
//   hud__interact, hud__interact-key, hud__interact-label, hud__interact-ring
//
// Vehicule :
//   hud__vehicle, hud__veh-name, hud__speedo, hud__speedo-track,
//   hud__speedo-arc, hud__speedo-needle, hud__speedo-value, hud__speedo-unit,
//   hud__veh-gauges, hud__gauge, hud__gauge--body, hud__gauge--fuel,
//   hud__gauge-label, hud__gauge-track, hud__gauge-fill,
//   hud__veh-seat, hud__veh-exit
//
// Largage / parapente :
//   hud__flight, hud__flight-alt, hud__flight-sub, hud__flight-hint,
//   hud__flight-compass, hud__flight-arrow
//
// Etats particuliers :
//   hud__downed, hud__downed-title, hud__downed-timer,
//   hud__spectate, hud__spectate-name, hud__spectate-hint
//
// Tableau des scores :
//   hud__scoreboard, hud__sb-panel, hud__sb-title, hud__sb-table, hud__sb-head,
//   hud__sb-row, hud__sb-row--dead, hud__sb-rank, hud__sb-name, hud__sb-bot,
//   hud__sb-kills, hud__sb-damage, hud__sb-state, hud__sb-state--dead
//
// Grande carte :
//   hud__map, hud__map-canvas, hud__map-title, hud__map-hint
//
// Chat en jeu :
//   hud__chat, hud__chat-label, hud__chat-input
//
// Utilitaires :
//   hud__key, hud__blink
// -----------------------------------------------------------------------------

import { GOAT, VEHICLE_TYPES, WORLD_HALF } from '/shared/constants.js';
import { RARITY, AMMO, WEAPONS, ITEMS, CHEST_KINDS } from '/shared/loot.js';
import { POIS, ISLAND, HARBOUR, MOUNT, BEACH, terrainHeight } from '/shared/mapdata.js';
import { trackSamples, CORNERS } from '/shared/track.js';

const TAU = Math.PI * 2;
const SLOT_COUNT = 5;
const AMMO_ORDER = ['light', 'medium', 'shells', 'rockets'];
const KEY_GLYPHS = { gamepad: { E: '✕', F: '⃞', ' ': '✕', Espace: '✕' } };

// ---------------------------------------------------------------------------
// Petits utilitaires DOM (avec memorisation de la derniere valeur ecrite)
// ---------------------------------------------------------------------------

function el(tag, cls, parent, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) { n.textContent = text; n.__t = text; }
  if (parent) parent.appendChild(n);
  return n;
}

function svgEl(tag, attrs, parent) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

/** textContent uniquement si la valeur a change. */
function setText(node, value) {
  const v = value == null ? '' : String(value);
  if (node.__t !== v) { node.__t = v; node.textContent = v; }
}

/** style[prop] uniquement si la valeur a change. */
function css(node, prop, value) {
  const k = '__c_' + prop;
  if (node[k] !== value) { node[k] = value; node.style[prop] = value; }
}

/** setAttribute uniquement si la valeur a change. */
function attr(node, name, value) {
  const k = '__a_' + name;
  const v = String(value);
  if (node[k] !== v) { node[k] = v; node.setAttribute(name, v); }
}

/** classList.toggle uniquement si l'etat a change. */
function setCls(node, cls, on) {
  const k = '__k_' + cls;
  const b = !!on;
  if (node[k] !== b) { node[k] = b; node.classList.toggle(cls, b); }
}

function setHide(node, hidden) {
  const b = !!hidden;
  if (node.__h !== b) { node.__h = b; node.hidden = b; }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hexColor = (c) => (typeof c === 'number' ? '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6) : (c || '#ffffff'));
const round1 = (v) => Math.round(v * 10) / 10;

function damp(a, b, lambda, dt) {
  return b + (a - b) * Math.exp(-lambda * dt);
}

/** « 0:42 » */
function fmtTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Nom court pour un emplacement d'inventaire (« Fusil d'Assaut « Bouquetin » » → « Bouquetin »). */
function shortName(name) {
  if (!name) return '';
  if (name.length <= 15) return name;
  const q = name.match(/[«"](.+?)[»"]/);
  if (q && q[1].length <= 15) return q[1].trim();
  const cut = name.slice(0, 14);
  const sp = cut.lastIndexOf(' ');
  return (sp > 6 ? cut.slice(0, sp) : cut) + '…';
}

// ---------------------------------------------------------------------------
// Feuille de style embarquee.
// Placee dans une couche @layer : n'importe quelle regle de /css/style.css
// (non-layered) la surclasse automatiquement, quel que soit l'ordre.
// ---------------------------------------------------------------------------

const STYLE_ID = 'koroyale-hud-style';
let styleUsers = 0;

function ensureStyle() {
  styleUsers++;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = HUD_CSS;
  document.head.appendChild(s);
}

function releaseStyle() {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers === 0) {
    const s = document.getElementById(STYLE_ID);
    if (s && s.parentNode) s.parentNode.removeChild(s);
  }
}

const HUD_CSS = `@layer koroyale-hud {
.hud__root{position:absolute;inset:0;overflow:hidden;pointer-events:none;color:#eef3f8;
  font-family:system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.25;
  -webkit-user-select:none;user-select:none;text-shadow:0 1px 2px rgba(0,0,0,.75)}
.hud__root [hidden]{display:none!important}
.hud__root *{box-sizing:border-box}
.hud__root :focus-visible{outline:2px solid #ffd166;outline-offset:2px}
.hud__key{display:inline-block;min-width:1.6em;padding:1px 6px;margin:0 2px;border-radius:5px;
  border:1px solid rgba(255,255,255,.55);background:rgba(10,16,24,.72);font-weight:700;font-size:.9em;text-align:center}
.hud__blink{animation:hud-blink 1s steps(2,start) infinite}
@keyframes hud-blink{0%,100%{opacity:1}50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.hud__blink{animation:none}}

/* --- calques plein ecran --- */
.hud__banner{position:absolute;top:0;left:0;right:0;padding:8px 14px;text-align:center;font-weight:700;
  background:linear-gradient(180deg,rgba(120,10,20,.92),rgba(120,10,20,.55));border-bottom:1px solid rgba(255,255,255,.25);z-index:9}
.hud__toast{position:absolute;top:9%;left:50%;transform:translateX(-50%);padding:7px 16px;border-radius:999px;
  background:rgba(8,14,22,.72);border:1px solid rgba(255,255,255,.18);font-weight:600;opacity:0;transition:opacity .18s ease}
.hud__toast--show{opacity:1}
.hud__flash{position:absolute;inset:0;opacity:0;pointer-events:none;
  background:radial-gradient(ellipse at center,rgba(140,0,0,0) 42%,rgba(160,10,10,.85) 100%)}
.hud__scope{position:absolute;inset:0}
.hud__scope-vignette{position:absolute;inset:0;background:radial-gradient(circle at center,rgba(0,0,0,0) 26vmin,rgba(0,0,0,.98) 32vmin)}
.hud__scope-lens{position:absolute;top:50%;left:50%;width:64vmin;height:64vmin;transform:translate(-50%,-50%);
  border-radius:50%;border:2px solid rgba(0,0,0,.9);box-shadow:inset 0 0 60px rgba(0,0,0,.6)}
.hud__scope-cross{position:absolute;background:rgba(15,20,15,.9)}
.hud__scope-cross--v{top:0;bottom:0;left:50%;width:1px;transform:translateX(-50%)}
.hud__scope-cross--h{left:0;right:0;top:50%;height:1px;transform:translateY(-50%)}
.hud__scope-ticks{position:absolute;inset:0}
.hud__scope-tick{position:absolute;background:rgba(15,20,15,.85)}
.hud__scope-tick--major{background:rgba(10,14,10,.95)}

/* --- centre : reticule --- */
.hud__center{position:absolute;top:50%;left:50%;width:0;height:0}
.hud__crosshair{position:absolute;top:0;left:0;width:0;height:0}
.hud__cross-line{position:absolute;top:0;left:0;width:2px;height:9px;margin:-4.5px 0 0 -1px;border-radius:1px;
  background:rgba(255,255,255,.92);box-shadow:0 0 2px rgba(0,0,0,.9)}
.hud__cross-dot{position:absolute;top:0;left:0;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;border-radius:50%;
  background:#fff;box-shadow:0 0 2px rgba(0,0,0,.9)}
.hud__hit{position:absolute;top:0;left:0;width:0;height:0}
.hud__hit-bar{position:absolute;top:0;left:0;width:2px;height:16px;margin:-8px 0 0 -1px;background:#fff;border-radius:1px}
.hud__hit-bar--a{transform:rotate(45deg)}
.hud__hit-bar--b{transform:rotate(-45deg)}
.hud__hit--head .hud__hit-bar{background:#ff4d4d}
.hud__ring{position:absolute;top:-32px;left:-32px;width:64px;height:64px;overflow:visible}
.hud__ring-track{fill:none;stroke:rgba(0,0,0,.45);stroke-width:3}
.hud__ring-arc{fill:none;stroke:#ffd166;stroke-width:3;stroke-linecap:round;transition:none}
.hud__ring--item .hud__ring-arc{stroke:#6ab04c}
.hud__ring--chest .hud__ring-arc{stroke:#5ad1ff}
.hud__cross-label{position:absolute;top:44px;left:0;transform:translateX(-50%);white-space:nowrap;
  font-size:13px;font-weight:600;letter-spacing:.02em}
.hud__dmg{position:absolute;top:-70px;left:-70px;width:140px;height:140px;overflow:visible}
.hud__dmg-arc{fill:none;stroke:#ff3b30;stroke-width:6;stroke-linecap:round;transform-origin:70px 70px}

/* --- minimap --- */
.hud__minimap{position:absolute;top:14px;left:14px;width:176px}
.hud__minimap-ring{position:relative;width:176px;height:176px;border-radius:50%;
  border:2px solid rgba(255,255,255,.35);background:rgba(6,12,20,.55);overflow:hidden;
  box-shadow:0 4px 18px rgba(0,0,0,.45)}
.hud__minimap-canvas{display:block;width:100%;height:100%;border-radius:50%}
.hud__zone{margin-top:6px;text-align:center;font-weight:700;font-size:13px;letter-spacing:.03em}

/* --- haut droite --- */
.hud__topright{position:absolute;top:14px;right:14px;width:min(320px,42vw);display:flex;flex-direction:column;
  align-items:flex-end;gap:6px}
.hud__counters{display:flex;gap:8px;align-items:flex-end}
.hud__count{padding:4px 10px;border-radius:8px;background:rgba(6,12,20,.6);border:1px solid rgba(255,255,255,.16);
  text-align:right}
.hud__count-value{font-size:20px;font-weight:800;line-height:1}
.hud__count-label{display:block;font-size:11px;opacity:.8}
.hud__stats{display:flex;gap:8px}
.hud__stat{padding:3px 9px;border-radius:8px;background:rgba(6,12,20,.55);border:1px solid rgba(255,255,255,.12);font-size:12px}
.hud__stat-value{font-weight:800}
.hud__stat-label{opacity:.75;margin-left:4px}
.hud__net{font-size:11px;opacity:.7;letter-spacing:.03em}
.hud__storm{padding:4px 10px;border-radius:8px;background:rgba(40,10,60,.6);border:1px solid rgba(180,120,255,.4);
  font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
.hud__storm--shrinking{background:rgba(70,10,70,.7);border-color:rgba(230,140,255,.75)}
.hud__storm-icon{font-size:14px}
.hud__storm-warn{padding:3px 10px;border-radius:8px;background:rgba(120,0,0,.75);border:1px solid rgba(255,120,120,.6);
  font-size:12px;font-weight:700}
.hud__killfeed{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:3px;align-items:flex-end}
.hud__kf{padding:2px 8px;border-radius:6px;background:rgba(6,12,20,.55);font-size:12px;max-width:100%;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hud__kf--mine{background:rgba(20,60,30,.7);border:1px solid rgba(120,230,150,.45)}
.hud__kf--me{background:rgba(80,10,10,.72);border:1px solid rgba(255,120,120,.5)}
.hud__kf-killer{font-weight:700}
.hud__kf-arrow{margin:0 5px;opacity:.85}
.hud__kf-victim{font-weight:700}
.hud__kf-info{margin-left:6px;opacity:.7;font-size:11px}

/* --- vie / bouclier --- */
.hud__vitals{position:absolute;left:16px;bottom:16px;width:min(300px,38vw);display:flex;flex-direction:column;gap:4px}
.hud__bar{display:flex;align-items:center;gap:7px}
.hud__bar-icon{width:18px;text-align:center;font-size:13px}
.hud__bar-track{position:relative;flex:1;height:15px;border-radius:4px;background:rgba(6,12,20,.65);
  border:1px solid rgba(255,255,255,.22);overflow:hidden}
.hud__bar-lag{position:absolute;inset:0 auto 0 0;width:0;background:rgba(230,60,60,.8);transition:none}
.hud__bar-fill{position:absolute;inset:0 auto 0 0;width:0}
.hud__bar--health .hud__bar-fill{background:linear-gradient(180deg,#7ee36a,#3aa93f)}
.hud__bar--shield .hud__bar-fill{background:linear-gradient(180deg,#8ed4ff,#2f86ff)}
.hud__bar--shield .hud__bar-track{height:9px}
.hud__bar-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;letter-spacing:.04em}

/* --- inventaire --- */
.hud__inventory{position:absolute;right:16px;bottom:16px;display:flex;align-items:flex-end;gap:12px}
.hud__slots{display:flex;gap:6px;align-items:flex-end;pointer-events:auto}
.hud__slot{position:relative;width:82px;height:64px;padding:3px 5px;border-radius:8px;color:inherit;
  background:rgba(6,12,20,.66);border:2px solid rgba(255,255,255,.22);font:inherit;text-align:left;
  display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;
  transition:transform .12s ease,background .12s ease}
.hud__slot--active{background:rgba(20,34,50,.9);transform:translateY(-6px);box-shadow:0 0 0 2px rgba(255,255,255,.35)}
.hud__slot--empty{opacity:.45}
.hud__slot-num{position:absolute;top:2px;right:5px;font-size:10px;font-weight:700;opacity:.8}
.hud__slot-icon{font-size:19px;line-height:1}
.hud__slot-name{font-size:10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.hud__slot-line{display:flex;justify-content:space-between;align-items:baseline;font-size:11px}
.hud__slot-ammo{font-weight:700}
.hud__slot-count{font-weight:700;opacity:.9}
.hud__ammo{text-align:right;min-width:92px}
.hud__ammo-mag{font-size:34px;font-weight:800;line-height:1}
.hud__ammo-sep{font-size:20px;opacity:.6;margin:0 2px}
.hud__ammo-reserve{font-size:19px;font-weight:700;opacity:.85}
.hud__ammo-type{display:block;font-size:11px;opacity:.75}
.hud__reserves{position:absolute;right:0;bottom:82px;padding:8px 10px;border-radius:8px;
  background:rgba(6,12,20,.72);border:1px solid rgba(255,255,255,.16);font-size:12px;min-width:190px}
.hud__reserve{display:flex;justify-content:space-between;gap:12px}
.hud__reserve-count{font-weight:700}

/* --- interaction --- */
.hud__interact{position:absolute;left:50%;bottom:23%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;
  padding:6px 14px;border-radius:10px;background:rgba(6,12,20,.62);border:1px solid rgba(255,255,255,.2);
  font-weight:600;white-space:nowrap}
.hud__interact-key{min-width:1.8em;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.9);color:#0d1b2a;font-weight:800}
.hud__interact-ring{position:absolute;top:50%;left:-30px;width:44px;height:44px;transform:translateY(-50%)}

/* --- vehicule --- */
.hud__vehicle{position:absolute;right:16px;bottom:104px;width:210px;padding:8px 10px;border-radius:10px;
  background:rgba(6,12,20,.6);border:1px solid rgba(255,255,255,.16)}
.hud__veh-name{font-size:12px;font-weight:700;opacity:.9;margin-bottom:2px}
.hud__speedo{display:block;width:100%;height:74px}
.hud__speedo-track{fill:none;stroke:rgba(255,255,255,.18);stroke-width:7;stroke-linecap:round}
.hud__speedo-arc{fill:none;stroke:#ffd166;stroke-width:7;stroke-linecap:round}
.hud__speedo-needle{stroke:#ff5252;stroke-width:2.5;stroke-linecap:round}
.hud__speedo-value{font-size:22px;font-weight:800;fill:#fff;text-anchor:middle}
.hud__speedo-unit{font-size:9px;fill:rgba(255,255,255,.75);text-anchor:middle}
.hud__veh-gauges{display:flex;flex-direction:column;gap:3px;margin-top:2px}
.hud__gauge{display:flex;align-items:center;gap:6px;font-size:11px}
.hud__gauge-label{width:16px;text-align:center}
.hud__gauge-track{position:relative;flex:1;height:7px;border-radius:4px;background:rgba(0,0,0,.5);overflow:hidden}
.hud__gauge-fill{position:absolute;inset:0 auto 0 0;width:0}
.hud__gauge--body .hud__gauge-fill{background:#7ee36a}
.hud__gauge--fuel .hud__gauge-fill{background:#ffa000}
.hud__veh-seat{font-size:11px;opacity:.8;margin-top:3px}
.hud__veh-exit{font-size:11px;margin-top:2px}

/* --- largage --- */
.hud__flight{position:absolute;left:50%;top:14%;transform:translateX(-50%);text-align:center;
  padding:8px 16px;border-radius:12px;background:rgba(6,12,20,.55);border:1px solid rgba(255,255,255,.16)}
.hud__flight-alt{font-size:26px;font-weight:800;line-height:1}
.hud__flight-sub{font-size:12px;opacity:.8}
.hud__flight-hint{margin-top:4px;font-size:13px;font-weight:600}
.hud__flight-compass{width:44px;height:44px;margin:4px auto 0}
.hud__flight-arrow{fill:#ffd166;stroke:rgba(0,0,0,.6);stroke-width:1}

/* --- etats --- */
.hud__downed{position:absolute;left:50%;top:11%;transform:translateX(-50%);text-align:center;padding:8px 20px;
  border-radius:10px;background:rgba(120,0,0,.72);border:1px solid rgba(255,120,120,.6)}
.hud__downed-title{font-size:19px;font-weight:800}
.hud__downed-timer{font-size:14px;font-weight:700}
.hud__spectate{position:absolute;left:50%;top:11%;transform:translateX(-50%);text-align:center;padding:8px 20px;
  border-radius:10px;background:rgba(6,12,20,.62);border:1px solid rgba(255,255,255,.2)}
.hud__spectate-name{font-size:17px;font-weight:800}
.hud__spectate-hint{font-size:12px;opacity:.85;margin-top:3px}

/* --- tableau des scores --- */
.hud__scoreboard{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:rgba(4,8,14,.72);pointer-events:auto}
.hud__sb-panel{width:min(720px,92vw);max-height:80vh;overflow:auto;padding:14px 16px;border-radius:14px;
  background:rgba(8,14,22,.92);border:1px solid rgba(255,255,255,.18)}
.hud__sb-title{margin:0 0 10px;font-size:17px;font-weight:800;letter-spacing:.04em}
.hud__sb-table{width:100%;border-collapse:collapse;font-size:13px}
.hud__sb-table th,.hud__sb-table td{padding:5px 8px;text-align:left;border-bottom:1px solid rgba(255,255,255,.09)}
.hud__sb-head th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
.hud__sb-row--dead{opacity:.5}
.hud__sb-rank{width:3em;font-weight:800;opacity:.8}
.hud__sb-name{font-weight:700}
.hud__sb-bot{margin-left:6px;padding:0 5px;border-radius:4px;font-size:10px;font-weight:700;
  background:rgba(255,255,255,.16);letter-spacing:.06em}
.hud__sb-kills,.hud__sb-damage{width:5.5em;text-align:right!important;font-variant-numeric:tabular-nums}
.hud__sb-state{width:7em}
.hud__sb-state--dead{color:#ff8a8a}

/* --- grande carte --- */
.hud__map{position:absolute;inset:0;background:rgba(4,8,14,.86);pointer-events:auto;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px}
.hud__map-title{font-size:16px;font-weight:800;letter-spacing:.05em}
.hud__map-canvas{width:min(78vh,78vw);height:min(78vh,78vw);border-radius:10px;
  border:1px solid rgba(255,255,255,.2);cursor:crosshair;touch-action:none}
.hud__map-hint{font-size:12px;opacity:.8}

/* --- chat --- */
.hud__chat{position:absolute;left:16px;bottom:96px;display:flex;align-items:center;gap:8px;pointer-events:auto;
  padding:6px 10px;border-radius:8px;background:rgba(6,12,20,.85);border:1px solid rgba(255,255,255,.25)}
.hud__chat-label{font-size:12px;font-weight:700;opacity:.85}
.hud__chat-input{width:min(340px,50vw);padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.3);
  background:rgba(0,0,0,.5);color:#fff;font:inherit;font-size:13px}

/* --- tactile / petits ecrans --- */
.hud__root--touch .hud__slot{width:64px;height:56px}
.hud__root--touch .hud__ammo-mag{font-size:26px}
.hud__root--scoped .hud__crosshair{display:none}
@media (max-width:720px){
  .hud__minimap,.hud__minimap-ring{width:120px}
  .hud__minimap-ring{height:120px}
  .hud__slot{width:62px;height:54px}
  .hud__ammo-mag{font-size:26px}
  .hud__vitals{width:min(220px,46vw)}
  .hud__vehicle{width:160px}
}
}`;

// ---------------------------------------------------------------------------
// Geometrie de carte, calculee une seule fois (paresseusement)
// ---------------------------------------------------------------------------

let _geo = null;

/** Trace du circuit + points des virages + trait de cote, en coordonnees monde. */
function mapGeometry() {
  if (_geo) return _geo;
  const ss = trackSamples();
  const line = [];
  for (let i = 0; i < ss.length; i += 2) line.push(ss[i].x, ss[i].z);
  if (ss.length) line.push(ss[0].x, ss[0].z); // boucle fermee

  const corners = [];
  for (const c of CORNERS) {
    let s = null;
    for (let i = 0; i < ss.length; i++) { if (ss[i].cpIndex === c.cp) { s = ss[i]; break; } }
    if (s) corners.push({ name: c.name, x: s.x, z: s.z });
  }

  // Trait de cote : on cherche par dichotomie le rayon ou le terrain passe sous la mer.
  const coast = [];
  const N = 96;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    let lo = 520, hi = 880;
    for (let k = 1; k <= 18; k++) {
      const rr = 520 + (880 - 520) * (k / 18);
      if (terrainHeight(ISLAND.cx + ca * rr, ISLAND.cz + sa * rr) < 0) { hi = rr; break; }
      lo = rr;
    }
    for (let k = 0; k < 6; k++) {
      const mid = (lo + hi) * 0.5;
      if (terrainHeight(ISLAND.cx + ca * mid, ISLAND.cz + sa * mid) < 0) hi = mid; else lo = mid;
    }
    coast.push(ISLAND.cx + ca * lo, ISLAND.cz + sa * lo);
  }

  _geo = { line, corners, coast };
  return _geo;
}

// ---------------------------------------------------------------------------

export class HUD {
  constructor(opts = {}) {
    this.root = opts.root || document.body;
    this.destroyed = false;
    ensureStyle();

    // --- etats memorises (anti-reecriture + animations) ---
    this._time = 0;
    this._last = 0;
    this._lag = { health: 0, shield: 0, holdH: 0, holdS: 0 };
    this._spread = 0;
    this._reloadMax = 0;
    this._useMax = 0;
    this._kfSig = '';
    this._sbSig = '';
    this._slotSig = new Array(SLOT_COUNT).fill('');
    this._mm = { x: 1e9, z: 1e9, yaw: 1e9, sig: '', w: 0, h: 0, css: 0, dirty: true, need: true };
    this._bm = { sig: '', w: 0, h: 0, css: 0, dirty: true, need: true, at: 0 };
    this._scratch = [0, 0];
    this._chatSend = null;
    this._banner = null;

    this._build();
    this._wire();
  }

  // -------------------------------------------------------------------------
  // Construction du DOM (une seule fois)
  // -------------------------------------------------------------------------

  _build() {
    const r = el('div', 'hud__root', this.root);
    this.el = r;

    // --- bandeau persistant / toast / vignette de degats ---
    this.bannerEl = el('div', 'hud__banner', r);
    this.bannerEl.setAttribute('role', 'status');
    this.bannerEl.setAttribute('aria-live', 'polite');
    setHide(this.bannerEl, true);

    this.toastEl = el('div', 'hud__toast', r);
    this.toastEl.setAttribute('role', 'status');
    this.toastEl.setAttribute('aria-live', 'polite');

    this.flashEl = el('div', 'hud__flash', r);
    this.flashEl.setAttribute('aria-hidden', 'true');

    this._buildScope(r);
    this._buildCenter(r);
    this._buildMinimap(r);
    this._buildTopRight(r);
    this._buildVitals(r);
    this._buildInventory(r);
    this._buildInteract(r);
    this._buildVehicle(r);
    this._buildFlight(r);
    this._buildStates(r);
    this._buildScoreboard(r);
    this._buildBigMap(r);
    this._buildChat(r);
  }

  _buildScope(r) {
    const s = el('div', 'hud__scope', r);
    s.setAttribute('aria-hidden', 'true');
    el('div', 'hud__scope-vignette', s);
    const lens = el('div', 'hud__scope-lens', s);
    el('div', 'hud__scope-cross hud__scope-cross--v', lens);
    el('div', 'hud__scope-cross hud__scope-cross--h', lens);
    const ticks = el('div', 'hud__scope-ticks', lens);
    // graduations : verticales sous le centre, horizontales de part et d'autre
    for (let i = 1; i <= 6; i++) {
      const major = i % 2 === 0;
      const t = el('div', 'hud__scope-tick' + (major ? ' hud__scope-tick--major' : ''), ticks);
      t.style.cssText = `left:50%;top:calc(50% + ${i * 4}%);width:${major ? 5 : 3}%;height:1px;transform:translateX(-50%)`;
      const hL = el('div', 'hud__scope-tick' + (major ? ' hud__scope-tick--major' : ''), ticks);
      hL.style.cssText = `top:50%;left:calc(50% - ${i * 4}%);height:${major ? 5 : 3}%;width:1px;transform:translateY(-50%)`;
      const hR = el('div', 'hud__scope-tick' + (major ? ' hud__scope-tick--major' : ''), ticks);
      hR.style.cssText = `top:50%;left:calc(50% + ${i * 4}%);height:${major ? 5 : 3}%;width:1px;transform:translateY(-50%)`;
    }
    this.scopeEl = s;
    setHide(s, true);
  }

  _buildCenter(r) {
    const c = el('div', 'hud__center', r);
    c.setAttribute('aria-hidden', 'true');
    this.centerEl = c;

    // reticule
    const ch = el('div', 'hud__crosshair', c);
    this.crossEl = ch;
    this.crossLines = ['top', 'right', 'bottom', 'left'].map((d) =>
      el('div', `hud__cross-line hud__cross-line--${d}`, ch));
    css(this.crossLines[1], 'transform', 'rotate(90deg)');
    css(this.crossLines[3], 'transform', 'rotate(90deg)');
    this.crossDot = el('div', 'hud__cross-dot', ch);

    // marque de touche
    const hit = el('div', 'hud__hit', c);
    el('div', 'hud__hit-bar hud__hit-bar--a', hit);
    el('div', 'hud__hit-bar hud__hit-bar--b', hit);
    this.hitEl = hit;
    setHide(hit, true);

    // anneau de progression (rechargement / objet / coffre)
    const ring = svgEl('svg', { class: 'hud__ring', viewBox: '0 0 64 64', 'aria-hidden': 'true' }, c);
    svgEl('circle', { class: 'hud__ring-track', cx: 32, cy: 32, r: 27 }, ring);
    const arc = svgEl('circle', { class: 'hud__ring-arc', cx: 32, cy: 32, r: 27, transform: 'rotate(-90 32 32)' }, ring);
    this.ringC = TAU * 27;
    arc.setAttribute('stroke-dasharray', String(this.ringC));
    this.ringEl = ring;
    this.ringArc = arc;
    setHide(ring, true);

    this.crossLabel = el('div', 'hud__cross-label', c);
    setHide(this.crossLabel, true);

    // indicateur directionnel de degats
    const dmg = svgEl('svg', { class: 'hud__dmg', viewBox: '-70 -70 140 140', 'aria-hidden': 'true' }, c);
    this.dmgArc = svgEl('path', {
      class: 'hud__dmg-arc',
      d: 'M -29.83 -42.61 A 52 52 0 0 1 29.83 -42.61',
    }, dmg);
    this.dmgEl = dmg;
    setHide(dmg, true);
  }

  _buildMinimap(r) {
    const box = el('div', 'hud__minimap', r);
    const ring = el('div', 'hud__minimap-ring', box);
    const cv = el('canvas', 'hud__minimap-canvas', ring);
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', 'Carte des environs');
    this.minimapBox = box;
    this.minimapCanvas = cv;
    this.minimapCtx = cv.getContext('2d');
    this.zoneEl = el('div', 'hud__zone', box, '');
  }

  _buildTopRight(r) {
    const tr = el('div', 'hud__topright', r);
    this.topRight = tr;

    const counters = el('div', 'hud__counters', tr);
    const mkCount = (mod) => {
      const b = el('div', `hud__count hud__count--${mod}`, counters);
      const v = el('span', 'hud__count-value', b, '0');
      const l = el('span', 'hud__count-label', b, '');
      return { box: b, value: v, label: l };
    };
    this.cAlive = mkCount('alive');
    this.cTeams = mkCount('teams');
    setHide(this.cTeams.box, true);

    const stats = el('div', 'hud__stats', tr);
    const mkStat = (mod, label) => {
      const b = el('div', `hud__stat hud__stat--${mod}`, stats);
      const v = el('span', 'hud__stat-value', b, '0');
      el('span', 'hud__stat-label', b, label);
      return v;
    };
    this.sKills = mkStat('kills', 'élim.');
    this.sDamage = mkStat('damage', 'dégâts');

    this.netEl = el('div', 'hud__net', tr, '');

    const storm = el('div', 'hud__storm', tr);
    el('span', 'hud__storm-icon', storm, '🌫️');
    this.stormText = el('span', 'hud__storm-text', storm, '');
    this.stormEl = storm;

    this.stormWarn = el('div', 'hud__storm-warn hud__blink', tr, '');
    this.stormWarn.setAttribute('role', 'status');
    this.stormWarn.setAttribute('aria-live', 'polite');
    setHide(this.stormWarn, true);

    const kf = el('ul', 'hud__killfeed', tr);
    kf.setAttribute('role', 'log');
    kf.setAttribute('aria-live', 'polite');
    kf.setAttribute('aria-label', 'Éliminations');
    this.killfeedEl = kf;
    this.kfRows = [];
  }

  _buildVitals(r) {
    const v = el('div', 'hud__vitals', r);
    const mkBar = (mod, icon, label) => {
      const b = el('div', `hud__bar hud__bar--${mod}`, v);
      el('span', 'hud__bar-icon', b, icon);
      const track = el('div', 'hud__bar-track', b);
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', label);
      track.setAttribute('aria-valuemin', '0');
      const lag = el('div', 'hud__bar-lag', track);
      const fill = el('div', 'hud__bar-fill', track);
      const text = el('div', 'hud__bar-text', track, '');
      return { box: b, track, lag, fill, text };
    };
    this.shieldBar = mkBar('shield', '🛡️', 'Bouclier');
    this.healthBar = mkBar('health', '❤️', 'Points de vie');
    this.vitalsEl = v;
  }

  _buildInventory(r) {
    const inv = el('div', 'hud__inventory', r);
    this.inventoryEl = inv;

    const slots = el('div', 'hud__slots', inv);
    slots.setAttribute('role', 'group');
    slots.setAttribute('aria-label', 'Emplacements d’inventaire');
    this.slotEls = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const b = el('button', 'hud__slot hud__slot--empty', slots);
      b.type = 'button';
      b.dataset.slot = String(i);
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', `Emplacement ${i + 1} : vide`);
      el('span', 'hud__slot-num', b, String(i + 1));
      const icon = el('span', 'hud__slot-icon', b, '');
      const name = el('span', 'hud__slot-name', b, '—');
      const line = el('span', 'hud__slot-line', b);
      const ammo = el('span', 'hud__slot-ammo', line, '');
      const count = el('span', 'hud__slot-count', line, '');
      this.slotEls.push({ box: b, icon, name, ammo, count });
    }

    const ammo = el('div', 'hud__ammo', inv);
    this.ammoMag = el('span', 'hud__ammo-mag', ammo, '—');
    this.ammoSep = el('span', 'hud__ammo-sep', ammo, '/');
    this.ammoReserve = el('span', 'hud__ammo-reserve', ammo, '0');
    this.ammoType = el('span', 'hud__ammo-type', ammo, '');
    this.ammoEl = ammo;

    const res = el('div', 'hud__reserves', inv);
    res.setAttribute('aria-label', 'Réserve de munitions');
    this.reserveEls = {};
    for (const id of AMMO_ORDER) {
      const row = el('div', 'hud__reserve', res);
      el('span', 'hud__reserve-name', row, AMMO[id].name);
      this.reserveEls[id] = el('span', 'hud__reserve-count', row, '0');
    }
    this.reservesEl = res;
    setHide(res, true);
  }

  _buildInteract(r) {
    const box = el('div', 'hud__interact', r);
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    this.interactKey = el('span', 'hud__interact-key', box, 'E');
    this.interactLabel = el('span', 'hud__interact-label', box, '');
    const ring = svgEl('svg', { class: 'hud__interact-ring', viewBox: '0 0 44 44', 'aria-hidden': 'true' }, box);
    svgEl('circle', { class: 'hud__ring-track', cx: 22, cy: 22, r: 18 }, ring);
    const arc = svgEl('circle', {
      class: 'hud__ring-arc', cx: 22, cy: 22, r: 18, transform: 'rotate(-90 22 22)',
    }, ring);
    this.interactC = TAU * 18;
    arc.setAttribute('stroke-dasharray', String(this.interactC));
    this.interactRing = ring;
    this.interactArc = arc;
    this.interactEl = box;
    setHide(box, true);
    setHide(ring, true);
  }

  _buildVehicle(r) {
    const box = el('div', 'hud__vehicle', r);
    this.vehName = el('div', 'hud__veh-name', box, '');

    const sp = svgEl('svg', { class: 'hud__speedo', viewBox: '0 0 120 72', 'aria-hidden': 'true' }, box);
    svgEl('path', { class: 'hud__speedo-track', d: 'M 12 62 A 48 48 0 0 1 108 62' }, sp);
    const arc = svgEl('path', { class: 'hud__speedo-arc', d: 'M 12 62 A 48 48 0 0 1 108 62' }, sp);
    this.speedoC = Math.PI * 48;
    arc.setAttribute('stroke-dasharray', String(this.speedoC));
    arc.setAttribute('stroke-dashoffset', String(this.speedoC));
    const needle = svgEl('line', {
      class: 'hud__speedo-needle', x1: 60, y1: 62, x2: 60, y2: 24,
      transform: 'rotate(-90 60 62)',
    }, sp);
    const value = svgEl('text', { class: 'hud__speedo-value', x: 60, y: 56 }, sp);
    const unit = svgEl('text', { class: 'hud__speedo-unit', x: 60, y: 68 }, sp);
    unit.textContent = 'km/h';
    this.speedoArc = arc;
    this.speedoNeedle = needle;
    this.speedoValue = value;

    const gauges = el('div', 'hud__veh-gauges', box);
    const mkGauge = (mod, label, aria) => {
      const g = el('div', `hud__gauge hud__gauge--${mod}`, gauges);
      el('span', 'hud__gauge-label', g, label);
      const track = el('div', 'hud__gauge-track', g);
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', aria);
      return el('div', 'hud__gauge-fill', track);
    };
    this.vehBody = mkGauge('body', '🔧', 'Carrosserie');
    this.vehFuel = mkGauge('fuel', '⛽', 'Carburant');

    this.vehSeat = el('div', 'hud__veh-seat', box, '');
    this.vehExit = el('div', 'hud__veh-exit', box);
    const k = el('span', 'hud__key', this.vehExit, 'F');
    this.vehExitKey = k;
    el('span', null, this.vehExit, ' Sortir');

    this.vehicleEl = box;
    setHide(box, true);
  }

  _buildFlight(r) {
    const box = el('div', 'hud__flight', r);
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    this.flightAlt = el('div', 'hud__flight-alt', box, '');
    this.flightSub = el('div', 'hud__flight-sub', box, '');
    this.flightHint = el('div', 'hud__flight-hint', box, '');
    const sv = svgEl('svg', { class: 'hud__flight-compass', viewBox: '-22 -22 44 44', 'aria-hidden': 'true' }, box);
    svgEl('circle', { cx: 0, cy: 0, r: 20, fill: 'rgba(0,0,0,.35)', stroke: 'rgba(255,255,255,.35)' }, sv);
    this.flightArrow = svgEl('path', {
      class: 'hud__flight-arrow', d: 'M 0 -16 L 7 8 L 0 3 L -7 8 Z',
    }, sv);
    this.flightCompass = sv;
    this.flightEl = box;
    setHide(box, true);
  }

  _buildStates(r) {
    const d = el('div', 'hud__downed', r);
    d.setAttribute('role', 'alert');
    el('div', 'hud__downed-title', d, 'Vous êtes à terre');
    this.downedTimer = el('div', 'hud__downed-timer', d, '');
    this.downedEl = d;
    setHide(d, true);

    const s = el('div', 'hud__spectate', r);
    s.setAttribute('role', 'status');
    s.setAttribute('aria-live', 'polite');
    this.spectateName = el('div', 'hud__spectate-name', s, '');
    const hint = el('div', 'hud__spectate-hint', s);
    el('span', 'hud__key', hint, 'Espace');
    el('span', null, hint, ' Chèvre suivante');
    this.spectateEl = s;
    setHide(s, true);
  }

  _buildScoreboard(r) {
    const box = el('div', 'hud__scoreboard', r);
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Tableau des scores');
    const panel = el('div', 'hud__sb-panel', box);
    el('h2', 'hud__sb-title', panel, 'Tableau des scores');
    const table = el('table', 'hud__sb-table', panel);
    const thead = el('thead', null, table);
    const hr = el('tr', 'hud__sb-head', thead);
    for (const [txt, cls] of [['#', 'hud__sb-rank'], ['Chèvre', 'hud__sb-name'], ['Élim.', 'hud__sb-kills'],
      ['Dégâts', 'hud__sb-damage'], ['État', 'hud__sb-state']]) {
      const th = el('th', cls, hr, txt);
      th.scope = 'col';
    }
    this.sbBody = el('tbody', null, table);
    this.sbRows = [];
    this.scoreboardEl = box;
    setHide(box, true);
  }

  _buildBigMap(r) {
    const box = el('div', 'hud__map', r);
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Carte de Monaco');
    el('div', 'hud__map-title', box, 'Monaco — Rocher & Circuit');
    const cv = el('canvas', 'hud__map-canvas', box);
    cv.tabIndex = 0;
    cv.setAttribute('role', 'application');
    cv.setAttribute('aria-label', 'Carte : cliquez pour poser un marqueur');
    el('div', 'hud__map-hint', box, 'Clic (ou Entrée) pour poser un marqueur — la même touche referme la carte.');
    this.mapEl = box;
    this.mapCanvas = cv;
    this.mapCtx = cv.getContext('2d');
    setHide(box, true);
  }

  _buildChat(r) {
    const form = el('form', 'hud__chat', r);
    form.setAttribute('aria-label', 'Chat de partie');
    const id = 'hud-chat-input';
    const label = el('label', 'hud__chat-label', form, 'Dire :');
    label.htmlFor = id;
    const input = el('input', 'hud__chat-input', form);
    input.type = 'text';
    input.id = id;
    input.maxLength = 200;
    input.autocomplete = 'off';
    input.placeholder = 'Message… (Entrée pour envoyer, Échap pour annuler)';
    this.chatForm = form;
    this.chatInput = input;
    setHide(form, true);
  }

  // -------------------------------------------------------------------------
  // Evenements
  // -------------------------------------------------------------------------

  _wire() {
    this._onSlotClick = (ev) => {
      const btn = ev.target.closest ? ev.target.closest('.hud__slot') : null;
      if (!btn) return;
      ev.preventDefault();
      const slot = Number(btn.dataset.slot);
      btn.blur();
      this.root.dispatchEvent(new CustomEvent('hud:slot', { detail: { slot }, bubbles: true }));
    };
    this.el.addEventListener('click', this._onSlotClick);

    this._onMapClick = (ev) => {
      const rect = this.mapCanvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const p = this._mapWorldAt(ev.clientX - rect.left, ev.clientY - rect.top, rect.width, rect.height);
      if (p) this.root.dispatchEvent(new CustomEvent('hud:mark', { detail: { x: p[0], z: p[1] }, bubbles: true }));
    };
    this.mapCanvas.addEventListener('click', this._onMapClick);

    this._onMapKey = (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      const rect = this.mapCanvas.getBoundingClientRect();
      const p = this._mapWorldAt(rect.width / 2, rect.height / 2, rect.width, rect.height);
      if (p) this.root.dispatchEvent(new CustomEvent('hud:mark', { detail: { x: p[0], z: p[1] }, bubbles: true }));
    };
    this.mapCanvas.addEventListener('keydown', this._onMapKey);

    this._onChatSubmit = (ev) => {
      ev.preventDefault();
      const text = this.chatInput.value.trim();
      if (text && this._chatSend) { try { this._chatSend(text); } catch { /* ignore */ } }
      this.closeChat();
    };
    this.chatForm.addEventListener('submit', this._onChatSubmit);

    this._onChatKey = (ev) => {
      ev.stopPropagation(); // le jeu ne doit pas interpreter la frappe
      if (ev.key === 'Escape') { ev.preventDefault(); this.closeChat(); }
    };
    this.chatInput.addEventListener('keydown', this._onChatKey);
    this.chatInput.addEventListener('keyup', (e) => e.stopPropagation());
    this.chatInput.addEventListener('keypress', (e) => e.stopPropagation());

    this._onResize = () => {
      this._mm.dirty = this._mm.need = true;
      this._bm.dirty = this._bm.need = true;
    };
    window.addEventListener('resize', this._onResize, { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(this.minimapCanvas);
      this._ro.observe(this.mapCanvas);
    }
  }

  // -------------------------------------------------------------------------
  // API publique
  // -------------------------------------------------------------------------

  /** Bandeau persistant en haut de l'ecran (null pour l'effacer). */
  setBanner(text) {
    if (this.destroyed) return;
    this._banner = text || null;
    setText(this.bannerEl, this._banner || '');
    setHide(this.bannerEl, !this._banner);
  }

  /** Ouvre la saisie de chat ; sendFn(texte) est appele a l'envoi. */
  openChat(sendFn) {
    if (this.destroyed) return;
    this._chatSend = typeof sendFn === 'function' ? sendFn : null;
    this.chatInput.value = '';
    setHide(this.chatForm, false);
    // le focus est pris apres la frappe qui a ouvert le chat
    this._focusTimer = setTimeout(() => { try { this.chatInput.focus(); } catch { /* detache */ } }, 0);
  }

  closeChat() {
    if (this.destroyed) return;
    this.chatInput.value = '';
    setHide(this.chatForm, true);
    try { this.chatInput.blur(); } catch { /* detache */ }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this._focusTimer);
    this.el.removeEventListener('click', this._onSlotClick);
    this.mapCanvas.removeEventListener('click', this._onMapClick);
    this.mapCanvas.removeEventListener('keydown', this._onMapKey);
    this.chatForm.removeEventListener('submit', this._onChatSubmit);
    this.chatInput.removeEventListener('keydown', this._onChatKey);
    window.removeEventListener('resize', this._onResize);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
    releaseStyle();
  }

  // -------------------------------------------------------------------------
  // Boucle : 60 fois par seconde
  // -------------------------------------------------------------------------

  update(view) {
    if (this.destroyed || !view) return;
    const now = performance.now();
    const dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 0.016;
    this._last = now;
    this._time += dt;

    const ready = !!view.minimap; // buildView() renvoie {phase:'loading'} avant le 1er snapshot
    setCls(this.el, 'hud__root--touch', !!view.touch);
    setCls(this.el, 'hud__root--scoped', !!(view.crosshair && view.crosshair.scoped));

    this._updateToast(view);

    if (!ready) {
      this._hideAll();
      return;
    }

    this._updateVitals(view, dt);
    this._updateInventory(view);
    this._updateCrosshair(view, dt);
    this._updateTopRight(view);
    this._updateStorm(view);
    this._updateKillfeed(view);
    this._updateInteract(view);
    this._updateVehicle(view);
    this._updateFlight(view);
    this._updateStates(view);
    this._updateMinimap(view);
    this._updateScoreboard(view);
    this._updateBigMap(view, now);
  }

  _hideAll() {
    for (const n of [this.vitalsEl, this.inventoryEl, this.topRight, this.minimapBox, this.centerEl,
      this.interactEl, this.vehicleEl, this.flightEl, this.downedEl, this.spectateEl,
      this.scoreboardEl, this.mapEl, this.scopeEl]) setHide(n, true);
  }

  // --- messages -------------------------------------------------------------

  _updateToast(view) {
    const msg = view.message || '';
    setText(this.toastEl, msg);
    setCls(this.toastEl, 'hud__toast--show', !!msg);
  }

  // --- vie / bouclier -------------------------------------------------------

  _updateVitals(view, dt) {
    setHide(this.vitalsEl, false);
    const maxH = view.maxHealth || GOAT.maxHealth;
    const maxS = view.maxShield || GOAT.maxShield;
    const h = Math.max(0, Math.min(maxH, view.health ?? 0));
    const s = Math.max(0, Math.min(maxS, view.shield ?? 0));

    // barre « fantome » rouge : suit la valeur avec un retard puis se resorbe
    const L = this._lag;
    if (h > L.health) { L.health = h; L.holdH = 0; }
    else if (h < L.health) {
      L.holdH += dt;
      if (L.holdH > 0.35) L.health = Math.max(h, damp(L.health, h, 6, dt));
    }
    if (s > L.shield) { L.shield = s; L.holdS = 0; }
    else if (s < L.shield) {
      L.holdS += dt;
      if (L.holdS > 0.35) L.shield = Math.max(s, damp(L.shield, s, 6, dt));
    }

    this._bar(this.healthBar, h, L.health, maxH, `${Math.ceil(h)} / ${maxH}`);
    this._bar(this.shieldBar, s, L.shield, maxS, s > 0 ? `${Math.ceil(s)} / ${maxS}` : '');
  }

  _bar(bar, value, lag, max, text) {
    const pct = max > 0 ? (value / max) * 100 : 0;
    const lagPct = max > 0 ? (lag / max) * 100 : 0;
    css(bar.fill, 'width', `${round1(pct)}%`);
    css(bar.lag, 'width', `${round1(Math.max(lagPct, pct))}%`);
    setText(bar.text, text);
    attr(bar.track, 'aria-valuenow', Math.round(value));
    attr(bar.track, 'aria-valuemax', Math.round(max));
  }

  // --- inventaire -----------------------------------------------------------

  _updateInventory(view) {
    setHide(this.inventoryEl, false);
    const slots = view.slots || [];
    const active = view.activeSlot ?? -1;
    const ammo = view.ammo || {};

    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = slots[i] || null;
      const ui = this.slotEls[i];
      const sig = s
        ? (s.kind === 'weapon'
          ? `w|${s.id}|${s.rarity}|${s.mag}|${s.maxMag}`
          : `i|${s.id}|${s.count}`)
        : 'x';
      if (this._slotSig[i] !== sig) {
        this._slotSig[i] = sig;
        if (!s) {
          setText(ui.icon, '');
          setText(ui.name, '—');
          setText(ui.ammo, '');
          setText(ui.count, '');
          css(ui.box, 'borderColor', 'rgba(255,255,255,.22)');
          attr(ui.box, 'aria-label', `Emplacement ${i + 1} : vide`);
        } else if (s.kind === 'weapon') {
          const col = hexColor(RARITY[s.rarity] ? RARITY[s.rarity].color : s.color);
          setText(ui.icon, s.icon || '❔');
          setText(ui.name, shortName(s.name));
          setText(ui.ammo, `${s.mag ?? 0} / ${s.maxMag ?? 0}`);
          setText(ui.count, s.ammoType && ammo ? String(ammo[s.ammoType] ?? 0) : '');
          css(ui.box, 'borderColor', col);
          const rar = RARITY[s.rarity] ? RARITY[s.rarity].name : '';
          attr(ui.box, 'aria-label', `Emplacement ${i + 1} : ${s.name}${rar ? ', ' + rar : ''}, ${s.mag ?? 0} sur ${s.maxMag ?? 0}`);
        } else {
          setText(ui.icon, s.icon || '❔');
          setText(ui.name, shortName(s.name));
          setText(ui.ammo, '');
          setText(ui.count, s.count > 1 ? `×${s.count}` : '');
          css(ui.box, 'borderColor', hexColor(s.color));
          attr(ui.box, 'aria-label', `Emplacement ${i + 1} : ${s.name}${s.count > 1 ? ', ' + s.count : ''}`);
        }
        setCls(ui.box, 'hud__slot--empty', !s);
      } else if (s && s.kind === 'weapon' && s.ammoType) {
        // le stock de munitions bouge sans que l'emplacement change
        setText(ui.count, String(ammo[s.ammoType] ?? 0));
      }
      setCls(ui.box, 'hud__slot--active', i === active);
      attr(ui.box, 'aria-pressed', i === active ? 'true' : 'false');
    }

    // gros compteur de munitions
    const cur = slots[active] || null;
    if (cur && cur.kind === 'weapon') {
      setHide(this.ammoEl, false);
      setText(this.ammoMag, String(cur.mag ?? 0));
      setHide(this.ammoSep, !cur.ammoType);
      setText(this.ammoReserve, cur.ammoType ? String(ammo[cur.ammoType] ?? 0) : '');
      setText(this.ammoType, cur.ammoType && AMMO[cur.ammoType] ? AMMO[cur.ammoType].name : 'Sans munitions');
    } else if (cur) {
      setHide(this.ammoEl, false);
      setText(this.ammoMag, `×${cur.count ?? 1}`);
      setHide(this.ammoSep, true);
      setText(this.ammoReserve, '');
      setText(this.ammoType, cur.name || '');
    } else {
      setHide(this.ammoEl, true);
    }

    // panneau des reserves (touche « inventaire »)
    const open = !!view.showInventory;
    setHide(this.reservesEl, !open);
    setCls(this.inventoryEl, 'hud__inventory--open', open);
    if (open) for (const id of AMMO_ORDER) setText(this.reserveEls[id], String(ammo[id] ?? 0));
  }

  // --- reticule / anneaux / degats -----------------------------------------

  _updateCrosshair(view, dt) {
    setHide(this.centerEl, false);
    const ch = view.crosshair || {};
    const scoped = !!ch.scoped;
    setHide(this.scopeEl, !scoped);
    setHide(this.crossEl, scoped);

    if (!scoped) {
      const target = 5 + (ch.spread || 0) * 3.2;
      this._spread = damp(this._spread, target, 14, dt);
      const gap = Math.round(this._spread * 2) / 2;
      css(this.crossLines[0], 'transform', `translateY(${-gap - 5}px)`);
      css(this.crossLines[2], 'transform', `translateY(${gap + 5}px)`);
      css(this.crossLines[1], 'transform', `translateX(${gap + 5}px) rotate(90deg)`);
      css(this.crossLines[3], 'transform', `translateX(${-gap - 5}px) rotate(90deg)`);
      css(this.crossDot, 'opacity', ch.aiming ? '1' : '.75');
    }

    // marque de touche
    setHide(this.hitEl, !ch.hit);
    setCls(this.hitEl, 'hud__hit--head', !!ch.headshot);

    // anneau de progression : coffre > objet > rechargement
    let prog = -1, kind = '', label = '';
    const chest = view.chestProgress || 0;
    const using = view.usingItem || null;
    const reload = view.reloading || 0;
    if (chest > 0 && chest < 1) {
      prog = clamp01(chest); kind = 'chest'; label = 'Ouverture du coffre…';
    } else if (using) {
      if (!this._useMax || using.t > this._useMax) this._useMax = using.t || 1;
      prog = clamp01(1 - (using.t || 0) / (this._useMax || 1));
      kind = 'item';
      const def = ITEMS[using.id];
      label = def ? `${def.name}…` : 'Utilisation…';
    } else if (reload > 0) {
      if (!this._reloadMax || reload > this._reloadMax) this._reloadMax = reload;
      prog = clamp01(1 - reload / (this._reloadMax || 1));
      kind = 'reload'; label = 'Rechargement…';
    }
    if (!using) this._useMax = 0;
    if (reload <= 0) this._reloadMax = 0;

    if (prog < 0) {
      setHide(this.ringEl, true);
      setHide(this.crossLabel, true);
    } else {
      setHide(this.ringEl, false);
      setHide(this.crossLabel, false);
      setCls(this.ringEl, 'hud__ring--reload', kind === 'reload');
      setCls(this.ringEl, 'hud__ring--item', kind === 'item');
      setCls(this.ringEl, 'hud__ring--chest', kind === 'chest');
      attr(this.ringArc, 'stroke-dashoffset', Math.round(this.ringC * (1 - prog) * 10) / 10);
      setText(this.crossLabel, label);
    }

    // vignette + indicateur directionnel
    const flash = clamp01(view.damageFlash || 0);
    css(this.flashEl, 'opacity', String(Math.round(flash * 100) / 100));
    const showDir = flash > 0.02 && typeof view.damageDir === 'number';
    setHide(this.dmgEl, !showDir);
    if (showDir) {
      const yaw = view.minimap ? view.minimap.yaw || 0 : 0;
      let rel = view.damageDir - yaw;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      css(this.dmgArc, 'transform', `rotate(${Math.round((rel * 180) / Math.PI)}deg)`);
      css(this.dmgArc, 'opacity', String(Math.round(Math.min(1, flash * 1.6) * 100) / 100));
    }
  }

  // --- compteurs haut droite -----------------------------------------------

  _updateTopRight(view) {
    setHide(this.topRight, false);
    const alive = view.aliveCount ?? 0;
    setText(this.cAlive.value, String(alive));
    setText(this.cAlive.label, alive > 1 ? 'chèvres en lice' : 'chèvre en lice');

    const teams = view.teamsAlive ?? 0;
    const showTeams = teams > 0 && teams !== alive;
    setHide(this.cTeams.box, !showTeams);
    if (showTeams) {
      setText(this.cTeams.value, String(teams));
      setText(this.cTeams.label, teams > 1 ? 'troupeaux' : 'troupeau');
    }

    setText(this.sKills, String(view.kills ?? 0));
    setText(this.sDamage, String(Math.round(view.damage ?? 0)));
    setText(this.netEl, `${Math.round(view.ping ?? 0)} ms · ${Math.round(view.fps ?? 0)} IPS`);
  }

  // --- tempete --------------------------------------------------------------

  _updateStorm(view) {
    const st = view.storm;
    if (!st) { setHide(this.stormEl, true); setHide(this.stormWarn, true); return; }
    setHide(this.stormEl, false);
    const t = fmtTime(st.timeLeft);
    setText(this.stormText, st.shrinking ? `La brume se referme — ${t}` : `La brume avance dans ${t}`);
    setCls(this.stormEl, 'hud__storm--shrinking', !!st.shrinking);

    setHide(this.stormWarn, !st.inStorm);
    if (st.inStorm) setText(this.stormWarn, `Vous êtes dans la brume ! −${st.dps} PV/s`);
  }

  // --- kill feed ------------------------------------------------------------

  _updateKillfeed(view) {
    const feed = view.killfeed || [];
    const last = feed.length ? feed[feed.length - 1] : null;
    const sig = `${feed.length}|${last ? last.at : 0}`;
    if (sig === this._kfSig) return;
    this._kfSig = sig;

    while (this.kfRows.length < feed.length) {
      const li = el('li', 'hud__kf', this.killfeedEl);
      const killer = el('span', 'hud__kf-killer', li, '');
      el('span', 'hud__kf-arrow', li, '⟶');
      const victim = el('span', 'hud__kf-victim', li, '');
      const info = el('span', 'hud__kf-info', li, '');
      this.kfRows.push({ li, killer, victim, info });
    }
    for (let i = 0; i < this.kfRows.length; i++) {
      const row = this.kfRows[i];
      const k = feed[i];
      if (!k) { setHide(row.li, true); continue; }
      setHide(row.li, false);
      setText(row.killer, k.killer || 'La brume');
      setText(row.victim, k.victim || '?');
      const wname = k.weapon ? (WEAPONS[k.weapon] ? WEAPONS[k.weapon].name : k.weapon) : null;
      const bits = [];
      if (wname) bits.push(wname);
      if (k.dist != null) bits.push(`${Math.round(k.dist)} m`);
      setText(row.info, bits.length ? `(${bits.join(', ')})` : '');
      if (k.zone) attr(row.li, 'title', k.zone); else attr(row.li, 'title', '');
      setCls(row.li, 'hud__kf--mine', !!k.mine);
      setCls(row.li, 'hud__kf--me', !!k.me);
    }
  }

  // --- invite d'interaction -------------------------------------------------

  _updateInteract(view) {
    const it = view.interact;
    if (!it) { setHide(this.interactEl, true); return; }
    setHide(this.interactEl, false);
    setText(this.interactLabel, it.label || '');

    const device = view.device || (view.touch ? 'touch' : 'keyboard');
    if (device === 'touch' || view.touch) {
      setHide(this.interactKey, true);
    } else {
      setHide(this.interactKey, false);
      const glyphs = device === 'gamepad' || device === 'pad' ? KEY_GLYPHS.gamepad : null;
      const key = it.key || 'E';
      setText(this.interactKey, glyphs && glyphs[key] ? glyphs[key] : key);
    }

    const hold = !!it.hold;
    setHide(this.interactRing, !hold);
    if (hold) {
      const p = clamp01(it.progress || 0);
      attr(this.interactArc, 'stroke-dashoffset', Math.round(this.interactC * (1 - p) * 10) / 10);
    }
    css(this.interactEl, 'borderColor', it.rarity && RARITY[it.rarity]
      ? hexColor(RARITY[it.rarity].color) : 'rgba(255,255,255,.2)');
  }

  // --- vehicule -------------------------------------------------------------

  _updateVehicle(view) {
    const v = view.vehicle;
    if (!v) { setHide(this.vehicleEl, true); return; }
    setHide(this.vehicleEl, false);
    setText(this.vehName, v.name || (VEHICLE_TYPES[v.type] ? VEHICLE_TYPES[v.type].name : 'Véhicule'));

    const def = VEHICLE_TYPES[v.type];
    const maxKmh = (def ? def.maxSpeed : 40) * 3.6;
    const kmh = Math.max(0, v.speedKmh || 0);
    const p = clamp01(kmh / maxKmh);
    setText(this.speedoValue, String(Math.round(kmh)));
    attr(this.speedoArc, 'stroke-dashoffset', Math.round(this.speedoC * (1 - p) * 10) / 10);
    attr(this.speedoNeedle, 'transform', `rotate(${Math.round(-90 + p * 180)} 60 62)`);

    css(this.vehBody, 'width', `${round1(clamp01(v.health ?? 1) * 100)}%`);
    css(this.vehFuel, 'width', `${round1(clamp01((v.fuel ?? 0) / 100) * 100)}%`);
    attr(this.vehBody.parentNode, 'aria-valuenow', Math.round(clamp01(v.health ?? 1) * 100));
    attr(this.vehFuel.parentNode, 'aria-valuenow', Math.round(v.fuel ?? 0));

    const seats = Array.isArray(v.seats) ? v.seats.length : (def ? def.seats : 1);
    setText(this.vehSeat, `Place ${(v.seat ?? 0) + 1} / ${seats}`);
    setHide(this.vehExit, !!view.touch);
  }

  // --- largage / parapente --------------------------------------------------

  _updateFlight(view) {
    const f = view.flight;
    const g = view.gliding;
    if (!f && !g) { setHide(this.flightEl, true); return; }
    setHide(this.flightEl, false);

    const alt = g ? g.altitude : (f ? f.altitude : 0);
    setText(this.flightAlt, `${Math.max(0, Math.round(alt))} m`);
    setText(this.flightSub, g ? 'au-dessus du sol' : 'altitude');

    const touchDevice = !!view.touch;
    if (f && f.inPlane) {
      setText(this.flightHint, touchDevice ? 'Touchez « Sauter »' : '[Espace] Sauter');
    } else if (g && g.parachute) {
      setText(this.flightHint, 'Parapente déployé');
    } else if (g) {
      setText(this.flightHint, touchDevice ? 'Chute libre — parapente automatique' : 'Chute libre — [Espace] Parapente');
    } else {
      setText(this.flightHint, '');
    }

    // fleche de trajectoire de l'avion, relative a la vue
    const from = f && f.from, to = f && f.to;
    if (from && to) {
      setHide(this.flightCompass, false);
      const yaw = view.minimap ? view.minimap.yaw || 0 : 0;
      const course = Math.atan2(to.x - from.x, to.z - from.z);
      let rel = course - yaw;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      attr(this.flightArrow, 'transform', `rotate(${Math.round((rel * 180) / Math.PI)})`);
    } else {
      setHide(this.flightCompass, true);
    }
  }

  // --- a terre / spectateur -------------------------------------------------

  _updateStates(view) {
    const downed = !!view.downed;
    setHide(this.downedEl, !downed);
    if (downed) {
      const left = (view.health ?? 0) / (GOAT.downedDecay || 1);
      setText(this.downedTimer, `Vous saignez — ${fmtTime(left)}`);
    }

    const spec = view.spectating;
    setHide(this.spectateEl, !spec);
    if (spec) setText(this.spectateName, `Vous suivez ${spec.name || '?'}`);
  }

  // --- tableau des scores ---------------------------------------------------

  _updateScoreboard(view) {
    const show = !!view.showScoreboard;
    setHide(this.scoreboardEl, !show);
    if (!show) return;
    const rows = view.scoreboard || [];
    let sig = String(rows.length);
    for (const r of rows) sig += `|${r.i},${r.k},${r.d},${r.a}`;
    if (sig === this._sbSig) return;
    this._sbSig = sig;

    while (this.sbRows.length < rows.length) {
      const tr = el('tr', 'hud__sb-row', this.sbBody);
      const rank = el('td', 'hud__sb-rank', tr, '');
      const nameCell = el('td', 'hud__sb-name', tr);
      const name = el('span', null, nameCell, '');
      const bot = el('span', 'hud__sb-bot', nameCell, 'IA');
      const kills = el('td', 'hud__sb-kills', tr, '');
      const dmg = el('td', 'hud__sb-damage', tr, '');
      const state = el('td', 'hud__sb-state', tr, '');
      this.sbRows.push({ tr, rank, name, bot, kills, dmg, state });
    }
    for (let i = 0; i < this.sbRows.length; i++) {
      const ui = this.sbRows[i];
      const r = rows[i];
      if (!r) { setHide(ui.tr, true); continue; }
      setHide(ui.tr, false);
      setText(ui.rank, String(i + 1));
      setText(ui.name, r.n || '?');
      setHide(ui.bot, !r.bot);
      setText(ui.kills, String(r.k ?? 0));
      setText(ui.dmg, String(Math.round(r.d ?? 0)));
      const aliveRow = r.a === 1 || r.a === true;
      setText(ui.state, aliveRow ? 'En vie' : 'Éliminé');
      setCls(ui.state, 'hud__sb-state--dead', !aliveRow);
      setCls(ui.tr, 'hud__sb-row--dead', !aliveRow);
    }
  }

  // -------------------------------------------------------------------------
  // Cartes
  // -------------------------------------------------------------------------

  /**
   * Ajuste la taille reelle d'un canvas (devicePixelRatio).
   * On ne mesure QUE si c'est necessaire (`cache.need`, pose par le ResizeObserver
   * ou par window.resize) : lire clientWidth a chaque image forcerait un reflow.
   * Renvoie true si la taille a change.
   */
  _sizeCanvas(canvas, cache) {
    if (!cache.need && cache.w) return false;
    cache.need = false;
    const cssW = canvas.clientWidth || 0;
    const cssH = canvas.clientHeight || cssW;
    if (!cssW || !cssH) { cache.w = 0; cache.h = 0; return false; }
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    cache.css = cssW;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      cache.w = w; cache.h = h;
      return true;
    }
    cache.w = w; cache.h = h;
    return false;
  }

  _stormSig(view) {
    const s = view.storm;
    if (!s) return '-';
    const mm = view.minimap || {};
    const marks = mm.marks || [], drops = mm.drops || [], chests = mm.chests || [];
    return `${s.cx}|${s.cz}|${s.radius}|${s.nextCx}|${s.nextCz}|${s.nextRadius}|` +
      `${marks.length}|${marks.length ? marks[marks.length - 1].at : 0}|${drops.length}|${chests.length}`;
  }

  _updateMinimap(view) {
    setHide(this.minimapBox, false);
    setText(this.zoneEl, view.zone || '');
    const mm = view.minimap;
    if (!mm) return;
    const c = this._mm;
    const resized = this._sizeCanvas(this.minimapCanvas, c);
    const sig = this._stormSig(view);
    const moved = Math.abs(mm.x - c.x) > 0.5 || Math.abs(mm.z - c.z) > 0.5;
    const turned = Math.abs(mm.yaw - c.yaw) > 0.01;
    if (!c.dirty && !resized && !moved && !turned && sig === c.sig) return;
    c.dirty = false; c.x = mm.x; c.z = mm.z; c.yaw = mm.yaw; c.sig = sig;
    if (!c.w || !c.h) return;

    const size = Math.min(c.w, c.h);
    const scale = size / 2 / 190; // ~190 m de rayon visible
    this._drawWorld(this.minimapCtx, {
      w: c.w, h: c.h, cx: c.w / 2, cy: c.h / 2,
      wx: mm.x, wz: mm.z, s: scale,
      cos: Math.cos(mm.yaw), sin: Math.sin(mm.yaw), rot: true,
      dpr: c.css ? c.w / c.css : 1,
    }, view, false);
  }

  _updateBigMap(view, now) {
    const show = !!view.showMap;
    setHide(this.mapEl, !show);
    if (!show) return;
    const c = this._bm;
    const resized = this._sizeCanvas(this.mapCanvas, c);
    const mm = view.minimap;
    const sig = this._stormSig(view) +
      `|${Math.round((mm.x || 0) / 3)}|${Math.round((mm.z || 0) / 3)}|${Math.round((mm.yaw || 0) / 0.05)}`;
    if (!c.dirty && !resized && sig === c.sig) return;
    c.dirty = false; c.sig = sig; c.at = now;
    if (!c.w || !c.h) return;

    const tf = this._mapTransform(c.w, c.h);
    tf.dpr = c.css ? c.w / c.css : 1;
    this._drawWorld(this.mapCtx, tf, view, true);
  }

  _mapTransform(w, h) {
    const s = Math.min(w, h) / (WORLD_HALF * 2) * 0.97;
    return { w, h, cx: w / 2, cy: h / 2, wx: 0, wz: 0, s, cos: 1, sin: 0, rot: false, dpr: 1 };
  }

  /** Coordonnees monde d'un point de la grande carte (px CSS). */
  _mapWorldAt(px, py, cssW, cssH) {
    if (!cssW || !cssH) return null;
    const s = Math.min(cssW, cssH) / (WORLD_HALF * 2) * 0.97;
    const x = (px - cssW / 2) / s;
    const z = -(py - cssH / 2) / s;
    if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return null;
    return [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
  }

  _proj(tf, x, z, out) {
    const dx = (x - tf.wx) * tf.s;
    const dy = -(z - tf.wz) * tf.s;
    out[0] = tf.cx + dx * tf.cos + dy * tf.sin;
    out[1] = tf.cy - dx * tf.sin + dy * tf.cos;
    return out;
  }

  _drawWorld(ctx, tf, view, big) {
    const p = this._scratch;
    const g = mapGeometry();
    const s = tf.s;
    const k = tf.dpr || 1; // epaisseurs en pixels ecran
    const mm = view.minimap || {};

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, tf.w, tf.h);

    // --- mer ---
    ctx.fillStyle = '#123b58';
    ctx.fillRect(0, 0, tf.w, tf.h);

    // --- terre ---
    ctx.beginPath();
    for (let i = 0; i < g.coast.length; i += 2) {
      this._proj(tf, g.coast[i], g.coast[i + 1], p);
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.fillStyle = '#3d5a35';
    ctx.fill();
    ctx.strokeStyle = 'rgba(240,225,190,.75)';
    ctx.lineWidth = 1.5 * k;
    ctx.stroke();

    // --- relief : Mont Chèvre ---
    this._proj(tf, MOUNT.x, MOUNT.z, p);
    ctx.beginPath();
    ctx.arc(p[0], p[1], MOUNT.r * 0.72 * s, 0, TAU);
    ctx.fillStyle = 'rgba(120,126,110,.55)';
    ctx.fill();

    // --- plage ---
    this._proj(tf, BEACH.x, BEACH.z, p);
    ctx.beginPath();
    ctx.arc(p[0], p[1], BEACH.r * 0.8 * s, 0, TAU);
    ctx.fillStyle = 'rgba(226,206,150,.75)';
    ctx.fill();

    // --- port Hercule ---
    const a = this._proj(tf, HARBOUR.minX, HARBOUR.minZ, [0, 0]);
    const b = this._proj(tf, HARBOUR.maxX, HARBOUR.maxZ, [0, 0]);
    const c2 = this._proj(tf, HARBOUR.minX, HARBOUR.maxZ, [0, 0]);
    const d2 = this._proj(tf, HARBOUR.maxX, HARBOUR.minZ, [0, 0]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(d2[0], d2[1]);
    ctx.closePath();
    ctx.fillStyle = '#17517a';
    ctx.fill();

    // --- circuit ---
    ctx.beginPath();
    for (let i = 0; i < g.line.length; i += 2) {
      this._proj(tf, g.line[i], g.line[i + 1], p);
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#2a2a30';
    ctx.lineWidth = Math.max(2 * k, 12 * s);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = Math.max(0.6 * k, 1.6 * s);
    ctx.stroke();

    // --- trajectoire de l'avion ---
    const fl = view.flight;
    if (fl && fl.from && fl.to) {
      const f1 = this._proj(tf, fl.from.x, fl.from.z, [0, 0]);
      const f2 = this._proj(tf, fl.to.x, fl.to.z, [0, 0]);
      ctx.save();
      ctx.setLineDash([8 * k, 6 * k]);
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 1.6 * k;
      ctx.beginPath();
      ctx.moveTo(f1[0], f1[1]); ctx.lineTo(f2[0], f2[1]);
      ctx.stroke();
      ctx.restore();
    }

    // --- tempete ---
    const st = view.storm;
    if (st) {
      const cur = this._proj(tf, st.cx, st.cz, [0, 0]);
      ctx.beginPath();
      ctx.rect(0, 0, tf.w, tf.h);
      ctx.arc(cur[0], cur[1], Math.max(0, st.radius * s), 0, TAU);
      ctx.fillStyle = 'rgba(140,60,220,.32)';
      ctx.fill('evenodd');
      ctx.beginPath();
      ctx.arc(cur[0], cur[1], Math.max(0, st.radius * s), 0, TAU);
      ctx.strokeStyle = '#b06cff';
      ctx.lineWidth = 2 * k;
      ctx.stroke();
      if (st.nextRadius > 0) {
        const nx = this._proj(tf, st.nextCx, st.nextCz, [0, 0]);
        ctx.beginPath();
        ctx.arc(nx[0], nx[1], st.nextRadius * s, 0, TAU);
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = 1.6 * k;
        ctx.stroke();
      }
    }

    // --- coffres (petits points) ---
    const chests = mm.chests || [];
    if (s > 0.2 || big) {
      for (const ch of chests) {
        if (ch.o) continue;
        this._proj(tf, ch.x, ch.z, p);
        if (p[0] < -8 || p[1] < -8 || p[0] > tf.w + 8 || p[1] > tf.h + 8) continue;
        ctx.beginPath();
        ctx.arc(p[0], p[1], 2.2 * k, 0, TAU);
        ctx.fillStyle = hexColor((CHEST_KINDS[ch.k] || CHEST_KINDS.wood).color);
        ctx.fill();
      }
    }

    // --- largages ---
    for (const dr of mm.drops || []) {
      this._proj(tf, dr.x, dr.z, p);
      ctx.beginPath();
      ctx.arc(p[0], p[1], 5 * k, 0, TAU);
      ctx.fillStyle = 'rgba(47,134,255,.9)';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.4 * k;
      ctx.stroke();
    }

    // --- coequipiers ---
    for (const t of mm.teammates || []) {
      this._proj(tf, t.x, t.z, p);
      ctx.beginPath();
      ctx.arc(p[0], p[1], 4 * k, 0, TAU);
      ctx.fillStyle = t.downed ? '#ff8a3c' : '#4cd964';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.lineWidth = 1.2 * k;
      ctx.stroke();
    }

    // --- marqueurs ---
    for (const m of mm.marks || []) {
      this._proj(tf, m.x, m.z, p);
      ctx.beginPath();
      ctx.moveTo(p[0], p[1] - 7 * k);
      ctx.lineTo(p[0] + 5 * k, p[1] + 4 * k);
      ctx.lineTo(p[0] - 5 * k, p[1] + 4 * k);
      ctx.closePath();
      ctx.fillStyle = '#5ad1ff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.lineWidth = 1.2 * k;
      ctx.stroke();
    }

    // --- etiquettes (POIS puis virages) ---
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(11 * k)}px system-ui, sans-serif`;
    ctx.lineWidth = 3 * k;
    ctx.strokeStyle = 'rgba(0,0,0,.75)';
    for (const poi of mm.pois || POIS) {
      this._proj(tf, poi.x, poi.z, p);
      if (p[0] < 0 || p[1] < 0 || p[0] > tf.w || p[1] > tf.h) continue;
      if (!big) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], Math.min(30 * k, poi.r * s), 0, TAU);
        ctx.strokeStyle = 'rgba(255,255,255,.16)';
        ctx.lineWidth = 1 * k;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,.75)';
        ctx.lineWidth = 3 * k;
      }
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.strokeText(poi.name, p[0], p[1]);
      ctx.fillText(poi.name, p[0], p[1]);
    }
    if (big) {
      ctx.font = `${Math.round(10 * k)}px system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(255,214,102,.95)';
      for (const co of g.corners) {
        this._proj(tf, co.x, co.z, p);
        ctx.strokeText(co.name, p[0], p[1]);
        ctx.fillText(co.name, p[0], p[1]);
      }
    }

    // --- le joueur ---
    this._proj(tf, mm.x, mm.z, p);
    ctx.save();
    ctx.translate(p[0], p[1]);
    if (!tf.rot) ctx.rotate(mm.yaw || 0);
    ctx.beginPath();
    ctx.moveTo(0, -8 * k);
    ctx.lineTo(6 * k, 7 * k);
    ctx.lineTo(0, 4 * k);
    ctx.lineTo(-6 * k, 7 * k);
    ctx.closePath();
    ctx.fillStyle = '#ffd166';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.85)';
    ctx.lineWidth = 1.4 * k;
    ctx.stroke();
    ctx.restore();

    // --- rose des vents (le nord tourne avec la vue) ---
    if (!big) {
      // le nord monde (+Z) se projette en (-sin yaw, -cos yaw) a l'ecran
      const R = Math.min(tf.w, tf.h) / 2 - 10 * k;
      const nx = tf.cx - Math.sin(mm.yaw || 0) * R;
      const ny = tf.cy - Math.cos(mm.yaw || 0) * R;
      ctx.font = `bold ${Math.round(11 * k)}px system-ui, sans-serif`;
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.lineWidth = 3 * k;
      ctx.fillStyle = '#ff6b6b';
      ctx.strokeText('N', nx, ny);
      ctx.fillText('N', nx, ny);
    }
  }
}

export default HUD;
