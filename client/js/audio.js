// Moteur sonore : tout est SYNTHETISE avec la Web Audio API.
// Aucun fichier son dans le depot — coups de feu, explosions, klaxons, moteurs et
// bêlements sont fabriques a la volee avec des oscillateurs et du bruit filtre.
//
// Rien ne touche a l'audio avant unlock() : les navigateurs exigent un geste utilisateur.

const MAX_VOICES = 32;
const NOISE_SECONDS = 2;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.noise = null;
    this.enabled = true;
    this.volume = 0.7;
    this.voices = [];
    this.engines = new Map();
    this.music = null;
    this.failed = false;
  }

  // -------------------------------------------------------------------------
  // Cycle de vie
  // -------------------------------------------------------------------------

  unlock() {
    if (this.failed) return;
    if (!this.ctx) {
      if (typeof window === 'undefined') { this.failed = true; return; }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { this.failed = true; return; }
      try { this.ctx = new Ctx({ latencyHint: 'interactive' }); }
      catch { this.failed = true; return; }

      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? this.volume : 0;
      this.master.connect(this.ctx.destination);

      // un soupçon de reverbe commune, ca pose l'espace sans coûter cher
      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = this._impulse(1.1, 2.4);
      this.reverbGain = this.ctx.createGain();
      this.reverbGain.gain.value = 0.18;
      this.reverbGain.connect(this.master);
      this.reverb.connect(this.reverbGain);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 1;
      this.sfxBus.connect(this.master);
      this.sfxBus.connect(this.reverb);

      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.34;
      this.musicBus.connect(this.master);

      this.noise = this._noiseBuffer();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
  }

  destroy() {
    this.stopMusic();
    for (const id of [...this.engines.keys()]) this.engine(id, false);
    for (const v of this.voices) { try { v.stop(); } catch { /* deja arrete */ } }
    this.voices.length = 0;
    if (this.ctx) { try { this.ctx.close(); } catch { /* deja ferme */ } }
    this.ctx = null;
  }

  // -------------------------------------------------------------------------
  // Utilitaires
  // -------------------------------------------------------------------------

  _noiseBuffer() {
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, sr * NOISE_SECONDS, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _impulse(seconds, decay) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /** Destination d'une voix : bus 2D, ou panner spatialise si une position est fournie. */
  _dest(pos, refDistance = 12) {
    if (!pos) return this.sfxBus;
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.maxDistance = 400;
    p.rolloffFactor = 1.1;
    if (p.positionX) {
      p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
    } else if (p.setPosition) {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    p.connect(this.sfxBus);
    return p;
  }

  _track(node) {
    this.voices.push(node);
    if (this.voices.length > MAX_VOICES) {
      const old = this.voices.shift();
      try { old.stop(); } catch { /* deja fini */ }
    }
    node.onended = () => {
      const i = this.voices.indexOf(node);
      if (i >= 0) this.voices.splice(i, 1);
    };
  }

  /** Impulsion de bruit filtree : la brique de base des armes et des impacts. */
  _burst(dest, { freq, q = 1, type = 'bandpass', dur = 0.12, gain = 0.6, sweep = 0, when = 0 }) {
    const t = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t);
    if (sweep) filt.frequency.exponentialRampToValueAtTime(Math.max(60, freq * sweep), t + dur);
    filt.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.05);
    this._track(src);
    return src;
  }

  /** Note d'oscillateur avec enveloppe. */
  _tone(dest, { freq, type = 'sine', dur = 0.2, gain = 0.3, slide = 0, attack = 0.005, when = 0, detune = 0 }) {
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    if (detune) o.detune.value = detune;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
    this._track(o);
    return o;
  }

  // -------------------------------------------------------------------------
  // Ecoute
  // -------------------------------------------------------------------------

  listener(x, y, z, yaw) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    if (L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setTargetAtTime(x, t, 0.02);
      L.positionY.setTargetAtTime(y, t, 0.02);
      L.positionZ.setTargetAtTime(z, t, 0.02);
      L.forwardX.setTargetAtTime(fx, t, 0.02);
      L.forwardY.setTargetAtTime(0, t, 0.02);
      L.forwardZ.setTargetAtTime(fz, t, 0.02);
      L.upX.setTargetAtTime(0, t, 0.02);
      L.upY.setTargetAtTime(1, t, 0.02);
      L.upZ.setTargetAtTime(0, t, 0.02);
    } else if (L.setPosition) {
      L.setPosition(x, y, z);
      L.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  // -------------------------------------------------------------------------
  // Sons du jeu
  // -------------------------------------------------------------------------

  play(name, pos = null, opts = {}) {
    if (!this.enabled || this.failed) return;
    if (!this.ctx) return;              // pas encore debloque : silence, pas d'erreur
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    const fn = RECIPES[name];
    if (!fn) return;                    // nom inconnu : on ignore proprement
    try { fn(this, this._dest(pos, opts.refDistance), opts); }
    catch { /* un son rate ne doit jamais casser une partie */ }
  }

  // -------------------------------------------------------------------------
  // Moteurs (boucles, un par vehicule)
  // -------------------------------------------------------------------------

  engine(id, on, opts = {}) {
    if (!this.ctx || this.failed) return;
    let e = this.engines.get(id);
    if (!on) {
      if (e) {
        try {
          e.osc.stop(); e.sub.stop(); e.noise.stop();
        } catch { /* deja arrete */ }
        this.engines.delete(id);
      }
      return;
    }
    if (!e) {
      const dest = this.sfxBus;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.connect(dest);

      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      const oscG = this.ctx.createGain(); oscG.gain.value = 0.35;
      osc.connect(oscG); oscG.connect(g);

      const sub = this.ctx.createOscillator();
      sub.type = 'square';
      const subG = this.ctx.createGain(); subG.gain.value = 0.22;
      sub.connect(subG); subG.connect(g);

      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noise; noise.loop = true;
      const nf = this.ctx.createBiquadFilter();
      nf.type = 'bandpass'; nf.frequency.value = 400; nf.Q.value = 0.6;
      const nG = this.ctx.createGain(); nG.gain.value = 0.12;
      noise.connect(nf); nf.connect(nG); nG.connect(g);

      osc.start(); sub.start(); noise.start();
      e = { g, osc, sub, noise, nf };
      this.engines.set(id, e);
    }
    const t = this.ctx.currentTime;
    const speed = Math.abs(opts.speed ?? 0);
    const base = opts.type === 'f1' ? 90 : opts.type === 'scooter' ? 70 : opts.type === 'boat' ? 45 : 55;
    const rev = base + speed * (opts.type === 'f1' ? 9 : 6);
    e.osc.frequency.setTargetAtTime(rev, t, 0.08);
    e.sub.frequency.setTargetAtTime(rev * 0.5, t, 0.08);
    e.nf.frequency.setTargetAtTime(300 + speed * 22, t, 0.1);
    e.g.gain.setTargetAtTime(Math.min(0.3, 0.06 + speed * 0.006), t, 0.12);
  }

  // -------------------------------------------------------------------------
  // Musique
  // -------------------------------------------------------------------------

  startMusic(name = 'menu') {
    if (!this.ctx || this.failed) return;
    this.stopMusic();
    const menu = name === 'menu';
    const scale = menu ? [0, 4, 7, 11, 14, 16] : [0, 3, 7, 10, 12, 15];
    const root = menu ? 196 : 130.8; // sol3 / do3
    const bus = this.musicBus;

    const pad = this.ctx.createGain();
    pad.gain.value = 0.0001;
    pad.connect(bus);
    pad.gain.exponentialRampToValueAtTime(menu ? 0.22 : 0.14, this.ctx.currentTime + 3);
    const oscs = [];
    for (const semi of [0, 7, 12]) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = root * Math.pow(2, semi / 12);
      o.detune.value = (Math.random() - 0.5) * 12;
      o.connect(pad);
      o.start();
      oscs.push(o);
    }

    // arpege discret
    let step = 0;
    const arp = () => {
      if (!this.music || !this.ctx) return;
      const semi = scale[step % scale.length];
      const f = root * 2 * Math.pow(2, semi / 12);
      this._tone(bus, { freq: f, type: 'sine', dur: menu ? 1.1 : 0.6, gain: menu ? 0.07 : 0.05, attack: 0.06 });
      step++;
      this.music.timer = setTimeout(arp, menu ? 900 : 520);
    };
    this.music = { pad, oscs, timer: null };
    arp();
  }

  stopMusic() {
    if (!this.music) return;
    const m = this.music;
    this.music = null;
    if (m.timer) clearTimeout(m.timer);
    try {
      const t = this.ctx.currentTime;
      m.pad.gain.cancelScheduledValues(t);
      m.pad.gain.setValueAtTime(Math.max(0.0001, m.pad.gain.value), t);
      m.pad.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      for (const o of m.oscs) o.stop(t + 0.7);
    } catch { /* contexte deja ferme */ }
  }
}

// ---------------------------------------------------------------------------
// Recettes sonores
// ---------------------------------------------------------------------------

/** Coup de feu generique : claquement + corps de bruit + queue. */
function gunshot(a, dest, { freq, body, dur, gain, tail = 0 }) {
  a._burst(dest, { freq, q: 0.7, dur, gain, sweep: 0.35 });
  a._burst(dest, { freq: body, q: 2.2, dur: dur * 0.6, gain: gain * 0.7, sweep: 0.5 });
  a._tone(dest, { freq: body * 0.5, type: 'square', dur: 0.05, gain: gain * 0.35, slide: 0.4 });
  if (tail) a._burst(dest, { freq: 900, q: 0.4, dur: tail, gain: gain * 0.16, sweep: 0.25, when: 0.03 });
}

const RECIPES = {
  shot_pistol: (a, d) => gunshot(a, d, { freq: 2600, body: 900, dur: 0.13, gain: 0.5 }),
  shot_smg: (a, d) => gunshot(a, d, { freq: 3000, body: 1100, dur: 0.09, gain: 0.38 }),
  shot_ar: (a, d) => gunshot(a, d, { freq: 2200, body: 700, dur: 0.16, gain: 0.55, tail: 0.18 }),
  shot_dmr: (a, d) => gunshot(a, d, { freq: 1800, body: 560, dur: 0.2, gain: 0.6, tail: 0.3 }),
  shot_shotgun: (a, d) => {
    gunshot(a, d, { freq: 1100, body: 320, dur: 0.26, gain: 0.7, tail: 0.35 });
    a._tone(d, { freq: 90, type: 'sine', dur: 0.18, gain: 0.35, slide: 0.5 });
  },
  shot_sniper: (a, d) => {
    gunshot(a, d, { freq: 3400, body: 480, dur: 0.3, gain: 0.75, tail: 0.7 });
    a._tone(d, { freq: 120, type: 'sine', dur: 0.3, gain: 0.3, slide: 0.35 });
  },
  shot_rpg: (a, d) => {
    a._burst(d, { freq: 700, q: 0.5, dur: 0.5, gain: 0.6, sweep: 0.2 });
    a._tone(d, { freq: 70, type: 'sawtooth', dur: 0.6, gain: 0.35, slide: 2.5 });
  },
  shot_hoof: (a, d) => RECIPES.melee(a, d),

  melee: (a, d) => {
    a._burst(d, { freq: 500, q: 1.4, dur: 0.11, gain: 0.5, sweep: 0.3 });
    a._tone(d, { freq: 180, type: 'square', dur: 0.09, gain: 0.3, slide: 0.5 });
  },

  explosion: (a, d) => {
    a._burst(d, { freq: 400, q: 0.4, dur: 0.9, gain: 0.9, sweep: 0.12 });
    a._tone(d, { freq: 62, type: 'sine', dur: 1.0, gain: 0.6, slide: 0.35 });
    a._burst(d, { freq: 2400, q: 0.6, dur: 0.16, gain: 0.4, sweep: 0.3 });
  },

  hit: (a, d) => a._tone(d, { freq: 880, type: 'square', dur: 0.06, gain: 0.22, slide: 0.7 }),
  headshot: (a, d) => {
    a._tone(d, { freq: 1500, type: 'square', dur: 0.07, gain: 0.28, slide: 0.6 });
    a._tone(d, { freq: 2300, type: 'sine', dur: 0.1, gain: 0.2, when: 0.04 });
  },
  kill: (a, d) => {
    a._tone(d, { freq: 660, type: 'triangle', dur: 0.12, gain: 0.3 });
    a._tone(d, { freq: 990, type: 'triangle', dur: 0.18, gain: 0.28, when: 0.09 });
  },
  death: (a, d) => {
    a._tone(d, { freq: 320, type: 'sawtooth', dur: 0.7, gain: 0.3, slide: 0.35 });
    RECIPES.bleat(a, d, { sad: true });
  },

  reload: (a, d) => {
    a._burst(d, { freq: 1800, q: 3, dur: 0.05, gain: 0.28 });
    a._burst(d, { freq: 900, q: 3, dur: 0.06, gain: 0.3, when: 0.14 });
    a._burst(d, { freq: 2400, q: 4, dur: 0.04, gain: 0.24, when: 0.3 });
  },
  pickup: (a, d) => {
    a._tone(d, { freq: 700, type: 'sine', dur: 0.09, gain: 0.22 });
    a._tone(d, { freq: 1050, type: 'sine', dur: 0.12, gain: 0.2, when: 0.07 });
  },
  chest: (a, d) => {
    a._burst(d, { freq: 600, q: 1.2, dur: 0.25, gain: 0.35, sweep: 1.8 });
    for (let i = 0; i < 4; i++) {
      a._tone(d, { freq: 800 * Math.pow(1.26, i), type: 'sine', dur: 0.2, gain: 0.14, when: 0.06 * i });
    }
  },

  // Le bêlement : oscillateur en dents de scie, vibrato rapide, formants de chevre.
  bleat: (a, d, opts = {}) => {
    const t = a.ctx.currentTime;
    const dur = opts.sad ? 0.75 : 0.5;
    const base = (opts.sad ? 210 : 300) * (0.9 + Math.random() * 0.25);
    const o = a.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(base * 1.15, t);
    o.frequency.exponentialRampToValueAtTime(base * 0.8, t + dur);

    // vibrato : c'est lui qui fait le « bêêê »
    const lfo = a.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = opts.sad ? 14 : 22;
    const lfoG = a.ctx.createGain();
    lfoG.gain.value = base * 0.16;
    lfo.connect(lfoG); lfoG.connect(o.frequency);

    // deux formants pour la couleur vocale
    const f1 = a.ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.frequency.value = 780; f1.Q.value = 5;
    const f2 = a.ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.frequency.value = 1900; f2.Q.value = 7;
    const mix = a.ctx.createGain(); mix.gain.value = 0.5;

    const g = a.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34, t + 0.05);
    g.gain.setValueAtTime(0.34, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    o.connect(f1); o.connect(f2);
    f1.connect(mix); f2.connect(mix);
    mix.connect(g); g.connect(d);
    o.start(t); lfo.start(t);
    o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    a._track(o);
  },

  horn: (a, d, opts = {}) => {
    const type = opts.type || 'scooter';
    if (type === 'boat') {
      a._tone(d, { freq: 110, type: 'sawtooth', dur: 1.1, gain: 0.4, attack: 0.08 });
      a._tone(d, { freq: 165, type: 'sawtooth', dur: 1.1, gain: 0.22, attack: 0.08 });
    } else if (type === 'f1') {
      a._tone(d, { freq: 880, type: 'square', dur: 0.35, gain: 0.28 });
      a._tone(d, { freq: 1320, type: 'square', dur: 0.35, gain: 0.2 });
    } else {
      a._tone(d, { freq: 440, type: 'square', dur: 0.4, gain: 0.3 });
      a._tone(d, { freq: 554, type: 'square', dur: 0.4, gain: 0.24 });
    }
  },

  ping: (a, d) => {
    a._tone(d, { freq: 1400, type: 'sine', dur: 0.18, gain: 0.24 });
    a._tone(d, { freq: 2100, type: 'sine', dur: 0.22, gain: 0.16, when: 0.06 });
  },
  storm: (a, d) => {
    a._burst(d, { freq: 260, q: 0.4, dur: 1.6, gain: 0.35, sweep: 0.5 });
    a._tone(d, { freq: 55, type: 'sine', dur: 1.8, gain: 0.28, slide: 1.6 });
  },
  land: (a, d) => {
    a._burst(d, { freq: 300, q: 1, dur: 0.16, gain: 0.34, sweep: 0.4 });
    a._tone(d, { freq: 90, type: 'sine', dur: 0.14, gain: 0.22, slide: 0.6 });
  },
  jump: (a, d) => a._tone(d, { freq: 420, type: 'triangle', dur: 0.12, gain: 0.16, slide: 1.5 }),

  countdown: (a, d) => a._tone(d, { freq: 660, type: 'square', dur: 0.13, gain: 0.26 }),
  victory: (a, d) => {
    [523, 659, 784, 1047].forEach((f, i) => {
      a._tone(d, { freq: f, type: 'triangle', dur: 0.45, gain: 0.26, when: i * 0.13 });
    });
    RECIPES.bleat(a, d);
  },
  defeat: (a, d) => {
    [440, 392, 330, 262].forEach((f, i) => {
      a._tone(d, { freq: f, type: 'triangle', dur: 0.4, gain: 0.2, when: i * 0.15 });
    });
  },

  ui_click: (a, d) => a._tone(d, { freq: 1200, type: 'square', dur: 0.04, gain: 0.12 }),
  ui_hover: (a, d) => a._tone(d, { freq: 900, type: 'sine', dur: 0.03, gain: 0.06 }),
};

export default AudioEngine;
