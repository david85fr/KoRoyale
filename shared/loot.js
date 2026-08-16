// Armes, soins et tables de butin — partage serveur / client.

export const RARITY = {
  common: { id: 'common', name: 'Commune', color: 0x9aa0a6, mult: 1.0, weight: 42 },
  uncommon: { id: 'uncommon', name: 'Peu commune', color: 0x4caf50, mult: 1.08, weight: 28 },
  rare: { id: 'rare', name: 'Rare', color: 0x2f86ff, mult: 1.16, weight: 18 },
  epic: { id: 'epic', name: 'Épique', color: 0xa259ff, mult: 1.24, weight: 9 },
  legendary: { id: 'legendary', name: 'Légendaire', color: 0xffa000, mult: 1.34, weight: 3 },
};
export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export const AMMO = {
  light: { id: 'light', name: 'Munitions légères', color: 0xd9c27a, box: 24 },
  medium: { id: 'medium', name: 'Munitions lourdes', color: 0xb08040, box: 18 },
  shells: { id: 'shells', name: 'Cartouches', color: 0xc0392b, box: 8 },
  rockets: { id: 'rockets', name: 'Roquettes', color: 0x4a4a4a, box: 2 },
};

/**
 * Armes. `damage` est par balle avant multiplicateur de rarete.
 * `spread` en degres (hanche / vise). `fireMode` : auto | semi | burst | bolt | charge
 */
export const WEAPONS = {
  hoof: {
    id: 'hoof', name: 'Coup de corne', kind: 'melee', slotless: true,
    damage: 34, rate: 1.3, range: 2.6, ammo: null, rarities: ['common'],
    spread: [0, 0], fireMode: 'semi', recoil: 0, reloadTime: 0, magazine: 0,
    bulletSpeed: 0, dropoff: null, icon: '🐐', desc: 'Toujours disponible. Ça pousse fort.',
  },
  pistol: {
    id: 'pistol', name: 'Bêlier 9mm', kind: 'gun', damage: 24, rate: 5.0, ammo: 'light',
    magazine: 15, reloadTime: 1.4, spread: [2.4, 0.9], fireMode: 'semi', recoil: 0.7,
    bulletSpeed: 340, range: 180, dropoff: [40, 120, 0.65], headshot: true,
    rarities: ['common', 'uncommon', 'rare'], icon: '🔫',
    desc: 'Fiable, léger, increvable.',
  },
  smg: {
    id: 'smg', name: 'Chevrotine SMG', kind: 'gun', damage: 17, rate: 12.0, ammo: 'light',
    magazine: 32, reloadTime: 2.1, spread: [4.4, 2.2], fireMode: 'auto', recoil: 0.55,
    bulletSpeed: 320, range: 140, dropoff: [28, 90, 0.55], headshot: true,
    rarities: ['common', 'uncommon', 'rare', 'epic'], icon: '💨',
    desc: 'Crache vite. Vide vite.',
  },
  ar: {
    id: 'ar', name: 'Fusil d’Assaut « Bouquetin »', kind: 'gun', damage: 31, rate: 6.5, ammo: 'medium',
    magazine: 30, reloadTime: 2.4, spread: [3.2, 0.8], fireMode: 'auto', recoil: 1.1,
    bulletSpeed: 480, range: 260, dropoff: [70, 190, 0.7], headshot: true,
    rarities: ['common', 'uncommon', 'rare', 'epic', 'legendary'], icon: '🎯',
    desc: 'Le couteau suisse des alpages.',
  },
  shotgun: {
    id: 'shotgun', name: 'Cornes de Boue', kind: 'gun', damage: 12, pellets: 9, rate: 1.1, ammo: 'shells',
    magazine: 5, reloadTime: 3.0, reloadPerShell: true, spread: [9.5, 7.0], fireMode: 'semi', recoil: 2.6,
    bulletSpeed: 240, range: 45, dropoff: [8, 32, 0.25], headshot: true,
    rarities: ['common', 'uncommon', 'rare', 'epic'], icon: '💥',
    desc: 'Discussion de couloir. Très convaincante.',
  },
  sniper: {
    id: 'sniper', name: 'Tir de Falaise', kind: 'gun', damage: 105, rate: 0.62, ammo: 'medium',
    magazine: 5, reloadTime: 3.2, spread: [8.0, 0.06], fireMode: 'bolt', recoil: 4.0,
    bulletSpeed: 900, range: 700, dropoff: [300, 640, 0.85], headshot: true, headshotMult: 2.4,
    scope: 4.5, rarities: ['rare', 'epic', 'legendary'], icon: '🔭',
    desc: 'Une chèvre patiente vaut deux chèvres pressées.',
  },
  dmr: {
    id: 'dmr', name: 'Carabine du Berger', kind: 'gun', damage: 52, rate: 2.6, ammo: 'medium',
    magazine: 10, reloadTime: 2.6, spread: [4.5, 0.35], fireMode: 'semi', recoil: 2.0,
    bulletSpeed: 640, range: 420, dropoff: [140, 340, 0.8], headshot: true,
    scope: 2.5, rarities: ['uncommon', 'rare', 'epic'], icon: '🏹',
    desc: 'Le compromis du berger : rapide et précis.',
  },
  rpg: {
    id: 'rpg', name: 'Lance-Foin', kind: 'launcher', damage: 92, rate: 0.55, ammo: 'rockets',
    magazine: 1, reloadTime: 3.4, spread: [1.4, 0.8], fireMode: 'semi', recoil: 3.4,
    projectileSpeed: 46, projectileGravity: 3.5, splashRadius: 7.5, splashDamage: 92,
    range: 500, headshot: false, structureDamage: 3.0,
    rarities: ['rare', 'epic', 'legendary'], icon: '🚀',
    desc: 'Réorganise la place du Casino en une seule botte.',
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS).filter((k) => WEAPONS[k].kind !== 'melee');

/** Objets consommables et utilitaires. */
export const ITEMS = {
  bandage: {
    id: 'bandage', name: 'Bandage', kind: 'heal', heal: 15, capHealth: 75,
    useTime: 2.0, stack: 15, icon: '🩹', color: 0xf0e6d2,
    desc: 'Soigne 15 PV, jusqu’à 75 max.',
  },
  medkit: {
    id: 'medkit', name: 'Trousse de soins', kind: 'heal', heal: 100, capHealth: 100,
    useTime: 6.0, stack: 3, icon: '⛑️', color: 0xe74c3c,
    desc: 'Rend tous les points de vie.',
  },
  grass: {
    id: 'grass', name: 'Botte d’herbe fraîche', kind: 'heal', heal: 25, capHealth: 100,
    overTime: 5, useTime: 1.2, stack: 8, icon: '🌿', color: 0x6ab04c,
    desc: 'Régénère 25 PV sur 5 s. Une chèvre reste une chèvre.',
  },
  shieldSmall: {
    id: 'shieldSmall', name: 'Petit lait de chèvre', kind: 'shield', shield: 25, capShield: 50,
    useTime: 2.0, stack: 8, icon: '🥛', color: 0x7ec8ff,
    desc: '+25 boucliers, jusqu’à 50.',
  },
  shieldBig: {
    id: 'shieldBig', name: 'Grand lait de chèvre', kind: 'shield', shield: 50, capShield: 100,
    useTime: 4.0, stack: 3, icon: '🍶', color: 0x2f86ff,
    desc: '+50 boucliers, jusqu’à 100.',
  },
  cheese: {
    id: 'cheese', name: 'Meule de fromage', kind: 'both', heal: 40, shield: 40,
    capHealth: 100, capShield: 100, useTime: 8.0, stack: 2, icon: '🧀', color: 0xffc94d,
    desc: 'Rare. Soigne et protège. Le graal.',
  },
  grenade: {
    id: 'grenade', name: 'Crotte explosive', kind: 'throwable', damage: 84, splashRadius: 6.5,
    fuse: 3.0, throwSpeed: 24, useTime: 0.5, stack: 6, icon: '💣', color: 0x5d4037,
    desc: 'Ça sent le roussi.',
  },
  fuel: {
    id: 'fuel', name: 'Jerrican', kind: 'fuel', fuel: 40, useTime: 3.0, stack: 4,
    icon: '⛽', color: 0xff7043, desc: 'Fait le plein d’un véhicule.',
  },
  repair: {
    id: 'repair', name: 'Caisse à outils', kind: 'repair', repair: 150, useTime: 4.0, stack: 3,
    icon: '🧰', color: 0x546e7a, desc: 'Répare 150 PV de carrosserie.',
  },
};

/** Table de butin des coffres. */
export const CHEST_TABLE = [
  { type: 'weapon', id: 'pistol', weight: 10 },
  { type: 'weapon', id: 'smg', weight: 12 },
  { type: 'weapon', id: 'ar', weight: 12 },
  { type: 'weapon', id: 'shotgun', weight: 10 },
  { type: 'weapon', id: 'dmr', weight: 7 },
  { type: 'weapon', id: 'sniper', weight: 4 },
  { type: 'weapon', id: 'rpg', weight: 2 },
  { type: 'item', id: 'bandage', weight: 12, count: [3, 5] },
  { type: 'item', id: 'grass', weight: 9, count: [2, 4] },
  { type: 'item', id: 'medkit', weight: 4, count: [1, 1] },
  { type: 'item', id: 'shieldSmall', weight: 10, count: [2, 3] },
  { type: 'item', id: 'shieldBig', weight: 5, count: [1, 2] },
  { type: 'item', id: 'cheese', weight: 1.5, count: [1, 1] },
  { type: 'item', id: 'grenade', weight: 7, count: [2, 3] },
  { type: 'item', id: 'repair', weight: 3, count: [1, 1] },
  { type: 'item', id: 'fuel', weight: 4, count: [1, 2] },
  { type: 'ammo', id: 'light', weight: 12, count: [24, 48] },
  { type: 'ammo', id: 'medium', weight: 11, count: [18, 36] },
  { type: 'ammo', id: 'shells', weight: 8, count: [6, 14] },
  { type: 'ammo', id: 'rockets', weight: 2, count: [1, 3] },
];

/** Butin au sol (moins genereux que les coffres). */
export const FLOOR_TABLE = [
  { type: 'weapon', id: 'pistol', weight: 14 },
  { type: 'weapon', id: 'smg', weight: 11 },
  { type: 'weapon', id: 'ar', weight: 8 },
  { type: 'weapon', id: 'shotgun', weight: 9 },
  { type: 'weapon', id: 'dmr', weight: 4 },
  { type: 'weapon', id: 'sniper', weight: 1.5 },
  { type: 'item', id: 'bandage', weight: 16, count: [2, 4] },
  { type: 'item', id: 'grass', weight: 12, count: [1, 3] },
  { type: 'item', id: 'shieldSmall', weight: 9, count: [1, 2] },
  { type: 'item', id: 'grenade', weight: 6, count: [1, 2] },
  { type: 'item', id: 'fuel', weight: 5, count: [1, 1] },
  { type: 'ammo', id: 'light', weight: 16, count: [18, 36] },
  { type: 'ammo', id: 'medium', weight: 13, count: [12, 24] },
  { type: 'ammo', id: 'shells', weight: 9, count: [4, 10] },
];

/** Bonus de rarete selon le type de coffre. */
export const CHEST_KINDS = {
  wood: { id: 'wood', name: 'Coffre', rarityBoost: 0, items: [2, 3], color: 0x8d6e63 },
  gold: { id: 'gold', name: 'Coffre doré', rarityBoost: 1.9, items: [3, 4], color: 0xffc107 },
  pit: { id: 'pit', name: 'Caisse des stands', rarityBoost: 1.2, items: [3, 4], color: 0xd6001c },
  supply: { id: 'supply', name: 'Largage', rarityBoost: 3.2, items: [4, 5], color: 0x2f86ff },
};

/** Degats effectifs d'une arme selon sa rarete. */
export function weaponDamage(weaponId, rarity = 'common') {
  const w = WEAPONS[weaponId];
  if (!w) return 0;
  return w.damage * (RARITY[rarity]?.mult ?? 1);
}

/** Cadence effective (coups/s). */
export function weaponRate(weaponId, rarity = 'common') {
  const w = WEAPONS[weaponId];
  if (!w) return 1;
  const m = RARITY[rarity]?.mult ?? 1;
  return w.rate * (1 + (m - 1) * 0.45);
}

export function weaponMagazine(weaponId, rarity = 'common') {
  const w = WEAPONS[weaponId];
  if (!w) return 0;
  const bonus = RARITY_ORDER.indexOf(rarity);
  return w.magazine + (w.magazine >= 15 ? Math.max(0, bonus) * 2 : 0);
}

export function weaponReload(weaponId, rarity = 'common') {
  const w = WEAPONS[weaponId];
  if (!w) return 1;
  const m = RARITY[rarity]?.mult ?? 1;
  return w.reloadTime / (1 + (m - 1) * 0.7);
}

/** Attenuation des degats avec la distance. */
export function damageFalloff(weaponId, distance) {
  const w = WEAPONS[weaponId];
  if (!w || !w.dropoff) return 1;
  const [near, far, minMult] = w.dropoff;
  if (distance <= near) return 1;
  if (distance >= far) return minMult;
  const t = (distance - near) / (far - near);
  return 1 + (minMult - 1) * t;
}

/** Tire une rarete, `boost` decale la table vers le haut. */
export function rollRarity(rng, allowed = RARITY_ORDER, boost = 0) {
  const pool = allowed.map((id) => ({ id, weight: RARITY[id].weight * Math.pow(1.9, boost * (RARITY_ORDER.indexOf(id) / 4)) }));
  return rng.weighted(pool).id;
}

/**
 * Tire un lot de butin.
 * Renvoie [{type:'weapon'|'item'|'ammo', id, rarity?, count}]
 */
export function rollLoot(rng, table, count, rarityBoost = 0) {
  const out = [];
  let hasWeapon = false;
  for (let i = 0; i < count; i++) {
    // Garantir au moins une arme par coffre
    const forceWeapon = i === 0 && !hasWeapon;
    const pool = forceWeapon ? table.filter((e) => e.type === 'weapon') : table;
    const entry = rng.weighted(pool);
    if (entry.type === 'weapon') {
      hasWeapon = true;
      const w = WEAPONS[entry.id];
      const rarity = rollRarity(rng, w.rarities, rarityBoost);
      out.push({ type: 'weapon', id: entry.id, rarity, ammo: w.magazine });
      // munitions assorties
      const ammoId = w.ammo;
      if (ammoId) out.push({ type: 'ammo', id: ammoId, count: AMMO[ammoId].box * rng.int(1, 2) });
    } else if (entry.type === 'ammo') {
      out.push({ type: 'ammo', id: entry.id, count: rng.int(entry.count[0], entry.count[1]) });
    } else {
      out.push({ type: 'item', id: entry.id, count: rng.int(entry.count[0], entry.count[1]) });
    }
  }
  return out;
}

/** Score d'une arme, pour que l'IA sache choisir la meilleure. */
export function weaponScore(weaponId, rarity = 'common', targetDistance = 30) {
  const w = WEAPONS[weaponId];
  if (!w) return 0;
  if (w.kind === 'melee') return 1;
  const dps = weaponDamage(weaponId, rarity) * weaponRate(weaponId, rarity) * (w.pellets || 1);
  const rangeFit = w.range >= targetDistance ? 1 : Math.max(0.15, w.range / targetDistance);
  const fall = damageFalloff(weaponId, targetDistance);
  return dps * rangeFit * fall;
}

export function itemDef(id) { return ITEMS[id] || null; }
export function weaponDef(id) { return WEAPONS[id] || null; }

export function lootLabel(entry) {
  if (entry.type === 'weapon') return WEAPONS[entry.id]?.name ?? entry.id;
  if (entry.type === 'item') return ITEMS[entry.id]?.name ?? entry.id;
  if (entry.type === 'ammo') return AMMO[entry.id]?.name ?? entry.id;
  return entry.id;
}

export function lootIcon(entry) {
  if (entry.type === 'weapon') return WEAPONS[entry.id]?.icon ?? '❔';
  if (entry.type === 'item') return ITEMS[entry.id]?.icon ?? '❔';
  if (entry.type === 'ammo') return '📦';
  return '❔';
}

export function lootColor(entry) {
  if (entry.type === 'weapon') return RARITY[entry.rarity]?.color ?? 0x9aa0a6;
  if (entry.type === 'item') return ITEMS[entry.id]?.color ?? 0xffffff;
  if (entry.type === 'ammo') return AMMO[entry.id]?.color ?? 0xcccccc;
  return 0xffffff;
}
