// Point d'entree du client : profil, salon, lancement de la partie.

import { S2C, ACT, ERR_TEXT, ROOM_STATE } from '/shared/protocol.js';
import { GOAT_SKINS, GOAT_NAMES, MATCH } from '/shared/constants.js';
import { Net } from './net.js';
import { InputManager } from './input.js';
import { LobbyUI } from './ui/lobby.js';
import { HUD } from './ui/hud.js';
import { AudioEngine } from './audio.js';
import { Game } from './game.js';

const STORE_KEY = 'koroyale.profile';

class App {
  constructor() {
    this.canvas = document.getElementById('scene');
    this.uiRoot = document.getElementById('ui');
    this.hudRoot = document.getElementById('hud');
    this.touchRoot = document.getElementById('touch');

    this.profile = loadProfile();
    this.quality = this.profile.quality || autoQuality();
    this.room = null;
    this.game = null;
    this.screen = 'connecting';

    this.net = new Net();
    this.audio = new AudioEngine();
    this.audio.setVolume(this.profile.volume ?? 0.7);
    this.audio.setEnabled(this.profile.sound !== false);

    this.input = new InputManager({
      canvas: this.canvas,
      touchRoot: this.touchRoot,
      onAction: (a) => this.onAction(a),
      onDeviceChange: (d) => { this.lastDevice = d; },
    });
    this.input.setSensitivity(this.profile.sensitivity ?? 1);
    this.input.setInvertY(!!this.profile.invertY);

    this.hud = new HUD({ root: this.hudRoot });
    this.lobby = new LobbyUI({
      root: this.uiRoot,
      actions: this.lobbyActions(),
      skins: GOAT_SKINS,
      maxLobby: MATCH.maxLobbySize,
    });

    this.wireNet();
    this.net.connect();
    this.setScreen('connecting');

    // lien d'invitation : /?salon=XXXXX
    const params = new URLSearchParams(location.search);
    this.pendingJoin = (params.get('salon') || params.get('room') || '').toUpperCase() || null;
  }

  // -------------------------------------------------------------------------

  lobbyActions() {
    const net = this.net;
    return {
      quickPlay: () => { this.audio.unlock(); net.quickPlay(); },
      createRoom: (settings, isPublic, name) => { this.audio.unlock(); net.createRoom(settings, isPublic, name); },
      joinRoom: (code) => { this.audio.unlock(); net.joinRoom(code); },
      leave: () => net.leaveRoom(),
      setReady: (r) => net.setReady(r),
      setSettings: (s) => net.setSettings(s),
      addBot: () => net.addBot(),
      removeBot: () => net.removeBot(),
      kick: (id) => net.kick(id),
      start: () => net.startMatch(),
      chat: (t) => net.chat(t),
      setProfile: (p) => {
        Object.assign(this.profile, p);
        saveProfile(this.profile);
        net.setProfile(this.profile.name, this.profile.skin);
      },
      setOption: (k, v) => {
        this.profile[k] = v;
        saveProfile(this.profile);
        if (k === 'volume') this.audio.setVolume(v);
        if (k === 'sound') this.audio.setEnabled(v);
        if (k === 'sensitivity') this.input.setSensitivity(v);
        if (k === 'invertY') this.input.setInvertY(v);
        if (k === 'quality') this.quality = v;
      },
      getProfile: () => ({ ...this.profile, quality: this.quality }),
      inviteLink: () => (this.room ? `${location.origin}/?salon=${this.room.code}` : location.origin),
      backToMenu: () => { this.leaveMatch(); net.leaveRoom(); this.setScreen('menu'); },
    };
  }

  wireNet() {
    const net = this.net;

    net.on('state', (s) => {
      this.lobby.setConnection(s);
      if (s === 'open') {
        net.hello(this.profile.name, this.profile.skin);
        if (this.pendingJoin) { net.joinRoom(this.pendingJoin); this.pendingJoin = null; }
        else if (this.screen === 'connecting') this.setScreen('menu');
      } else if (s === 'closed' && this.game) {
        this.hud.setBanner?.('Connexion perdue — reconnexion…');
      }
    });

    net.on('welcome', (msg) => {
      this.lobby.setRooms(msg.rooms || []);
      if (this.screen === 'connecting' && !this.pendingJoin) this.setScreen('menu');
    });

    net.on(S2C.ROOM_LIST, (msg) => this.lobby.setRooms(msg.rooms || []));

    net.on(S2C.ROOM, (msg) => {
      this.room = msg.r;
      this.lobby.setRoom(this.room);
      if (this.room.state === ROOM_STATE.LOBBY || this.room.state === ROOM_STATE.COUNTDOWN) {
        if (this.screen !== 'room') this.setScreen('room');
      }
    });

    net.on(S2C.CHAT, (msg) => this.lobby.pushChat(msg.c));

    net.on(S2C.COUNTDOWN, (msg) => {
      this.lobby.setCountdown(msg.t);
      if (msg.t <= 3 && msg.t > 0) this.audio.play('countdown');
    });

    net.on(S2C.ERROR, (msg) => {
      this.lobby.setError(msg.t || ERR_TEXT[msg.c] || 'Erreur');
    });

    net.on(S2C.KICKED, () => {
      this.leaveMatch();
      this.room = null;
      this.lobby.setError('Vous avez été exclu du salon.');
      this.setScreen('menu');
    });

    net.on(S2C.MATCH_START, (msg) => this.startMatch(msg));

    net.on(S2C.SNAPSHOT, (msg) => {
      if (this.game) this.game.onSnapshot(msg.s);
    });

    net.on(S2C.EVENTS, (msg) => {
      if (this.game && msg.sb) this.game.onScoreboard(msg.sb);
    });

    net.on(S2C.MATCH_END, (msg) => {
      if (this.game) this.game.paused = false;
      this.lobby.setResults({
        results: msg.r,
        scoreboard: msg.sb,
        me: this.net.id,
      });
      this.setScreen('results');
      const won = msg.r.winners.some((w) => w.id === this.net.id);
      this.audio.play(won ? 'victory' : 'defeat');
      setTimeout(() => this.leaveMatch(), 600);
    });

    net.on('versionMismatch', () => {
      this.lobby.setError('Le jeu a été mis à jour : rechargez la page.');
    });
  }

  // -------------------------------------------------------------------------

  async startMatch(msg) {
    this.audio.unlock();
    this.setScreen('loading');
    await new Promise((r) => setTimeout(r, 30)); // laisse l'ecran de chargement s'afficher

    if (!this.game) {
      this.game = new Game({
        canvas: this.canvas,
        net: this.net,
        input: this.input,
        audio: this.audio,
        hud: this.hud,
        quality: this.quality,
      });
      await this.game.boot();
    }
    this.game.setRoster(msg.players, msg.you);
    this.game.start();
    this.setScreen('playing');
    this.input.setMode('glide');
    if (!this.input.isTouch) this.input.requestPointerLock();
    this.audio.startMusic('match');
  }

  leaveMatch() {
    if (!this.game) return;
    this.game.dispose();
    this.game = null;
    this.input.setMode('menu');
    this.input.exitPointerLock();
    this.audio.stopMusic();
  }

  onAction(a) {
    // actions locales d'interface
    if (a.type === 'ui') {
      switch (a.name) {
        case 'scoreboard': if (this.game) this.game.showScoreboard = a.down ?? !this.game.showScoreboard; break;
        case 'map': if (this.game) this.game.showMap = !this.game.showMap; break;
        case 'inventory': if (this.game) this.game.showInventory = !this.game.showInventory; break;
        case 'chat': this.hud.openChat?.((t) => this.net.chat(t)); break;
        case 'menu': this.toggleMenu(); break;
        default: break;
      }
      return;
    }
    // tout le reste part au serveur
    const { type, ...rest } = a;
    this.net.action(type, rest);

    // adaptation du mode d'entree
    if (type === ACT.ENTER_VEHICLE) this.input.setMode('vehicle');
    if (type === ACT.EXIT_VEHICLE) this.input.setMode('foot');
  }

  toggleMenu() {
    if (!this.game) return;
    this.game.paused = !this.game.paused;
    this.lobby.setPauseMenu(this.game.paused);
    if (this.game.paused) this.input.exitPointerLock();
    else if (!this.input.isTouch) this.input.requestPointerLock();
  }

  setScreen(name) {
    this.screen = name;
    this.lobby.setScreen(name);
    document.body.dataset.screen = name;
    const inGame = name === 'playing';
    this.hudRoot.hidden = !inGame;
    this.touchRoot.hidden = !inGame;
    this.canvas.style.visibility = (name === 'playing' || name === 'results') ? 'visible' : 'hidden';
  }

  /** Le mode d'entree suit l'etat du joueur (a pied / au volant / en vol). */
  syncInputMode() {
    if (!this.game || !this.game.latest) return;
    const snap = this.game.latest;
    const me = snap.ps.find((p) => p.i === this.game.myId);
    let mode = 'foot';
    if (snap.me.st === 2) mode = 'spectate';
    else if (me?.v) mode = 'vehicle';
    else if (snap.ip === 1 || snap.me.gl === 1) mode = 'glide';
    if (mode !== this._mode) { this._mode = mode; this.input.setMode(mode); }
  }
}

// ---------------------------------------------------------------------------

function loadProfile() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { p = {}; }
  if (!p.name) p.name = GOAT_NAMES[Math.floor(Math.random() * GOAT_NAMES.length)];
  if (!p.skin) p.skin = GOAT_SKINS[Math.floor(Math.random() * GOAT_SKINS.length)].id;
  return p;
}

function saveProfile(p) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* mode prive */ }
}

function autoQuality() {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency || 4;
  if (mobile || cores <= 4) return 'low';
  if (cores <= 8) return 'medium';
  return 'high';
}

const app = new App();
setInterval(() => app.syncInputMode(), 120);
window.KoRoyale = app;

// evite le menu contextuel qui gene la visee a la souris
window.addEventListener('contextmenu', (e) => {
  if (document.body.dataset.screen === 'playing') e.preventDefault();
});
