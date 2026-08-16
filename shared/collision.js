// Monde de collision partage : le serveur l'utilise pour la simulation autoritaire,
// le client pour la prediction locale. Meme code = meme resultat.
//
// Deux formes seulement : boites orientees autour de Y (OBB) et cylindres verticaux.
// Le terrain est fourni par une fonction hauteur(x, z).

import { clamp, worldToLocal, localToWorld, rayOBB, rayCylinder } from './math.js';
import { SURFACE } from './constants.js';

const CELL = 32;

export class CollisionWorld {
  /**
   * @param {Array} colliders liste de {type:'box'|'cyl', ...}
   * @param {(x:number,z:number)=>number} terrainFn
   * @param {{half:number}} opts
   */
  constructor(colliders, terrainFn, opts = {}) {
    this.colliders = colliders;
    this.terrain = terrainFn;
    this.half = opts.half ?? 900;
    this.cols = Math.ceil((this.half * 2) / CELL) + 1;
    this.origin = -this.half;
    this.cells = new Map();
    for (let i = 0; i < colliders.length; i++) this._insert(i, colliders[i]);
  }

  _bounds(c) {
    if (c.type === 'box') {
      const ca = Math.abs(Math.cos(c.yaw || 0)), sa = Math.abs(Math.sin(c.yaw || 0));
      const ex = c.hx * ca + c.hz * sa;
      const ez = c.hx * sa + c.hz * ca;
      return [c.x - ex, c.z - ez, c.x + ex, c.z + ez];
    }
    return [c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r];
  }

  _key(cx, cz) { return cz * this.cols + cx; }

  _insert(idx, c) {
    const [minX, minZ, maxX, maxZ] = this._bounds(c);
    const x0 = Math.floor((minX - this.origin) / CELL);
    const x1 = Math.floor((maxX - this.origin) / CELL);
    const z0 = Math.floor((minZ - this.origin) / CELL);
    const z1 = Math.floor((maxZ - this.origin) / CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = this._key(cx, cz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(idx);
      }
    }
  }

  /** Appelle cb(collider) pour tous les colliders dont la cellule touche le disque (x,z,r). */
  forEachNear(x, z, r, cb) {
    const x0 = Math.floor((x - r - this.origin) / CELL);
    const x1 = Math.floor((x + r - this.origin) / CELL);
    const z0 = Math.floor((z - r - this.origin) / CELL);
    const z1 = Math.floor((z + r - this.origin) / CELL);
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.cells.get(this._key(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const idx = list[i];
          if (seen.has(idx)) continue;
          seen.add(idx);
          if (cb(this.colliders[idx], idx) === false) return;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sol / plafond
  // -------------------------------------------------------------------------

  /**
   * Hauteur du sol praticable sous un personnage.
   * @returns {{y:number, surface:number, collider:object|null}}
   */
  ground(x, z, feetY, radius = 0.5, stepUp = 0.7) {
    let best = this.terrain(x, z);
    let surface = SURFACE.GRASS;
    let col = null;
    const limit = feetY + stepUp;
    this.forEachNear(x, z, radius + 0.1, (c) => {
      if (c.walkable === false) return;
      const top = c.type === 'box' ? c.y + c.hy : c.y + c.h;
      if (top > limit || top <= best) return;
      if (!this._insideXZ(c, x, z, 0)) return;
      best = top; surface = c.surface ?? SURFACE.STONE; col = c;
    });
    return { y: best, surface, collider: col };
  }

  /** Plafond au dessus de feetY (Infinity si degage). */
  ceiling(x, z, headY, radius = 0.5) {
    let best = Infinity;
    this.forEachNear(x, z, radius + 0.1, (c) => {
      const bottom = c.type === 'box' ? c.y - c.hy : c.y;
      const top = c.type === 'box' ? c.y + c.hy : c.y + c.h;
      if (bottom < headY - 0.02 || bottom >= best) return;
      if (top <= headY) return;
      if (!this._insideXZ(c, x, z, radius * 0.5)) return;
      best = bottom;
    });
    return best;
  }

  _insideXZ(c, x, z, margin) {
    if (c.type === 'box') {
      const [lx, lz] = worldToLocal(x, z, c.x, c.z, c.yaw || 0);
      return Math.abs(lx) <= c.hx + margin && Math.abs(lz) <= c.hz + margin;
    }
    const dx = x - c.x, dz = z - c.z;
    return dx * dx + dz * dz <= (c.r + margin) * (c.r + margin);
  }

  // -------------------------------------------------------------------------
  // Deplacement horizontal d'une capsule
  // -------------------------------------------------------------------------

  /**
   * Repousse la position (x,z) hors des colliders dont la tranche verticale
   * [bottom, top] recouvre celle du personnage.
   * @returns {{x:number, z:number, hit:boolean, nx:number, nz:number}}
   */
  pushOut(x, z, feetY, height, radius, iterations = 3) {
    let px = x, pz = z, hit = false, nx = 0, nz = 0;
    const bodyBottom = feetY + 0.25; // on tolere les petites marches
    const bodyTop = feetY + height;
    for (let it = 0; it < iterations; it++) {
      let moved = false;
      this.forEachNear(px, pz, radius + 2.2, (c) => {
        const cb = c.type === 'box' ? c.y - c.hy : c.y;
        const ct = c.type === 'box' ? c.y + c.hy : c.y + c.h;
        if (ct <= bodyBottom || cb >= bodyTop) return; // pas de recouvrement vertical
        if (c.type === 'box') {
          const [lx, lz] = worldToLocal(px, pz, c.x, c.z, c.yaw || 0);
          const ox = c.hx + radius - Math.abs(lx);
          const oz = c.hz + radius - Math.abs(lz);
          if (ox <= 0 || oz <= 0) return;
          let nlx = lx, nlz = lz;
          if (ox < oz) nlx = Math.sign(lx || 1) * (c.hx + radius);
          else nlz = Math.sign(lz || 1) * (c.hz + radius);
          const [wx, wz] = localToWorld(nlx, nlz, c.x, c.z, c.yaw || 0);
          nx += wx - px; nz += wz - pz;
          px = wx; pz = wz;
          moved = true; hit = true;
        } else {
          const dx = px - c.x, dz = pz - c.z;
          const d = Math.hypot(dx, dz);
          const rr = c.r + radius;
          if (d >= rr) return;
          if (d < 1e-4) { px = c.x + rr; nx += rr; }
          else {
            const k = rr / d;
            const wx = c.x + dx * k, wz = c.z + dz * k;
            nx += wx - px; nz += wz - pz;
            px = wx; pz = wz;
          }
          moved = true; hit = true;
        }
      });
      if (!moved) break;
    }
    const l = Math.hypot(nx, nz) || 1;
    return { x: px, z: pz, hit, nx: nx / l, nz: nz / l };
  }

  /** Vrai s'il y a de la place pour une capsule a cet endroit. */
  isFree(x, z, feetY, height, radius) {
    let free = true;
    const bodyBottom = feetY + 0.15;
    const bodyTop = feetY + height;
    this.forEachNear(x, z, radius, (c) => {
      const cb = c.type === 'box' ? c.y - c.hy : c.y;
      const ct = c.type === 'box' ? c.y + c.hy : c.y + c.h;
      if (ct <= bodyBottom || cb >= bodyTop) return;
      if (this._insideXZ(c, x, z, radius)) { free = false; return false; }
    });
    return free;
  }

  // -------------------------------------------------------------------------
  // Lancer de rayon
  // -------------------------------------------------------------------------

  /**
   * Rayon contre le decor + le terrain.
   * @returns {{t:number,x:number,y:number,z:number,nx:number,ny:number,nz:number,collider:object|null,terrain:boolean}|null}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, opts = {}) {
    let best = maxDist;
    let hit = null;

    // --- decor, via un parcours DDA de la grille ---
    let cx = Math.floor((ox - this.origin) / CELL);
    let cz = Math.floor((oz - this.origin) / CELL);
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(dx) < 1e-9 ? Infinity : Math.abs(CELL / dx);
    const tDeltaZ = Math.abs(dz) < 1e-9 ? Infinity : Math.abs(CELL / dz);
    const cellMinX = this.origin + cx * CELL;
    const cellMinZ = this.origin + cz * CELL;
    let tMaxX = Math.abs(dx) < 1e-9 ? Infinity
      : ((dx > 0 ? cellMinX + CELL - ox : ox - cellMinX) / Math.abs(dx));
    let tMaxZ = Math.abs(dz) < 1e-9 ? Infinity
      : ((dz > 0 ? cellMinZ + CELL - oz : oz - cellMinZ) / Math.abs(dz));

    const seen = new Set();
    let travelled = 0;
    let guard = 0;
    while (travelled <= best && guard++ < 4096) {
      const list = this.cells.get(this._key(cx, cz));
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const idx = list[i];
          if (seen.has(idx)) continue;
          seen.add(idx);
          const c = this.colliders[idx];
          if (opts.filter && !opts.filter(c)) continue;
          const r = c.type === 'box'
            ? rayOBB(ox, oy, oz, dx, dy, dz, c)
            : rayCylinder(ox, oy, oz, dx, dy, dz, c.x, c.y, c.z, c.r, c.h);
          if (r && r.t >= 0 && r.t < best) {
            best = r.t;
            hit = { t: r.t, nx: r.nx, ny: r.ny, nz: r.nz, collider: c, terrain: false };
          }
        }
      }
      if (tMaxX < tMaxZ) { travelled = tMaxX; cx += stepX; tMaxX += tDeltaX; }
      else { travelled = tMaxZ; cz += stepZ; tMaxZ += tDeltaZ; }
      if (cx < -2 || cz < -2 || cx > this.cols + 2 || cz > this.cols + 2) break;
    }

    // --- terrain : marche a pas fixe puis affinage ---
    if (!opts.skipTerrain) {
      const step = opts.terrainStep ?? 1.2;
      let prevT = 0;
      let prevAbove = oy - this.terrain(ox, oz);
      for (let t = step; t <= best; t += step) {
        const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
        const above = py - this.terrain(px, pz);
        if (above <= 0) {
          // dichotomie
          let lo = prevT, hi = t;
          for (let k = 0; k < 8; k++) {
            const mid = (lo + hi) / 2;
            const mx = ox + dx * mid, my = oy + dy * mid, mz = oz + dz * mid;
            if (my - this.terrain(mx, mz) <= 0) hi = mid; else lo = mid;
          }
          if (hi < best) {
            best = hi;
            const hx = ox + dx * hi, hz = oz + dz * hi;
            const e = 0.6;
            const nxT = this.terrain(hx - e, hz) - this.terrain(hx + e, hz);
            const nzT = this.terrain(hx, hz - e) - this.terrain(hx, hz + e);
            const nl = Math.hypot(nxT, 2 * e, nzT) || 1;
            hit = { t: hi, nx: nxT / nl, ny: (2 * e) / nl, nz: nzT / nl, collider: null, terrain: true };
          }
          break;
        }
        prevT = t; prevAbove = above;
      }
      void prevAbove;
    }

    if (!hit) return null;
    hit.x = ox + dx * hit.t;
    hit.y = oy + dy * hit.t;
    hit.z = oz + dz * hit.t;
    return hit;
  }

  /** Ligne de vue degagee entre deux points (ignore le terrain si demande). */
  lineOfSight(ax, ay, az, bx, by, bz, opts = {}) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) return true;
    const h = this.raycast(ax, ay, az, dx / d, dy / d, dz / d, d - 0.2, opts);
    return !h;
  }

  /** Ajoute un collider dynamique (vehicule). Renvoie son index. */
  addDynamic(c) {
    const idx = this.colliders.length;
    this.colliders.push(c);
    this._insert(idx, c);
    return idx;
  }
}

/** Pente du terrain en (x,z) : renvoie la normale unitaire. */
export function terrainNormal(terrainFn, x, z, e = 0.7) {
  const hL = terrainFn(x - e, z), hR = terrainFn(x + e, z);
  const hD = terrainFn(x, z - e), hU = terrainFn(x, z + e);
  const nx = hL - hR, nz = hD - hU, ny = 2 * e;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

export function slopeCos(terrainFn, x, z) {
  return clamp(terrainNormal(terrainFn, x, z)[1], 0, 1);
}
