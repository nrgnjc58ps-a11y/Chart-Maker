// Song library + gigs, saved in this device's browser storage.
const KEY = 'chartmaker.v1';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function newSection(label = '') {
  return { id: uid(), label, bars: '', rhythm: 'slashes', perLine: 4, repeat: false, times: '', ending1: '', ending2: '', note: '', pageBreak: false };
}

export function newSong() {
  return {
    id: uid(), title: '', composer: '', tempo: '', time: '4/4', key: 'C', transpose: 0, style: 'hand',
    sections: [newSection('Intro'), newSection('Verse'), newSection('Chorus')],
    useRaw: false, raw: '', updated: Date.now(),
  };
}

export function exampleSong() {
  const s = (o) => ({ ...newSection(), ...o });
  return {
    id: uid(), title: 'Shape of a Heart', composer: 'J Browne', tempo: '110', time: '4/4', key: 'E', transpose: 0, style: 'hand',
    useRaw: false, raw: '', updated: Date.now(),
    sections: [
      s({ label: 'Intro', rhythm: 'eighths', bars: 'E >> | | C#m >> | | A >> | B/A | A >> | B/A', note: 'Bass plays accents' }),
      s({ label: 'Verse/Bridge', repeat: true, times: '3', bars: 'E | | C#m | | A | B/A | A | B/A', note: 'Cont. 8ths feel/ and accents' }),
      s({ label: '', bars: 'A | B/A | A | B <' }),
      s({ label: 'Chorus', repeat: true, bars: 'E | | C#m | | A | B/A | A | B' }),
      s({ label: 'Verse', repeat: true, bars: 'E | | C#m | | A | B/A | A', ending1: 'B/A', ending2: 'B <', note: 'Cont. 8ths feel/ and accents' }),
      s({ label: 'Chorus', pageBreak: true, bars: 'segno E | | C#m | | A | B/A | A | B' }),
    ],
  };
}

function defaultPaper() {
  const lang = (navigator.language || 'en-US').toLowerCase();
  return /^(en-us|en-ca|es-mx|fr-ca)$/.test(lang) ? 'letter' : 'a4';
}

function blank() {
  return { version: 1, songs: [exampleSong()], gigs: [], prefs: { paper: defaultPaper() } };
}

let state;
export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? JSON.parse(raw) : blank();
  } catch {
    state = blank();
  }
  state.songs ||= [];
  state.gigs ||= [];
  state.prefs ||= { paper: defaultPaper() };
  return state;
}

let saveTimer;
export function save(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn('Save failed', e); }
  };
  if (now) write(); else saveTimer = setTimeout(write, 300);
}

export const getState = () => state;
export const findSong = (id) => state.songs.find((s) => s.id === id);
export const findGig = (id) => state.gigs.find((g) => g.id === id);

export function exportBackup() {
  return JSON.stringify({ app: 'chart-maker', exported: new Date().toISOString(), ...state }, null, 1);
}

// Merge a backup (or a single shared song) into the library. Returns counts.
export function importBackup(text) {
  const data = JSON.parse(text);
  let songs = 0, gigs = 0;
  const incomingSongs = data.songs || (data.song ? [data.song] : []);
  for (const s of incomingSongs) {
    if (!s || !Array.isArray(s.sections)) continue;
    const existing = state.songs.findIndex((x) => x.id === s.id);
    if (existing >= 0) state.songs[existing] = s; else state.songs.push(s);
    songs++;
  }
  for (const g of data.gigs || []) {
    if (!g || !Array.isArray(g.items)) continue;
    const existing = state.gigs.findIndex((x) => x.id === g.id);
    if (existing >= 0) state.gigs[existing] = g; else state.gigs.push(g);
    gigs++;
  }
  save(true);
  return { songs, gigs };
}
