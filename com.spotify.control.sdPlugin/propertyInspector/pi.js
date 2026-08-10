'use strict';

var $ws = null;
var $uuid = null;
var $action = null;
var $context = null;
var $actionName = null;
var $settings = {};
var $wired = false;
var $gotState = false;
var $noResponseTimer = null;

var $ = function (id) { return document.getElementById(id); };

// StreamDock вызывает эту функцию при открытии панели
function connectElgatoStreamDeckSocket(port, uuid, event, app, info) {
  try { info = JSON.parse(info); } catch (e) { info = {}; }
  $uuid = uuid;
  $context = info.context || null;
  $action = info.action || null;
  $actionName = $action ? $action.split('.').pop() : null;

  $ws = new WebSocket('ws://127.0.0.1:' + port);
  $ws.onopen = function () {
    $ws.send(JSON.stringify({ event: event, uuid: uuid }));
    // после подключения запросим актуальное состояние
    setTimeout(function () { sendToPlugin({ type: 'getState' }); }, 200);
    // если плагин не ответил — скорее всего он не запустился
    $noResponseTimer = setTimeout(function () {
      if (!$gotState) {
        $('status').textContent = 'Плагин не отвечает';
        $('status').className = 'status';
        $('authMsg').textContent = 'Похоже, плагин не запустился. Перезапустите StreamDock полностью и попробуйте снова.';
        $('authMsg').className = 'msg';
      }
    }, 4000);
  };
  $ws.onmessage = function (e) {
    var data;
    try { data = JSON.parse(e.data); } catch (err) { return; }
    if (data.event === 'didReceiveSettings') {
      $settings = data.payload.settings || {};
      applySettings();
    } else if (data.event === 'sendToPropertyInspector') {
      applyPi(data.payload);
    }
  };
  $ws.onerror = function (e) {
    console.error('WebSocket ошибка:', e);
  };
}

// Подключаем обработчики кнопок сразу при загрузке страницы (не только из bootstrap)
function init() {
  if ($wired) return;
  $wired = true;
  wire();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function sendToPlugin(payload) {
  if ($ws && $ws.readyState === 1) {
    // В payload передаём контекст конкретной кнопки ($context), чтобы плагин
    // применял настройки к той кнопке, чью панель открыли, а не к первой попавшейся.
    payload = payload || {};
    payload.buttonContext = $context || null;
    $ws.send(JSON.stringify({
      event: 'sendToPlugin',
      action: $action,
      // StreamDock (как и референс-плагин) адресует сообщения плагину по uuid плагина
      context: $uuid,
      payload: payload
    }));
  }
}

function ensureWs() {
  if ($ws && $ws.readyState === 1) return true;
  $('authMsg').textContent = 'Нет связи с плагином. Проверьте, что плагин запустился (кнопка «Лог» ниже покажет подробности).';
  $('authMsg').className = 'msg';
  return false;
}

function wire() {
  var clientId = $('clientId');
  var clientSecret = $('clientSecret');
  var redirectUri = $('redirectUri');
  var loginBtn = $('loginBtn');
  var logoutBtn = $('logoutBtn');

  var saveAuth = debounce(function () {
    sendToPlugin({
      type: 'saveAuth',
      clientId: clientId.value,
      clientSecret: clientSecret.value,
      redirectUri: redirectUri.value
    });
  }, 400);

  clientId.addEventListener('input', saveAuth);
  clientSecret.addEventListener('input', saveAuth);
  redirectUri.addEventListener('input', saveAuth);

  loginBtn.addEventListener('click', function () {
    console.log('Нажата кнопка «Войти через Spotify»');
    if (!ensureWs()) return;
    loginBtn.disabled = true;
    sendToPlugin({ type: 'saveAuth', clientId: clientId.value, clientSecret: clientSecret.value, redirectUri: redirectUri.value });
    setTimeout(function () { sendToPlugin({ type: 'login' }); }, 150);
    setTimeout(function () { loginBtn.disabled = false; }, 3000);
  });

  logoutBtn.addEventListener('click', function () {
    if (!ensureWs()) return;
    sendToPlugin({ type: 'logout' });
  });

  $('logBtn').addEventListener('click', function () {
    if (!ensureWs()) return;
    sendToPlugin({ type: 'getLog' });
  });
  $('optLogEnabled').addEventListener('change', function () {
    if (!ensureWs()) return;
    sendToPlugin({ type: 'setLogEnabled', enabled: $('optLogEnabled').checked });
  });
  $('hideLogBtn').addEventListener('click', function () {
    $('logBox').hidden = true;
  });
  $('copyLogBtn').addEventListener('click', function () {
    var ta = $('logText');
    ta.select();
    var done = function () { $('copyLogBtn').textContent = 'Скопировано'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(done).catch(done);
    } else {
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      done();
    }
  });

  // ВАЖНО: шлём только изменённое поле, а не все настройки разом.
  // Иначе значения слайдеров (если сохранённые настройки ещё не пришли)
  // затирают остальные поля дефолтами — из-за этого пропадало время и не работала прозрачность.
  function saveDisplay(partial) {
    sendToPlugin({
      type: 'settings',
      settings: partial
    });
  }

  [
    ['optCover', 'cover'],
    ['optTitle', 'title'],
    ['optArtist', 'artist'],
    ['optTime', 'time'],
    ['optIcon', 'showIcon'],
    ['optContrast', 'autoContrast'],
    ['optProgress', 'progressBar']
  ].forEach(function (pair) {
    $(pair[0]).addEventListener('change', function () {
      var o = {};
      o[pair[1]] = $(pair[0]).checked;
      saveDisplay(o);
    });
  });

  var font = $('optFont');
  font.addEventListener('input', function () {
    $('fontVal').textContent = font.value;
  });
  font.addEventListener('change', function () {
    saveDisplay({ fontSize: parseInt(font.value, 10) || 13 });
  });

  // Цвет времени применяется явно кнопкой «Применить» (а не сам по себе при закрытии палитры)
  $('timeColorApply').addEventListener('click', function () {
    saveDisplay({ timeColor: $('optTimeColor').value });
  });

}

function isDynamicAction() {
  return $actionName === 'playpause' || $actionName === 'info';
}

function applySettings() {
  if (!isDynamicAction()) return;
  var s = $settings || {};
  $('optCover').checked = s.cover !== false;
  $('optTitle').checked = s.title !== false;
  $('optArtist').checked = s.artist !== false;
  $('optTime').checked = s.time === true;
  // Иконка play/pause есть только у кнопки плей/пауза
  $('iconWrap').hidden = $actionName !== 'playpause';
  $('optIcon').checked = s.showIcon === true;
  $('optContrast').checked = s.autoContrast !== false;
  $('optProgress').checked = s.progressBar !== false;
  $('optTimeColor').value = s.timeColor || '#1DB954';
  var font = parseInt(s.fontSize, 10);
  if (isFinite(font)) {
    $('optFont').value = Math.min(30, Math.max(6, font));
    $('fontVal').textContent = $('optFont').value;
  }
  $('displayCard').hidden = false;
}

function applyPi(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (payload.type === 'state') {
    $gotState = true;
    if ($noResponseTimer) { clearTimeout($noResponseTimer); $noResponseTimer = null; }
    $settings = payload.settings || {};
    applySettings();
  }

  if (payload.type === 'log') {
    $('logText').value = payload.text || '(лог пуст)';
    $('copyLogBtn').disabled = false;
    $('logBox').hidden = false;
  }

  if (payload.type === 'loginUrl') {
    var link = $('loginLink');
    link.href = payload.url || '#';
    link.hidden = false;
    if (payload.message) {
      $('authMsg').textContent = payload.message;
      $('authMsg').className = 'msg connecting';
    }
  }

  if (payload.type === 'state' || payload.type === 'auth') {
    // поля авторизации заполняем только при первом получении состояния,
    // чтобы не затирать то, что пользователь печатает
    if (!authFieldsTouched) {
      if (payload.clientId) $('clientId').value = payload.clientId;
      if (payload.hasSecret) $('clientSecret').value = '********';
      if (payload.redirectUri) $('redirectUri').value = payload.redirectUri;
    }
    $('optLogEnabled').checked = !!payload.logEnabled;
    updateAuth(payload);
  }

  if (payload.player) {
    updatePlayer(payload.player);
  }
}

var authFieldsTouched = false;
['clientId', 'clientSecret', 'redirectUri'].forEach(function (id) {
  $(id).addEventListener('input', function () { authFieldsTouched = true; });
});

function updateAuth(p) {
  var status = $('status');
  var msg = $('authMsg');
  var logoutBtn = $('logoutBtn');

  if (p.error) {
    status.textContent = 'Ошибка';
    status.className = 'status';
    msg.textContent = p.error;
    msg.className = 'msg';
    $('loginLink').hidden = true;
    return;
  }

  if (p.status === 'connecting') {
    status.textContent = 'Подключение…';
    status.className = 'status';
    msg.textContent = p.message || 'Открываем браузер. Подтвердите доступ в Spotify и вернитесь сюда.';
    msg.className = 'msg connecting';
    return;
  }

  if (p.libraryError) {
    status.textContent = p.loggedIn ? 'Подключено' : 'Не подключено';
    status.className = p.loggedIn ? 'status ok' : 'status';
    logoutBtn.disabled = !p.loggedIn;
    var sc = (p.scopes && p.scopes.length) ? p.scopes.join(', ') : '—';
    var hasLib = p.scopes && p.scopes.indexOf('user-library-read') !== -1;
    msg.textContent = hasLib
      ? '⚠️ Spotify отвечает 403 на запросы библиотеки, хотя право user-library-read у токена есть (эндпоинты /me/tracks могут быть недоступны для этого приложения). Попробуйте «Выйти» и «Войти через Spotify» заново.'
      : '⚠️ Spotify не даёт доступ к библиотеке (лайкам): у токена нет права user-library-read. Права токена: ' + sc + '. Нажмите «Выйти», затем «Войти через Spotify» заново и подтвердите доступ.';
    msg.className = 'msg';
    return;
  }

  if (p.loggedIn) {
    status.textContent = p.account ? 'Подключено: ' + p.account : 'Подключено';
    status.className = 'status ok';
    logoutBtn.disabled = false;
    msg.textContent = '';
    msg.className = 'msg';
    $('loginLink').hidden = true;
  } else {
    status.textContent = 'Не подключено';
    status.className = 'status';
    logoutBtn.disabled = true;
    if (p.clientId && p.hasSecret) {
      msg.textContent = '';
      msg.className = 'msg';
    } else {
      msg.textContent = 'Введите Client ID и Client Secret вашего Spotify-приложения.';
      msg.className = 'msg';
    }
  }
}

function updatePlayer(p) {
  var el = $('playerInfo');
  if (p.empty === 'noauth') {
    el.innerHTML = 'Войдите в аккаунт Spotify, чтобы видеть текущий трек.';
  } else if (p.empty === 'nodevice') {
    el.innerHTML = 'Сейчас ничего не играет. Запустите музыку на любом устройстве Spotify.';
  } else if (p.empty === 'premium') {
    el.innerHTML = 'Управление воспроизведением требует Spotify Premium.';
  } else if (p.track) {
    el.innerHTML = '<b>' + escapeHtml(p.track) + '</b><br>' + (p.playing ? '▶ играет' : '⏸ на паузе');
  } else {
    el.innerHTML = '—';
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function debounce(fn, delay) {
  var t = null;
  return function () {
    var args = arguments;
    var self = this;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(self, args); }, delay);
  };
}
