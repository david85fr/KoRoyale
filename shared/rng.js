// Generateur pseudo-aleatoire deterministe (mulberry32) : meme graine => meme monde
// sur le serveur et sur tous les clients.

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class RNG {
  constructor(seed = 1) {
    this.seed = typeof seed === 'string' ? hashString(seed) : (seed >>> 0) || 1;
    this.state = this.seed;
  }

  /** [0,1) */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  float(min = 0, max = 1) {
    return min + this.next() * (max - min);
  }

  /** entier dans [min, max] inclus */
  int(min, max) {
    return Math.floor(this.float(min, max + 1 - 1e-9));
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }

  /** Tirage pondere : items = [{weight}] ou poids fourni par `getWeight`. */
  weighted(items, getWeight = (it) => it.weight ?? 1) {
    let total = 0;
    for (const it of items) total += getWeight(it);
    if (total <= 0) return items[0];
    let r = this.next() * total;
    for (const it of items) {
      r -= getWeight(it);
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** Point uniforme dans un disque. */
  inDisk(radius = 1) {
    const a = this.next() * Math.PI * 2;
    const r = Math.sqrt(this.next()) * radius;
    return [Math.cos(a) * r, Math.sin(a) * r];
  }

  fork(salt = 0) {
    return new RNG((this.state ^ Math.imul(salt + 1, 2654435761)) >>> 0);
  }
}

/** Instance jetable pour du bruit deterministe base sur un index. */
export function seededRng(...parts) {
  return new RNG(hashString(parts.join('|')));
}
