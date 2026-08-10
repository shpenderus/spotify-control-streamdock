'use strict';
const http = require('http');
const https = require('https');

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ms -> "m:ss" (or "h:mm:ss" for long tracks)
function fmtTime(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s < 10 ? '0' + s : '' + s;
  return h > 0 ? h + ':' + (m < 10 ? '0' + m : '' + m) + ':' + ss : m + ':' + ss;
}

// Truncate a string with an ellipsis to fit the button
function truncate(s, maxChars) {
  s = String(s == null ? '' : s);
  if (s.length <= maxChars) return s;
  if (maxChars <= 1) return s.slice(0, maxChars);
  return s.slice(0, maxChars - 1) + '…';
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function svgDataUrl(svg) {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

// GET with redirects, returns { buffer, contentType }
function getBuffer(url, redirects, viaV4) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Spotify-Control-StreamDock/1.0' }
    };
    // On some networks IPv6 is broken: DNS returns an IPv6 address first, Node
    // tries it and the TLS handshake is reset (ECONNRESET) — images (covers)
    // never load. Retry once over IPv4, which works.
    if (viaV4) opts.family = 4;
    const req = client.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4) {
        res.resume();
        resolve(getBuffer(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: res.headers['content-type'] || 'image/jpeg'
      }));
      res.on('error', reject);
    });
    req.on('error', (e) => {
      if (!viaV4 && /^(ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED)$/.test(e.code || '')) {
        resolve(getBuffer(url, redirects, true));
        return;
      }
      reject(e);
    });
    req.setTimeout(15000, () => req.destroy(new Error('Request timeout')));
  });
}

function dataUrlFromBuffer(buffer, contentType) {
  return 'data:' + (contentType || 'image/jpeg') + ';base64,' + buffer.toString('base64');
}

module.exports = { escapeXml, fmtTime, truncate, clamp, svgDataUrl, getBuffer, dataUrlFromBuffer };
