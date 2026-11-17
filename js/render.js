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

// Per-line clean-up after abcjs has drawn it:
//  - pull chord symbols (and text stacked above them) down close to the staff
//  - draw one-bar repeat signs where the generator left invisible anchors
function tidyLine(svg, song) {
  const topLine = svg.querySelector('.abcjs-top-line');
  if (!topLine) return;
  const staffTop = topLine.getBBox().y;
  const lineYs = [...svg.querySelectorAll('.abcjs-staff path')].map((p) => p.getBBox().y).filter((y) => y > staffTop + 1).sort((a, b) => a - b);
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

  // Chords closer to the staff.
  const above = [...svg.querySelectorAll('text.abcjs-annotation')].filter((t) => parseFloat(t.getAttribute('y')) < staffTop);
  if (above.length) {
    const lowest = Math.max(...above.map((t) => parseFloat(t.getAttribute('y'))));
    const delta = staffTop - CHORD_GAP - lowest;
    if (delta > 0) {
      // Section labels travel with the chords so they stay just above them.
      [...above, ...svg.querySelectorAll('text.abcjs-part')].forEach((t) => t.setAttribute('y', parseFloat(t.getAttribute('y')) + delta));
    }
  }
  // Trim empty bands above and below the line, keeping a little breathing room.
  const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  if (vb.length === 4) {
    const bb = svg.getBBox();
    const top = Math.max(vb[1], bb.y - 6);
    const bottom = Math.min(vb[1] + vb[3], bb.y + bb.height + 14);
    const h = bottom - top;
    svg.setAttribute('viewBox', `${vb[0]} ${top} ${vb[2]} ${h}`);
    svg.setAttribute('height', h);
  }
}

// Render one song. Returns { pages: [svgElement], warnings, abc, key }.
export function renderSong(song, { paper: paperName = 'letter', transpose } = {}) {
  const paper = PAPER[paperName] || PAPER.letter;
  const steps = transpose ?? (song.transpose || 0);
  let abc, lineSections = [], warnings = [];
  if (song.useRaw && song.raw && song.raw.trim()) {
    abc = song.raw;
  } else {
    ({ abc, lineSections, warnings } = songToAbc(song, steps));
  }

  const contentW = paper.w - MARGIN * 2;
  const host = getWorkArea();
  host.innerHTML = '';
  const target = document.createElement('div');
  target.style.width = Math.round(contentW / ZOOM) + 'px';
  host.appendChild(target);

  let tunes;
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
  if (tunes[0] && tunes[0].warnings) {
    for (const w of tunes[0].warnings.slice(0, 5)) warnings.push(String(w).replace(/<[^>]+>/g, ''));
  }

  // Plain-text notes were drawn in the chord font; switch them to the text font.
  const tf = (FONT_STYLES[song.style] || FONT_STYLES.hand).text;
  target.querySelectorAll('text').forEach((t) => {
    if (!t.textContent.includes(TEXT_MARK)) return;
    t.setAttribute('font-family', tf.family);
    t.setAttribute('font-size', tf.size);
    t.setAttribute('font-weight', 'normal');
    t.setAttribute('font-style', tf.style);
    t.querySelectorAll('tspan').forEach((s) => { s.textContent = s.textContent.split(TEXT_MARK).join(''); });
    if (!t.querySelector('tspan')) t.textContent = t.textContent.split(TEXT_MARK).join('');
  });

  target.querySelectorAll('svg').forEach((svg) => tidyLine(svg, song));

  const lines = [...target.querySelectorAll('svg')].map((s) => {
    const w = parseFloat(s.getAttribute('width')) || contentW;
    const h = parseFloat(s.getAttribute('height')) || 50;
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

function niceDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// A simple printed setlist page for a gig.
export function renderSetlist(gig, songs, paperName = 'letter') {
  const paper = PAPER[paperName] || PAPER.letter;
  const svg = newPage(paper);
  const hand = '"Chart Hand", sans-serif';
  let y = MARGIN + 40;
  svg.appendChild(el('text', { x: paper.w / 2, y, 'text-anchor': 'middle', 'font-family': '"Chart Title", serif', 'font-weight': 'bold', 'font-size': 34, fill: '#000' }, gig.name || 'Setlist'));
  y += 30;
  const sub = [niceDate(gig.date), gig.venue].filter(Boolean).join('  ·  ');
  if (sub) {
    svg.appendChild(el('text', { x: paper.w / 2, y, 'text-anchor': 'middle', 'font-family': hand, 'font-size': 18, fill: '#333' }, sub));
    y += 20;
  }
  y += 30;
  const rows = songs.length;
  const rowH = Math.max(24, Math.min(44, (paper.h - y - MARGIN - (gig.notes ? 60 : 0)) / Math.max(1, rows)));
  const size = Math.min(30, rowH * 0.72);
  songs.forEach((item, i) => {
    const yy = y + rowH * (i + 0.75);
    svg.appendChild(el('text', { x: MARGIN + 30, y: yy, 'text-anchor': 'end', 'font-family': hand, 'font-size': size, fill: '#666' }, `${i + 1}.`));
    svg.appendChild(el('text', { x: MARGIN + 44, y: yy, 'font-family': hand, 'font-size': size, fill: '#000' }, item.title || 'Untitled'));
    // Key in the chord font (the small-caps font would turn "Ab" into "AB").
    const info = el('text', { x: paper.w - MARGIN, y: yy, 'text-anchor': 'end', 'font-size': size * 0.8, fill: '#333' });
    info.appendChild(el('tspan', { 'font-family': '"Chart Chord", sans-serif' }, prettyChord(item.key)));
    if (item.tempo) info.appendChild(el('tspan', { 'font-family': hand, dx: 14 }, `${item.tempo} bpm`));
    svg.appendChild(info);
    svg.appendChild(el('line', { x1: MARGIN, x2: paper.w - MARGIN, y1: y + rowH * (i + 1), y2: y + rowH * (i + 1), stroke: '#ddd', 'stroke-width': 1 }));
  });
  if (gig.notes) {
    svg.appendChild(el('text', { x: MARGIN, y: paper.h - MARGIN - 10, 'font-family': hand, 'font-size': 16, fill: '#333' }, gig.notes.slice(0, 120)));
  }
  return svg;
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
  const img = await loadImage(url);
  if (img.decode) await img.decode().catch(() => {});
  // Safari sometimes needs a moment before web fonts inside an SVG image are ready.
  await new Promise((r) => setTimeout(r, 60));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(paper.w * scale);
  canvas.height = Math.round(paper.h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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
