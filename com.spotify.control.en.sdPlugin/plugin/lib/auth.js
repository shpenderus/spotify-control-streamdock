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
  'user-library-modify',
  'playlist-read-private',
  'user-read-private'
].join(' ');

const DEFAULT_REDIRECT = 'http://127.0.0.1:8888/callback';
const FILE_NAME = '.spotify-control-streamdock.json';

function okHtml(message) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Spotify Control</title></head>' +
    '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;' +
    'background:#121212;font-family:Arial,sans-serif;color:#fff">' +
    '<div style="text-align:center"><div style="font-size:40px">✅</div>' +
    '<p style="font-size:16px">' + message + '</p>' +
    '<p style="color:#1DB954;font-size:13px">You can close this tab</p></div></body></html>';
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
    this.product = null;
    this.grantedScopes = null; // scopes returned by Spotify in the token response (the most reliable source)
    this.filePath = path.join(os.homedir(), FILE_NAME);
    this._serverPromise = null;
    this._serverReject = null;
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
      product: this.product,
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
    if (typeof d.product === 'string') this.product = d.product;
    if (typeof d.scopes === 'string') this.grantedScopes = d.scopes.split(' ');
    else if (Array.isArray(d.scopes)) this.grantedScopes = d.scopes;
  }

  loadFile() {
    try {
      const d = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.fromJSON(d);
    } catch (e) { /* no file — that's fine */ }
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
      account: this.account,
      product: this.product
    };
  }

  hasToken() { return !!this.accessToken; }
  getToken() { return this.accessToken; }

  // The scopes actually granted to the token.
  // The most reliable source is the token endpoint response (Spotify always returns a scope field).
  // If it's missing, fall back to decoding the JWT payload of the token.
  // Returns an array of strings, or null if there is no token / it can't be parsed.
  scopes() {
    if (!this.accessToken) return null;
    if (Array.isArray(this.grantedScopes)) return this.grantedScopes;
    try {
      // JWTs are base64url-encoded (using -_ instead of +/), which Node's base64 decoder doesn't understand
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
    // '********' is the visual placeholder in the panel: it must not overwrite the saved secret
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
    if (!this.accessToken) throw new AuthError('No token');
    if (this.expiresAt && Date.now() > this.expiresAt) {
      await this.refresh();
    }
  }

  async refresh() {
    if (!this.refreshToken) throw new AuthError('No refresh token — sign in again');
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
    this.product = null;
    this.grantedScopes = null;
    this.save();
  }

  async logout() {
    await this.clearTokens();
  }

  // Step 1: validate the credentials and start a local server. Returns { url } — the authorization link
  prepareLogin() {
    if (!this.clientId) throw new Error('Please enter a Client ID first');
    if (!this.clientSecret) throw new Error('Please enter a Client Secret first');

    let ru;
    try { ru = new URL(this.redirectUri); } catch (e) { throw new Error('Invalid Redirect URI'); }
    // The server only listens on 127.0.0.1 — localhost/[::1] is rejected:
    // the browser may resolve to IPv6 and get a connection refused.
    if (!/^127\.0\.0\.1$/.test(ru.hostname)) {
      throw new Error('Redirect URI must point to 127.0.0.1 (local server). localhost is not supported — use 127.0.0.1.');
    }
    const port = parseInt(ru.port || '80', 10);
    const callbackPath = ru.pathname || '/';
    this._state = crypto.randomBytes(8).toString('hex');

    this._stopLoginServer();
    this._serverPromise = new Promise((resolve, reject) => {
      this._serverReject = reject;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        this._serverReject = null;
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
          res.end(okHtml('Error: state mismatch'));
          return;
        }
        const err = u.searchParams.get('error');
        const c = u.searchParams.get('code');
        if (err) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(okHtml('Authorization error: ' + err));
          finish(reject, new Error('Spotify authorization error: ' + err));
          return;
        }
        if (!c) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(okHtml('No authorization code received'));
          finish(reject, new Error('No authorization code received'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(okHtml('Signed in!'));
        finish(resolve, c);
      });
      this._server = server;
      this._serverTimeout = setTimeout(() => {
        finish(reject, new Error('Authorization timed out (2 minutes). Try again.'));
      }, 120000);
      server.on('error', (e) => {
        finish(reject, new Error('Failed to start the local server on port ' + port + ': ' + e.message));
      });
      server.listen(port, '127.0.0.1');
    });

    return { url: this.buildAuthorizeUrl() };
  }

  _stopLoginServer() {
    if (this._server) { try { this._server.close(); } catch (e) { /* ignore */ } this._server = null; }
    if (this._serverTimeout) { clearTimeout(this._serverTimeout); this._serverTimeout = null; }
    // If the previous login was still waiting for a code, reject it — otherwise
    // it would hang forever after clicking "Sign in" again.
    const reject = this._serverReject;
    this._serverReject = null;
    this._serverPromise = null;
    if (reject) reject(new Error('Authorization cancelled — a new one was started'));
  }

  // Step 2: wait for Spotify to return the code to the local server
  async waitForCode() {
    if (!this._serverPromise) throw new Error('Authorization has not started');
    return this._serverPromise;
  }

  // Step 3: exchange the code for tokens
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
      show_dialog: 'true',
      state: this._state || crypto.randomBytes(8).toString('hex')
    });
    return 'https://accounts.spotify.com/authorize?' + params.toString();
  }
}

module.exports = { Auth };
