'use strict';
// Renders all button states as SVG data-URLs (StreamDock accepts data:image/svg+xml;base64 in setImage).
const { escapeXml, fmtTime, clamp, svgDataUrl } = require('./util');

const GREEN = '#1DB954';
const DARK = '#121212';
const DIM = '#535353';
const LIGHT = '#B3B3B3';
const WHITE = '#FFFFFF';
const LOAD = '#8a8a8a'; // like status not known yet (loading)
const SIZE = 72;
const FONT_MIN = 6;
const FONT_MAX = 30;

// Auto-contrast: if the bottom of the cover is light — dark text, dark — white.
// Threshold ~150 (of 255). luma == null (not computed) → white text, as before.
const LUMA_THRESHOLD = 150;
const INK = '#101010';   // almost black
const INK_SOFT = '#3d3d3d'; // dark gray for the artist on light covers

// IMPORTANT: StreamDock only accepts ready data-URLs in setImage;
// raw SVG XML strings are ignored (the button keeps its previous image).
function frame(inner) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${inner}</svg>`;
  return svgDataUrl(svg);
}

function bgRect() {
  return `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="14" fill="${DARK}"/>`;
}

// Press effect: the button "sinks in" — content temporarily shrinks toward the center.
// The shape changes, not the color (a fill overlay used to make dark buttons a "black screen").
function pressScale(inner) {
  return `<g transform="translate(36,36) scale(0.88) translate(-36,-36)">${inner}</g>`;
}

function coverImage(cover) {
  return `<image x="0" y="0" width="${SIZE}" height="${SIZE}" preserveAspectRatio="xMidYMid slice" ` +
    `xlink:href="${cover}" href="${cover}"/>`;
}

// Thin green progress bar at the bottom of the button (like the Spotify player). Optional
// (settings.progressBar). A gray track with a green filled part on top.
function progressBar(pct, durationMs) {
  if (!durationMs || !isFinite(pct) || pct < 0) return '';
  const p = clamp(pct / durationMs, 0, 1);
  const x = 8, y = 68, w = 56, h = 3;
  const fillW = w * p;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5" fill="rgba(83,83,83,0.75)"/>` +
    (fillW >= 0.5 ? `<rect x="${x}" y="${y}" width="${fillW.toFixed(1)}" height="${h}" rx="1.5" fill="${GREEN}"/>` : '');
}


function playGlyph(cx, cy, fill, s) {
  s = s || 1;
  const h = 18 * s, w = 15 * s;
  const left = cx - w * 0.5, top = cy - h * 0.5;
  return `<path d="M${left.toFixed(1)} ${top.toFixed(1)} L${(cx + w * 0.5).toFixed(1)} ${cy.toFixed(1)} L${left.toFixed(1)} ${(top + h).toFixed(1)} Z" ` +
    `fill="${fill}" stroke="${fill}" stroke-width="${(3.5 * s).toFixed(1)}" stroke-linejoin="round"/>`;
}

function pauseGlyph(cx, cy, fill, s) {
  s = s || 1;
  const h = 18 * s, w = 5.5 * s, gap = 3.5 * s;
  const top = cy - h / 2, left = cx - w - gap / 2;
  return `<rect x="${(left).toFixed(1)}" y="${(top).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(2.75 * s).toFixed(1)}" fill="${fill}"/>` +
    `<rect x="${(left + w + gap).toFixed(1)}" y="${(top).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(2.75 * s).toFixed(1)}" fill="${fill}"/>`;
}

// Dark "chip" with a play/pause glyph.
// The glyph is green like the other buttons (it used to be white).
function chip(cx, cy, playing, size) {
  size = size || 30;
  const r = size / 2;
  const s = size / 30;
  return `<rect x="${(cx - r).toFixed(1)}" y="${(cy - r).toFixed(1)}" width="${size}" height="${size}" rx="${r.toFixed(1)}" fill="rgba(0,0,0,0.55)"/>` +
    (playing ? pauseGlyph(cx, cy, GREEN, s) : playGlyph(cx, cy, GREEN, s));
}

function textAttrs(size, fill, weight) {
  return `font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight || 'normal'}" fill="${fill}"`;
}

function textLine(text, x, y, size, fill, weight) {
  return `<text x="${x}" y="${y.toFixed(1)}" ${textAttrs(size, fill, weight)} text-anchor="middle">${escapeXml(text)}</text>`;
}

// Marquee: when text doesn't fit it scrolls smoothly to the left (two copies for a seamless loop).
// Fixed speed: 14 px/s (2 fps at 7px) — a proven pace for StreamDock.
function marqueeLine(line, y, size, phase) {
  const W = line.text.length * size * 0.52;
  const gap = 24;
  const L = W + gap;
  const speed = 14;
  const p = ((phase || 0) / 1000 * speed) % L;
  const x1 = SIZE - p;
  const x2 = x1 + L;
  const attrs = textAttrs(size, line.fill, line.weight);
  return `<text x="${x1.toFixed(1)}" y="${y.toFixed(1)}" ${attrs}>${escapeXml(line.text)}</text>` +
    `<text x="${x2.toFixed(1)}" y="${y.toFixed(1)}" ${attrs}>${escapeXml(line.text)}</text>`;
}

// approximate Arial glyph width: ~0.52 * fontSize; available field ~62px
function fitChars(size) {
  return Math.max(4, Math.floor(62 / (size * 0.52)));
}

// Builds text lines into a block. Returns { html, height }
function textBlock(lines, size, phase) {
  const lineH = size * 1.25;
  const pad = 7;
  const html = [];
  let y = pad + size;
  for (const line of lines) {
    if (line.overflow) html.push(marqueeLine(line, y, line.size || size, phase));
    else html.push(textLine(line.text, 36, y, line.size || size, line.fill, line.weight));
    y += lineH;
  }
  return { html: html.join(''), height: lines.length * lineH + pad * 2 };
}

// Auto-contrast (autoContrast): all text becomes black/white based on the cover's bottom
// luminance so it doesn't blend in. Disabled — classic colors (white/gray, time in timeColor).
function buildLines(track, settings, progressMs, size, luma) {
  const lines = [];
  if (!track) return lines;
  const maxChars = fitChars(size);
  const auto = settings.autoContrast !== false && luma != null;
  const dark = auto && luma > LUMA_THRESHOLD; // light cover → dark text
  const titleFill = auto ? (dark ? INK : WHITE) : WHITE;
  const artistFill = auto ? (dark ? INK_SOFT : LIGHT) : LIGHT;
  if (settings.title && track.name) lines.push({ text: track.name, overflow: track.name.length > maxChars, fill: titleFill, weight: 'bold' });
  if (settings.artist && track.artists) lines.push({ text: track.artists, overflow: track.artists.length > maxChars, fill: artistFill, weight: 'normal' });
  // Time color is configurable (timeColor), default — Spotify green.
  // With auto-contrast the time is also black/white (custom color is ignored).
  if (settings.time) {
    const timeFill = auto ? (dark ? INK : WHITE) : (settings.timeColor || GREEN);
    lines.push({ text: fmtTime(progressMs) + ' / ' + fmtTime(track.durationMs), overflow: false, fill: timeFill, weight: 'bold' });
  }
  return lines;
}

// Whether a marquee is needed on this button (text doesn't fit)
function needsMarquee(track, settings) {
  if (!track) return false;
  const size = clamp(Number(settings && settings.fontSize) || 13, FONT_MIN, FONT_MAX);
  const maxChars = fitChars(size);
  if (settings.title && track.name && track.name.length > maxChars) return true;
  if (settings.artist && track.artists && track.artists.length > maxChars) return true;
  return false;
}

function repeatArrows(fill) {
  return `<path d="M16 28 H44 A8 8 0 0 1 52 36" fill="none" stroke="${fill}" stroke-width="5" stroke-linecap="round"/>` +
    `<path d="M46 31 L54 36 L46 41 Z" fill="${fill}"/>` +
    `<path d="M56 44 H28 A8 8 0 0 0 20 36" fill="none" stroke="${fill}" stroke-width="5" stroke-linecap="round"/>` +
    `<path d="M26 31 L18 36 L26 41 Z" fill="${fill}"/>`;
}

function equalizerGlyph(fill) {
  return `<rect x="20" y="38" width="6" height="12" rx="3" fill="${fill}"/>` +
    `<rect x="30" y="28" width="6" height="22" rx="3" fill="${fill}"/>` +
    `<rect x="40" y="34" width="6" height="16" rx="3" fill="${fill}"/>` +
    `<rect x="50" y="22" width="6" height="28" rx="3" fill="${fill}"/>`;
}

function shuffleGlyph(fill) {
  return `<g transform="translate(12,12) scale(2)"><path fill="${fill}" ` +
    `d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></g>`;
}

/* ---------- Glyphs for the new buttons (playlist / device / sleep timer) ---------- */

// Playlist: list rows + play triangle
function playlistGlyph(fill) {
  return `<rect x="18" y="17" width="22" height="4" rx="2" fill="${fill}"/>` +
    `<rect x="18" y="25" width="22" height="4" rx="2" fill="${fill}"/>` +
    `<rect x="18" y="33" width="14" height="4" rx="2" fill="${fill}"/>` +
    `<path d="M45 21 L53 26 L45 31 Z" fill="${fill}"/>`;
}

// Label button: icon on top, text below (playlist).
// Long text scrolls as a marquee, like on the other buttons.
function renderLabelButton(opts) {
  const size = 13;
  const text = String(opts.text == null ? '' : opts.text);
  const line = { text, overflow: text.length > fitChars(size), fill: WHITE, weight: 'bold' };
  // The marquee phase (2 fps, like the other buttons) enters the image ONLY when
  // the text overflows: otherwise the SVG is stable and the setIcon dedup does
  // not send images every 100 ms (an image flood used to freeze the device).
  const phase = line.overflow ? (Math.floor((opts.phase || 0) / 500) * 500) : 0;
  const block = textBlock([line], size, phase);
  let inner = bgRect() + playlistGlyph(GREEN);
  inner += `<g transform="translate(0, ${(SIZE - block.height - 4).toFixed(1)})">${block.html}</g>`;
  if (opts.pressed) inner = pressScale(inner);
  return frame(inner);
}

/* ---------- Static icons (mirror imgs/*.svg) ---------- */

function iconSvg(name, pressed) {
  let glyph = '';
  switch (name) {
    case 'next':
      glyph = `<rect x="50" y="21" width="6" height="30" rx="3" fill="${GREEN}"/>` +
        `<path d="M22 22 L46 36 L22 50 Z" fill="${GREEN}" stroke="${GREEN}" stroke-width="4" stroke-linejoin="round"/>`;
      break;
    case 'previous':
      glyph = `<rect x="16" y="21" width="6" height="30" rx="3" fill="${GREEN}"/>` +
        `<path d="M50 22 L26 36 L50 50 Z" fill="${GREEN}" stroke="${GREEN}" stroke-width="4" stroke-linejoin="round"/>`;
      break;
    case 'like':
      glyph = heartPath('none', DIM);
      break;
    case 'like-load':
      glyph = heartPath('none', LOAD);
      break;
    case 'liked':
      glyph = heartPath(GREEN, GREEN);
      break;
    case 'repeat':
      glyph = repeatArrows(GREEN);
      break;
    case 'repeat1':
      glyph = repeatArrows(GREEN) + `<text x="36" y="40" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="18" fill="${GREEN}" text-anchor="middle">1</text>`;
      break;
    case 'repeat-off':
      glyph = repeatArrows(DIM);
      break;
    case 'shuffle':
      glyph = shuffleGlyph(GREEN);
      break;
    case 'shuffle-off':
      glyph = shuffleGlyph(DIM);
      break;
    case 'seek':
      glyph = `<rect x="12" y="33" width="48" height="6" rx="3" fill="${DIM}"/>` +
        `<rect x="12" y="33" width="24" height="6" rx="3" fill="${GREEN}"/>` +
        `<circle cx="39" cy="36" r="6" fill="${GREEN}"/>`;
      break;
    case 'volume':
      glyph = `<path d="M22 30 H30 L38 24 V48 L30 42 H22 Z" fill="${GREEN}"/>` +
        `<path d="M42 28 A11 11 0 0 1 42 44" fill="none" stroke="${GREEN}" stroke-width="4" stroke-linecap="round"/>` +
        `<path d="M48 22 A18 18 0 0 1 48 50" fill="none" stroke="${GREEN}" stroke-width="4" stroke-linecap="round"/>`;
      break;
    case 'playlist':
      glyph = playlistGlyph(GREEN);
      break;
    default:
      glyph = '';
  }
  const content = bgRect() + glyph;
  return frame(pressed ? pressScale(content) : content);
}

function heartPath(fill, stroke) {
  const d = 'M36 52.5 C21 42.5 15.5 32 15.5 25.5 C15.5 19 20.5 14.5 26.5 14.5 C30.5 14.5 34 16.5 36 19.5 C38 16.5 41.5 14.5 45.5 14.5 C51.5 14.5 56.5 19 56.5 25.5 C56.5 32 51 42.5 36 52.5 Z';
  if (fill && fill !== 'none') return `<path d="${d}" fill="${fill}"/>`;
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="4" stroke-linejoin="round"/>`;
}

/* ---------- Play/pause button with cover ---------- */

function renderPlayPause(opts) {
  const { cover, playing, track, settings, empty } = opts;
  const size = clamp(Number(settings.fontSize) || 13, FONT_MIN, FONT_MAX);
  const lines = buildLines(track, settings, opts.progressMs, size, opts.luma);
  const hasCover = !!(cover && settings.cover !== false && track && empty === 'none');

  // Play/pause icon on the button — optional (showIcon, off by default)
  const showIcon = settings.showIcon === true;

  let inner = '';
  if (lines.length) {
    const block = textBlock(lines, size, opts.phase);
    if (hasCover) {
      inner += coverImage(cover);
      // text right on the cover, no dark panel
      inner += `<g transform="translate(0, ${(SIZE - block.height).toFixed(1)})">${block.html}</g>`;
      if (showIcon) inner += chip(36, 20, playing, 24);
    } else {
      inner += bgRect();
      inner += `<g transform="translate(0, ${((SIZE - block.height) / 2 + 6).toFixed(1)})">${block.html}</g>`;
      if (showIcon) inner += chip(36, 18, playing, 24);
    }
  } else {
    if (hasCover) {
      inner += coverImage(cover);
    } else {
      inner += bgRect();
    }
    if (showIcon || !hasCover) inner += chip(36, 36, playing, 30);
  }
  // Thin green progress bar at the bottom (the "Progress bar" option)
  if (settings.progressBar !== false && track && empty === 'none') {
    inner += progressBar(opts.progressMs, track.durationMs);
  }
  if (opts.pressed) inner = pressScale(inner);
  return frame(inner);
}

/* ---------- Now Playing button ---------- */

function renderInfo(opts) {
  const { cover, track, settings, progressMs, empty } = opts;
  const size = clamp(Number(settings.fontSize) || 13, FONT_MIN, FONT_MAX);
  const lines = (track && empty === 'none') ? buildLines(track, settings, progressMs, size, opts.luma) : [];

  if (!lines.length) {
    let inner = bgRect() + equalizerGlyph(empty === 'noauth' ? DIM : GREEN);
    if (opts.pressed) inner = pressScale(inner);
    return frame(inner);
  }

  const block = textBlock(lines, size, opts.phase);

  let inner;
  if (cover && settings.cover !== false) {
    inner = coverImage(cover);
    // text right on the cover, no dark panel
    inner += `<g transform="translate(0, ${(SIZE - block.height).toFixed(1)})">${block.html}</g>`;
  } else {
    // without a cover — text centered on a dark background
    inner = bgRect();
    inner += `<g transform="translate(0, ${((SIZE - block.height) / 2).toFixed(1)})">${block.html}</g>`;
  }
  // Thin green progress bar at the bottom (the "Progress bar" option)
  if (settings.progressBar !== false && track && empty === 'none') {
    inner += progressBar(progressMs, track.durationMs);
  }
  if (opts.pressed) inner = pressScale(inner);
  return frame(inner);
}

module.exports = {
  iconSvg,
  renderPlayPause,
  renderInfo,
  renderLabelButton,
  needsMarquee
};
