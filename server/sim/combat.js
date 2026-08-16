// Tir, degats, projectiles et explosions.

import {
  GOAT, PSTATE, HEADSHOT_MULT, LIMB_MULT, GRAVITY, SEA_LEVEL, VEHICLE_DAMAGE,
} from '../../shared/constants.js';
import { raySphere, clamp, norm3 } from '../../shared/math.js';
import {
  WEAPONS, weaponDamage, damageFalloff, RARITY,
} from '../../shared/loot.js';

// Volumes de la chevre, relatifs a la base des sabots.
const HITBOXES = [
  { part: 'head', dy: 1.30, r: 0.34, mult: HEADSHOT_MULT },
  { part: 'body', dy: 0.82, r: 0.50, mult: 1.0 },
  { part: 'legs', dy: 0.30, r: 0.38, mult: LIMB_MULT },
];
const CROUCH_SCALE = 0.62;

/**
 * Lancer de rayon contre le decor, les joueurs et les vehicules.
 * @param match  la partie (pour ses listes)
 * @param shooter joueur tireur (peut etre null)
 * @param rewind  secondes de compensation de latence
 * @returns {{t, x, y, z, kind:'player'|'vehicle'|'world', player?, vehicle?, part?, mult?, normal?, surface?}|null}
 */
export function traceShot(match, shooter, ox, oy, oz, dx, dy, dz, maxDist, rewind = 0) {
  const world = match.world.collision;
  let best = maxDist;
  let result = null;

  const wall = world.raycast(ox, oy, oz, dx, dy, dz, maxDist, { terrainStep: 1.6 });
  if (wall) {
    best = wall.t;
    result = {
      t: wall.t, x: wall.x, y: wall.y, z: wall.z, kind: 'world',
      normal: [wall.nx, wall.ny, wall.nz],
      surface: wall.terrain ? match.world.surfaceAt(wall.x, wall.z) : (wall.collider?.surface ?? 2),
    };
  }

  const now = match.time;
  for (const p of match.players.values()) {
    if (p === shooter) continue;
    if (!p.alive) continue;
    if (p.vehicleId) continue; // touche par la caisse du vehicule, pas par la hitbox
    const pos = rewind > 0 ? p.positionAt(now, rewind) : p;
    // rejet rapide : distance du centre a la droite
    const cx = pos.x - ox, cy = pos.y + 0.8 - oy, cz = pos.z - oz;
    const along = cx * dx + cy * dy + cz * dz;
    if (along < -1 || along > best + 1.2) continue;
    const perp2 = (cx * cx + cy * cy + cz * cz) - along * along;
    if (perp2 > 2.6) continue;

    const scale = pos.crouch ? CROUCH_SCALE : 1;
    for (const hb of HITBOXES) {
      const t = raySphere(ox, oy, oz, dx, dy, dz, pos.x, pos.y + hb.dy * scale, pos.z, hb.r);
      if (t >= 0 && t < best) {
        best = t;
        result = {
          t, x: ox + dx * t, y: oy + dy * t, z: oz + dz * t,
          kind: 'player', player: p, part: hb.part, mult: hb.mult,
        };
      }
    }
  }

  for (const v of match.vehicles.values()) {
    if (v.destroyed) continue;
    const box = v.box();
    const cx = box.x - ox, cy = box.y - oy, cz = box.z - oz;
    const along = cx * dx + cy * dy + cz * dz;
    if (along < -4 || along > best + 5) continue;
    const hit = rayBoxQuick(ox, oy, oz, dx, dy, dz, box);
    if (hit !== null && hit < best) {
      best = hit;
      result = {
        t: hit, x: ox + dx * hit, y: oy + dy * hit, z: oz + dz * hit,
        kind: 'vehicle', vehicle: v, normal: [0, 1, 0], surface: 7,
      };
    }
  }

  return result;
}

function rayBoxQuick(ox, oy, oz, dx, dy, dz, b) {
  const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw);
  const rx = ox - b.x, ry = oy - b.y, rz = oz - b.z;
  const lox = rx * c + rz * s, loz = -rx * s + rz * c;
  const ldx = dx * c + dz * s, ldz = -dx * s + dz * c;
  const o = [lox, ry, loz], d = [ldx, dy, ldz], h = [b.hx, b.hy, b.hz];
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) { if (o[i] < -h[i] || o[i] > h[i]) return null; continue; }
    const inv = 1 / d[i];
    let t1 = (-h[i] - o[i]) * inv, t2 = (h[i] - o[i]) * inv;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  const t = tmin < 0 ? tmax : tmin;
  return t < 0 ? null : t;
}

/** Applique la dispersion a une direction. */
export function applySpread(dx, dy, dz, spreadDeg, rng) {
  if (spreadDeg <= 0) return [dx, dy, dz];
  const rad = spreadDeg * Math.PI / 180;
  // base orthonormee autour de la direction
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(dy) > 0.95) { ux = 1; uy = 0; }
  let rxx = uy * dz - uz * dy, ryy = uz * dx - ux * dz, rzz = ux * dy - uy * dx;
  const rl = Math.hypot(rxx, ryy, rzz) || 1;
  rxx /= rl; ryy /= rl; rzz /= rl;
  const sxx = dy * rzz - dz * ryy, syy = dz * rxx - dx * rzz, szz = dx * ryy - dy * rxx;
  const a = rng.next() * Math.PI * 2;
  const r = Math.sqrt(rng.next()) * rad;
  const cx = Math.cos(a) * r, cy = Math.sin(a) * r;
  return norm3(dx + rxx * cx + sxx * cy, dy + ryy * cx + syy * cy, dz + rzz * cx + szz * cy);
}

/** Degats finaux d'une balle. */
export function bulletDamage(weaponId, rarity, distance, partMult) {
  const base = weaponDamage(weaponId, rarity);
  const def = WEAPONS[weaponId];
  let mult = partMult;
  if (mult > 1 && def.headshotMult) mult = def.headshotMult;
  if (mult > 1 && !def.headshot) mult = 1;
  return base * damageFalloff(weaponId, distance) * mult;
}

// ---------------------------------------------------------------------------
// Projectiles (roquettes, grenades)
// ---------------------------------------------------------------------------

let _pid = 0;

export function createProjectile(kind, owner, x, y, z, dx, dy, dz, opts = {}) {
  return {
    id: `x${++_pid}`,
    kind,
    ownerId: owner ? owner.id : null,
    team: owner ? owner.team : -1,
    x, y, z,
    vx: dx * opts.speed, vy: dy * opts.speed, vz: dz * opts.speed,
    gravity: opts.gravity ?? 0,
    bounce: opts.bounce ?? 0,
    fuse: opts.fuse ?? 8,
    radius: opts.radius ?? 6,
    damage: opts.damage ?? 80,
    weaponId: opts.weaponId || null,
    life: 0,
    exploded: false,
  };
}

/**
 * Avance un projectile. Renvoie true s'il doit exploser.
 */
export function stepProjectile(pr, match, dt) {
  const world = match.world.collision;
  pr.life += dt;
  pr.fuse -= dt;
  pr.vy -= pr.gravity * dt;

  const speed = Math.hypot(pr.vx, pr.vy, pr.vz);
  const dist = speed * dt;
  if (dist > 1e-4) {
    const dx = pr.vx / speed, dy = pr.vy / speed, dz = pr.vz / speed;
    const hit = traceShot(match, null, pr.x, pr.y, pr.z, dx, dy, dz, dist, 0);
    const skipOwner = hit && hit.kind === 'player' && hit.player.id === pr.ownerId && pr.life < 0.15;
    if (hit && !skipOwner) {
      if (pr.bounce > 0 && hit.kind === 'world' && hit.normal) {
        // rebond amorti (grenade)
        const [nx, ny, nz] = hit.normal;
        const dot = pr.vx * nx + pr.vy * ny + pr.vz * nz;
        pr.vx = (pr.vx - 2 * dot * nx) * pr.bounce;
        pr.vy = (pr.vy - 2 * dot * ny) * pr.bounce;
        pr.vz = (pr.vz - 2 * dot * nz) * pr.bounce;
        pr.x = hit.x + nx * 0.12;
        pr.y = hit.y + ny * 0.12;
        pr.z = hit.z + nz * 0.12;
        if (Math.hypot(pr.vx, pr.vy, pr.vz) < 1.2) { pr.vx = pr.vy = pr.vz = 0; pr.gravity = 0; }
        return pr.fuse <= 0;
      }
      pr.x = hit.x; pr.y = hit.y; pr.z = hit.z;
      pr.directHit = hit;
      return true;
    }
  }

  pr.x += pr.vx * dt;
  pr.y += pr.vy * dt;
  pr.z += pr.vz * dt;

  if (pr.y < SEA_LEVEL - 1.5) return true;
  if (Math.abs(pr.x) > 900 || Math.abs(pr.z) > 900) return true;
  return pr.fuse <= 0;
}

/**
 * Explosion : degats aux joueurs et vehicules, avec attenuation radiale
 * et verification de la ligne de vue.
 * @returns {Array<{player, damage}>}
 */
export function explode(match, x, y, z, radius, damage, ownerId, opts = {}) {
  const out = [];
  const world = match.world.collision;
  for (const p of match.players.values()) {
    if (!p.alive) continue;
    const px = p.x, py = p.y + 0.8, pz = p.z;
    const d = Math.hypot(px - x, py - y, pz - z);
    if (d > radius) continue;
    // un mur protege partiellement
    const blocked = !world.lineOfSight(x, y, z, px, py, pz, { terrainStep: 1.2 });
    const falloff = 1 - (d / radius) * (d / radius) * 0.85;
    let dmg = damage * falloff * (blocked ? 0.35 : 1);
    if (p.id === ownerId) dmg *= opts.selfMult ?? 0.55;
    if (dmg <= 0.5) continue;
    out.push({ player: p, damage: dmg, distance: d });
    // souffle
    const l = d || 1;
    const push = (1 - d / radius) * (opts.knockback ?? 13);
    p.vx += ((px - x) / l) * push;
    p.vz += ((pz - z) / l) * push;
    p.vy += Math.max(2, ((py - y) / l) * push * 0.8);
    p.onGround = false;
  }
  for (const v of match.vehicles.values()) {
    if (v.destroyed) continue;
    const d = Math.hypot(v.x - x, v.y + 0.6 - y, v.z - z);
    if (d > radius * 1.4) continue;
    v.damage(damage * (1 - d / (radius * 1.4)) * 1.6, ownerId, match);
  }
  return out;
}

/** Degats infliges par un choc de vehicule. */
export function ramDamage(speed, mult) {
  const over = Math.abs(speed) - VEHICLE_DAMAGE.minSpeed;
  if (over <= 0) return 0;
  return Math.min(VEHICLE_DAMAGE.maxPerHit, over * VEHICLE_DAMAGE.perSpeed * mult);
}

/** Degats de chute pour une chevre. */
export function fallDamage(landSpeed) {
  const over = landSpeed - 17;
  return over > 0 ? over * 5.5 : 0;
}

export { RARITY, clamp, GOAT, PSTATE, GRAVITY };
