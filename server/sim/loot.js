// Coffres, butin au sol et largages de ravitaillement.

import { CHEST, PICKUP_RANGE, SEA_LEVEL } from '../../shared/constants.js';
import {
  CHEST_KINDS, CHEST_TABLE, FLOOR_TABLE, rollLoot, lootLabel, WEAPONS,
} from '../../shared/loot.js';
import { EV } from '../../shared/protocol.js';

let _lid = 0;

export class LootManager {
  constructor(match, rng) {
    this.match = match;
    this.rng = rng;
    this.chests = new Map();
    this.loot = new Map();
    this.drops = new Map();
    this.nextDropAt = 90 + rng.float(0, 40);
  }

  spawnInitial() {
    const map = this.match.world.map;
    for (const c of map.chests) {
      this.chests.set(c.id, {
        id: c.id, x: c.x, y: c.y, z: c.z, yaw: c.yaw, kind: c.kind, opened: false,
      });
    }
    // butin au sol : on n'en materialise qu'une partie pour respirer
    const spots = this.rng.shuffle(map.lootSpawns.slice());
    const count = Math.min(spots.length, Math.round(spots.length * 0.78));
    for (let i = 0; i < count; i++) {
      const s = spots[i];
      const [entry] = rollLoot(this.rng, FLOOR_TABLE, 1, 0);
      this.spawn(s.x, s.y + 0.3, s.z, entry, { permanent: true });
    }
  }

  spawn(x, y, z, entry, opts = {}) {
    const id = `l${++_lid}`;
    const item = {
      id, x, y, z,
      type: entry.type,
      itemId: entry.id,
      rarity: entry.rarity || null,
      count: entry.count ?? 1,
      ammo: entry.ammo ?? null,
      ttl: opts.permanent ? Infinity : 180,
      vy: opts.vy ?? 0,
      settled: !!opts.permanent,
    };
    this.loot.set(id, item);
    return item;
  }

  /** Ejecte un lot de butin autour d'un point (mort d'un joueur, coffre ouvert). */
  scatter(x, y, z, entries, radius = 1.6) {
    const out = [];
    const n = entries.length || 1;
    for (let i = 0; i < entries.length; i++) {
      const a = (i / n) * Math.PI * 2 + this.rng.float(-0.3, 0.3);
      const r = radius * this.rng.float(0.4, 1.1);
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      const gy = Math.max(this.match.world.terrain(px, pz), SEA_LEVEL + 0.1);
      out.push(this.spawn(px, gy + 0.35, pz, entries[i], { permanent: true }));
    }
    return out;
  }

  openChest(chest, player) {
    if (chest.opened) return false;
    chest.opened = true;
    const kind = CHEST_KINDS[chest.kind] || CHEST_KINDS.wood;
    const n = this.rng.int(kind.items[0], kind.items[1]);
    const entries = rollLoot(this.rng, CHEST_TABLE, n, kind.rarityBoost);
    this.scatter(chest.x, chest.y, chest.z, entries, 1.9);
    this.match.pushEvent({ e: EV.CHEST, id: chest.id, by: player ? player.id : null, k: chest.kind });
    return true;
  }

  /** Objet ramassable le plus proche du joueur (pour l'invite « Appuyez sur E »). */
  nearestPickup(player) {
    let best = null, bestD = PICKUP_RANGE * PICKUP_RANGE;
    for (const l of this.loot.values()) {
      const dx = l.x - player.x, dy = l.y - player.y, dz = l.z - player.z;
      if (Math.abs(dy) > 2.2) continue;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = l; }
    }
    return best;
  }

  nearestChest(player) {
    let best = null, bestD = CHEST.openRange * CHEST.openRange;
    for (const c of this.chests.values()) {
      if (c.opened) continue;
      const dx = c.x - player.x, dy = c.y - player.y, dz = c.z - player.z;
      if (Math.abs(dy) > 2.5) continue;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /** Tente de ramasser l'objet le plus proche. */
  tryPickup(player) {
    const l = this.nearestPickup(player);
    if (!l) return null;
    const entry = {
      type: l.type, id: l.itemId, rarity: l.rarity,
      count: l.count, ammo: l.ammo,
    };
    const res = player.addLoot(entry);
    if (!res.ok) return { ok: false, label: res.label };
    this.loot.delete(l.id);
    if (res.dropped) {
      const gy = Math.max(this.match.world.terrain(player.x, player.z), SEA_LEVEL + 0.1);
      this.spawn(player.x + 0.7, gy + 0.35, player.z, res.dropped, { permanent: true });
    }
    this.match.pushEvent({ e: EV.PICKUP, p: player.id, l: res.label });
    return { ok: true, label: res.label };
  }

  /** Ramassage automatique des munitions et du premier equipement quand on marche dessus. */
  autoPickup(player) {
    for (const l of this.loot.values()) {
      const dx = l.x - player.x, dz = l.z - player.z;
      if (dx * dx + dz * dz > 1.5 * 1.5) continue;
      if (Math.abs(l.y - player.y) > 2.0) continue;
      const isAmmo = l.type === 'ammo';
      const firstWeapon = l.type === 'weapon' && player.firstEmptySlot() >= 0 && !player.weapon;
      if (!isAmmo && !firstWeapon) continue;
      const res = player.addLoot({ type: l.type, id: l.itemId, rarity: l.rarity, count: l.count, ammo: l.ammo });
      if (res.ok) {
        this.loot.delete(l.id);
        this.match.pushEvent({ e: EV.PICKUP, p: player.id, l: res.label });
      }
    }
  }

  update(dt) {
    const terrain = this.match.world.terrain;
    for (const l of this.loot.values()) {
      if (!l.settled) {
        l.vy -= 22 * dt;
        l.y += l.vy * dt;
        const g = Math.max(terrain(l.x, l.z), SEA_LEVEL + 0.1) + 0.35;
        if (l.y <= g) { l.y = g; l.vy = 0; l.settled = true; }
      }
      if (l.ttl !== Infinity) {
        l.ttl -= dt;
        if (l.ttl <= 0) this.loot.delete(l.id);
      }
    }

    // largages
    for (const d of this.drops.values()) {
      if (d.falling) {
        d.y -= 7 * dt;
        const g = Math.max(terrain(d.x, d.z), SEA_LEVEL + 0.1);
        if (d.y <= g + 0.5) { d.y = g + 0.5; d.falling = false; }
      }
    }

    this.nextDropAt -= dt;
    if (this.nextDropAt <= 0) {
      this.spawnSupplyDrop();
      this.nextDropAt = 110 + this.rng.float(0, 50);
    }
  }

  spawnSupplyDrop() {
    const storm = this.match.storm;
    const [ox, oz] = this.rng.inDisk(Math.max(30, storm.radius * 0.7));
    const x = storm.cx + ox, z = storm.cz + oz;
    if (Math.abs(x) > 880 || Math.abs(z) > 880) return;
    const id = `d${++_lid}`;
    const drop = { id, x, y: 220, z, falling: true, opened: false };
    this.drops.set(id, drop);
    // le contenu est un coffre « supply » pose au meme endroit
    const chestId = `sc${id}`;
    this.chests.set(chestId, {
      id: chestId, x, y: Math.max(this.match.world.terrain(x, z), SEA_LEVEL + 0.1),
      z, yaw: 0, kind: 'supply', opened: false, dropId: id,
    });
    this.match.pushEvent({ e: EV.SUPPLY_DROP, x: Math.round(x), z: Math.round(z) });
  }

  /** Entites visibles depuis un point (filtrage par zone d'interet). */
  visible(x, z, radius) {
    const r2 = radius * radius;
    const chests = [];
    for (const c of this.chests.values()) {
      const dx = c.x - x, dz = c.z - z;
      if (dx * dx + dz * dz <= r2) chests.push({ i: c.id, x: r2f(c.x), y: r2f(c.y), z: r2f(c.z), a: r2f(c.yaw), k: c.kind, o: c.opened ? 1 : 0 });
    }
    const loot = [];
    for (const l of this.loot.values()) {
      const dx = l.x - x, dz = l.z - z;
      if (dx * dx + dz * dz <= r2) {
        loot.push({ i: l.id, x: r2f(l.x), y: r2f(l.y), z: r2f(l.z), t: l.type, d: l.itemId, r: l.rarity, c: l.count });
      }
    }
    const drops = [];
    for (const d of this.drops.values()) {
      drops.push({ i: d.id, x: r2f(d.x), y: r2f(d.y), z: r2f(d.z), f: d.falling ? 1 : 0 });
    }
    return { chests, loot, drops };
  }
}

const r2f = (v) => Math.round(v * 20) / 20;

export { lootLabel, WEAPONS };
