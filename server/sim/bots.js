// Les chevres IA. Elles remplissent le salon quand il manque des joueurs, et prennent
// le relais d'un joueur qui se deconnecte.
//
// Pas de recherche de chemin globale : une chevre grimpe a peu pres partout, donc un
// pilotage « aller vers, contourner, sauter si ca bloque » suffit et coute tres peu.

import { BOT, GOAT, PSTATE, BTN } from '../../shared/constants.js';
import { ACT } from '../../shared/protocol.js';
import { clamp, angleDelta, wrapAngle } from '../../shared/math.js';
import { POIS } from '../../shared/mapdata.js';
import { trackSamples, nearestTrackPoint } from '../../shared/track.js';
import { WEAPONS, ITEMS, weaponScore } from '../../shared/loot.js';

const STATE = {
  DROP: 'drop', LOOT: 'loot', ROTATE: 'rotate', FIGHT: 'fight',
  HEAL: 'heal', FLEE: 'flee', DRIVE: 'drive',
};

const DIFF = {
  chevreau: { skill: 0, aimErr: 6.0, react: 0.55, fireMult: 1.0, range: 70, courage: 0.35 },
  biquette: { skill: 1, aimErr: 3.6, react: 0.38, fireMult: 0.85, range: 95, courage: 0.5 },
  bouc: { skill: 2, aimErr: 2.0, react: 0.26, fireMult: 0.7, range: 120, courage: 0.7 },
  bouquetin: { skill: 3, aimErr: 0.9, react: 0.16, fireMult: 0.55, range: 150, courage: 0.9 },
};

export class BotBrain {
  constructor(player, match, difficulty, rng) {
    this.p = player;
    this.m = match;
    this.rng = rng;
    this.cfg = DIFF[difficulty] || DIFF.biquette;
    this.difficulty = difficulty;

    this.state = STATE.DROP;
    this.target = null;         // {x, z} destination
    this.targetKind = null;     // 'chest' | 'loot' | 'zone' | 'vehicle'
    this.targetId = null;
    this.enemy = null;
    this.enemySeenAt = -99;
    this.reactTimer = 0;
    this.thinkTimer = rng.float(0, 0.2);
    this.aimYaw = player.yaw;
    this.aimPitch = 0;
    this.strafe = rng.bool() ? 1 : -1;
    this.strafeTimer = 0;
    this.stuckTimer = 0;
    this.lastX = player.x; this.lastZ = player.z;
    this.jumpTimer = 0;
    this.wp = -1;               // index de waypoint sur le circuit
    this.reverseTimer = 0;
    this.dropTarget = this.pickDropTarget();
    this.wantVehicle = rng.bool(0.55);
    this.chestHold = 0;
    this.emoteTimer = rng.float(20, 90);
    this.blacklist = new Map(); // cibles inatteignables (butin sur un toit, coffre dans un mur)
    this.lootDwell = 0;
    this.anchorX = player.x; this.anchorZ = player.z; this.anchorAt = 0;
    this.fightSince = 0; this.fightDamage = 0;
  }

  pickDropTarget() {
    // les meilleures chevres visent les zones riches
    const pool = POIS.filter((p) => p.kind !== 'water');
    const weights = pool.map((p) => ({
      p, weight: ({ low: 1, mid: 2, high: 3.4, 'very-high': 4.6 })[p.loot] ?? 2,
    }));
    const pick = this.rng.weighted(weights);
    const spot = this.landNear(pick.p.x, pick.p.z, pick.p.r * 0.7);
    return { x: spot.x, z: spot.z, name: pick.p.name };
  }

  /** Point terrestre tire au hasard autour de (cx,cz) : une chevre ne vise jamais la mer. */
  landNear(cx, cz, radius) {
    const terrain = this.m.world.terrain;
    for (let i = 0; i < 24; i++) {
      const [ox, oz] = this.rng.inDisk(radius);
      const x = clamp(cx + ox, -880, 880), z = clamp(cz + oz, -880, 880);
      if (terrain(x, z) > 1.5) return { x, z };
    }
    // repli : le centre s'il est sec, sinon le centre de l'ile
    if (terrain(cx, cz) > 1.5) return { x: cx, z: cz };
    return { x: 0, z: 80 };
  }

  /** Direction du rivage le plus proche quand on patauge. */
  findShore() {
    const p = this.p;
    const terrain = this.m.world.terrain;
    let best = null, bestD = Infinity;
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const sx = Math.sin(ang), sz = Math.cos(ang);
      for (let d = 8; d <= 220; d += 10) {
        const x = p.x + sx * d, z = p.z + sz * d;
        if (Math.abs(x) > 890 || Math.abs(z) > 890) break;
        if (terrain(x, z) > 1.2) {
          if (d < bestD) { bestD = d; best = { x, z }; }
          break;
        }
      }
    }
    // au large : on met le cap sur le centre de l'ile
    return best || { x: p.x * 0.6, z: 80 + (p.z - 80) * 0.6 };
  }

  // -------------------------------------------------------------------------

  think(dt) {
    const p = this.p;
    if (p.state === PSTATE.DEAD) { p.cmd.buttons = 0; return; }

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.15 + this.rng.float(0, 0.1);
      this.perceive();
      this.decide();
    }

    if (p.state === PSTATE.DOWNED) { p.cmd.buttons = 0; p.cmd.moveX = 0; p.cmd.moveY = 0; return; }

    if (!p.inPlane && !p.gliding && !p.vehicleId) this.watchProgress();

    if (p.inPlane) { this.actPlane(); return; }
    if (p.gliding) { this.actGlide(dt); return; }
    if (p.vehicleId) { this.actDrive(dt); return; }
    this.actOnFoot(dt);
  }

  /**
   * Filet de securite : une chevre coincee contre un rebord peut osciller indefiniment
   * (elle grimpe, retombe, regrimpe). Si elle n'a pas progresse en 12 s, on la depose
   * sur un point libre a cote.
   */
  watchProgress() {
    const p = this.p;
    const m = this.m;
    if (m.time - this.anchorAt < 12) return;
    const moved = Math.hypot(p.x - this.anchorX, p.z - this.anchorZ);
    this.anchorAt = m.time;
    this.anchorX = p.x; this.anchorZ = p.z;
    if (moved > 8 || this.state === STATE.HEAL) return;
    this.rescue();
  }

  rescue() {
    const p = this.p;
    const m = this.m;
    const terrain = m.world.terrain;
    for (let i = 0; i < 18; i++) {
      const a = this.rng.float(0, Math.PI * 2);
      const d = this.rng.float(6, 20);
      const x = clamp(p.x + Math.sin(a) * d, -880, 880);
      const z = clamp(p.z + Math.cos(a) * d, -880, 880);
      const y = terrain(x, z);
      if (y < 1.5) continue;
      if (!m.world.collision.isFree(x, z, y + 0.2, GOAT.height, GOAT.radius)) continue;
      p.x = x; p.y = y + 0.1; p.z = z;
      p.vx = p.vy = p.vz = 0;
      p.onGround = true;
      break;
    }
    if (this.targetKind === 'chest' || this.targetKind === 'loot') this.giveUpTarget();
    else { this.safeSpotAt = -99; this.safeSpot = null; }
    this.stuckTimer = 0;
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  perceive() {
    const p = this.p;
    const m = this.m;
    let best = null, bestScore = Infinity;
    const range = this.cfg.range;
    for (const o of m.players.values()) {
      if (o === p || !o.alive) continue;
      if (m.teamSize > 1 && o.team === p.team) continue;
      if (this.isBlacklisted(o.id)) continue;
      const dx = o.x - p.x, dz = o.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > range) continue;
      // champ de vision : large mais pas total, sauf si l'ennemi tire pres de nous
      const ang = Math.abs(angleDelta(p.yaw, Math.atan2(dx, dz)));
      const heard = d < BOT.hearRange && m.time - (o.lastShotAt ?? -99) < 1.5;
      if (ang > 1.5 && !heard && d > 12) continue;
      if (!m.world.collision.lineOfSight(p.x, p.eyeY, p.z, o.x, o.y + 0.9, o.z, { terrainStep: 1.6 })) continue;
      const score = d - (o.state === PSTATE.DOWNED ? 40 : 0);
      if (score < bestScore) { bestScore = score; best = o; }
    }
    if (best) {
      if (this.enemy !== best) {
        this.reactTimer = this.cfg.react * this.rng.float(0.8, 1.3);
        this.fightSince = this.m.time;
        this.fightDamage = this.p.damageDealt;
      }
      this.enemy = best;
      this.enemySeenAt = this.m.time;
      // duel qui n'aboutit pas (obstacle entre les deux) : on passe a autre chose
      if (this.m.time - this.fightSince > 18 && this.p.damageDealt - this.fightDamage < 1) {
        this.blacklist.set(best.id, this.m.time + 25);
        this.enemy = null;
        this.fightSince = this.m.time;
      }
    } else if (this.m.time - this.enemySeenAt > 3.5) {
      this.enemy = null;
    }
  }

  // -------------------------------------------------------------------------
  // Decision
  // -------------------------------------------------------------------------

  decide() {
    const p = this.p;
    const m = this.m;
    if (p.inPlane || p.gliding) { this.state = STATE.DROP; return; }

    const totalHp = p.health + p.shield;
    const outside = m.storm.outside(p.x, p.z);
    const distToSafe = Math.hypot(p.x - m.storm.cx, p.z - m.storm.cz) - m.storm.radius;
    const armed = !!p.weapon;

    // 0) sortir de l'eau : une chevre qui nage ne fait rien de bon
    if (p.swimming && !p.vehicleId) {
      const shore = this.findShore();
      if (shore) {
        this.state = STATE.ROTATE;
        this.target = shore;
        this.targetKind = 'zone';
        this.safeSpot = null;
        return;
      }
    }

    // 1) se soigner si on est au calme et amoche
    if (totalHp < 62 && !this.enemy && this.hasHealing() && !p.usingItem) {
      this.state = STATE.HEAL;
      this.useBestHealing();
      return;
    }

    // 2) la brume prime sur tout
    if (outside || distToSafe > -40) {
      this.state = STATE.ROTATE;
      this.pickSafeTarget();
      if (this.wantVehicle && !p.vehicleId && distToSafe > 60) this.seekVehicle();
      return;
    }

    // 3) combat — mais une chevre desarmee va chercher une arme plutot que de mourir bravement
    if (this.enemy) {
      const d = Math.hypot(this.enemy.x - p.x, this.enemy.z - p.z);
      const weak = totalHp < 38 && this.rng.bool(1 - this.cfg.courage);
      const dy = Math.abs(this.enemy.y - p.y);
      if (!armed && (d > 9 || dy > 6)) {
        const spot = this.findLootTarget(true);
        if (spot) { this.state = STATE.LOOT; return; }
        this.state = STATE.FLEE; this.pickFleeTarget(); return;
      }
      if (weak && d < 45) { this.state = STATE.FLEE; this.pickFleeTarget(); return; }
      this.state = STATE.FIGHT;
      return;
    }

    // 4) butin
    if (this.needsLoot()) {
      const spot = this.findLootTarget(!armed);
      if (spot) { this.state = STATE.LOOT; return; }
    }

    // 5) sinon on se rapproche du centre du cercle
    this.state = STATE.ROTATE;
    this.pickSafeTarget();
    // grande rotation : autant prendre une voiture
    if (this.wantVehicle && !p.vehicleId && this.target
      && Math.hypot(this.target.x - p.x, this.target.z - p.z) > 140) this.seekVehicle();
  }

  hasHealing() {
    return this.p.slots.some((s) => s && s.kind === 'item'
      && (ITEMS[s.id]?.kind === 'heal' || ITEMS[s.id]?.kind === 'shield' || ITEMS[s.id]?.kind === 'both'));
  }

  useBestHealing() {
    const p = this.p;
    let bestIdx = -1, bestVal = 0;
    for (let i = 0; i < p.slots.length; i++) {
      const s = p.slots[i];
      if (!s || s.kind !== 'item') continue;
      const def = ITEMS[s.id];
      if (!def) continue;
      let val = 0;
      if (def.kind === 'heal' && p.health < Math.min(def.capHealth, GOAT.maxHealth)) val = def.heal;
      else if (def.kind === 'shield' && p.shield < def.capShield) val = def.shield * 1.1;
      else if (def.kind === 'both') val = def.heal + def.shield;
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    if (bestIdx >= 0) p.startUseItem(bestIdx);
  }

  needsLoot() {
    const p = this.p;
    if (!p.weapon) return true;
    const filled = p.slots.filter(Boolean).length;
    if (filled < 4) return true;
    if (!this.hasHealing()) return true;
    const def = p.weaponDef;
    if (def && def.ammo && (p.ammo[def.ammo] ?? 0) < 12) return true;
    return false;
  }

  /** @param urgent cherche beaucoup plus loin (chevre desarmee) */
  findLootTarget(urgent = false) {
    const p = this.p;
    const m = this.m;
    const reach = urgent ? BOT.lootRadius * 2.4 : BOT.lootRadius;
    let best = null, bestD = reach * reach, kind = null, id = null;
    // un coffre garantit une arme : il vaut mieux que du butin au sol equidistant
    for (const c of m.loot.chests.values()) {
      if (c.opened || this.isBlacklisted(c.id)) continue;
      const dx = c.x - p.x, dz = c.z - p.z;
      const d = (dx * dx + dz * dz) * 0.55;
      if (d < bestD) { bestD = d; best = c; kind = 'chest'; id = c.id; }
    }
    for (const l of m.loot.loot.values()) {
      if (this.isBlacklisted(l.id) || !this.wantsLoot(l)) continue;
      const dx = l.x - p.x, dz = l.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = l; kind = 'loot'; id = l.id; }
    }
    if (!best) return null;
    // on garde une cible tant qu'elle est valable, pour eviter les allers-retours
    this.target = { x: best.x, z: best.z };
    this.targetKind = kind;
    this.targetId = id;
    return best;
  }

  isBlacklisted(id) {
    const until = this.blacklist.get(id);
    if (until === undefined) return false;
    if (this.m.time > until) { this.blacklist.delete(id); return false; }
    return true;
  }

  /** La cible est la, a portee de museau, et rien ne se passe : on l'oublie. */
  giveUpTarget() {
    if (this.targetId) this.blacklist.set(this.targetId, this.m.time + 75);
    this.target = null;
    this.targetKind = null;
    this.targetId = null;
    this.lootDwell = 0;
  }

  wantsLoot(l) {
    const p = this.p;
    if (l.type === 'ammo') {
      const def = p.weaponDef;
      return !def || !def.ammo || (p.ammo[l.itemId] ?? 0) < 90;
    }
    if (l.type === 'item') return p.firstEmptySlot() >= 0 || !this.hasHealing();
    // arme : seulement si meilleure que la pire qu'on a
    if (p.firstEmptySlot() >= 0) return true;
    const cand = weaponScore(l.itemId, l.rarity, 40);
    for (const s of p.slots) {
      if (s && s.kind === 'weapon' && weaponScore(s.id, s.rarity, 40) < cand * 0.85) return true;
    }
    return false;
  }

  pickSafeTarget() {
    const m = this.m;
    const p = this.p;
    const r = Math.max(6, m.storm.radius * 0.55);
    if (!this.safeSpot || m.time - (this.safeSpotAt || -99) > 10
      || Math.hypot(p.x - this.safeSpot.x, p.z - this.safeSpot.z) < 22) {
      this.safeSpot = this.landNear(m.storm.cx, m.storm.cz, r);
      this.safeSpotAt = m.time;
    }
    this.target = this.safeSpot;
    this.targetKind = 'zone';
  }

  pickFleeTarget() {
    const p = this.p;
    const e = this.enemy;
    if (!e) return;
    const away = Math.atan2(p.x - e.x, p.z - e.z);
    this.target = { x: p.x + Math.sin(away) * 45, z: p.z + Math.cos(away) * 45 };
    this.targetKind = 'zone';
  }

  seekVehicle() {
    const p = this.p;
    let best = null, bestD = 120 * 120;
    for (const v of this.m.vehicles.values()) {
      if (v.destroyed || v.freeSeat() < 0) continue;
      if (v.T.aquatic) continue;
      const dx = v.x - p.x, dz = v.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best) {
      this.target = { x: best.x, z: best.z };
      this.targetKind = 'vehicle';
      this.targetId = best.id;
    }
  }

  // -------------------------------------------------------------------------
  // Actions : largage
  // -------------------------------------------------------------------------

  actPlane() {
    const p = this.p;
    const t = this.dropTarget;
    const d = Math.hypot(t.x - p.x, t.z - p.z);
    p.cmd.yaw = Math.atan2(t.x - p.x, t.z - p.z);
    p.cmd.pitch = -0.5;
    p.cmd.moveX = 0; p.cmd.moveY = 0; p.cmd.buttons = 0;
    // On saute au point le plus proche de la cible : sauter des qu'elle est
    // theoriquement atteignable fait atterrir la moitie du troupeau dans la mer.
    const closing = d < (this.lastPlaneDist ?? Infinity) - 0.05;
    this.lastPlaneDist = d;
    const glideReach = 330; // portee reelle chute libre + parapente
    if ((!closing && d < glideReach) || d < 90 || this.m.flightT > 0.9) {
      this.m.applyAction(p.id, { a: ACT.JUMP_OUT });
    }
  }

  actGlide(dt) {
    const p = this.p;
    const t = this.dropTarget;
    const yaw = Math.atan2(t.x - p.x, t.z - p.z);
    p.cmd.yaw = yaw;
    p.cmd.pitch = -0.6;
    const d = Math.hypot(t.x - p.x, t.z - p.z);
    p.cmd.moveY = d > 14 ? 1 : 0;
    p.cmd.moveX = 0;
    p.cmd.buttons = 0;
    void dt;
  }

  // -------------------------------------------------------------------------
  // Actions : a pied
  // -------------------------------------------------------------------------

  actOnFoot(dt) {
    const p = this.p;
    const m = this.m;
    let buttons = 0;
    let moveY = 0, moveX = 0;

    // --- visee ---
    if (this.enemy && this.enemy.alive) {
      this.aimAt(this.enemy, dt);
      p.cmd.yaw = this.aimYaw;
      p.cmd.pitch = this.aimPitch;
    } else if (this.target) {
      const want = Math.atan2(this.target.x - p.x, this.target.z - p.z);
      p.cmd.yaw = wrapAngle(p.cmd.yaw + angleDelta(p.cmd.yaw, want) * clamp(dt * 6, 0, 1));
      p.cmd.pitch += (0 - p.cmd.pitch) * clamp(dt * 3, 0, 1);
    }

    // --- deplacement ---
    switch (this.state) {
      case STATE.FIGHT: {
        const e = this.enemy;
        if (e) {
          const d = Math.hypot(e.x - p.x, e.z - p.z);
          const dy = Math.abs(e.y - p.y);
          const def = p.weaponDef;
          // desarmee, elle charge au corps a corps ; armee, elle tient sa distance utile
          const ideal = def ? clamp(def.range * 0.35, 8, 55) : 1.4;
          if (d > ideal * 1.25) { moveY = 1; buttons |= BTN.SPRINT; }
          else if (def && d < ideal * 0.55) moveY = -0.8;
          // pas chasse pour ne pas etre une cible fixe
          this.strafeTimer -= dt;
          if (this.strafeTimer <= 0) { this.strafe = -this.strafe; this.strafeTimer = this.rng.float(0.7, 1.9); }
          moveX = this.strafe * (0.55 + this.cfg.skill * 0.12);
          if (d < GOAT.headbuttRange && dy < 2.2 && (!def || p.reloading || d < 1.9)) buttons |= BTN.MELEE;
          if (this.cfg.skill >= 2 && this.rng.bool(0.02)) buttons |= BTN.JUMP;
          // une crotte explosive bien placee, de temps en temps
          this.nadeTimer = (this.nadeTimer || 0) - dt;
          if (this.cfg.skill >= 1 && d > 12 && d < 34 && this.nadeTimer <= 0
            && p.slots.some((s) => s && s.kind === 'item' && s.id === 'grenade')
            && this.rng.bool(0.35)) {
            this.nadeTimer = this.rng.float(6, 14);
            m.applyAction(p.id, { a: ACT.THROW, charge: clamp(d / 34, 0.35, 1) });
          }
        }
        break;
      }
      case STATE.HEAL:
        moveY = 0;
        buttons |= BTN.CROUCH;
        break;
      case STATE.LOOT:
      case STATE.ROTATE:
      case STATE.FLEE:
      default: {
        if (this.target) {
          const d = Math.hypot(this.target.x - p.x, this.target.z - p.z);
          if (d > 1.6) { moveY = 1; buttons |= BTN.SPRINT; }
          else moveY = 0;
        }
        break;
      }
    }

    // --- interactions ---
    if (this.state === STATE.LOOT && this.target) {
      const d = Math.hypot(this.target.x - p.x, this.target.z - p.z);
      // on est dessus mais rien ne vient : la cible est hors d'atteinte (toit, corniche)
      if (d < 4) {
        this.lootDwell += dt;
        if (this.lootDwell > 5) { this.giveUpTarget(); return this.finishFrame(moveX, moveY, buttons); }
      } else this.lootDwell = Math.max(0, this.lootDwell - dt);
      if (d < 2.4) {
        if (this.targetKind === 'chest') {
          buttons |= BTN.USE; // maintenu : ca ouvre le coffre
        } else {
          this.chestHold -= dt;
          if (this.chestHold <= 0) { m.applyAction(p.id, { a: ACT.USE }); this.chestHold = 0.25; }
        }
      }
    }
    if (this.targetKind === 'vehicle' && this.target
      && Math.hypot(this.target.x - p.x, this.target.z - p.z) < 3.0) {
      m.applyAction(p.id, { a: ACT.ENTER_VEHICLE });
      this.targetKind = null;
      this.target = null;
      // sinon la destination reste la voiture elle-meme, et la chevre en redescend aussitot
      if (p.vehicleId) { this.safeSpot = null; this.safeSpotAt = -99; this.pickSafeTarget(); }
    }

    // --- arme : choisir la meilleure, recharger, tirer ---
    this.manageWeapon(dt);
    if (this.state === STATE.FIGHT && this.enemy) {
      this.reactTimer -= dt;
      const def = p.weaponDef;
      if (this.reactTimer <= 0 && def) {
        const d = Math.hypot(this.enemy.x - p.x, this.enemy.z - p.z);
        const aimOk = Math.abs(angleDelta(p.cmd.yaw, Math.atan2(this.enemy.x - p.x, this.enemy.z - p.z))) < 0.22;
        if (aimOk && d <= def.range) {
          buttons |= BTN.FIRE;
          if (def.scope || def.spread[1] < 1) buttons |= BTN.AIM;
        }
      }
    }
    if (p.reloading) buttons &= ~BTN.FIRE;

    // --- desenclavement ---
    this.avoidAndUnstick(dt, () => { buttons |= BTN.JUMP; });

    // --- emote de temps en temps, pour la vie ---
    this.emoteTimer -= dt;
    if (this.emoteTimer <= 0) {
      this.emoteTimer = this.rng.float(40, 140);
      if (!this.enemy) m.applyAction(p.id, { a: ACT.EMOTE, id: this.rng.int(0, 3) });
    }

    return this.finishFrame(moveX, moveY, buttons);
  }

  finishFrame(moveX, moveY, buttons) {
    const p = this.p;
    p.cmd.moveX = clamp(moveX + (this.avoidX || 0), -1, 1);
    p.cmd.moveY = clamp(moveY, -1, 1);
    p.cmd.buttons = buttons | (this.forceJump ? BTN.JUMP : 0);
    this.forceJump = false;
  }

  aimAt(e, dt) {
    const p = this.p;
    const def = p.weaponDef;
    const dx = e.x - p.x, dz = e.z - p.z;
    const dist = Math.hypot(dx, dz);
    // anticipation du deplacement de la cible
    const speed = def?.bulletSpeed || 400;
    const lead = clamp(dist / speed, 0, 0.5) * (0.4 + this.cfg.skill * 0.2);
    const tx = e.x + e.vx * lead, tz = e.z + e.vz * lead;
    const ty = e.y + 0.85 + e.vy * lead * 0.5;

    const wantYaw = Math.atan2(tx - p.x, tz - p.z);
    const wantPitch = Math.atan2(ty - p.eyeY, Math.hypot(tx - p.x, tz - p.z));

    // erreur de visee : bruit lent, plus faible quand on garde la cible longtemps
    const held = clamp(this.m.time - this.enemySeenAt + 1, 0, 2.5);
    const err = (this.cfg.aimErr * Math.PI / 180) / (1 + held * 0.6);
    this.aimNoiseT = (this.aimNoiseT || 0) + dt;
    const nx = Math.sin(this.aimNoiseT * 1.7 + this.strafe) * err;
    const ny = Math.cos(this.aimNoiseT * 2.3) * err * 0.6;

    const turn = clamp(dt * (5 + this.cfg.skill * 3), 0, 1);
    this.aimYaw = wrapAngle(this.aimYaw + angleDelta(this.aimYaw, wantYaw + nx) * turn);
    this.aimPitch = clamp(this.aimPitch + (wantPitch + ny - this.aimPitch) * turn, -1.4, 1.4);
  }

  manageWeapon(dt) {
    const p = this.p;
    if (p.reloading || p.usingItem) return;
    const dist = this.enemy ? Math.hypot(this.enemy.x - p.x, this.enemy.z - p.z) : 30;
    let bestIdx = -1, bestVal = -1;
    for (let i = 0; i < p.slots.length; i++) {
      const s = p.slots[i];
      if (!s || s.kind !== 'weapon') continue;
      const def = WEAPONS[s.id];
      const hasAmmo = !def.ammo || s.mag > 0 || (p.ammo[def.ammo] ?? 0) > 0;
      if (!hasAmmo) continue;
      const val = weaponScore(s.id, s.rarity, dist);
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestIdx !== p.activeSlot) p.switchSlot(bestIdx);
    const w = p.weapon;
    if (w) {
      const def = WEAPONS[w.id];
      if (def.magazine > 0 && w.mag <= 0) p.startReload();
      else if (!this.enemy && def.magazine > 0 && w.mag < def.magazine * 0.4) p.startReload();
    }
    void dt;
  }

  /** Contournement d'obstacle et deblocage. */
  avoidAndUnstick(dt, jump) {
    const p = this.p;
    const world = this.m.world.collision;
    this.avoidX = 0;

    const moved = Math.hypot(p.x - this.lastX, p.z - this.lastZ);
    this.lastX = p.x; this.lastZ = p.z;
    if (moved < 0.06 && (p.cmd.moveY !== 0 || this.state !== STATE.HEAL)) this.stuckTimer += dt;
    else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);

    const fx = Math.sin(p.cmd.yaw), fz = Math.cos(p.cmd.yaw);
    const eye = p.y + 0.7;
    const ahead = world.raycast(p.x, eye, p.z, fx, 0, fz, 3.0, { terrainStep: 0.8 });
    if (ahead) {
      // essayer a gauche puis a droite
      const rx = Math.cos(p.cmd.yaw), rz = -Math.sin(p.cmd.yaw);
      const left = world.raycast(p.x - rx * 1.2, eye, p.z - rz * 1.2, fx, 0, fz, 3.0, { terrainStep: 0.8 });
      const right = world.raycast(p.x + rx * 1.2, eye, p.z + rz * 1.2, fx, 0, fz, 3.0, { terrainStep: 0.8 });
      if (!left) this.avoidX = -0.85;
      else if (!right) this.avoidX = 0.85;
      else { this.avoidX = this.strafe * 0.85; jump(); this.forceJump = true; }
    }

    if (this.stuckTimer > 0.8) {
      this.forceJump = true;
      this.avoidX = this.strafe * 1;
      if (this.stuckTimer > 2.2) {
        this.strafe = -this.strafe;
        this.stuckTimer = 0;
        // cible manifestement inatteignable : on en change
        if (this.targetKind === 'chest' || this.targetKind === 'loot') this.giveUpTarget();
        else this.safeSpotAt = -99;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Actions : au volant
  // -------------------------------------------------------------------------

  actDrive(dt) {
    const p = this.p;
    const v = this.m.vehicles.get(p.vehicleId);
    if (!v) return;
    if (p.seat !== 0) {
      // passager : il tire
      p.cmd.moveX = 0; p.cmd.moveY = 0;
      let b = 0;
      if (this.enemy) {
        this.aimAt(this.enemy, dt);
        p.cmd.yaw = this.aimYaw; p.cmd.pitch = this.aimPitch;
        this.reactTimer -= dt;
        if (this.reactTimer <= 0 && p.weaponDef) b |= BTN.FIRE;
      }
      p.cmd.buttons = b;
      return;
    }

    // --- pilote ---
    const target = this.target || this.safeSpot;
    if (!target) { p.cmd.moveY = 0; p.cmd.moveX = 0; p.cmd.buttons = 0; return; }

    const distToTarget = Math.hypot(target.x - v.x, target.z - v.z);
    // on ne descend qu'une fois arrive (et pas dans la seconde qui suit la montee)
    this.driveTime = (this.driveTime || 0) + dt;
    if (this.driveTime > 1.5
      && (distToTarget < 14 || (this.enemy && Math.hypot(this.enemy.x - v.x, this.enemy.z - v.z) < 26))) {
      this.m.applyAction(p.id, { a: ACT.EXIT_VEHICLE });
      this.driveTime = 0;
      return;
    }

    // Sur le circuit on suit les waypoints dans l'ordre : la recherche du point le plus
    // proche accroche le mauvais brin dans les epingles et envoie la voiture dans le rail.
    const onTrack = nearestTrackPoint(v.x, v.z, 26);
    const useTrack = onTrack.dist !== Infinity && onTrack.dist < onTrack.width * 0.6
      && this.trackHelps(target, onTrack);

    let steer = 0, throttle = 1;
    if (useTrack) {
      const ss = trackSamples();
      if (this.wp < 0) this.wp = onTrack.index;
      for (let k = 0; k < 40; k++) {
        const s = ss[this.wp % ss.length];
        const ahead = (s.x - v.x) * Math.sin(v.yaw) + (s.z - v.z) * Math.cos(v.yaw);
        if (ahead < 5 || Math.hypot(s.x - v.x, s.z - v.z) < 9) this.wp++;
        else break;
      }
      const lead = Math.round(2 + Math.abs(v.speed) * 0.45);
      const tgt = ss[(this.wp + lead) % ss.length];
      steer = clamp(angleDelta(v.yaw, Math.atan2(tgt.x - v.x, tgt.z - v.z)) * 2.4, -1, 1);
      const a = ss[(this.wp + 5) % ss.length];
      const b = ss[(this.wp + 22) % ss.length];
      const curve = Math.abs(angleDelta(Math.atan2(a.tx, a.tz), Math.atan2(b.x - a.x, b.z - a.z)));
      const want = clamp(v.T.maxSpeed * (1 - curve * 1.5), 9, v.T.maxSpeed * 0.92);
      throttle = v.speed < want ? 1 : (v.speed > want * 1.12 ? -1 : 0.2);
    } else {
      this.wp = -1;
      steer = clamp(angleDelta(v.yaw, Math.atan2(target.x - v.x, target.z - v.z)) * 2.2, -1, 1);
      const want = clamp(v.T.maxSpeed * (1 - Math.abs(steer) * 0.55), 7, v.T.maxSpeed * 0.8);
      throttle = v.speed < want ? 1 : -0.4;
      // obstacle droit devant : on ralentit
      const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
      const look = 4 + Math.abs(v.speed) * 0.9;
      const hit = this.m.world.collision.raycast(v.x, v.y + 0.8, v.z, fx, 0, fz, look, { terrainStep: 1.2 });
      if (hit) { throttle = -0.6; steer = clamp(steer + this.strafe * 0.7, -1, 1); }
    }

    // deblocage : marche arriere
    if (Math.abs(v.speed) < 1.2 && !v.T.aquatic) {
      this.reverseTimer += dt;
      if (this.reverseTimer > 0.9) { throttle = -1; steer = -steer; }
      if (this.reverseTimer > 3.2) { this.reverseTimer = 0; this.wp = -1; }
    } else this.reverseTimer = 0;

    p.cmd.moveY = throttle;
    p.cmd.moveX = steer;
    p.cmd.yaw = v.yaw;
    p.cmd.pitch = 0;
    p.cmd.buttons = 0;
    if (this.rng.bool(0.004)) p.cmd.buttons |= BTN.HORN;
  }

  /** Le circuit va-t-il globalement dans la bonne direction ? */
  trackHelps(target, np) {
    const dx = target.x - np.x, dz = target.z - np.z;
    const l = Math.hypot(dx, dz) || 1;
    const dot = (dx / l) * np.tx + (dz / l) * np.tz;
    return dot > 0.15;
  }
}

export { STATE, DIFF };
