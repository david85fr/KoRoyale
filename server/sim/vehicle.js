// Les vehicules : etat, sieges, degats, et pont vers la physique partagee.

import { VEHICLE_TYPES, BTN, VEHICLE_DAMAGE, SEA_LEVEL } from '../../shared/constants.js';
import { stepVehicle, seatWorldPos, findExitSpot } from '../../shared/movement.js';
import { EV } from '../../shared/protocol.js';
import { clamp } from '../../shared/math.js';

const _seat = { x: 0, y: 0, z: 0 };
let _vid = 0;

export class Vehicle {
  constructor(opts) {
    this.id = opts.id || `v${++_vid}`;
    this.type = opts.type;
    const T = VEHICLE_TYPES[this.type];
    this.T = T;
    this.x = opts.x; this.y = opts.y; this.z = opts.z;
    this.yaw = opts.yaw || 0;
    this.pitch = 0; this.roll = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.speed = 0;
    this.steer = 0;
    this.wheelSpin = 0;
    this.grounded = true;
    this.impactSpeed = 0;
    this.health = T.health;
    this.maxHealth = T.health;
    this.fuel = 100;
    this.destroyed = false;
    this.seats = new Array(T.seats).fill(null);
    this.lastDriverId = null;
    this.horn = 0;
    this.brake = false;
    this.explodeTimer = 0;
    this.idle = 0;
  }

  get driverId() { return this.seats[0]; }
  get occupied() { return this.seats.some((s) => s !== null); }

  freeSeat() {
    return this.seats.findIndex((s) => s === null);
  }

  box() {
    return {
      x: this.x, y: this.y + this.T.halfExtents[1], z: this.z,
      hx: this.T.halfExtents[0], hy: this.T.halfExtents[1], hz: this.T.halfExtents[2],
      yaw: this.yaw,
    };
  }

  seatPosition(index) {
    return seatWorldPos(this, index, _seat);
  }

  /** Un tick de simulation. `driver` peut etre null (vehicule a l'abandon). */
  step(match, dt) {
    const T = this.T;
    let throttle = 0, steer = 0, handbrake = false;
    const driver = this.driverId ? match.players.get(this.driverId) : null;

    if (driver && driver.alive && !this.destroyed) {
      const c = driver.cmd;
      throttle = clamp(c.moveY, -1, 1);
      steer = clamp(c.moveX, -1, 1);
      handbrake = (c.buttons & BTN.HANDBRAKE) !== 0 || (c.buttons & BTN.CROUCH) !== 0;
      this.brake = throttle < -0.05 && this.speed > 1;
      if (c.buttons & BTN.HORN) this.horn = Math.max(this.horn, 0.4);
      this.idle = 0;
    } else {
      this.brake = false;
      this.idle += dt;
      // un vehicule vide s'arrete tout seul
      throttle = 0;
      if (Math.abs(this.speed) > 0.2) throttle = -0.25 * Math.sign(this.speed);
    }
    if (this.horn > 0) this.horn = Math.max(0, this.horn - dt);

    const prevSpeed = this.speed;
    stepVehicle(this, { throttle, steer, handbrake }, match.world.ctx, dt);

    // --- degats de collision ---
    if (this.impactSpeed > VEHICLE_DAMAGE.minSpeed) {
      const dmg = (this.impactSpeed - VEHICLE_DAMAGE.minSpeed) * VEHICLE_DAMAGE.selfPerSpeed * 4;
      this.damage(dmg, null, match);
      for (const id of this.seats) {
        const p = id && match.players.get(id);
        if (p && p.alive) {
          const r = p.applyDamage((this.impactSpeed - VEHICLE_DAMAGE.minSpeed) * 1.5, null, match.time,
            { canDown: match.teamSize > 1 });
          if (r.killed || r.downed) match.onPlayerDefeated(p, null, 'collision', r.downed);
        }
      }
    }
    if (this.hardLanding && this.hardLanding > VEHICLE_DAMAGE.fallDamageSpeed) {
      this.damage((this.hardLanding - VEHICLE_DAMAGE.fallDamageSpeed) * 6, null, match);
      this.hardLanding = 0;
    }
    void prevSpeed;

    // --- renversement des chevres a pied ---
    if (Math.abs(this.speed) > VEHICLE_DAMAGE.minSpeed) this.runOver(match);

    // --- carcasse ---
    if (this.destroyed) {
      this.explodeTimer -= dt;
      if (this.explodeTimer <= 0) match.removeVehicle(this);
    }

    // une vedette qui coule
    if (this.T.aquatic && this.y < SEA_LEVEL - 2.5) this.damage(999, null, match);
  }

  runOver(match) {
    const T = this.T;
    const reach = Math.max(T.halfExtents[0], T.halfExtents[2]) + 0.7;
    for (const p of match.players.values()) {
      if (!p.alive || p.vehicleId) continue;
      const dx = p.x - this.x, dz = p.z - this.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      if (Math.abs(p.y - this.y) > 2.2) continue;
      if (this.seats.includes(p.id)) continue;
      const now = match.time;
      if (p._lastRam && now - p._lastRam < 0.6) continue;
      p._lastRam = now;
      const dmg = Math.min(VEHICLE_DAMAGE.maxPerHit,
        (Math.abs(this.speed) - VEHICLE_DAMAGE.minSpeed) * VEHICLE_DAMAGE.perSpeed * T.rammingDamage);
      if (dmg <= 0) continue;
      const attacker = this.driverId ? match.players.get(this.driverId) : null;
      if (attacker && attacker.team === p.team && match.teamSize > 1 && attacker.id !== p.id) continue;
      const res = p.applyDamage(dmg, attacker ? attacker.id : null, now, { canDown: match.teamSize > 1 });
      const l = Math.hypot(dx, dz) || 1;
      p.vx += (dx / l) * 9 + this.vx * 0.3;
      p.vz += (dz / l) * 9 + this.vz * 0.3;
      p.vy += 5.5;
      p.onGround = false;
      if (attacker) attacker.damageDealt += res.dealt;
      match.pushEvent({ e: EV.HIT, t: p.id, d: Math.round(dmg), by: attacker?.id ?? null, hs: 0 });
      if (res.killed || res.downed) match.onPlayerDefeated(p, attacker, 'ram', res.downed);
      this.damage(dmg * 0.25, null, match);
    }
  }

  damage(amount, byId, match) {
    if (this.destroyed) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.destroyed = true;
      this.explodeTimer = 0.6;
      match.onVehicleDestroyed(this, byId);
    }
  }

  enter(player, seatIndex, match) {
    if (this.destroyed) return false;
    let idx = seatIndex;
    if (idx === undefined || idx === null || idx < 0 || this.seats[idx] !== null) idx = this.freeSeat();
    if (idx < 0) return false;
    this.seats[idx] = player.id;
    player.vehicleId = this.id;
    player.seat = idx;
    player.cancelActions();
    player.vx = player.vy = player.vz = 0;
    player.onGround = true;
    if (idx === 0) this.lastDriverId = player.id;
    void match;
    return true;
  }

  exit(player, match) {
    const idx = this.seats.indexOf(player.id);
    if (idx >= 0) this.seats[idx] = null;
    const spot = findExitSpot(this, match.world.ctx, 0.55, 1.55);
    player.vehicleId = null;
    player.seat = -1;
    player.x = spot.x; player.y = spot.y + 0.2; player.z = spot.z;
    player.vx = this.vx * 0.35; player.vz = this.vz * 0.35; player.vy = 2.2;
    player.onGround = false;
    return true;
  }

  /** Colle les passagers a leur siege. */
  syncPassengers(match) {
    for (let i = 0; i < this.seats.length; i++) {
      const id = this.seats[i];
      if (!id) continue;
      const p = match.players.get(id);
      if (!p) { this.seats[i] = null; continue; }
      if (!p.alive) { this.seats[i] = null; p.vehicleId = null; p.seat = -1; continue; }
      const s = this.seatPosition(i);
      p.x = s.x; p.y = s.y - 0.55; p.z = s.z;
      p.vx = this.vx; p.vy = this.vy; p.vz = this.vz;
      p.onGround = true;
    }
  }

  serialize() {
    return {
      i: this.id,
      t: this.type,
      x: Math.round(this.x * 50) / 50,
      y: Math.round(this.y * 50) / 50,
      z: Math.round(this.z * 50) / 50,
      a: Math.round(this.yaw * 500) / 500,
      p: Math.round(this.pitch * 200) / 200,
      r: Math.round(this.roll * 200) / 200,
      sp: Math.round(this.speed * 10) / 10,
      st: Math.round(this.steer * 100) / 100,
      w: Math.round(this.wheelSpin * 20) / 20,
      h: Math.round((this.health / this.maxHealth) * 100) / 100,
      f: Math.round(this.fuel),
      s: this.seats.map((s) => s || 0),
      d: this.destroyed ? 1 : 0,
      hn: this.horn > 0 ? 1 : 0,
      b: this.brake ? 1 : 0,
    };
  }
}
