// Le moteur de jeu cote client : scene, entites, camera, prediction, boucle de rendu.

import * as THREE from 'three';

import {
  TICK_DT, TICK_RATE, INTERP_DELAY, GOAT, PSTATE, BTN, MATCH, ANIM,
  SEA_LEVEL, VEHICLE_TYPES, WORLD_HALF,
} from '/shared/constants.js';
import { ACT, EV, FLAG } from '/shared/protocol.js';
import { clamp, lerp, damp, wrapAngle, angleDelta, dirFromYawPitch } from '/shared/math.js';
import { buildMap, terrainHeight, zoneNameAt, POIS } from '/shared/mapdata.js';
import { CollisionWorld } from '/shared/collision.js';
import { stepGoat, stepGlide, stepVehicle } from '/shared/movement.js';
import { WEAPONS, ITEMS, RARITY, weaponMagazine } from '/shared/loot.js';

import { buildWorld } from './render/world.js';
import { createGoatModel, disposeGoatCache } from './render/goat.js';
import { createVehicleModel, disposeVehicleCache } from './render/vehicles.js';
import { Effects } from './render/effects.js';
import { PickupRenderer } from './render/pickups.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

const CAM = {
  distance: 4.6,
  height: 1.55,
  shoulder: 0.75,
  aimDistance: 2.4,
  aimShoulder: 0.5,
  vehicleDistance: 9.5,
  vehicleHeight: 3.4,
  fov: 74,
  aimFov: 52,
  scopeFovDiv: 1,
};

export class Game {
  constructor(opts) {
    this.canvas = opts.canvas;
    this.net = opts.net;
    this.input = opts.input;
    this.audio = opts.audio;
    this.hud = opts.hud;
    this.quality = opts.quality || 'medium';
    this.onExit = opts.onExit || (() => {});

    this.myId = null;
    this.players = new Map();   // id -> {model, snaps:[], render:{}, info}
    this.vehicles = new Map();
    this.roster = new Map();
    this.snapshots = [];
    this.latest = null;
    this.serverTimeOffset = 0;
    this.running = false;
    this.paused = false;

    this.local = null;          // etat physique predit
    this.pending = [];          // entrees non confirmees
    this.seq = 0;
    this.accumulator = 0;
    this.posError = new THREE.Vector3();
    this.localVehicle = null;   // copie predite du vehicule pilote

    this.killfeed = [];
    this.marks = [];
    this.scoreboard = [];
    this.message = null;
    this.messageUntil = 0;
    this.hitMarker = 0;
    this.hitMarkerHead = false;
    this.damageFlash = 0;
    this.lastDamageDir = 0;
    this.fps = 60;
    this._fpsAcc = 0; this._fpsFrames = 0;
    this.showScoreboard = false;
    this.showMap = false;
    this.showInventory = false;
    this.recoil = { yaw: 0, pitch: 0 };
    this.grenadeCharge = 0;
    this.spectateName = null;
    this.results = null;
  }

  // -------------------------------------------------------------------------
  // Mise en place
  // -------------------------------------------------------------------------

  async boot() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality === 'low' ? 1 : 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    if (this.quality === 'high') {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAM.fov, window.innerWidth / window.innerHeight, 0.1, 3000);
    this.camera.rotation.order = 'YXZ';

    // le monde est deterministe : on le reconstruit a l'identique cote client
    this.map = buildMap();
    this.collision = new CollisionWorld(this.map.colliders, terrainHeight, { half: WORLD_HALF });
    this.ctx = { world: this.collision, terrain: terrainHeight };

    this.world = buildWorld(this.scene, { quality: this.quality, renderer });
    this.effects = new Effects(this.scene, { quality: this.quality, camera: this.camera });
    this.pickups = new PickupRenderer(this.scene, { quality: this.quality });

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  resize() {
    if (!this.renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setRoster(list, myId) {
    this.myId = myId;
    this.roster.clear();
    for (const r of list) this.roster.set(r.i, { name: r.n, skin: r.k, bot: !!r.bot, team: r.tm ?? 0 });
  }

  start() {
    this.running = true;
    this.lastFrame = performance.now();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    for (const p of this.players.values()) { p.model.dispose(); this.scene.remove(p.model.root); }
    for (const v of this.vehicles.values()) { v.model.dispose(); this.scene.remove(v.model.root); }
    this.players.clear(); this.vehicles.clear();
    this.pickups?.dispose();
    this.effects?.dispose();
    this.world?.dispose();
    disposeGoatCache();
    disposeVehicleCache();
    this.renderer?.dispose();
  }

  // -------------------------------------------------------------------------
  // Reception
  // -------------------------------------------------------------------------

  onSnapshot(snap) {
    const now = performance.now();
    snap._recv = now;
    this.snapshots.push(snap);
    while (this.snapshots.length > 24) this.snapshots.shift();
    this.latest = snap;

    if (!this.serverStart) { this.serverStart = snap.t; this.clientStart = now; }

    // --- reconciliation de notre propre chevre ---
    const mine = snap.ps.find((p) => p.i === this.myId);
    if (mine) this.reconcile(mine, snap);

    // --- evenements ---
    if (snap.ev) for (const ev of snap.ev) this.handleEvent(ev);

    // --- entites ---
    this.syncPlayers(snap);
    this.syncVehicles(snap);
    this.pickups.syncChests(snap.ch.map((c) => ({ id: c.i, x: c.x, y: c.y, z: c.z, yaw: c.a, kind: c.k, opened: !!c.o })));
    this.pickups.syncLoot(snap.lo.map((l) => ({
      id: l.i, x: l.x, y: l.y, z: l.z, type: l.t, itemId: l.d, rarity: l.r, count: l.c,
    })));
    this.pickups.syncDrops(snap.dr.map((d) => ({ id: d.i, x: d.x, y: d.y, z: d.z, falling: !!d.f })));

    this.effects.setStorm({
      cx: snap.st.cx, cz: snap.st.cz, radius: snap.st.r,
      nextCx: snap.st.nx, nextCz: snap.st.nz, nextRadius: snap.st.nr, phase: snap.st.p,
    });
  }

  onScoreboard(rows) { this.scoreboard = rows; }

  handleEvent(ev) {
    const eff = this.effects;
    switch (ev.e) {
      case EV.SHOT: {
        const from = { x: ev.x, y: ev.y, z: ev.z };
        if (ev.w === 'hoof') { this.audio?.play('melee', from); break; }
        const to = ev.ex !== undefined ? { x: ev.ex, y: ev.ey, z: ev.ez } : null;
        const dir = to
          ? { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
          : { x: ev.dx, y: ev.dy, z: ev.dz };
        eff.muzzleFlash(from, dir, 1);
        if (to) {
          eff.tracer(from, to, { color: 0xfff0b0 });
          if (ev.s === 2 || ev.s === 0) {
            eff.impact(to, { x: ev.nx ?? 0, y: ev.ny ?? 1, z: ev.nz ?? 0 }, ev.sf ?? 0);
          } else if (ev.s === 1) {
            eff.bloodPuff(to, 1);
          }
        }
        this.audio?.play(`shot_${ev.w}`, from);
        if (ev.p === this.myId) this.applyRecoil(ev.w);
        break;
      }
      case EV.HIT: {
        if (ev.by === this.myId && ev.t !== this.myId) {
          this.hitMarker = 0.25;
          this.hitMarkerHead = !!ev.hs;
          this.audio?.play(ev.hs ? 'headshot' : 'hit');
          const target = this.players.get(ev.t);
          if (target) {
            eff.damageNumber(target.render, ev.d, { crit: !!ev.hs, shield: ev.sh > 0 });
          }
        }
        if (ev.t === this.myId) {
          this.damageFlash = 0.6;
          const src = ev.by ? this.players.get(ev.by) : null;
          if (src) this.lastDamageDir = Math.atan2(src.render.x - this.local.x, src.render.z - this.local.z);
          this.input?.vibrate?.(0.4, 0.2, 120);
        }
        break;
      }
      case EV.KILL: {
        this.killfeed.push({
          killer: ev.kn, victim: ev.vn, weapon: ev.w, dist: ev.dist, zone: ev.z,
          mine: ev.k === this.myId, me: ev.v === this.myId, at: performance.now(),
        });
        while (this.killfeed.length > 6) this.killfeed.shift();
        if (ev.k === this.myId) { this.setMessage(`Éliminé : ${ev.vn}`, 2200); this.audio?.play('kill'); }
        if (ev.v === this.myId) this.audio?.play('death');
        break;
      }
      case EV.DOWN:
        if (ev.k === this.myId) this.setMessage('Chèvre à terre !', 1800);
        break;
      case EV.EXPLOSION:
        eff.explosion({ x: ev.x, y: ev.y, z: ev.z }, ev.r);
        this.audio?.play('explosion', { x: ev.x, y: ev.y, z: ev.z });
        break;
      case EV.CHEST:
        this.audio?.play('chest', null);
        break;
      case EV.PICKUP:
        if (ev.p === this.myId) { this.setMessage(ev.l, 1400); this.audio?.play('pickup'); }
        break;
      case EV.VEHICLE_DESTROYED:
        eff.explosion({ x: ev.x, y: ev.y + 0.8, z: ev.z }, 8);
        this.audio?.play('explosion', { x: ev.x, y: ev.y, z: ev.z });
        break;
      case EV.STORM_PHASE:
        this.setMessage(ev.s ? 'La brume avance !' : 'La brume se prépare…', 2600);
        this.audio?.play('storm');
        break;
      case EV.SUPPLY_DROP:
        this.setMessage('Largage de ravitaillement repéré', 2600);
        break;
      case EV.MARK:
        this.marks.push({ x: ev.x, z: ev.z, at: performance.now(), by: ev.p });
        while (this.marks.length > 8) this.marks.shift();
        this.effects.ping({ x: ev.x, y: terrainHeight(ev.x, ev.z), z: ev.z }, 0x5ad1ff);
        this.audio?.play('ping');
        break;
      case EV.HORN:
        this.audio?.play('horn', { x: ev.x, y: ev.y, z: ev.z });
        break;
      case EV.LAND:
        if (ev.p === this.myId) this.audio?.play('land');
        break;
      case EV.EMOTE:
        this.audio?.play('bleat', this.players.get(ev.p)?.render || null);
        break;
      default: break;
    }
  }

  setMessage(text, ms = 1800) {
    this.message = text;
    this.messageUntil = performance.now() + ms;
  }

  applyRecoil(weaponId) {
    const def = WEAPONS[weaponId];
    if (!def) return;
    this.recoil.pitch += def.recoil * 0.012;
    this.recoil.yaw += (Math.random() - 0.5) * def.recoil * 0.008;
    this.input?.vibrate?.(0.25, 0.45, 60);
  }

  // -------------------------------------------------------------------------
  // Prediction
  // -------------------------------------------------------------------------

  ensureLocal(mine, snap) {
    if (this.local) return;
    this.local = {
      x: mine.x, y: mine.y, z: mine.z,
      vx: 0, vy: 0, vz: 0,
      onGround: false, jumps: 0, coyote: 0, jumpHeld: false,
      climbing: false, swimming: false, crouching: false, sprinting: false,
      speed: 0, anim: mine.s, surface: 0, landSpeed: 0,
      parachute: !!(mine.f & FLAG.PARACHUTE),
    };
    void snap;
  }

  reconcile(mine, snap) {
    this.ensureLocal(mine, snap);
    const L = this.local;

    // en avion, en vol ou en vehicule : le serveur fait foi, on lisse
    const gliding = (mine.f & FLAG.GLIDING) !== 0;
    const inVehicle = !!mine.v;
    if (gliding || inVehicle || snap.me.st === PSTATE.DEAD) {
      this.posError.set(L.x - mine.x, L.y - mine.y, L.z - mine.z);
      if (this.posError.length() > 12) this.posError.set(0, 0, 0);
      L.x = mine.x; L.y = mine.y; L.z = mine.z;
      L.parachute = (mine.f & FLAG.PARACHUTE) !== 0;
      this.pending.length = 0;
      return;
    }

    // on repart de l'etat autoritaire (position ET elan : sans la vitesse, rejouer les
    // entrees repart d'une inertie fausse et la correction oscille)
    const before = { x: L.x, y: L.y, z: L.z };
    L.x = mine.x; L.y = mine.y; L.z = mine.z;
    const ph = snap.me.ph;
    if (ph) {
      L.vx = ph.vx; L.vy = ph.vy; L.vz = ph.vz;
      L.onGround = ph.g === 1;
      L.jumps = ph.j;
      L.coyote = ph.c;
    }

    // ...et on rejoue les entrees que le serveur n'a pas encore traitees
    const acked = snap.sq || 0;
    let i = 0;
    while (i < this.pending.length && this.pending[i].seq <= acked) i++;
    this.pending.splice(0, i);
    for (const p of this.pending) stepGoat(L, p.cmd, this.ctx, TICK_DT);

    // l'ecart residuel est absorbe visuellement en quelques images
    const ex = before.x - L.x, ey = before.y - L.y, ez = before.z - L.z;
    const err = Math.hypot(ex, ey, ez);
    if (err > 0.02 && err < 6) this.posError.set(ex, ey, ez);
    else this.posError.set(0, 0, 0);
  }

  // -------------------------------------------------------------------------
  // Entites distantes
  // -------------------------------------------------------------------------

  syncPlayers(snap) {
    const seen = new Set();
    const t = snap.t;
    for (const ps of snap.ps) {
      seen.add(ps.i);
      let e = this.players.get(ps.i);
      if (!e) {
        const info = this.roster.get(ps.i) || { name: ps.n || 'Chèvre', skin: ps.k || 'alpine', bot: !!ps.bot };
        const model = createGoatModel({
          skin: ps.k || info.skin, isLocal: ps.i === this.myId,
          name: ps.n || info.name, teamColor: null,
        });
        this.scene.add(model.root);
        model.setNameTag(ps.i === this.myId ? null : (ps.n || info.name), 0xffffff);
        e = {
          id: ps.i, model, info, snaps: [],
          render: { x: ps.x, y: ps.y, z: ps.z, yaw: ps.a, pitch: ps.b, anim: ps.s, flags: ps.f, speed: 0, moveDir: { x: 0, z: 0 } },
        };
        this.players.set(ps.i, e);
      }
      e.snaps.push({ t, x: ps.x, y: ps.y, z: ps.z, yaw: ps.a, pitch: ps.b, anim: ps.s, flags: ps.f, v: ps.v, vs: ps.vs, w: ps.w, wr: ps.wr });
      while (e.snaps.length > 20) e.snaps.shift();
      e.lastSeen = performance.now();
      if (e.weaponId !== ps.w || e.rarity !== ps.wr) {
        e.weaponId = ps.w; e.rarity = ps.wr;
        e.model.setHeldWeapon(ps.w || null, ps.wr || null);
      }
    }
    for (const [id, e] of this.players) {
      if (seen.has(id)) continue;
      if (performance.now() - (e.lastSeen || 0) > 3000) {
        e.model.dispose();
        this.scene.remove(e.model.root);
        this.players.delete(id);
      } else {
        e.model.setVisible(false);
      }
    }
  }

  syncVehicles(snap) {
    const seen = new Set();
    const t = snap.t;
    for (const vs of snap.vs) {
      seen.add(vs.i);
      let e = this.vehicles.get(vs.i);
      if (!e) {
        const model = createVehicleModel(vs.t, { color: null, team: null });
        this.scene.add(model.root);
        e = {
          id: vs.i, type: vs.t, model, snaps: [],
          render: { x: vs.x, y: vs.y, z: vs.z, yaw: vs.a, pitch: vs.p, roll: vs.r, speed: vs.sp, steer: vs.st, wheelSpin: vs.w, brake: !!vs.b, grounded: true, health01: vs.h },
        };
        this.vehicles.set(vs.i, e);
      }
      e.snaps.push({ t, x: vs.x, y: vs.y, z: vs.z, yaw: vs.a, pitch: vs.p, roll: vs.r, speed: vs.sp, steer: vs.st, wheelSpin: vs.w, brake: !!vs.b, health: vs.h, seats: vs.s, destroyed: !!vs.d });
      while (e.snaps.length > 20) e.snaps.shift();
      e.lastSeen = performance.now();
      e.seats = vs.s;
      e.health01 = vs.h;
      e.fuel = vs.f;
      e.destroyed = !!vs.d;
      if (vs.hn) this.audio?.play('horn', { x: vs.x, y: vs.y, z: vs.z });
    }
    for (const [id, e] of this.vehicles) {
      if (seen.has(id)) continue;
      if (performance.now() - (e.lastSeen || 0) > 2000) {
        e.model.dispose();
        this.scene.remove(e.model.root);
        this.vehicles.delete(id);
      }
    }
  }

  /** Interpolation d'une entite a l'instant de rendu. */
  interpolate(snaps, renderTime, out) {
    if (!snaps.length) return false;
    if (snaps.length === 1 || renderTime >= snaps[snaps.length - 1].t) {
      Object.assign(out, snaps[snaps.length - 1]);
      return true;
    }
    if (renderTime <= snaps[0].t) { Object.assign(out, snaps[0]); return true; }
    for (let i = snaps.length - 1; i > 0; i--) {
      const b = snaps[i], a = snaps[i - 1];
      if (a.t <= renderTime && renderTime <= b.t) {
        const f = (renderTime - a.t) / Math.max(1, b.t - a.t);
        out.x = lerp(a.x, b.x, f);
        out.y = lerp(a.y, b.y, f);
        out.z = lerp(a.z, b.z, f);
        out.yaw = a.yaw + angleDelta(a.yaw, b.yaw) * f;
        out.pitch = lerp(a.pitch, b.pitch, f);
        out.anim = b.anim;
        out.flags = b.flags;
        out.v = b.v; out.vs = b.vs;
        out.speed = Math.hypot(b.x - a.x, b.z - a.z) / Math.max(0.001, (b.t - a.t) / 1000);
        out.moveDir = out.moveDir || { x: 0, z: 0 };
        const dl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        out.moveDir.x = (b.x - a.x) / dl;
        out.moveDir.z = (b.z - a.z) / dl;
        if (b.roll !== undefined) { out.roll = lerp(a.roll, b.roll, f); out.steer = lerp(a.steer, b.steer, f); out.wheelSpin = b.wheelSpin; out.brake = b.brake; out.health01 = b.health; }
        return true;
      }
    }
    Object.assign(out, snaps[snaps.length - 1]);
    return true;
  }

  // -------------------------------------------------------------------------
  // Boucle
  // -------------------------------------------------------------------------

  loop(now) {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    this._fpsAcc += dt; this._fpsFrames++;
    if (this._fpsAcc >= 0.5) { this.fps = this._fpsFrames / this._fpsAcc; this._fpsAcc = 0; this._fpsFrames = 0; }

    const frame = this.input.poll(dt);
    this._frame = frame;
    this.applyRecoilDecay(dt, frame);

    if (!this.paused) {
      this.fixedUpdate(dt, frame);
      this.updateRender(dt, now);
    }
    this.renderer.render(this.scene, this.camera);
    this.hud?.update(this.buildView(frame));
  }

  applyRecoilDecay(dt, frame) {
    if (this.recoil.pitch !== 0 || this.recoil.yaw !== 0) {
      this.input.setYawPitch(frame.yaw + this.recoil.yaw, frame.pitch + this.recoil.pitch);
      this.recoil.yaw = 0; this.recoil.pitch = 0;
    }
  }

  fixedUpdate(dt, frame) {
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= TICK_DT && steps < 4) {
      this.accumulator -= TICK_DT;
      steps++;
      this.tickLocal(frame);
    }
  }

  tickLocal(frame) {
    if (!this.local || !this.latest) return;
    const me = this.latest.me;
    const cmd = {
      moveX: frame.moveX, moveY: frame.moveY,
      yaw: frame.yaw, pitch: frame.pitch, buttons: frame.buttons,
    };
    this.net.sendInput(frame);
    const seq = this.net.inputSeq;

    const gliding = this.latest.ip || (me.gl === 1);
    const myPs = this.latest.ps.find((p) => p.i === this.myId);
    if (myPs?.v) { this.tickVehicle(frame, myPs); this.pending.length = 0; return; }
    this.localVehicle = null;
    if (me.st === PSTATE.DEAD || gliding) { this.pending.length = 0; return; }

    this.pending.push({ seq, cmd: { ...cmd } });
    while (this.pending.length > 60) this.pending.shift();
    stepGoat(this.local, cmd, this.ctx, TICK_DT);
  }

  /**
   * Prediction locale du vehicule que l'on pilote. Sans elle, le conducteur voit sa propre
   * voiture avec 100 ms de retard d'interpolation : injouable a 190 km/h.
   */
  tickVehicle(frame, myPs) {
    const e = this.vehicles.get(myPs.v);
    if (!e || myPs.vs !== 0) { this.localVehicle = null; return; }
    const srv = e.snaps[e.snaps.length - 1];
    if (!srv) return;
    let V = this.localVehicle;
    if (!V || V.id !== e.id) {
      V = this.localVehicle = {
        id: e.id, type: e.type,
        x: srv.x, y: srv.y, z: srv.z, yaw: srv.yaw, pitch: srv.pitch, roll: srv.roll,
        vx: 0, vy: 0, vz: 0, speed: srv.speed, steer: srv.steer,
        wheelSpin: srv.wheelSpin, grounded: true, health: 1, fuel: 100,
      };
    }
    // correction douce vers l'etat autoritaire (ou recalage brutal si on a trop derive)
    const err = Math.hypot(V.x - srv.x, V.y - srv.y, V.z - srv.z);
    if (err > 8) {
      V.x = srv.x; V.y = srv.y; V.z = srv.z; V.yaw = srv.yaw;
      V.vx = 0; V.vz = 0; V.speed = srv.speed;
    } else if (err > 0.05) {
      const k = 0.14;
      V.x += (srv.x - V.x) * k; V.y += (srv.y - V.y) * k; V.z += (srv.z - V.z) * k;
      V.yaw += angleDelta(V.yaw, srv.yaw) * k * 0.8;
      V.speed += (srv.speed - V.speed) * k;
    }
    stepVehicle(V, {
      throttle: clamp(frame.moveY, -1, 1),
      steer: clamp(frame.moveX, -1, 1),
      handbrake: (frame.buttons & BTN.HANDBRAKE) !== 0 || (frame.buttons & BTN.CROUCH) !== 0,
    }, this.ctx, TICK_DT);
  }

  updateRender(dt, now) {
    const renderTime = this.latest ? this.latest.t - INTERP_DELAY * 1000 : 0;

    // --- chevres ---
    for (const e of this.players.values()) {
      if (e.id === this.myId) {
        const r = e.render;
        // notre chevre suit la prediction, avec resorption de l'erreur
        this.posError.multiplyScalar(Math.exp(-14 * dt));
        r.x = this.local.x + this.posError.x;
        r.y = this.local.y + this.posError.y;
        r.z = this.local.z + this.posError.z;
        const snapMe = e.snaps[e.snaps.length - 1];
        r.anim = this.local.anim;
        r.flags = snapMe ? snapMe.flags : 0;
        r.speed = this.local.speed;
        r.pitch = this.currentPitch ?? 0;
        r.yaw = this.currentYaw ?? r.yaw;
        e.model.setVisible(this.latest?.me.st !== PSTATE.DEAD);
        e.model.update(r, dt);
        continue;
      }
      if (!this.interpolate(e.snaps, renderTime, e.render)) continue;
      const inVeh = !!e.render.v;
      e.model.setVisible(!inVeh || true);
      if (inVeh) {
        const veh = this.vehicles.get(e.render.v);
        if (veh && veh.model.seatAnchors[e.render.vs]) {
          veh.model.seatAnchors[e.render.vs].getWorldPosition(_v);
          e.render.x = _v.x; e.render.y = _v.y - 0.55; e.render.z = _v.z;
          e.render.anim = ANIM.DRIVE;
        }
      }
      e.model.update(e.render, dt);
    }

    // --- vehicules ---
    for (const e of this.vehicles.values()) {
      if (this.localVehicle && this.localVehicle.id === e.id) {
        const V = this.localVehicle;
        e.render.x = V.x; e.render.y = V.y; e.render.z = V.z;
        e.render.yaw = V.yaw; e.render.pitch = V.pitch; e.render.roll = V.roll;
        e.render.speed = V.speed; e.render.steer = V.steer; e.render.wheelSpin = V.wheelSpin;
        e.render.grounded = V.grounded;
      } else {
        this.interpolate(e.snaps, renderTime, e.render);
      }
      e.render.health01 = e.health01 ?? 1;
      e.model.setDamage(e.render.health01);
      e.model.update(e.render, dt);
    }

    // --- camera ---
    this.updateCamera(dt);

    this.world.update(dt, this.camera, this.local || { x: 0, y: 0, z: 0 });
    this.effects.update(dt, this.camera);
    this.pickups.update(dt, this.camera, this.local || { x: 0, y: 0, z: 0 });
    this.pickups.setHighlight(this.interactTarget?.id ?? null);

    if (this.audio) {
      this.audio.listener(this.camera.position.x, this.camera.position.y, this.camera.position.z, this.currentYaw ?? 0);
    }

    if (this.hitMarker > 0) this.hitMarker = Math.max(0, this.hitMarker - dt);
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    void now;
  }

  updateCamera(dt) {
    const frame = this._frame;
    if (!frame) return;
    const yaw = frame.yaw;
    const pitch = frame.pitch;
    this.currentYaw = yaw;
    this.currentPitch = pitch;

    const me = this.players.get(this.myId);
    const meState = this.latest?.me;
    const spectating = this.latest?.spec;
    let px, py, pz;

    if (spectating) {
      const tgt = this.players.get(spectating);
      if (tgt) { px = tgt.render.x; py = tgt.render.y; pz = tgt.render.z; }
    }
    if (px === undefined && this.localVehicle) {
      const V = this.localVehicle;
      px = V.x; py = V.y; pz = V.z;
    }
    if (px === undefined) {
      if (this.local) { px = this.local.x + this.posError.x; py = this.local.y + this.posError.y; pz = this.local.z + this.posError.z; }
      else if (me) { px = me.render.x; py = me.render.y; pz = me.render.z; }
      else return;
    }

    const myPs = this.latest?.ps.find((p) => p.i === this.myId);
    const vehId = myPs?.v;
    const aiming = (frame.buttons & BTN.AIM) !== 0;
    const inPlane = this.latest?.ip === 1;
    const gliding = meState?.gl === 1;

    let dist, height, shoulder, fov;
    if (vehId) {
      const veh = this.vehicles.get(vehId);
      dist = CAM.vehicleDistance * (veh ? 1 + Math.min(0.5, Math.abs(veh.render.speed) / 90) : 1);
      height = CAM.vehicleHeight;
      shoulder = 0;
      fov = CAM.fov + (veh ? Math.min(16, Math.abs(veh.render.speed) * 0.28) : 0);
    } else if (inPlane || gliding) {
      dist = 7; height = 2.2; shoulder = 0; fov = CAM.fov + 6;
    } else if (aiming) {
      const def = meState ? WEAPONS[this.currentWeaponId()] : null;
      dist = CAM.aimDistance; height = CAM.height; shoulder = CAM.aimShoulder;
      fov = def?.scope ? CAM.aimFov / def.scope * 1.6 : CAM.aimFov;
    } else {
      dist = CAM.distance; height = CAM.height; shoulder = CAM.shoulder;
      fov = CAM.fov;
    }

    this.camera.fov = damp(this.camera.fov, fov, 12, dt);
    this.camera.updateProjectionMatrix();

    // point de visee : la tete
    const headX = px, headY = py + height, headZ = pz;
    const fwd = dirFromYawPitch(yaw, pitch);
    const right = [Math.cos(yaw), 0, -Math.sin(yaw)];

    let cx = headX - fwd[0] * dist + right[0] * shoulder;
    let cy = headY - fwd[1] * dist + 0.1;
    let cz = headZ - fwd[2] * dist + right[2] * shoulder;

    // la camera ne traverse pas les murs
    const dx = cx - headX, dy = cy - headY, dz = cz - headZ;
    const len = Math.hypot(dx, dy, dz) || 1;
    const hit = this.collision.raycast(headX, headY, headZ, dx / len, dy / len, dz / len, len, { terrainStep: 0.6 });
    if (hit) {
      const t = Math.max(0.4, hit.t - 0.35);
      cx = headX + (dx / len) * t;
      cy = headY + (dy / len) * t;
      cz = headZ + (dz / len) * t;
    }
    cy = Math.max(cy, terrainHeight(cx, cz) + 0.35);

    const smooth = vehId ? 9 : 20;
    this.camera.position.x = damp(this.camera.position.x, cx, smooth, dt);
    this.camera.position.y = damp(this.camera.position.y, cy, smooth, dt);
    this.camera.position.z = damp(this.camera.position.z, cz, smooth, dt);
    _e.set(pitch, yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_e);
  }

  currentWeaponId() {
    const me = this.latest?.me;
    if (!me) return null;
    const s = me.inv[me.sl];
    return s && s.k === 'w' ? s.id : null;
  }

  // -------------------------------------------------------------------------
  // Interactions locales
  // -------------------------------------------------------------------------

  /** Ce que le joueur peut faire ici et maintenant (affiche par le HUD). */
  computeInteract() {
    const L = this.local;
    const snap = this.latest;
    if (!L || !snap) return null;
    const myPs = snap.ps.find((p) => p.i === this.myId);
    if (myPs?.v) {
      const veh = this.vehicles.get(myPs.v);
      return { kind: 'exit', label: `Sortir du ${VEHICLE_TYPES[veh?.type]?.name ?? 'véhicule'}`, key: 'F', id: myPs.v };
    }
    let best = null, bestD = Infinity;
    for (const c of snap.ch) {
      if (c.o) continue;
      const d = Math.hypot(c.x - L.x, c.z - L.z);
      if (d < 2.6 && Math.abs(c.y - L.y) < 2.5 && d < bestD) {
        bestD = d;
        best = { kind: 'chest', label: 'Ouvrir le coffre', key: 'E', hold: true, id: c.i, progress: snap.me.ch?.p ?? 0 };
      }
    }
    if (!best) {
      for (const l of snap.lo) {
        const d = Math.hypot(l.x - L.x, l.z - L.z);
        if (d < 2.2 && Math.abs(l.y - L.y) < 2.2 && d < bestD) {
          bestD = d;
          best = { kind: 'loot', label: `Ramasser ${lootName(l)}`, key: 'E', id: l.i, rarity: l.r };
        }
      }
    }
    if (!best) {
      for (const v of snap.vs) {
        if (v.d) continue;
        const d = Math.hypot(v.x - L.x, v.z - L.z);
        if (d < 3.4 && Math.abs(v.y - L.y) < 3.2 && d < bestD) {
          const free = (v.s || []).some((s) => !s);
          if (!free) continue;
          bestD = d;
          best = { kind: 'vehicle', label: `Monter dans ${VEHICLE_TYPES[v.t]?.name ?? 'le véhicule'}`, key: 'F', id: v.i };
        }
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Modele de vue pour le HUD
  // -------------------------------------------------------------------------

  buildView(frame) {
    const snap = this.latest;
    if (!snap) return { phase: 'loading' };
    const me = snap.me;
    this.interactTarget = this.computeInteract();
    const now = performance.now();

    const slots = me.inv.map((s) => {
      if (!s) return null;
      if (s.k === 'w') {
        const def = WEAPONS[s.id];
        return {
          kind: 'weapon', id: s.id, name: def?.name ?? s.id, icon: def?.icon ?? '❔',
          rarity: s.r, color: RARITY[s.r]?.color ?? 0x9aa0a6,
          mag: s.m, maxMag: weaponMagazine(s.id, s.r), ammoType: def?.ammo ?? null,
        };
      }
      const def = ITEMS[s.id];
      return {
        kind: 'item', id: s.id, name: def?.name ?? s.id, icon: def?.icon ?? '❔',
        count: s.c, color: def?.color ?? 0xffffff,
      };
    });

    const myPs = snap.ps.find((p) => p.i === this.myId);
    const veh = myPs?.v ? this.vehicles.get(myPs.v) : null;

    const team = [];
    if (snap.ps) {
      for (const p of snap.ps) {
        const info = this.roster.get(p.i);
        if (!info || p.i === this.myId) continue;
        if (info.team !== undefined && myPs && info.team === this.roster.get(this.myId)?.team) {
          team.push({ name: info.name, downed: !!(p.f & FLAG.DOWNED) });
        }
      }
    }

    const stormD = Math.hypot(this.local ? this.local.x - snap.st.cx : 0, this.local ? this.local.z - snap.st.cz : 0);

    return {
      phase: snap.ph,
      alive: me.st !== PSTATE.DEAD,
      downed: me.st === PSTATE.DOWNED,
      health: me.hp, maxHealth: GOAT.maxHealth,
      shield: me.sh, maxShield: GOAT.maxShield,
      slots, activeSlot: me.sl, ammo: me.am,
      reloading: me.rl > 0 ? me.rl : 0,
      usingItem: me.ui,
      chestProgress: me.ch ? me.ch.p : 0,
      kills: me.kills, damage: me.dmg,
      aliveCount: snap.al, teamsAlive: snap.te,
      storm: {
        cx: snap.st.cx, cz: snap.st.cz, radius: snap.st.r,
        nextCx: snap.st.nx, nextCz: snap.st.nz, nextRadius: snap.st.nr,
        phase: snap.st.p, shrinking: !!snap.st.s, timeLeft: snap.st.t, dps: snap.st.d,
        inStorm: stormD > snap.st.r,
      },
      killfeed: this.killfeed.filter((k) => now - k.at < 7000),
      message: now < this.messageUntil ? this.message : null,
      interact: this.interactTarget,
      crosshair: {
        spread: this.crosshairSpread(frame),
        hit: this.hitMarker > 0,
        headshot: this.hitMarkerHead,
        aiming: (frame.buttons & BTN.AIM) !== 0,
        scoped: this.isScoped(frame),
      },
      damageFlash: this.damageFlash,
      damageDir: this.lastDamageDir,
      vehicle: veh ? {
        type: veh.type, name: VEHICLE_TYPES[veh.type]?.name,
        speedKmh: Math.abs(veh.render.speed) * 3.6,
        health: veh.health01, fuel: veh.fuel,
        seat: myPs.vs, seats: veh.seats || [],
      } : null,
      flight: snap.ph === 'flight' ? {
        inPlane: snap.ip === 1, t: snap.ft,
        from: snap.fp ? { x: snap.fp.fx, z: snap.fp.fz } : null,
        to: snap.fp ? { x: snap.fp.tx, z: snap.fp.tz } : null,
        altitude: this.local ? this.local.y : 0,
      } : null,
      gliding: me.gl === 1 ? {
        parachute: me.pa === 1,
        altitude: (this.local?.y ?? 0) - terrainHeight(this.local?.x ?? 0, this.local?.z ?? 0),
      } : null,
      spectating: snap.spec ? { name: this.roster.get(snap.spec)?.name ?? '?' } : null,
      minimap: {
        x: this.local?.x ?? 0, z: this.local?.z ?? 0, yaw: this.currentYaw ?? 0,
        pois: POIS,
        marks: this.marks.filter((m) => now - m.at < 12000),
        drops: snap.dr,
        chests: snap.ch,
        teammates: [],
      },
      zone: zoneNameAt(this.local?.x ?? 0, this.local?.z ?? 0),
      scoreboard: this.scoreboard,
      showScoreboard: this.showScoreboard,
      showMap: this.showMap,
      showInventory: this.showInventory,
      ping: Math.round(this.net.latency),
      fps: Math.round(this.fps),
      device: this.input.lastDevice,
      touch: this.input.isTouch,
    };
  }

  crosshairSpread(frame) {
    const id = this.currentWeaponId();
    const def = id ? WEAPONS[id] : null;
    if (!def) return 0.2;
    const aiming = (frame.buttons & BTN.AIM) !== 0;
    let s = aiming ? def.spread[1] : def.spread[0];
    if (this.local) {
      if (!this.local.onGround) s *= 1.7;
      else if (this.local.speed > GOAT.walkSpeed) s *= 1.45;
      else if (this.local.crouching) s *= 0.7;
    }
    return s;
  }

  isScoped(frame) {
    const id = this.currentWeaponId();
    const def = id ? WEAPONS[id] : null;
    return !!(def?.scope && (frame.buttons & BTN.AIM));
  }
}

function lootName(l) {
  if (l.t === 'weapon') return WEAPONS[l.d]?.name ?? l.d;
  if (l.t === 'item') return `${ITEMS[l.d]?.name ?? l.d}${l.c > 1 ? ` x${l.c}` : ''}`;
  return `Munitions x${l.c}`;
}

export { CAM };
