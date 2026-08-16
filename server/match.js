// Une partie de KoRoyale : simulation autoritaire a 20 Hz.
// Le salon (room.js) cree un Match, lui donne ses joueurs, puis relaie les snapshots.

import {
  TICK_DT, GOAT, PSTATE, MATCH, AOI_RADIUS, BTN, CHEST, ANIM, SEA_LEVEL,
  TEAM_MODES, GOAT_SKINS,
} from '../shared/constants.js';
import { ACT, EV } from '../shared/protocol.js';
import { RNG } from '../shared/rng.js';
import { clamp, dirFromYawPitch } from '../shared/math.js';
import { stepGoat, stepGlide } from '../shared/movement.js';
import { flightPath, zoneNameAt } from '../shared/mapdata.js';
import { WEAPONS, ITEMS } from '../shared/loot.js';
import { getWorld } from './sim/world.js';
import { Storm } from './sim/storm.js';
import { LootManager } from './sim/loot.js';
import { Vehicle } from './sim/vehicle.js';
import { Player } from './sim/player.js';
import {
  traceShot, applySpread, bulletDamage, createProjectile, stepProjectile, explode,
  fallDamage,
} from './sim/combat.js';
import { BotBrain } from './sim/bots.js';

const FLIGHT_DURATION = 26; // secondes de survol avant largage force
const MAX_EVENTS = 48;

export class Match {
  constructor(opts = {}) {
    this.world = getWorld();
    this.seed = opts.seed || `m${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    this.rng = new RNG(this.seed);
    this.teamSize = TEAM_MODES[opts.mode]?.size ?? 1;
    this.mode = opts.mode || 'solo';
    this.friendlyFire = !!opts.friendlyFire;

    this.players = new Map();
    this.vehicles = new Map();
    this.projectiles = [];
    this.brains = new Map();

    this.storm = new Storm(this.rng.fork(11));
    this.loot = new LootManager(this, this.rng.fork(12));
    this.flight = flightPath(this.rng.fork(13));

    this.phase = 'flight';
    this.time = 0;
    this.tick = 0;
    this.flightT = 0;
    this.events = [];
    this.placements = [];
    this.endTimer = 0;
    this.winnerTeam = null;
    this.onEnd = opts.onEnd || null;
    this.started = false;
  }

  // -------------------------------------------------------------------------
  // Mise en place
  // -------------------------------------------------------------------------

  /** @param roster [{id,name,skin,isBot,conn,difficulty}] */
  start(roster) {
    // equipes
    const shuffled = this.rng.shuffle(roster.slice());
    let team = 0, inTeam = 0;
    for (const r of shuffled) {
      const p = new Player({
        id: r.id, name: r.name, skin: r.skin || this.rng.pick(GOAT_SKINS).id,
        team, isBot: r.isBot, conn: r.conn,
      });
      p.reset();
      this.players.set(p.id, p);
      if (r.isBot) this.brains.set(p.id, new BotBrain(p, this, r.difficulty || 'biquette', this.rng.fork(p.id.length + team)));
      inTeam++;
      if (inTeam >= this.teamSize) { team++; inTeam = 0; }
    }
    if (inTeam > 0) team++;
    this.teamCount = team;

    // vehicules
    for (const s of this.world.map.vehicleSpawns) {
      const v = new Vehicle({ id: s.id, type: s.type, x: s.x, y: s.y, z: s.z, yaw: s.yaw });
      this.vehicles.set(v.id, v);
    }

    // butin
    this.loot.spawnInitial();

    // embarquement
    const n = this.players.size;
    let i = 0;
    for (const p of this.players.values()) {
      p.flightOffset = n > 1 ? i / (n - 1) : 0.5;
      p.boardFlight(this.flight, 0, MATCH.dropAltitude);
      p.gliding = true;
      p.inPlane = true;
      i++;
    }
    this.started = true;
    return this;
  }

  aliveList() {
    const out = [];
    for (const p of this.players.values()) if (p.alive) out.push(p);
    return out;
  }

  aliveTeams() {
    const s = new Set();
    for (const p of this.players.values()) if (p.alive) s.add(p.team);
    return s;
  }

  pushEvent(ev) {
    ev.k = this.tick;
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS * 4) this.events.splice(0, this.events.length - MAX_EVENTS * 4);
  }

  // -------------------------------------------------------------------------
  // Entrees
  // -------------------------------------------------------------------------

  applyInput(playerId, msg) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (typeof msg.s === 'number' && msg.s <= p.lastSeq) return;
    p.lastSeq = msg.s || 0;
    const c = p.cmd;
    c.moveX = clamp(msg.mx ?? 0, -1, 1);
    c.moveY = clamp(msg.my ?? 0, -1, 1);
    c.yaw = typeof msg.a === 'number' ? msg.a : c.yaw;
    c.pitch = clamp(typeof msg.b === 'number' ? msg.b : c.pitch, -1.45, 1.45);
    c.buttons = msg.bt | 0;
    p.lastInputAt = this.time;
    if (typeof msg.dt === 'number') p.ping = clamp(msg.dt, 0, 400);
  }

  applyAction(playerId, msg) {
    const p = this.players.get(playerId);
    if (!p || !p.alive) return;
    switch (msg.a) {
      case ACT.SLOT: p.switchSlot(msg.slot | 0); break;
      case ACT.DROP: {
        const l = p.dropSlot(p.activeSlot);
        if (l) {
          const gy = Math.max(this.world.terrain(p.x, p.z), SEA_LEVEL + 0.1);
          const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
          this.loot.spawn(p.x + fx * 1.2, gy + 0.9, p.z + fz * 1.2, l, { vy: 1.5 });
        }
        break;
      }
      case ACT.USE: this.tryUse(p); break;
      case ACT.USE_ITEM: {
        const idx = typeof msg.slot === 'number'
          ? msg.slot
          : p.slots.findIndex((s) => s && s.kind === 'item' && s.id === msg.id);
        if (idx >= 0) p.startUseItem(idx);
        break;
      }
      case ACT.ENTER_VEHICLE: this.tryEnterVehicle(p, msg.seat); break;
      case ACT.EXIT_VEHICLE: this.tryExitVehicle(p); break;
      case ACT.SEAT: this.trySwitchSeat(p, msg.seat | 0); break;
      case ACT.THROW: this.throwGrenade(p, clamp(msg.charge ?? 1, 0, 1)); break;
      case ACT.JUMP_OUT: if (p.inPlane) { p.inPlane = false; p.gliding = true; } break;
      case ACT.DEPLOY: if (p.gliding) p.parachute = true; break;
      case ACT.MARK:
        if (p.markCooldown <= 0) {
          p.markCooldown = 2;
          this.pushEvent({ e: EV.MARK, p: p.id, tm: p.team, x: Math.round(msg.x || p.x), z: Math.round(msg.z || p.z) });
        }
        break;
      case ACT.EMOTE:
        this.pushEvent({ e: EV.EMOTE, p: p.id, id: (msg.id | 0) || 0 });
        break;
      case ACT.REVIVE: this.tryRevive(p); break;
      case ACT.SPECTATE_NEXT: this.cycleSpectate(p); break;
      default: break;
    }
  }

  // -------------------------------------------------------------------------
  // Interactions
  // -------------------------------------------------------------------------

  tryUse(p) {
    if (p.vehicleId) { this.tryExitVehicle(p); return; }
    // 1) coffre a portee : c'est la pression maintenue qui l'ouvre (gere dans le tick)
    // 2) sinon on ramasse
    const got = this.loot.tryPickup(p);
    if (got) return;
    // 3) sinon on monte dans un vehicule
    this.tryEnterVehicle(p);
  }

  nearestVehicle(p, maxDist = 3.4) {
    let best = null, bestD = maxDist * maxDist;
    for (const v of this.vehicles.values()) {
      if (v.destroyed) continue;
      const dx = v.x - p.x, dz = v.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD && Math.abs(v.y - p.y) < 3.2 && v.freeSeat() >= 0) { bestD = d; best = v; }
    }
    return best;
  }

  tryEnterVehicle(p, seat) {
    if (p.vehicleId || !p.alive || p.state === PSTATE.DOWNED) return false;
    const v = this.nearestVehicle(p);
    if (!v) return false;
    if (!v.enter(p, seat, this)) return false;
    this.pushEvent({ e: EV.VEHICLE_ENTER, p: p.id, v: v.id, s: p.seat });
    return true;
  }

  tryExitVehicle(p) {
    if (!p.vehicleId) return false;
    const v = this.vehicles.get(p.vehicleId);
    if (!v) { p.vehicleId = null; p.seat = -1; return false; }
    v.exit(p, this);
    this.pushEvent({ e: EV.VEHICLE_EXIT, p: p.id, v: v.id });
    return true;
  }

  trySwitchSeat(p, seat) {
    if (!p.vehicleId) return;
    const v = this.vehicles.get(p.vehicleId);
    if (!v || seat < 0 || seat >= v.seats.length || v.seats[seat] !== null) return;
    v.seats[p.seat] = null;
    v.seats[seat] = p.id;
    p.seat = seat;
  }

  tryRevive(p) {
    if (this.teamSize <= 1 || !p.alive || p.state === PSTATE.DOWNED) return;
    for (const o of this.players.values()) {
      if (o === p || o.team !== p.team || o.state !== PSTATE.DOWNED) continue;
      const d = Math.hypot(o.x - p.x, o.z - p.z);
      if (d < 2.4 && Math.abs(o.y - p.y) < 2.4) { o.reviverId = p.id; return; }
    }
  }

  cycleSpectate(p) {
    const alive = this.aliveList().filter((a) => a.id !== p.id);
    if (!alive.length) return;
    const idx = alive.findIndex((a) => a.id === p.spectateTarget);
    p.spectateTarget = alive[(idx + 1) % alive.length].id;
  }

  throwGrenade(p, charge) {
    const idx = p.slots.findIndex((s) => s && s.kind === 'item' && s.id === 'grenade');
    if (idx < 0) return;
    const s = p.slots[idx];
    s.count--;
    if (s.count <= 0) p.slots[idx] = null;
    const def = ITEMS.grenade;
    const [dx, dy, dz] = dirFromYawPitch(p.yaw, clamp(p.pitch + 0.22, -1.2, 1.2));
    const speed = def.throwSpeed * (0.45 + charge * 0.55);
    const pr = createProjectile('grenade', p, p.x + dx * 0.7, p.eyeY, p.z + dz * 0.7, dx, dy, dz, {
      speed, gravity: 20, bounce: 0.42, fuse: def.fuse,
      radius: def.splashRadius, damage: def.damage,
    });
    pr.vx += p.vx * 0.6; pr.vz += p.vz * 0.6;
    this.projectiles.push(pr);
  }

  // -------------------------------------------------------------------------
  // Tir
  // -------------------------------------------------------------------------

  fireWeapon(p) {
    const slot = p.weapon;
    if (!slot) return;
    const def = WEAPONS[slot.id];
    p.consumeShot();
    p.lastShotAt = this.time; // les bots proches "entendent" le coup de feu

    const eyeY = p.eyeY;
    const aiming = (p.cmd.buttons & BTN.AIM) !== 0;
    let spread = aiming ? def.spread[1] : def.spread[0];
    if (!p.onGround) spread *= 1.7;
    else if (p.speed > GOAT.walkSpeed) spread *= 1.45;
    else if (p.crouching) spread *= 0.7;

    const [bx, by, bz] = dirFromYawPitch(p.yaw, p.pitch);
    const rewind = clamp(p.ping / 1000, 0, 0.25);

    if (def.kind === 'launcher') {
      const pr = createProjectile('rocket', p, p.x + bx * 0.9, eyeY, p.z + bz * 0.9, bx, by, bz, {
        speed: def.projectileSpeed, gravity: def.projectileGravity, fuse: 9,
        radius: def.splashRadius, damage: def.splashDamage, weaponId: def.id,
      });
      this.projectiles.push(pr);
      this.pushEvent({ e: EV.SHOT, p: p.id, w: def.id, x: r1(p.x), y: r1(eyeY), z: r1(p.z), dx: r2(bx), dy: r2(by), dz: r2(bz) });
      return;
    }

    const pellets = def.pellets || 1;
    for (let i = 0; i < pellets; i++) {
      const [dx, dy, dz] = applySpread(bx, by, bz, spread, this.rng);
      const hit = traceShot(this, p, p.x, eyeY, p.z, dx, dy, dz, def.range, rewind);
      const end = hit
        ? { x: hit.x, y: hit.y, z: hit.z }
        : { x: p.x + dx * def.range, y: eyeY + dy * def.range, z: p.z + dz * def.range };

      if (hit && hit.kind === 'player') {
        const victim = hit.player;
        if (!this.canDamage(p, victim)) continue;
        const dmg = bulletDamage(slot.id, slot.rarity, hit.t, hit.mult);
        this.dealDamage(victim, dmg, p, slot.id, hit.part === 'head');
      } else if (hit && hit.kind === 'vehicle') {
        hit.vehicle.damage(bulletDamage(slot.id, slot.rarity, hit.t, 1) * 0.8, p.id, this);
      }
      if (i === 0 || pellets <= 3) {
        this.pushEvent({
          e: EV.SHOT, p: p.id, w: def.id,
          x: r1(p.x), y: r1(eyeY), z: r1(p.z),
          ex: r1(end.x), ey: r1(end.y), ez: r1(end.z),
          s: hit ? (hit.kind === 'player' ? 1 : 2) : 0,
          sf: hit?.surface ?? 0,
          nx: hit?.normal ? r2(hit.normal[0]) : 0,
          ny: hit?.normal ? r2(hit.normal[1]) : 1,
          nz: hit?.normal ? r2(hit.normal[2]) : 0,
        });
      }
    }
  }

  headbutt(p) {
    if (p.meleeCooldown > 0) return;
    p.meleeCooldown = GOAT.headbuttCooldown;
    p.anim = ANIM.HEADBUTT;
    p.meleeAnim = 0.35;
    const [dx, , dz] = dirFromYawPitch(p.yaw, 0);
    let hitSomething = false;
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      if (!this.canDamage(p, o)) continue;
      const ox = o.x - p.x, oz = o.z - p.z;
      const d = Math.hypot(ox, oz);
      if (d > GOAT.headbuttRange || Math.abs(o.y - p.y) > 2.2) continue;
      if ((ox / (d || 1)) * dx + (oz / (d || 1)) * dz < 0.4) continue;
      this.dealDamage(o, GOAT.headbuttDamage, p, 'hoof', false);
      o.vx += dx * GOAT.headbuttKnockback;
      o.vz += dz * GOAT.headbuttKnockback;
      o.vy += 4.5;
      o.onGround = false;
      hitSomething = true;
    }
    // un coup de corne dans une voiture, ca compte aussi
    for (const v of this.vehicles.values()) {
      if (v.destroyed) continue;
      const d = Math.hypot(v.x - p.x, v.z - p.z);
      if (d < GOAT.headbuttRange + 1.6 && Math.abs(v.y - p.y) < 2.6) {
        v.damage(GOAT.headbuttDamage * 0.8, p.id, this);
        v.vx += dx * 3; v.vz += dz * 3;
        hitSomething = true;
      }
    }
    this.pushEvent({ e: EV.SHOT, p: p.id, w: 'hoof', x: r1(p.x), y: r1(p.eyeY), z: r1(p.z), s: hitSomething ? 1 : 0 });
  }

  canDamage(attacker, victim) {
    if (!attacker) return true;
    if (attacker.id === victim.id) return false;
    if (this.teamSize > 1 && attacker.team === victim.team && !this.friendlyFire) return false;
    return true;
  }

  dealDamage(victim, amount, attacker, weaponId, headshot) {
    const res = victim.applyDamage(amount, attacker ? attacker.id : null, this.time, {
      canDown: this.teamSize > 1 && this.teamHasAlly(victim),
    });
    if (attacker) attacker.damageDealt += res.dealt;
    this.pushEvent({
      e: EV.HIT, t: victim.id, d: Math.round(res.dealt), by: attacker?.id ?? null,
      hs: headshot ? 1 : 0, sh: Math.round(res.toShield),
    });
    if (res.killed || res.downed) this.onPlayerDefeated(victim, attacker, weaponId, res.downed);
    return res;
  }

  teamHasAlly(p) {
    if (this.teamSize <= 1) return false;
    for (const o of this.players.values()) {
      if (o !== p && o.team === p.team && o.state === PSTATE.ALIVE) return true;
    }
    return false;
  }

  onPlayerDefeated(victim, attacker, weaponId, downed) {
    if (downed) {
      this.pushEvent({
        e: EV.DOWN, v: victim.id, k: attacker?.id ?? null, w: weaponId || null,
        z: zoneNameAt(victim.x, victim.z),
      });
      return;
    }
    if (victim.state !== PSTATE.DEAD) return;
    if (victim.vehicleId) {
      const v = this.vehicles.get(victim.vehicleId);
      if (v) { const i = v.seats.indexOf(victim.id); if (i >= 0) v.seats[i] = null; }
      victim.vehicleId = null; victim.seat = -1;
    }
    if (attacker && attacker !== victim) attacker.kills++;
    const remaining = this.aliveList().length;
    victim.placement = remaining + 1;
    this.placements.push({
      id: victim.id, name: victim.name, place: victim.placement,
      kills: victim.kills, damage: Math.round(victim.damageDealt), bot: victim.isBot,
    });
    const dist = attacker ? Math.round(Math.hypot(attacker.x - victim.x, attacker.z - victim.z)) : 0;
    this.pushEvent({
      e: EV.KILL, v: victim.id, vn: victim.name, k: attacker?.id ?? null, kn: attacker?.name ?? null,
      w: weaponId || null, hs: 0, dist, z: zoneNameAt(victim.x, victim.z), left: remaining,
    });
    // le butin tombe au sol
    const drops = victim.dropEverything();
    if (drops.length) {
      const gy = Math.max(this.world.terrain(victim.x, victim.z), SEA_LEVEL + 0.1);
      this.loot.scatter(victim.x, gy, victim.z, drops, 2.1);
    }
  }

  onVehicleDestroyed(v, byId) {
    this.pushEvent({ e: EV.VEHICLE_DESTROYED, v: v.id, x: r1(v.x), y: r1(v.y), z: r1(v.z) });
    const hits = explode(this, v.x, v.y + 0.8, v.z, 8, 75, byId, { knockback: 16 });
    for (const h of hits) {
      const attacker = byId ? this.players.get(byId) : null;
      if (attacker && !this.canDamage(attacker, h.player)) continue;
      this.dealDamage(h.player, h.damage, attacker, 'explosion', false);
    }
    for (const id of v.seats) {
      const p = id && this.players.get(id);
      if (p) { p.vehicleId = null; p.seat = -1; }
    }
    v.seats.fill(null);
  }

  removeVehicle(v) {
    this.vehicles.delete(v.id);
  }

  // -------------------------------------------------------------------------
  // Boucle
  // -------------------------------------------------------------------------

  update(dt = TICK_DT) {
    if (!this.started) return;
    this.time += dt;
    this.tick++;

    if (this.phase === 'ended') {
      this.endTimer -= dt;
      return;
    }

    // --- phase de largage ---
    if (this.phase === 'flight') {
      this.flightT += dt / FLIGHT_DURATION;
      if (this.flightT >= 1) {
        for (const p of this.players.values()) p.inPlane = false;
        this.phase = 'playing';
      } else if (![...this.players.values()].some((p) => p.inPlane)) {
        this.phase = 'playing';
      }
    }

    // --- cerveaux des bots ---
    for (const b of this.brains.values()) b.think(dt);

    // --- joueurs ---
    for (const p of this.players.values()) {
      this.updatePlayer(p, dt);
    }

    // --- vehicules ---
    for (const v of this.vehicles.values()) {
      v.step(this, dt);
      v.syncPassengers(this);
    }

    // --- projectiles ---
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      if (stepProjectile(pr, this, dt)) {
        this.projectiles.splice(i, 1);
        this.detonate(pr);
      }
    }

    // --- butin, tempete ---
    this.loot.update(dt);
    // Passe dediee : la brume ignore les carrosseries. Sans ca, deux chevres au volant
    // se partagent une partie eternelle une fois le cercle referme.
    for (const p of this.players.values()) {
      if (!p.alive || p.inPlane || p.gliding) { p.stormAcc = 0; continue; }
      const sdps = this.storm.damageAt(p.x, p.z);
      if (sdps <= 0) { p.stormAcc = 0; continue; }
      p.stormAcc = (p.stormAcc || 0) + sdps * dt;
      if (p.stormAcc >= 1) {
        const d = Math.floor(p.stormAcc);
        p.stormAcc -= d;
        this.dealDamage(p, d, null, 'brume', false);
      }
    }
    const phaseChange = this.storm.update(dt);
    if (phaseChange) {
      this.pushEvent({ e: EV.STORM_PHASE, p: this.storm.phase, s: this.storm.shrinking ? 1 : 0 });
    }

    this.checkVictory();
  }

  detonate(pr) {
    this.pushEvent({ e: EV.EXPLOSION, x: r1(pr.x), y: r1(pr.y), z: r1(pr.z), r: pr.radius });
    const owner = pr.ownerId ? this.players.get(pr.ownerId) : null;
    // degat direct
    if (pr.directHit && pr.directHit.kind === 'player') {
      const v = pr.directHit.player;
      if (this.canDamage(owner, v)) this.dealDamage(v, pr.damage * 0.55, owner, pr.weaponId || 'grenade', false);
    } else if (pr.directHit && pr.directHit.kind === 'vehicle') {
      pr.directHit.vehicle.damage(pr.damage * 1.4, pr.ownerId, this);
    }
    const hits = explode(this, pr.x, pr.y, pr.z, pr.radius, pr.damage, pr.ownerId);
    for (const h of hits) {
      if (owner && !this.canDamage(owner, h.player) && h.player.id !== pr.ownerId) continue;
      this.dealDamage(h.player, h.damage, owner, pr.weaponId || 'grenade', false);
    }
  }

  updatePlayer(p, dt) {
    p.tickTimers(dt);
    if (p.meleeAnim > 0) p.meleeAnim = Math.max(0, p.meleeAnim - dt);

    if (p.state === PSTATE.DEAD) {
      p.anim = ANIM.DOWNED;
      return;
    }

    // --- a terre ---
    if (p.state === PSTATE.DOWNED) {
      p.anim = ANIM.DOWNED;
      p.health -= GOAT.downedDecay * dt;
      // relevage
      if (p.reviverId) {
        const r = this.players.get(p.reviverId);
        const ok = r && r.state === PSTATE.ALIVE
          && Math.hypot(r.x - p.x, r.z - p.z) < 2.6 && (r.cmd.buttons & BTN.USE);
        if (ok) {
          p.reviveProgress += dt;
          if (p.reviveProgress >= GOAT.reviveTime) {
            p.state = PSTATE.ALIVE;
            p.health = 35;
            p.reviveProgress = 0;
            p.reviverId = null;
            this.pushEvent({ e: EV.REVIVED, p: p.id, by: r.id });
          }
        } else { p.reviverId = null; p.reviveProgress = Math.max(0, p.reviveProgress - dt * 2); }
      } else {
        p.reviveProgress = Math.max(0, p.reviveProgress - dt * 2);
      }
      if (p.health <= 0) {
        p.health = 0;
        p.state = PSTATE.DEAD;
        p.deathTime = this.time;
        const killer = p.lastHitBy ? this.players.get(p.lastHitBy) : null;
        this.onPlayerDefeated(p, killer, 'saignement', false);
      }
      // les chevres a terre rampent doucement
      const crawl = { ...p.cmd, buttons: 0 };
      this.stepOnFoot(p, crawl, dt, 0.35);
      p.recordHistory(this.time);
      return;
    }

    // --- dans l'avion ---
    if (p.inPlane) {
      const t = clamp(this.flightT, 0, 1);
      p.x = this.flight.from.x + (this.flight.to.x - this.flight.from.x) * t;
      p.z = this.flight.from.z + (this.flight.to.z - this.flight.from.z) * t;
      p.y = MATCH.dropAltitude;
      p.yaw = p.cmd.yaw;
      p.pitch = p.cmd.pitch;
      p.anim = ANIM.GLIDE;
      p.recordHistory(this.time);
      return;
    }

    // --- en vol ---
    if (p.gliding) {
      const landed = stepGlide(p, p.cmd, this.world.ctx, dt, MATCH);
      p.yaw = p.cmd.yaw;
      p.pitch = p.cmd.pitch;
      if (landed) {
        p.gliding = false;
        p.landed = true;
        this.pushEvent({ e: EV.LAND, p: p.id, x: r1(p.x), z: r1(p.z) });
      }
      p.recordHistory(this.time);
      return;
    }

    // --- en vehicule : la physique est celle du vehicule ---
    if (p.vehicleId) {
      const v = this.vehicles.get(p.vehicleId);
      if (!v || v.destroyed) { p.vehicleId = null; p.seat = -1; }
      else {
        p.yaw = p.cmd.yaw;
        p.pitch = p.cmd.pitch;
        p.anim = ANIM.DRIVE;
        // le passager peut tirer
        this.handleWeapons(p, dt, p.seat !== 0);
        p.recordHistory(this.time);
        return;
      }
    }

    // --- a pied ---
    this.stepOnFoot(p, p.cmd, dt, 1);
    p.yaw = p.cmd.yaw;
    p.pitch = p.cmd.pitch;
    if (p.meleeAnim > 0) p.anim = ANIM.HEADBUTT;

    // degats de chute
    if (p.landSpeed > 0) {
      const dmg = fallDamage(p.landSpeed);
      p.landSpeed = 0;
      if (dmg > 0) this.dealDamage(p, dmg, null, 'chute', false);
    }

    this.handleWeapons(p, dt, true);
    this.handleInteract(p, dt);
    this.loot.autoPickup(p);

    // --- noyade ---
    if (p.swimming && p.y < SEA_LEVEL - 1.4) {
      p.drown = (p.drown || 0) + dt;
      if (p.drown > 12) { this.dealDamage(p, 6 * dt, null, 'noyade', false); }
    } else p.drown = 0;

    p.recordHistory(this.time);
  }

  stepOnFoot(p, cmd, dt, speedMult) {
    const ctx = speedMult === 1 ? this.world.ctx : { ...this.world.ctx, speedMult };
    stepGoat(p, cmd, ctx, dt);
  }

  handleWeapons(p, dt, canFire) {
    const btn = p.cmd.buttons;
    const prev = p.prevButtons || 0;
    p.prevButtons = btn;

    if ((btn & BTN.MELEE) && !(prev & BTN.MELEE) && !p.vehicleId) this.headbutt(p);
    if ((btn & BTN.RELOAD) && !(prev & BTN.RELOAD)) p.startReload();

    if (!canFire) return;
    const def = p.weaponDef;
    if (!def) return;
    const firing = (btn & BTN.FIRE) !== 0;
    const rising = firing && !(prev & BTN.FIRE);
    const wantShoot = def.fireMode === 'auto' ? firing : rising;
    if (wantShoot && p.canFire(this.time)) {
      this.fireWeapon(p);
    } else if (firing && !p.reloading && def.magazine > 0) {
      const w = p.weapon;
      if (w && w.mag <= 0) p.startReload();
    }
    void dt;
  }

  handleInteract(p, dt) {
    const holding = (p.cmd.buttons & BTN.USE) !== 0;
    if (!holding) { p.chestProgress = 0; p.chestTarget = null; return; }
    const chest = this.loot.nearestChest(p);
    if (!chest) { p.chestProgress = 0; p.chestTarget = null; return; }
    if (p.chestTarget !== chest.id) { p.chestTarget = chest.id; p.chestProgress = 0; }
    p.chestProgress += dt / CHEST.openTime;
    if (p.chestProgress >= 1) {
      this.loot.openChest(chest, p);
      p.chestProgress = 0;
      p.chestTarget = null;
    }
  }

  checkVictory() {
    if (this.phase !== 'playing') return;
    const teams = this.aliveTeams();
    if (teams.size <= 1 && this.players.size > 1) {
      this.phase = 'ended';
      this.endTimer = MATCH.endDelay;
      this.winnerTeam = teams.size ? [...teams][0] : null;
      const winners = this.aliveList();
      for (const w of winners) {
        w.placement = 1;
        this.placements.push({
          id: w.id, name: w.name, place: 1, kills: w.kills,
          damage: Math.round(w.damageDealt), bot: w.isBot,
        });
      }
      if (this.onEnd) this.onEnd(this.results());
    }
  }

  results() {
    const sorted = this.placements.slice().sort((a, b) => a.place - b.place || b.kills - a.kills);
    return {
      winnerTeam: this.winnerTeam,
      winners: sorted.filter((p) => p.place === 1),
      placements: sorted,
      duration: Math.round(this.time),
    };
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  /** Construit l'etat vu par un joueur donne. */
  snapshotFor(p) {
    const eyeX = p.x, eyeZ = p.z;
    const r2v = AOI_RADIUS * AOI_RADIUS;
    const ps = [];
    for (const o of this.players.values()) {
      if (o.state === PSTATE.DEAD && o !== p) continue;
      const dx = o.x - eyeX, dz = o.z - eyeZ;
      const near = dx * dx + dz * dz <= r2v;
      const teammate = this.teamSize > 1 && o.team === p.team;
      if (!near && !teammate && o !== p) continue;
      ps.push(o.packPublic(true));
    }
    const vs = [];
    for (const v of this.vehicles.values()) {
      const dx = v.x - eyeX, dz = v.z - eyeZ;
      if (dx * dx + dz * dz <= r2v * 2.2) vs.push(v.serialize());
    }
    const prs = [];
    for (const pr of this.projectiles) {
      const dx = pr.x - eyeX, dz = pr.z - eyeZ;
      if (dx * dx + dz * dz <= r2v * 2.5) {
        prs.push({ i: pr.id, k: pr.kind, x: r1(pr.x), y: r1(pr.y), z: r1(pr.z) });
      }
    }
    const { chests, loot, drops } = this.loot.visible(eyeX, eyeZ, AOI_RADIUS * 0.85);

    return {
      t: Math.round(this.time * 1000),
      k: this.tick,
      ph: this.phase,
      me: p.packSelf(),
      ps, vs, ch: chests, lo: loot, dr: drops, pr: prs,
      st: this.storm.serialize(),
      al: this.aliveList().length,
      te: this.aliveTeams().size,
      ft: this.phase === 'flight' ? Math.round(this.flightT * 1000) / 1000 : null,
      fp: this.phase === 'flight'
        ? { fx: r1(this.flight.from.x), fz: r1(this.flight.from.z), tx: r1(this.flight.to.x), tz: r1(this.flight.to.z) }
        : null,
      ip: p.inPlane ? 1 : 0,
      sq: p.lastSeq,
    };
  }

  /** Evenements de ce tick qui concernent ce joueur. */
  eventsFor(p, sinceTick) {
    const out = [];
    for (const e of this.events) {
      if (e.k <= sinceTick) continue;
      if (e.x !== undefined && e.z !== undefined && e.e !== EV.KILL && e.e !== EV.STORM_PHASE && e.e !== EV.SUPPLY_DROP) {
        const dx = e.x - p.x, dz = e.z - p.z;
        if (dx * dx + dz * dz > (AOI_RADIUS * 1.4) ** 2) continue;
      }
      out.push(e);
      if (out.length >= MAX_EVENTS) break;
    }
    return out;
  }

  clearOldEvents() {
    if (this.events.length > MAX_EVENTS * 2) {
      this.events = this.events.filter((e) => e.k > this.tick - 4);
    }
  }

  /** Tableau des scores (envoye moins souvent). */
  scoreboard() {
    const rows = [];
    for (const p of this.players.values()) {
      rows.push({
        i: p.id, n: p.name, tm: p.team, k: p.kills, d: Math.round(p.damageDealt),
        a: p.alive ? 1 : 0, bot: p.isBot ? 1 : 0, pl: p.placement,
      });
    }
    rows.sort((a, b) => b.a - a.a || b.k - a.k);
    return rows;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.vehicleId) {
      const v = this.vehicles.get(p.vehicleId);
      if (v) { const i = v.seats.indexOf(id); if (i >= 0) v.seats[i] = null; }
    }
    if (p.state !== PSTATE.DEAD) {
      p.state = PSTATE.DEAD;
      p.placement = this.aliveList().length + 1;
      this.placements.push({ id: p.id, name: p.name, place: p.placement, kills: p.kills, damage: Math.round(p.damageDealt), bot: p.isBot });
    }
    this.brains.delete(id);
    this.players.delete(id);
  }

  /** Remplace un joueur deconnecte par un bot (le match continue proprement). */
  convertToBot(id, difficulty = 'biquette') {
    const p = this.players.get(id);
    if (!p || !p.alive) return false;
    p.isBot = true;
    p.conn = null;
    p.name = `${p.name} (IA)`;
    this.brains.set(id, new BotBrain(p, this, difficulty, this.rng.fork(id.length + 7)));
    return true;
  }
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

