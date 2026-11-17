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

const CHORD_RE = /^(N\.?C\.?|[A-G](?:#|b|♯|♭)?[A-Za-z0-9+°ø#♯♭()\-^]*(?:\/[A-G](?:#|b|♯|♭)?)?)$/;

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
  const bar = { simile: false, beats: [], accents: 0, hairpin: null, above: [], startDecos: [], endDecos: [], endText: [], rhythm: null, custom: null, warnings: [] };
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
    } else if (CHORD_RE.test(tok)) {
      bar.beats.push(tok);
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


function barToAbc(bar, meter, defaultRhythm, extraStart, extraEnd, tr) {
  const chordText = (c) => `"^${c.split(/\s+/).map((x) => prettyChord(transposeChord(x, tr.steps, tr.key))).join('  ')}"`;
  const chords = placeChords(bar.beats, meter.beats);
  const chordAt = (i) => (chords[i] ? chordText(chords[i]) : '');
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
    // One-bar repeat: invisible beats, with anchors the renderer replaces by the 𝄎 sign.
    const first = bar.beats.find((c) => c);
    const parts = [];
    for (let b = 0; b < meter.beats; b++) {
      let pre = '';
      if (b === 0) pre = startBits + (first ? chordText(first) : '') + `"_${SIMILE_MARK}S"`;
      if (b === meter.beats - 1) pre += endBits + `"_${SIMILE_MARK}E"`;
      parts.push(`${pre}x${meter.beatLen}`);
    }
    return parts.join(' ');
  }

  const rhythm = bar.rhythm || defaultRhythm || 'slashes';
  const notes = []; // {chord, len, beam}
  if (rhythm === 'whole') {
    notes.push({ chord: chordAt(0), len: meter.barLen, sep: ' ' });
    // Later chords in a one-slash bar would be lost: attach them as text.
    const later = chords.slice(1).filter(Boolean);
    if (later.length) notes[0].chord += `"^${later.map((c) => abcText(prettyChord(transposeChord(c, tr.steps, tr.key)))).join('   ')}"`;
  } else {
    for (let b = 0; b < meter.beats; b++) {
      if (rhythm === 'eighths') {
        const n = meter.sub;
        const len = meter.beatLen / n;
        for (let s = 0; s < n; s++) {
          // Beam 2 beats together in simple meters with an even beat count (4/4 → 4+4).
          const groupEnd = meter.sub === 3 ? s === n - 1 : s === n - 1 && (meter.beats % 2 === 1 || b % 2 === 1);
          notes.push({ chord: s === 0 ? chordAt(b) : '', len, sep: groupEnd ? ' ' : '' });
        }
      } else if (rhythm === 'quarters') {
        notes.push({ chord: chordAt(b), len: meter.beatLen, sep: ' ' });
      } else {
        notes.push({ chord: chordAt(b), len: 0, sep: ' ' });
      }
    }
  }
  let s = '';
  notes.forEach((n, i) => {
    let pre = '';
    if (i === 0) pre += startBits + cresc[0];
    if (i < bar.accents) pre += '!>!';
    if (i === notes.length - 1) pre += endBits;
    let post = '';
    if (i === notes.length - 1 && cresc[1]) post = cresc[1];
    s += `${pre}${n.chord}${RHY}B${n.len}${post}${n.sep}`;
  });
  return s.trim();
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
    `%%gchordfont ${f.gchord}`,
    `%%annotationfont ${f.gchord}`,
    `%%tempofont ${f.tempo}`,
    `%%measurefont ${f.measure}`,
    '%%partsbox 0',
  );
  return lines;
}

// Returns { abc, lineSections: [sectionIndex per music line], warnings }
export function songToAbc(song, steps = 0) {
  const meter = meterInfo(song.time);
  const tr = { steps, key: transposeKeyName(KEYS.includes(song.key) ? song.key : 'C', steps) };
  const out = header(song, steps);
  const key = KEYS.includes(song.key) ? song.key : 'C';
  out.push(`K:${key}`, 'V:1 stem=up');
  const lineSections = [];
  const warnings = [];
  const sections = (song.sections || []).filter((s) => splitBarsEx(s.bars).length || splitBarsEx(s.ending1).length || s.label);

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
        if (timesText) items[items.length - 1].extraEnd = textNote('^', timesText);
        if (end2.length) {
          const second = items.length;
          end2.forEach((b) => items.push({ bar: b, after: '|', before: '' }));
          items[second].before = '[2';
        }
      } else {
        items[items.length - 1].after = ':|';
        if (timesText) items[items.length - 1].extraEnd = textNote('^', timesText);
      }
    }
    // Inline repeat ends (":|" typed in the bars).
    items.forEach((it) => { if (it.bar.endRepeat && it.after === '|') it.after = ':|'; });
    const lastItem = items[items.length - 1];
    if (lastItem.after === '|') lastItem.after = isLast ? '|]' : '||';
    if (isLast && end2.length) lastItem.after = '|]';

    // Note under the first bar.
    if (sec.note) items[0].extraStart = textNote('_', sec.note);

    // Line breaks: chunk by bars-per-line, never leave a single bar alone.
    const per = Math.max(1, parseInt(sec.perLine, 10) || 4);
    const chunks = [];
    for (let i = 0; i < items.length; i += per) chunks.push(items.slice(i, i + per));
    if (chunks.length > 1 && chunks[chunks.length - 1].length === 1) {
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
        line += barToAbc(it.bar, meter, sec.rhythm, it.extraStart || '', it.extraEnd || '', tr) + ` ${it.after} `;
      });
      out.push(line.trim());
      lineSections.push(song.sections.indexOf(sec));
    });
  });

  if (!sections.length) {
    out.push(`${RHY}B0 ${RHY}B0 ${RHY}B0 ${RHY}B0 |]`);
    lineSections.push(-1);
  }
  return { abc: out.join('\n') + '\n', lineSections, warnings };
}
