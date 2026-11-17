import { prettyChord, styleChord, canonicalChord } from './abcgen.js';

// Quick-entry chord pad shown while a chord box (bars / endings) is focused.
// Buttons never take focus away from the box, so the caret stays put.

const LETTERS = 'CDEFGAB';
const NATURAL = [0, 2, 4, 5, 7, 9, 11];
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC = { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: '##' };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);
const SHARP_KEYS = new Set(['G', 'D', 'A', 'E', 'B', 'F#', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m']);

function parseKey(key) {
  const m = /^([A-G])([#b]?)(m?)$/.exec(key || 'C') || [0, 'C', '', ''];
  const letterIdx = LETTERS.indexOf(m[1]);
  const pc = (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { letterIdx, pc, minor: m[3] === 'm' };
}

// Spell the note on scale-step `step` (0-6) that sits `semis` above the tonic.
function spell(k, step, semis) {
  const li = (k.letterIdx + step) % 7;
  const target = (k.pc + semis) % 12;
  let diff = target - NATURAL[li];
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  return LETTERS[li] + (ACC[diff] ?? '');
}

const chord = (k, step, semis, quality, roman) => ({ name: spell(k, step, semis) + quality, roman });

export function keyChords(key) {
  const k = parseKey(key);
  if (!k.minor) {
    return {
      diatonic: [
        chord(k, 0, 0, '', 'I'), chord(k, 1, 2, 'm', 'ii'), chord(k, 2, 4, 'm', 'iii'), chord(k, 3, 5, '', 'IV'),
        chord(k, 4, 7, '', 'V'), chord(k, 5, 9, 'm', 'vi'), chord(k, 6, 11, 'm7b5', 'vii°'),
      ],
      extra: [
        chord(k, 6, 10, '', '♭VII'), chord(k, 5, 8, '', '♭VI'), chord(k, 2, 3, '', '♭III'),
        chord(k, 1, 2, '', 'II'), chord(k, 2, 4, '', 'III'), chord(k, 3, 5, 'm', 'iv'),
      ],
    };
  }
  return {
    diatonic: [
      chord(k, 0, 0, 'm', 'i'), chord(k, 1, 2, 'm7b5', 'ii°'), chord(k, 2, 3, '', 'III'), chord(k, 3, 5, 'm', 'iv'),
      chord(k, 4, 7, 'm', 'v'), chord(k, 5, 8, '', 'VI'), chord(k, 6, 10, '', 'VII'),
    ],
    extra: [
      chord(k, 4, 7, '', 'V'), chord(k, 4, 7, '7', 'V7'), chord(k, 3, 5, '', 'IV'), chord(k, 1, 1, '', '♭II'),
    ],
  };
}

export function roots(key) {
  if (FLAT_KEYS.has(key)) return ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  if (SHARP_KEYS.has(key)) return ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
}

const pretty = prettyChord;
const MODS = ['m', '7', 'maj7', 'm7b5', 'dim7', '5', 'sus4', 'sus2', '7sus4', 'add9', '6', '9', 'dim', 'aug'];
const ALTS = ['b5', '#5', 'b9', '#9', '#11', 'b13', 'alt'];
const SHORT_LABEL = { m: '-', maj7: 'Δ7', m7b5: 'ø7', dim7: '°7', dim: '°', aug: '+' };

// ---------------------------------------------------------------- editing
function ctx(field) {
  const v = field.value;
  const pos = field.selectionStart ?? v.length;
  return { v, pos, before: v.slice(0, pos), after: v.slice(field.selectionEnd ?? pos) };
}
function put(field, before, after) {
  field.value = before + after;
  const p = before.length;
  try { field.setSelectionRange(p, p); } catch { /* ignore */ }
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
const needsSpace = (before) => before.length && !/[\s/]$/.test(before);

function insertToken(field, token) {
  const { before, after } = ctx(field);
  // ">" then ">" makes ">>" (accent the first two slashes).
  if (token === '>' && />$/.test(before)) return put(field, before + '>', after);
  put(field, before + (needsSpace(before) ? ' ' : '') + token, after);
}
function insertChord(field, name) {
  const { before, after } = ctx(field);
  if (/\/$/.test(before)) {
    // After "/": use just the root as the bass note.
    put(field, before + name.match(/^[A-G][#b]?/)[0], after);
  } else insertToken(field, styleChord(name, getStyle()));
}
function insertBar(field, kind = '|') {
  const { before, after } = ctx(field);
  let b = before.replace(/\s+$/, '');
  // Upgrade the barline just typed instead of adding a second one.
  if (kind === '|:' && /:\|$/.test(b)) { b = b.slice(0, -2).replace(/\s+$/, ''); kind = ':|:'; }
  else if (kind !== '|' && /(^|\s)\|$/.test(b)) b = b.slice(0, -1).replace(/\s+$/, '');
  else if (kind === ':|' && /\|:$/.test(b)) { b = b.slice(0, -2).replace(/\s+$/, ''); }
  put(field, b + (b.length ? ' ' : '') + kind + ' ', after);
}
function addModifier(field, mod) {
  const { before, after } = ctx(field);
  const m = /([A-G][#b]?)([^\s|/]*)$/.exec(before);
  if (!m) return false;
  const typed = m[0];
  const canon = canonicalChord(typed);
  const write = (root, q) => put(field, before.slice(0, before.length - typed.length) + styleChord(root + q, getStyle()), after);
  let quality = canon.slice(m[1].length);
  const original = quality;
  const isMinor = quality.startsWith('m') && !quality.startsWith('maj');
  if (ALTS.includes(mod)) {
    // Alterations add on (G7 → G7♭9 → G7♭9♯11); tap again to take one off.
    if (mod === 'alt') quality = /alt$/.test(quality) ? quality.replace(/alt$/, '') || '7' : (isMinor ? 'm7' : '7') + 'alt';
    else if (quality.includes(mod)) quality = quality.replace(mod, '');
    else {
      quality = quality.replace(/alt$/, '');
      if (!/(7|9|11|13)/.test(quality)) quality += '7';
      quality += mod;
    }
    write(m[1], quality);
    return true;
  }
  if (mod === 'm') quality = isMinor ? '' : 'm'; // toggle minor
  else if (['7', '9', '6', 'add9'].includes(mod)) quality = (isMinor ? 'm' : '') + mod; // keep minor: Am → Am7
  else quality = mod === 'maj7' && isMinor ? 'm(maj7)' : mod; // sus4, maj7, dim… replace (minor + maj7 = minor-major 7th)
  if (quality === original && mod !== 'm') quality = isMinor ? 'm' : ''; // tap again to undo
  write(m[1], quality);
  return true;
}
function addSlash(field) {
  const { before, after } = ctx(field);
  if (!/[A-G][^\s|]*$/.test(before) || /\/$/.test(before)) return false;
  put(field, before + '/', after);
  return true;
}
function backspace(field) {
  const { before, after } = ctx(field);
  let b = before.replace(/\s+$/, '');
  if (b.endsWith('|')) b = b.slice(0, -1);
  else b = b.replace(/\S+$/, '');
  put(field, b.replace(/\s+$/, '') + (b.trim() ? ' ' : ''), after);
}

// ---------------------------------------------------------------- UI
let pad, field, getKey, getStyle, setStyle, kbPref;

function kbHidden() {
  if (kbPref != null) return kbPref;
  try { const v = localStorage.getItem('cm.kbHidden'); if (v != null) return (kbPref = v === '1'); } catch { /* ignore */ }
  return (kbPref = window.matchMedia('(pointer: coarse)').matches);
}
export const keyboardHidden = () => kbHidden();

function setKb(hidden) {
  kbPref = hidden;
  try { localStorage.setItem('cm.kbHidden', hidden ? '1' : '0'); } catch { /* ignore */ }
  document.querySelectorAll('[data-chordbox]').forEach((f) => f.setAttribute('inputmode', hidden ? 'none' : 'text'));
  if (field) { field.blur(); setTimeout(() => field && field.focus(), 30); }
}

function btn(label, act, val = '', sub = '', cls = '') {
  if (act === 'chord' && val.length > 4) cls += ' pk-long';
  return `<button type="button" class="pk ${cls}" data-pk="${act}" data-v="${val.replace(/"/g, '&quot;')}">${label}${sub ? `<small>${sub}</small>` : ''}</button>`;
}

function draw() {
  const key = getKey();
  const style = getStyle();
  const show = (name) => pretty(styleChord(name, style));
  const modLabel = (m) => (style === 'short' && SHORT_LABEL[m] ? SHORT_LABEL[m] : pretty(m));
  const { diatonic, extra } = keyChords(key);
  pad.innerHTML = `
    <div class="pk-row pk-tools">
      ${btn('|', 'bar', '|', 'bar', 'pk-bar')}
      ${btn('‖:', 'bar', '|:', 'repeat', 'pk-rep')}
      ${btn(':‖', 'bar', ':|', 'end rpt', 'pk-rep')}
      ${btn('%', 'tok', '%', 'bar rpt', 'pk-rep')}
      ${btn('·', 'tok', '.', 'hold')}
      ${btn('&gt;', 'tok', '>', 'accent')}
      ${btn('⌫', 'back', '', '', 'pk-del')}
      ${btn(kbHidden() ? '⌨' : '⌨̶', 'kb', '', kbHidden() ? 'type' : 'hide')}
      ${btn('Done', 'done', '', '', 'pk-done')}
    </div>
    <div class="pk-label pk-labelrow"><span>In ${pretty(key)}</span>${btn(style === 'short' ? 'CΔ7 · C-7' : 'Cmaj7 · Cm7', 'style', style === 'short' ? 'standard' : 'short', '', 'pk-style')}</div>
    <div class="pk-row pk-key">${diatonic.map((c) => btn(show(c.name), 'chord', c.name, c.roman, 'pk-chord')).join('')}</div>
    <div class="pk-row pk-key">${extra.map((c) => btn(show(c.name), 'chord', c.name, c.roman, 'pk-chord pk-out')).join('')}${btn('/', 'slash', '', 'bass')}</div>
    <div class="pk-row pk-alt">${ALTS.map((m) => btn(m === 'alt' ? 'alt' : pretty(m), 'mod', m)).join('')}</div>
    <div class="pk-row pk-mods">${MODS.map((m) => btn(modLabel(m), 'mod', m)).join('')}${btn('&lt;', 'tok', '<', 'cresc')}${btn('N.C.', 'tok', 'N.C.')}</div>
    <div class="pk-row pk-roots">${roots(key).map((r) => btn(pretty(r), 'chord', r, '', 'pk-root')).join('')}</div>`;
}

function act(b) {
  if (!field) return;
  const a = b.dataset.pk, v = b.dataset.v;
  if (a === 'bar') insertBar(field, v || '|');
  else if (a === 'tok') insertToken(field, v);
  else if (a === 'chord') insertChord(field, v);
  else if (a === 'mod') addModifier(field, v);
  else if (a === 'slash') addSlash(field);
  else if (a === 'back') backspace(field);
  else if (a === 'kb') { setKb(!kbHidden()); draw(); }
  else if (a === 'style') { setStyle(v); draw(); }
  else if (a === 'done') field.blur();
  if (navigator.vibrate) try { navigator.vibrate(5); } catch { /* ignore */ }
}

function place() {
  if (!pad || pad.hidden) return;
  const vv = window.visualViewport;
  const offset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  pad.style.bottom = offset + 'px';
  document.body.style.paddingBottom = pad.offsetHeight + offset + 12 + 'px';
}

export function initPalette(keyGetter, styleGetter = () => 'short', styleSetter = () => {}) {
  getKey = keyGetter;
  getStyle = styleGetter;
  setStyle = styleSetter;
  pad = document.createElement('div');
  pad.className = 'chordpad';
  pad.hidden = true;
  pad.setAttribute('role', 'toolbar');
  pad.setAttribute('aria-label', 'Chord pad');
  document.body.appendChild(pad);

  // Keep focus in the chord box: stop the press from moving focus, act on release.
  let touchBtn = null;
  pad.addEventListener('touchstart', (e) => { e.preventDefault(); touchBtn = e.target.closest('.pk'); touchBtn?.classList.add('down'); }, { passive: false });
  pad.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (touchBtn) { touchBtn.classList.remove('down'); act(touchBtn); touchBtn = null; }
  }, { passive: false });
  pad.addEventListener('touchcancel', () => { touchBtn?.classList.remove('down'); touchBtn = null; });
  pad.addEventListener('mousedown', (e) => e.preventDefault());
  pad.addEventListener('click', (e) => { const b = e.target.closest('.pk'); if (b) act(b); });

  document.addEventListener('focusin', (e) => {
    if (!e.target.matches('[data-chordbox]')) return;
    field = e.target;
    draw();
    pad.hidden = false;
    place();
    // Keep the box visible above the pad.
    setTimeout(() => {
      const r = field.getBoundingClientRect();
      const padTop = pad.getBoundingClientRect().top;
      if (r.bottom > padTop - 8) window.scrollBy({ top: r.bottom - padTop + 16, behavior: 'smooth' });
    }, 60);
  });
  document.addEventListener('focusout', (e) => {
    if (e.target !== field) return;
    setTimeout(() => {
      if (document.activeElement && document.activeElement.matches('[data-chordbox]')) return;
      field = null;
      pad.hidden = true;
      document.body.style.paddingBottom = '';
    }, 120);
  });
  window.visualViewport?.addEventListener('resize', place);
  window.visualViewport?.addEventListener('scroll', place);
  window.addEventListener('resize', place);
}

// Redraw when the song's key changes while the pad is open.
export function refreshPalette() { if (pad && !pad.hidden) { draw(); place(); } }
