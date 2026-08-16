// Petites maths partagees. Aucune dependance : tourne dans Node et dans le navigateur.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Interpolation exponentielle stable quel que soit le dt. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Ramene un angle dans ]-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Plus court chemin angulaire de a vers b. */
export function angleDelta(a, b) {
  return wrapAngle(b - a);
}

export function lerpAngle(a, b, t) {
  return a + angleDelta(a, b) * t;
}

export function dist2(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  return dx * dx + dz * dz;
}

export function dist(ax, az, bx, bz) {
  return Math.sqrt(dist2(ax, az, bx, bz));
}

export function dist3(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function len3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

export function norm3(x, y, z) {
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  return [x / l, y / l, z / l];
}

/** Direction unitaire depuis un yaw (0 = +Z) et un pitch. */
export function dirFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
}

export function yawFromDir(x, z) {
  return Math.atan2(x, z);
}

/** Distance d'un point 2D au segment [a,b]. Renvoie {d, t, x, z}. */
export function closestPointOnSegment(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 1e-9 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
  t = clamp01(t);
  const x = ax + abx * t, z = az + abz * t;
  return { t, x, z, d: Math.hypot(px - x, pz - z) };
}

/** Rotation d'un point 2D autour de l'origine. */
export function rot2(x, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

/** Passage monde -> local d'une boite orientee (yaw uniquement). */
export function worldToLocal(px, pz, cx, cz, yaw) {
  const dx = px - cx, dz = pz - cz;
  const c = Math.cos(-yaw), s = Math.sin(-yaw);
  return [dx * c + dz * s, -dx * s + dz * c];
}

export function localToWorld(lx, lz, cx, cz, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [cx + lx * c + lz * s, cz - lx * s + lz * c];
}

/** Intersection rayon / sphere. Renvoie t >= 0 ou -1. */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

/**
 * Intersection rayon / boite orientee (yaw). Renvoie {t, nx, ny, nz} ou null.
 * o = origine, d = direction (unitaire), box = {x,y,z,hx,hy,hz,yaw} (y = centre).
 */
export function rayOBB(ox, oy, oz, dx, dy, dz, box) {
  const c = Math.cos(-box.yaw || 0), s = Math.sin(-box.yaw || 0);
  const rx = ox - box.x, ry = oy - box.y, rz = oz - box.z;
  const lox = rx * c + rz * s, loz = -rx * s + rz * c;
  const ldx = dx * c + dz * s, ldz = -dx * s + dz * c;
  const o = [lox, ry, loz], d = [ldx, dy, ldz];
  const h = [box.hx, box.hy, box.hz];
  let tmin = -Infinity, tmax = Infinity, axis = 0, sgn = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < -h[i] || o[i] > h[i]) return null;
      continue;
    }
    const inv = 1 / d[i];
    let t1 = (-h[i] - o[i]) * inv;
    let t2 = (h[i] - o[i]) * inv;
    let sg = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sgn = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  const t = tmin < 0 ? tmax : tmin;
  if (t < 0) return null;
  const ln = [0, 0, 0];
  ln[axis] = sgn;
  // retour en repere monde
  const cc = Math.cos(box.yaw || 0), ss = Math.sin(box.yaw || 0);
  return {
    t,
    nx: ln[0] * cc + ln[2] * ss,
    ny: ln[1],
    nz: -ln[0] * ss + ln[2] * cc,
  };
}

/** Intersection rayon / cylindre vertical (base y0, hauteur h). */
export function rayCylinder(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, h) {
  const mx = ox - cx, mz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return null;
  const b = mx * dx + mz * dz;
  const c = mx * mx + mz * mz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / a;
  if (t < 0) t = (-b + sq) / a;
  if (t < 0) return null;
  const y = oy + dy * t;
  if (y < cy || y > cy + h) return null;
  const hx = ox + dx * t, hz = oz + dz * t;
  const nl = Math.hypot(hx - cx, hz - cz) || 1;
  return { t, nx: (hx - cx) / nl, ny: 0, nz: (hz - cz) / nl };
}

/** Bruit de valeur deterministe 2D (rapide, sans table). */
export function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

export function valueNoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

export function fbm2(x, y, octaves = 4, lac = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / (norm || 1);
}

/** Catmull-Rom sur 4 points (composante scalaire). */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
