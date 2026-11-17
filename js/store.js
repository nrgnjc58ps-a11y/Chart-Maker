// Song library + gigs.
// Two places to keep them:
//  - "local": this browser's storage (the normal hosted app, e.g. GitHub Pages)
//  - "account": the viewer's private storage when the app runs as a claude.ai Artifact
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
  return { version: 1, songs: [], gigs: [], prefs: { paper: defaultPaper() } };
}

let state;
let mode = 'local';
let coll = null; // account collection
const written = new Map(); // doc id -> JSON last written, so only changes are sent

export const storageMode = () => mode;
export const inArtifact = () => !!(window.claude && typeof window.claude.use === 'function');

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

export async function load() {
  if (inArtifact()) {
    try {
      const pair = await withTimeout(Promise.all([window.claude.use('db'), window.claude.use('user')]), 10000);
      const [db, user] = pair || [];
      if (db && user) {
        const id = await user.id();
        coll = db.collection('data/users/' + id);
        const snap = await withTimeout(coll.get(), 10000);
        if (snap) {
          mode = 'account';
          state = blank();
          for (const d of snap.docs) {
            const body = d.data();
            if (!body || typeof body.json !== 'string') continue;
            written.set(d.id, body.json);
            const value = JSON.parse(body.json);
            if (body.kind === 'song') state.songs.push(value);
            else if (body.kind === 'gig') state.gigs.push(value);
            else if (body.kind === 'prefs') state.prefs = value;
          }
          return state;
        }
      }
    } catch (e) {
      console.warn('Account storage unavailable', e);
    }
  }
  mode = 'local';
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

let onSaveError = () => {};
export const setSaveErrorHandler = (fn) => { onSaveError = fn; };

async function writeAccount() {
  const docs = new Map();
  state.songs.forEach((x) => docs.set('song_' + x.id, { kind: 'song', json: JSON.stringify(x) }));
  state.gigs.forEach((x) => docs.set('gig_' + x.id, { kind: 'gig', json: JSON.stringify(x) }));
  docs.set('prefs', { kind: 'prefs', json: JSON.stringify(state.prefs) });
  for (const [id, body] of docs) {
    if (written.get(id) === body.json) continue;
    try { await coll.doc(id).set(body); written.set(id, body.json); } catch (e) { console.warn('Save failed', id, e); onSaveError(e); }
  }
  for (const id of [...written.keys()]) {
    if (docs.has(id)) continue;
    try { await coll.doc(id).delete(); written.delete(id); } catch (e) { console.warn('Delete failed', id, e); }
  }
}

let saveTimer;
let saving = Promise.resolve();
export function save(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    if (mode === 'account') {
      saving = saving.then(writeAccount);
      return;
    }
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn('Save failed', e); onSaveError(e); }
  };
  if (now) write(); else saveTimer = setTimeout(write, mode === 'account' ? 800 : 300);
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
