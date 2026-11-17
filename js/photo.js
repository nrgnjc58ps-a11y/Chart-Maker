// "From a photo": read a picture of an existing chart and turn it into a Chart Maker song.
// Works only inside the claude.ai Artifact, where the page may ask Claude (the `sample`
// capability) to look at images. Everywhere else photoImportAvailable() stays false.
import { newSong, newSection } from './store.js';
import { KEYS } from './abcgen.js';

let samplePromise = null;
let limits = null;

// Resolves true when this view can send images to Claude.
export function photoImportAvailable() {
  if (!samplePromise) {
    samplePromise = (async () => {
      try {
        if (!window.claude || typeof window.claude.use !== 'function') return null;
        const sample = await window.claude.use('sample');
        if (!sample) return null;
        limits = await sample.limits().catch(() => null);
        return limits && limits.images ? sample : null;
      } catch { return null; }
    })();
  }
  return samplePromise.then(Boolean);
}

export const imageTypes = () => [...(limits?.images?.mediaTypes || ['image/jpeg', 'image/png', 'image/webp']), 'application/pdf', '.pdf'].join(',');

// ---------- PDFs: each page becomes a picture (pdf.js, loaded only when needed) ----------
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      if (window.pdfjsLib) return resolve(window.pdfjsLib);
      const s = document.createElement('script');
      s.src = 'vendor/pdf.min.js';
      s.onload = () => {
        const lib = window.pdfjsLib;
        if (!lib) return reject(new Error('The PDF reader didn’t load.'));
        lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
        resolve(lib);
      };
      s.onerror = () => { pdfjsPromise = null; reject(new Error('The PDF reader didn’t load.')); };
      document.head.appendChild(s);
    });
  }
  return pdfjsPromise;
}

async function pdfToImages(file, maxPages) {
  const lib = await loadPdfJs();
  let doc;
  try {
    doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  } catch (e) {
    throw new Error(e && e.name === 'PasswordException' ? 'That PDF is password protected.' : 'That PDF couldn’t be opened.');
  }
  const images = [];
  let text = '';
  const pages = Math.min(doc.numPages, maxPages);
  for (let n = 1; n <= pages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 1800 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    images.push(await new Promise((r) => canvas.toBlob(r, 'image/png')));
    try {
      const tc = await page.getTextContent();
      text += tc.items.map((i) => i.str).join(' ') + '\n';
    } catch { /* scanned PDFs have no text */ }
  }
  doc.destroy();
  return { images: images.filter(Boolean), text, skipped: doc.numPages - pages };
}

// Photos pass straight through; PDFs are turned into page pictures.
// Returns {images, text (any text found in PDFs), skipped (pages left out)}.
export async function prepareFiles(files) {
  const max = maxImages();
  const images = [];
  let text = '', skipped = 0;
  for (const f of files) {
    const room = max - images.length;
    if (room <= 0) { skipped++; continue; }
    if (isPdf(f)) {
      const r = await pdfToImages(f, room);
      images.push(...r.images);
      text += r.text;
      skipped += r.skipped;
    } else {
      images.push(f);
    }
  }
  return { images, text: text.replace(/[ \t]+/g, ' ').trim(), skipped };
}
export const maxImages = () => limits?.images?.maxCount || 1;

const PROMPT = `You are reading a photo or screenshot of a guitarist's chord chart (a gig chart: slash notation, chord symbols, repeat signs, endings, road-map signs).
The images are the pages of ONE song, in order. Transcribe it exactly into the JSON format below. Copy what is written; do not add, guess or "improve" chords.

Reply with ONLY this JSON object:
{
  "title": "song title or empty",
  "composer": "artist/composer or empty",
  "tempo": "bpm number if written, else empty",
  "time": "time signature, e.g. 4/4, 3/4, 6/8, 12/8",
  "key": "key, one of ${KEYS.join(' ')}. If not written, work it out from the chords",
  "style": "style or feel text if written (e.g. Disco, Swing), else empty",
  "sections": [
    { "label": "Intro", "bars": "B | % | % | %", "repeat": true, "times": "", "ending1": "", "ending2": "", "note": "", "perLine": 4 }
  ],
  "unsure": ["short notes on anything you could not read clearly, with the section and bar"]
}

How to write "bars" (one section; bars separated by " | "):
- Chords: plain text. Minor = m (E- or Em -> Em), major 7 = maj7 (CΔ or CΔ7 -> Cmaj7), half-diminished = m7b5 (ø), diminished = dim or dim7 (°), augmented = aug (+), sus4, sus2, add9, 6, 9, 11, 13, b9, #9, #11, b13, slash bass as C/E. Sharps # and flats b.
- Two or more chords in one bar: space between them ("Em C"). Use "." for a beat held without a chord when the beat position is clear ("A . . B" = B on beat 4).
- A bar of slashes with no chord written = an empty bar (nothing between the bar lines) - the previous chord carries on.
- One-bar repeat sign (the % / ./. symbol) = "%".
- Repeat signs inside a section: "|:" before the first bar and ":|" after the last bar of the repeated part.
- If the WHOLE section is repeated, set "repeat": true instead and leave the repeat signs out of "bars". "times": "3" for x3 etc.
- 1st/2nd endings: only with "repeat": true. Put the bars under the 1st ending bracket in "ending1" and under the 2nd in "ending2" (each like "Em | B"); do not repeat them in "bars".
- Road map words go inside the bar, after the chord: segno, coda, fine, dc, ds, ds-coda, dc-fine, dc-coda, to-coda. Example: "A | dc".
- Accents over the first slashes: ">" per accented slash ("E >>"). Crescendo hairpin "<", diminuendo "dim". Fermata: "fermata".
- A chord pushed an eighth early (anticipation, tied): put ^ before the chord ("C ^F", or "| ^F" when it lands just before beat 1).
- Short text written above a bar: in double quotes, e.g. "\\"Band out\\"". Longer instructions for a section go in "note".
- N.C. = no chord.

Sections:
- Start a new section at every rehearsal mark / section label, and also where a repeated block with endings starts.
- Expand label abbreviations: In/Int -> Intro, V -> Verse, PC/Pre -> Pre-Chorus, C/Ch -> Chorus, B/Br -> Bridge, Sol -> Solo, Inst -> Instrumental, Out/O -> Outro. A continuation with no label: "".
- "perLine": how many bars per line the original shows for that section (usually 4).
- Chord-symbol fonts often look like E_ or A_ for Em / Am: the dash or low line after the root means minor.

If something is unreadable, write your best reading and say so in "unsure". If the image is not a chord chart, reply {"error": "why"}.`;

const str = (v, max = 400) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();

// Turn Claude's reply into a song the rest of the app understands.
export function songFromReading(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('That reply wasn’t a chart.');
  if (data.error) throw new Error(str(data.error));
  const song = newSong();
  song.title = str(data.title, 120);
  song.composer = str(data.composer, 120);
  song.tempo = str(data.tempo, 20).replace(/[^\d.]/g, '');
  const time = str(data.time, 6);
  song.time = /^\d{1,2}\/\d{1,2}$/.test(time) ? time : '4/4';
  const key = str(data.key, 4).replace('♯', '#').replace('♭', 'b');
  song.key = KEYS.includes(key) ? key : KEYS.find((k) => k.toLowerCase() === key.toLowerCase()) || 'C';
  const secs = Array.isArray(data.sections) ? data.sections : [];
  song.sections = secs.slice(0, 60).map((s) => {
    const sec = newSection(str(s && s.label, 40));
    sec.bars = str(s && s.bars, 4000);
    sec.repeat = !!(s && s.repeat);
    sec.times = str(s && s.times, 4).replace(/[^\d]/g, '');
    sec.ending1 = sec.repeat ? str(s && s.ending1, 1000) : '';
    sec.ending2 = sec.repeat ? str(s && s.ending2, 1000) : '';
    sec.note = str(s && s.note, 300);
    const per = parseInt(s && s.perLine, 10);
    sec.perLine = per >= 1 && per <= 8 ? per : 4;
    return sec;
  }).filter((s) => s.label || s.bars || s.ending1);
  if (!song.sections.length) throw new Error('No bars could be read from that picture.');
  const style = str(data.style, 60);
  if (style) song.sections[0].note = song.sections[0].note ? `${style}. ${song.sections[0].note}` : style;
  const unsure = (Array.isArray(data.unsure) ? data.unsure : []).map((u) => str(u, 300)).filter(Boolean).slice(0, 20);
  return { song, unsure };
}

// Ask Claude to read the picture(s). Rejects with {code, message}.
export async function readChartImages(images, signal, pdfText = '') {
  const sample = await samplePromise;
  if (!sample) throw { code: 'images_unavailable', message: 'Not available here.' };
  const hint = pdfText ? `\n\nThe pages came from a PDF. Its text layer reads as below. It can help with exact chord spellings and titles, but its order and positions are unreliable, so follow the pictures for the layout:\n${pdfText.slice(0, 6000)}` : '';
  const data = await sample.json(PROMPT + hint, { images: images.slice(0, maxImages()), modelTier: 'complex', signal });
  return songFromReading(data);
}

export function errorText(e) {
  switch (e && e.code) {
    case 'not_granted': return 'Claude wasn’t allowed to read the picture. You can allow it next time you try.';
    case 'rate_limited': return 'Too many requests just now. Try again in a minute.';
    case 'image_rejected': return 'That picture couldn’t be used. Try a JPEG or PNG screenshot.';
    case 'images_unavailable': case 'sampling_disabled': case 'capability_disabled': return 'Reading pictures isn’t available in this view.';
    case 'session_expired': return 'Please sign in to Claude again.';
    case 'invalid_json': case 'empty_completion': return 'The chart couldn’t be read. Try a sharper or closer picture.';
    case 'refused': return 'Claude couldn’t read that picture.';
    default: return (e && !e.code && e.message) || 'Something went wrong reading the picture. Try again.';
  }
}
