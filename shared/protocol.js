// Protocole reseau KoRoyale (JSON sur WebSocket).
// Les cles sont volontairement courtes dans les snapshots : ils partent 20x/s.

export const C2S = {
  HELLO: 'hi',
  CREATE_ROOM: 'cr',
  JOIN_ROOM: 'jr',
  QUICK_PLAY: 'qp',
  LEAVE_ROOM: 'lr',
  READY: 'rd',
  SETTINGS: 'st',
  KICK: 'kk',
  ADD_BOT: 'ab',
  REMOVE_BOT: 'rb',
  CHAT: 'ch',
  START: 'go',
  PROFILE: 'pf',
  INPUT: 'in',
  ACTION: 'ac',
  PING: 'pi',
  RESPAWN_SPECTATE: 'sp',
};

export const S2C = {
  WELCOME: 'we',
  ERROR: 'er',
  ROOM: 'rm',
  ROOM_LIST: 'rl',
  CHAT: 'ch',
  COUNTDOWN: 'cd',
  MATCH_START: 'ms',
  SNAPSHOT: 'sn',
  EVENTS: 'ev',
  MATCH_END: 'me',
  PONG: 'po',
  KICKED: 'kd',
};

/** Types d'action ponctuelle (le reste passe par les bits d'entree). */
export const ACT = {
  USE: 'use',            // ouvrir un coffre / ramasser
  DROP: 'drop',          // jeter l'objet du slot courant
  SLOT: 'slot',          // changer d'emplacement { slot }
  USE_ITEM: 'item',      // consommer { id }
  ENTER_VEHICLE: 'ev',
  EXIT_VEHICLE: 'xv',
  SEAT: 'seat',          // changer de siege { seat }
  THROW: 'throw',        // lancer une grenade { yaw, pitch, charge }
  MARK: 'mark',          // marqueur sur la carte { x, z }
  JUMP_OUT: 'jump',      // quitter le planeur
  DEPLOY: 'deploy',      // ouvrir le parapente
  EMOTE: 'emote',        // { id }
  REVIVE: 'revive',      // { target }
  SPECTATE_NEXT: 'specn',
};

export const ERR = {
  ROOM_NOT_FOUND: 'room_not_found',
  ROOM_FULL: 'room_full',
  ROOM_IN_GAME: 'room_in_game',
  NOT_HOST: 'not_host',
  BAD_NAME: 'bad_name',
  RATE_LIMIT: 'rate_limit',
  VERSION: 'version_mismatch',
  SERVER_FULL: 'server_full',
};

export const ERR_TEXT = {
  [ERR.ROOM_NOT_FOUND]: 'Ce salon n’existe pas (ou plus).',
  [ERR.ROOM_FULL]: 'Le salon est plein.',
  [ERR.ROOM_IN_GAME]: 'La partie a déjà commencé dans ce salon.',
  [ERR.NOT_HOST]: 'Seul l’hôte peut faire ça.',
  [ERR.BAD_NAME]: 'Ce nom de chèvre ne passe pas.',
  [ERR.RATE_LIMIT]: 'Doucement, la chèvre !',
  [ERR.VERSION]: 'Version du jeu obsolète : rechargez la page.',
  [ERR.SERVER_FULL]: 'Le serveur est plein, réessayez dans un instant.',
};

/** Etats d'un salon. */
export const ROOM_STATE = { LOBBY: 'lobby', COUNTDOWN: 'countdown', PLAYING: 'playing', ENDED: 'ended' };

/** Types d'evenements pousses aux clients (kill-feed, sons, particules). */
export const EV = {
  HIT: 'hit',            // {t:cible, d:degats, hs:headshot, by}
  KILL: 'kill',          // {v:victime, k:tueur, w:arme, hs, dist, zone}
  DOWN: 'down',
  REVIVED: 'rev',
  SHOT: 'shot',          // {p:joueur, w, x,y,z, dx,dy,dz}
  EXPLOSION: 'boom',     // {x,y,z,r}
  CHEST: 'chest',        // {id, by}
  PICKUP: 'pick',        // {p, label}
  VEHICLE_ENTER: 'vin',
  VEHICLE_EXIT: 'vout',
  VEHICLE_DESTROYED: 'vdead',
  STORM_PHASE: 'storm',
  SUPPLY_DROP: 'drop',
  LAND: 'land',
  EMOTE: 'emote',
  HORN: 'horn',
  MARK: 'mark',
};

// Caracteres de controle + espaces invisibles + marques de direction.
const CTRL = new RegExp("[\\u0000-\\u001F\\u007F\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\uFEFF]", "g");

/** Nettoyage d'un pseudo. */
export function sanitizeName(raw, fallback = 'Chèvre') {
  if (typeof raw !== 'string') return fallback;
  const s = raw.replace(CTRL, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s.length >= 2 ? s : fallback;
}

export function sanitizeChat(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(CTRL, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Encodage compact d'un joueur pour les snapshots. */
export function packPlayer(p, full = false) {
  const o = {
    i: p.id,
    x: r2(p.x), y: r2(p.y), z: r2(p.z),
    a: r3(p.yaw), b: r3(p.pitch),
    s: p.anim,
    f: p.flags,
  };
  if (p.vehicleId) { o.v = p.vehicleId; o.vs = p.seat; }
  if (full) {
    o.n = p.name; o.k = p.skin; o.tm = p.team; o.bot = p.isBot ? 1 : 0;
  }
  if (p.weaponId) o.w = p.weaponId;
  if (p.rarity) o.wr = p.rarity;
  return o;
}

export const FLAG = {
  SPRINT: 1 << 0,
  CROUCH: 1 << 1,
  AIM: 1 << 2,
  DOWNED: 1 << 3,
  DEAD: 1 << 4,
  GLIDING: 1 << 5,
  PARACHUTE: 1 << 6,
  IN_STORM: 1 << 7,
  RELOADING: 1 << 8,
  SWIMMING: 1 << 9,
  CLIMBING: 1 << 10,
  SHIELDED: 1 << 11,
  USING_ITEM: 1 << 12,
  DRIVING: 1 << 13,
};
