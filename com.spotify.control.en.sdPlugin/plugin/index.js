'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Auth } = require('./lib/auth');
const { SpotifyApi, AuthError } = require('./lib/spotify');
const render = require('./lib/render');
const { getBuffer, dataUrlFromBuffer, clamp, fmtTime } = require('./lib/util');
const { averageLuminance } = require('./lib/luma');
const { log, LOG_FILE, setEnabled } = require('./lib/log');

// "Write plugin log" is a user setting (default: OFF). When off, log() writes
// nothing, so the plugin uses no resources for logging. Stored in global settings.
let logEnabled = false;

log('Plugin started, argv:', process.argv);

// WebSocket: use the global one (Node >= 20.10), otherwise the bundled fallback
let WSImpl = (typeof WebSocket === 'function') ? WebSocket : null;
if (!WSImpl) {
  WSImpl = require('./lib/ws-client');
}

/* ============================== SDK ============================== */

class Plugin {
  constructor() {
    this.port = process.argv[3];
    this.uuid = process.argv[5];
    this.registerEvent = process.argv[7];
    this.currentPI = { action: null, context: null };
    this.actions = {};     // short action name -> Action
    this.contextAction = {}; // context -> short name
    this.ws = null;
    this.connect();
  }

  connect() {
    try {
      this.ws = new WSImpl('ws://127.0.0.1:' + this.port);
    } catch (e) {
      log('Failed to create WebSocket:', e && e.message || e);
      return;
    }
    this.ws.onopen = () => {
      log('WebSocket opened, registering');
      this.send({ event: this.registerEvent, uuid: this.uuid });
      this.getGlobalSettings();
    };
    this.ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      try { this.handle(data); } catch (e) { log('Error handling message:', e); }
    };
    this.ws.onclose = () => { log('WebSocket closed'); process.exit(0); };
    this.ws.onerror = (e) => log('WebSocket error:', e && e.message || e);
  }

  send(obj) {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  }

  setImage(context, image) { this.send({ event: 'setImage', context, payload: { target: 0, image } }); }
  setTitle(context, title) { this.send({ event: 'setTitle', context, payload: { target: 0, title: String(title) } }); }
  setState(context, state) { this.send({ event: 'setState', context, payload: { state } }); }
  showAlert(context) { this.send({ event: 'showAlert', context }); }
  setSettings(context, payload) { this.send({ event: 'setSettings', context, payload }); }
  setGlobalSettings(payload) { this.send({ event: 'setGlobalSettings', context: this.uuid, payload }); }
  getGlobalSettings() { this.send({ event: 'getGlobalSettings', context: this.uuid }); }
  openUrl(url) { this.send({ event: 'openUrl', payload: { url } }); }

  sendToPI(payload) {
    const { action, context } = this.currentPI;
    if (!action || !context) return;
    this.send({ event: 'sendToPropertyInspector', action, context, payload });
  }

  actionFor(context) {
    const name = this.contextAction[context];
    return name ? this.actions[name] : null;
  }

  // First context of an action button (the panel sends context = plugin uuid,
  // but settings must be applied to the specific button context)
  firstContextFor(short) {
    for (const key of Object.keys(this.contextAction)) {
      if (this.contextAction[key] === short) return key;
    }
    return null;
  }

  handle(data) {
    // Log panel messages (with secrets masked) — this is the main
    // diagnostic tool for settings and login issues.
    let pl = data.payload;
    if (pl && typeof pl === 'object') {
      try {
        const copy = JSON.parse(JSON.stringify(pl));
        if (copy && copy.clientSecret && copy.clientSecret !== '********') copy.clientSecret = '***';
        const spot = copy && copy.settings && copy.settings.spotify;
        if (spot) {
          if (spot.accessToken) spot.accessToken = '***';
          if (spot.refreshToken) spot.refreshToken = '***';
        }
        pl = copy;
      } catch (e) { /* ignore */ }
    }
    log('Message from StreamDock:', data.event, data.action || '', pl !== undefined ? JSON.stringify(pl) : '');
    if (data.event === 'didReceiveGlobalSettings') {
      const gs = (data.payload && data.payload.settings) || {};
      const spot = gs.spotify || null;
      // logging on/off — a global user setting (default: off)
      if (typeof gs.logEnabled === 'boolean') {
        logEnabled = gs.logEnabled;
        setEnabled(logEnabled);
      }
      // The plugin file is the source of truth (written synchronously on every token change),
      // while StreamDock global settings may be stale. Use them only if the file is missing.
      if (!auth.hasToken() && spot) auth.fromJSON(spot);
      if (auth.hasToken()) {
        state.empty = 'none';
        poll();
      }
      logScopes(); // token already loaded — log the actual scopes
      renderAll(true);
      pushAuthState();
      return;
    }

    const short = data.action ? String(data.action).split('.').pop() : null;
    const action = short ? this.actions[short] : null;
    const ctx = data.context;
    const settings = (data.payload && data.payload.settings) || {};

    switch (data.event) {
      case 'willAppear':
        this.contextAction[ctx] = short;
        if (action) action.willAppear(ctx, settings);
        break;
      case 'willDisappear':
        if (action) action.willDisappear(ctx);
        delete this.contextAction[ctx];
        break;
      case 'didReceiveSettings':
        if (action) action.receiveSettings(ctx, settings);
        break;
      case 'keyDown':
        // The device may have blanked keys during idle — redraw everything
        // so the whole panel comes back on the first press.
        bumpAll();
        if (action) action.keyDown(ctx);
        break;
      case 'keyUp':
        if (action) action.keyUp(ctx);
        break;
      case 'dialRotate':
        // Same as keyDown — redraw everything (debounced, the encoder sends
        // many ticks per turn) in case the device blanked during idle.
        if (Date.now() - lastDialBump > 2000) {
          lastDialBump = Date.now();
          bumpAll();
        }
        if (action) action.dialRotate(ctx, (data.payload && data.payload.ticks) || 0);
        break;
      case 'dialDown':
      case 'dialPress':
        if (action) action.dialDown(ctx);
        break;
      case 'propertyInspectorDidAppear':
        this.currentPI = { action: data.action, context: ctx };
        if (action) action.piAppear(ctx);
        break;
      case 'propertyInspectorDidDisappear':
        if (this.currentPI.context === ctx) this.currentPI = { action: null, context: null };
        break;
      case 'sendToPlugin':
        // panel message — this also tells us which panel is currently open
        this.currentPI = { action: data.action, context: ctx };
        if (action) action.piMessage(ctx, data.payload);
        break;
      default:
        break;
    }
  }
}

const plugin = new Plugin();

/* ============================== Auth / API ============================== */

const auth = new Auth({
  onStateChange: () => {
    plugin.setGlobalSettings({ spotify: auth.toJSON(), logEnabled });
  },
  openUrl: (url) => plugin.openUrl(url)
});

// Diagnostics: the token's actual scopes (is user-library-read present for likes)
function logScopes() {
  const sc = auth.scopes();
  if (sc === null) return log('[scopes] no token');
  const hasLib = sc.indexOf('user-library-read') !== -1;
  log('[scopes]', sc.join(', ') || '(empty)', hasLib ? '— user-library-read present ✓' : '— user-library-read MISSING ✗ (likes will not work; re-login required)');
}

const spotify = new SpotifyApi(auth);

/* ============================== State ============================== */

const state = {
  empty: 'noauth', // noauth | nodevice | notrack | premium | none
  track: null,     // { id, name, artists, durationMs, cover, coverSmall, uri }
  isPlaying: false,
  progressMs: 0,
  repeat: 'off',
  shuffle: false,
  liked: false,
  likedKnown: false,
  likeRetryAt: 0,
  like403At: 0,
  likeLegacy: false, // legacy /v1/me/library endpoint works better than the new one — use it
  library403: false,
  volume: null,       // 0..100, active device volume (from /me/player)
  deviceId: null,     // active device id (needed for /volume)
  lastPoll: 0,
  endPollId: null, // track id we already fired the end-of-track poll for
  _lastTick: 0
};

/* ============================== Like cache ============================== */

// The like status per trackId is saved to disk so the button shows the
// correct state immediately on startup (no "empty" heart).
const LIKE_CACHE_FILE = path.join(os.homedir(), '.spotify-control-likecache.json');

function loadLikeCache() {
  try {
    state.likedCache = JSON.parse(fs.readFileSync(LIKE_CACHE_FILE, 'utf8')) || {};
  } catch (e) {
    state.likedCache = {};
  }
}

function saveLikeCache() {
  try {
    fs.writeFileSync(LIKE_CACHE_FILE, JSON.stringify(state.likedCache));
  } catch (e) { /* ignore */ }
}

loadLikeCache();

/* ============================== Actions ============================== */

class Action {
  constructor(name, defaults) {
    this.name = name;
    this.defaults = defaults || {};
    this.contexts = new Set();
    this.settings = {};
    this.icons = new Map();
    this.sig = new Map();
    this.pressed = new Set();
  }

  willAppear(ctx, settings) {
    this.contexts.add(ctx);
    this.setSettings(ctx, settings);
    this.render(ctx);
  }

  willDisappear(ctx) {
    this.contexts.delete(ctx);
    this.pressed.delete(ctx);
    delete this.settings[ctx];
    this.icons.delete(ctx);
    this.sig.delete(ctx);
  }

  // Press effect: highlight while the button is held
  keyDown(ctx) {
    this.pressed.add(ctx);
    this.render(ctx, true);
  }

  keyUp(ctx) {
    this.pressed.delete(ctx);
    this.render(ctx, true);
  }

  receiveSettings(ctx, settings) {
    this.setSettings(ctx, settings);
    this.render(ctx);
  }

  // Merge with previously saved values rather than only defaults:
  // the panel sends partial updates (one field), otherwise every change
  // would reset the other button settings to defaults.
  setSettings(ctx, settings) {
    const prev = this.settings[ctx] || {};
    this.settings[ctx] = Object.assign({}, this.defaults, prev, settings);
  }

  get(ctx) { return this.settings[ctx] || this.defaults; }

  setIcon(ctx, svg) {
    if (this.icons.get(ctx) === svg) return;
    this.icons.set(ctx, svg);
    plugin.setImage(ctx, svg);
  }

  render() { /* override */ }
  piAppear(ctx) { pushState(ctx); }
  // IMPORTANT: the panel message handler (Log / Sign in / Sign out / settings)
  // must work on ALL buttons, not only the dynamic ones. It used to be
  // overridden only in DynamicAction — so "Plugin Log" and login
  // didn't work on like/repeat/shuffle/encoders.
  piMessage(ctx, payload) { handlePiMessage(ctx, payload, this); }
}

class DynamicAction extends Action {
  constructor(name, defaults, kind) {
    super(name, defaults);
    this.kind = kind;
  }

  render(ctx, force) {
    if (force) this.sig.delete(ctx);
    renderDynamic(ctx, this.kind);
  }

  keyUp(ctx) {
    this.pressed.delete(ctx);
    this.render(ctx, true);
    togglePlayPause(ctx);
  }
}

class StaticIconAction extends Action {
  constructor(name, iconName, onKey) {
    super(name, {});
    this.iconName = iconName;
    this.onKey = onKey;
  }

  render(ctx) {
    this.setIcon(ctx, render.iconSvg(this.iconName, this.pressed.has(ctx)));
  }

  keyUp(ctx) {
    this.pressed.delete(ctx);
    this.render(ctx, true);
    if (this.onKey) this.onKey(ctx);
  }
}

// Like/Repeat/Shuffle render via setImage (rendered SVG data-URLs), NOT setState:
// on StreamDock (MiraBox) setState blanks the button on the device (the app
// fails to resolve the manifest state image), while setImage always works.
class LikeAction extends Action {
  constructor() { super('like', {}); }

  // 'like' = not liked, 'liked' = liked, 'like-load' = status unknown (loading / no user-library-read scope)
  likeIcon() {
    if (!state.likedKnown) return 'like-load';
    return state.liked ? 'liked' : 'like';
  }

  render(ctx) {
    this.setIcon(ctx, render.iconSvg(this.likeIcon(), this.pressed.has(ctx)));
  }

  keyUp(ctx) {
    this.pressed.delete(ctx);
    this.render(ctx, true);
    toggleLike(ctx);
  }
}

class RepeatAction extends Action {
  constructor() { super('repeat', {}); }

  repeatIcon() {
    return state.repeat === 'track' ? 'repeat1' : (state.repeat === 'context' ? 'repeat' : 'repeat-off');
  }

  render(ctx) {
    this.setIcon(ctx, render.iconSvg(this.repeatIcon(), this.pressed.has(ctx)));
  }

  keyUp(ctx) {
    this.pressed.delete(ctx);
    this.render(ctx, true);
    cycleRepeat(ctx);
  }
}

class ShuffleAction extends Action {
  constructor() { super('shuffle', {}); }

  render(ctx) {
    this.setIcon(ctx, render.iconSvg(state.shuffle ? 'shuffle' : 'shuffle-off', this.pressed.has(ctx)));
  }

  keyUp(ctx) {
    this.pressed.delete(ctx);
    this.render(ctx, true);
    toggleShuffle(ctx);
  }
}

/* ---------- Encoders (Knob) ---------- */

class SeekEncoderAction extends Action {
  constructor() { super('seek', {}); }

  render(ctx) {
    this.setIcon(ctx, render.iconSvg('seek', this.pressed.has(ctx)));
  }

  keyUp(ctx) {
    this.pressed.delete(ctx);
    this.render(ctx, true);
    togglePlayPause(ctx);
  }

  dialDown(ctx) { togglePlayPause(ctx); }
  dialRotate(ctx, ticks) { seekByTicks(ctx, ticks, this); }
}

class TrackEncoderAction extends Action {
  constructor() { super('track', {}); }

  render(ctx) {
    this.setIcon(ctx, render.iconSvg('next', this.pressed.has(ctx)));
  }

  keyUp(ctx) {
    this.pressed.delete(ctx);
    this.render(ctx, true);
    togglePlayPause(ctx);
  }

  dialDown(ctx) { togglePlayPause(ctx); }

  dialRotate(ctx, ticks) {
    if (!ensureAuthed(ctx)) return;
    if (ticks > 0) {
      spotify.next().then(() => { poll(); recheckAfterSkip(); }).catch((e) => {
        if (e instanceof AuthError) onAuthFailure();
        plugin.showAlert(ctx);
      });
    } else if (ticks < 0) {
      spotify.previous().then(() => { poll(); recheckAfterSkip(); }).catch((e) => {
        if (e instanceof AuthError) onAuthFailure();
        plugin.showAlert(ctx);
      });
    }
  }
}

// Volume (encoder): rotate = volume ±2% per step, press = play/pause.
// Shows the current volume level on the encoder display.
class VolumeEncoderAction extends Action {
  constructor() { super('volume', {}); }

  render(ctx) {
    this.setIcon(ctx, render.iconSvg('volume', this.pressed.has(ctx)));
    this.updateTitle(ctx);
  }

  updateTitle(ctx) {
    const v = (state.volume == null) ? '—' : Math.round(state.volume) + '%';
    plugin.setTitle(ctx, 'Volume ' + v);
  }

  keyUp(ctx) {
    this.pressed.delete(ctx);
    this.render(ctx, true);
    togglePlayPause(ctx);
  }

  dialDown(ctx) { togglePlayPause(ctx); }

  dialRotate(ctx, ticks) {
    if (!ensureAuthed(ctx)) return;
    if (state.volume == null) { plugin.showAlert(ctx); return; }
    const st = this._vol || (this._vol = {});
    const base = st.target != null ? st.target : state.volume;
    const target = clamp(base + ticks * 2, 0, 100);
    st.target = target;
    // show the new value on the encoder display right away
    plugin.setTitle(ctx, 'Volume ' + Math.round(target) + '%');
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = null;
      st.target = null;
      state.volume = target;
      spotify.volume(target, state.deviceId).catch((e) => {
        if (e instanceof AuthError) onAuthFailure();
      });
    }, 120);
  }
}

const actions = {
  playpause: new DynamicAction('playpause', { cover: true, title: true, artist: true, time: false, fontSize: 13, showIcon: false, timeColor: '#1DB954', autoContrast: true, progressBar: true }, 'playpause'),
  info: new DynamicAction('info', { cover: true, title: true, artist: true, time: true, fontSize: 13, timeColor: '#1DB954', autoContrast: true, progressBar: true }, 'info'),
  next: new StaticIconAction('next', 'next', onNext),
  previous: new StaticIconAction('previous', 'previous', onPrevious),
  like: new LikeAction('like'),
  repeat: new RepeatAction('repeat'),
  shuffle: new ShuffleAction('shuffle'),
  seek: new SeekEncoderAction('seek'),
  track: new TrackEncoderAction('track'),
  volume: new VolumeEncoderAction('volume')
};
for (const name of Object.keys(actions)) plugin.actions[name] = actions[name];

/* ============================== Covers ============================== */

const coverCache = new Map();    // url -> dataUrl
const coverLuma = new Map();     // url -> average luminance of the bottom part (0..255) or null
const coverLoading = new Map();  // url -> Promise
const coverFailed = new Map();   // url -> timestamp of last failure (retry after 5 min)

function ensureCover(url) {
  if (!url) return Promise.resolve(null);
  if (coverCache.has(url)) return Promise.resolve(coverCache.get(url));
  const failedAt = coverFailed.get(url);
  if (failedAt && Date.now() - failedAt < 300000) return Promise.resolve(null);
  if (coverLoading.has(url)) return coverLoading.get(url);
  const p = getBuffer(url)
    .then((r) => {
      const d = dataUrlFromBuffer(r.buffer, r.contentType);
      coverCache.set(url, d);
      coverFailed.delete(url);
      // Luminance for text auto-contrast (black/white over the cover)
      try { coverLuma.set(url, averageLuminance(r.buffer)); } catch (e) { coverLuma.set(url, null); }
      while (coverCache.size > 12) {
        const k = coverCache.keys().next().value;
        coverCache.delete(k);
        coverLuma.delete(k);
      }
      coverLoading.delete(url);
      renderAll(true); // cover loaded — re-render (and the text color too)
      return d;
    })
    .catch((e) => {
      coverLoading.delete(url);
      coverFailed.set(url, Date.now());
      log('[cover] fetch failed:', e && e.message || e);
      return null;
    });
  coverLoading.set(url, p);
  return p;
}

function pickCover(images, minWidth) {
  if (!images || !images.length) return null;
  const sorted = images.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  for (const img of sorted) {
    if ((img.width || 0) >= minWidth) return img.url;
  }
  return sorted[sorted.length - 1].url;
}

/* ============================== Rendering ============================== */

function renderDynamic(ctx, kind) {
  const action = actions[kind];
  const settings = action.get(ctx);
  const track = state.track;
  const coverUrl = (settings.cover !== false && track)
    ? (kind === 'info' ? track.coverSmall : track.cover)
    : null;
  if (coverUrl) ensureCover(coverUrl);

  const cover = coverUrl ? (coverCache.get(coverUrl) || null) : null;
  const luma = coverUrl ? (coverLuma.get(coverUrl) || null) : null;
  // The progress bar also depends on progressMs — include seconds in the
  // signature so the bar moves every second even when "Time" is off.
  const showBar = settings.progressBar !== false && state.empty === 'none' && !!track;
  const timePart = (showBar || kind === 'info' || settings.time) ? Math.floor(state.progressMs / 1000) : '-';
  // Marquee: 2 fps (500 ms); real milliseconds are passed to the renderer.
  const nowMs = Date.now();
  const marquee = render.needsMarquee(track, settings);
  if (marquee && !action.marqSeen) {
    action.marqSeen = true;
    log('[marquee] text doesn\'t fit, marquee enabled on button', kind);
  }
  const phaseSig = marquee ? Math.floor(nowMs / 500) : 0;
  const pressed = action.pressed.has(ctx);
  const sig = [
    state.empty,
    track ? track.id : '-',
    cover ? 'c' : '-',
    state.isPlaying ? 1 : 0,
    timePart,
    marquee ? 'm' + phaseSig : '-',
    pressed ? 1 : 0,
    JSON.stringify(settings)
  ].join('|');

  if (action.sig.get(ctx) === sig) return;
  action.sig.set(ctx, sig);

  const opts = {
    cover,
    luma,
    playing: state.isPlaying,
    track,
    settings,
    progressMs: state.progressMs,
    empty: state.empty,
    phase: marquee ? nowMs : 0,
    pressed
  };
  const svg = kind === 'info' ? render.renderInfo(opts) : render.renderPlayPause(opts);
  action.setIcon(ctx, svg);
}

function renderDynamicAll(force) {
  for (const ctx of actions.playpause.contexts) actions.playpause.render(ctx, force);
  for (const ctx of actions.info.contexts) actions.info.render(ctx, force);
}

function renderLikeAll() {
  for (const ctx of actions.like.contexts) actions.like.render(ctx);
}

function renderRepeatAll() {
  for (const ctx of actions.repeat.contexts) actions.repeat.render(ctx);
}

function renderShuffleAll() {
  for (const ctx of actions.shuffle.contexts) actions.shuffle.render(ctx);
}

function renderAll(force) {
  renderDynamicAll(force);
  renderLikeAll();
  renderRepeatAll();
  renderShuffleAll();
  // Static icons (next/previous/encoders) are rendered only once at willAppear,
  // so startup re-renders (the retry loop calls renderAll(true)) must reach
  // them too — otherwise the device's startup image drop leaves them blank.
  for (const name of ['next', 'previous', 'seek', 'track', 'volume']) {
    for (const ctx of actions[name].contexts) actions[name].render(ctx, force);
  }
}

/* ============================== Spotify polling ============================== */

let polling = false;
// Spotify rate limit (429): after a hit, don't poll again for a while so the
// quota can reset — hammering the API during a 429 keeps the limit hot.
let nextPollAt = 0;

async function poll() {
  if (!auth.hasToken()) return;
  if (polling) return;
  polling = true;
  nextPollAt = 0;
  try {
    const res = await spotify.getPlayer();
    if (res.status === 200 && res.data && res.data.item && res.data.item.type === 'track') {
      const d = res.data;
      const item = d.item;
      const track = {
        id: item.id,
        name: item.name,
        artists: (item.artists || []).map((a) => a.name).join(', '),
        durationMs: item.duration_ms || 0,
        cover: pickCover(item.album && item.album.images, 300),
        coverSmall: pickCover(item.album && item.album.images, 1),
        uri: item.uri
      };
      const changed = !state.track || state.track.id !== track.id;
      if (changed) log('[poll] track:', track.name, '-', track.artists);
      state.track = track;
      state.isPlaying = !!d.is_playing;
      state.progressMs = d.progress_ms || 0;
      state.repeat = d.repeat_state || 'off';
      state.shuffle = !!d.shuffle_state;
      state.volume = (d.device && typeof d.device.volume_percent === 'number') ? d.device.volume_percent : state.volume;
      state.deviceId = (d.device && d.device.id) || null;
      state.empty = 'none';
      if (changed) {
        // first show the cached like status (if any),
        // then confirm the real one in the background
        const has = Object.prototype.hasOwnProperty.call(state.likedCache, track.id);
        state.liked = has ? !!state.likedCache[track.id] : false;
        state.likedKnown = has;
        refreshLike(true);
      }
      renderAll(changed);
    } else if (res.status === 204 || (res.status === 200 && !res.data.item)) {
      if (state.track || state.empty !== 'nodevice') {
        state.track = null;
        state.isPlaying = false;
        state.empty = 'nodevice';
        renderAll(true);
      }
    } else if (res.status === 429) {
      log('[poll] 429 rate limit — backing off for 30s');
      nextPollAt = Date.now() + 30000;
    } else if (res.status === 403) {
      if (state.empty !== 'premium') { state.empty = 'premium'; renderAll(true); }
    } else if (res.status === 401) {
      // refresh didn't help — the token is dead
      await auth.clearTokens();
      state.empty = 'noauth';
      pushAuthState();
      renderAll(true);
    }
  } catch (e) {
    if (e instanceof AuthError) {
      await auth.clearTokens().catch(() => {});
      state.empty = 'noauth';
      pushAuthState();
      renderAll(true);
    }
    // ignore network errors — the timer will retry
  } finally {
    polling = false;
    state.lastPoll = Date.now();
  }
}

// Serialization: all status requests go through a promise chain so that two
// requests never run at the same time. A race used to let one return 200 and
// the other 403, overwriting the state AFTER success (the button showed "not
// liked" for a liked track). await refreshLike() waits for the whole chain.
let likeChain = Promise.resolve();

function refreshLike(force) {
  if (!auth.hasToken() || !state.track) return Promise.resolve();
  if (state.likedKnown && !force) return Promise.resolve();
  likeChain = likeChain.then(() => doRefreshLike()).catch((e) => log('[like] error:', e && e.message || e));
  return likeChain;
}

async function doRefreshLike() {
  log('[like] status request:', state.track.id);
  try {
    let res = state.likeLegacy
      ? await spotify.isLikedLegacy(state.track.id)
      : await spotify.isLiked(state.track.id);
    // Error on the modern /v1/me/tracks/contains — try the legacy /v1/me/library/contains
    // (like the official MiraBox plugin): on some accounts only the legacy endpoints
    // work (403/400 on the new ones even with the scopes in place).
    // After the first success through the legacy endpoint, remember it and use it directly.
    if (!(res.status >= 200 && res.status < 300) && !state.likeLegacy) {
      log('[like] ' + res.status + ' on /me/tracks/contains, trying /me/library/contains');
      try { res = await spotify.isLikedLegacy(state.track.id); } catch (e2) { /* handled below */ }
    }
    log('[like] response:', res.status, JSON.stringify(res.data));
    if (res.status === 200) {
      const val = res.data && res.data[0];
      state.liked = !!(Array.isArray(val) ? val[0] : val);
      state.likedKnown = true;
      state.library403 = false;
      state.like403At = 0;
      state.likeLegacy = true; // legacy endpoint worked — use it from now on
      state.likedCache[state.track.id] = state.liked;
      saveLikeCache();
      renderLikeAll();
    } else if (res.status === 403) {
      // 403 on the legacy endpoint too = the token has no user-library-read scope.
      // Only a re-login fixes it; retrying won't help — don't spam.
      const msg = (res.data && res.data.error && (res.data.error.message || res.data.error.status)) || 'no data';
      state.library403 = true;
      state.like403At = Date.now() + 30000;
      pushAuthState();
      const sc = auth.scopes();
      const hasLib = sc ? sc.indexOf('user-library-read') !== -1 : null;
      log('[like] 403:', msg, '— token scopes:', sc ? sc.join(', ') : '(could not read)', hasLib === true ? '— user-library-read present ✓, but Spotify still returns 403.' : hasLib === false ? '— user-library-read MISSING ✗. Press "Sign out" and "Sign in with Spotify" again.' : '— scopes unreadable (token may not be a JWT); if likes don\'t work — "Sign out" → "Sign in" again.');
    }
  } catch (e) { log('[like] error:', e && e.message || e); }
}

let _summaryAt = 0;

function pollInterval() {
  // While music is playing we poll every 10s (track changes, volume changes
  // from other devices, like status). When paused there's nothing to track —
  // poll every 60s so the daily dev-mode quota is barely touched.
  // The end-of-track poll (below) fires right when a track finishes, so the
  // next track's info still appears immediately despite the 10s interval.
  return (state.isPlaying && state.track) ? 10000 : 60000;
}

function tick() {
  const now = Date.now();
  // The machine was asleep (or the app/device stalled for a while): the device
  // may have blanked its keys or re-enumerated. Push all images again with a
  // few retries — the app may still be reconnecting the device right now.
  const lastTick = state._lastTick || now;
  if (now - lastTick > 15000) {
    log('[wake] gap of ' + Math.round((now - lastTick) / 1000) + 's — re-rendering all buttons');
    bumpAllDelayed();
  }
  // Periodic state summary — so the log shows what the plugin sees
  // (track, volume, like, token scopes) without a pile of separate lines.
  if (now - _summaryAt > 30000) {
    _summaryAt = now;
    const sc = auth.scopes();
    const hasLib = sc ? sc.indexOf('user-library-read') !== -1 : false;
    log('[summary] track=' + (state.track ? state.track.name : '-') +
      ' playing=' + state.isPlaying +
      ' vol=' + (state.volume == null ? '-' : Math.round(state.volume)) +
      ' repeat=' + state.repeat + ' shuffle=' + state.shuffle +
      ' liked=' + (state.likedKnown ? state.liked : '?') +
      ' lib403=' + state.library403 + ' libScope=' + hasLib + ' libLegacy=' + state.likeLegacy +
      ' settings: ' + [actions.playpause, actions.info].map((a) => {
        const parts = [];
        for (const c of a.contexts) parts.push(a.name + '[' + String(c).slice(0, 6) + ']=' + JSON.stringify(a.get(c)));
        return parts.join(' ') || (a.name + '=—');
      }).join(' | '));
  }
  if (now >= nextPollAt && now - state.lastPoll > pollInterval()) poll();
  if (state.empty === 'none' && state.isPlaying && state.track) {
    state.progressMs = Math.min(state.track.durationMs, state.progressMs + (now - (state._lastTick || now)));
  }
  // The current track is about to end (local estimate) — poll right away so
  // the next track's info (title, cover, like) appears immediately instead
  // of waiting for the next 10s interval. One-shot per track: the marker
  // stops a repeat flood if the request fails and progress stays at the end.
  if (state.empty === 'none' && state.isPlaying && state.track &&
      state.track.durationMs - state.progressMs <= 1000 &&
      now >= nextPollAt &&
      state.endPollId !== state.track.id) {
    state.endPollId = state.track.id;
    poll();
  }
  // Like: if the status is still unknown (or the first request failed) — retry
  if (state.track && !state.likedKnown && now > state.likeRetryAt && now > (state.like403At || 0)) {
    state.likeRetryAt = now + 5000;
    refreshLike();
  }
  state._lastTick = now;
  renderDynamicAll(false);
  // Time on the seek encoder display
  if (actions.seek.contexts.size) {
    const t = state.track ? fmtTime(state.progressMs) + ' / ' + fmtTime(state.track.durationMs) : '';
    for (const ctx of actions.seek.contexts) plugin.setTitle(ctx, t);
  }
  // Volume on the volume encoder display
  if (actions.volume.contexts.size) {
    for (const ctx of actions.volume.contexts) actions.volume.updateTitle(ctx);
  }
}

setInterval(tick, 1000);
// Marquee: poll frequently, but only re-render when the frame phase changes
// (2 fps) — deduplication via the signature
setInterval(() => { if (auth.hasToken()) renderDynamicAll(false); }, 100);
setTimeout(poll, 500);

// StreamDock (MiraBox) silently drops setImage/setState messages sent in the
// first moments after the plugin connects, while the device is still
// initializing its keys. Buttons rendered only once at willAppear (next,
// previous, encoders) would stay blank on the device until the first press.
// Re-send every button image a few times with a short delay after startup.
{
  // Early passes catch the device's startup drop window better than one fixed interval
  const delays = [400, 1000, 1800, 2800, 4000, 5500];
  let i = 0;
  const rearm = () => {
    if (i >= delays.length) return;
    setTimeout(() => {
      for (const name of Object.keys(actions)) {
        actions[name].icons.clear();
        actions[name].sig.clear();
      }
      renderAll(true);
      i++;
      rearm();
    }, delays[i]);
  };
  rearm();
}

// Redraw every button, bypassing the render-signature deduplication, so the
// images actually go out to the device again. Used after a wake-up and on a
// key press / encoder turn (the device may have blanked keys during idle) —
// but NOT on a timer: flooding the device with images while it is idle made
// it stop responding to anything at all until the app was restarted.
let wakeRenders = 0;
let lastDialBump = 0;
function bumpAll() {
  for (const name of Object.keys(actions)) {
    actions[name].icons.clear();
    actions[name].sig.clear();
  }
  renderAll(true);
}
// After the machine wakes from sleep the device may take a moment to
// re-enumerate, so push the images a few times with short delays.
function bumpAllDelayed() {
  if (wakeRenders) return;
  wakeRenders = 1;
  [0, 1500, 4000].forEach((d, i) => {
    setTimeout(() => {
      bumpAll();
      if (i === 2) wakeRenders = 0;
    }, d);
  });
}

/* ============================== Press handling ============================== */

function ensureAuthed(ctx) {
  if (auth.hasToken()) return true;
  plugin.showAlert(ctx);
  return false;
}

async function togglePlayPause(ctx) {
  if (!ensureAuthed(ctx)) return;
  const target = !state.isPlaying;
  // Optimistic: no checkmarks and no false errors.
  // 404 = "no active device" (the device "falls asleep" after a pause) —
  // retry play after a second so the track resumes on the first press.
  try {
    let res = await spotify.setPlay(target);
    if (target && res.status === 404) {
      await new Promise((r) => setTimeout(r, 900));
      await spotify.setPlay(true);
    }
  } catch (e) {
    if (e instanceof AuthError) onAuthFailure();
  }
  poll();
}

async function onNext(ctx) {
  if (!ensureAuthed(ctx)) return;
  try {
    await spotify.next();
    poll();
    recheckAfterSkip();
  } catch (e) {
    if (e instanceof AuthError) onAuthFailure();
    plugin.showAlert(ctx);
  }
}

async function onPrevious(ctx) {
  if (!ensureAuthed(ctx)) return;
  try {
    await spotify.previous();
    poll();
    recheckAfterSkip();
  } catch (e) {
    if (e instanceof AuthError) onAuthFailure();
    plugin.showAlert(ctx);
  }
}

// Spotify switches tracks asynchronously: the poll() right after next/previous
// often still returns the OLD track, and the next scheduled poll is 10s away —
// the button would show stale info. Recheck a few times (1.5s apart) until the
// new track appears. Bounded: max 5 extra polls per press, so quota is fine.
let _skipRecheck = null;

function recheckAfterSkip() {
  const startId = state.track ? state.track.id : null;
  let tries = 0;
  if (_skipRecheck) clearTimeout(_skipRecheck);
  const attempt = () => {
    if (tries >= 5) return;
    tries++;
    poll().then(() => {
      if (state.track && state.track.id !== startId) return; // switched — done
      _skipRecheck = setTimeout(attempt, 1500);
    });
  };
  _skipRecheck = setTimeout(attempt, 1500);
}

async function toggleLike(ctx) {
  if (!ensureAuthed(ctx)) return;
  if (!state.track) { plugin.showAlert(ctx); return; }
  // If the status is unknown, first learn the REAL status instead of toggling
  // blindly: otherwise pressing a liked button used to "unlike" (the button
  // showed "not liked" while the track was liked) or vice versa.
  if (!state.likedKnown) {
    await refreshLike(true);
    if (!state.likedKnown) { plugin.showAlert(ctx); return; }
  }
  const prev = state.liked;
  const target = !state.liked;
  // Optimistically show the new state
  state.liked = target;
  state.likedKnown = true;
  renderLikeAll();
  try {
    let res = state.likeLegacy
      ? await spotify.setLikedLegacy(state.track.id, target)
      : await spotify.setLiked(state.track.id, target);
    // Error on the modern /v1/me/tracks — try the legacy /v1/me/library (like the official plugin).
    if (!(res.status >= 200 && res.status < 300) && !state.likeLegacy) {
      log('[like] set ' + res.status + ' on /me/tracks, trying /me/library');
      try { res = await spotify.setLikedLegacy(state.track.id, target); } catch (e2) { /* handled below */ }
    }
    if (res.status >= 200 && res.status < 300) {
      state.likeLegacy = true;
      state.likedCache[state.track.id] = target;
      saveLikeCache();
      // Confirm the real status so the button always matches the track
      refreshLike(true);
    } else {
      // Spotify rejected both legacy and modern endpoints: roll back the icon
      log('[like] set response:', res.status, JSON.stringify(res.data));
      if (res.status === 403) {
        const sc = auth.scopes();
        const hasLib = sc ? sc.indexOf('user-library-modify') !== -1 : null;
        state.library403 = true;
        state.like403At = Date.now() + 30000;
        pushAuthState();
        log('[like] set 403:', '— token scopes:', sc ? sc.join(', ') : '(could not read)', hasLib ? '— user-library-modify present ✓, but Spotify returns 403.' : '— user-library-modify MISSING ✗. Press "Sign out" and "Sign in with Spotify" again.');
      }
      if (prev != null) {
        state.liked = prev;
        state.likedKnown = true;
      } else {
        state.likedKnown = false;
      }
      renderLikeAll();
    }
  } catch (e) {
    if (e instanceof AuthError) onAuthFailure();
    plugin.showAlert(ctx);
    refreshLike();
  }
}

async function cycleRepeat(ctx) {
  if (!ensureAuthed(ctx)) return;
  const order = ['off', 'track', 'context'];
  const idx = order.indexOf(state.repeat);
  const next = order[(idx + 1) % order.length];
  state.repeat = next;
  renderRepeatAll();
  try {
    await spotify.setRepeat(next);
  } catch (e) {
    if (e instanceof AuthError) onAuthFailure();
    plugin.showAlert(ctx);
  }
}

async function toggleShuffle(ctx) {
  if (!ensureAuthed(ctx)) return;
  const target = !state.shuffle;
  state.shuffle = target;
  renderShuffleAll();
  try {
    await spotify.setShuffle(target);
  } catch (e) {
    if (e instanceof AuthError) onAuthFailure();
    plugin.showAlert(ctx);
  }
}

// Encoder seek: each tick = 5 seconds (like the reference plugin).
// Fast ticks accumulate and flush as one request after 120 ms.
function seekByTicks(ctx, ticks, action) {
  if (!ensureAuthed(ctx)) return;
  if (!state.track || state.empty !== 'none') { plugin.showAlert(ctx); return; }
  // Per-button state (one Action instance serves every seek encoder button):
  // the accumulated target and the debounce timer must not bleed between buttons.
  const st = action._seek || (action._seek = {});
  const s = st[ctx] || (st[ctx] = {});
  if (!s.rotTrackId) s.rotTrackId = state.track.id; // track at the start of this rotation burst
  const base = s.target != null ? s.target : state.progressMs;
  const target = clamp(base + ticks * 5000, 0, state.track.durationMs);
  s.target = target;
  // show the new position on the encoder display right away
  plugin.setTitle(ctx, fmtTime(target) + ' / ' + fmtTime(state.track.durationMs));
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    s.target = null;
    const rotTrack = s.rotTrackId;
    s.rotTrackId = null;
    // the track changed while the user was rotating — don't apply the old
    // position to the new track (Spotify would seek the new track to it)
    if (rotTrack && rotTrack !== state.track.id) {
      log('[seek] track changed during rotation — skipping the seek');
      return;
    }
    state.progressMs = target;
    spotify.seek(target).then(() => {
      // Spotify may apply the request to the NEXT track if the track changed
      // while the request was in flight — jump it back to the beginning
      if (rotTrack && rotTrack !== state.track.id) {
        log('[seek] stale seek landed on', state.track.name, '— resetting to 0');
        state.progressMs = 0;
        spotify.seek(0).catch(() => {});
      }
      poll(); // resync progressMs with the real position
    }).catch((e) => {
      log('[seek] error:', e && e.message || e);
      if (e instanceof AuthError) onAuthFailure();
    });
  }, 120);
}

function onAuthFailure() {
  auth.clearTokens().then(() => {
    state.empty = 'noauth';
    pushAuthState();
    renderAll(true);
  }).catch(() => {});
}

/* ============================== Property Inspector ============================== */

function pushAuthState() {
  plugin.sendToPI({ type: 'auth', ...auth.publicState(), scopes: auth.scopes(), libraryError: state.library403, logEnabled, player: playerSummary() });
}

function pushState(ctx) {
  const action = plugin.actionFor(ctx);
  plugin.sendToPI({
    type: 'state',
    action: action ? action.name : null,
    settings: action ? action.get(ctx) : {},
    ...auth.publicState(),
    scopes: auth.scopes(),
    libraryError: state.library403,
    logEnabled,
    player: playerSummary()
  });
}

function playerSummary() {
  return {
    empty: state.empty,
    playing: state.isPlaying,
    track: state.track ? (state.track.name + ' — ' + state.track.artists) : null
  };
}

async function doLogin() {
  const step = (msg) => {
    log('[login]', msg);
    plugin.sendToPI({ type: 'auth', ...auth.publicState(), status: 'connecting', message: msg, player: playerSummary() });
  };
  try {
    step('Checking Client ID and Client Secret…');
    const { url } = auth.prepareLogin();
    step('Local server started, opening the browser…');
    plugin.openUrl(url);
    plugin.sendToPI({ type: 'loginUrl', url, message: 'If the browser didn\'t open by itself, click the link below.' });
    step('Waiting for confirmation in the browser…');
    const code = await auth.waitForCode();
    step('Exchanging the code for tokens…');
    await auth.exchangeCode(code);
    log('[login] tokens received');
    logScopes();
    try {
      const me = await spotify.me();
      if (me.status === 200 && me.data) {
        auth.account = me.data.display_name || me.data.id || null;
        auth.save();
      }
    } catch (e) { /* account name is not critical */ }
    state.empty = 'none';
    state.library403 = false;
    state.like403At = 0;
    state.likeLegacy = false;
    state.likedKnown = false;
    renderAll(true);
    poll();
    if (state.track) refreshLike(true); // after re-login, verify the like right away
    pushAuthState();
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    log('[login] error:', msg);
    plugin.sendToPI({
      type: 'auth',
      ...auth.publicState(),
      error: msg,
      player: playerSummary()
    });
  }
}

async function doLogout() {
  await auth.clearTokens();
  state.empty = 'noauth';
  state.library403 = false;
  state.like403At = 0;
  renderAll(true);
  pushAuthState();
}

function handlePiMessage(ctx, payload, action) {
  if (!payload || typeof payload !== 'object') return;
  // The panel sends context = plugin uuid, but settings must apply to the button.
  // The panel passes its button context in payload.buttonContext — use it,
  // otherwise settings used to land on the first button of the action.
  const bc = payload.buttonContext;
  const target = (bc && action && action.contexts.has(bc))
    ? bc
    : (plugin.contextAction[ctx] || plugin.firstContextFor(action ? action.name : null));
  switch (payload.type) {
    case 'getState':
      pushState(target);
      break;
    case 'saveAuth':
      auth.setCredentials(payload);
      pushAuthState();
      break;
    case 'login':
      doLogin();
      break;
    case 'logout':
      doLogout();
      break;
    case 'getLog': {
      let text = '';
      try {
        const full = fs.readFileSync(LOG_FILE, 'utf8');
        text = full.split('\n').filter(Boolean).slice(-200).join('\n');
      } catch (e) {
        text = '(log file is still empty: ' + LOG_FILE + ')'
      }
      plugin.sendToPI({ type: 'log', text });
      break;
    }
    case 'setLogEnabled': {
      const v = !!(payload && payload.enabled);
      logEnabled = v;
      setEnabled(v);
      // start with a clean file on every toggle, so the Log button
      // doesn't show old lines from before
      try { fs.truncateSync(LOG_FILE, 0); } catch (e) { /* ignore */ }
      plugin.setGlobalSettings({ spotify: auth.toJSON(), logEnabled });
      pushAuthState();
      break;
    }
    case 'settings': {
      const act = action || plugin.actionFor(target);
      if (act && target && payload.settings && typeof payload.settings === 'object') {
        act.setSettings(target, payload.settings);
        plugin.setSettings(target, act.get(target));
        act.render(target);
        log('[settings]', act.name, 'ctx=' + String(target).slice(0, 8), '->', JSON.stringify(payload.settings));
      } else {
        log('[settings] NOT applied: action=', action && action.name, 'target=', target, 'payload.settings=', payload.settings);
      }
      break;
    }
    default:
      break;
  }
}

/* ============================== Startup ============================== */

process.on('uncaughtException', (e) => log('[uncaughtException]', e && e.stack || e));
process.on('unhandledRejection', (e) => log('[unhandledRejection]', e && e.stack || e));

log('Plugin log: ' + LOG_FILE);
// scopes are logged after the token is loaded (didReceiveGlobalSettings / login)
