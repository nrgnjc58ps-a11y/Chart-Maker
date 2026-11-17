// Engraves songs with abcjs, lays the lines out on pages, and exports PDFs.
import { arrangeSong } from './layout.js';
import { songToAbc, transposeKeyName, prettyChord, meterInfo, TEXT_MARK, SIMILE_MARK, FILL_MARK, TIMES_MARK, FONT_STYLES } from './abcgen.js';

const SVGNS = 'http://www.w3.org/2000/svg';
export const PAPER = {
  letter: { w: 816, h: 1056, label: 'US Letter', pdf: 'letter' }, // CSS px at 96/in
  a4: { w: 794, h: 1123, label: 'A4', pdf: 'a4' },
};
const MARGIN = 40;
const CONT_HEADER = 34;
const ZOOM = 1.22; // engrave narrower, then scale up: bigger staff + lettering on the page

export const FONT_FILES = [
  { family: 'Chart Hand', url: 'fonts/patrick-hand-sc.woff2', weight: 'normal' },
  { family: 'Chart Title', url: 'fonts/stardos-stencil-700.woff2', weight: 'bold' },
  { family: 'Chart Chord', url: 'fonts/kalam-700.woff2', weight: 'normal' },
];

export async function loadFonts() {
  await Promise.all([
    document.fonts.load('16px "Chart Hand"'),
    document.fonts.load('bold 30px "Chart Title"'),
    document.fonts.load('18px "Chart Chord"'),
  ]).catch(() => {});
}

let workArea;
function getWorkArea() {
  if (!workArea || !workArea.isConnected) {
    workArea = document.createElement('div');
    workArea.setAttribute('aria-hidden', 'true');
    workArea.style.cssText = 'position:absolute;left:-20000px;top:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(workArea);
  }
  return workArea;
}

function el(name, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function newPage(paper) {
  // Charts are always black ink on white paper, whatever the phone's light/dark theme
  // (abcjs draws in "currentColor", so the colour must be set here).
  const svg = el('svg', { xmlns: SVGNS, viewBox: `0 0 ${paper.w} ${paper.h}`, width: paper.w, height: paper.h, class: 'page-svg', color: '#000', style: 'color:#000' });
  svg.appendChild(el('rect', { x: 0, y: 0, width: paper.w, height: paper.h, fill: '#fff' }));
  return svg;
}

function pageHeader(svg, paper, pageNo, title, style) {
  const font = style === 'clean' ? 'Helvetica, Arial, sans-serif' : '"Chart Hand", sans-serif';
  svg.appendChild(el('text', { x: MARGIN, y: MARGIN + 6, 'font-family': font, 'font-size': 20, fill: '#000' }, String(pageNo)));
  svg.appendChild(el('text', { x: paper.w - MARGIN, y: MARGIN + 6, 'font-family': font, 'font-size': 14, fill: '#444', 'text-anchor': 'end' }, title));
}

// Chord lettering size for every chart (set from the app's settings).
let chordSize = 'medium';
export const setChordSize = (size) => { chordSize = size || 'medium'; };

const CHORD_GAP = 6; // px between chord baseline and the top staff line (before page scaling)

// A measured box, or null when the browser can't give a sensible one
// (browsers differ here, so every measurement is checked before use).
function box(node) {
  try {
    const b = node.getBBox();
    if (!b || !isFinite(b.x) || !isFinite(b.y) || (!b.width && !b.height)) return null;
    return b;
  } catch {
    return null;
  }
}

// "FORM: Intro – Verse – Chorus …" wrapped to the page width, drawn under the title.
function formLine(text, width, tf) {
  const size = 20, lead = size * 1.4;
  const font = `${size}px ${tf.family}`;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `bold ${font}`;
  const labelW = ctx.measureText('FORM  ').width;
  ctx.font = font;
  const items = text.split('  –  ');
  const rows = [];
  let row = '', avail = width - labelW - 4;
  items.forEach((it, i) => {
    const piece = i < items.length - 1 ? `${it}  –  ` : it;
    if (row && ctx.measureText(row + piece).width > avail) { rows.push(row.trimEnd()); row = ''; }
    row += piece;
  });
  if (row) rows.push(row);
  const h = Math.ceil(rows.length * lead + 14);
  const svg = el('svg', { xmlns: 'http://www.w3.org/2000/svg', width, height: h, viewBox: `0 0 ${width} ${h}` });
  svg.appendChild(el('text', { x: 0, y: size + 2, 'font-family': tf.family, 'font-size': size, 'font-weight': 'bold', fill: '#000' }, 'FORM'));
  rows.forEach((r, i) => svg.appendChild(el('text', { x: labelW, y: size + 2 + i * lead, 'font-family': tf.family, 'font-size': size, fill: '#000' }, r)));
  return { svg, w: width, fullW: width, h, viewBox: `0 0 ${width} ${h}` };
}

// Per-line clean-up after abcjs has drawn it:
//  - pull chord symbols (and text stacked above them) down close to the staff
//  - draw one-bar repeat signs where the generator left invisible anchors
function tidyLine(svg, song) {
  const topLine = svg.querySelector('.abcjs-top-line');
  const topBox = topLine && box(topLine);
  if (!topBox) return;
  const staffTop = topBox.y;
  const lineYs = [...svg.querySelectorAll('.abcjs-staff path')].map((p) => box(p)?.y).filter((y) => y > staffTop + 1).sort((a, b) => a - b);
  const sp = lineYs.length && lineYs[0] - staffTop > 3 && lineYs[0] - staffTop < 20 ? lineYs[0] - staffTop : 8;

  // One-bar repeat signs.
  const anchors = [...svg.querySelectorAll('text')].filter((t) => t.textContent.includes(SIMILE_MARK));
  const beats = meterInfo(song.time).beats;
  for (let i = 0; i + 1 < anchors.length; i += 2) {
    const xs = parseFloat(anchors[i].getAttribute('x'));
    const xe = parseFloat(anchors[i + 1].getAttribute('x'));
    const count = parseInt(anchors[i + 1].textContent.replace(/\D+/g, ''), 10) || beats;
    const step = count > 1 ? (xe - xs) / (count - 1) : 20;
    const cx = (xs + xe + step) / 2;
    const T = staffTop;
    const g = el('g', { class: 'simile', fill: '#000' });
    g.appendChild(el('polygon', { points: [[cx - 1.15 * sp, T + 3.35 * sp], [cx - 0.45 * sp, T + 3.35 * sp], [cx + 1.15 * sp, T + 0.65 * sp], [cx + 0.45 * sp, T + 0.65 * sp]].map((p) => p.join(',')).join(' ') }));
    g.appendChild(el('circle', { cx: cx - 1.0 * sp, cy: T + 1.2 * sp, r: 0.32 * sp }));
    g.appendChild(el('circle', { cx: cx + 1.0 * sp, cy: T + 2.8 * sp, r: 0.32 * sp }));
    svg.appendChild(g);
  }
  anchors.forEach((t) => t.remove());

  // Chords closer to the staff: one row, just clear of the highest stem, beam or sign.
  let ceiling = staffTop;
  svg.querySelectorAll('path, polygon').forEach((p) => {
    if (p.closest('.abcjs-ending, .abcjs-tempo, .simile')) return;
    const y = box(p)?.y;
    if (y < ceiling && y > staffTop - 60) ceiling = y;
  });
  const above = [...svg.querySelectorAll('text.abcjs-annotation')].filter((t) => parseFloat(t.getAttribute('y')) < staffTop);
  const chords = above.filter((t) => !t.hasAttribute('data-note'));
  const notes = above.filter((t) => t.hasAttribute('data-note'));
  if (above.length) {
    const base = ceiling - CHORD_GAP;
    const oldLowest = Math.max(...above.map((t) => parseFloat(t.getAttribute('y'))));
    chords.forEach((t) => t.setAttribute('y', base));
    // Notes above ("Band out", "x3"): next to the chords if there is room, otherwise just above them.
    const rowH = chords.length ? Math.max(18, ...chords.map((t) => box(t)?.height || 0)) * 0.62 : 0;
    notes.forEach((t) => {
      const bb = box(t);
      const clash = !bb || chords.some((c) => { const cb = box(c); return !cb || (cb.x < bb.x + bb.width + 4 && bb.x < cb.x + cb.width + 4); });
      t.setAttribute('y', clash ? base - rowH : base);
    });
    const delta = base - oldLowest;
    // Section labels travel with the chords so they stay just above them.
    if (delta > 0) svg.querySelectorAll('text.abcjs-part').forEach((t) => t.setAttribute('y', parseFloat(t.getAttribute('y')) + delta));
  }
  // Every bar on the line gets exactly the same width (a fixed grid, like a written chart).
  // A short line is padded with invisible filler bars; they set the grid, then get cut off.
  const bars = [...svg.querySelectorAll('.abcjs-bar')].map(box).filter(Boolean);
  let lineRight = bars.length ? Math.max(...bars.map((b) => b.x + b.width)) : Infinity;
  const fill = [...svg.querySelectorAll('text')].find((t) => t.textContent.includes(FILL_MARK));
  const fx = fill ? parseFloat(fill.getAttribute('x')) : Infinity;
  const missing = fill ? parseInt(fill.textContent.replace(/\D+/g, ''), 10) || 0 : 0;
  if (fill) fill.remove();
  try {
    const right = equaliseBars(svg, fx, missing);
    if (isFinite(right)) lineRight = right;
  } catch (e) { console.warn('equaliseBars', e); }
  if (fill) {
    const vb0 = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    if (vb0.length === 4 && isFinite(lineRight)) {
      const newW = lineRight + 2 - vb0[0];
      if (newW > 40 && newW < vb0[2]) {
        svg.setAttribute('data-fullw', svg.getAttribute('width') || vb0[2]);
        svg.setAttribute('viewBox', `${vb0[0]} ${vb0[1]} ${newW} ${vb0[3]}`);
        svg.setAttribute('width', newW);
        svg.setAttribute('data-trimmed', '');
      }
    }
  }
  try { fitChords(svg, chords, lineRight); } catch (e) { console.warn('fitChords', e); }
  try { placeTimes(svg, chords, lineYs.length ? lineYs[lineYs.length - 1] : staffTop + 4 * sp); } catch (e) { console.warn('placeTimes', e); }

  // Trim empty bands above and below the line, keeping a little breathing room.
  // Measure the drawn pieces one by one (not the whole SVG, which some browsers report as empty).
  const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  if (vb.length !== 4 || vb.some((n) => !isFinite(n))) return;
  let minY = Infinity, maxY = -Infinity;
  svg.querySelectorAll('path, text, polygon, circle, line, use').forEach((n) => {
    const b = box(n);
    if (!b) return;
    minY = Math.min(minY, b.y);
    maxY = Math.max(maxY, b.y + b.height);
  });
  if (!isFinite(minY) || !isFinite(maxY)) return;
  const top = Math.max(vb[1], minY - 6);
  const bottom = Math.min(vb[1] + vb[3], maxY + 14);
  const h = bottom - top;
  // Only trim when the result is sane: the staff is inside it and it isn't tiny.
  if (!(h > 40) || staffTop < top || staffTop > bottom) return;
  svg.setAttribute('viewBox', `${vb[0]} ${top} ${vb[2]} ${h}`);
  svg.setAttribute('height', h);
}

const LABEL_GAP = 6;
const MIN_SCALE = 0.75; // smallest a crowded chord name gets

// Lay a drawn line out again so each bar has the same width. Everything inside a bar
// moves proportionally; long shapes (ties, beams, brackets, hairpins) stretch with it.
// Returns the right edge of the last real bar.
function equaliseBars(svg, fillX, missing) {
  const notes = [...svg.querySelectorAll('g.abcjs-note')].map(box).filter(Boolean);
  if (!notes.length) return NaN;
  const firstNoteX = Math.min(...notes.map((b) => b.x));
  const barList = [...svg.querySelectorAll('g.abcjs-bar')].map((g) => box(g)).filter(Boolean).sort((a, b) => a.x - b.x);
  const lead = barList.filter((b) => b.x + b.width <= firstNoteX + 0.5);
  const ends = barList.filter((b) => b.x + b.width > firstNoteX + 0.5 && b.x < fillX);
  if (!ends.length) return NaN;
  const extras = [...svg.querySelectorAll('.abcjs-staff-extra')].map(box).filter(Boolean);
  const start = lead.length ? Math.max(...lead.map((b) => b.x + b.width))
    : extras.length ? Math.max(...extras.map((b) => b.x + b.width)) : firstNoteX - 10;
  const staff = [...svg.querySelectorAll('.abcjs-staff path')].map(box).filter(Boolean);
  const last = ends[ends.length - 1];
  const staffRight = staff.length ? Math.max(...staff.map((b) => b.x + b.width)) : last.x + last.width;
  const n = ends.length;
  const T = (staffRight - start - last.width) / (n + missing);
  if (!(T > 10)) return NaN;
  const oldB = [start, ...ends.map((b) => b.x)];
  const newB = oldB.map((_, k) => start + k * T);
  for (let k = 1; k < oldB.length; k++) if (!(oldB[k] > oldB[k - 1])) return NaN; // unexpected layout: leave as drawn
  const map = (x) => {
    if (x <= oldB[0]) return x;
    for (let k = 0; k < n; k++) {
      if (x <= oldB[k + 1]) return newB[k] + ((x - oldB[k]) * (newB[k + 1] - newB[k])) / (oldB[k + 1] - oldB[k]);
    }
    return x + (newB[n] - oldB[n]);
  };
  const withTransform = (node, t) => node.setAttribute('transform', `${t} ${node.getAttribute('transform') || ''}`.trim());
  svg.querySelectorAll('path, text, polygon, circle, ellipse, line, rect, use').forEach((node) => {
    if (node.closest('.abcjs-staff, .abcjs-staff-extra')) return;
    if (node.tagName === 'text') {
      const x = parseFloat(node.getAttribute('x'));
      if (!isFinite(x)) return;
      const dx = map(x) - x;
      if (Math.abs(dx) < 0.01) return;
      node.setAttribute('x', x + dx);
      node.querySelectorAll('tspan[x]').forEach((t) => t.setAttribute('x', parseFloat(t.getAttribute('x')) + dx));
      return;
    }
    if (node.closest('text')) return;
    const b = box(node);
    if (!b) return;
    if (b.width <= 30) {
      const c = b.x + b.width / 2;
      const dx = map(c) - c;
      if (Math.abs(dx) >= 0.01) withTransform(node, `translate(${dx} 0)`);
    } else {
      const L = b.x, R = b.x + b.width;
      const L2 = map(L), R2 = map(R);
      const a = (R2 - L2) / (R - L);
      if (Math.abs(a - 1) < 0.001 && Math.abs(L2 - L) < 0.01) return;
      withTransform(node, `matrix(${a} 0 0 1 ${L2 - a * L} 0)`);
    }
  });
  return newB[n] + last.width;
}

// "x4" for a repeated section: bold, about chord size, right under the end repeat sign.
function placeTimes(svg, chords, staffBottom) {
  const marks = [...svg.querySelectorAll('text')].filter((t) => t.textContent.includes(TIMES_MARK));
  if (!marks.length) return;
  const ref = chords[0];
  const size = (parseFloat(ref?.getAttribute('font-size')) || 16) * 1.15;
  const family = ref?.getAttribute('font-family');
  const bars = [...svg.querySelectorAll('g.abcjs-bar')].map(box).filter(Boolean);
  marks.forEach((t) => {
    const label = t.textContent.split(TIMES_MARK).join('');
    t.textContent = label;
    const x = parseFloat(t.getAttribute('x'));
    const next = bars.filter((b) => b.x + b.width >= x).sort((a, b) => a.x - b.x)[0];
    if (next) {
      t.setAttribute('x', next.x + next.width);
      t.setAttribute('text-anchor', 'end');
    }
    t.setAttribute('y', staffBottom + size + 2);
    t.setAttribute('font-size', size);
    t.setAttribute('font-weight', 'bold');
    if (family) t.setAttribute('font-family', family);
    t.setAttribute('class', `${t.getAttribute('class') || ''} times-mark`.trim());
  });
}

// Make each chord name fit before the next one: shrink just that name (down to 75%),
// and if it still doesn't fit, lift it half a row so the two never collide.
function fitChords(svg, chords, lineRight) {
  const items = chords.map((t) => ({ t, x: parseFloat(t.getAttribute('x')), w: box(t)?.width || 0 })).filter((c) => isFinite(c.x) && c.w).sort((a, b) => a.x - b.x);
  let lifted = false;
  items.forEach((c, i) => {
    const end = i + 1 < items.length ? items[i + 1].x : lineRight;
    const room = end - c.x - LABEL_GAP;
    if (!(room > 0) || c.w <= room) { lifted = false; return; }
    const k = Math.max(MIN_SCALE, room / c.w);
    const size = parseFloat(c.t.getAttribute('font-size')) || 15;
    c.t.setAttribute('font-size', size * k);
    if (c.w * k > room + 1 && !lifted && i + 1 < items.length) {
      // Still too long: raise the next chord so they sit on two levels.
      const nxt = items[i + 1].t;
      nxt.setAttribute('y', parseFloat(nxt.getAttribute('y')) - size * 0.95);
      lifted = true;
    } else lifted = false;
  });
}

// Render one song. Returns { pages: [svgElement], warnings, abc, key }.
export function renderSong(typed, { paper: paperName = 'letter', transpose } = {}) {
  // The layout (written out / form / compact) decides which sections are drawn.
  const { song, note: layoutNote } = arrangeSong(typed);
  const paper = PAPER[paperName] || PAPER.letter;
  const steps = transpose ?? (song.transpose || 0);
  const raw = song.useRaw && song.raw && song.raw.trim();
  const contentW = paper.w - MARGIN * 2;
  const host = getWorkArea();
  const tf = (FONT_STYLES[song.style] || FONT_STYLES.hand).text;
  let abc, lineSections = [], warnings = [], target, tunes, chordCount = 0;

  const draw = (pads) => {
    if (raw) { abc = song.raw; lineSections = []; warnings = []; } else ({ abc, lineSections, warnings, chordCount } = songToAbc({ ...song, chordSize: chordSize }, steps, pads));
    host.innerHTML = '';
    target = document.createElement('div');
    target.style.width = Math.round(contentW / ZOOM) + 'px';
    host.appendChild(target);
    try {
      tunes = window.ABCJS.renderAbc(target, abc, {
        staffwidth: Math.round(contentW / ZOOM) - 2,
        paddingleft: 0, paddingright: 0, paddingtop: 6, paddingbottom: 6,
        oneSvgPerLine: true,
        visualTranspose: steps,
        add_classes: true,
      });
    } catch (e) {
      warnings.push('Could not draw this chart: ' + e.message);
      tunes = [];
    }
    // Plain-text notes were drawn in the chord font; switch them to the text font.
    target.querySelectorAll('text').forEach((t) => {
      if (!t.textContent.includes(TEXT_MARK)) return;
      t.setAttribute('data-note', '');
      t.setAttribute('font-family', tf.family);
      t.setAttribute('font-size', tf.size);
      t.setAttribute('font-weight', 'normal');
      t.setAttribute('font-style', tf.style);
      t.querySelectorAll('tspan').forEach((s) => { s.textContent = s.textContent.split(TEXT_MARK).join(''); });
      if (!t.querySelector('tspan')) t.textContent = t.textContent.split(TEXT_MARK).join('');
    });
  };

  // Chord names take no room on their own, so a long one can run into the next.
  // Measure, give the crowded spots more room, and redraw (a few rounds at most).
  // Every bar keeps the same width (easier to follow on a gig); crowded chord
  // names are lettered smaller rather than widening their bar.
  draw([]);
  void chordCount;
  if (tunes[0] && tunes[0].warnings) {
    for (const w of tunes[0].warnings.slice(0, 5)) warnings.push(String(w).replace(/<[^>]+>/g, ''));
  }

  target.querySelectorAll('svg').forEach((svg) => {
    try { tidyLine(svg, song); } catch (e) { console.warn('tidyLine', e); }
  });

  const lines = [...target.querySelectorAll('svg')].map((s) => {
    const w = parseFloat(s.getAttribute('width')) || contentW;
    const fullW = parseFloat(s.getAttribute('data-fullw')) || w;
    let h = parseFloat(s.getAttribute('height'));
    if (!(h > 0)) h = 50;
    // abcjs gives each line its own viewBox (offset down the original tune); keep it.
    const viewBox = s.getAttribute('viewBox') || `0 0 ${w} ${h}`;
    return { svg: s, w, fullW, h, viewBox };
  });
  let headerCount = Math.max(0, lines.length - lineSections.length);
  if (song.formText) {
    lines.splice(headerCount, 0, formLine(song.formText, contentW, tf));
    headerCount++;
  }

  // Lay out lines on pages.
  const pages = [];
  let page, y;
  const start = () => {
    page = newPage(paper);
    pages.push(page);
    y = MARGIN;
    if (pages.length > 1) {
      pageHeader(page, paper, pages.length, song.title || '', song.style);
      y += CONT_HEADER;
    }
  };
  start();
  let lastSection = null;
  lines.forEach((line, i) => {
    const scale = contentW / line.fullW;
    const h = line.h * scale;
    const secIndex = i >= headerCount ? lineSections[i - headerCount] : null;
    const sec = secIndex != null && secIndex >= 0 ? song.sections[secIndex] : null;
    const firstOfSection = secIndex != null && secIndex !== lastSection;
    const pageHasContent = y > MARGIN + (pages.length > 1 ? CONT_HEADER : 0) + 1;
    if (pageHasContent && ((firstOfSection && sec && sec.pageBreak) || y + h > paper.h - MARGIN)) start();
    if (secIndex != null) lastSection = secIndex;

    const nested = line.svg;
    nested.removeAttribute('style');
    nested.setAttribute('viewBox', line.viewBox);
    nested.setAttribute('x', MARGIN);
    nested.setAttribute('y', y);
    nested.setAttribute('width', line.w * scale);
    nested.setAttribute('height', h);
    // Trimmed short lines are clipped so the hidden filler bars' staff doesn't show.
    nested.setAttribute('overflow', nested.hasAttribute('data-trimmed') ? 'hidden' : 'visible');
    page.appendChild(nested);
    y += h;
  });
  host.innerHTML = '';
  return { pages, warnings, abc, key: transposeKeyName(song.key, steps), layoutNote };
}

// ---------- PDF ----------
let fontCss;
async function embeddedFontCss() {
  if (fontCss) return fontCss;
  const parts = await Promise.all(FONT_FILES.map(async (f) => {
    const buf = await (await fetch(f.url)).arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `@font-face{font-family:'${f.family}';font-weight:${f.weight};src:url(data:font/woff2;base64,${btoa(bin)}) format('woff2');}`;
  }));
  fontCss = parts.join('');
  return fontCss;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not draw page image'));
    img.src = url;
  });
}

async function pageToJpeg(svg, paper, scale) {
  const css = await embeddedFontCss();
  const clone = svg.cloneNode(true);
  const style = document.createElementNS(SVGNS, 'style');
  style.textContent = css;
  clone.insertBefore(style, clone.firstChild);
  clone.setAttribute('width', paper.w);
  clone.setAttribute('height', paper.h);
  const xml = new XMLSerializer().serializeToString(clone);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(paper.w * scale);
  canvas.height = Math.round(paper.h * scale);
  const ctx = canvas.getContext('2d');
  // Safari (iPhone/iPad) can draw an SVG image before the fonts embedded in it
  // have loaded, giving the wrong lettering. Draw once to warm it up, wait,
  // then draw a fresh copy over the top.
  for (const wait of [250, 120]) {
    const img = await loadImage(url);
    if (img.decode) await img.decode().catch(() => {});
    await new Promise((r) => setTimeout(r, wait));
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }
  const data = canvas.toDataURL('image/jpeg', 0.92);
  canvas.width = canvas.height = 0; // free memory (important on iPhone)
  return data;
}

// pages: [svgElement]; returns a Blob
export async function pagesToPdf(pages, paperName, onProgress) {
  const paper = PAPER[paperName] || PAPER.letter;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: paper.pdf, compress: true });
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  for (let i = 0; i < pages.length; i++) {
    onProgress && onProgress(i + 1, pages.length);
    const jpeg = await pageToJpeg(pages[i], paper, 3); // ~288 dpi
    if (i > 0) doc.addPage(paper.pdf);
    doc.addImage(jpeg, 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
  }
  return doc.output('blob');
}
