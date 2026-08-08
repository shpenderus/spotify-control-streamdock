'use strict';
// Минимальный WebSocket-клиент (RFC 6455) на чистом Node (net + crypto).
// Используется только если в рантайме нет глобального WebSocket (Node >= 20.10).
// Реализует ровно то, что нужно плагину: текстовые сообщения, ping/pong, close.

const net = require('net');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocketClient {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    const m = /^ws:\/\/([^:/?#]+)(?::(\d+))?([^?#]*)/.exec(url);
    if (!m) {
      this._fail(new Error('Некорректный ws URL: ' + url));
      return;
    }
    this._host = m[1];
    this._port = m[2] ? parseInt(m[2], 10) : 80;
    this._path = m[3] || '/';
    this._key = crypto.randomBytes(16).toString('base64');
    this._buffer = Buffer.alloc(0);
    this._opened = false;
    this._socket = null;

    try {
      this._socket = net.connect(this._port, this._host, () => this._handshake());
      this._socket.on('data', (chunk) => this._onData(chunk));
      this._socket.on('error', (err) => this._fail(err));
      this._socket.on('close', () => {
        if (this.readyState !== 3) {
          this.readyState = 3; // CLOSED
          if (this.onclose) this.onclose({ code: 1006, reason: '' });
        }
      });
    } catch (err) {
      this._fail(err);
    }
  }

  _handshake() {
    const req = [
      'GET ' + this._path + ' HTTP/1.1',
      'Host: ' + this._host + ':' + this._port,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + this._key,
      'Sec-WebSocket-Version: 13',
      '',
      ''
    ].join('\r\n');
    this._socket.write(req);
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);

    if (!this._opened) {
      const idx = this._buffer.indexOf('\r\n\r\n');
      if (idx === -1) return; // ждём заголовки
      const header = this._buffer.slice(0, idx).toString('latin1');
      this._buffer = this._buffer.slice(idx + 4);
      const lines = header.split('\r\n');
      if (!lines[0] || lines[0].indexOf(' 101 ') === -1 && !/^HTTP\/1\.[01] 101/.test(lines[0])) {
        this._fail(new Error('Handshake failed: ' + lines[0]));
        return;
      }
      // Проверяем Sec-WebSocket-Accept
      const acceptLine = lines.find((l) => /^sec-websocket-accept:/i.test(l));
      const expected = crypto.createHash('sha1').update(this._key + GUID).digest('base64');
      if (acceptLine && acceptLine.split(':')[1].trim() !== expected) {
        this._fail(new Error('Invalid Sec-WebSocket-Accept'));
        return;
      }
      this._opened = true;
      this.readyState = 1; // OPEN
      if (this.onopen) this.onopen({});
    }

    // Разбор кадров (серверные кадры НЕ маскированы)
    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this._buffer.length < 4) break;
        len = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this._buffer.length < 10) break;
        const big = this._buffer.readBigUInt64BE(2);
        if (big > BigInt(64 * 1024 * 1024)) break;
        len = Number(big);
        offset = 10;
      }
      if (this._buffer.length < offset + len) break;
      const payload = this._buffer.slice(offset, offset + len);
      this._buffer = this._buffer.slice(offset + len);

      if (opcode === 0x1) {
        // text frame
        if (this.onmessage) this.onmessage({ data: payload.toString('utf8') });
      } else if (opcode === 0x9) {
        // ping -> pong
        this._sendFrame(0xA, payload);
      } else if (opcode === 0x8) {
        // close
        this._sendFrame(0x8, Buffer.alloc(0));
        this.readyState = 3;
        if (this.onclose) this.onclose({ code: 1000, reason: '' });
        this._socket.end();
        break;
      }
      // opcode 0x0 (continuation) и 0x2 (binary) игнорируем — сервер шлёт только text
    }
  }

  _sendFrame(opcode, payload) {
    if (!this._socket || this.readyState !== 1) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');
    const mask = crypto.randomBytes(4);
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this._socket.write(Buffer.concat([header, mask, masked]));
  }

  _fail(err) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onerror) this.onerror(err);
    if (this.onclose) this.onclose({ code: 1006, reason: err.message });
    try { if (this._socket) this._socket.destroy(); } catch (e) { /* ignore */ }
  }

  send(data) {
    this._sendFrame(0x1, String(data));
  }

  close() {
    try { this._sendFrame(0x8, Buffer.alloc(0)); } catch (e) { /* ignore */ }
    try { if (this._socket) this._socket.end(); } catch (e) { /* ignore */ }
  }
}

module.exports = WebSocketClient;
