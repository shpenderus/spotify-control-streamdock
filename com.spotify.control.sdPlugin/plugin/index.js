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

// «Писать лог» — настройка пользователя (по умолчанию ВЫКЛ). Когда выключено,
// log() ничего не пишет — ноль ресурсов на логирование. Хранится в глобальных настройках.
let logEnabled = false;

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
          if (spot.clientSecret) spot.clientSecret = '***';
        }
        pl = copy;
      } catch (e) { /* ignore */ }
    }
    log('Сообщение от StreamDock:', data.event, data.action || '', pl !== undefined ? JSON.stringify(pl) : '');
    if (data.event === 'didReceiveGlobalSettings') {
      const gs = (data.payload && data.payload.settings) || {};
      const spot = gs.spotify || null;
      // вкл/выкл лога — глобальная настройка пользователя (по умолчанию выкл)
      if (typeof gs.logEnabled === 'boolean') {
        logEnabled = gs.logEnabled;
        setEnabled(logEnabled);
      }
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
        // Устройство могло погасить клавиши в простое — перерисовываем всё,
        // чтобы вся панель вернулась уже по первому нажатию.
        bumpAll();
        if (action) action.keyDown(ctx);
        break;
      case 'keyUp':
        if (action) action.keyUp(ctx);
        break;
      case 'dialRotate':
        // То же, что и keyDown — перерисовываем всё (с дебаунсом: энкодер
        // шлёт много тиков за один поворот) на случай простоя устройства.
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
    plugin.setGlobalSettings({ spotify: auth.toJSON(), logEnabled });
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
  progressAt: 0,   // когда progressMs последний раз получен с сервера (для точного локального инкремента)
  repeat: 'off',
  shuffle: false,
  liked: false,
  likedKnown: false,
  likeRetryAt: 0,
  like403At: 0,
  likeLegacy: false, // старый эндпоинт /v1/me/library работает лучше новых — используем его
  library403: false,
  apiError: null,
  volume: null,       // 0..100, громкость активного устройства (из /me/player)
  deviceId: null,     // id активного устройства (нужен для /volume)
  deviceName: null,   // имя активного устройства (для кнопки «Устройство»)
  trackStartedAt: 0,  // когда начался текущий трек (адаптивный поллинг)
  userUri: null,      // spotify:user:{id} — для «Любимых треков»
  episode: null,      // текущий подкаст/эпизод (для кнопки «Назад»)
  episodeProgress: 0, // его позиция, мс
  episodeProgressAt: 0,
  lastPoll: 0,
  lastPollOk: 0, // когда poll последний раз УСПЕШНО обновил состояние (не сетевой сбой)
  endPollId: null, // id трека, для которого уже отправлен опрос в конце трека
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
    // Кэш не должен расти бесконечно (по записи на каждый проверенный трек)
    const keys = Object.keys(state.likedCache);
    if (keys.length > 200) {
      for (let i = 0; i < keys.length - 200; i++) delete state.likedCache[keys[i]];
    }
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

// Лайк/повтор/шаффл рисуются через setImage (готовые SVG data-URL), а не setState:
// на StreamDock (MiraBox) setState оставляет кнопку пустой на устройстве (приложение
// не находит картинку состояния), тогда как setImage работает всегда.
class LikeAction extends Action {
  constructor() { super('like', {}); }

  // 'like' = не лайкнут, 'liked' = лайкнут, 'like-load' = статус неизвестен (загружается / нет прав)
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
    // Серия быстрых тиков одного поворота объединяется в ОДНО переключение трека
    // (по направлению суммарных тиков) — как у громкости и перемотки. Иначе один
    // поворот энкодера перескакивал через 3–5 треков.
    const all = this._track || (this._track = {});
    const s = all[ctx] || (all[ctx] = {});
    s.net = (s.net || 0) + ticks;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      const net = s.net;
      s.net = 0;
      if (net === 0) return;
      const fn = net > 0 ? () => spotify.next() : () => spotify.previous();
      fn().then(() => { safePoll(); recheckAfterSkip(); }).catch((e) => {
        if (e instanceof AuthError) onAuthFailure();
        plugin.showAlert(ctx);
      });
    }, 120);
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
    // Состояние серии вращения — на КАЖДУЮ кнопку (st[ctx]), как у перемотки:
    // общий объект на все кнопки приводил к конфликту двух энкодеров громкости.
    const all = this._vol || (this._vol = {});
    const st = all[ctx] || (all[ctx] = {});
    if (state.volume == null) {
      // Алерт не чаще раза в 2 секунды (иначе спам на каждый тик).
      if (!st.alertAt || Date.now() - st.alertAt > 2000) {
        st.alertAt = Date.now();
        plugin.showAlert(ctx);
      }
      return;
    }
    const base = st.target != null ? st.target : state.volume;
    // Шаг одного эвента ограничен 10%: на некоторых устройствах первый эвент
    // после простоя несёт большой ticks (тот же баг, что и с перемоткой),
    // и без ограничения один щелчок прыгал бы на 40%+.
    const rawDelta = ticks * 2;
    const delta = clamp(rawDelta, -10, 10);
    if (delta !== rawDelta) log('[volume] большой ticks =', ticks, '— шаг ограничен 10%');
    const target = clamp(base + delta, 0, 100);
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

/* ---------- Кнопка плейлиста ---------- */

// Кнопка-плейлист: нажатие запускает выбранный в настройках плейлист
// (или «Любимые треки»). На кнопке — иконка и название плейлиста.
class PlaylistAction extends Action {
  constructor() { super('playlist', { playlistId: '', playlistName: '', playlistUri: '' }); }

  render(ctx) {
    const s = this.get(ctx);
    this.setIcon(ctx, render.renderLabelButton({
      glyph: 'playlist',
      text: s.playlistName || 'Плейлист',
      phase: Date.now(),
      pressed: this.pressed.has(ctx)
    }));
  }

  keyUp(ctx) {
    this.pressed.delete(ctx);
    this.render(ctx, true);
    playPlaylist(ctx);
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
  volume: new VolumeEncoderAction('volume'),
  playlist: new PlaylistAction()
};
for (const name of Object.keys(actions)) plugin.actions[name] = actions[name];

/* ============================== Обложки ============================== */

const coverCache = new Map();    // url -> dataUrl
const coverLuma = new Map();     // url -> средняя яркость нижней части (0..255) или null
const coverLoading = new Map();  // url -> Promise
const coverFailed = new Map();   // url -> время последней ошибки (повтор через 5 мин)

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
    .catch((e) => {
      coverLoading.delete(url);
      coverFailed.set(url, Date.now());
      if (coverFailed.size > 50) {
        const k = coverFailed.keys().next().value;
        coverFailed.delete(k);
      }
      log('[cover] ошибка загрузки:', e && e.message || e);
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

// Кнопка с подписью (плейлист): перерисовывается по таймеру (marquee) —
// дедупликация картинок в setIcon не даёт лишних пересылок.
function renderLabelAll(force) {
  for (const ctx of actions.playlist.contexts) actions.playlist.render(ctx, force);
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
  // Статические иконки (next/previous/энкодеры) рисуются только один раз в willAppear,
  // поэтому стартовые перерисовки (ретрай вызывает renderAll(true)) должны доходить
  // и до них — иначе устройство теряет картинку при старте, и кнопка остаётся пустой.
  for (const name of ['next', 'previous', 'seek', 'track', 'volume', 'playlist']) {
    for (const ctx of actions[name].contexts) actions[name].render(ctx, force);
  }
}

/* ============================== Опрос Spotify ============================== */

let polling = false;
// Рейт-лимит Spotify (429): после попадания не опрашиваем API какое-то время,
// чтобы квота успела сброситься — долбёжка во время 429 только держит лимит.
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
      if (changed) log('[poll] трек:', track.name, '-', track.artists);
      state.track = track;
      state.isPlaying = !!d.is_playing;
      state.progressMs = d.progress_ms || 0;
      state.progressAt = Date.now();
      state.lastPollOk = Date.now();
      state.repeat = d.repeat_state || 'off';
      state.shuffle = !!d.shuffle_state;
      state.volume = (d.device && typeof d.device.volume_percent === 'number') ? d.device.volume_percent : state.volume;
      state.deviceId = (d.device && d.device.id) || null;
      state.deviceName = (d.device && d.device.name) || state.deviceName;
      state.episode = null;
      state.empty = 'none';
      if (changed) {
        state.trackStartedAt = Date.now();
        // сначала показываем кэшированный статус лайка (если есть),
        // затем в фоне подтверждаем актуальный
        const has = Object.prototype.hasOwnProperty.call(state.likedCache, track.id);
        state.liked = has ? !!state.likedCache[track.id] : false;
        state.likedKnown = has;
        refreshLike(true);
      }
      renderAll(changed);
    } else if (res.status === 204 || (res.status === 200 && !res.data.item)) {
      if (state.track || state.empty !== 'nodevice' || state.likedKnown) {
        state.track = null;
        state.isPlaying = false;
        state.empty = 'nodevice';
        state.deviceName = null;
        state.deviceId = null;
        state.trackStartedAt = 0;
        state.episode = null;
        state.liked = false;
        state.likedKnown = false;
        state.lastPollOk = Date.now();
        renderAll(true);
      }
    } else if (res.status === 200 && res.data && res.data.item) {
      // Подкаст, эпизод или реклама — не трек: показывать нечего, состояние
      // раньше застревало на прошлой песне (кнопка «врала» весь эпизод).
      const playing = !!res.data.is_playing;
      // Прогресс эпизода обновляем на каждом опросе — кнопка «Назад» по нему
      // решает: >3 c в эпизоде — перезапуск, иначе — предыдущий эпизод.
      state.episode = { id: res.data.item.id, durationMs: res.data.item.duration_ms || 0 };
      state.episodeProgress = res.data.progress_ms || 0;
      state.episodeProgressAt = Date.now();
      if (state.track || state.empty !== 'notrack' || state.isPlaying !== playing || state.likedKnown) {
        state.track = null;
        state.isPlaying = playing;
        state.empty = 'notrack';
        state.trackStartedAt = 0;
        state.liked = false;
        state.likedKnown = false;
        state.lastPollOk = Date.now();
        renderAll(true);
      }
    } else if (res.status === 429) {
      log('[poll] 429 rate limit — backing off for 30s');
      nextPollAt = Date.now() + 30000;
    } else if (res.status === 403) {
      log('[poll] 403 Forbidden —', res.message || 'требуется Spotify Premium или нет доступа к плееру');
      if (res.message) state.apiError = res.message;
      if (state.empty !== 'premium') { state.empty = 'premium'; renderAll(true); }
      pushAuthState();
    } else if (res.status === 404) {
      log('[poll] 404 Not Found — активное устройство не найдено');
    } else if (res.status === 401) {
      log('[poll] 401 Unauthorized — токен недействителен');
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

// Опрос с уважением к backoff (429): обработчики нажатий звали poll()
// напрямую и сбрасывали nextPollAt, долбя API во время рейт-лимита.
// safePoll() пропускает опрос, пока действует пауза после 429.
function safePoll() {
  if (Date.now() < nextPollAt) return Promise.resolve(false);
  const p = poll();
  return p || Promise.resolve(false);
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
    // Не-2xx на текущем эндпоинте — пробуем другой (современный /v1/me/tracks/contains
    // или старый /v1/me/library/contains, как в официальном плагине MiraBox): у части
    // аккаунтов работают только старые эндпоинты (403/400 на новых, хотя права на месте),
    // и наоборот. Запоминаем, какой эндпоинт реально сработал, чтобы не дёргать мёртвый.
    if (!(res.status >= 200 && res.status < 300)) {
      log('[like] ' + res.status + ' на ' + (state.likeLegacy ? '/me/library/contains' : '/me/tracks/contains') + ', пробую другой эндпоинт');
      try {
        const alt = state.likeLegacy
          ? await spotify.isLiked(state.track.id)
          : await spotify.isLikedLegacy(state.track.id);
        res = alt;
        if (alt.status >= 200 && alt.status < 300) state.likeLegacy = !state.likeLegacy;
      } catch (e2) { /* ниже обработаем */ }
    }
    log('[like] ответ:', res.status, JSON.stringify(res.data));
    if (res.status === 200) {
      const val = res.data && res.data[0];
      state.liked = !!(Array.isArray(val) ? val[0] : val);
      state.likedKnown = true;
      state.library403 = false;
      state.like403At = 0;
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

function pollInterval() {
  // Адаптивный интервал опроса. Пока трек играет — чем дольше он играет, тем
  // реже опрашиваем (бережём лимиты API). НО трек вот-вот закончится — опрос
  // ускоряется до 5 с, чтобы обложка и название СЛЕДУЮЩЕГО трека появились
  // сразу, а не через адаптивную паузу. На паузе — 60 с (как раньше).
  if (!state.isPlaying || !state.track) return 60000;
  if (state.track.durationMs > 0 && state.track.durationMs - state.progressMs <= 10000) return 5000;
  const age = Date.now() - state.trackStartedAt;
  if (age < 120000) return 10000; // первые 2 минуты трека
  if (age < 300000) return 20000; // 2–5 минут
  return 30000;                   // дольше 5 минут
}

function tick() {
  const now = Date.now();
  // Компьютер был в сне (или приложение/устройство надолго зависло): устройство
  // могло погасить клавиши или переподключиться. Заново отправляем все картинки
  // с парой повторов — приложение может в этот момент ещё переподключать устройство.
  const lastTick = state._lastTick || now;
  if (now - lastTick > 15000) {
    log('[wake] разрыв ' + Math.round((now - lastTick) / 1000) + 'с — перерисовываю все кнопки');
    bumpAllDelayed();
  }
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
  if (now >= nextPollAt && now - state.lastPoll > pollInterval()) poll();
  if (state.empty === 'none' && state.isPlaying && state.track) {
    // Точный локальный инкремент: от момента получения progressMs с сервера,
    // а не от конца прошлого тика (иначе позиция убегала вперёд до ~1 сек).
    const base = state.progressAt || now;
    state.progressMs = Math.min(state.track.durationMs, state.progressMs + (now - base));
    state.progressAt = now;
  }
  // Прогресс подкаста — то же самое, для кнопки «Назад»
  if (state.empty === 'notrack' && state.isPlaying && state.episode) {
    const ebase = state.episodeProgressAt || now;
    state.episodeProgress = Math.min(state.episode.durationMs || Number.MAX_SAFE_INTEGER, state.episodeProgress + (now - ebase));
    state.episodeProgressAt = now;
  }
  // Текущий трек вот-вот закончится (локальная оценка) — опрашиваем сразу,
  // чтобы информация о следующем треке (название, обложка, лайк) появилась
  // мгновенно, а не через 10 сек. Один раз на трек: маркер защищает от
  // повторных запросов, если запрос не прошёл и прогресс застрял на конце.
  if (state.empty === 'none' && state.isPlaying && state.track &&
      state.track.durationMs - state.progressMs <= 1000 &&
      now >= nextPollAt &&
      state.endPollId !== state.track.id) {
    state.endPollId = state.track.id;
    poll();
  }
  // Лайк: если статус ещё не известен (или первый запрос не прошёл) — пробуем снова
  if (state.track && !state.likedKnown && now > state.likeRetryAt && now > (state.like403At || 0)) {
    state.likeRetryAt = now + 5000;
    refreshLike();
  }
  state._lastTick = now;
  renderDynamicAll(false);
  renderLabelAll(false);
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
setInterval(() => { if (auth.hasToken()) { renderDynamicAll(false); renderLabelAll(false); } }, 100);
setTimeout(poll, 500);

// StreamDock (MiraBox) молча теряет setImage/setState, отправленные в первые
// мгновения после подключения плагина, пока устройство ещё инициализирует
// клавиши. Кнопки, которые рисуются один раз в willAppear (next, previous,
// энкодеры), остались бы на устройстве пустыми до первого нажатия.
// Повторно отправляем картинки всех кнопок несколько раз с задержкой.
{
  // Ранние проходы лучше накрывают стартовое окно потери картинок, чем один интервал
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

// Перерисовываем все кнопки в обход дедупликации по сигнатуре, чтобы картинки
// реально ушли на устройство заново. Используется после «пробуждения» и по
// нажатию кнопки/повороту энкодера (устройство могло погасить клавиши в
// простое) — но НЕ по таймеру: поток картинок во время простоя приводил к
// тому, что устройство переставало реагировать вообще на всё до перезапуска.
let wakeRenders = 0;
let lastDialBump = 0;
function bumpAll() {
  for (const name of Object.keys(actions)) {
    actions[name].icons.clear();
    actions[name].sig.clear();
  }
  renderAll(true);
}
// После выхода из сна устройство может переподключаться с задержкой —
// отправляем картинки несколько раз с небольшими интервалами.
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
      res = await spotify.setPlay(true);
    }
    if (res.status === 403) {
      log('[play] 403 Forbidden — требуется Spotify Premium');
      plugin.showAlert(ctx);
    } else if (res.status === 404) {
      log('[play] 404 Not Found — активное устройство не найдено (запустите Spotify)');
      plugin.showAlert(ctx);
    }
  } catch (e) {
    if (e instanceof AuthError) { onAuthFailure(); return; }
    plugin.showAlert(ctx);
  }
  safePoll();
}

async function onNext(ctx) {
  if (!ensureAuthed(ctx)) return;
  try {
    const res = await spotify.next();
    if (res && res.status === 403) {
      log('[next] 403 Forbidden — требуется Spotify Premium');
      plugin.showAlert(ctx);
    }
    safePoll();
    recheckAfterSkip();
  } catch (e) {
    if (e instanceof AuthError) onAuthFailure();
    plugin.showAlert(ctx);
  }
}

async function onPrevious(ctx) {
  if (!ensureAuthed(ctx)) return;
  try {
    // «Назад» как в Spotify: если трек играет больше ~3 секунд — возвращаемся
    // в начало трека, а повторное нажатие (трек в начале) — на предыдущий.
    // Прогресс сбрасываем локально: немедленный опрос после seek откатил бы
    // позицию назад (см. дизайн перемотки энкодера).
    const restartable = (state.track && state.progressMs > 3000) ||
      (state.empty === 'notrack' && state.episode && state.episodeProgress > 3000);
    if (restartable) {
      await spotify.seek(0);
      state.progressMs = 0;
      state.progressAt = Date.now();
      state.episodeProgress = 0;
      state.episodeProgressAt = Date.now();
      state.endPollId = null;
      renderDynamicAll(false);
    } else {
      const res = await spotify.previous();
      if (res && res.status === 403) {
        log('[previous] 403 Forbidden — требуется Spotify Premium');
        plugin.showAlert(ctx);
      }
      safePoll();
      recheckAfterSkip();
    }
  } catch (e) {
    if (e instanceof AuthError) onAuthFailure();
    plugin.showAlert(ctx);
  }
}

// Spotify переключает трек асинхронно: poll() сразу после next/previous часто
// ещё возвращает СТАРЫЙ трек, а следующий плановый опрос — через 10 сек.
// Перепроверяем несколько раз (с интервалом 1.5 сек), пока не увидим новый
// трек. Ограничено: максимум 5 лишних опросов на нажатие, квоту не жжёт.
let _skipRecheck = null;

function recheckAfterSkip() {
  const startId = state.track ? state.track.id : null;
  let tries = 0;
  if (_skipRecheck) clearTimeout(_skipRecheck);
  const attempt = () => {
    if (tries >= 5) return;
    tries++;
    safePoll().then(() => {
      if (state.track && state.track.id !== startId) return; // переключился — готово
      _skipRecheck = setTimeout(attempt, 1500);
    });
  };
  _skipRecheck = setTimeout(attempt, 1500);
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
    // Не-2xx на текущем эндпоинте — пробуем другой (как в официальном плагине MiraBox)
    // и запоминаем, какой реально сработал.
    if (!(res.status >= 200 && res.status < 300)) {
      log('[like] set ' + res.status + ' на ' + (state.likeLegacy ? '/me/library' : '/me/tracks') + ', пробую другой');
      try {
        const alt = state.likeLegacy
          ? await spotify.setLiked(state.track.id, target)
          : await spotify.setLikedLegacy(state.track.id, target);
        res = alt;
        if (alt.status >= 200 && alt.status < 300) state.likeLegacy = !state.likeLegacy;
      } catch (e2) { /* ниже обработаем */ }
    }
    if (res.status >= 200 && res.status < 300) {
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
  const prev = state.repeat;
  state.repeat = next;
  renderRepeatAll();
  try {
    await spotify.setRepeat(next);
  } catch (e) {
    if (e instanceof AuthError) onAuthFailure();
    // Ошибка API — откатываем иконку, чтобы кнопка не «врала» до следующего опроса.
    state.repeat = prev;
    renderRepeatAll();
    plugin.showAlert(ctx);
  }
}

async function toggleShuffle(ctx) {
  if (!ensureAuthed(ctx)) return;
  const target = !state.shuffle;
  const prev = state.shuffle;
  state.shuffle = target;
  renderShuffleAll();
  try {
    await spotify.setShuffle(target);
  } catch (e) {
    if (e instanceof AuthError) onAuthFailure();
    state.shuffle = prev;
    renderShuffleAll();
    plugin.showAlert(ctx);
  }
}
/* ---------- Плейлист ---------- */

async function playPlaylist(ctx) {
  if (!ensureAuthed(ctx)) return;
  const s = actions.playlist.get(ctx);
  if (!s.playlistUri) { plugin.showAlert(ctx); return; }
  try {
    let res = await spotify.playContext(s.playlistUri, state.deviceId || undefined);
    if (res.status === 404) {
      // активное устройство пропало — пробуем ещё раз без привязки к нему
      await new Promise((r) => setTimeout(r, 900));
      res = await spotify.playContext(s.playlistUri);
    }
    if (!(res.status >= 200 && res.status < 300)) {
      log('[playlist] ответ:', res.status, JSON.stringify(res.data));
      plugin.showAlert(ctx);
    }
  } catch (e) {
    if (e instanceof AuthError) { onAuthFailure(); return; }
    plugin.showAlert(ctx);
  }
  safePoll();
}

// Список для панели: «Любимые треки» + первые 50 плейлистов пользователя
async function fetchPlaylists() {
  const items = [{ id: 'liked', name: '❤️ Любимые треки', uri: null }];
  try {
    if (!state.userUri) {
      const me = await spotify.me();
      if (me.status === 200 && me.data && me.data.id) state.userUri = 'spotify:user:' + me.data.id;
    }
    if (state.userUri) items[0].uri = state.userUri + ':collection';
    const res = await spotify.playlists();
    if (res.status === 200 && Array.isArray(res.data && res.data.items)) {
      for (const p of res.data.items) {
        if (p && p.id && p.name) items.push({ id: p.id, name: p.name, uri: p.uri || '' });
      }
    } else {
      log('[playlists] ответ:', res.status, JSON.stringify(res.data));
    }
  } catch (e) {
    log('[playlists] ошибка:', e && e.message || e);
  }
  return items;
}

// Перемотка энкодером: каждый тик = 5 секунд (как в референс-плагине).
// Быстрые тики накапливаются и сбрасываются одним запросом через 120 мс.
// Перемотка энкодером. Серия тиков накапливается в буфере и применяется ОДНИМ
// запросом seek после паузы во вращении (SEEK_BURST_MS). КАЖДАЯ новая серия
// начинается со свежего опроса: позиция в состоянии может быть от ПРЕДЫДУЩЕГО
// трека — трек только что сменился (next/плейлист), а poll ещё не догнал, и
// seek с такой базой улетал на полтрека вперёд/назад. Плюс:
//   * шаг одного эвента ограничен 30 с — одиночный «шумовой» эвент не может
//     перемотать далеко, а непрерывное вращение продолжает копить дальше;
//   * после seek НЕТ немедленного опроса — он мог вернуть позицию, снятую до
//     применения seek, и перезаписать прогресс старым значением (seek «прыгал
//     назад», когда крутишь только вперёд). Плановый опрос всё выровняет.
const SEEK_BURST_MS = 300;      // окно накопления тиков, мс
const SEEK_MAX_STEP_MS = 30000; // максимум перемотки за один эвент, мс

// Свежий опрос перед серией вращения: ждём текущий (если идёт, не дольше 3 с)
// или запускаем новый. Разрешается true, только если poll реально получил
// свежий ответ (lastPollOk сдвинулся), а не упал по сети/429. При активном
// 429-backoff серия пропускается — база может быть от старого трека.
function ensureFreshPoll() {
  const before = state.lastPollOk;
  const finish = () => state.lastPollOk > before;
  if (polling) {
    // опрос уже идёт — дожидаемся его результата
    return new Promise((resolve) => {
      const started = Date.now();
      const iv = setInterval(() => {
        if (!polling || Date.now() - started > 3000) {
          clearInterval(iv);
          resolve(finish());
        }
      }, 100);
    });
  }
  if (Date.now() < nextPollAt) {
    // 429-backoff: свежий опрос невозможен, а база может быть от старого трека
    // (трек сменился, пока опросы заблокированы) — вслепую не перематываем,
    // серия пропускается; следующее вращение попробует после паузы.
    return Promise.resolve(false);
  }
  const p = poll();
  return p ? p.then(finish) : Promise.resolve(finish());
}

async function seekByTicks(ctx, ticks, action) {
  if (!ensureAuthed(ctx)) return;
  // Состояние на каждую кнопку (один экземпляр действия обслуживает все
  // кнопки энкодера перемотки): накопленный таргет и таймер дебаунса
  // не должны смешиваться между кнопками.
  const st = action._seek || (action._seek = {});
  const s = st[ctx] || (st[ctx] = {});
  if (!state.track || state.empty !== 'none') {
    // Не спамим алертами на каждый тик — не чаще раза в 2 секунды.
    if (!s.alertAt || Date.now() - s.alertAt > 2000) {
      s.alertAt = Date.now();
      plugin.showAlert(ctx);
    }
    return;
  }
  if (!s.rotTrackId) {
    // Начало новой серии: база обязана быть от ТЕКУЩЕГО трека. Тики копим,
    // пока идёт свежий опрос, затем применяем один раз.
    s.rotTrackId = state.track.id;
    s.awaiting = true;
    s.pendingTicks = (s.pendingTicks || 0) + ticks;
    ensureFreshPoll().then((ok) => {
      s.awaiting = false;
      const t = s.pendingTicks;
      s.pendingTicks = 0;
      if (!ok || !state.track || state.empty !== 'none') {
        // Свежий ответ не получили (сеть/429/опрос идёт) — вслепую не
        // перематываем; следующее вращение попробует снова.
        s.rotTrackId = null;
        return;
      }
      s.rotTrackId = state.track.id; // привязываемся к актуальному треку
      if (t !== 0) accumulateSeek(ctx, s, t);
    }).catch(() => { s.awaiting = false; s.rotTrackId = null; });
    return;
  }
  if (s.awaiting) { s.pendingTicks = (s.pendingTicks || 0) + ticks; return; }
  accumulateSeek(ctx, s, ticks);
}

function accumulateSeek(ctx, s, ticks) {
  const base = s.target != null ? s.target : state.progressMs;
  const rawDelta = ticks * 5000;
  const delta = clamp(rawDelta, -SEEK_MAX_STEP_MS, SEEK_MAX_STEP_MS);
  if (delta !== rawDelta) {
    log('[seek] большой ticks =', ticks, '— шаг ограничен', SEEK_MAX_STEP_MS / 1000 + 'с');
  }
  const target = clamp(base + delta, 0, state.track.durationMs);
  s.target = target;
  // сразу показываем новую позицию на дисплее энкодера
  plugin.setTitle(ctx, fmtTime(target) + ' / ' + fmtTime(state.track.durationMs));
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    s.target = null;
    const rotTrack = s.rotTrackId;
    s.rotTrackId = null;
    // трек сменился, пока пользователь крутил — не применяем старую позицию
    // к новому треку (Spotify перемотал бы новый трек на неё)
    if (rotTrack && rotTrack !== state.track.id) {
      log('[seek] трек сменился во время вращения — перемотку пропускаем');
      return;
    }
    const prevProgress = state.progressMs;
    state.progressMs = target;
    state.progressAt = Date.now();
    spotify.seek(target).then(() => {
      // если трек сменился, пока запрос летел, Spotify мог применить его
      // к новому треку — откатываем новый трек в начало
      if (rotTrack && rotTrack !== state.track.id) {
        log('[seek] запоздавший seek применился к', state.track.name, '— сбрасываем в 0');
        state.progressMs = 0;
        state.progressAt = Date.now();
        spotify.seek(0).catch(() => {});
      }
      // Без немедленного опроса: он мог вернуть позицию, снятую до применения
      // seek, и перезаписать прогресс старым значением («лаги» назад).
    }).catch((e) => {
      log('[seek] error:', e && e.message || e);
      if (e instanceof AuthError) { onAuthFailure(); return; }
      // seek не применился (404 нет устройства и т.п.) — возвращаем реальную
      // позицию, чтобы прогресс-бар не «врал» до планового опроса
      if (rotTrack && rotTrack === state.track.id) {
        state.progressMs = prevProgress;
        state.progressAt = Date.now();
      }
    });
  }, SEEK_BURST_MS);
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
  plugin.sendToPI({ type: 'auth', ...auth.publicState(), scopes: auth.scopes(), libraryError: state.library403, apiError: state.apiError, logEnabled, player: playerSummary() });
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
    apiError: state.apiError,
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

let loginBusy = false;

async function doLogin() {
  if (loginBusy) return; // повторный клик во время активного входа — игнорируем
  loginBusy = true;
  state.apiError = null;
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
        auth.product = me.data.product || null;
        log('[login] профиль получен:', auth.account, 'тип подписки:', auth.product);
        auth.save();
      } else {
        log('[login] me() ответ:', me.status, me.message || JSON.stringify(me.data));
        if (me.status === 403 && me.message) state.apiError = me.message;
      }
    } catch (e) {
      log('[login] me() ошибка:', e && e.message || e);
    }
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
  } finally {
    loginBusy = false;
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
    case 'getPlaylists':
      fetchPlaylists().then((items) => {
        plugin.sendToPI({ type: 'playlists', items });
      });
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
    case 'setLogEnabled': {
      const v = !!(payload && payload.enabled);
      logEnabled = v;
      setEnabled(v);
      // при каждом переключении начинаем с чистого файла,
      // чтобы кнопка «Лог» не показывала старые строки
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
