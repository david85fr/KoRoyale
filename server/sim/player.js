// Etat d'une chevre : physique, inventaire, sante, armes.
// Aucune logique reseau ici — le match orchestre, le joueur ne fait que se tenir a jour.

import {
  GOAT, PSTATE, INVENTORY_SLOTS, MAX_STACK, ANIM, BTN, MATCH, SEA_LEVEL,
} from '../../shared/constants.js';
import { FLAG } from '../../shared/protocol.js';
import { clamp } from '../../shared/math.js';
import {
  WEAPONS, ITEMS, AMMO, weaponMagazine, weaponRate, weaponReload,
} from '../../shared/loot.js';

let _seq = 0;

export class Player {
  constructor(opts) {
    this.id = opts.id || `p${++_seq}`;
    this.name = opts.name || 'Chèvre';
    this.skin = opts.skin || 'alpine';
    this.team = opts.team ?? 0;
    this.isBot = !!opts.isBot;
    this.conn = opts.conn || null;

    // --- physique ---
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = 0; this.pitch = 0;
    this.onGround = false;
    this.jumps = 0;
    this.coyote = 0;
    this.jumpHeld = false;
    this.climbing = false;
    this.swimming = false;
    this.crouching = false;
    this.sprinting = false;
    this.speed = 0;
    this.anim = ANIM.IDLE;
    this.surface = 0;
    this.landSpeed = 0;

    // --- largage ---
    this.gliding = true;
    this.parachute = false;
    this.landed = false;

    // --- vie ---
    this.state = PSTATE.ALIVE;
    this.health = GOAT.maxHealth;
    this.shield = 0;
    this.downedTimer = 0;
    this.lastHitBy = null;
    this.lastHitAt = 0;
    this.deathTime = 0;
    this.placement = 0;
    this.kills = 0;
    this.damageDealt = 0;
    this.reviverId = null;
    this.reviveProgress = 0;

    // --- inventaire ---
    this.slots = new Array(INVENTORY_SLOTS).fill(null);
    this.activeSlot = 0;
    this.ammo = { light: 0, medium: 0, shells: 0, rockets: 0 };
    this.reloading = false;
    this.reloadEnd = 0;
    this.nextFire = 0;
    this.usingItem = null;
    this.useEnd = 0;
    this.healOverTime = 0;
    this.healTicks = 0;
    this.meleeCooldown = 0;
    this.grenadeCharge = 0;

    // --- vehicule ---
    this.vehicleId = null;
    this.seat = -1;

    // --- entrees ---
    this.cmd = { moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0 };
    this.lastSeq = 0;
    this.lastInputAt = 0;
    this.ping = 0;

    // --- divers ---
    this.history = []; // pour la compensation de latence
    this.markCooldown = 0;
    this.chestProgress = 0;
    this.chestTarget = null;
    this.spectateTarget = null;
    this.aliveTime = 0;
  }

  get alive() { return this.state === PSTATE.ALIVE || this.state === PSTATE.DOWNED; }
  get eyeY() { return this.y + (this.crouching ? GOAT.eyeHeight * 0.6 : GOAT.eyeHeight); }

  get weapon() {
    const s = this.slots[this.activeSlot];
    return s && s.kind === 'weapon' ? s : null;
  }

  get weaponDef() {
    const w = this.weapon;
    return w ? WEAPONS[w.id] : null;
  }

  // -------------------------------------------------------------------------
  // Inventaire
  // -------------------------------------------------------------------------

  firstEmptySlot() {
    return this.slots.findIndex((s) => s === null);
  }

  /**
   * Ajoute un lot de butin.
   * @returns {{ok:boolean, label:string, dropped:object|null}}
   */
  addLoot(entry) {
    if (entry.type === 'ammo') {
      const cap = MAX_STACK[entry.id] ?? 999;
      const before = this.ammo[entry.id] ?? 0;
      this.ammo[entry.id] = Math.min(cap, before + entry.count);
      const got = this.ammo[entry.id] - before;
      return { ok: got > 0, label: `${got} ${AMMO[entry.id]?.name ?? entry.id}`, dropped: null };
    }

    if (entry.type === 'item') {
      const def = ITEMS[entry.id];
      if (!def) return { ok: false, label: '', dropped: null };
      let remaining = entry.count ?? 1;
      // empiler sur les emplacements existants
      for (let i = 0; i < this.slots.length && remaining > 0; i++) {
        const s = this.slots[i];
        if (s && s.kind === 'item' && s.id === entry.id && s.count < def.stack) {
          const add = Math.min(def.stack - s.count, remaining);
          s.count += add;
          remaining -= add;
        }
      }
      while (remaining > 0) {
        const empty = this.firstEmptySlot();
        if (empty < 0) break;
        const add = Math.min(def.stack, remaining);
        this.slots[empty] = { kind: 'item', id: entry.id, count: add };
        remaining -= add;
      }
      const got = (entry.count ?? 1) - remaining;
      if (got <= 0) return { ok: false, label: 'Inventaire plein', dropped: null };
      return { ok: true, label: `${def.name}${got > 1 ? ` x${got}` : ''}`, dropped: remaining > 0 ? { ...entry, count: remaining } : null };
    }

    // arme
    const def = WEAPONS[entry.id];
    if (!def) return { ok: false, label: '', dropped: null };
    const slot = {
      kind: 'weapon', id: entry.id, rarity: entry.rarity || 'common',
      mag: entry.ammo ?? weaponMagazine(entry.id, entry.rarity || 'common'),
    };
    const empty = this.firstEmptySlot();
    if (empty >= 0) {
      this.slots[empty] = slot;
      if (!this.weapon) this.activeSlot = empty;
      return { ok: true, label: def.name, dropped: null };
    }
    // plus de place : on echange avec l'emplacement actif
    const old = this.slots[this.activeSlot];
    this.slots[this.activeSlot] = slot;
    this.cancelActions();
    return { ok: true, label: def.name, dropped: old ? this.slotToLoot(old) : null };
  }

  slotToLoot(slot) {
    if (!slot) return null;
    if (slot.kind === 'weapon') return { type: 'weapon', id: slot.id, rarity: slot.rarity, ammo: slot.mag };
    return { type: 'item', id: slot.id, count: slot.count };
  }

  dropSlot(index) {
    const s = this.slots[index];
    if (!s) return null;
    this.slots[index] = null;
    if (index === this.activeSlot) this.cancelActions();
    return this.slotToLoot(s);
  }

  /** Tout le contenu de l'inventaire, pour la mort. */
  dropEverything() {
    const out = [];
    for (let i = 0; i < this.slots.length; i++) {
      const l = this.dropSlot(i);
      if (l) out.push(l);
    }
    for (const id of Object.keys(this.ammo)) {
      if (this.ammo[id] > 0) {
        out.push({ type: 'ammo', id, count: Math.ceil(this.ammo[id] * 0.6) });
        this.ammo[id] = 0;
      }
    }
    return out;
  }

  switchSlot(i) {
    if (i < 0 || i >= INVENTORY_SLOTS) return;
    if (i === this.activeSlot) return;
    this.activeSlot = i;
    this.cancelActions();
    this.nextFire = Math.max(this.nextFire, 0.25);
  }

  cancelActions() {
    this.reloading = false;
    this.usingItem = null;
    this.chestProgress = 0;
    this.chestTarget = null;
    this.grenadeCharge = 0;
  }

  // -------------------------------------------------------------------------
  // Armes
  // -------------------------------------------------------------------------

  ammoFor(slot) {
    const def = WEAPONS[slot.id];
    if (!def || !def.ammo) return Infinity;
    return this.ammo[def.ammo] ?? 0;
  }

  canFire(now) {
    const w = this.weapon;
    if (!w || this.state !== PSTATE.ALIVE) return false;
    if (this.reloading || this.usingItem) return false;
    if (this.nextFire > 0) return false;
    const def = WEAPONS[w.id];
    if (def.magazine > 0 && w.mag <= 0) return false;
    void now;
    return true;
  }

  consumeShot() {
    const w = this.weapon;
    if (!w) return;
    const def = WEAPONS[w.id];
    if (def.magazine > 0) w.mag = Math.max(0, w.mag - 1);
    this.nextFire = 1 / weaponRate(w.id, w.rarity);
  }

  startReload() {
    const w = this.weapon;
    if (!w || this.reloading) return false;
    const def = WEAPONS[w.id];
    if (!def.ammo || def.magazine <= 0) return false;
    const cap = weaponMagazine(w.id, w.rarity);
    if (w.mag >= cap) return false;
    if ((this.ammo[def.ammo] ?? 0) <= 0) return false;
    this.reloading = true;
    this.reloadEnd = weaponReload(w.id, w.rarity);
    this.usingItem = null;
    return true;
  }

  finishReload() {
    const w = this.weapon;
    this.reloading = false;
    if (!w) return;
    const def = WEAPONS[w.id];
    const cap = weaponMagazine(w.id, w.rarity);
    const need = cap - w.mag;
    const have = this.ammo[def.ammo] ?? 0;
    const take = Math.min(need, have);
    w.mag += take;
    this.ammo[def.ammo] = have - take;
  }

  // -------------------------------------------------------------------------
  // Consommables
  // -------------------------------------------------------------------------

  startUseItem(slotIndex) {
    const s = this.slots[slotIndex];
    if (!s || s.kind !== 'item') return false;
    const def = ITEMS[s.id];
    if (!def) return false;
    if (this.usingItem || this.reloading) return false;
    // rien a soigner ?
    if (def.kind === 'heal' && this.health >= Math.min(def.capHealth, GOAT.maxHealth)) return false;
    if (def.kind === 'shield' && this.shield >= def.capShield) return false;
    if (def.kind === 'both' && this.health >= GOAT.maxHealth && this.shield >= GOAT.maxShield) return false;
    if (def.kind === 'throwable' || def.kind === 'fuel' || def.kind === 'repair') return false;
    this.usingItem = { slot: slotIndex, id: s.id };
    this.useEnd = def.useTime;
    return true;
  }

  finishUseItem() {
    const u = this.usingItem;
    this.usingItem = null;
    if (!u) return null;
    const s = this.slots[u.slot];
    if (!s || s.kind !== 'item' || s.id !== u.id) return null;
    const def = ITEMS[u.id];
    s.count--;
    if (s.count <= 0) this.slots[u.slot] = null;
    if (def.overTime) {
      this.healOverTime = def.heal / def.overTime;
      this.healTicks = def.overTime;
      this.healCap = Math.min(def.capHealth, GOAT.maxHealth);
    } else {
      if (def.heal) this.health = Math.min(Math.min(def.capHealth, GOAT.maxHealth), this.health + def.heal);
      if (def.shield) this.shield = Math.min(def.capShield, this.shield + def.shield);
    }
    return def;
  }

  // -------------------------------------------------------------------------
  // Degats
  // -------------------------------------------------------------------------

  /** @returns {{dealt:number, killed:boolean, downed:boolean, toShield:number}} */
  applyDamage(amount, fromId, now, opts = {}) {
    if (this.state === PSTATE.DEAD) return { dealt: 0, killed: false, downed: false, toShield: 0 };
    let remaining = amount;
    let toShield = 0;
    if (this.state === PSTATE.DOWNED) {
      // a terre : plus de bouclier, on tape direct
      this.health -= remaining;
    } else {
      if (this.shield > 0) {
        toShield = Math.min(this.shield, remaining);
        this.shield -= toShield;
        remaining -= toShield;
      }
      this.health -= remaining;
    }
    if (fromId && fromId !== this.id) { this.lastHitBy = fromId; this.lastHitAt = now; }
    // se faire toucher interrompt soin et rechargement
    if (this.usingItem) this.usingItem = null;
    if (opts.interruptReload !== false && this.reloading && amount > 4) { /* le rechargement continue */ }

    let killed = false, downed = false;
    if (this.health <= 0) {
      if (this.state === PSTATE.ALIVE && opts.canDown) {
        this.state = PSTATE.DOWNED;
        this.health = GOAT.downedHealth;
        this.shield = 0;
        this.downedTimer = 0;
        this.cancelActions();
        downed = true;
      } else {
        this.health = 0;
        this.state = PSTATE.DEAD;
        this.deathTime = now;
        killed = true;
      }
    }
    return { dealt: amount, killed, downed, toShield };
  }

  heal(amount, capHealth = GOAT.maxHealth) {
    this.health = Math.min(capHealth, this.health + amount);
  }

  // -------------------------------------------------------------------------
  // Mise a jour des minuteries
  // -------------------------------------------------------------------------

  tickTimers(dt) {
    if (this.nextFire > 0) this.nextFire = Math.max(0, this.nextFire - dt);
    if (this.meleeCooldown > 0) this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);
    if (this.markCooldown > 0) this.markCooldown = Math.max(0, this.markCooldown - dt);
    if (this.reloading) {
      this.reloadEnd -= dt;
      if (this.reloadEnd <= 0) this.finishReload();
    }
    if (this.usingItem) {
      this.useEnd -= dt;
      if (this.useEnd <= 0) this.finishUseItem();
    }
    if (this.healTicks > 0) {
      const d = Math.min(dt, this.healTicks);
      this.health = Math.min(this.healCap ?? GOAT.maxHealth, this.health + this.healOverTime * d);
      this.healTicks -= d;
    }
    if (this.state === PSTATE.ALIVE) this.aliveTime += dt;
  }

  // -------------------------------------------------------------------------
  // Serialisation
  // -------------------------------------------------------------------------

  get flags() {
    let f = 0;
    if (this.sprinting) f |= FLAG.SPRINT;
    if (this.crouching) f |= FLAG.CROUCH;
    if (this.cmd.buttons & BTN.AIM) f |= FLAG.AIM;
    if (this.state === PSTATE.DOWNED) f |= FLAG.DOWNED;
    if (this.state === PSTATE.DEAD) f |= FLAG.DEAD;
    if (this.gliding) f |= FLAG.GLIDING;
    if (this.parachute) f |= FLAG.PARACHUTE;
    if (this.reloading) f |= FLAG.RELOADING;
    if (this.swimming) f |= FLAG.SWIMMING;
    if (this.climbing) f |= FLAG.CLIMBING;
    if (this.shield > 0) f |= FLAG.SHIELDED;
    if (this.usingItem) f |= FLAG.USING_ITEM;
    if (this.vehicleId) f |= FLAG.DRIVING;
    return f;
  }

  /** Vue publique (les autres joueurs). */
  packPublic(full) {
    const o = {
      i: this.id,
      x: Math.round(this.x * 50) / 50,
      y: Math.round(this.y * 50) / 50,
      z: Math.round(this.z * 50) / 50,
      a: Math.round(this.yaw * 500) / 500,
      b: Math.round(this.pitch * 500) / 500,
      s: this.anim,
      f: this.flags,
    };
    if (this.vehicleId) { o.v = this.vehicleId; o.vs = this.seat; }
    const w = this.weapon;
    if (w) { o.w = w.id; o.wr = w.rarity; }
    if (full) { o.n = this.name; o.k = this.skin; o.tm = this.team; o.bot = this.isBot ? 1 : 0; }
    return o;
  }

  /** Vue privee (soi meme) : inventaire, munitions, etat detaille. */
  packSelf() {
    return {
      hp: Math.round(this.health),
      sh: Math.round(this.shield),
      st: this.state,
      sl: this.activeSlot,
      inv: this.slots.map((s) => (s
        ? (s.kind === 'weapon'
          ? { k: 'w', id: s.id, r: s.rarity, m: s.mag }
          : { k: 'i', id: s.id, c: s.count })
        : null)),
      am: this.ammo,
      rl: this.reloading ? Math.max(0, this.reloadEnd) : 0,
      ui: this.usingItem ? { id: this.usingItem.id, t: Math.max(0, this.useEnd) } : null,
      ch: this.chestTarget ? { id: this.chestTarget, p: this.chestProgress } : null,
      gl: this.gliding ? 1 : 0,
      pa: this.parachute ? 1 : 0,
      kills: this.kills,
      dmg: Math.round(this.damageDealt),
      dt: this.state === PSTATE.DOWNED ? Math.round(this.health) : 0,
      vy: Math.round(this.vy * 10) / 10,
    };
  }

  /** Enregistre la position pour la compensation de latence. */
  recordHistory(now) {
    this.history.push({ t: now, x: this.x, y: this.y, z: this.z, crouch: this.crouching });
    while (this.history.length > 40) this.history.shift();
  }

  /** Position telle qu'elle etait il y a `lagMs` millisecondes. */
  positionAt(now, lagSec) {
    const target = now - lagSec;
    const h = this.history;
    if (!h.length) return this;
    if (target >= h[h.length - 1].t) return h[h.length - 1];
    if (target <= h[0].t) return h[0];
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= target && target <= h[i].t) {
        const span = h[i].t - h[i - 1].t || 1;
        const f = (target - h[i - 1].t) / span;
        return {
          x: h[i - 1].x + (h[i].x - h[i - 1].x) * f,
          y: h[i - 1].y + (h[i].y - h[i - 1].y) * f,
          z: h[i - 1].z + (h[i].z - h[i - 1].z) * f,
          crouch: h[i].crouch,
        };
      }
    }
    return h[h.length - 1];
  }

  /** Place le joueur dans l'avion de largage. */
  boardFlight(path, t, altitude = MATCH.dropAltitude) {
    this.gliding = true;
    this.parachute = false;
    this.landed = false;
    this.x = path.from.x + (path.to.x - path.from.x) * t;
    this.z = path.from.z + (path.to.z - path.from.z) * t;
    this.y = altitude;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = Math.atan2(path.to.x - path.from.x, path.to.z - path.from.z);
    this.pitch = -0.35;
    this.anim = ANIM.GLIDE;
  }

  reset() {
    this.state = PSTATE.ALIVE;
    this.health = GOAT.maxHealth;
    this.shield = 0;
    this.kills = 0;
    this.damageDealt = 0;
    this.placement = 0;
    this.slots.fill(null);
    this.ammo = { light: 0, medium: 0, shells: 0, rockets: 0 };
    this.activeSlot = 0;
    this.vehicleId = null;
    this.seat = -1;
    this.history.length = 0;
    this.cancelActions();
    this.aliveTime = 0;
    this.vx = this.vy = this.vz = 0;
    this.landSpeed = 0;
    this.downedTimer = 0;
    this.spectateTarget = null;
  }
}

export function clampPitch(p) {
  return clamp(p, -1.45, 1.45);
}

export const SEA = SEA_LEVEL;
