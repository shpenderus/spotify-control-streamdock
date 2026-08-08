'use strict';
// Средняя яркость обложки (0..255) — чтобы выбрать цвет текста поверх неё (чёрный/белый).
// Публичного API «цвет обложки» у Spotify нет, поэтому считаем яркость сами из буфера картинки.
// Поддерживаем PNG (через встроенный zlib) и baseline-последовательный JPEG (распаковываем только
// DC-коэффициенты — их среднее даёт среднюю яркость без полного декодирования).
// Любая ошибка → null (текст останется белым, как раньше).

const zlib = require('zlib');

// Нижняя часть обложки (~40%): именно там лежит текст, поэтому ориентируемся на неё.
const BOTTOM_RATIO = 0.6;

function averageLuminance(buffer) {
  if (!buffer || buffer.length < 16) return null;
  try {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return pngLuminance(buffer);
    }
    // JPEG: FF D8
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      return jpegLuminance(buffer);
    }
  } catch (e) { /* не разобрали — вернём null */ }
  return null;
}

/* ============================== PNG ============================== */

function pngLuminance(buf) {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (!width || !height || interlace !== 0 || bitDepth !== 8) return null;

  let channels;
  if (colorType === 0) channels = 1;       // grayscale
  else if (colorType === 2) channels = 3;  // RGB
  else if (colorType === 4) channels = 2;  // gray + alpha
  else if (colorType === 6) channels = 4;  // RGBA
  else return null; // palette (3) и другие — пропускаем

  // Собираем IDAT
  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') idat.push(buf.slice(pos + 8, pos + 8 + len));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!idat.length) return null;

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const bpp = Math.max(1, channels);
  const startY = Math.floor(height * BOTTOM_RATIO);

  let prev = Buffer.alloc(stride);
  let sum = 0;
  let count = 0;
  let off = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[off++];
    const line = raw.slice(off, off + stride);
    off += stride;
    // Разфильтровка (для фильтров, отличных от None)
    if (filter !== 0) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? line[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v = line[x];
        if (filter === 1) v = (v + a) & 0xFF;
        else if (filter === 2) v = (v + b) & 0xFF;
        else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xFF;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 0xFF;
        } else { return null; }
        line[x] = v;
      }
    }
    if (y >= startY) {
      for (let x = 0; x < width; x++) {
        const i = x * channels;
        const r = line[i], g = line[i + (channels >= 3 ? 1 : 0)], b = line[i + (channels >= 3 ? 2 : 0)];
        sum += 0.299 * r + 0.587 * g + 0.114 * b;
        count++;
      }
    }
    prev = line;
  }
  return count ? sum / count : null;
}

/* ============================== JPEG (baseline, DC-only) ============================== */

class BitReader {
  constructor(buf, start) {
    this.buf = buf;
    this.pos = start;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  readBit() {
    if (this.bitCnt === 0) {
      let b = this.buf[this.pos++];
      if (b === 0xFF) {
        // 0xFF 0x00 — вставленный байт (stuffing)
        if (this.buf[this.pos] === 0x00) {
          this.pos++;
        } else {
          // 0xFF D0-D7 — маркер рестарта; вернём 0xFF как сигнал
          return -1;
        }
      }
      this.bitBuf = b;
      this.bitCnt = 8;
    }
    this.bitCnt--;
    return (this.bitBuf >> this.bitCnt) & 1;
  }
  // Выравнивание по байту и пропуск маркера рестарта RSTn (если он здесь)
  alignAndSkipRestart() {
    this.bitCnt = 0;
    while (this.pos < this.buf.length && this.buf[this.pos] === 0xFF) {
      const n = this.buf[this.pos + 1];
      if (n >= 0xD0 && n <= 0xD7) { this.pos += 2; return; }
      this.pos++;
    }
  }
}

function buildHuffTable(counts, symbols) {
  const table = [];
  let code = 0;
  let k = 0;
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < counts[i]; j++) {
      table.push({ len: i + 1, code: code, symbol: symbols[k++] });
      code++;
    }
    code <<= 1;
  }
  return table;
}

function decodeHuff(br, table) {
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    const bit = br.readBit();
    if (bit < 0) throw new Error('bad huffman bit');
    code = (code << 1) | bit;
    for (let i = 0; i < table.length; i++) {
      const t = table[i];
      if (t.len === len && t.code === code) return t.symbol;
    }
  }
  throw new Error('bad huffman code');
}

// Читает "размер" (число бит) и само значение; для AC-коэффициентов значение не нужно,
// но биты нужно прочитать, чтобы битстрим не сбился.
function readBits(br, n) {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const bit = br.readBit();
    if (bit < 0) throw new Error('bad bits');
    v = (v << 1) | bit;
  }
  return v;
}

function jpegLuminance(buf) {
  let pos = 2; // после SOI
  let width = 0, height = 0;
  let quant = {};      // id -> Int16Array(64)
  let huffDC = {};     // id -> table
  let huffAC = {};     // id -> table
  let restartInterval = 0;
  let components = []; // { id, h, v, tq }
  let scanComps = null;

  // Разбор маркеров
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xFF) { pos++; continue; }
    const marker = buf[pos + 1];
    const len = buf.readUInt16BE(pos + 2);
    const body = pos + 4;
    if (marker >= 0xD0 && marker <= 0xD7) { pos += 2; continue; } // RST вне скана — не бывает
    if (marker === 0xDA) { // SOS: начало энтропийных данных
      scanComps = { body, len };
      break;
    }
    if (marker === 0xD9) break; // EOI
    if (marker === 0xDB) { // DQT
      let p = body;
      const end = body + len - 2;
      while (p + 1 < end) {
        const info = buf[p++];
        const id = info & 0x0F;
        const precision = info >> 4;
        const q = new Int16Array(64);
        for (let i = 0; i < 64; i++) {
          q[i] = precision ? buf.readUInt16BE(p + i * 2) : buf[p + i];
        }
        quant[id] = q;
        p += precision ? 128 : 64;
      }
    } else if (marker === 0xC4) { // DHT
      let p = body;
      const end = body + len - 2;
      while (p + 16 < end) {
        const info = buf[p++];
        const cls = info >> 4;
        const id = info & 0x0F;
        const counts = [];
        let total = 0;
        for (let i = 0; i < 16; i++) { counts.push(buf[p + i]); total += buf[p + i]; }
        p += 16;
        const symbols = buf.slice(p, p + total);
        p += total;
        const table = buildHuffTable(counts, symbols);
        if (cls === 0) huffDC[id] = table; else huffAC[id] = table;
      }
    } else if (marker >= 0xC0 && marker <= 0xC3 && marker !== 0xC4) { // SOF0/1/2/3
      if (marker !== 0xC0) return null; // поддерживаем только baseline (SOF0)
      const precision = buf[body];
      if (precision !== 8) return null;
      height = buf.readUInt16BE(body + 1);
      width = buf.readUInt16BE(body + 3);
      const n = buf[body + 5];
      components = [];
      for (let i = 0; i < n; i++) {
        const off = body + 6 + i * 3;
        components.push({ id: buf[off], h: buf[off + 1] >> 4, v: buf[off + 1] & 0x0F, tq: buf[off + 2] });
      }
    } else if (marker === 0xDD) { // DRI
      restartInterval = buf.readUInt16BE(body);
    }
    pos = body + len - 2;
  }

  if (!scanComps || !width || !height || !components.length) return null;

  // Компоненты в порядке скана
  const nComp = buf[scanComps.body];
  const compOrder = [];
  for (let i = 0; i < nComp; i++) {
    const off = scanComps.body + 1 + i * 2;
    const cid = buf[off];
    compOrder.push({ id: cid, tdc: buf[off + 1] >> 4, tac: buf[off + 1] & 0x0F });
  }
  // Y-компонент — тот, у которого максимальная выборка (обычно первый)
  const yComp = components.reduce((a, b) => (a.h * a.v >= b.h * b.v ? a : b), components[0]);
  const maxH = components.reduce((m, c) => Math.max(m, c.h), 1);
  const maxV = components.reduce((m, c) => Math.max(m, c.v), 1);
  const mcuW = 8 * maxH, mcuH = 8 * maxV;
  const mcusX = Math.ceil(width / mcuW);
  const mcusY = Math.ceil(height / mcuH);

  const br = new BitReader(buf, scanComps.body + 1 + nComp * 2 + 3); // +Ss,Se,AhAl

  // Предсказание DC по компоненту
  const dcPred = {};
  let sum = 0;
  let count = 0;
  const startRow = Math.floor(mcusY * BOTTOM_RATIO); // считаем только нижние MCU-ряды

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      const mcuIndex = my * mcusX + mx;
      if (restartInterval > 0 && mcuIndex > 0 && mcuIndex % restartInterval === 0) {
        for (const c of components) dcPred[c.id] = 0;
        br.alignAndSkipRestart();
      }
      for (const sc of compOrder) {
        const comp = components.find((c) => c.id === sc.id);
        const q = quant[comp.tq];
        const blocksPerMcu = comp.h * comp.v;
        for (let b = 0; b < blocksPerMcu; b++) {
          // DC
          const cat = decodeHuff(br, huffDC[sc.tdc]);
          let diff = 0;
          if (cat > 0) {
            const bits = readBits(br, cat);
            diff = bits < (1 << (cat - 1)) ? bits - (1 << cat) + 1 : bits;
          }
          dcPred[comp.id] = (dcPred[comp.id] || 0) + diff;
          const dc = dcPred[comp.id];
          if (comp.id === yComp.id && my >= startRow) {
            // средняя яркость блока = 128 + F(0,0)/8, где F(0,0) = dc * q[0]
            sum += 128 + (dc * q[0]) / 8;
            count++;
          }
          // AC: проматываем, чтобы битстрим не сбился
          for (let k = 1; k < 64; k++) {
            const sym = decodeHuff(br, huffAC[sc.tac]);
            if (sym === 0) break; // EOB
            if (sym === 0xF0) { k += 15; continue; } // 16 нулей
            const run = sym >> 4;
            const size = sym & 0x0F;
            k += run;
            if (size > 0) readBits(br, size);
          }
        }
      }
    }
  }
  return count ? sum / count : null;
}

module.exports = { averageLuminance };
