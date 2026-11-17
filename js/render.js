// Engraves songs with abcjs, lays the lines out on pages, and exports PDFs.
import { songToAbc, transposeKeyName, prettyChord, meterInfo, TEXT_MARK, SIMILE_MARK, FONT_STYLES } from './abcgen.js';

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
  if (!workArea) {
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
  const svg = el('svg', { xmlns: SVGNS, viewBox: `0 0 ${paper.w} ${paper.h}`, width: paper.w, height: paper.h, class: 'page-svg' });
  svg.appendChild(el('rect', { x: 0, y: 0, width: paper.w, height: paper.h, fill: '#fff' }));
  return svg;
}

function pageHeader(svg, paper, pageNo, title, style) {
  const font = style === 'clean' ? 'Helvetica, Arial, sans-serif' : '"Chart Hand", sans-serif';
  svg.appendChild(el('text', { x: MARGIN, y: MARGIN + 6, 'font-family': font, 'font-size': 20, fill: '#000' }, String(pageNo)));
  svg.appendChild(el('text', { x: paper.w - MARGIN, y: MARGIN + 6, 'font-family': font, 'font-size': 14, fill: '#444', 'text-anchor': 'end' }, title));
}

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
    const beatW = beats > 1 ? (xe - xs) / (beats - 1) : 20;
    const cx = (xs + xe + beatW) / 2;
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

// How many spacer units each chord label needs so it clears the next label
// (or the end of the line). Returns null when nothing collides.
const LABEL_GAP = 7;
const UNIT = 5; // rough width one spacer adds once the line is justified
const MIN_SCALE = 0.75; // smallest chord lettering on a crowded line

// Lines whose chord names can't all fit at full size get smaller lettering.
function lineScales(target) {
  return [...target.querySelectorAll('svg')].map((svg) => {
    const chords = [...svg.querySelectorAll('text.abcjs-annotation')].filter((t) => !t.hasAttribute('data-note') && !t.textContent.includes(SIMILE_MARK));
    if (chords.length < 2) return 1;
    const bars = [...svg.querySelectorAll('.abcjs-bar')].map(box).filter(Boolean);
    if (!bars.length) return 1;
    const right = Math.max(...bars.map((b) => b.x + b.width));
    const left = Math.min(...chords.map((t) => parseFloat(t.getAttribute('x'))));
    const total = chords.reduce((sum, t) => sum + (box(t)?.width || 0) + LABEL_GAP, 0) * 1.08;
    const k = (right - left) / total;
    return isFinite(k) && k > 0 ? Math.max(MIN_SCALE, Math.min(1, k)) : 1;
  });
}

function chordCrowding(target, chordCount, scales) {
  const svgs = [...target.querySelectorAll('svg')];
  const all = [];
  svgs.forEach((svg, li) => {
    svg.querySelectorAll('text.abcjs-annotation').forEach((t) => {
      if (t.hasAttribute('data-note') || t.textContent.includes(SIMILE_MARK)) return;
      all.push({ t, li, svg });
    });
  });
  if (all.length !== chordCount) return null; // can't match labels to chords; leave as drawn
  const need = new Array(chordCount).fill(0);
  let any = false;
  all.forEach((c, i) => {
    const x = parseFloat(c.t.getAttribute('x'));
    const w = (box(c.t)?.width || 0) * (scales[c.li] || 1);
    if (!isFinite(x) || !w) return;
    const next = all[i + 1];
    let limit;
    if (next && next.li === c.li) limit = parseFloat(next.t.getAttribute('x')) - LABEL_GAP;
    else {
      const bars = [...c.svg.querySelectorAll('.abcjs-bar')].map(box).filter(Boolean);
      limit = bars.length ? Math.max(...bars.map((b) => b.x + b.width)) + 4 : Infinity;
    }
    const over = x + w - limit;
    if (over > 0.5) { need[i] = Math.ceil(over / UNIT); any = true; }
  });
  return any ? need : null;
}

// Render one song. Returns { pages: [svgElement], warnings, abc, key }.
export function renderSong(song, { paper: paperName = 'letter', transpose } = {}) {
  const paper = PAPER[paperName] || PAPER.letter;
  const steps = transpose ?? (song.transpose || 0);
  const raw = song.useRaw && song.raw && song.raw.trim();
  const contentW = paper.w - MARGIN * 2;
  const host = getWorkArea();
  const tf = (FONT_STYLES[song.style] || FONT_STYLES.hand).text;
  let abc, lineSections = [], warnings = [], target, tunes, chordCount = 0;

  const draw = (pads) => {
    if (raw) { abc = song.raw; lineSections = []; warnings = []; } else ({ abc, lineSections, warnings, chordCount } = songToAbc(song, steps, pads));
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
  let pads = [];
  draw(pads);
  // Decide lettering size per line from the first drawing (line breaks don't change).
  let scales = [];
  try { if (!raw) scales = lineScales(target); } catch (e) { console.warn('lineScales', e); }
  for (let round = 0; round < 6 && !raw; round++) {
    let more = null;
    try { more = chordCrowding(target, chordCount, scales); } catch (e) { console.warn('chordCrowding', e); }
    if (!more) break;
    pads = pads.slice();
    more.forEach((n, i) => { if (n) pads[i] = (pads[i] || 0) + n; });
    draw(pads);
  }
  [...target.querySelectorAll('svg')].forEach((svg, li) => {
    const k = scales[li] || 1;
    if (k >= 1) return;
    svg.querySelectorAll('text.abcjs-annotation').forEach((t) => {
      if (t.hasAttribute('data-note')) return;
      t.setAttribute('font-size', (parseFloat(t.getAttribute('font-size')) || 18) * k);
    });
  });
  if (tunes[0] && tunes[0].warnings) {
    for (const w of tunes[0].warnings.slice(0, 5)) warnings.push(String(w).replace(/<[^>]+>/g, ''));
  }

  target.querySelectorAll('svg').forEach((svg) => {
    try { tidyLine(svg, song); } catch (e) { console.warn('tidyLine', e); }
  });

  const lines = [...target.querySelectorAll('svg')].map((s) => {
    const w = parseFloat(s.getAttribute('width')) || contentW;
    let h = parseFloat(s.getAttribute('height'));
    if (!(h > 0)) h = 50;
    // abcjs gives each line its own viewBox (offset down the original tune); keep it.
    const viewBox = s.getAttribute('viewBox') || `0 0 ${w} ${h}`;
    return { svg: s, w, h, viewBox };
  });
  const headerCount = Math.max(0, lines.length - lineSections.length);

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
    const scale = contentW / line.w;
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
    nested.setAttribute('width', contentW);
    nested.setAttribute('height', h);
    nested.setAttribute('overflow', 'visible');
    page.appendChild(nested);
    y += h;
  });
  host.innerHTML = '';
  return { pages, warnings, abc, key: transposeKeyName(song.key, steps) };
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
