// Turns a song (plain JS object) into ABC notation for abcjs to engrave.
//
// Bar syntax (one section's "bars" text):
//   Bars are separated by "|". An empty bar keeps the previous chord.
//   Inside a bar, words are separated by spaces:
//     E  C#m7  B/A  N.C.   chord symbols (several chords split the bar evenly)
//     .                    hold the previous chord for one beat (e.g. "A . . B")
//     >  >>  >>>           accent the first 1, 2, 3... slashes of the bar
//     <                    crescendo hairpin under the bar ("cresc" works too)
//     dim                  diminuendo hairpin under the bar
//     "Band out"           text above the bar
//     segno coda fine      symbols above the bar
//     ds dc ds-coda dc-fine to-coda   road-map instructions
//     8ths quarters slashes whole     rhythm for this bar only
//     {e2 f g a4}          real notation for this bar (ABC notes, eighth = 1)

export const RHYTHMS = {
  slashes: 'Slashes',
  quarters: 'Slashes with stems',
  eighths: '8th-note slashes',
  whole: 'One slash per bar',
};

const KEYWORDS = {
  segno: { deco: '!segno!', at: 'start' },
  coda: { deco: '!coda!', at: 'start' },
  fine: { deco: '!fine!', at: 'end' },
  ds: { deco: '!D.S.!', at: 'end' },
  'd.s.': { deco: '!D.S.!', at: 'end' },
  dc: { deco: '!D.C.!', at: 'end' },
  'd.c.': { deco: '!D.C.!', at: 'end' },
  'ds-coda': { deco: '!D.S.alcoda!', at: 'end' },
  'dc-coda': { deco: '!D.C.alcoda!', at: 'end' },
  'ds-fine': { deco: '!D.S.alfine!', at: 'end' },
  'dc-fine': { deco: '!D.C.alfine!', at: 'end' },
  'to-coda': { text: 'To Coda', deco: '!coda!', at: 'end' },
  tocoda: { text: 'To Coda', deco: '!coda!', at: 'end' },
  fermata: { deco: '!fermata!', at: 'end' },
};

const RHYTHM_WORDS = { '8ths': 'eighths', eighths: 'eighths', quarters: 'quarters', slashes: 'slashes', whole: 'whole' };

const CHORD_RE = /^(N\.?C\.?|[A-G](?:#|b|♯|♭)?[A-Za-z0-9+°øØΔ△#♯♭()\-−^]*(?:\/[A-G](?:#|b|♯|♭)?)?)$/;

export const CHORD_STYLES = {
  standard: 'Standard (Cmaj7, Cm7, Cm7♭5, Cdim7)',
  short: 'Shorthand (CΔ7, C-7, Cø7, C°7)',
};

// Accept shorthand as typed and store/transpose one spelling:
// CΔ7 CM7 → Cmaj7 · CM CΔ Cmaj → C · Cmin7 C-7 → Cm7 · Cø → Cm7b5 · C°7 → Cdim7 · C+ C+5 → Caug
export function canonicalChord(chord) {
  const m = /^([A-G][#b]?)(.*?)(\/[A-G][#b]?)?$/.exec(chord);
  if (!m) return chord;
  let q = m[2].replace(/△/g, 'Δ').replace(/−/g, '-').replace(/Ø/g, 'ø');
  q = q.replace(/^min(?!or)/, 'm').replace(/^-/, 'm');
  q = q.replace(/^m(?:Maj|maj|Δ|\^|M)7?/, 'm(maj7)');
  // Major indicators: on their own they mean a plain major chord (CM, Cmaj, CΔ = C);
  // with a number they mean major 7th and up (CM7, Cmaj7, CΔ7 = Cmaj7; CΔ9 = Cmaj9).
  if (/^(?:Δ|\^)/.test(q)) q = 'maj' + q.slice(1);
  else if (/^Maj/.test(q)) q = 'maj' + q.slice(3);
  else if (/^M(?=\d|$)/.test(q)) q = 'maj' + q.slice(1);
  if (q === 'maj') q = '';
  q = q.replace(/^ø7?/, 'm7b5').replace(/^°/, 'dim').replace(/^\+5?/, 'aug');
  return m[1] + q + (m[3] || '');
}

// Print a (canonical) chord in the chosen style.
export function styleChord(chord, style) {
  if (style !== 'short') return chord;
  const m = /^([A-G][#b]?)(.*?)(\/[A-G][#b]?)?$/.exec(chord);
  if (!m) return chord;
  let q = m[2];
  if (/^m7b5/.test(q)) q = 'ø7' + q.slice(4);
  else if (/^m\(maj7\)/.test(q)) q = '-Δ7' + q.slice(7);
  else if (/^maj/.test(q)) q = 'Δ' + q.slice(3);
  else if (/^m(?!aj)/.test(q)) q = '-' + q.slice(1);
  else if (/^dim/.test(q)) q = '°' + q.slice(3);
  else if (/^aug/.test(q)) q = '+' + q.slice(3);
  return m[1] + q + (m[3] || '');
}

// Normalise "smart" punctuation that iPhone/iPad keyboards insert.
export function normalise(text) {
  return String(text || '')
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b');
}

function abcText(s) {
  // Text inside an ABC annotation: no double quotes allowed.
  return String(s).replace(/"/g, "'").replace(/\s+/g, ' ').trim();
}

// Split a bar's text into tokens, keeping {…} and "…" groups together.
function tokenize(bar) {
  const tokens = [];
  const re = /\{[^}]*\}?|"[^"]*"?|\S+/g;
  let m;
  while ((m = re.exec(bar))) tokens.push(m[0]);
  return tokens;
}

export function parseBar(text) {
  let pushNext = false;
  const bar = { simile: false, pushes: false, beats: [], accents: 0, hairpin: null, above: [], startDecos: [], endDecos: [], endText: [], rhythm: null, custom: null, warnings: [] };
  for (const tok of tokenize(normalise(text).trim())) {
    const low = tok.toLowerCase();
    if (tok.startsWith('{')) {
      bar.custom = tok.replace(/^\{|\}$/g, '').trim();
    } else if (tok.startsWith('"')) {
      const t = tok.replace(/^"|"$/g, '').trim();
      if (t) bar.above.push(t);
    } else if (tok === '%') {
      bar.simile = true;
    } else if (/^>+$/.test(tok)) {
      bar.accents = tok.length;
    } else if (tok === '<' || low === 'cresc') {
      bar.hairpin = 'cresc';
    } else if (low === 'dim' || low === 'decresc') {
      bar.hairpin = 'dim';
    } else if (RHYTHM_WORDS[low]) {
      bar.rhythm = RHYTHM_WORDS[low];
    } else if (KEYWORDS[low]) {
      const k = KEYWORDS[low];
      if (k.at === 'start') bar.startDecos.push(k.deco);
      else { bar.endDecos.push(k.deco); if (k.text) bar.endText.push(k.text); }
    } else if (tok === '.' || tok === '/' || tok === '-') {
      bar.beats.push(null);
    } else if (tok === '^') {
      pushNext = true;
    } else if (tok.startsWith('^') && CHORD_RE.test(tok.slice(1))) {
      bar.beats.push('^' + canonicalChord(tok.slice(1)));
      bar.pushes = true;
    } else if (CHORD_RE.test(tok)) {
      bar.beats.push((pushNext ? '^' : '') + canonicalChord(tok));
      if (pushNext) bar.pushes = true;
      pushNext = false;
    } else {
      bar.warnings.push(tok);
    }
  }
  return bar;
}

// Bars with inline repeat signs: "|:" starts a repeat, ":|" ends one, ":|:" does both.
export function splitBarsEx(text) {
  const t = normalise(text).replace(/\n/g, ' ').replace(/::/g, ':|:').trim();
  if (!t) return [];
  const parts = t.split(/(:\|:|\|:|:\||\|)/);
  const bars = [];
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i].trim();
    const before = parts[i - 1], after = parts[i + 1];
    const edge = i === 0 || i === parts.length - 1;
    if (!seg && edge && parts.length > 1) continue; // leading/trailing barline
    bars.push({
      text: seg,
      startRepeat: before === '|:' || before === ':|:',
      endRepeat: after === ':|' || after === ':|:',
    });
  }
  return bars;
}

const barsOf = (text) => splitBarsEx(text).map((b) => Object.assign(parseBar(b.text), { startRepeat: b.startRepeat, endRepeat: b.endRepeat }));

export function splitBars(text) {
  const t = normalise(text).replace(/\n/g, ' ').trim();
  if (!t) return [];
  let parts = t.split('|');
  // Allow a leading or trailing "|".
  if (parts.length > 1 && parts[0].trim() === '') parts = parts.slice(1);
  if (parts.length > 1 && parts[parts.length - 1].trim() === '') parts = parts.slice(0, -1);
  return parts.map((p) => p.trim());
}

// Meter → how slashes are drawn. Units are sixteenth notes (L:1/16).
export function meterInfo(time) {
  const m = /^(\d+)\/(\d+)$/.exec(time || '4/4') || [0, 4, 4];
  const num = +m[1], den = +m[2];
  const unit = 16 / den; // sixteenths per written beat-note
  if (den === 8 && num % 3 === 0 && num > 3) {
    return { num, den, beats: num / 3, beatLen: unit * 3, sub: 3, barLen: num * unit };
  }
  return { num, den, beats: num, beatLen: unit, sub: 2, barLen: num * unit };
}

// Spread chord tokens across the bar's beats.
function placeChords(tokens, beats) {
  if (!tokens.some(Boolean)) return new Array(beats).fill(null);
  const out = new Array(beats).fill(null);
  if (!tokens.length) return out;
  if (tokens.length > beats) {
    // More positions than slashes (e.g. "F . Gm ." in 6/8): drop the holds and spread the chords.
    tokens = tokens.filter(Boolean);
    if (tokens.length > beats) {
      // Still too many: the last slash carries the leftovers.
      const rest = tokens.slice(beats - 1).join('  ');
      tokens = [...tokens.slice(0, beats - 1), rest];
    }
    return placeChords(tokens, beats);
  }
  const each = Math.floor(beats / tokens.length);
  const extra = beats - each * tokens.length;
  let pos = 0;
  tokens.forEach((t, i) => {
    out[pos] = t;
    pos += each + (i < extra ? 1 : 0);
  });
  return out;
}

const RHY = '!style=rhythm!';
// Marks plain text (notes, "x3"…) so the renderer can give it the small text font.
// Everything else drawn as an annotation is a chord symbol.
export const TEXT_MARK = '\u2060';
// Marks the invisible anchors of a one-bar repeat sign (drawn by the renderer).
export const SIMILE_MARK = '\u2063';
// Marks where invisible filler bars start on a short line (the renderer trims them off).
export const FILL_MARK = '\u2064';
// Marks the "x4" of a repeated section (drawn bold under the end repeat sign).
export const TIMES_MARK = '\u2061';

const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_KEYS = new Set(['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb', 'Am', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm']);

function moveNote(note, steps, flats) {
  const idx = KEY_INDEX[note];
  if (idx == null) return note;
  const n = (((idx + steps) % 12) + 12) % 12;
  return (flats ? FLATS : SHARPS)[n];
}

// Transpose one chord symbol, e.g. "C#m7/G#" up 1 → "Dm7/A".
export function transposeChord(chord, steps, targetKey) {
  if (!steps || /^N\.?C/.test(chord)) return chord;
  const m = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/.exec(chord);
  if (!m) return chord;
  const flats = FLAT_KEYS.has(targetKey);
  return moveNote(m[1], steps, flats) + m[2] + (m[3] ? '/' + moveNote(m[3], steps, flats) : '');
}

// Pretty sharps/flats for printing: C#m7b5 → C♯m7♭5
export function prettyChord(chord) {
  return chord
    .replace(/^([A-G])#/, '$1♯').replace(/^([A-G])b/, '$1♭')
    .replace(/\/([A-G])#/, '/$1♯').replace(/\/([A-G])b/, '/$1♭')
    .replace(/#(?=\d)/g, '♯').replace(/b(?=\d)/g, '♭');
}

const textNote = (pos, t) => `"${pos}${TEXT_MARK}${abcText(t)}"`;


// opts.pushOut: a chord pushed into the NEXT bar's beat 1 lands on this bar's last eighth.
// opts.tiedIn: this bar's beat-1 chord was already sounded (and named) in the bar before.
function barToAbc(bar, meter, defaultRhythm, extraStart, extraEnd, tr, opts = {}) {
  const chordText = (c) => {
    tr.ord++;
    return `"^${c.replace(/(^|\s)\^/g, '$1').split(/\s+/).map((x) => prettyChord(styleChord(transposeChord(x, tr.steps, tr.key), tr.style))).join('  ')}"`;
  };
  const chords = placeChords(bar.beats, meter.beats);
  const startBits = extraStart + bar.startDecos.join('') + bar.above.map((t) => textNote('^', t)).join('');
  const endBits = extraEnd + bar.endText.map((t) => textNote('^', t)).join('') + bar.endDecos.join('');
  const cresc = bar.hairpin === 'cresc' ? ['!<(!', '!<)!'] : bar.hairpin === 'dim' ? ['!>(!', '!>)!'] : ['', ''];

  if (bar.custom != null) {
    // Real notation: user writes ABC with eighth note = 1.
    const firstChord = bar.beats.find((c) => c);
    const body = bar.custom || 'z8';
    return `[L:1/8]${startBits}${endBits}${firstChord ? chordText(firstChord) : ''}${body}[L:1/16]`;
  }

  if (bar.simile) {
    // One-bar repeat: invisible copies of this section's slashes (so the bar is the same
    // width as its neighbours), with anchors the renderer replaces by the 𝄎 sign.
    const ghost = barToAbc(parseBar(bar.rhythm || ''), meter, defaultRhythm, '', '', tr).replace(/!style=rhythm!B/g, 'x');
    const n = (ghost.match(/x/g) || []).length;
    const first = bar.beats.find((c) => c);
    let k = 0;
    return ghost.replace(/x/g, (m) => {
      k++;
      let pre = '';
      if (k === 1) pre = startBits + (first ? chordText(first) : '') + `"_${SIMILE_MARK}S"`;
      if (k === n) pre += endBits + `"_${SIMILE_MARK}E${n}"`;
      return pre + m;
    });
  }

  // Rhythm notation only when something really lands off the beat (a beat-1 push with no bar
  // before it just plays on 1, so that bar stays as slashes).
  const realPush = chords.some((c, b) => c && c.startsWith('^') && (b > 0 || opts.tiedIn));
  if ((realPush || opts.pushOut) && meter.sub === 2 && meter.beatLen === 4) return pushedBarToAbc(bar, chords, meter, chordText, startBits, endBits, cresc, opts);

  const rhythm = bar.rhythm || defaultRhythm || 'slashes';
  const notes = []; // {chord, len, beam}
  if (rhythm === 'whole') {
    // One slash: any later chords share its label.
    const all = chords.filter(Boolean);
    notes.push({ chord: all.length ? all.join('   ') : null, len: meter.barLen, sep: ' ' });
  } else {
    for (let b = 0; b < meter.beats; b++) {
      if (rhythm === 'eighths') {
        const n = meter.sub;
        const len = meter.beatLen / n;
        for (let s = 0; s < n; s++) {
          // Beam 2 beats together in simple meters with an even beat count (4/4 → 4+4).
          const groupEnd = meter.sub === 3 ? s === n - 1 : s === n - 1 && (meter.beats % 2 === 1 || b % 2 === 1);
          notes.push({ chord: s === 0 ? chords[b] : null, len, sep: groupEnd ? ' ' : '' });
        }
      } else if (rhythm === 'quarters') {
        notes.push({ chord: chords[b], len: meter.beatLen, sep: ' ' });
      } else {
        notes.push({ chord: chords[b], len: 0, sep: ' ' });
      }
    }
  }
  // Chord labels, and extra room after a label that would run into the next one.
  notes.forEach((n) => {
    n.label = n.chord ? chordText(n.chord) : '';
    n.ord = n.chord ? tr.ord - 1 : -1;
    n.space = 0;
  });
  notes.forEach((n, i) => {
    const pad = n.ord >= 0 ? tr.pads[n.ord] || 0 : 0;
    if (!pad) return;
    let end = i + 1;
    while (end < notes.length && !notes[end].chord) end++;
    // Spread the room over the gaps between this chord and the next one (or the barline).
    const gaps = end - i;
    for (let k = 0; k < pad; k++) notes[i + (k % gaps)].space++;
  });
  let s = '';
  notes.forEach((n, i) => {
    let pre = '';
    if (i === 0) pre += startBits + cresc[0];
    if (i < bar.accents) pre += '!>!';
    if (i === notes.length - 1) pre += endBits;
    let post = '';
    if (i === notes.length - 1 && cresc[1]) post = cresc[1];
    const room = n.space ? (n.sep ? ' ' : '') + Array(n.space).fill('y').join(n.sep ? ' ' : '') : '';
    s += `${pre}${n.label}${RHY}B${n.len}${post}${room}${n.sep}`;
  });
  return s.trim();
}

// A bar with pushed chords ("C ^F": F on the 'and' of 2) in rhythm notation:
// each chord's slash starts where the chord lands and is held (tied) to the next chord.
// Units are sixteenths; an eighth push = 2.
function pushedBarToAbc(bar, chords, meter, chordText, startBits, endBits, cresc, opts = {}) {
  const onsets = [];
  chords.forEach((c, b) => {
    if (!c) return;
    const pushed = c.startsWith('^');
    const name = pushed ? c.slice(1) : c;
    if (b === 0) {
      // A push onto beat 1 sounds in the bar before (tied over); here it just carries on.
      onsets.push({ pos: 0, chord: pushed && opts.tiedIn ? null : name });
      return;
    }
    onsets.push({ pos: b * meter.beatLen - (pushed ? 2 : 0), chord: name });
  });
  const lastEighth = meter.barLen - 2;
  if (opts.pushOut) {
    const clash = onsets.findIndex((o) => o.pos === lastEighth);
    if (clash >= 0) onsets.splice(clash, 1);
    onsets.push({ pos: lastEighth, chord: opts.pushOut });
  }
  onsets.sort((a, b) => a.pos - b.pos);
  if (!onsets.length || onsets[0].pos > 0) onsets.unshift({ pos: 0, chord: null });
  const end = meter.barLen;
  const half = meter.barLen / 2;
  const four = meter.barLen === 16; // half notes and dotted quarters only where they show the beat (4/4)
  const notes = [];
  onsets.forEach((o, i) => {
    const stop = i + 1 < onsets.length ? onsets[i + 1].pos : end;
    let p = o.pos;
    const pieces = [];
    while (p < stop) {
      const left = stop - p;
      let len;
      if (p === 0 && left >= end) len = end; // whole bar
      else if (four && (p === 0 || p === half) && left >= 8) len = 8; // half note on 1 or 3 (4/4)
      else if (four && (p === 0 || p === half) && left >= 6) len = 6; // dotted quarter on 1 or 3 (4/4)
      else if (p % 4 === 0 && left >= 4) len = 4; // quarter on the beat
      else if (p % 2 === 0 && left >= 2) len = 2; // eighth
      else len = 1;
      pieces.push(len);
      p += len;
    }
    pieces.forEach((len, k) => notes.push({ len, label: k === 0 && o.chord ? chordText(o.chord) : '', tie: k < pieces.length - 1 }));
  });
  return notes.map((n, i) => {
    let pre = '';
    if (i === 0) pre += startBits + cresc[0];
    if (i < bar.accents) pre += '!>!';
    if (i === notes.length - 1) pre += endBits;
    const tieOver = i === notes.length - 1 && opts.pushOut; // held over the barline into the next bar
    const post = (n.tie || tieOver ? '-' : '') + (i === notes.length - 1 && cresc[1] ? cresc[1] : '');
    return `${pre}${n.label}${RHY}B${n.len}${post}`;
  }).join(' ');
}

const KEY_INDEX = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
const NEW_KEY = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const NEW_KEY_MINOR = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

export const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B',
  'Cm', 'C#m', 'Dm', 'D#m', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

// Same spelling rules abcjs uses, so the label matches the printed key signature.
export function transposeKeyName(key, steps) {
  const m = /^([A-G][#b]?)(m?)$/.exec(key || 'C');
  if (!m) return key;
  const idx = (((KEY_INDEX[m[1]] ?? 0) + steps) % 12 + 12) % 12;
  return (m[2] ? NEW_KEY_MINOR[idx] : NEW_KEY[idx]) + m[2];
}

export const FONT_STYLES = {
  hand: {
    label: 'Handwritten',
    title: '"Chart Title" 30 bold',
    composer: '"Chart Hand" 15',
    parts: '"Chart Hand" 16',
    gchord: '"Chart Chord" 18',
    tempo: '"Chart Hand" 14',
    measure: '"Chart Hand" 11',
    text: { family: '"Chart Hand", sans-serif', size: 14, style: 'normal' },
  },
  clean: {
    label: 'Clean',
    title: 'Helvetica 26 bold',
    composer: 'Helvetica 13',
    parts: 'Helvetica 14 bold',
    gchord: 'Helvetica 16 bold',
    tempo: 'Helvetica 12',
    measure: 'Helvetica 10 italic',
    text: { family: 'Helvetica, Arial, sans-serif', size: 12, style: 'italic' },
  },
};

export const TUNINGS = {
  standard: { label: 'Standard (E A D G B E)', print: '' },
  dropD: { label: 'Drop D (D A D G B E)', print: 'Drop D tuning' },
  halfDown: { label: 'Half step down (E♭ A♭ D♭ G♭ B♭ E♭)', print: 'Tuning: ½ step down' },
  wholeDown: { label: 'Whole step down (D G C F A D)', print: 'Tuning: whole step down' },
  dropC: { label: 'Drop C (C G C F A D)', print: 'Drop C tuning' },
  dadgad: { label: 'DADGAD', print: 'Tuning: DADGAD' },
  openG: { label: 'Open G (D G D G B D)', print: 'Open G tuning (DGDGBD)' },
  openD: { label: 'Open D (D A D F♯ A D)', print: 'Open D tuning (DADF♯AD)' },
  openE: { label: 'Open E (E B E G♯ B E)', print: 'Open E tuning (EBEG♯BE)' },
  custom: { label: 'Other…', print: '' },
};

export function keyLabel(key) {
  const m = /^([A-G][#b]?)(m?)$/.exec(key || 'C');
  if (!m) return key;
  return prettyChord(m[1]) + (m[2] ? ' minor' : ' major');
}

// The line printed above the first system: "Key: G major · Capo 2 · Drop D tuning"
export function infoLine(song, steps = 0) {
  const bits = [];
  if (song.showKey !== false) bits.push('Key: ' + keyLabel(transposeKeyName(KEYS.includes(song.key) ? song.key : 'C', steps)));
  const capo = parseInt(song.capo, 10);
  if (capo > 0) bits.push(`Capo ${capo}`);
  const t = TUNINGS[song.tuning];
  if (song.tuning === 'custom' && song.tuningCustom) bits.push('Tuning: ' + song.tuningCustom.trim());
  else if (t && t.print) bits.push(t.print);
  return bits.join('   ·   ');
}

export const CHORD_SIZES = { small: { label: 'Small', px: 13 }, medium: { label: 'Medium', px: 15 }, large: { label: 'Large', px: 18 } };
const chordFont = (f, song) => f.gchord.replace(/\d+$/, String((CHORD_SIZES[song.chordSize] || CHORD_SIZES.medium).px));

function header(song, steps) {
  const f = FONT_STYLES[song.style] || FONT_STYLES.hand;
  const lines = [
    'X:1',
    `T:${abcText(song.title || 'Untitled')}`,
  ];
  if (song.composer) lines.push(`C:${abcText(song.composer)}`);
  lines.push(`M:${song.time || '4/4'}`, 'L:1/16');
  const tempo = parseInt(song.tempo, 10);
  const info = abcText(infoLine(song, steps));
  const label = info ? `"${info}${tempo > 0 ? '   ·   ' : ''}" ` : '';
  if (tempo > 0) {
    const meter = meterInfo(song.time);
    const beatNote = meter.beatLen === 6 ? '3/8' : meter.beatLen === 2 ? '1/8' : meter.beatLen === 8 ? '1/2' : '1/4';
    lines.push(`Q:${label}${beatNote}=${tempo}`);
  } else if (info) {
    lines.push(`Q:"${info}"`);
  }
  lines.push(
    '%%barnumbers 0',
    `%%titlefont ${f.title}`,
    `%%composerfont ${f.composer}`,
    `%%partsfont ${f.parts}`,
    `%%gchordfont ${chordFont(f, song)}`,
    `%%annotationfont ${chordFont(f, song)}`,
    `%%tempofont ${f.tempo}`,
    `%%measurefont ${f.measure}`,
    '%%partsbox 0',
  );
  return lines;
}

// Returns { abc, lineSections: [sectionIndex per music line], warnings }
// A repeat of another section ("Chorus again") plays the original's music;
// only its own "start on a new page" setting is kept.
export function resolveSection(song, sec) {
  if (!sec.linkTo) return sec;
  const src = (song.sections || []).find((x) => x.id === sec.linkTo && !x.linkTo);
  return src ? { ...src, id: sec.id, linkTo: sec.linkTo, pageBreak: !!sec.pageBreak } : sec;
}

// pads[i]: extra spacing after the i-th chord label (the renderer works these out).
export function songToAbc(song, steps = 0, pads = []) {
  const meter = meterInfo(song.time);
  const tr = { steps, key: transposeKeyName(KEYS.includes(song.key) ? song.key : 'C', steps), ord: 0, bar: 1, pads, style: song.chordStyle || 'short' };
  const out = header(song, steps);
  const key = KEYS.includes(song.key) ? song.key : 'C';
  out.push(`K:${key}`, 'V:1 stem=up');
  const lineSections = [];
  const warnings = [];
  const sections = (song.sections || []).map((s, idx) => ({ ...resolveSection(song, s), _idx: idx }))
    .filter((s) => splitBarsEx(s.bars).length || splitBarsEx(s.ending1).length || s.label);

  sections.forEach((sec, si) => {
    const isLast = si === sections.length - 1;
    const main = barsOf(sec.bars);
    const repeat = !!sec.repeat;
    const end1 = repeat ? barsOf(sec.ending1) : [];
    const end2 = repeat ? barsOf(sec.ending2) : [];
    if (!main.length && !end1.length) main.push(parseBar(''));
    [...main, ...end1, ...end2].forEach((b) => b.warnings.forEach((w) => warnings.push(`${sec.label || 'Section ' + (si + 1)}: “${w}” isn't a chord or keyword`)));

    // Build the flat list of bars with the barline that follows each.
    const items = main.map((b) => ({ bar: b, after: '|', before: '' }));
    const times = parseInt(sec.times, 10);
    const timesText = times > 2 ? `x${times}` : '';
    if (repeat) {
      if (end1.length) {
        const first = items.length;
        end1.forEach((b) => items.push({ bar: b, after: '|', before: '' }));
        items[first].before = '[1';
        items[items.length - 1].after = ':|';
        if (timesText) items[items.length - 1].extraEnd = `"_${TIMES_MARK}${timesText}"`;
        if (end2.length) {
          const second = items.length;
          end2.forEach((b) => items.push({ bar: b, after: '|', before: '' }));
          items[second].before = '[2';
        }
      } else {
        items[items.length - 1].after = ':|';
        if (timesText) items[items.length - 1].extraEnd = `"_${TIMES_MARK}${timesText}"`;
      }
    }
    // Pushes onto beat 1 ("| ^F"): the chord comes in on the last eighth of the bar before.
    const simpleTime = meter.sub === 2 && meter.beatLen === 4;
    items.forEach((it, k) => {
      const next = items[k + 1];
      if (!simpleTime || !next || next.before || it.bar.custom != null || it.bar.simile || next.bar.custom != null || next.bar.simile) return;
      const first = placeChords(next.bar.beats, meter.beats)[0];
      if (first && first.startsWith('^')) {
        it.pushOut = first.slice(1);
        next.tiedIn = true;
      }
    });

    // Inline repeat ends (":|" typed in the bars).
    items.forEach((it) => { if (it.bar.endRepeat && it.after === '|') it.after = ':|'; });
    const lastItem = items[items.length - 1];
    if (lastItem.after === '|') lastItem.after = isLast ? '|]' : '||';
    if (isLast && end2.length) lastItem.after = '|]';

    // Note under the first bar.
    if (sec.note) items[0].extraStart = textNote('_', sec.note);

    // Line breaks: chunk by bars-per-line, so every line keeps the 4-bar grid. A lone
    // 2nd ending starts the next line, unless the section asks to keep endings together.
    const per = Math.max(1, parseInt(sec.perLine, 10) || 4);
    const chunks = [];
    for (let i = 0; i < items.length; i += per) chunks.push(items.slice(i, i + per));
    if (sec.keepEndings && chunks.length > 1 && chunks[chunks.length - 1].length === 1 && chunks[chunks.length - 1][0].before === '[2') {
      chunks[chunks.length - 2].push(...chunks.pop());
    }

    // Inline repeat starts ("|:"): at a line start it opens the line, otherwise it joins the previous barline.
    chunks.forEach((chunk) => chunk.forEach((it, j) => {
      if (!it.bar.startRepeat) return;
      if (j === 0) { it.lineStart = true; return; }
      const prev = chunk[j - 1];
      prev.after = prev.after === ':|' ? '::' : '|:';
    }));

    if (sec.label) out.push(`P:${abcText(sec.label)}`);
    chunks.forEach((chunk, ci) => {
      let line = (ci === 0 && repeat) || chunk[0].lineStart ? '|:' : '';
      chunk.forEach((it) => {
        if (it.before) line += `${it.before} `;
        line += barToAbc(it.bar, meter, sec.rhythm, it.extraStart || '', it.extraEnd || '', tr, { pushOut: it.pushOut, tiedIn: it.tiedIn }) + ` ${it.after} `;
      });
      // Short line: pad with invisible bars so every bar on the chart is the same width.
      for (let k = chunk.length; k < per; k++) {
        const ghost = barToAbc(parseBar(''), meter, sec.rhythm, '', '', tr).replace(/!style=rhythm!B/g, 'x');
        line += `${k === chunk.length ? `"_${FILL_MARK}${per - chunk.length}"` : ''}${ghost} [|] `;
      }
      // Bar numbers count real bars only.
      out.push(`%%setbarnb ${tr.bar}`);
      tr.bar += chunk.length;
      out.push(line.trim());
      lineSections.push(sec._idx);
    });
  });

  if (!sections.length) {
    out.push(`${RHY}B0 ${RHY}B0 ${RHY}B0 ${RHY}B0 |]`);
    lineSections.push(-1);
  }
  return { abc: out.join('\n') + '\n', lineSections, warnings, chordCount: tr.ord };
}
