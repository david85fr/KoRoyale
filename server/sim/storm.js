// La « Brume du Rocher » : le cercle qui retrecit.
// Chaque phase attend, puis se deplace/retrecit vers le cercle suivant.

import { STORM_PHASES } from '../../shared/constants.js';
import { lerp, clamp } from '../../shared/math.js';
import { ISLAND } from '../../shared/mapdata.js';

export class Storm {
  constructor(rng) {
    this.rng = rng;
    this.phase = 0;
    this.timer = 0;
    this.shrinking = false;
    const p0 = STORM_PHASES[0];
    this.cx = ISLAND.cx;
    this.cz = ISLAND.cz;
    this.radius = p0.radius;
    this.fromCx = this.cx; this.fromCz = this.cz; this.fromR = this.radius;
    this._pickNext();
    this.dps = p0.dps;
    this.finished = false;
  }

  _pickNext() {
    const next = STORM_PHASES[Math.min(this.phase + 1, STORM_PHASES.length - 1)];
    // le prochain cercle est contenu dans l'actuel, avec un peu de decentrage
    const maxOffset = Math.max(0, this.radius - next.radius) * 0.72;
    const [ox, oz] = this.rng.inDisk(maxOffset);
    this.nextCx = this.cx + ox;
    this.nextCz = this.cz + oz;
    this.nextRadius = next.radius;
  }

  /** @returns {string|null} 'wait'|'shrink' quand la phase change, sinon null */
  update(dt) {
    if (this.finished) return null;
    const cur = STORM_PHASES[this.phase];
    this.timer += dt;
    if (!this.shrinking) {
      if (this.timer >= cur.waitTime) {
        this.timer = 0;
        this.shrinking = true;
        this.fromCx = this.cx; this.fromCz = this.cz; this.fromR = this.radius;
        return 'shrink';
      }
    } else {
      const t = clamp(this.timer / cur.shrinkTime, 0, 1);
      this.cx = lerp(this.fromCx, this.nextCx, t);
      this.cz = lerp(this.fromCz, this.nextCz, t);
      this.radius = lerp(this.fromR, this.nextRadius, t);
      if (t >= 1) {
        this.timer = 0;
        this.shrinking = false;
        this.phase++;
        if (this.phase >= STORM_PHASES.length - 1) {
          this.finished = true;
          this.radius = 0;
          this.dps = STORM_PHASES[STORM_PHASES.length - 1].dps;
          return 'wait';
        }
        this.dps = STORM_PHASES[this.phase].dps;
        this._pickNext();
        return 'wait';
      }
    }
    return null;
  }

  /** Degats par seconde subis en (x,z). 0 si a l'abri. */
  damageAt(x, z) {
    const d = Math.hypot(x - this.cx, z - this.cz);
    return d > this.radius ? this.dps : 0;
  }

  outside(x, z) {
    return Math.hypot(x - this.cx, z - this.cz) > this.radius;
  }

  /** Temps restant avant le prochain evenement (pour l'interface). */
  timeLeft() {
    const cur = STORM_PHASES[this.phase];
    return Math.max(0, (this.shrinking ? cur.shrinkTime : cur.waitTime) - this.timer);
  }

  serialize() {
    return {
      cx: Math.round(this.cx * 10) / 10,
      cz: Math.round(this.cz * 10) / 10,
      r: Math.round(this.radius * 10) / 10,
      nx: Math.round(this.nextCx * 10) / 10,
      nz: Math.round(this.nextCz * 10) / 10,
      nr: Math.round(this.nextRadius * 10) / 10,
      p: this.phase,
      s: this.shrinking ? 1 : 0,
      t: Math.round(this.timeLeft() * 10) / 10,
      d: this.dps,
    };
  }
}
