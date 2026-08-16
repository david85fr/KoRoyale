// KoRoyale — constantes partagees serveur / client.
// Ce fichier est importe tel quel par Node ET par le navigateur : pas de dependance externe.

export const PROTOCOL_VERSION = 7;

// ---------------------------------------------------------------------------
// Boucle de simulation
// ---------------------------------------------------------------------------
export const TICK_RATE = 20; // ticks de simulation par seconde (serveur, autoritaire)
export const TICK_DT = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 20; // envois d'etat par seconde
export const CLIENT_INPUT_RATE = 40; // envois d'input par seconde
export const INTERP_DELAY = 0.1; // retard d'interpolation cote client (s)
export const AOI_RADIUS = 220; // rayon d'interet : au-dela on n'envoie pas l'entite

// ---------------------------------------------------------------------------
// Monde
// ---------------------------------------------------------------------------
export const WORLD_SIZE = 1800; // le monde va de -900 a +900 sur X et Z
export const WORLD_HALF = WORLD_SIZE / 2;
export const SEA_LEVEL = 0;
export const GRAVITY = 26;

// ---------------------------------------------------------------------------
// La chevre (le joueur)
// ---------------------------------------------------------------------------
export const GOAT = {
  radius: 0.55,
  height: 1.55, // hauteur de la capsule (garrot)
  eyeHeight: 1.35,
  walkSpeed: 6.2,
  sprintSpeed: 9.6,
  crouchSpeed: 3.0,
  airControl: 0.32,
  accel: 60,
  friction: 11,
  jumpSpeed: 9.4,
  doubleJumpSpeed: 8.4, // les chevres sautent deux fois
  maxSlope: 0.82, // cos de l'angle max : les chevres grimpent tres raide (~35 deg de pente residuelle)
  climbSpeed: 3.4, // vitesse d'escalade sur paroi (capacite chevre)
  maxHealth: 100,
  maxShield: 100,
  headbuttDamage: 34,
  headbuttRange: 2.6,
  headbuttCooldown: 0.75,
  headbuttKnockback: 11,
  reviveTime: 8, // temps pour relever un coequipier a terre (mode duo/squad)
  downedHealth: 100,
  downedDecay: 3.2, // pv perdus par seconde a terre
};

// Etats de joueur
export const PSTATE = { ALIVE: 0, DOWNED: 1, DEAD: 2, SPECTATING: 3 };

// ---------------------------------------------------------------------------
// Tempete (la « Brume du Rocher »)
// ---------------------------------------------------------------------------
export const STORM_PHASES = [
  // waitTime : temps avant que le cercle bouge ; shrinkTime : duree du retrecissement
  { radius: 820, waitTime: 45, shrinkTime: 60, dps: 1 },
  { radius: 560, waitTime: 40, shrinkTime: 55, dps: 2 },
  { radius: 370, waitTime: 35, shrinkTime: 50, dps: 4 },
  { radius: 230, waitTime: 30, shrinkTime: 45, dps: 7 },
  { radius: 130, waitTime: 25, shrinkTime: 40, dps: 10 },
  { radius: 65, waitTime: 20, shrinkTime: 35, dps: 14 },
  { radius: 25, waitTime: 15, shrinkTime: 30, dps: 20 },
  { radius: 0, waitTime: 10, shrinkTime: 40, dps: 25 },
];

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------
export const MATCH = {
  minPlayers: 2, // en dessous on complete avec des bots
  defaultLobbySize: 20,
  maxLobbySize: 40,
  countdownSeconds: 5,
  dropAltitude: 260, // altitude du « planeur » (parapente de chevre)
  glideFallSpeed: 22,
  glideForwardSpeed: 34,
  parachuteAltitude: 55, // ouverture auto du parapente
  parachuteFallSpeed: 9,
  parachuteForwardSpeed: 16,
  endDelay: 12, // secondes d'ecran de fin avant retour au salon
};

// ---------------------------------------------------------------------------
// Vehicules
// ---------------------------------------------------------------------------
export const VEHICLE_TYPES = {
  f1: {
    id: 'f1',
    name: 'Monoplace GP',
    seats: 2, // pilote + une chevre accrochee a l'aileron
    mass: 800,
    maxSpeed: 62,
    reverseSpeed: 9,
    engineForce: 16,
    latAccel: 30, // acceleration laterale max (m/s2) : limite de virage
    wheelbase: 3.45,
    brakeForce: 60,
    steerAngle: 0.55,
    steerSpeedFalloff: 0.72, // moins de braquage a haute vitesse
    grip: 12.5,
    driftGrip: 5.5,
    drag: 0.0005,
    rollingResistance: 0.8,
    halfExtents: [1.0, 0.55, 2.6],
    seatOffsets: [
      [0, 0.75, -0.15],
      [0, 0.95, -2.1],
    ],
    health: 260,
    rammingDamage: 1.5, // multiplicateur de degats de collision
    maxSlope: 0.55,
    wheel: { radius: 0.36, front: 1.75, rear: -1.7, track: 0.95 },
    color: 0xd6001c,
    honk: 'f1',
  },
  buggy: {
    id: 'buggy',
    name: 'Buggy des Alpages',
    seats: 4,
    mass: 1200,
    maxSpeed: 34,
    reverseSpeed: 11,
    engineForce: 10,
    latAccel: 13, // acceleration laterale max (m/s2) : limite de virage
    wheelbase: 2.95,
    brakeForce: 38,
    steerAngle: 0.7,
    steerSpeedFalloff: 0.5,
    grip: 9.5,
    driftGrip: 4.2,
    drag: 0.0012,
    rollingResistance: 1.2,
    halfExtents: [1.15, 0.85, 2.2],
    seatOffsets: [
      [-0.55, 1.0, 0.35],
      [0.55, 1.0, 0.35],
      [-0.55, 1.0, -0.85],
      [0.55, 1.0, -0.85],
    ],
    health: 420,
    rammingDamage: 1.0,
    maxSlope: 0.72, // 4x4 : grimpe bien
    wheel: { radius: 0.5, front: 1.5, rear: -1.45, track: 1.15 },
    color: 0x3d7a3a,
    honk: 'buggy',
  },
  scooter: {
    id: 'scooter',
    name: 'Scooter du Port',
    seats: 2,
    mass: 190,
    maxSpeed: 26,
    reverseSpeed: 6,
    engineForce: 9,
    latAccel: 11, // acceleration laterale max (m/s2) : limite de virage
    wheelbase: 1.44,
    brakeForce: 30,
    steerAngle: 0.95,
    steerSpeedFalloff: 0.62,
    grip: 8.0,
    driftGrip: 3.4,
    drag: 0.0018,
    rollingResistance: 1,
    halfExtents: [0.4, 0.6, 1.0],
    seatOffsets: [
      [0, 0.85, -0.05],
      [0, 0.85, -0.7],
    ],
    health: 140,
    rammingDamage: 0.6,
    maxSlope: 0.6,
    wheel: { radius: 0.32, front: 0.72, rear: -0.72, track: 0.0 },
    color: 0xf2f2f2,
    honk: 'scooter',
  },
  boat: {
    id: 'boat',
    name: 'Vedette du Port',
    seats: 4,
    mass: 900,
    maxSpeed: 30,
    reverseSpeed: 8,
    engineForce: 8,
    latAccel: 6, // acceleration laterale max (m/s2) : limite de virage
    wheelbase: 4,
    brakeForce: 14,
    steerAngle: 0.8,
    steerSpeedFalloff: 0.45,
    grip: 3.2,
    driftGrip: 2.4,
    drag: 0.0022,
    rollingResistance: 1.6,
    halfExtents: [1.3, 0.7, 3.0],
    seatOffsets: [
      [0, 1.0, -0.4],
      [0, 1.0, -1.5],
      [-0.6, 1.0, 0.6],
      [0.6, 1.0, 0.6],
    ],
    health: 300,
    rammingDamage: 0.8,
    maxSlope: 1.0,
    aquatic: true,
    wheel: null,
    color: 0xffffff,
    honk: 'boat',
  },
};

export const VEHICLE_DAMAGE = {
  minSpeed: 9, // en dessous, une collision ne blesse pas
  perSpeed: 3.4, // degats par (m/s au dessus du seuil)
  selfPerSpeed: 1.6,
  maxPerHit: 120,
  fallDamageSpeed: 14,
};

// ---------------------------------------------------------------------------
// Coffres et butin
// ---------------------------------------------------------------------------
export const CHEST = {
  openTime: 0.9, // maintien de la touche
  openRange: 2.6,
  itemsMin: 2,
  itemsMax: 4,
  respawnTime: 0, // 0 = pas de respawn
};

export const PICKUP_RANGE = 2.2;
export const INVENTORY_SLOTS = 5; // 5 emplacements d'armes/objets
export const MAX_STACK = { light: 240, medium: 180, shells: 60, rockets: 12, fuel: 6 };

// ---------------------------------------------------------------------------
// Degats / combat
// ---------------------------------------------------------------------------
export const HEADSHOT_MULT = 2.0;
export const LIMB_MULT = 0.85;
export const FALL_DAMAGE = { safeSpeed: 17, perSpeed: 5.5 };
export const SHIELD_ABSORB = 1.0; // le bouclier encaisse avant les pv

// ---------------------------------------------------------------------------
// Salon / rooms
// ---------------------------------------------------------------------------
export const ROOM = {
  codeLength: 5,
  codeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // sans I,O,0,1 (ambigus)
  maxChatLength: 200,
  chatHistory: 60,
  idleTimeoutMs: 15 * 60 * 1000,
  maxRooms: 500,
};

export const TEAM_MODES = {
  solo: { id: 'solo', name: 'Solo', size: 1 },
  duo: { id: 'duo', name: 'Duo', size: 2 },
  squad: { id: 'squad', name: 'Troupeau', size: 4 },
};

// ---------------------------------------------------------------------------
// Bots (chevres IA)
// ---------------------------------------------------------------------------
export const BOT = {
  reactionTime: [0.16, 0.55], // min/max selon difficulte
  aimError: [0.9, 6.0], // degres d'erreur
  viewRange: 120,
  hearRange: 45,
  lootRadius: 70,
  fireRateMult: [1.0, 0.55],
  accuracyRamp: 1.4,
  difficulties: ['chevreau', 'biquette', 'bouc', 'bouquetin'],
};

export const GOAT_NAMES = [
  'Biquette', 'Cabri', 'Chevrotine', 'Bouc-Émissaire', 'Roquefort', 'Barbichette',
  'Cornebidouille', 'Picodon', 'Bêêêatrice', 'Chabichou', 'Sabot-de-Fer', 'Crottin',
  'Gruyère', 'Blanquette', 'Alpage', 'Estive', 'Pelagie', 'Mistigri', 'Rocamadour',
  'Broutille', 'Cornu', 'Toundra', 'Nubienne', 'Angora', 'Cachemire', 'Poivrot',
  'Bêlissime', 'Capra', 'Chèvrefeuille', 'Boucanier', 'Cabriole', 'Pyrénée',
  'Tomme', 'Feta', 'Sainte-Maure', 'Valençay', 'Banon', 'Pélardon', 'Selles',
  'Grimpette', 'Falaise', 'Éboulis', 'Névé', 'Piolet', 'Crampon', 'Sherpa',
];

export const GOAT_SKINS = [
  { id: 'alpine', name: 'Alpine', body: 0xc9b8a4, belly: 0xe8dfd2, horn: 0x6b5b4a },
  { id: 'nubienne', name: 'Nubienne', body: 0x6b4a35, belly: 0x8f6a4d, horn: 0x3a2c22 },
  { id: 'saanen', name: 'Saanen', body: 0xf2eee4, belly: 0xffffff, horn: 0xb8ab96 },
  { id: 'toggenburg', name: 'Toggenburg', body: 0x8b7355, belly: 0xd8ccb8, horn: 0x4a3c2e },
  { id: 'noire', name: 'Noire du Rove', body: 0x2f2b28, belly: 0x4a4440, horn: 0x1a1715 },
  { id: 'rousse', name: 'Rousse', body: 0xb35a2a, belly: 0xd9905c, horn: 0x5c3a20 },
  { id: 'pie', name: 'Pie', body: 0xdedede, belly: 0x333333, horn: 0x777777 },
  { id: 'grise', name: 'Grise des Cimes', body: 0x8e9299, belly: 0xc3c7cc, horn: 0x565b61 },
  { id: 'monaco', name: 'Monégasque', body: 0xd6001c, belly: 0xffffff, horn: 0x8a0012 },
  { id: 'or', name: 'Chèvre d’Or', body: 0xd4af37, belly: 0xf5e0a3, horn: 0x8a6d1f },
];

// ---------------------------------------------------------------------------
// Bits d'entree (uint16) — voir shared/protocol.js
// ---------------------------------------------------------------------------
export const BTN = {
  JUMP: 1 << 0,
  SPRINT: 1 << 1,
  CROUCH: 1 << 2,
  FIRE: 1 << 3,
  AIM: 1 << 4,
  RELOAD: 1 << 5,
  USE: 1 << 6, // interagir : coffre, butin, vehicule
  MELEE: 1 << 7, // coup de corne
  HORN: 1 << 8, // klaxon / belement
  DROP: 1 << 9,
  HANDBRAKE: 1 << 10,
  PING: 1 << 11, // marqueur sur la carte
};

export const ANIM = {
  IDLE: 0, WALK: 1, RUN: 2, JUMP: 3, FALL: 4, GLIDE: 5,
  HEADBUTT: 6, DOWNED: 7, DRIVE: 8, CLIMB: 9, SWIM: 10,
};

export const SURFACE = { GRASS: 0, ASPHALT: 1, STONE: 2, WOOD: 3, WATER: 4, SAND: 5, ROCK: 6, METAL: 7 };
