// Shorter ways to print a song whose sections repeat. What the person typed (the
// song in playing order) stays the master copy; these build a new section list
// from it each time the chart is drawn.
//
//   'full'     as typed
//   'form'     a FORM line in playing order, then each different part printed once
//   'compact'  back-to-back repeats become xN, and one D.C./D.S. (al Coda / al Fine)
//              jump is used when it saves real space. Never more than one jump.
import { resolveSection, splitBarsEx } from './abcgen.js';

export const LAYOUTS = {
  full: 'Written out',
  form: 'Form + sections',
  compact: 'Compact (D.S. & Coda)',
};

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const keyOf = (s) => JSON.stringify([norm(s.label).toLowerCase(), norm(s.bars), !!s.repeat, s.repeat ? norm(s.times) : '', s.repeat ? norm(s.ending1) : '', s.repeat ? norm(s.ending2) : '', s.rhythm || '', !!s.keepEndings]);
const barCount = (s) => splitBarsEx(s.bars).length + (s.repeat ? splitBarsEx(s.ending1).length + splitBarsEx(s.ending2).length : 0);
const copy = (s) => ({ ...s, linkTo: undefined, pageBreak: false });

// Rebuild a section's bar text from split bars (keeps the repeat signs).
const joinBars = (list) => list.map((b, i) => `${b.startRepeat ? '|: ' : i ? '| ' : ''}${b.text}${b.endRepeat ? ' :|' : ''}`)
  .join(' ').replace(/:\| \|: /g, ':|: ').replace(/:\| \| /g, ':| ');

// Split a section where an inline repeat starts or ends ("|: Am … Em C :| A | A"
// becomes the repeated part and an unlabelled "A | A"), and turn a section that is one
// inline repeat into an ordinary repeated section. Same music, easier to match up.
function normalise(sec) {
  if (sec.repeat) return [sec];
  const bars = splitBarsEx(sec.bars);
  if (!bars.some((b) => b.startRepeat || b.endRepeat)) return [sec];
  const pieces = [];
  let cur = [];
  bars.forEach((b, i) => {
    if (b.startRepeat && cur.length) { pieces.push(cur); cur = []; }
    cur.push(b);
    if (b.endRepeat && i < bars.length - 1) { pieces.push(cur); cur = []; }
  });
  if (cur.length) pieces.push(cur);
  return pieces.map((list, i) => {
    const out = { ...sec, label: i ? '' : sec.label, note: i ? '' : sec.note };
    const whole = list[0].startRepeat && list[list.length - 1].endRepeat && !list.slice(1).some((b) => b.startRepeat) && !list.slice(0, -1).some((b) => b.endRepeat);
    if (whole) {
      out.repeat = true; out.times = ''; out.ending1 = ''; out.ending2 = '';
      out.bars = joinBars(list.map((b) => ({ text: b.text })));
    } else {
      out.bars = joinBars(list);
    }
    return out;
  });
}

function playedSections(song) {
  return (song.sections || []).map((s) => copy(resolveSection(song, s)))
    .filter((s) => splitBarsEx(s.bars).length || splitBarsEx(s.ending1).length || s.label)
    .flatMap(normalise);
}

// Put a road-map word at the start of a section's first bar.
function addStart(sec, word) {
  sec.bars = sec.bars.replace(/^(\s*(?:\|:|:\|:|\|)?\s*)/, `$1${word} `);
}
// …or at the end of the last bar it plays.
function addEnd(sec, word) {
  const field = sec.repeat && norm(sec.ending2) ? 'ending2' : sec.repeat && norm(sec.ending1) ? 'ending1' : 'bars';
  sec[field] = (sec[field] || '').replace(/(\s*(?::\|:?|\|:|\|)?\s*)$/, ` ${word}$1`);
}

// The music of a section, ignoring how many times a plain repeat is played.
const hasEndings = (s) => s.repeat && (norm(s.ending1) || norm(s.ending2));
const musicKey = (s) => JSON.stringify([norm(s.bars), hasEndings(s) ? [norm(s.ending1), norm(s.ending2), norm(s.times)] : '', s.rhythm || '', !!s.keepEndings]);
const plays = (s) => (s.repeat && !hasEndings(s) ? Math.max(2, parseInt(s.times, 10) || 2) : 1);

function formLayout(song) {
  const secs = playedSections(song);
  const total = secs.reduce((a, s) => a + barCount(s), 0);
  const entries = new Map(); // label + music -> printed section
  const usedNames = new Map(); // name -> music key
  const printed = [];
  const order = [];
  let part = 'Start', pos = 0;
  secs.forEach((s) => {
    const label = norm(s.label);
    if (label) { part = label; pos = 0; } else pos++;
    let mk = musicKey(s);
    let id = (label ? label.toLowerCase() : '') + '§' + mk;
    const prev = entries.get(id);
    if (prev && !(Number.isInteger(plays(s) / prev.plays) && plays(s) >= prev.plays)) {
      // Played fewer (or an odd number of) times than the printed one: print it separately.
      mk += `#${plays(s)}`;
      id += `#${plays(s)}`;
    }
    let e = entries.get(id);
    if (!e) {
      let name = label || `${part} ${'bcdefghij'[Math.min(pos - 1, 8)] || 'b'}`;
      for (let n = 2; usedNames.has(name.toLowerCase()) && usedNames.get(name.toLowerCase()) !== mk; n++) name = `${label || `${part} ${'bcdefghij'[Math.min(pos - 1, 8)]}`} (${n})`;
      usedNames.set(name.toLowerCase(), mk);
      e = { name, plays: plays(s), sec: { ...s, label: name } };
      entries.set(id, e);
      printed.push(e.sec);
    }
    // How many times round the printed section this is ("Chorus ×2" = its repeat played twice over).
    const ratio = plays(s) / e.plays;
    const times = Number.isInteger(ratio) && ratio >= 1 ? ratio : 1;
    const last = order[order.length - 1];
    if (last && last.name === e.name) last.n += times;
    else order.push({ name: e.name, n: times, base: e.plays });
  });
  const printedBars = printed.reduce((a, s) => a + barCount(s), 0);
  return {
    sections: printed,
    // "Chorus (4 times)" counts times through the printed bars, so it reads the same
    // whether or not the printed section has its own repeat signs.
    formText: order.map((o) => (o.n > 1 ? `${o.name} (${o.n * o.base} times)` : o.name)).join('  –  '),
    note: printedBars < total
      ? `Form + sections: ${total} bars written out → ${printedBars} printed.${secs.some((x) => !norm(x.label)) ? ' Tip: name the unlabelled parts (e.g. Link, Tag) and the form line reads better.' : ''}`
      : 'Form + sections: nothing in this song repeats, so it prints as written, with the form at the top.',
  };
}

function compactLayout(song) {
  const secs = playedSections(song);
  const total = secs.reduce((a, s) => a + barCount(s), 0);

  // 1. Back-to-back identical sections become one repeated section (×N).
  const units = [];
  secs.forEach((s) => {
    const k = keyOf(s);
    const last = units[units.length - 1];
    const plain = !norm(s.ending1) && !norm(s.ending2) && !/:\||\|:/.test(s.bars);
    if (last && last.key === k && plain) { last.n++; return; }
    units.push({ sec: s, key: k, n: 1, plain });
  });
  const seq = units.map((u) => {
    if (u.n === 1) return { sec: u.sec, key: u.key };
    const each = u.sec.repeat ? Math.max(2, parseInt(u.sec.times, 10) || 2) : 1;
    const sec = { ...u.sec, repeat: true, times: String(each * u.n), ending1: '', ending2: '' };
    return { sec, key: keyOf(sec) };
  });
  const bars = seq.map((u) => barCount(u.sec));
  const sum = (a, b) => bars.slice(a, b).reduce((x, y) => x + y, 0);
  const n = seq.length;
  const collapsed = sum(0, n);

  // 2. The best single jump: play seq[0..j), go back to s (0 = D.C., else D.S. at the segno),
  //    play seq[s..k) again, then the coda seq[j+(k-s)..n) (or stop at Fine when there is none).
  let best = null;
  for (let j = 1; j < n; j++) {
    for (let s = 0; s < j; s++) {
      for (let k = s + 1; k <= j && j + (k - s) <= n; k++) {
        let same = true;
        for (let i = 0; i < k - s; i++) if (seq[j + i].key !== seq[s + i].key) { same = false; break; }
        if (!same) continue;
        const codaStart = j + (k - s);
        const printed = sum(0, j) + sum(codaStart, n);
        // Prefer fewer bars; on a tie, a D.C. (no segno) and a jump with no coda read easiest.
        const score = printed * 100 + (s > 0 ? 2 : 0) + (codaStart < n ? 1 : 0);
        if (!best || score < best.score) best = { j, s, k, codaStart, printed, score };
      }
    }
  }
  const saving = best ? collapsed - best.printed : 0;
  if (!best || saving < Math.max(6, collapsed * 0.15)) {
    return {
      sections: seq.map((u) => u.sec),
      note: collapsed < total
        ? `Compact: ${total} bars → ${collapsed} (repeats joined up). No single D.C./D.S. jump fits this song’s form; Form + sections may print shorter.`
        : 'Compact: no D.C./D.S. jump fits this song’s form, so it prints as written. Try Form + sections.',
    };
  }

  const { j, s, k, codaStart } = best;
  const out = seq.slice(0, j).map((u) => ({ ...u.sec }));
  const coda = seq.slice(codaStart).map((u) => ({ ...u.sec }));
  const hasCoda = coda.length > 0;
  const word = (s === 0 ? 'dc' : 'ds') + (hasCoda ? '-coda' : '-fine');
  const replayRepeats = seq.slice(s, k).some((u) => u.sec.repeat || /:\||\|:/.test(u.sec.bars));
  if (s > 0) addStart(out[s], 'segno');
  if (hasCoda) addEnd(out[k - 1], 'to-coda');
  else addEnd(out[k - 1], 'fine');
  addEnd(out[j - 1], replayRepeats ? `${word} "with repeats"` : word);
  if (hasCoda) {
    addStart(coda[0], 'coda');
    coda[0].label = coda[0].label ? `Coda – ${coda[0].label}` : 'Coda';
  }
  const jump = `${s === 0 ? 'D.C.' : 'D.S.'} al ${hasCoda ? 'Coda' : 'Fine'}`;
  return {
    sections: [...out, ...coda],
    note: `Compact: ${total} bars → ${best.printed}, using ${jump}${replayRepeats ? ' (with repeats)' : ''}.`,
  };
}

// The song to draw for the chosen layout, plus a short note about what was done.
export function arrangeSong(song) {
  const mode = song.layout || 'full';
  if (mode === 'full' || song.useRaw) return { song, note: '' };
  try {
    const r = mode === 'form' ? formLayout(song) : compactLayout(song);
    return { song: { ...song, sections: r.sections, formText: r.formText || '' }, note: r.note };
  } catch (e) {
    console.warn('layout', e);
    return { song, note: '' };
  }
}

