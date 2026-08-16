// Physique partagee : le serveur fait autorite, le client rejoue EXACTEMENT le meme code
// pour predire ses propres deplacements. Toute divergence ici = « rubber banding ».
//
// Ces fonctions mutent l'etat passe en argument et n'allouent rien.

import { GOAT, GRAVITY, SEA_LEVEL, ANIM, BTN, VEHICLE_TYPES } from './constants.js';
import { clamp, wrapAngle, damp, lerp, angleDelta } from './math.js';

const DEEP_WATER = 1.35; // profondeur a partir de laquelle on nage

/**
 * Un pas de simulation pour une chevre a pied.
 * @param p   etat mutable {x,y,z,vx,vy,vz,onGround,jumps,climbing,swimming,coyote,anim,speed}
 * @param cmd {moveX,moveY,yaw,pitch,buttons}
 * @param ctx {world:CollisionWorld, terrain:(x,z)=>number}
 * @param dt  pas de temps (s)
 */
export function stepGoat(p, cmd, ctx, dt) {
  const world = ctx.world;
  const cfg = GOAT;

  const sprint = (cmd.buttons & BTN.SPRINT) !== 0;
  const crouch = (cmd.buttons & BTN.CROUCH) !== 0;
  const wantJump = (cmd.buttons & BTN.JUMP) !== 0;

  // --- direction souhaitee, dans le repere de la camera ---
  // avant = (sin(yaw), cos(yaw)) ; droite = (cos(yaw), -sin(yaw))
  let wx = cmd.moveY * Math.sin(cmd.yaw) + cmd.moveX * Math.cos(cmd.yaw);
  let wz = cmd.moveY * Math.cos(cmd.yaw) - cmd.moveX * Math.sin(cmd.yaw);
  const wl = Math.hypot(wx, wz);
  if (wl > 1) { wx /= wl; wz /= wl; }
  const wishLen = Math.min(wl, 1);

  // --- milieu : eau ? ---
  const groundY = ctx.terrain(p.x, p.z);
  const submerged = p.y < SEA_LEVEL - 0.35 && groundY < SEA_LEVEL - 0.2;
  p.swimming = submerged && (SEA_LEVEL - groundY) > DEEP_WATER;

  // --- vitesse cible ---
  let target;
  if (p.swimming) target = 4.4;
  else if (crouch && p.onGround) target = cfg.crouchSpeed;
  else if (sprint && wishLen > 0.1) target = cfg.sprintSpeed;
  else target = cfg.walkSpeed;
  if (ctx.speedMult) target *= ctx.speedMult;

  // --- acceleration horizontale ---
  const control = p.onGround || p.swimming ? 1 : cfg.airControl;
  const accel = cfg.accel * control;
  if (wishLen > 0.01) {
    const tvx = wx * target, tvz = wz * target;
    p.vx += clamp(tvx - p.vx, -accel * dt, accel * dt);
    p.vz += clamp(tvz - p.vz, -accel * dt, accel * dt);
  } else if (p.onGround || p.swimming) {
    const f = Math.exp(-cfg.friction * dt);
    p.vx *= f; p.vz *= f;
  }

  // --- vertical ---
  if (p.swimming) {
    // flottaison : on remonte doucement vers la surface, l'espace fait nager vers le haut
    const surface = SEA_LEVEL - 0.6;
    const buoy = (surface - p.y) * 6;
    p.vy = damp(p.vy, clamp(buoy, -3, 3) + (wantJump ? 3.4 : 0), 6, dt);
    p.jumps = 0;
    p.climbing = false;
  } else {
    p.vy -= GRAVITY * dt;
    if (p.vy < -75) p.vy = -75;
  }

  // --- saut / double saut (une chevre saute deux fois) ---
  if (wantJump && !p.jumpHeld && !p.swimming) {
    if (p.onGround || p.coyote > 0) {
      p.vy = cfg.jumpSpeed;
      p.jumps = 1;
      p.onGround = false;
      p.coyote = 0;
    } else if (p.jumps < 2) {
      p.vy = cfg.doubleJumpSpeed;
      p.jumps = 2;
    }
  }
  p.jumpHeld = wantJump;

  // --- integration + collisions ---
  const feetBefore = p.y;
  let nx = p.x + p.vx * dt;
  let nz = p.z + p.vz * dt;

  const pushed = world.pushOut(nx, nz, p.y, cfg.height, cfg.radius);
  const blocked = pushed.hit;
  if (blocked) {
    // on annule la composante de vitesse qui rentre dans le mur
    const dot = p.vx * pushed.nx + p.vz * pushed.nz;
    if (dot < 0) { p.vx -= pushed.nx * dot; p.vz -= pushed.nz * dot; }
    nx = pushed.x; nz = pushed.z;
  }

  // --- escalade : specialite chevre. Contre un mur + saut maintenu => on monte. ---
  p.climbing = false;
  if (!p.swimming && blocked && wishLen > 0.35 && wantJump && p.vy < cfg.climbSpeed) {
    const into = -(wx * pushed.nx + wz * pushed.nz); // on pousse bien vers le mur
    if (into > 0.35) {
      p.vy = cfg.climbSpeed;
      p.climbing = true;
      p.jumps = 1;
    }
  }

  let ny = p.y + p.vy * dt;

  // --- sol ---
  // en chute rapide on peut franchir plusieurs metres en un tick : on elargit la fenetre de
  // recherche a toute la distance parcourue, sinon on traverse le pont d'un yacht.
  const fallDist = Math.max(0, feetBefore - ny);
  const stepUp = p.vy <= 0.01 ? Math.max(0.75, fallDist + 0.1) : 0.05;
  const g = world.ground(nx, nz, ny, cfg.radius, stepUp);
  const supportY = g.y;

  if (ny <= supportY + 0.001 && p.vy <= 0.5) {
    ny = supportY;
    if (!p.onGround) p.landSpeed = -p.vy; // pour les degats de chute
    p.vy = 0;
    p.onGround = true;
    p.jumps = 0;
    p.coyote = 0.12;
    p.surface = g.surface;
  } else {
    p.onGround = false;
    p.coyote = Math.max(0, (p.coyote || 0) - dt);
    // plafond
    const ceil = world.ceiling(nx, nz, p.y + cfg.height * 0.9, cfg.radius);
    if (ny + cfg.height > ceil && p.vy > 0) {
      ny = ceil - cfg.height - 0.01;
      p.vy = 0;
    }
  }

  p.x = nx; p.y = ny; p.z = nz;

  // --- bornes du monde ---
  const LIM = 895;
  if (p.x < -LIM) { p.x = -LIM; p.vx = 0; }
  if (p.x > LIM) { p.x = LIM; p.vx = 0; }
  if (p.z < -LIM) { p.z = -LIM; p.vz = 0; }
  if (p.z > LIM) { p.z = LIM; p.vz = 0; }

  p.speed = Math.hypot(p.vx, p.vz);
  p.crouching = crouch && p.onGround;
  p.sprinting = sprint && p.speed > cfg.walkSpeed * 0.8;

  // --- animation deduite de l'etat ---
  if (p.swimming) p.anim = ANIM.SWIM;
  else if (p.climbing) p.anim = ANIM.CLIMB;
  else if (!p.onGround) p.anim = p.vy > 0.6 ? ANIM.JUMP : ANIM.FALL;
  else if (p.speed > cfg.walkSpeed * 0.9) p.anim = ANIM.RUN;
  else if (p.speed > 0.6) p.anim = ANIM.WALK;
  else p.anim = ANIM.IDLE;


}

/** Chute libre / parapente pendant la phase de largage. */
export function stepGlide(p, cmd, ctx, dt, cfg) {
  const fall = p.parachute ? cfg.parachuteFallSpeed : cfg.glideFallSpeed;
  const fwd = p.parachute ? cfg.parachuteForwardSpeed : cfg.glideForwardSpeed;

  const wx = cmd.moveY * Math.sin(cmd.yaw) + cmd.moveX * Math.cos(cmd.yaw);
  const wz = cmd.moveY * Math.cos(cmd.yaw) - cmd.moveX * Math.sin(cmd.yaw);
  const wl = Math.hypot(wx, wz) || 1;
  const inTurn = Math.hypot(cmd.moveX, cmd.moveY) > 0.1;

  const tvx = inTurn ? (wx / wl) * fwd : 0;
  const tvz = inTurn ? (wz / wl) * fwd : 0;
  p.vx = damp(p.vx, tvx, 2.4, dt);
  p.vz = damp(p.vz, tvz, 2.4, dt);
  p.vy = damp(p.vy, -fall, 3.0, dt);

  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.z += p.vz * dt;

  const LIM = 880;
  p.x = clamp(p.x, -LIM, LIM);
  p.z = clamp(p.z, -LIM, LIM);

  const ground = ctx.terrain(p.x, p.z);
  p.anim = ANIM.GLIDE;
  p.speed = Math.hypot(p.vx, p.vz);

  // ouverture automatique du parapente
  if (!p.parachute && p.y - Math.max(ground, SEA_LEVEL) < cfg.parachuteAltitude) p.parachute = true;

  if (p.y <= Math.max(ground, SEA_LEVEL - 0.5)) {
    p.y = Math.max(ground, SEA_LEVEL - 0.5);
    p.vy = 0;
    p.landed = true;
    p.parachute = false;
    p.onGround = true;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Vehicules
// ---------------------------------------------------------------------------

const WHEEL_OFFSETS = [
  [-1, 1], [1, 1], [-1, -1], [1, -1], // [cote, avant/arriere]
];

/**
 * Un pas de simulation pour un vehicule.
 * A 60 m/s, un tick de 50 ms fait avancer de 3 m : une glissiere de 44 cm d'epaisseur serait
 * traversee sans etre vue. On decoupe donc le tick en sous-pas d'au plus 55 cm.
 */
export function stepVehicle(v, cmd, ctx, dt) {
  const T = VEHICLE_TYPES[v.type];
  if (!T) return;
  const travel = Math.hypot(v.vx, v.vz) * dt;
  const n = Math.min(8, Math.max(1, Math.ceil(travel / 0.55)));
  const sub = dt / n;
  let maxImpact = 0;
  for (let i = 0; i < n; i++) {
    stepVehicleOnce(v, cmd, ctx, sub);
    if (v.impactSpeed > maxImpact) maxImpact = v.impactSpeed;
  }
  v.impactSpeed = maxImpact;
  v.substeps = n;
}

/**
 * Un sous-pas de simulation vehicule (modele arcade, 4 appuis au sol).
 * @param v   {x,y,z,yaw,pitch,roll,vx,vy,vz,speed,steer,wheelSpin,grounded,type,fuel,health}
 * @param cmd {throttle:-1..1, steer:-1..1, handbrake:bool}
 * @param ctx {world, terrain}
 */
function stepVehicleOnce(v, cmd, ctx, dt) {
  const T = VEHICLE_TYPES[v.type];
  const world = ctx.world;

  const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);   // avant
  const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);  // droite

  let fwdSpeed = v.vx * fx + v.vz * fz;
  let latSpeed = v.vx * rx + v.vz * rz;

  const aquatic = !!T.aquatic;
  const groundY = ctx.terrain(v.x, v.z);
  const onWater = groundY < SEA_LEVEL - 0.4;

  // --- sol / flottaison ---
  let supportY, grounded;
  if (aquatic) {
    supportY = onWater ? SEA_LEVEL - 0.25 : groundY;
    grounded = true;
  } else {
    const g = world.ground(v.x, v.z, v.y + 0.6, Math.max(T.halfExtents[0], 0.6), 0.9);
    supportY = Math.max(g.y, onWater ? SEA_LEVEL - 1.4 : g.y);
    grounded = v.y <= supportY + 0.35;
  }
  v.grounded = grounded;

  const outOfFuel = v.fuel !== undefined && v.fuel <= 0;
  const wrecked = v.health !== undefined && v.health <= 0;
  const throttle = outOfFuel || wrecked ? 0 : cmd.throttle;

  // --- moteur ---
  if (grounded) {
    const maxFwd = T.maxSpeed;
    const maxRev = T.reverseSpeed;
    if (throttle > 0.01) {
      const room = 1 - clamp(fwdSpeed / maxFwd, 0, 1);
      fwdSpeed += T.engineForce * throttle * room * dt;
    } else if (throttle < -0.01) {
      if (fwdSpeed > 0.6) fwdSpeed -= T.brakeForce * -throttle * dt; // freinage
      else {
        const room = 1 - clamp(-fwdSpeed / maxRev, 0, 1);
        fwdSpeed += T.engineForce * 0.55 * throttle * room * dt;
      }
    }
    // resistance au roulement + trainee
    fwdSpeed -= Math.sign(fwdSpeed) * T.rollingResistance * dt;
    fwdSpeed -= fwdSpeed * Math.abs(fwdSpeed) * T.drag * dt;
    if (Math.abs(fwdSpeed) < 0.12 && Math.abs(throttle) < 0.01) fwdSpeed = 0;
    if (cmd.handbrake) fwdSpeed *= Math.exp(-3.0 * dt);

    // --- adherence laterale ---
    const grip = cmd.handbrake ? T.driftGrip : T.grip;
    latSpeed *= Math.exp(-grip * dt);

    // --- direction : modele bicyclette, borne par l'adherence laterale ---
    v.steer = damp(v.steer || 0, clamp(cmd.steer, -1, 1), 12, dt);
    const wheelbase = T.wheelbase || 2.6;
    let yawRate = (fwdSpeed / wheelbase) * Math.tan(v.steer * T.steerAngle);
    // au dela de latAccel m/s2 le vehicule sous-vire : on plafonne le rayon de braquage
    const latAcc = Math.abs(yawRate * fwdSpeed);
    const maxLat = cmd.handbrake ? T.latAccel * 1.35 : T.latAccel;
    if (latAcc > maxLat && latAcc > 1e-6) yawRate *= maxLat / latAcc;
    v.yaw = wrapAngle(v.yaw + yawRate * dt);
    v.yawRate = yawRate;
  } else {
    fwdSpeed -= fwdSpeed * Math.abs(fwdSpeed) * T.drag * 0.4 * dt;
    latSpeed *= Math.exp(-0.4 * dt);
    v.steer = damp(v.steer || 0, cmd.steer, 6, dt);
  }

  // limites
  fwdSpeed = clamp(fwdSpeed, -T.reverseSpeed, T.maxSpeed);

  // recomposition de la vitesse monde
  const nfx = Math.sin(v.yaw), nfz = Math.cos(v.yaw);
  const nrx = Math.cos(v.yaw), nrz = -Math.sin(v.yaw);
  v.vx = nfx * fwdSpeed + nrx * latSpeed;
  v.vz = nfz * fwdSpeed + nrz * latSpeed;
  v.speed = fwdSpeed;

  // --- vertical ---
  if (aquatic) {
    v.vy = damp(v.vy, (supportY - v.y) * 5, 5, dt);
  } else {
    v.vy -= GRAVITY * dt;
  }

  let nx = v.x + v.vx * dt;
  let ny = v.y + v.vy * dt;
  let nz = v.z + v.vz * dt;

  // --- collisions du chassis : on teste les 4 coins ---
  const hx = T.halfExtents[0], hz = T.halfExtents[2];
  let impact = 0, inx = 0, inz = 0, pushX = 0, pushZ = 0;
  for (let i = 0; i < 4; i++) {
    const [sx, sz] = WHEEL_OFFSETS[i];
    const cx = nx + (nrx * hx * sx) + (nfx * hz * sz);
    const cz = nz + (nrz * hx * sx) + (nfz * hz * sz);
    const r = world.pushOut(cx, cz, ny + 0.25, T.halfExtents[1] * 2, 0.3, 2);
    if (r.hit) {
      pushX += r.x - cx; pushZ += r.z - cz;
      inx += r.nx; inz += r.nz;
      impact++;
    }
  }
  v.impactSpeed = 0;
  if (impact > 0) {
    // correction complete (moyennee) : rester a moitie encastre ferait vibrer le vehicule
    nx += pushX / impact;
    nz += pushZ / impact;
    const l = Math.hypot(inx, inz) || 1;
    inx /= l; inz /= l;
    const into = v.vx * inx + v.vz * inz;
    if (into < 0) {
      v.impactSpeed = -into;
      // glissement le long du mur : on retire la composante normale, sans rebond
      // (un rebond empecherait de repartir une fois colle a la glissiere)
      v.vx -= inx * into;
      v.vz -= inz * into;
      // on paie le choc en vitesse le long du mur
      const loss = Math.exp(-clamp(v.impactSpeed * 0.12, 0, 2.5));
      v.vx *= loss; v.vz *= loss;
      // assistance « frotte-glissiere » : le vehicule s'aligne sur la paroi au lieu de
      // rester plante nez contre le rail. Indispensable a Monaco, ou l'on longe les rails.
      const tanX = -inz, tanZ = inx;
      const dir = (nfx * tanX + nfz * tanZ) >= 0 ? 1 : -1;
      const wallYaw = Math.atan2(tanX * dir, tanZ * dir);
      v.yaw = wrapAngle(v.yaw + angleDelta(v.yaw, wallYaw) * clamp(0.10 + v.impactSpeed * 0.02, 0, 0.4));
    }
  }
  // la vitesse longitudinale doit toujours refleter la vitesse reelle
  v.speed = v.vx * Math.sin(v.yaw) + v.vz * Math.cos(v.yaw);

  // --- pose sur le terrain (assiette) ---
  if (!aquatic) {
    const g2 = world.ground(nx, nz, ny + 0.8, Math.max(hx, 0.6), 1.2);
    const sy = Math.max(g2.y, onWater ? SEA_LEVEL - 1.4 : g2.y);
    if (ny <= sy + 0.02) {
      if (v.vy < -6) v.hardLanding = -v.vy;
      ny = sy;
      v.vy = 0;
      v.grounded = true;
    }
    // assiette : on echantillonne l'avant/l'arriere et la gauche/droite
    const fY = ctx.terrain(nx + nfx * hz, nz + nfz * hz);
    const bY = ctx.terrain(nx - nfx * hz, nz - nfz * hz);
    const lY = ctx.terrain(nx - nrx * hx, nz - nrz * hx);
    const rY = ctx.terrain(nx + nrx * hx, nz + nrz * hx);
    const tPitch = Math.atan2(bY - fY, hz * 2);
    const tRoll = Math.atan2(lY - rY, hx * 2);
    v.pitch = damp(v.pitch || 0, clamp(tPitch, -0.7, 0.7), 8, dt);
    v.roll = damp(v.roll || 0, clamp(tRoll, -0.7, 0.7) - clamp(latSpeed * 0.02, -0.25, 0.25), 8, dt);
  } else {
    ny = damp(ny, supportY, 6, dt);
    v.pitch = damp(v.pitch || 0, clamp(-fwdSpeed * 0.008, -0.2, 0.2), 3, dt);
    v.roll = damp(v.roll || 0, clamp(-latSpeed * 0.03, -0.35, 0.35), 3, dt);
    // une vedette echouee ralentit brutalement
    if (!onWater) { v.vx *= Math.exp(-4 * dt); v.vz *= Math.exp(-4 * dt); v.speed *= Math.exp(-4 * dt); }
  }

  v.x = nx; v.y = ny; v.z = nz;

  const LIM = 890;
  v.x = clamp(v.x, -LIM, LIM);
  v.z = clamp(v.z, -LIM, LIM);

  // rotation des roues (pour le rendu)
  if (T.wheel) v.wheelSpin = (v.wheelSpin || 0) + (fwdSpeed / T.wheel.radius) * dt;

  // consommation
  if (v.fuel !== undefined && Math.abs(throttle) > 0.05) {
    v.fuel = Math.max(0, v.fuel - Math.abs(fwdSpeed) * dt * 0.012);
  }
}

/** Position monde d'un siege. */
export function seatWorldPos(v, seatIndex, out) {
  const T = VEHICLE_TYPES[v.type];
  const off = T.seatOffsets[Math.min(seatIndex, T.seatOffsets.length - 1)];
  const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
  const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
  out.x = v.x + rx * off[0] + fx * off[2];
  out.y = v.y + off[1];
  out.z = v.z + rz * off[0] + fz * off[2];
  return out;
}

/** Cherche un point de sortie libre a cote du vehicule. */
export function findExitSpot(v, ctx, radius, height) {
  const T = VEHICLE_TYPES[v.type];
  const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
  const d = T.halfExtents[0] + radius + 0.5;
  for (const side of [-1, 1, -1.8, 1.8]) {
    const x = v.x + rx * d * side;
    const z = v.z + rz * d * side;
    const y = ctx.terrain(x, z);
    if (y > SEA_LEVEL - 1 && ctx.world.isFree(x, z, y, height, radius)) return { x, y, z };
  }
  return { x: v.x, y: Math.max(v.y + 1.2, ctx.terrain(v.x, v.z)), z: v.z };
}

export { lerp };
