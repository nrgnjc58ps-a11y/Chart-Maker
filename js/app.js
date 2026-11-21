import * as store from './store.js';
import { RHYTHMS, KEYS, FONT_STYLES, TUNINGS, CHORD_STYLES, CHORD_SIZES, resolveSection, splitBarsEx, targetKey, sectionKey, keySpellings, transposeKeyName as keyName, prettyChord, songToAbc } from './abcgen.js';
// The key a song is shown in, with the sharps/flats spelling chosen for it.
const shownKey = (song) => targetKey(song.key, song.transpose || 0, song.keyPref);
const transposeKeyName = (k, n) => prettyChord(keyName(k, n));
const keyText = (k) => prettyChord(k.replace(/m$/, '')) + (/m$/.test(k) ? ' minor' : ' major');
const PC_OF = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const pcOf = (k) => { const m = /^([A-G])([#b]?)/.exec(k) || [0, 'C', '']; return (PC_OF[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12; };
import { renderSong, pagesToPdf, loadFonts, setChordSize, PAPER } from './render.js';
import { initPalette, refreshPalette, keyboardHidden } from './palette.js';
import { LAYOUTS } from './layout.js';
import { photoImportAvailable, readChartImages, prepareFiles, errorText, imageTypes, maxImages } from './photo.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const SECTION_NAMES = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Solo', 'Interlude', 'Instrumental', 'Middle 8', 'Breakdown', 'Tag', 'Outro', 'Coda', 'Ending'];
const TIMES = ['4/4', '3/4', '2/4', '6/8', '12/8', '5/4', '7/8', '2/2'];
const NO_AUTO = 'autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"';

let state;
let previewTimer;
let photoOK = false; // can this view ask Claude to read a picture of a chart?

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

function transposeInfo(song) {
  const t = song.transpose || 0;
  if (t) return `${stepsLabel(t)} (written in ${prettyChord(song.key)})`;
  const k = shownKey(song);
  return k !== song.key ? `Same notes, spelled in ${prettyChord(k)} (written in ${prettyChord(song.key)})` : 'Original key';
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
  return viewSongs();
}
if (!ARTIFACT) window.addEventListener('hashchange', route);

// ---------- home: songs ----------
// Select mode on the song list (for deleting several at once).
let selecting = null; // 'songs' | null
const selected = new Set();

function selectBar(kind) {
  const n = selected.size;
  return `<div class="select-bar">
    <button class="btn small" data-act="select-all" data-kind="${kind}">Select all</button>
    <span class="grow muted small">${n} selected</span>
    <button class="btn danger-fill" data-act="delete-selected" data-kind="${kind}" ${n ? '' : 'disabled'}>Delete${n ? ` (${n})` : ''}</button>
  </div>`;
}

function listTopbar(kind) {
  const isSel = selecting === kind;
  const has = state.songs.length;
  const sel = has ? `<button class="tbtn" data-act="${isSel ? 'select-done' : 'select-start'}" data-kind="${kind}">${isSel ? 'Done' : 'Select'}</button>` : '';
  const add = isSel ? '' : '<button class="tbtn icon-btn" data-act="paste-song" aria-label="Paste a song copied from Audio Charter" title="Paste a song copied from Audio Charter">📋</button><button class="tbtn icon-btn" data-act="settings" aria-label="Settings and backup">⚙︎</button><button class="tbtn primary" data-act="new-song">+ New</button>';
  topbar({ title: isSel ? `${selected.size} selected` : 'Charts', left: sel, right: add });
}

function viewSongs(filter = '') {
  if (selecting !== 'songs') { selecting = null; selected.clear(); }
  listTopbar('songs');
  const songs = [...state.songs].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  app.innerHTML = `
    <div class="home">
      ${state.songs.length > 6 || filter ? `<input type="search" id="song-search" class="search" placeholder="Search ${state.songs.length} songs" value="${esc(filter)}" ${NO_AUTO}>` : ''}
      <ul class="list song-list" id="song-list"></ul>
      ${selecting === 'songs' ? selectBar('songs') : ''}
    </div>`;
  const list = $('#song-list');
  const draw = (q) => {
    const ql = q.trim().toLowerCase();
    const shown = songs.filter((s) => !ql || `${s.title} ${s.composer}`.toLowerCase().includes(ql));
    const row = (s) => `
        <div class="grow"><div class="title">${esc(s.title || 'Untitled')}</div><div class="meta">${esc(s.composer || '')}${s.tempo ? ` · ${esc(s.tempo)} bpm` : ''}</div></div>
        <span class="pill">${esc(prettyChord(shownKey(s)))}</span>`;
    list.innerHTML = shown.length ? shown.map((s) => (selecting === 'songs'
      ? `<li><label class="list-item select-row"><input type="checkbox" data-select="${s.id}" ${selected.has(s.id) ? 'checked' : ''}>${row(s)}</label></li>`
      : `<li><a class="list-item" href="#/song/${s.id}">${row(s)}<span class="chev" aria-hidden="true">›</span></a></li>`)).join('')
      : (state.songs.length ? '<li class="empty">No songs match.</li>' : `<li class="empty">No songs yet. Tap “+ New song”, or start from an example chart.<br><button class="btn" data-act="add-example" style="margin-top:10px">Add example: Shape of a Heart</button></li>`);
  };
  draw(filter);
  $('#song-search')?.addEventListener('input', (e) => draw(e.target.value));
}

app.addEventListener('change', (e) => {
  const id = e.target.dataset?.select;
  if (!id) return;
  e.target.checked ? selected.add(id) : selected.delete(id);
  const bar = $('.select-bar');
  if (bar) bar.outerHTML = selectBar(selecting);
  $('#top-title').textContent = `${selected.size} selected`;
});

function gigsUsing(songIds) {
  return state.gigs.filter((g) => g.items.some((it) => songIds.includes(it.songId)));
}

// Delete songs after asking; also takes them out of any gig setlists.
async function deleteSongs(ids) {
  if (!ids.length) return false;
  const names = ids.map((id) => store.findSong(id)?.title || 'Untitled');
  const what = ids.length === 1 ? `“${names[0]}”` : `${ids.length} songs`;
  const ok = await askConfirm(`Delete ${what}? This can’t be undone.`, ids.length === 1 ? 'Delete song' : `Delete ${ids.length} songs`);
  if (!ok) return false;
  state.songs = state.songs.filter((s) => !ids.includes(s.id));
  gigsUsing(ids).forEach((g) => { g.items = g.items.filter((it) => !ids.includes(it.songId)); });
  store.save(true);
  toast(ids.length === 1 ? `Deleted “${names[0]}”` : `Deleted ${ids.length} songs`);
  return true;
}

// ---------- new song: blank, or read from a photo of a chart ----------
function newSongSheet() {
  const many = maxImages() > 1;
  openModal(`
    <h3>New chart</h3>
    <div class="actions">
      <button class="btn primary" data-act="new-blank">Blank chart</button>
      <label class="btn">From a photo, screenshot or PDF…<input type="file" id="photo-pick" accept="${esc(imageTypes())}" ${many ? 'multiple' : ''} hidden></label>
    </div>
    <p class="small muted">Pick a picture or PDF of a chart${many ? ` (up to ${maxImages()} pages of one song)` : ''}. Claude reads it and writes it out here for you to check and edit.</p>`);
  $('#photo-pick').addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (files.length) importFromPhotos(files);
  });
}

async function importFromPhotos(files) {
  const ctl = new AbortController();
  let prep;
  if (files.some((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''))) {
    openModal('<h3>Opening the PDF…</h3><div class="spinner"></div>');
  }
  try {
    prep = await prepareFiles(files);
  } catch (err) {
    const m = openModal(`<h3>Couldn’t open that file</h3><p>${esc(err && err.message)}</p><div class="actions"><button class="btn" data-m="close">OK</button></div>`);
    m.addEventListener('click', (e) => { if (e.target.dataset.m === 'close') closeModal(); });
    return;
  }
  if (!prep.images.length) { closeModal(); toast('Nothing to read in that file.'); return; }
  if (prep.skipped) toast(`Only the first ${prep.images.length} pages are read.`, 3500);
  const urls = prep.images.map((f) => URL.createObjectURL(f));
  const sheet = openModal(`
    <h3>Reading the chart…</h3>
    <div class="photo-thumbs">${urls.map((u) => `<img src="${u}" alt="">`).join('')}</div>
    <p class="small muted"><span class="spinner inline"></span> This usually takes 20–60 seconds.</p>
    <div class="actions"><button class="btn" data-m="stop">Stop</button></div>`);
  sheet.addEventListener('click', (e) => { if (e.target.dataset.m === 'stop') ctl.abort(); });
  const done = () => urls.forEach((u) => URL.revokeObjectURL(u));
  let result;
  try {
    result = await readChartImages(prep.images, ctl.signal, prep.text);
  } catch (err) {
    done();
    if (err && err.code === 'cancelled') { closeModal(); return; }
    const m = openModal(`<h3>Couldn’t read that chart</h3><p>${esc(errorText(err))}</p><div class="actions"><button class="btn" data-m="close">OK</button></div>`);
    m.addEventListener('click', (e) => { if (e.target.dataset.m === 'close') closeModal(); });
    return;
  }
  done();
  const { song, unsure } = result;
  state.songs.push(song);
  store.save(true);
  sessionStorageSet('view', 'preview');
  closeModal();
  navigate(`/song/${song.id}`);
  const m = openModal(`
    <h3>Chart imported</h3>
    <p>Check it against the original before the gig: the chords, repeats and endings are read from the picture and can be wrong.</p>
    ${unsure.length ? `<p class="small"><b>Worth a closer look:</b></p><ul class="small">${unsure.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}
    <div class="actions"><button class="btn primary" data-m="close">OK</button></div>`);
  m.addEventListener('click', (e) => { if (e.target.dataset.m === 'close') closeModal(); });
}

function settingsSheet() {
  const sheet = openModal(`
      <h3>Settings &amp; backup</h3>
      <div class="row">
        <label class="field">Paper size
          <select id="paper">${Object.entries(PAPER).map(([k, p]) => `<option value="${k}" ${state.prefs.paper === k ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
        </label>
        <label class="field">Chord size
          <select id="chord-size">${Object.entries(CHORD_SIZES).map(([k, c]) => `<option value="${k}" ${(state.prefs.chordSize || 'medium') === k ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
        </label>
      </div>
      <p class="small muted">${store.storageMode() === 'account'
        ? 'Your songs are saved privately to your Claude account, so they’re here whenever you open this page. A backup file is still a good idea.'
        : 'Your songs are saved on this device only. Save a backup file now and then (to Files or iCloud Drive), especially before clearing Safari data.'}</p>
      <div class="row">
        <button class="btn" data-act="backup">Save backup file</button>
        <label class="btn">Restore backup<input type="file" id="restore" accept=".json,application/json" hidden></label>
      </div>
      <div class="actions"><button class="btn" data-m="close">Done</button></div>`);
  sheet.addEventListener('click', (e) => { if (e.target.dataset.m === 'close') closeModal(); });
  bindSettings();
}

function bindSettings() {
  $('#chord-size')?.addEventListener('change', (e) => { state.prefs.chordSize = e.target.value; setChordSize(e.target.value); store.save(); toast(`Chord size: ${CHORD_SIZES[e.target.value].label}`); });
  $('#paper')?.addEventListener('change', (e) => { state.prefs.paper = e.target.value; store.save(); toast(`Paper: ${PAPER[e.target.value].label}`); });
  $('#restore')?.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = store.importBackup(await f.text());
      closeModal(); toast(`Restored ${r.songs} song${r.songs === 1 ? '' : 's'}`);
      route();
    } catch {
      toast('That file isn’t a Chart Maker backup.');
    }
  });
}

// ---------- paste a song copied from Audio Charter ----------
// Audio Charter's "Copy for Chart Maker" puts a backup-format song on the clipboard
// ({ app: 'chart-maker', songs: [...] }). It's merged like Restore backup: a song with
// the same id is updated, everything else is kept.
async function pasteSong() {
  let text = '';
  try { text = await navigator.clipboard.readText(); }
  catch { toast('Couldn’t read the clipboard. Allow Paste, or use ⚙︎ → Restore backup.', 3500); return; }
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  const incoming = data && data.app === 'chart-maker' ? (data.songs || (data.song ? [data.song] : [])) : [];
  if (!incoming.length) { toast('No song on the clipboard. In Audio Charter: Export → Copy for Chart Maker.', 3500); return; }
  const updating = incoming.filter((s) => s && store.findSong(s.id)).length;
  const r = store.importBackup(text);
  if (!r.songs) { toast('That clipboard text isn’t a Chart Maker song.'); return; }
  const what = r.songs === 1 ? `“${incoming[0].title || 'Untitled'}”` : `${r.songs} songs`;
  toast(updating === r.songs ? `Updated ${what}` : `Added ${what}`);
  if (r.songs === 1 && store.findSong(incoming[0].id)) navigate('/song/' + incoming[0].id);
  else route();
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
        <label class="field" style="min-width:90px;max-width:120px">Capo<select data-song="capo">${['', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `<option value="${n}" ${String(song.capo || '') === String(n) ? 'selected' : ''}>${n === '' ? 'None' : 'Capo ' + n}</option>`).join('')}</select></label>
        <label class="field">Tuning<select data-song="tuning">${Object.entries(TUNINGS).map(([k, t]) => `<option value="${k}" ${(song.tuning || 'standard') === k ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
      </div>
      ${song.tuning === 'custom' ? `<div class="row" style="margin-top:8px"><label class="field">Tuning (low to high)<input type="text" data-song="tuningCustom" value="${esc(song.tuningCustom)}" placeholder="e.g. C G D G B D" ${NO_AUTO}></label></div>` : ''}
      <label class="check" style="margin-top:6px"><input type="checkbox" data-song="showKey" ${song.showKey !== false ? 'checked' : ''}> Print the key at the top (e.g. “Key: G major”)</label>
      <div class="row" style="margin-top:8px">
        <label class="field">Chord symbols<select data-song="chordStyle">${Object.entries(CHORD_STYLES).map(([k, v]) => `<option value="${k}" ${(song.chordStyle || 'short') === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      </div>
      <div class="row" style="margin-top:8px">
        <label class="field">Layout<select data-song="layout">${Object.entries(LAYOUTS).map(([k, v]) => `<option value="${k}" ${(song.layout || 'full') === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      </div>
      <p class="small muted" style="margin:6px 0 0">Type the song in playing order. <b>Form + sections</b> prints the order at the top and each different part once; <b>Compact</b> joins repeats and uses one D.C./D.S. jump when it saves space. Your sections stay as typed.</p>
      <div class="row" style="margin-top:8px">
        <label class="field">Chart lettering<select data-song="style">${Object.entries(FONT_STYLES).map(([k, f]) => `<option value="${k}" ${song.style === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select></label>
      </div>
    </div>

    <div class="card">
      <h2>Transpose</h2>
      <div class="transpose">
        <button class="btn icon" data-act="tr-down" aria-label="Down a semitone">−</button>
        <select class="keyshow" id="keyshow" data-act-change="tr-to" aria-label="Transpose to">${transposeOptions(song)}</select>
        <button class="btn icon" data-act="tr-up" aria-label="Up a semitone">+</button>
        <span class="muted small grow" id="trinfo">${esc(transposeInfo(song))}</span>
        <button class="btn small" data-act="tr-reset" ${t || song.keyPref ? '' : 'disabled'}>Reset</button>
      </div>
    </div>

    ${song.useRaw ? '' : song.sections.map((s, i) => (s.linkTo ? linkedCard(song, s, i) : sectionCard(s, i, song.sections.length, song))).join('')}

    ${song.useRaw ? '' : `<div class="card">
      <div id="repeat-chips">${repeatChips(song)}</div>
      <h2>Add a new section</h2>
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
    <div class="row" style="margin:4px 0 20px"><span class="grow"></span><button class="btn danger" data-act="song-del">Delete this song</button></div>
    <datalist id="section-names">${SECTION_NAMES.map((n) => `<option value="${n}">`).join('')}</datalist>`;
  requestAnimationFrame(growAll);
}

// One button per section already written (Verse, Chorus…), to play it again.
function repeatChips(song) {
  const seen = new Set();
  const originals = song.sections.filter((s) => !s.linkTo && splitBarsEx(s.bars).length).filter((s) => {
    const key = (s.label || '').trim().toLowerCase() || s.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!originals.length) return '';
  return `<h2>Repeat a section</h2>
    <div class="chips" style="margin-bottom:14px">${originals.map((s) => `<button class="chip chip-repeat" data-act="add-link" data-id="${s.id}">↻ ${esc(s.label || 'Section ' + (song.sections.indexOf(s) + 1))}</button>`).join('')}</div>`;
}

// A repeat of another section: shows what it plays, edits happen on the original.
function linkedCard(song, s, i) {
  const src = song.sections.find((x) => x.id === s.linkTo && !x.linkTo);
  const r = resolveSection(song, s);
  const n = src ? song.sections.indexOf(src) + 1 : '?';
  const bars = splitBarsEx(r.bars).length + (r.repeat ? splitBarsEx(r.ending1).length + splitBarsEx(r.ending2).length : 0);
  return `
  <div class="card section-card linked-card" data-index="${i}">
    <div class="section-head">
      <span class="section-num">${i + 1}</span>
      <div class="grow"><div class="linked-title">↻ ${esc(r.label || 'Section ' + n)}</div>
      <div class="small muted">${src ? `Same as section ${n} · ${bars} bar${bars === 1 ? '' : 's'}${r.repeat ? ' · repeated' : ''}. Changes to section ${n} show here too.` : 'The original section was deleted.'}</div></div>
    </div>
    <div class="linked-bars">${esc(r.bars)}</div>
    <div class="row" style="margin-top:8px"><label class="field">Key change for this one<select data-sec="${i}" data-f="keyChange">${keyChangeOptions(song, s)}</select></label></div>
    <div class="row"><label class="check"><input type="checkbox" data-sec="${i}" data-f="pageBreak" ${s.pageBreak ? 'checked' : ''}> Start on a new page</label></div>
    <div class="section-tools">
      <button class="btn small icon" data-act="sec-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button class="btn small icon" data-act="sec-down" data-i="${i}" ${i === song.sections.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="btn small" data-act="sec-unlink" data-i="${i}">Change this one</button>
      <span class="grow"></span>
      <button class="btn small danger" data-act="sec-del" data-i="${i}">Delete</button>
    </div>
  </div>`;
}

function sectionCard(s, i, count, song) {
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
      <label class="check"><input type="checkbox" data-sec="${i}" data-f="repeat" ${s.repeat ? 'checked' : ''}> Repeat whole section ‖: :‖</label>
      <label class="check"><input type="checkbox" data-sec="${i}" data-f="pageBreak" ${s.pageBreak ? 'checked' : ''}> Start on a new page</label>
    </div>
    ${s.repeat ? `
      <div class="endings">
        <label class="field" style="max-width:110px">Play × times<input type="number" inputmode="numeric" min="2" max="16" data-sec="${i}" data-f="times" value="${esc(s.times)}" placeholder="2"></label>
        <label class="field">1st ending bars<input type="text" data-sec="${i}" data-f="ending1" data-chordbox inputmode="${keyboardHidden() ? 'none' : 'text'}" value="${esc(s.ending1)}" placeholder="e.g. B/A" ${NO_AUTO}></label>
        <label class="field">2nd ending bars<input type="text" data-sec="${i}" data-f="ending2" data-chordbox inputmode="${keyboardHidden() ? 'none' : 'text'}" value="${esc(s.ending2)}" placeholder="e.g. B" ${NO_AUTO}></label>
      </div>
      <label class="check"><input type="checkbox" data-sec="${i}" data-f="keepEndings" ${s.keepEndings ? 'checked' : ''}> Keep both endings on one line (squeezes that line)</label>` : ''}
    <div class="row" style="margin-top:8px"><label class="field">Key change (moves this section's chords)<select data-sec="${i}" data-f="keyChange">${keyChangeOptions(song, s)}</select></label></div>
    <div class="row" style="margin-top:8px"><label class="field">Note above the first bar<input type="text" data-sec="${i}" data-f="note" value="${esc(s.note)}" placeholder="e.g. Cont. 8ths feel / and accents" autocomplete="off"></label></div>
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
      ${r('C ^F', '<b>^</b> pushes a chord an eighth early: here F lands on the “and” of 2. The bar is written in rhythm notation.')}
      ${r('C | ^F', 'A push onto beat 1: F comes in on the “and” of 4 of the C bar and is tied over the barline.')}
      ${r('|: G | C :|', 'Repeat signs anywhere in a section. <code>:|:</code> ends one repeat and starts the next.')}
      ${r('G | % | % | %', '<b>%</b> is a one-bar repeat sign (play the previous bar again).')}
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
    let res;
    try {
      res = renderSong(song, { paper: state.prefs.paper });
    } catch (err) {
      console.error(err);
      pagesEl.innerHTML = `<div class="warn">The chart couldn’t be drawn: ${esc(err && err.message)}. Please send Claude a screenshot of this message.</div>`;
      return;
    }
    pagesEl.innerHTML = '';
    res.pages.forEach((p) => {
      const w = document.createElement('div');
      w.className = 'page-wrap';
      w.appendChild(p);
      pagesEl.appendChild(w);
    });
    $('#preview-info').innerHTML = `${esc(`Key of ${res.key} · ${res.pages.length} page${res.pages.length === 1 ? '' : 's'} · ${PAPER[state.prefs.paper].label}`)}${res.layoutNote ? `<br>${esc(res.layoutNote)}` : ''}`;
    const warn = $('#warnings');
    if (warn) warn.innerHTML = res.warnings.length ? `<div class="warn">${res.warnings.slice(0, 6).map(esc).join('<br>')}</div>` : '';
  };
  if (immediate) go(); else previewTimer = setTimeout(go, 350);
}

// Every key of the song's kind (major or minor), with both spellings where there are two.
function transposeOptions(song) {
  const minor = /m$/.test(song.key);
  const now = shownKey(song);
  return KEYS.filter((k) => /m$/.test(k) === minor).map((k) => `<option value="${k}" ${k === now ? 'selected' : ''}>${esc(prettyChord(k))}</option>`).join('');
}

// "Key change" choices for a section, named in the key the song is shown in.
function keyChangeOptions(song, sec) {
  const base = shownKey(song);
  const shift = parseInt(sec.shift, 10) || 0;
  const cur = shift ? sectionKey(base, shift, sec.shiftKey) : '';
  let html = `<option value="0|" ${shift ? '' : 'selected'}>No key change</option>`;
  for (const n of [1, 2, 3, 4, 5, 6, -1, -2, -3, -4, -5]) {
    keySpellings(keyName(base, n)).forEach((k) => {
      const label = `${keyText(k)} (${n > 0 ? 'up' : 'down'} ${Math.abs(n)})`;
      html += `<option value="${n}|${k}" ${shift === n && cur === k ? 'selected' : ''}>${esc(label)}</option>`;
    });
  }
  return html;
}

function updateTransposeUi(song) {
  const t = song.transpose || 0;
  $('#keyshow').innerHTML = transposeOptions(song);
  $('#trinfo').textContent = transposeInfo(song);
  $('[data-act="tr-reset"]').disabled = !t && !song.keyPref;
}

function afterTranspose(song) {
  song.updated = Date.now();
  store.save();
  updateTransposeUi(song);
  // Section key-change choices are named in the key shown, so refresh them when it moves.
  $$('select[data-f="keyChange"]').forEach((sel) => {
    const sec = song.sections[+sel.dataset.sec];
    if (sec) sel.innerHTML = keyChangeOptions(song, sec);
  });
  renderPreview(song);
}

// "Transpose to" a key picked from the list (sets the spelling too: F# or Gb).
app.addEventListener('change', (e) => {
  if (e.target.id !== 'keyshow') return;
  const song = currentSong();
  if (!song) return;
  const k = e.target.value;
  song.transpose = wrapSteps(pcOf(k) - pcOf(song.key));
  song.keyPref = k;
  afterTranspose(song);
});

// Field edits (song + sections). Checkboxes use "change" (older iOS), everything else "input".
const onSongField = (e) => {
  const song = currentSong();
  if (!song) return;
  const tgt = e.target;
  if ((tgt.type === 'checkbox') !== (e.type === 'change')) return;
  if (tgt.dataset.song) {
    song[tgt.dataset.song] = tgt.type === 'checkbox' ? tgt.checked : tgt.value;
    if (tgt.dataset.song === 'tuning') drawEditPane(song);
    if (tgt.dataset.song === 'title') $('#top-title').textContent = tgt.value || 'New song';
    if (tgt.dataset.song === 'key') { song.keyPref = ''; drawEditPane(song); refreshPalette(); }
    if (tgt.dataset.song === 'chordStyle') { updateTransposeUi(song); refreshPalette(); }
  } else if (tgt.dataset.sec != null) {
    const sec = song.sections[+tgt.dataset.sec];
    if (!sec) return;
    if (tgt.dataset.f === 'keyChange') {
      const [n, k] = tgt.value.split('|');
      sec.shift = parseInt(n, 10) || 0;
      sec.shiftKey = sec.shift ? k : '';
    } else if (tgt.type === 'checkbox') sec[tgt.dataset.f] = tgt.checked;
    else sec[tgt.dataset.f] = tgt.value;
    if (tgt.dataset.f === 'repeat') drawEditPane(song);
    if (tgt.dataset.f === 'bars' || tgt.dataset.f === 'label') {
      // Keep the "Repeat a section" buttons and any repeat cards up to date while typing.
      const rc = $('#repeat-chips');
      if (rc) rc.innerHTML = repeatChips(song);
      $$('.linked-card').forEach((card) => {
        const j = +card.dataset.index;
        const holder = document.createElement('div');
        holder.innerHTML = linkedCard(song, song.sections[j], j);
        card.parentNode.insertBefore(holder.firstElementChild, card);
        card.parentNode.removeChild(card);
      });
    }
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

// ---------- PDF / print ----------
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
    sheet.innerHTML = `<h3>Couldn’t make the PDF</h3><p>${esc(err && err.message)}</p><p class="small muted">A screenshot of this helps Claude fix it.</p><div class="actions"><button class="btn" data-m="close">Close</button></div>`;
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
  const i = +btn.dataset.i;

  switch (act) {
    case 'new-song': {
      if (photoOK) { newSongSheet(); break; }
      const s = store.newSong();
      state.songs.push(s);
      store.save(true);
      sessionStorageSet('view', 'edit');
      navigate(`/song/${s.id}`);
      break;
    }
    case 'new-blank': {
      closeModal();
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
      song.keyPref = '';
      afterTranspose(song);
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
    case 'add-link': {
      const src = song.sections.find((x) => x.id === btn.dataset.id);
      if (!src) break;
      song.sections.push({ id: store.uid(), linkTo: src.id, pageBreak: false });
      store.save(); drawEditPane(song); renderPreview(song);
      $$('.section-card').pop()?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(`Added ${src.label || 'section'} again`);
      break;
    }
    case 'sec-unlink': {
      // Turn the repeat into its own section, starting from the original's chords.
      const r = resolveSection(song, song.sections[i]);
      song.sections[i] = { ...r, id: store.uid(), linkTo: undefined, _idx: undefined };
      delete song.sections[i].linkTo;
      delete song.sections[i]._idx;
      store.save(); drawEditPane(song); renderPreview(song);
      const card = $$('.section-card')[i];
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('textarea', card)?.focus({ preventScroll: true });
      break;
    }
    case 'sec-del':
      askConfirm(`Delete section ${i + 1}${resolveSection(song, song.sections[i]).label ? ` (${resolveSection(song, song.sections[i]).label})` : ''}?${!song.sections[i].linkTo && song.sections.some((x) => x.linkTo === song.sections[i].id) ? ' Its repeats will keep their chords.' : ''}`).then((ok) => {
        if (!ok) return;
        const gone = song.sections[i];
        // Repeats of a deleted section keep their music as their own sections.
        song.sections.forEach((x, j) => {
          if (x.linkTo === gone.id) song.sections[j] = { ...gone, id: store.uid(), pageBreak: !!x.pageBreak };
        });
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
      makePdf(() => renderSong(song, { paper: state.prefs.paper }).pages, `${song.title || 'Chart'}${song.transpose || song.keyPref ? ` - ${shownKey(song)}` : ''}`);
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
        if (m === 'del') deleteSongs([song.id]).then((ok) => ok && navigate('/'));
      });
      break;
    }
    case 'song-del':
      deleteSongs([song.id]).then((ok) => ok && navigate('/'));
      break;
    case 'select-start':
      selecting = btn.dataset.kind; selected.clear(); route();
      break;
    case 'select-done':
      selecting = null; selected.clear(); route();
      break;
    case 'settings': settingsSheet(); break;
    case 'paste-song': pasteSong(); break;
    case 'select-all': {
      const ids = state.songs.map((x) => x.id);
      const all = ids.every((id) => selected.has(id));
      ids.forEach((id) => (all ? selected.delete(id) : selected.add(id)));
      route();
      break;
    }
    case 'delete-selected': {
      const ids = [...selected];
      deleteSongs(ids).then((ok) => {
        if (!ok) return;
        selected.clear();
        if (!state.songs.length) selecting = null;
        route();
      });
      break;
    }
  }
});

// Show unexpected errors instead of failing silently (a screenshot then pinpoints the problem).
window.addEventListener('error', (e) => toast(`Something went wrong: ${e.message || 'unknown error'}`, 6000));
window.addEventListener('unhandledrejection', (e) => toast(`Something went wrong: ${(e.reason && e.reason.message) || e.reason || 'unknown error'}`, 6000));

// Save immediately when the app is backgrounded (iOS may kill it).
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.save(true); });

// ---------- start ----------
(async function start() {
  app.innerHTML = '<div class="spinner" style="margin-top:40px"></div><p class="empty">Opening your charts…</p>';
  store.setSaveErrorHandler(() => toast('Couldn’t save that change. Check your connection.'));
  state = await store.load();
  setChordSize(state.prefs.chordSize);
  initPalette(() => currentSong()?.key || 'C', () => currentSong()?.chordStyle || 'short', (style) => {
    const song = currentSong();
    if (!song) return;
    song.chordStyle = style;
    store.save();
    const sel = $('[data-song="chordStyle"]');
    if (sel) sel.value = style;
    renderPreview(song, false);
  });
  await loadFonts();
  route();
  photoImportAvailable().then((ok) => { photoOK = ok; });
  if (!ARTIFACT && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
