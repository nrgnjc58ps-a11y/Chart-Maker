import * as store from './store.js';
import { RHYTHMS, KEYS, FONT_STYLES, transposeKeyName as keyName, prettyChord, songToAbc } from './abcgen.js';
const transposeKeyName = (k, n) => prettyChord(keyName(k, n));
import { renderSong, renderSetlist, pagesToPdf, loadFonts, PAPER } from './render.js';
import { initPalette, refreshPalette, keyboardHidden } from './palette.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const SECTION_NAMES = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Solo', 'Interlude', 'Instrumental', 'Middle 8', 'Breakdown', 'Tag', 'Outro', 'Coda', 'Ending'];
const TIMES = ['4/4', '3/4', '2/4', '6/8', '12/8', '5/4', '7/8', '2/2'];
const NO_AUTO = 'autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"';

let state;
let previewTimer;

// ---------- helpers ----------
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function topbar({ title = 'Chart Maker', left = '', right = '' }) {
  $('#top-title').textContent = title;
  $('#top-left').innerHTML = left;
  $('#top-right').innerHTML = right;
  document.title = title === 'Chart Maker' ? 'Chart Maker' : `${title} · Chart Maker`;
}

function openModal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  return m.firstElementChild;
}
function closeModal() {
  const m = $('#modal');
  m.hidden = true;
  m.innerHTML = '';
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

function askConfirm(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const sheet = openModal(`<h3>${esc(message)}</h3><div class="actions"><button class="btn primary danger-fill" data-c="ok">${esc(okLabel)}</button><button class="btn" data-c="no">Cancel</button></div>`);
    sheet.addEventListener('click', (e) => {
      const c = e.target.dataset.c;
      if (!c) return;
      closeModal();
      resolve(c === 'ok');
    });
  });
}

// Hand a file to the person: Artifact save prompt, iOS share sheet, or a download.
async function saveFile(blob, filename, { preferShare = true } = {}) {
  if (ARTIFACT) {
    const dl = await window.claude.use('downloads');
    if (!dl) { toast('Saving files isn’t available in this view.'); return false; }
    try { await dl.save({ filename, data: blob }); return true; } catch (err) {
      if (err && err.code !== 'declined') toast('Couldn’t save the file here.');
      return false;
    }
  }
  const file = new File([blob], filename, { type: blob.type });
  if (preferShare && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; } catch (err) { if (err.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return true;
}

function stepsLabel(n) {
  return n === 0 ? 'Original key' : `${n > 0 ? '+' : '−'}${Math.abs(n)} semitone${Math.abs(n) === 1 ? '' : 's'}`;
}
function wrapSteps(n) {
  // keep between -6 and +6 (same key either way)
  n = ((n % 12) + 12) % 12;
  return n > 6 ? n - 12 : n;
}
function fileSafe(s) {
  return (s || 'chart').replace(/[^\w\-# ]+/g, '').trim().replace(/\s+/g, ' ') || 'chart';
}

// ---------- routing ----------
// Inside a claude.ai Artifact only plain #names reach the address bar, so the
// app keeps its own current path there; elsewhere the path lives in location.hash.
const ARTIFACT = store.inArtifact();
let currentPath = ARTIFACT ? '/' : location.hash.replace(/^#/, '') || '/';
function navigate(path) {
  if (ARTIFACT) { currentPath = path; route(); }
  else location.hash = '#' + path;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#/"]');
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute('href').slice(1));
});
function route() {
  clearTimeout(previewTimer);
  if (!ARTIFACT) currentPath = location.hash.replace(/^#/, '') || '/';
  const parts = (currentPath.replace(/^\/?/, '') || '').split('/');
  window.scrollTo(0, 0);
  if (parts[0] === 'song' && store.findSong(parts[1])) return viewSong(store.findSong(parts[1]));
  if (parts[0] === 'gig' && store.findGig(parts[1])) return viewGig(store.findGig(parts[1]));
  if (parts[0] === 'gigs') return viewGigs();
  return viewSongs();
}
if (!ARTIFACT) window.addEventListener('hashchange', route);

// ---------- home: songs ----------
function homeTabs(active) {
  return `<nav class="tabs"><a href="#/" class="${active === 'songs' ? 'on' : ''}">Songs (${state.songs.length})</a><a href="#/gigs" class="${active === 'gigs' ? 'on' : ''}">Gigs (${state.gigs.length})</a></nav>`;
}

function viewSongs(filter = '') {
  topbar({ right: '<button class="tbtn primary" data-act="new-song">+ New song</button>' });
  const songs = [...state.songs].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  app.innerHTML = `
    ${homeTabs('songs')}
    <div class="card">
      <input type="search" id="song-search" placeholder="Search songs" value="${esc(filter)}" ${NO_AUTO}>
      <ul class="list" id="song-list" style="margin-top:8px"></ul>
    </div>
    ${settingsCard()}`;
  const list = $('#song-list');
  const draw = (q) => {
    const ql = q.trim().toLowerCase();
    const shown = songs.filter((s) => !ql || `${s.title} ${s.composer}`.toLowerCase().includes(ql));
    list.innerHTML = shown.length ? shown.map((s) => `
      <li><a class="list-item" href="#/song/${s.id}">
        <div class="grow"><div class="title">${esc(s.title || 'Untitled')}</div><div class="meta">${esc(s.composer || '')}${s.tempo ? ` · ♩=${esc(s.tempo)}` : ''}</div></div>
        <span class="pill">${esc(transposeKeyName(s.key, s.transpose || 0))}</span>
      </a></li>`).join('') : (state.songs.length ? '<li class="empty">No songs match.</li>' : `<li class="empty">No songs yet. Tap “+ New song”, or start from an example chart.<br><button class="btn" data-act="add-example" style="margin-top:10px">Add example: Shape of a Heart</button></li>`);
  };
  draw(filter);
  $('#song-search').addEventListener('input', (e) => draw(e.target.value));
  bindSettings();
}

function settingsCard() {
  return `
    <div class="card">
      <h2>Settings &amp; backup</h2>
      <div class="row">
        <label class="field">Paper size
          <select id="paper">${Object.entries(PAPER).map(([k, p]) => `<option value="${k}" ${state.prefs.paper === k ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
        </label>
      </div>
      <p class="small muted">${store.storageMode() === 'account'
        ? 'Your songs are saved privately to your Claude account, so they’re here whenever you open this page. A backup file is still a good idea.'
        : 'Your songs are saved on this device only. Save a backup file now and then (to Files or iCloud Drive), especially before clearing Safari data.'}</p>
      <div class="row">
        <button class="btn" data-act="backup">Save backup file</button>
        <label class="btn">Restore backup<input type="file" id="restore" accept=".json,application/json" hidden></label>
      </div>
    </div>`;
}

function bindSettings() {
  $('#paper')?.addEventListener('change', (e) => { state.prefs.paper = e.target.value; store.save(); toast(`Paper: ${PAPER[e.target.value].label}`); });
  $('#restore')?.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = store.importBackup(await f.text());
      toast(`Restored ${r.songs} song${r.songs === 1 ? '' : 's'} and ${r.gigs} gig${r.gigs === 1 ? '' : 's'}`);
      route();
    } catch {
      toast('That file isn’t a Chart Maker backup.');
    }
  });
}

// ---------- song editor ----------
function viewSong(song) {
  const isWide = () => window.matchMedia('(min-width: 900px)').matches;
  topbar({
    title: song.title || 'New song',
    left: '<a class="tbtn" href="#/">‹ Songs</a>',
    right: '<button class="tbtn" data-act="song-menu" aria-label="More">•••</button><button class="tbtn primary" data-act="song-pdf">PDF</button>',
  });
  app.innerHTML = `
    <div class="editor" data-view="${sessionStorageGet('view') || 'edit'}">
      <div class="mobile-switch"><div class="tabs"><button data-view="edit">Edit</button><button data-view="preview">Preview</button></div></div>
      <section class="pane-edit" id="pane-edit"></section>
      <section class="pane-preview">
        <div class="preview-bar"><span id="preview-info" class="muted small grow"></span>${ARTIFACT ? '' : '<button class="btn small" data-act="song-print">Print</button>'}</div>
        <div class="pages" id="pages"></div>
      </section>
    </div>`;
  const editor = $('.editor');
  const setView = (v) => {
    editor.dataset.view = v;
    sessionStorageSet('view', v);
    $$('.mobile-switch button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    if (v === 'preview') renderPreview(song);
  };
  $$('.mobile-switch button').forEach((b) => b.addEventListener('click', () => { setView(b.dataset.view); window.scrollTo(0, 0); }));
  setView(editor.dataset.view);
  drawEditPane(song);
  renderPreview(song);
  app.onSong = song;
  void isWide;
}

function sessionStorageGet(k) { try { return sessionStorage.getItem('cm.' + k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem('cm.' + k, v); } catch { /* ignore */ } }

function drawEditPane(song) {
  const pane = $('#pane-edit');
  const t = song.transpose || 0;
  pane.innerHTML = `
    <div id="warnings"></div>
    <div class="card">
      <h2>Song</h2>
      <div class="row"><label class="field" style="flex:2">Title<input type="text" data-song="title" value="${esc(song.title)}" placeholder="Song title" autocomplete="off"></label></div>
      <div class="row" style="margin-top:8px"><label class="field">Artist / writer<input type="text" data-song="composer" value="${esc(song.composer)}" autocomplete="off"></label></div>
      <div class="row" style="margin-top:8px">
        <label class="field" style="min-width:90px">Tempo (bpm)<input type="number" inputmode="numeric" data-song="tempo" value="${esc(song.tempo)}" min="20" max="400"></label>
        <label class="field" style="min-width:90px">Time<select data-song="time">${TIMES.map((x) => `<option ${song.time === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="field" style="min-width:90px">Key (as written)<select data-song="key">${KEYS.map((k) => `<option ${song.key === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      </div>
      <div class="row" style="margin-top:8px">
        <label class="field">Chart lettering<select data-song="style">${Object.entries(FONT_STYLES).map(([k, f]) => `<option value="${k}" ${song.style === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select></label>
      </div>
    </div>

    <div class="card">
      <h2>Transpose</h2>
      <div class="transpose">
        <button class="btn icon" data-act="tr-down" aria-label="Down a semitone">−</button>
        <span class="keyshow" id="keyshow">${esc(transposeKeyName(song.key, t))}</span>
        <button class="btn icon" data-act="tr-up" aria-label="Up a semitone">+</button>
        <span class="muted small grow" id="trinfo">${stepsLabel(t)}${t ? ` (written in ${esc(song.key)})` : ''}</span>
        <button class="btn small" data-act="tr-reset" ${t ? '' : 'disabled'}>Reset</button>
      </div>
    </div>

    ${song.useRaw ? '' : song.sections.map((s, i) => sectionCard(s, i, song.sections.length)).join('')}

    ${song.useRaw ? '' : `<div class="card">
      <h2>Add a section</h2>
      <div class="chips">${['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Solo', 'Outro'].map((n) => `<button class="chip" data-act="add-sec" data-name="${n}">+ ${n}</button>`).join('')}<button class="chip" data-act="add-sec" data-name="">+ Other</button></div>
    </div>`}

    ${helpCard()}

    <div class="card">
      <h2>Notation (advanced)</h2>
      <label class="check"><input type="checkbox" data-act="raw-toggle" ${song.useRaw ? 'checked' : ''}> Write the whole chart in ABC notation</label>
      ${song.useRaw ? `
        <p class="small muted">The section editor is switched off while this is on. Turning it off goes back to your sections (ABC changes are kept but not used).</p>
        <textarea data-song="raw" rows="16" class="bars" ${NO_AUTO}>${esc(song.raw)}</textarea>
        <p class="small muted">ABC notation guide: <a href="https://abcnotation.com/wiki/abc:standard:v2.1" target="_blank" rel="noopener">abcnotation.com</a></p>`
    : '<p class="small muted">For the odd bar of real notation you don’t need this — use <code>{…}</code> inside a bar (see “How to type bars”).</p>'}
    </div>
    <datalist id="section-names">${SECTION_NAMES.map((n) => `<option value="${n}">`).join('')}</datalist>`;
  requestAnimationFrame(growAll);
}

function sectionCard(s, i, count) {
  const sel = (field, opts) => `<select data-sec="${i}" data-f="${field}">${opts}</select>`;
  return `
  <div class="card section-card" data-index="${i}">
    <div class="section-head">
      <span class="section-num">${i + 1}</span>
      <input type="text" list="section-names" data-sec="${i}" data-f="label" value="${esc(s.label)}" placeholder="Section name (optional)" autocomplete="off">
    </div>
    <textarea class="bars" rows="2" data-sec="${i}" data-f="bars" data-chordbox inputmode="${keyboardHidden() ? 'none' : 'text'}" placeholder="Tap chords and | below, or type: E | | C#m | A" ${NO_AUTO}>${esc(s.bars)}</textarea>
    <div class="section-opts">
      <label class="field">Rhythm${sel('rhythm', Object.entries(RHYTHMS).map(([k, v]) => `<option value="${k}" ${s.rhythm === k ? 'selected' : ''}>${v}</option>`).join(''))}</label>
      <label class="field" style="max-width:130px">Bars per line${sel('perLine', [2, 3, 4, 5, 6, 8].map((n) => `<option ${+s.perLine === n ? 'selected' : ''}>${n}</option>`).join(''))}</label>
    </div>
    <div class="row">
      <label class="check"><input type="checkbox" data-sec="${i}" data-f="repeat" ${s.repeat ? 'checked' : ''}> Repeat</label>
      <label class="check"><input type="checkbox" data-sec="${i}" data-f="pageBreak" ${s.pageBreak ? 'checked' : ''}> Start on a new page</label>
    </div>
    ${s.repeat ? `
      <div class="endings">
        <label class="field" style="max-width:110px">Play × times<input type="number" inputmode="numeric" min="2" max="16" data-sec="${i}" data-f="times" value="${esc(s.times)}" placeholder="2"></label>
        <label class="field">1st ending bars<input type="text" data-sec="${i}" data-f="ending1" data-chordbox inputmode="${keyboardHidden() ? 'none' : 'text'}" value="${esc(s.ending1)}" placeholder="e.g. B/A" ${NO_AUTO}></label>
        <label class="field">2nd ending bars<input type="text" data-sec="${i}" data-f="ending2" data-chordbox inputmode="${keyboardHidden() ? 'none' : 'text'}" value="${esc(s.ending2)}" placeholder="e.g. B" ${NO_AUTO}></label>
      </div>` : ''}
    <div class="row" style="margin-top:8px"><label class="field">Note under the first bar<input type="text" data-sec="${i}" data-f="note" value="${esc(s.note)}" placeholder="e.g. Cont. 8ths feel / and accents" autocomplete="off"></label></div>
    <div class="section-tools">
      <button class="btn small icon" data-act="sec-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button class="btn small icon" data-act="sec-down" data-i="${i}" ${i === count - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="btn small" data-act="sec-dup" data-i="${i}">Duplicate</button>
      <span class="grow"></span>
      <button class="btn small danger" data-act="sec-del" data-i="${i}">Delete</button>
    </div>
  </div>`;
}

function helpCard() {
  const r = (code, what) => `<tr><td><code>${esc(code)}</code></td><td>${what}</td></tr>`;
  return `
  <details class="card help">
    <summary>How to type bars</summary>
    <table>
      ${r('E | C#m | A | B', 'Bars are split with <b>|</b>. One chord per bar.')}
      ${r('E | | C#m |', 'An empty bar keeps playing the last chord (no chord printed).')}
      ${r('A B/A', 'Two chords in a bar split it in half.')}
      ${r('A . . B', '<b>.</b> holds a beat — here A for 3 beats, B on beat 4.')}
      ${r('N.C.', 'No chord.')}
      ${r('E >>', 'Accent the first 2 slashes of the bar (<code>></code>, <code>>>></code>…).')}
      ${r('B <', 'Crescendo hairpin under the bar. <code>dim</code> for diminuendo.')}
      ${r('"Band out"', 'Text above the bar.')}
      ${r('segno  coda', 'Segno 𝄋 / coda 𝄌 sign at the start of the bar.')}
      ${r('ds  dc  ds-coda  dc-fine  to-coda  fine', 'Road-map instructions at the end of the bar. <code>fermata</code> too.')}
      ${r('8ths  quarters  whole', 'Change the rhythm for just that bar.')}
      ${r('A {e2 f g a4}', 'Real notation for a bar (ABC notes; eighth note = 1, so <code>e2</code> is a quarter, <code>z</code> is a rest).')}
    </table>
    <p class="small muted">Sharps and flats: type <code>#</code> and <code>b</code> (C#m, Bb7). Repeats, 1st/2nd endings and “x3” are set with the options under each section.</p>
  </details>`;
}

function renderPreview(song, immediate = true) {
  clearTimeout(previewTimer);
  const go = () => {
    const pagesEl = $('#pages');
    if (!pagesEl) return;
    const res = renderSong(song, { paper: state.prefs.paper });
    pagesEl.innerHTML = '';
    res.pages.forEach((p) => {
      const w = document.createElement('div');
      w.className = 'page-wrap';
      w.appendChild(p);
      pagesEl.appendChild(w);
    });
    $('#preview-info').textContent = `Key of ${res.key} · ${res.pages.length} page${res.pages.length === 1 ? '' : 's'} · ${PAPER[state.prefs.paper].label}`;
    const warn = $('#warnings');
    if (warn) warn.innerHTML = res.warnings.length ? `<div class="warn">${res.warnings.slice(0, 6).map(esc).join('<br>')}</div>` : '';
  };
  if (immediate) go(); else previewTimer = setTimeout(go, 350);
}

function updateTransposeUi(song) {
  const t = song.transpose || 0;
  $('#keyshow').textContent = transposeKeyName(song.key, t);
  $('#trinfo').textContent = stepsLabel(t) + (t ? ` (written in ${song.key})` : '');
  $('[data-act="tr-reset"]').disabled = !t;
}

// Field edits (song + sections). Checkboxes use "change" (older iOS), everything else "input".
const onSongField = (e) => {
  const song = currentSong();
  if (!song) return;
  const tgt = e.target;
  if ((tgt.type === 'checkbox') !== (e.type === 'change')) return;
  if (tgt.dataset.song) {
    song[tgt.dataset.song] = tgt.value;
    if (tgt.dataset.song === 'title') $('#top-title').textContent = tgt.value || 'New song';
    if (tgt.dataset.song === 'key') { updateTransposeUi(song); refreshPalette(); }
  } else if (tgt.dataset.sec != null) {
    const sec = song.sections[+tgt.dataset.sec];
    if (!sec) return;
    if (tgt.type === 'checkbox') sec[tgt.dataset.f] = tgt.checked;
    else sec[tgt.dataset.f] = tgt.value;
    if (tgt.dataset.f === 'repeat') drawEditPane(song);
  } else return;
  song.updated = Date.now();
  store.save();
  renderPreview(song, tgt.tagName === 'SELECT' || tgt.type === 'checkbox');
};
app.addEventListener('input', onSongField);
// Chord boxes grow with their contents instead of scrolling.
const autoGrow = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; };
app.addEventListener('input', (e) => { if (e.target.matches('textarea.bars')) autoGrow(e.target); });
const growAll = () => $$('textarea.bars').forEach(autoGrow);
app.addEventListener('change', onSongField);

function currentSong() {
  const m = /^\/song\/(.+)$/.exec(currentPath);
  return m ? store.findSong(m[1]) : null;
}
function currentGig() {
  const m = /^\/gig\/(.+)$/.exec(currentPath);
  return m ? store.findGig(m[1]) : null;
}

// ---------- gigs ----------
function viewGigs() {
  topbar({ right: '<button class="tbtn primary" data-act="new-gig">+ New gig</button>' });
  const gigs = [...state.gigs].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  app.innerHTML = `
    ${homeTabs('gigs')}
    <div class="card"><ul class="list">${gigs.length ? gigs.map((g) => `
      <li><a class="list-item" href="#/gig/${g.id}">
        <div class="grow"><div class="title">${esc(g.name || 'Untitled gig')}</div><div class="meta">${esc([g.date, g.venue].filter(Boolean).join(' · '))}</div></div>
        <span class="pill">${g.items.length} song${g.items.length === 1 ? '' : 's'}</span>
      </a></li>`).join('') : '<li class="empty">No gigs yet. Tap “+ New gig” to build a setlist and print every chart in one PDF.</li>'}
    </ul></div>
    ${settingsCard()}`;
  bindSettings();
}

function gigItemKey(item) {
  const song = store.findSong(item.songId);
  if (!song) return { song: null, steps: 0, key: '?' };
  const steps = item.transpose ?? (song.transpose || 0);
  return { song, steps, key: transposeKeyName(song.key, steps) };
}

function viewGig(gig) {
  topbar({
    title: gig.name || 'Gig',
    left: '<a class="tbtn" href="#/gigs">‹ Gigs</a>',
    right: `${ARTIFACT ? '' : '<button class="tbtn" data-act="gig-print">Print</button>'}<button class="tbtn primary" data-act="gig-pdf">PDF</button>`,
  });
  app.innerHTML = `
    <div style="max-width:760px;margin:0 auto">
    <div class="card">
      <h2>Gig</h2>
      <div class="row"><label class="field">Name<input type="text" data-gig="name" value="${esc(gig.name)}" placeholder="e.g. Smith wedding" autocomplete="off"></label></div>
      <div class="row" style="margin-top:8px">
        <label class="field">Date<input type="date" data-gig="date" value="${esc(gig.date)}"></label>
        <label class="field">Venue<input type="text" data-gig="venue" value="${esc(gig.venue)}" autocomplete="off"></label>
      </div>
      <div class="row" style="margin-top:8px"><label class="field">Notes (printed on the setlist)<input type="text" data-gig="notes" value="${esc(gig.notes)}" autocomplete="off"></label></div>
      <label class="check" style="margin-top:6px"><input type="checkbox" data-gig="setlistPage" ${gig.setlistPage !== false ? 'checked' : ''}> Put a setlist page at the front of the PDF</label>
    </div>
    <div class="card">
      <h2>Setlist</h2>
      <div id="gig-items">${gigItems(gig)}</div>
      <div class="row" style="margin-top:10px"><button class="btn primary grow" data-act="gig-add">+ Add songs</button></div>
      <p class="small muted">Transposing here only changes the key for this gig — the song itself stays as it is.</p>
    </div>
    <div class="row"><span class="grow"></span><button class="btn danger" data-act="gig-del">Delete gig</button></div>
    </div>`;
}

function gigItems(gig) {
  if (!gig.items.length) return '<p class="empty">No songs yet.</p>';
  return gig.items.map((item, i) => {
    const { song, steps, key } = gigItemKey(item);
    return `<div class="gig-item">
      <span class="n">${i + 1}</span>
      <div class="t">${song ? `<a href="#/song/${song.id}">${esc(song.title || 'Untitled')}</a>` : '<span class="muted">(deleted song)</span>'}<div class="k muted">${steps ? stepsLabel(steps) : 'Song’s key'}</div></div>
      <div class="stepper"><button data-act="gi-down" data-i="${i}" aria-label="Transpose down">−</button><span>${esc(key)}</span><button data-act="gi-up" data-i="${i}" aria-label="Transpose up">+</button></div>
      <button class="btn small icon" data-act="gi-moveup" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button class="btn small icon" data-act="gi-movedown" data-i="${i}" ${i === gig.items.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="btn small icon danger" data-act="gi-del" data-i="${i}" aria-label="Remove">✕</button>
    </div>`;
  }).join('');
}

const onGigField = (e) => {
  const gig = currentGig();
  const f = e.target.dataset.gig;
  if (!gig || !f) return;
  if ((e.target.type === 'checkbox') !== (e.type === 'change')) return;
  gig[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (f === 'name') $('#top-title').textContent = gig.name || 'Gig';
  store.save();
};
app.addEventListener('input', onGigField);
app.addEventListener('change', onGigField);

function gigAddSheet(gig) {
  const songs = [...state.songs].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const sheet = openModal(`
    <h3>Add songs to “${esc(gig.name || 'gig')}”</h3>
    <input type="search" id="add-search" placeholder="Search" ${NO_AUTO}>
    <div id="add-list" style="margin-top:8px"></div>
    <div class="actions"><button class="btn primary" data-m="add">Add selected</button><button class="btn" data-m="close">Cancel</button></div>`);
  const chosen = new Set();
  const draw = (q = '') => {
    const ql = q.toLowerCase();
    $('#add-list', sheet).innerHTML = songs.filter((s) => !ql || (s.title || '').toLowerCase().includes(ql)).map((s) => `
      <label class="check" style="display:flex"><input type="checkbox" value="${s.id}" ${chosen.has(s.id) ? 'checked' : ''}> <span class="grow">${esc(s.title || 'Untitled')}</span> <span class="pill">${esc(transposeKeyName(s.key, s.transpose || 0))}</span></label>`).join('') || '<p class="empty">No songs in your library yet.</p>';
  };
  draw();
  $('#add-search', sheet).addEventListener('input', (e) => draw(e.target.value));
  sheet.addEventListener('change', (e) => { if (e.target.type === 'checkbox') e.target.checked ? chosen.add(e.target.value) : chosen.delete(e.target.value); });
  sheet.addEventListener('click', (e) => {
    const m = e.target.dataset.m;
    if (m === 'close') closeModal();
    if (m === 'add') {
      // Keep library order of selection as alphabetical; user can reorder after.
      songs.filter((s) => chosen.has(s.id)).forEach((s) => gig.items.push({ songId: s.id, transpose: null }));
      store.save();
      closeModal();
      $('#gig-items').innerHTML = gigItems(gig);
    }
  });
}

// ---------- PDF / print ----------
function gigPages(gig) {
  const pages = [];
  const rows = [];
  gig.items.forEach((item) => {
    const { song, steps, key } = gigItemKey(item);
    if (!song) return;
    rows.push({ title: song.title, key, tempo: song.tempo });
    pages.push(...renderSong(song, { paper: state.prefs.paper, transpose: steps }).pages);
  });
  if (gig.setlistPage !== false) pages.unshift(renderSetlist(gig, rows, state.prefs.paper));
  return pages;
}

async function makePdf(getPages, name) {
  const sheet = openModal(`<h3>Making PDF…</h3><div class="spinner"></div><p class="muted small" id="pdf-progress" style="text-align:center">Preparing pages</p>`);
  try {
    await new Promise((r) => setTimeout(r, 30));
    const pages = getPages();
    if (!pages.length) throw new Error('Nothing to print yet.');
    const blob = await pagesToPdf(pages, state.prefs.paper, (i, n) => { const p = $('#pdf-progress', sheet); if (p) p.textContent = `Page ${i} of ${n}`; });
    const filename = fileSafe(name) + '.pdf';
    const pdf = new Blob([blob], { type: 'application/pdf' });
    const file = new File([pdf], filename, { type: 'application/pdf' });
    const canShare = !ARTIFACT && navigator.canShare && navigator.canShare({ files: [file] });
    const url = ARTIFACT ? '' : URL.createObjectURL(pdf);
    sheet.innerHTML = `
      <h3>PDF ready</h3>
      <p class="muted small">${esc(filename)} · ${pages.length} page${pages.length === 1 ? '' : 's'} · ${(pdf.size / 1024 / 1024).toFixed(1)} MB</p>
      <div class="actions">
        ${ARTIFACT ? '<button class="btn primary" data-m="save">Save PDF</button>' : ''}
        ${canShare ? '<button class="btn primary" data-m="share">Share / Save to Files / Print</button>' : ''}
        ${ARTIFACT ? '' : `<a class="btn ${canShare ? '' : 'primary'}" href="${url}" download="${esc(filename)}">Download PDF</a>
        <a class="btn" href="${url}" target="_blank" rel="noopener">Open PDF</a>`}
        <button class="btn" data-m="close">Done</button>
      </div>`;
    sheet.addEventListener('click', async (e) => {
      const m = e.target.dataset.m;
      if (m === 'close') { closeModal(); if (url) setTimeout(() => URL.revokeObjectURL(url), 60000); }
      if (m === 'save') saveFile(pdf, filename);
      if (m === 'share') {
        try { await navigator.share({ files: [file], title: name }); } catch (err) { if (err.name !== 'AbortError') toast('Sharing didn’t work. Try Download.'); }
      }
    });
  } catch (err) {
    console.error(err);
    sheet.innerHTML = `<h3>Couldn’t make the PDF</h3><p>${esc(err.message)}</p><div class="actions"><button class="btn" data-m="close">Close</button></div>`;
    sheet.addEventListener('click', (e) => { if (e.target.dataset.m === 'close') closeModal(); });
  }
}

function printPages(pages) {
  const root = $('#print-root');
  root.innerHTML = '';
  const paper = PAPER[state.prefs.paper];
  let style = $('#page-style');
  if (!style) { style = document.createElement('style'); style.id = 'page-style'; document.head.appendChild(style); }
  style.textContent = `@page { size: ${state.prefs.paper === 'a4' ? 'A4' : 'letter'}; margin: 0; }`;
  pages.forEach((p) => {
    p.setAttribute('width', `${paper.w / 96}in`);
    p.setAttribute('height', `${paper.h / 96}in`);
    root.appendChild(p);
  });
  setTimeout(() => { window.print(); }, 50);
}
window.addEventListener('afterprint', () => { $('#print-root').innerHTML = ''; });

// ---------- actions ----------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  const song = currentSong();
  const gig = currentGig();
  const i = +btn.dataset.i;

  switch (act) {
    case 'new-song': {
      const s = store.newSong();
      state.songs.push(s);
      store.save(true);
      sessionStorageSet('view', 'edit');
      navigate(`/song/${s.id}`);
      break;
    }
    case 'add-example': {
      state.songs.push(store.exampleSong());
      store.save(true);
      route();
      break;
    }
    case 'new-gig': {
      const g = { id: store.uid(), name: '', date: new Date().toISOString().slice(0, 10), venue: '', notes: '', setlistPage: true, items: [] };
      state.gigs.push(g);
      store.save(true);
      navigate(`/gig/${g.id}`);
      break;
    }
    case 'backup': {
      const blob = new Blob([store.exportBackup()], { type: 'application/json' });
      const name = `chart-maker-backup-${new Date().toISOString().slice(0, 10)}.json`;
      saveFile(blob, name);
      break;
    }
    // song
    case 'tr-up': case 'tr-down': case 'tr-reset':
      if (!song) break;
      song.transpose = act === 'tr-reset' ? 0 : wrapSteps((song.transpose || 0) + (act === 'tr-up' ? 1 : -1));
      store.save();
      updateTransposeUi(song);
      renderPreview(song);
      break;
    case 'add-sec': {
      const s = store.newSection(btn.dataset.name);
      song.sections.push(s);
      store.save();
      drawEditPane(song);
      const cards = $$('.section-card');
      const last = cards[cards.length - 1];
      last?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('textarea', last)?.focus({ preventScroll: true });
      renderPreview(song);
      break;
    }
    case 'sec-up': case 'sec-down': {
      const j = act === 'sec-up' ? i - 1 : i + 1;
      [song.sections[i], song.sections[j]] = [song.sections[j], song.sections[i]];
      store.save(); drawEditPane(song); renderPreview(song);
      $$('.section-card')[j]?.scrollIntoView({ block: 'center' });
      break;
    }
    case 'sec-dup':
      song.sections.splice(i + 1, 0, { ...song.sections[i], id: store.uid() });
      store.save(); drawEditPane(song); renderPreview(song);
      break;
    case 'sec-del':
      askConfirm(`Delete section ${i + 1}${song.sections[i].label ? ` (${song.sections[i].label})` : ''}?`).then((ok) => {
        if (!ok) return;
        song.sections.splice(i, 1);
        store.save(); drawEditPane(song); renderPreview(song);
      });
      break;
    case 'raw-toggle':
      song.useRaw = btn.checked;
      if (song.useRaw && !(song.raw || '').trim()) song.raw = songToAbc(song).abc;
      store.save(); drawEditPane(song); renderPreview(song);
      break;
    case 'song-pdf':
      makePdf(() => renderSong(song, { paper: state.prefs.paper }).pages, `${song.title || 'Chart'}${song.transpose ? ` - ${keyName(song.key, song.transpose)}` : ''}`);
      break;
    case 'song-print':
      printPages(renderSong(song, { paper: state.prefs.paper }).pages);
      break;
    case 'song-menu': {
      const sheet = openModal(`
        <h3>${esc(song.title || 'Song')}</h3>
        <div class="actions">
          ${ARTIFACT ? '' : '<button class="btn" data-m="print">Print</button>'}
          <button class="btn" data-m="dup">Duplicate song</button>
          <button class="btn" data-m="share">Send song file (to another device)</button>
          <button class="btn danger" data-m="del">Delete song</button>
          <button class="btn" data-m="close">Cancel</button>
        </div>`);
      sheet.addEventListener('click', (ev) => {
        const m = ev.target.dataset.m;
        if (!m) return;
        closeModal();
        if (m === 'print') printPages(renderSong(song, { paper: state.prefs.paper }).pages);
        if (m === 'dup') {
          const copy = JSON.parse(JSON.stringify(song));
          copy.id = store.uid();
          copy.title = (song.title || 'Untitled') + ' (copy)';
          copy.sections.forEach((s) => (s.id = store.uid()));
          state.songs.push(copy);
          store.save(true);
          navigate(`/song/${copy.id}`);
          toast('Duplicated');
        }
        if (m === 'share') {
          const name = fileSafe(song.title) + '.chart.json';
          const blob = new Blob([JSON.stringify({ app: 'chart-maker', song }, null, 1)], { type: 'application/json' });
          saveFile(blob, name);
        }
        if (m === 'del') {
          askConfirm(`Delete “${song.title || 'this song'}”? This can’t be undone.`).then((ok) => {
            if (!ok) return;
            state.songs = state.songs.filter((s) => s.id !== song.id);
            store.save(true);
            navigate('/');
          });
        }
      });
      break;
    }
    // gig
    case 'gig-add': gigAddSheet(gig); break;
    case 'gi-up': case 'gi-down': {
      const item = gig.items[i];
      const { song: s } = gigItemKey(item);
      if (!s) break;
      const cur = item.transpose ?? (s.transpose || 0);
      item.transpose = wrapSteps(cur + (act === 'gi-up' ? 1 : -1));
      store.save();
      $('#gig-items').innerHTML = gigItems(gig);
      break;
    }
    case 'gi-moveup': case 'gi-movedown': {
      const j = act === 'gi-moveup' ? i - 1 : i + 1;
      [gig.items[i], gig.items[j]] = [gig.items[j], gig.items[i]];
      store.save();
      $('#gig-items').innerHTML = gigItems(gig);
      break;
    }
    case 'gi-del':
      gig.items.splice(i, 1);
      store.save();
      $('#gig-items').innerHTML = gigItems(gig);
      break;
    case 'gig-pdf':
      if (!gig.items.length) { toast('Add some songs first.'); break; }
      makePdf(() => gigPages(gig), gig.name || 'Gig');
      break;
    case 'gig-print':
      if (!gig.items.length) { toast('Add some songs first.'); break; }
      printPages(gigPages(gig));
      break;
    case 'gig-del':
      askConfirm(`Delete the gig “${gig.name || 'Untitled'}”? Songs stay in your library.`).then((ok) => {
        if (!ok) return;
        state.gigs = state.gigs.filter((g) => g.id !== gig.id);
        store.save(true);
        navigate('/gigs');
      });
      break;
  }
});

// Save immediately when the app is backgrounded (iOS may kill it).
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.save(true); });

// ---------- start ----------
(async function start() {
  app.innerHTML = '<div class="spinner" style="margin-top:40px"></div><p class="empty">Opening your charts…</p>';
  store.setSaveErrorHandler(() => toast('Couldn’t save that change. Check your connection.'));
  state = await store.load();
  initPalette(() => currentSong()?.key || 'C');
  await loadFonts();
  route();
  if (!ARTIFACT && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
