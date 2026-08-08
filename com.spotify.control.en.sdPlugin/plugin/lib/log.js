'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_FILE = path.join(os.tmpdir(), 'spotify-control-plugin.log');

function toStr(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.map(toStr).join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore */ }
  try { console.log(line); } catch (e) { /* ignore */ }
}

module.exports = { log, LOG_FILE };
