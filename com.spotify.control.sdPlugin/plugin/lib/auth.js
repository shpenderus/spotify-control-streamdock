'use strict';
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { tokenRequest, AuthError } = require('./spotify');

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
  'user-library-modify'
].join(' ');

const DEFAULT_REDIRECT = 'http://127.0.0.1:8888/callback';
const FILE_NAME = '.spotify-control-streamdock.json';

function okHtml(message) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Spotify Control</title></head>' +
    '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;' +
    'background:#121212;font-family:Arial,sans-serif;color:#fff">' +
    '<div style="text-align:center"><div style="font-size:40px">✅</div>' +
    '<p style="font-size:16px">' + message + '</p>' +
    '<p style="color:#1DB954;font-size:13px">Можно закрыть эту вкладку</p></div></body></html>';
}

class Auth {
  constructor({ onStateChange, openUrl }) {
    this.onStateChange = onStateChange || (() => {});
    this.openUrl = openUrl || (() => {});
    this.clientId = '';
    this.clientSecret = '';
    this.redirectUri = DEFAULT_REDIRECT;
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this.account = null;
    this.grantedScopes = null; // права, которые вернул сам Spotify в ответе токена (самый надёжный источник)
    this.filePath = path.join(os.homedir(), FILE_NAME);
    this.loadFile();
  }

  toJSON() {
    return {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
      account: this.account,
      scopes: this.grantedScopes
    };
  }

  fromJSON(d) {
    if (!d || typeof d !== 'object') return;
    if (typeof d.clientId === 'string') this.clientId = d.clientId;
    if (typeof d.clientSecret === 'string') this.clientSecret = d.clientSecret;
    if (typeof d.redirectUri === 'string' && d.redirectUri) this.redirectUri = d.redirectUri;
    if (typeof d.accessToken === 'string') this.accessToken = d.accessToken;
    if (typeof d.refreshToken === 'string') this.refreshToken = d.refreshToken;
    if (typeof d.expiresAt === 'number') this.expiresAt = d.expiresAt;
    if (typeof d.account === 'string') this.account = d.account;
    if (typeof d.scopes === 'string') this.grantedScopes = d.scopes.split(' ');
    else if (Array.isArray(d.scopes)) this.grantedScopes = d.scopes;
  }

  loadFile() {
    try {
      const d = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.fromJSON(d);
    } catch (e) { /* файла нет — ок */ }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.toJSON(), null, 2));
    } catch (e) { /* ignore */ }
    try { this.onStateChange(); } catch (e) { /* ignore */ }
  }

  publicState() {
    return {
      loggedIn: !!this.accessToken,
      clientId: this.clientId,
      hasSecret: !!this.clientSecret,
      redirectUri: this.redirectUri,
      account: this.account
    };
  }

  hasToken() { return !!this.accessToken; }
  getToken() { return this.accessToken; }

  // Права (scopes), реально выданные токену.
  // Самый надёжный источник — ответ токен-эндпоинта (Spotify всегда возвращает поле scope).
  // Если его нет — пробуем вытащить из JWT-полезной нагрузки токена.
  // Возвращает массив строк или null, если токена нет / не удалось разобрать.
  scopes() {
    if (!this.accessToken) return null;
    if (Array.isArray(this.grantedScopes)) return this.grantedScopes;
    try {
      // JWT закодирован в base64url (вместо +/ используются -_), Node-декодер base64 этого не понимает
      const b64 = this.accessToken.split('.')[1]
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .replace(/=+$/, '');
      const pad = b64.length % 4;
      const raw = pad ? b64 + '='.repeat(4 - pad) : b64;
      const payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      const s = payload && payload.scope;
      return typeof s === 'string' ? s.split(' ') : [];
    } catch (e) {
      return null;
    }
  }

  setCredentials({ clientId, clientSecret, redirectUri }) {
    let changed = false;
    if (typeof clientId === 'string' && clientId !== this.clientId) { this.clientId = clientId.trim(); changed = true; }
    // '********' — визуальный плейсхолдер в панели: не должен затирать сохранённый секрет
    if (typeof clientSecret === 'string' && clientSecret && clientSecret !== '********' && clientSecret !== this.clientSecret) {
      this.clientSecret = clientSecret.trim();
      changed = true;
    }
    if (typeof redirectUri === 'string' && redirectUri.trim() && redirectUri.trim() !== this.redirectUri) {
      this.redirectUri = redirectUri.trim();
      changed = true;
    }
    if (changed) this.save();
  }

  async ensureToken() {
    if (!this.accessToken) throw new AuthError('Нет токена');
    if (this.expiresAt && Date.now() > this.expiresAt) {
      await this.refresh();
    }
  }

  async refresh() {
    if (!this.refreshToken) throw new AuthError('Нет refresh-токена — войдите заново');
    const d = await tokenRequest(this.clientId, this.clientSecret, {
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken
    });
    this.accessToken = d.access_token;
    if (d.refresh_token) this.refreshToken = d.refresh_token;
    if (typeof d.scope === 'string') this.grantedScopes = d.scope.split(' ');
    this.expiresAt = Date.now() + (d.expires_in || 3600) * 1000 - 60000;
    this.save();
  }

  async clearTokens() {
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this.account = null;
    this.grantedScopes = null;
    this.save();
  }

  async logout() {
    await this.clearTokens();
  }

  // Шаг 1: проверить данные и поднять локальный сервер. Возвращает { url } — ссылку авторизации
  prepareLogin() {
    if (!this.clientId) throw new Error('Сначала укажите Client ID');
    if (!this.clientSecret) throw new Error('Сначала укажите Client Secret');

    let ru;
    try { ru = new URL(this.redirectUri); } catch (e) { throw new Error('Некорректный Redirect URI'); }
    if (!/^127\.0\.0\.1$|^localhost$|^\[::1\]$/.test(ru.hostname)) {
      throw new Error('Redirect URI должен указывать на 127.0.0.1 (локальный сервер)');
    }
    const port = parseInt(ru.port || '80', 10);
    const callbackPath = ru.pathname || '/';
    this._state = crypto.randomBytes(8).toString('hex');

    this._stopLoginServer();
    this._serverPromise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (this._serverTimeout) { clearTimeout(this._serverTimeout); this._serverTimeout = null; }
        try { if (this._server) this._server.close(); } catch (e) { /* ignore */ }
        this._server = null;
        fn(value);
      };
      const server = http.createServer((req, res) => {
        let u;
        try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); res.end(); return; }
        if (u.pathname !== callbackPath) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (u.searchParams.get('state') !== this._state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(okHtml('Ошибка: state не совпадает'));
          return;
        }
        const err = u.searchParams.get('error');
        const c = u.searchParams.get('code');
        if (err) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(okHtml('Ошибка авторизации: ' + err));
          finish(reject, new Error('Ошибка авторизации Spotify: ' + err));
          return;
        }
        if (!c) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(okHtml('Код авторизации не получен'));
          finish(reject, new Error('Код авторизации не получен'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(okHtml('Вход выполнен!'));
        finish(resolve, c);
      });
      this._server = server;
      this._serverTimeout = setTimeout(() => {
        finish(reject, new Error('Таймаут авторизации (2 минуты). Попробуйте ещё раз.'));
      }, 120000);
      server.on('error', (e) => {
        finish(reject, new Error('Не удалось запустить локальный сервер на порту ' + port + ': ' + e.message));
      });
      server.listen(port, '127.0.0.1');
    });

    return { url: this.buildAuthorizeUrl() };
  }

  _stopLoginServer() {
    if (this._server) { try { this._server.close(); } catch (e) { /* ignore */ } this._server = null; }
    if (this._serverTimeout) { clearTimeout(this._serverTimeout); this._serverTimeout = null; }
    this._serverPromise = null;
  }

  // Шаг 2: ждать, пока Spotify вернёт код на локальный сервер
  async waitForCode() {
    if (!this._serverPromise) throw new Error('Авторизация не начата');
    return this._serverPromise;
  }

  // Шаг 3: обменять код на токены
  async exchangeCode(code) {
    const d = await tokenRequest(this.clientId, this.clientSecret, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri
    });
    this.accessToken = d.access_token;
    if (d.refresh_token) this.refreshToken = d.refresh_token;
    if (typeof d.scope === 'string') this.grantedScopes = d.scope.split(' ');
    this.expiresAt = Date.now() + (d.expires_in || 3600) * 1000 - 60000;
    this.save();
    return d;
  }

  buildAuthorizeUrl() {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      state: this._state || crypto.randomBytes(8).toString('hex')
    });
    return 'https://accounts.spotify.com/authorize?' + params.toString();
  }
}

module.exports = { Auth, DEFAULT_REDIRECT };
