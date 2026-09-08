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
var $playlistsLoaded = false;

var $ = function (id) { return document.getElementById(id); };

// StreamDock calls this function when the panel opens
function connectElgatoStreamDeckSocket(port, uuid, event, app, info) {
  try { info = JSON.parse(info); } catch (e) { info = {}; }
  $uuid = uuid;
  $context = info.context || null;
  $action = info.action || null;
  $actionName = $action ? $action.split('.').pop() : null;

  $ws = new WebSocket('ws://127.0.0.1:' + port);
  $ws.onopen = function () {
    $ws.send(JSON.stringify({ event: event, uuid: uuid }));
    // after connecting, request the current state
    setTimeout(function () { sendToPlugin({ type: 'getState' }); }, 200);
    // if the plugin didn't respond, it probably didn't start
    $noResponseTimer = setTimeout(function () {
      if (!$gotState) {
        $('status').textContent = 'Plugin not responding';
        $('status').className = 'status';
        $('authMsg').textContent = 'It looks like the plugin didn\'t start. Fully restart StreamDock and try again.';
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
    console.error('WebSocket error:', e);
  };
}

// Wire button handlers as soon as the page loads (not only from the bootstrap)
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
    // Pass the specific button context ($context) in the payload so the plugin
    // applies settings to the button whose panel is open, not to the first one found.
    payload = payload || {};
    payload.buttonContext = $context || null;
    $ws.send(JSON.stringify({
      event: 'sendToPlugin',
      action: $action,
      // StreamDock (like the reference plugin) addresses plugin messages by plugin uuid
      context: $uuid,
      payload: payload
    }));
  }
}

function ensureWs() {
  if ($ws && $ws.readyState === 1) return true;
  $('authMsg').textContent = 'No connection to the plugin. Make sure it started (the Log button below will show details).';
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
    console.log('Sign in with Spotify clicked');
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
    var done = function () { $('copyLogBtn').textContent = 'Copied'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(done).catch(done);
    } else {
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      done();
    }
  });

  // IMPORTANT: send only the changed field, not all settings at once.
  // Otherwise slider values (if saved settings haven't arrived yet)
  // overwrite other fields with defaults — this used to break time and transparency.
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

  // Time color is applied explicitly with the "Apply" button (not automatically when the picker closes)
  $('timeColorApply').addEventListener('click', function () {
    saveDisplay({ timeColor: $('optTimeColor').value });
  });

  // Playlist button: playlist list and selection
  $('playlistRefresh').addEventListener('click', function () {
    if (!ensureWs()) return;
    sendToPlugin({ type: 'getPlaylists' });
  });
  $('playlistSelect').addEventListener('change', function () {
    var opt = this.selectedOptions && this.selectedOptions[0];
    if (!opt) return;
    saveDisplay({ playlistId: opt.value, playlistName: opt.textContent, playlistUri: opt.dataset.uri || '' });
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
  // The play/pause icon only exists on the play/pause button
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

  // Button cards are shown only for their own action
  var isPlaylist = $actionName === 'playlist';
  $('playlistCard').hidden = !isPlaylist;

  if (isPlaylist) {
    $('playlistSelect').value = s.playlistId || '';
    // fetch the playlist list once when the panel opens
    if (!$playlistsLoaded) {
      $playlistsLoaded = true;
      sendToPlugin({ type: 'getPlaylists' });
    }
  }
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
    $('logText').value = payload.text || '(log is empty)';
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

  if (payload.type === 'playlists') {
    var sel = $('playlistSelect');
    var cur = $settings.playlistId || '';
    var items = payload.items || [];
    sel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '— select a playlist —';
    sel.appendChild(ph);
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.id;
      o.textContent = it.name;
      o.dataset.uri = it.uri || '';
      sel.appendChild(o);
    });
    // the saved playlist may not be in the first 50 — add it separately
    if (cur && !items.some(function (it) { return it.id === cur; })) {
      var o = document.createElement('option');
      o.value = cur;
      o.textContent = $settings.playlistName || cur;
      o.dataset.uri = $settings.playlistUri || '';
      sel.appendChild(o);
    }
    sel.value = cur;
  }

  if (payload.type === 'state' || payload.type === 'auth') {
    // fill the auth fields only on the first state receive,
    // so we don't overwrite what the user is typing
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
    status.textContent = 'Error';
    status.className = 'status';
    msg.textContent = p.error;
    msg.className = 'msg';
    $('loginLink').hidden = true;
    return;
  }

  if (p.status === 'connecting') {
    status.textContent = 'Connecting…';
    status.className = 'status';
    msg.textContent = p.message || 'Opening the browser. Confirm access in Spotify and come back here.';
    msg.className = 'msg connecting';
    return;
  }

  if (p.libraryError) {
    status.textContent = p.loggedIn ? 'Connected' : 'Not connected';
    status.className = p.loggedIn ? 'status ok' : 'status';
    logoutBtn.disabled = !p.loggedIn;
    var sc = (p.scopes && p.scopes.length) ? p.scopes.join(', ') : '—';
    var hasLib = p.scopes && p.scopes.indexOf('user-library-read') !== -1;
    msg.textContent = hasLib
      ? '⚠️ Spotify returns 403 for library requests even though the token has the user-library-read scope (the /me/tracks endpoints may be unavailable for this app). Try "Sign out" and "Sign in with Spotify" again.'
      : '⚠️ Spotify doesn\'t allow library access (likes): the token has no user-library-read scope. Token scopes: ' + sc + '. Press "Sign out", then "Sign in with Spotify" again and confirm access.';
    msg.className = 'msg';
    return;
  }

  if (p.apiError) {
    status.textContent = 'Spotify 403 Error';
    status.className = 'status';
    logoutBtn.disabled = !p.loggedIn;
    if (/owner of the app/i.test(p.apiError)) {
      msg.textContent = '⚠️ Spotify API (403): The developer app owner (the account that created the Client ID at developer.spotify.com) must have an active Premium subscription. If you renewed on a new/different account, create a new Client ID in developer.spotify.com under your new Premium account. If renewed on the same account, Spotify developer billing sync can take a few hours.';
    } else {
      msg.textContent = '⚠️ Spotify API: ' + p.apiError;
    }
    msg.className = 'msg';
    return;
  }

  if (p.loggedIn) {
    var acc = p.account || '';
    var prod = p.product ? (p.product === 'premium' ? 'Premium' : p.product) : '';
    var full = acc;
    if (prod) full += (full ? ' (' + prod + ')' : prod);
    status.textContent = full ? 'Connected: ' + full : 'Connected';
    status.className = 'status ok';
    logoutBtn.disabled = false;
    if (p.product && p.product !== 'premium') {
      msg.textContent = '⚠️ Account subscription type is ' + p.product + '. Playback control via the API requires Spotify Premium.';
      msg.className = 'msg';
    } else {
      msg.textContent = '';
      msg.className = 'msg';
    }
    $('loginLink').hidden = true;
  } else {
    status.textContent = 'Not connected';
    status.className = 'status';
    logoutBtn.disabled = true;
    if (p.clientId && p.hasSecret) {
      msg.textContent = '';
      msg.className = 'msg';
    } else {
      msg.textContent = 'Enter the Client ID and Client Secret of your Spotify app.';
      msg.className = 'msg';
    }
  }
}

function updatePlayer(p) {
  var el = $('playerInfo');
  if (p.empty === 'noauth') {
    el.innerHTML = 'Sign in to your Spotify account to see the current track.';
  } else if (p.empty === 'nodevice') {
    el.innerHTML = 'Nothing is playing right now. Start music on any Spotify device.';
  } else if (p.empty === 'premium') {
    el.innerHTML = 'Playback control requires Spotify Premium.';
  } else if (p.empty === 'notrack') {
    el.innerHTML = 'Playing a non-track item (podcast, episode or ad) — no track info available.';
  } else if (p.track) {
    el.innerHTML = '<b>' + escapeHtml(p.track) + '</b><br>' + (p.playing ? '▶ playing' : '⏸ paused');
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
