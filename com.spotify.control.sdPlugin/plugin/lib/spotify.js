'use strict';
const https = require('https');

class AuthError extends Error {}
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Универсальный https-запрос
function request(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: opts.host,
      port: opts.port || 443,
      path: opts.path,
      method: opts.method || 'GET',
      headers: opts.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 20000, () => req.destroy(new Error('Таймаут запроса')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Запрос к токен-эндпоинту (accounts.spotify.com/api/token)
async function tokenRequest(clientId, clientSecret, form) {
  const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const body = new URLSearchParams(form).toString();
  const res = await request({
    host: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + basic,
      'Content-Length': Buffer.byteLength(body)
    },
    body
  });
  let data = {};
  try { data = JSON.parse(res.body.toString('utf8')); } catch (e) { /* ignore */ }
  if (res.status !== 200) {
    const msg = data.error_description || data.error || ('HTTP ' + res.status);
    if (/invalid_grant|unauthorized_client/i.test(msg)) throw new AuthError(msg);
    throw new ApiError(res.status, msg);
  }
  return data;
}

class SpotifyApi {
  // auth: { getToken(), ensureToken(), refresh() }
  constructor(auth) {
    this.auth = auth;
  }

  async api(method, path, opts, attempt) {
    attempt = attempt || 0;
    opts = opts || {};
    await this.auth.ensureToken();
    const token = this.auth.getToken();
    if (!token) throw new AuthError('Нет токена — войдите в аккаунт');

    let urlPath = path;
    if (opts.qs) {
      const sp = new URLSearchParams();
      for (const k of Object.keys(opts.qs)) {
        const v = opts.qs[k];
        if (v !== undefined && v !== null) sp.set(k, String(v));
      }
      const q = sp.toString();
      if (q) urlPath += (urlPath.indexOf('?') === -1 ? '?' : '&') + q;
    }

    const headers = { 'Authorization': 'Bearer ' + token };
    let body = null;
    if (opts.json !== undefined) {
      body = Buffer.from(JSON.stringify(opts.json));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    } else if (method === 'PUT' || method === 'DELETE' || method === 'POST') {
      headers['Content-Length'] = 0;
    }

    const res = await request({ host: 'api.spotify.com', path: urlPath, method, headers, body });

    // 401 → пробуем обновить токен и повторить один раз
    if (res.status === 401 && attempt === 0) {
      await this.auth.refresh();
      return this.api(method, path, opts, 1);
    }
    // 429 → подождать и повторить (не более двух повторов)
    if (res.status === 429 && attempt < 2) {
      const waitMs = Math.min(parseInt(res.headers['retry-after'] || '3', 10) * 1000, 15000);
      await sleep(waitMs);
      return this.api(method, path, opts, attempt + 1);
    }

    let data = null;
    let text = null;
    if (res.body && res.body.length) {
      text = res.body.toString('utf8');
      try { data = JSON.parse(text); } catch (e) { /* ignore */ }
    }
    const message = (data && ((data.error && (data.error.message || data.error)) || data.message)) || text;
    return { status: res.status, data, text, message };
  }

  getPlayer() { return this.api('GET', '/v1/me/player'); }
  me() { return this.api('GET', '/v1/me'); }

  setPlay(playing) {
    return this.api('PUT', playing ? '/v1/me/player/play' : '/v1/me/player/pause');
  }
  next() { return this.api('POST', '/v1/me/player/next'); }
  previous() { return this.api('POST', '/v1/me/player/previous'); }
  setRepeat(state) { return this.api('PUT', '/v1/me/player/repeat', { qs: { state } }); }
  setShuffle(enabled) { return this.api('PUT', '/v1/me/player/shuffle', { qs: { state: enabled } }); }
  seek(positionMs) {
    return this.api('PUT', '/v1/me/player/seek', { qs: { position_ms: Math.max(0, Math.round(positionMs || 0)) } });
  }
  // 0..100; если deviceId не передан — громкость активного устройства
  volume(percent, deviceId) {
    const qs = { volume_percent: Math.max(0, Math.min(100, Math.round(percent))) };
    if (deviceId) qs.device_id = deviceId;
    return this.api('PUT', '/v1/me/player/volume', { qs });
  }

  devices() {
    return this.api('GET', '/v1/me/player/devices');
  }
  // Активировать устройство (перевести воспроизведение на него)
  transferPlayback(deviceId, play) {
    return this.api('PUT', '/v1/me/player', { json: { device_ids: [deviceId], play: !!play } });
  }
  // Начать воспроизведение контекста (плейлист/альбом/«Любимые треки»)
  playContext(contextUri, deviceId) {
    const json = { context_uri: contextUri };
    if (deviceId) json.device_id = deviceId;
    return this.api('PUT', '/v1/me/player/play', { json });
  }
  playlists() {
    return this.api('GET', '/v1/me/playlists', { qs: { limit: 50 } });
  }

  isLiked(trackId) {
    return this.api('GET', '/v1/me/tracks/contains', { qs: { ids: trackId } });
  }
  setLiked(trackId, liked) {
    return this.api(liked ? 'PUT' : 'DELETE', '/v1/me/tracks', { qs: { ids: trackId } });
  }
  // Fallback на старые эндпоинты /v1/me/library (как в официальном плагине MiraBox):
  // если современный /v1/me/tracks отвечает 403, пробуем старый вариант с uris.
  isLikedLegacy(trackId) {
    return this.api('GET', '/v1/me/library/contains', { qs: { uris: 'spotify:track:' + trackId } });
  }
  setLikedLegacy(trackId, liked) {
    return this.api(liked ? 'PUT' : 'DELETE', '/v1/me/library', { qs: { uris: 'spotify:track:' + trackId } });
  }
}

module.exports = { SpotifyApi, AuthError, ApiError, tokenRequest };
