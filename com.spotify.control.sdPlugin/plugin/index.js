'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Auth } = require('./lib/auth');
const { SpotifyApi, AuthError } = require('./lib/spotify');
const render = require('./lib/render');
const { getBuffer, dataUrlFromBuffer, clamp, fmtTime } = require('./lib/util');
const { averageLuminance } = require('./lib/luma');
const { log, LOG_FILE } = require('./lib/log');

log('Плагин запущен, argv:', process.argv);

// WebSocket: используем глобальный (Node >= 20.10), иначе собственный fallback
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
    this.actions = {};     // короткое имя действия -> Action
    this.contextAction = {}; // context -> короткое имя
    this.ws = null;
    this.connect();
  }

  connect() {
    try {
      this.ws = new WSImpl('ws://127.0.0.1:' + this.port);
    } catch (e) {
      log('Не удалось создать WebSocket:', e && e.message || e);
      return;
    }
    this.ws.onopen = () => {
      log('WebSocket открыт, регистрируемся');
      this.send({ event: this.registerEvent, uuid: this.uuid });
      this.getGlobalSettings();
    };
    this.ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      try { this.handle(data); } catch (e) { log('Ошибка обработки сообщения:', e); }
    };
    this.ws.onclose = () => { log('WebSocket закрыт'); process.exit(0); };
    this.ws.onerror = (e) => log('WebSocket ошибка:', e && e.message || e);
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

  // Первый контекст кнопки действия (панель шлёт context = uuid плагина,
  // а настройки нужно применить к контексту конкретной кнопки)
  firstContextFor(short) {
    for (const key of Object.keys(this.contextAction)) {
      if (this.contextAction[key] === short) return key;
    }
    return null;
  }

  handle(data) {
    // Логируем содержимое сообщений от панели (с маскировкой секрета) —
    // это главный инструмент диагностики настроек и входа.
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
    log('Сообщение от StreamDock:', data.event, data.action || '', pl !== undefined ? JSON.stringify(pl) : '');
    if (data.event === 'didReceiveGlobalSettings') {
      const spot = (data.payload && data.payload.settings && data.payload.settings.spotify) || null;
      // Файл плагина — источник истины (пишется синхронно при каждом изменении токенов),
      // а глобальные настройки StreamDock могут быть устаревшими. Берём их только если файла нет.
      if (!auth.hasToken() && spot) auth.fromJSON(spot);
      if (auth.hasToken()) {
        state.empty = 'none';
        poll();
      }
      logScopes(); // токен уже загружен — логируем реальные права
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
        if (action) action.keyDown(ctx);
        break;
      case 'keyUp':
        if (action) action.keyUp(ctx);
        break;
      case 'dialRotate':
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
        // сообщение от панели — по нему же знаем, какая панель сейчас открыта
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
    plugin.setGlobalSettings({ spotify: auth.toJSON() });
  },
  openUrl: (url) => plugin.openUrl(url)
});

// Диагностика: реальные права токена (есть ли user-library-read для лайков)
function logScopes() {
  const sc = auth.scopes();
  if (sc === null) return log('[scopes] токена нет');
  const hasLib = sc.indexOf('user-library-read') !== -1;
  log('[scopes]', sc.join(', ') || '(пусто)', hasLib ? '— user-library-read есть ✓' : '— user-library-read НЕТ ✗ (лайки не будут работать, нужен повторный вход)');
}

const spotify = new SpotifyApi(auth);

/* ============================== Состояние ============================== */

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
  likeLegacy: false, // старый эндпоинт /v1/me/library работает лучше новых — используем его
  library403: false,
  volume: null,       // 0..100, громкость активного устройства (из /me/player)
  deviceId: null,     // id активного устройства (нужен для /volume)
  lastPoll: 0,
  _lastTick: 0
};

/* ============================== Кэш лайков ============================== */

// Статус лайка по trackId сохраняется на диск, чтобы при запуске
// кнопка сразу показывала правильное состояние (без «пустого» сердечка).
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

  // Эффект нажатия: подсветка на время удержания кнопки
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

  // Мерджим с уже сохранёнными значениями, а не только с дефолтами:
  // панель шлёт частичные обновления (одно поле), и иначе каждое изменение
  // сбрасывало бы остальные настройки кнопки на дефолты.
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
  // ВАЖНО: обработчик сообщений панели (Лог / Войти / Выйти / настройки) должен
  // работать на ВСЕХ кнопках, а не только на динамических. Раньше он был
  // переопределён только у DynamicAction — поэтому «Лог плагина» и вход
  // не работали на лайке/повторе/перемешивании/энкодерах.
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

// Состояния кнопок переключаются через setState (как в официальном плагине MiraBox):
// StreamDock гарантированно применяет смену состояния, тогда как повторные setImage могут игнорироваться.
class LikeAction extends Action {
  constructor() { super('like', {}); }

  // 0 = не лайкнут, 1 = лайкнут, 2 = статус неизвестен (загружается / нет прав user-library-read)
  likeIndex() {
    if (!state.likedKnown) return 2;
    return state.liked ? 1 : 0;
  }

  render(ctx) {
    plugin.setState(ctx, this.likeIndex());
  }

  keyUp(ctx) {
    this.render(ctx);
    toggleLike(ctx);
  }
}

class RepeatAction extends Action {
  constructor() { super('repeat', {}); }

  repeatIndex() {
    return state.repeat === 'track' ? 2 : (state.repeat === 'context' ? 1 : 0);
  }

  render(ctx) {
    plugin.setState(ctx, this.repeatIndex());
  }

  keyUp(ctx) {
    this.render(ctx);
    cycleRepeat(ctx);
  }
}

class ShuffleAction extends Action {
  constructor() { super('shuffle', {}); }

  render(ctx) {
    plugin.setState(ctx, state.shuffle ? 1 : 0);
  }

  keyUp(ctx) {
    this.render(ctx);
    toggleShuffle(ctx);
  }
}

/* ---------- Крутилки (Knob) ---------- */

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
      spotify.next().then(() => poll()).catch((e) => {
        if (e instanceof AuthError) onAuthFailure();
        plugin.showAlert(ctx);
      });
    } else if (ticks < 0) {
      spotify.previous().then(() => poll()).catch((e) => {
        if (e instanceof AuthError) onAuthFailure();
        plugin.showAlert(ctx);
      });
    }
  }
}

// Громкость (энкодер): вращение = громкость ±2% за шаг, нажатие = плей/пауза.
// На дисплее энкодера показывает текущий уровень громкости.
class VolumeEncoderAction extends Action {
  constructor() { super('volume', {}); }

  render(ctx) {
    this.setIcon(ctx, render.iconSvg('volume', this.pressed.has(ctx)));
    this.updateTitle(ctx);
  }

  updateTitle(ctx) {
    const v = (state.volume == null) ? '—' : Math.round(state.volume) + '%';
    plugin.setTitle(ctx, 'Громкость ' + v);
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
    // сразу показываем новое значение на дисплее энкодера
    plugin.setTitle(ctx, 'Громкость ' + Math.round(target) + '%');
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

/* ============================== Обложки ============================== */

const coverCache = new Map();    // url -> dataUrl
const coverLuma = new Map();     // url -> средняя яркость нижней части (0..255) или null
const coverLoading = new Map();  // url -> Promise

function ensureCover(url) {
  if (!url) return Promise.resolve(null);
  if (coverCache.has(url)) return Promise.resolve(coverCache.get(url));
  if (coverLoading.has(url)) return coverLoading.get(url);
  const p = getBuffer(url)
    .then((r) => {
      const d = dataUrlFromBuffer(r.buffer, r.contentType);
      coverCache.set(url, d);
      // Яркость для авто-контраста текста (чёрный/белый по обложке)
      try { coverLuma.set(url, averageLuminance(r.buffer)); } catch (e) { coverLuma.set(url, null); }
      while (coverCache.size > 12) {
        const k = coverCache.keys().next().value;
        coverCache.delete(k);
        coverLuma.delete(k);
      }
      coverLoading.delete(url);
      renderAll(true); // обложка загружена — перерисовать (и цвет текста тоже)
      return d;
    })
    .catch(() => {
      coverLoading.delete(url);
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

/* ============================== Рендер ============================== */

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
  // Прогресс-бар тоже зависит от progressMs — включаем секунды в сигнатуру,
  // чтобы полоса двигалась каждую секунду, даже когда «Время» выключено.
  const showBar = settings.progressBar !== false && state.empty === 'none' && !!track;
  const timePart = (showBar || kind === 'info' || settings.time) ? Math.floor(state.progressMs / 1000) : '-';
  // Бегущая строка: 2 кадра/с (500 мс), в рендер передаются реальные миллисекунды.
  const nowMs = Date.now();
  const marquee = render.needsMarquee(track, settings);
  if (marquee && !action.marqSeen) {
    action.marqSeen = true;
    log('[marquee] текст не влезает, включена бегущая строка на кнопке', kind);
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
}

/* ============================== Опрос Spotify ============================== */

let polling = false;

async function poll() {
  if (!auth.hasToken()) return;
  if (polling) return;
  polling = true;
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
      if (changed) log('[poll] трек:', track.name, '-', track.artists);
      state.track = track;
      state.isPlaying = !!d.is_playing;
      state.progressMs = d.progress_ms || 0;
      state.repeat = d.repeat_state || 'off';
      state.shuffle = !!d.shuffle_state;
      state.volume = (d.device && typeof d.device.volume_percent === 'number') ? d.device.volume_percent : state.volume;
      state.deviceId = (d.device && d.device.id) || null;
      state.empty = 'none';
      if (changed) {
        // сначала показываем кэшированный статус лайка (если есть),
        // затем в фоне подтверждаем актуальный
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
    } else if (res.status === 403) {
      if (state.empty !== 'premium') { state.empty = 'premium'; renderAll(true); }
    } else if (res.status === 401) {
      // refresh не помог — токен мёртв
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
    // сетевые ошибки игнорируем — повторим по таймеру
  } finally {
    polling = false;
    state.lastPoll = Date.now();
  }
}

// Сериализация: все запросы статуса встают в очередь (промис-цепочку),
// чтобы два запроса не бежали одновременно. Из-за гонки один мог ответить 200,
// а второй — 403, и затёр бы состояние ПОСЛЕ успеха (кнопка показывала «нет»
// при лайкнутом треке). await refreshLike() ждёт всю цепочку.
let likeChain = Promise.resolve();

function refreshLike(force) {
  if (!auth.hasToken() || !state.track) return Promise.resolve();
  if (state.likedKnown && !force) return Promise.resolve();
  likeChain = likeChain.then(() => doRefreshLike()).catch((e) => log('[like] ошибка:', e && e.message || e));
  return likeChain;
}

async function doRefreshLike() {
  log('[like] запрос статуса:', state.track.id);
  try {
    let res = state.likeLegacy
      ? await spotify.isLikedLegacy(state.track.id)
      : await spotify.isLiked(state.track.id);
    // Ошибка на современном /v1/me/tracks/contains — пробуем старый /v1/me/library/contains
    // (как в официальном плагине MiraBox, который у тебя работает): у части аккаунтов работают
    // только старые эндпоинты (403/400 на новых, хотя права на месте).
    // После первого успеха через старый эндпоинт запоминаем — дальше ходим сразу туда.
    if (!(res.status >= 200 && res.status < 300) && !state.likeLegacy) {
      log('[like] ' + res.status + ' на /me/tracks/contains, пробую /me/library/contains');
      try { res = await spotify.isLikedLegacy(state.track.id); } catch (e2) { /* ниже обработаем */ }
    }
    log('[like] ответ:', res.status, JSON.stringify(res.data));
    if (res.status === 200) {
      const val = res.data && res.data[0];
      state.liked = !!(Array.isArray(val) ? val[0] : val);
      state.likedKnown = true;
      state.library403 = false;
      state.like403At = 0;
      state.likeLegacy = true; // старый эндпоинт сработал — используем его дальше
      state.likedCache[state.track.id] = state.liked;
      saveLikeCache();
      renderLikeAll();
    } else if (res.status === 403) {
      // 403 и на старом эндпоинте = у токена нет права user-library-read.
      // Лечится переподключением аккаунта; повторные запросы не помогут — не спамим.
      const msg = (res.data && res.data.error && (res.data.error.message || res.data.error.status)) || 'нет данных';
      state.library403 = true;
      state.like403At = Date.now() + 30000;
      pushAuthState();
      const sc = auth.scopes();
      const hasLib = sc ? sc.indexOf('user-library-read') !== -1 : null;
      log('[like] 403:', msg, '— права токена:', sc ? sc.join(', ') : '(не удалось прочитать)', hasLib === true ? '— user-library-read есть ✓, но Spotify всё равно 403.' : hasLib === false ? '— user-library-read НЕТ ✗. Нажмите «Выйти» и «Войти через Spotify» заново.' : '— права не прочитать (токен может быть не-JWT); если лайк не работает — «Выйти» → «Войти» заново.');
    }
  } catch (e) { log('[like] ошибка:', e && e.message || e); }
}

let _summaryAt = 0;

function tick() {
  const now = Date.now();
  // Периодическая сводка состояния — чтобы по логу было видно, что плагин видит
  // (трек, громкость, лайк, права токена) без кучи отдельных строк.
  if (now - _summaryAt > 30000) {
    _summaryAt = now;
    const sc = auth.scopes();
    const hasLib = sc ? sc.indexOf('user-library-read') !== -1 : false;
    log('[summary] трек=' + (state.track ? state.track.name : '-') +
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
  if (now - state.lastPoll > 2500) poll();
  if (state.empty === 'none' && state.isPlaying && state.track) {
    state.progressMs = Math.min(state.track.durationMs, state.progressMs + (now - (state._lastTick || now)));
  }
  // Лайк: если статус ещё не известен (или первый запрос не прошёл) — пробуем снова
  if (state.track && !state.likedKnown && now > state.likeRetryAt && now > (state.like403At || 0)) {
    state.likeRetryAt = now + 5000;
    refreshLike();
  }
  state._lastTick = now;
  renderDynamicAll(false);
  // Время на дисплее энкодера перемотки
  if (actions.seek.contexts.size) {
    const t = state.track ? fmtTime(state.progressMs) + ' / ' + fmtTime(state.track.durationMs) : '';
    for (const ctx of actions.seek.contexts) plugin.setTitle(ctx, t);
  }
  // Громкость на дисплее энкодера громкости
  if (actions.volume.contexts.size) {
    for (const ctx of actions.volume.contexts) actions.volume.updateTitle(ctx);
  }
}

setInterval(tick, 1000);
// Бегущая строка: опрашиваем часто, но реальная перерисовка происходит только
// когда меняется фаза кадра (2 кадра/с) — дедупликация в сигнатуре
setInterval(() => { if (auth.hasToken()) renderDynamicAll(false); }, 100);
setTimeout(poll, 500);

/* ============================== Обработка нажатий ============================== */

function ensureAuthed(ctx) {
  if (auth.hasToken()) return true;
  plugin.showAlert(ctx);
  return false;
}

async function togglePlayPause(ctx) {
  if (!ensureAuthed(ctx)) return;
  const target = !state.isPlaying;
  // Оптимистично: без галочек и без ложных ошибок.
  // 404 = "нет активного устройства" (устройство "засыпает" после паузы) —
  // повторяем play через секунду, чтобы трек продолжился с первого нажатия.
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
  } catch (e) {
    if (e instanceof AuthError) onAuthFailure();
    plugin.showAlert(ctx);
  }
}

async function toggleLike(ctx) {
  if (!ensureAuthed(ctx)) return;
  if (!state.track) { plugin.showAlert(ctx); return; }
  // Если статус неизвестен — сначала узнаём РЕАЛЬНЫЙ статус, а не тогглим вслепую:
  // иначе на лайкнутой кнопке нажатие «снимало» лайк (кнопка показывала «нет»,
  // а трек был лайкнут) или наоборот.
  if (!state.likedKnown) {
    await refreshLike(true);
    if (!state.likedKnown) { plugin.showAlert(ctx); return; }
  }
  const prev = state.liked;
  const target = !state.liked;
  // Оптимистично показываем новое состояние
  state.liked = target;
  state.likedKnown = true;
  renderLikeAll();
  try {
    let res = state.likeLegacy
      ? await spotify.setLikedLegacy(state.track.id, target)
      : await spotify.setLiked(state.track.id, target);
    // Ошибка на современном /v1/me/tracks — пробуем старый /v1/me/library (как в официальном плагине).
    if (!(res.status >= 200 && res.status < 300) && !state.likeLegacy) {
      log('[like] set ' + res.status + ' на /me/tracks, пробую /me/library');
      try { res = await spotify.setLikedLegacy(state.track.id, target); } catch (e2) { /* ниже обработаем */ }
    }
    if (res.status >= 200 && res.status < 300) {
      state.likeLegacy = true;
      state.likedCache[state.track.id] = target;
      saveLikeCache();
      // Подтверждаем реальный статус — чтобы кнопка точно совпала с треком
      refreshLike(true);
    } else {
      // Spotify отказал и на старом, и на новом эндпоинте: откатываем иконку
      log('[like] set ответ:', res.status, JSON.stringify(res.data));
      if (res.status === 403) {
        const sc = auth.scopes();
        const hasLib = sc ? sc.indexOf('user-library-modify') !== -1 : null;
        state.library403 = true;
        state.like403At = Date.now() + 30000;
        pushAuthState();
        log('[like] set 403:', '— права токена:', sc ? sc.join(', ') : '(не удалось прочитать)', hasLib ? '— user-library-modify есть ✓, но Spotify 403.' : '— user-library-modify НЕТ ✗. Нажмите «Выйти» и «Войти через Spotify» заново.');
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

// Перемотка энкодером: каждый тик = 5 секунд (как в референс-плагине).
// Быстрые тики накапливаются и сбрасываются одним запросом через 120 мс.
function seekByTicks(ctx, ticks, action) {
  if (!ensureAuthed(ctx)) return;
  if (!state.track || state.empty !== 'none') { plugin.showAlert(ctx); return; }
  const st = action._seek || (action._seek = {});
  const base = st.target != null ? st.target : state.progressMs;
  const target = clamp(base + ticks * 5000, 0, state.track.durationMs);
  st.target = target;
  // сразу показываем новую позицию на дисплее энкодера
  plugin.setTitle(ctx, fmtTime(target) + ' / ' + fmtTime(state.track.durationMs));
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    st.timer = null;
    st.target = null;
    state.progressMs = target;
    spotify.seek(target).catch((e) => {
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
  plugin.sendToPI({ type: 'auth', ...auth.publicState(), scopes: auth.scopes(), libraryError: state.library403, player: playerSummary() });
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
    step('Проверяем Client ID и Client Secret…');
    const { url } = auth.prepareLogin();
    step('Локальный сервер запущен, открываем браузер…');
    plugin.openUrl(url);
    plugin.sendToPI({ type: 'loginUrl', url, message: 'Если браузер не открылся сам — нажмите на ссылку ниже.' });
    step('Ждём подтверждения в браузере…');
    const code = await auth.waitForCode();
    step('Обмениваем код на токены…');
    await auth.exchangeCode(code);
    log('[login] токены получены');
    logScopes();
    try {
      const me = await spotify.me();
      if (me.status === 200 && me.data) {
        auth.account = me.data.display_name || me.data.id || null;
        auth.save();
      }
    } catch (e) { /* имя аккаунта не критично */ }
    state.empty = 'none';
    state.library403 = false;
    state.like403At = 0;
    state.likeLegacy = false;
    state.likedKnown = false;
    renderAll(true);
    poll();
    if (state.track) refreshLike(true); // после переподключения сразу проверить лайк
    pushAuthState();
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    log('[login] ошибка:', msg);
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
  // Панель шлёт context = uuid плагина, а настройки нужно применить к кнопке.
  // Панель передаёт контекст своей кнопки в payload.buttonContext — применяем к нему,
  // иначе настройки попадали на первую кнопку действия (важно, когда кнопок несколько).
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
        text = '(файл лога пока пуст: ' + LOG_FILE + ')';
      }
      plugin.sendToPI({ type: 'log', text });
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
        log('[settings] НЕ применено: action=', action && action.name, 'target=', target, 'payload.settings=', payload.settings);
      }
      break;
    }
    default:
      break;
  }
}

/* ============================== Запуск ============================== */

process.on('uncaughtException', (e) => log('[uncaughtException]', e && e.stack || e));
process.on('unhandledRejection', (e) => log('[unhandledRejection]', e && e.stack || e));

log('Лог плагина: ' + LOG_FILE);
// scopes логируются после загрузки токена (didReceiveGlobalSettings / вход)
