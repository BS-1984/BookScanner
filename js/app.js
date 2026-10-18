import * as db from './db.js';
import * as ISBN from './isbn.js';
import { lookup } from './lookup.js';
import { Scanner, isSupported } from './scanner.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PAGE_SIZE = 60;
const BACKUP_REMINDER_DAYS = 30;

const state = {
  books: [],
  byIsbn: new Map(),
  hay: new Map(),      // id -> normalisierter Suchtext
  titleKey: new Map(), // id -> normalisierter Titel für den Ähnlichkeitsabgleich
  view: 'library',
  query: '',
  sort: 'added',
  limit: PAGE_SIZE,
};

const settings = {
  get sound() { return load('sound', true); },
  set sound(v) { save('sound', v); },
  get vibrate() { return load('vibrate', true); },
  set vibrate(v) { save('vibrate', v); },
  get quick() { return load('quick', false); },
  set quick(v) { save('quick', v); },
  get lastBackup() { return load('lastBackup', null); },
  set lastBackup(v) { save('lastBackup', v); },
};

function load(key, fallback) {
  try {
    const v = localStorage.getItem('bs.' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

function save(key, value) {
  try { localStorage.setItem('bs.' + key, JSON.stringify(value)); } catch { /* egal */ }
}

// ---------- Hilfsfunktionen ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ARTICLES = /^(der|die|das|ein|eine|the|a|an|le|la|les|il|lo|el)\s+/;

function makeTitleKey(title) {
  return norm(title).replace(ARTICLES, '');
}

function surnames(authors) {
  return (authors || []).map(a => norm(a).split(' ').pop()).filter(Boolean);
}

function uid() {
  return crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('de-DE') : '';
}

function displayTitle(b) {
  return b.title || (b.isbn ? `ISBN ${ISBN.format(b.isbn)}` : 'Ohne Titel');
}

function toIsbn(raw) {
  const s = ISBN.clean(raw);
  if (ISBN.isBookEan(s)) return s;
  return ISBN.normalize(s);
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- Feedback (Ton + Vibration) ----------

let audioCtx = null;
document.addEventListener('pointerdown', () => {
  if (!audioCtx) {
    try { audioCtx = new AudioContext(); } catch { /* kein Audio */ }
  }
}, { once: true });

function tone(freq, start, dur) {
  const t0 = audioCtx.currentTime + start;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = freq;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function feedback(kind) {
  const patterns = {
    owned: { vib: [250, 100, 250, 100, 400], tones: [[330, 0, 0.18], [260, 0.22, 0.3]] },
    similar: { vib: [120, 80, 120], tones: [[660, 0, 0.1], [660, 0.15, 0.1]] },
    new: { vib: [60], tones: [[1200, 0, 0.09]] },
  };
  const p = patterns[kind];
  if (!p) return;
  if (settings.vibrate && navigator.vibrate) navigator.vibrate(p.vib);
  if (settings.sound && audioCtx) {
    audioCtx.resume?.();
    p.tones.forEach(([f, s, d]) => tone(f, s, d));
  }
}

// ---------- Datenhaltung ----------

function rebuildIndex() {
  state.byIsbn.clear();
  state.hay.clear();
  state.titleKey.clear();
  for (const b of state.books) {
    if (b.isbn) state.byIsbn.set(b.isbn, b);
    state.hay.set(b.id, norm([
      b.title, b.subtitle, (b.authors || []).join(' '), b.publisher, b.year,
      b.isbn, ISBN.to10(b.isbn || '') || '', b.location, (b.tags || []).join(' '), b.notes,
    ].join(' ')));
    state.titleKey.set(b.id, makeTitleKey(b.title));
  }
}

function makeBook(isbn, data) {
  const now = new Date().toISOString();
  return {
    id: uid(),
    isbn: isbn || '',
    title: data?.title || '',
    subtitle: data?.subtitle || '',
    authors: data?.authors || [],
    publisher: data?.publisher || '',
    year: data?.year || '',
    pages: data?.pages || null,
    language: data?.language || '',
    cover: data?.cover || '',
    description: data?.description || '',
    location: '',
    condition: '',
    price: '',
    tags: [],
    notes: '',
    addedAt: now,
    updatedAt: now,
    needsLookup: !!isbn && !data,
  };
}

async function saveBook(book) {
  book.updatedAt = new Date().toISOString();
  await db.put(book);
  const i = state.books.findIndex(b => b.id === book.id);
  if (i >= 0) state.books[i] = book; else state.books.push(book);
  rebuildIndex();
  renderLibrary();
  return book;
}

async function deleteBook(id) {
  await db.remove(id);
  state.books = state.books.filter(b => b.id !== id);
  rebuildIndex();
  renderLibrary();
}

function findSimilar(book) {
  const key = makeTitleKey(book.title);
  if (!key) return [];
  const names = surnames(book.authors);
  return state.books.filter(x => {
    if (x.id === book.id || (book.isbn && x.isbn === book.isbn)) return false;
    if (state.titleKey.get(x.id) !== key) return false;
    const other = surnames(x.authors);
    return !names.length || !other.length || other.some(n => names.includes(n));
  });
}

// ---------- Ansicht: Sammlung ----------

const SORTERS = {
  added: (a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''),
  title: (a, b) => displayTitle(a).localeCompare(displayTitle(b), 'de', { sensitivity: 'base' }),
  author: (a, b) => {
    const ka = surnames(a.authors)[0] || '~';
    const kb = surnames(b.authors)[0] || '~';
    return ka.localeCompare(kb, 'de') || SORTERS.title(a, b);
  },
  year: (a, b) => (b.year || '').localeCompare(a.year || ''),
  location: (a, b) => (a.location || '~').localeCompare(b.location || '~', 'de') || SORTERS.title(a, b),
};

function filtered() {
  let q = state.query.trim();
  // ISBN mit Bindestrichen/Leerzeichen als einen Suchbegriff behandeln
  if (/^[\d\s-]+[xX]?$/.test(q) && ISBN.clean(q).length >= 4) q = ISBN.clean(q).toLowerCase();
  const tokens = norm(q).split(' ').filter(Boolean);
  const list = tokens.length
    ? state.books.filter(b => {
        const h = state.hay.get(b.id) || '';
        return tokens.every(t => h.includes(t));
      })
    : state.books.slice();
  return list.sort(SORTERS[state.sort] || SORTERS.added);
}

function coverHtml(b, cls = 'cover') {
  return b.cover
    ? `<img class="${cls}" src="${esc(b.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="${cls} ph" aria-hidden="true"></div>`;
}

function bookCardHtml(b) {
  const sub = [b.year, b.publisher].filter(Boolean).join(' · ');
  return `<li class="book" data-id="${esc(b.id)}">
    ${coverHtml(b)}
    <div class="meta">
      <strong>${esc(displayTitle(b))}</strong>
      ${b.authors?.length ? `<span>${esc(b.authors.join(', '))}</span>` : ''}
      ${sub ? `<span class="small">${esc(sub)}</span>` : ''}
      ${b.location ? `<span class="tag">${esc(b.location)}</span>` : ''}
      ${b.needsLookup ? `<span class="tag warn">Daten fehlen</span>` : ''}
    </div>
  </li>`;
}

function renderLibrary() {
  const list = filtered();
  const total = state.books.length;
  $('#lib-count').textContent = state.query
    ? `${list.length} von ${total} Büchern`
    : `${total} ${total === 1 ? 'Buch' : 'Bücher'}`;
  $('#book-list').innerHTML = list.slice(0, state.limit).map(bookCardHtml).join('');
  $('#list-sentinel').hidden = list.length <= state.limit;
  $('#lib-empty').hidden = total > 0;
  $('#lib-noresult').hidden = !(total > 0 && list.length === 0);

  const last = settings.lastBackup;
  const stale = !last || (Date.now() - new Date(last).getTime()) > BACKUP_REMINDER_DAYS * 864e5;
  $('#backup-banner').hidden = !(stale && total >= 20);
}

function setupLibrary() {
  let t;
  $('#search').addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.query = e.target.value;
      state.limit = PAGE_SIZE;
      renderLibrary();
    }, 120);
  });
  $('#sort').value = state.sort;
  $('#sort').addEventListener('change', e => {
    state.sort = e.target.value;
    state.limit = PAGE_SIZE;
    renderLibrary();
  });
  $('#book-list').addEventListener('click', e => {
    const li = e.target.closest('.book');
    const book = li && state.books.find(b => b.id === li.dataset.id);
    if (book) openEditor(book, false);
  });
  new IntersectionObserver(entries => {
    if (entries.some(en => en.isIntersecting) && !$('#list-sentinel').hidden) {
      state.limit += PAGE_SIZE;
      renderLibrary();
    }
  }, { rootMargin: '400px' }).observe($('#list-sentinel'));
  $('#backup-banner').addEventListener('click', () => showView('more'));
}

// Kaputte Cover-Links durch Platzhalter ersetzen
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.classList.contains('cover')) {
    const ph = document.createElement('div');
    ph.className = img.className + ' ph';
    img.replaceWith(ph);
  }
}, true);

// ---------- Editor-Dialog ----------

let editing = null;

function fillLocations() {
  const locs = [...new Set(state.books.map(b => b.location).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  $('#locations').innerHTML = locs.map(l => `<option value="${esc(l)}">`).join('');
}

function fillEditor(b) {
  const f = $('#editor-form').elements;
  f.isbn.value = b.isbn ? ISBN.format(b.isbn) : '';
  f.title.value = b.title || '';
  f.subtitle.value = b.subtitle || '';
  f.authors.value = (b.authors || []).join(', ');
  f.publisher.value = b.publisher || '';
  f.year.value = b.year || '';
  f.pages.value = b.pages || '';
  f.location.value = b.location || '';
  f.condition.value = b.condition || '';
  f.price.value = b.price || '';
  f.tags.value = (b.tags || []).join(', ');
  f.notes.value = b.notes || '';
  $('#ed-cover').innerHTML = coverHtml(b, 'cover big');
  $('#ed-meta').textContent = b.addedAt && !editing?.isNew ? `Aufgenommen am ${fmtDate(b.addedAt)}` : '';
  updateEditorHint();
}

function readEditor(b) {
  const f = $('#editor-form').elements;
  const list = s => s.split(',').map(x => x.trim()).filter(Boolean);
  b.isbn = ISBN.normalize(f.isbn.value) || ISBN.clean(f.isbn.value);
  b.title = f.title.value.trim();
  b.subtitle = f.subtitle.value.trim();
  b.authors = list(f.authors.value);
  b.publisher = f.publisher.value.trim();
  b.year = f.year.value.trim();
  b.pages = Number(f.pages.value) || null;
  b.location = f.location.value.trim();
  b.condition = f.condition.value;
  b.price = f.price.value.trim();
  b.tags = list(f.tags.value);
  b.notes = f.notes.value.trim();
  if (b.title) b.needsLookup = false;
  return b;
}

function updateEditorHint() {
  if (!editing) return;
  const f = $('#editor-form').elements;
  const probe = {
    id: editing.book.id,
    isbn: ISBN.normalize(f.isbn.value) || '',
    title: f.title.value,
    authors: f.authors.value.split(',').map(s => s.trim()).filter(Boolean),
  };
  const hint = $('#ed-hint');
  const dup = probe.isbn && state.byIsbn.get(probe.isbn);
  if (dup && dup.id !== probe.id) {
    hint.textContent = 'Diese ISBN ist bereits in deiner Sammlung.';
    hint.className = 'hint owned';
  } else {
    const sim = findSimilar(probe);
    hint.textContent = sim.length ? `Ähnlicher Titel vorhanden: ${displayTitle(sim[0])}${sim[0].isbn ? ' (ISBN ' + ISBN.format(sim[0].isbn) + ')' : ''}` : '';
    hint.className = sim.length ? 'hint similar' : 'hint';
  }
  hint.hidden = !hint.textContent;
}

function openEditor(book, isNew) {
  return new Promise(resolve => {
    editing = { book: structuredClone(book), isNew, resolve };
    fillLocations();
    fillEditor(editing.book);
    $('#ed-heading').textContent = isNew ? 'Neues Buch' : 'Buch bearbeiten';
    $('#ed-delete').hidden = isNew;
    $('#editor').showModal();
  });
}

function closeEditor(result) {
  const ed = editing;
  editing = null;
  $('#editor').close();
  ed?.resolve(result);
}

function setupEditor() {
  const form = $('#editor-form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const action = e.submitter?.value;
    if (!editing) return;
    if (action === 'save') {
      const b = readEditor(editing.book);
      if (!b.title && !b.isbn) {
        const hint = $('#ed-hint');
        hint.textContent = 'Bitte mindestens Titel oder ISBN angeben.';
        hint.className = 'hint owned';
        hint.hidden = false;
        return;
      }
      const dup = b.isbn && state.byIsbn.get(b.isbn);
      if (editing.isNew && dup && !confirm('Diese ISBN ist schon in der Sammlung. Trotzdem als weiteres Exemplar speichern?')) return;
      await saveBook(b);
      toast(editing.isNew ? 'Zur Sammlung hinzugefügt' : 'Gespeichert');
      closeEditor(b);
    } else if (action === 'delete') {
      if (!confirm(`„${displayTitle(editing.book)}“ wirklich löschen?`)) return;
      await deleteBook(editing.book.id);
      toast('Gelöscht');
      closeEditor(null);
    } else {
      closeEditor(null);
    }
  });
  $('#editor').addEventListener('close', () => {
    if (editing) { const ed = editing; editing = null; ed.resolve(null); }
  });
  form.elements.isbn.addEventListener('change', updateEditorHint);
  form.elements.title.addEventListener('change', updateEditorHint);
  form.elements.authors.addEventListener('change', updateEditorHint);

  $('#ed-reload').addEventListener('click', async () => {
    const isbn = ISBN.normalize(form.elements.isbn.value);
    if (!isbn) { toast('Keine gültige ISBN'); return; }
    if (!navigator.onLine) { toast('Keine Internetverbindung'); return; }
    const btn = $('#ed-reload');
    btn.disabled = true;
    btn.textContent = 'Lädt…';
    try {
      const data = await lookup(isbn);
      if (!data) { btn.textContent = 'Keine Daten gefunden'; await new Promise(r => setTimeout(r, 1500)); return; }
      Object.assign(editing.book, {
        isbn, title: data.title, subtitle: data.subtitle, authors: data.authors, publisher: data.publisher,
        year: data.year, pages: data.pages, language: data.language, cover: data.cover, description: data.description,
        needsLookup: false,
      });
      // persönliche Felder aus dem Formular übernehmen, Metadaten neu füllen
      const f = form.elements;
      const keep = { location: f.location.value, condition: f.condition.value, price: f.price.value, tags: f.tags.value, notes: f.notes.value };
      fillEditor(editing.book);
      Object.entries(keep).forEach(([k, v]) => { f[k].value = v; });
    } catch {
      toast('Abruf fehlgeschlagen');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Daten neu laden';
    }
  });
}

// ---------- Kamera-Verwaltung ----------

const scanners = {};

async function startCamera(name, onCode) {
  const msg = $(`#${name}-cam-msg`);
  const torch = $(`[data-torch="${name}"]`);
  msg.hidden = true;
  torch.hidden = true;
  if (!window.isSecureContext) {
    msg.textContent = 'Die Kamera funktioniert nur über HTTPS. Bitte die App über die https-Adresse öffnen.';
    msg.hidden = false;
    return;
  }
  if (!isSupported()) {
    msg.textContent = 'Dieser Browser unterstützt keine Barcode-Erkennung. Bitte Chrome auf Android verwenden – oder die ISBN unten eintippen.';
    msg.hidden = false;
    return;
  }
  scanners[name] ||= new Scanner($(`#${name}-video`));
  try {
    await scanners[name].start(onCode);
    torch.hidden = !scanners[name].hasTorch();
    torch.classList.remove('on');
  } catch (err) {
    msg.textContent = err?.name === 'NotAllowedError'
      ? 'Kamerazugriff wurde verweigert. Erlaube ihn in den Website-Einstellungen von Chrome.'
      : `Kamera konnte nicht gestartet werden (${err?.message || err}).`;
    msg.hidden = false;
  }
}

function stopCameras() {
  Object.values(scanners).forEach(s => s.stop());
}

function setupTorchButtons() {
  $$('[data-torch]').forEach(btn => btn.addEventListener('click', async () => {
    const s = scanners[btn.dataset.torch];
    if (!s) return;
    const on = await s.toggleTorch();
    btn.classList.toggle('on', on);
  }));
}

// ---------- Ansicht: Aufnehmen ----------

const add = { busy: false, last: '', lastAt: 0 };

function renderAddStatus(book, label, kind) {
  const el = $('#add-status');
  el.className = `status-card ${kind}`;
  el.innerHTML = `
    ${coverHtml(book)}
    <div class="meta">
      <span class="label">${esc(label)}</span>
      <strong>${esc(displayTitle(book))}</strong>
      ${book.authors?.length ? `<span>${esc(book.authors.join(', '))}</span>` : ''}
    </div>
    <button type="button" class="btn small" data-edit="${esc(book.id)}">Bearbeiten</button>`;
  el.hidden = false;
}

async function handleAddCode(raw, manual = false) {
  if (editing || add.busy) return;
  const isbn = toIsbn(raw);
  if (!isbn) {
    if (manual) toast('Ungültige ISBN');
    return;
  }
  if (!manual && isbn === add.last && Date.now() - add.lastAt < 4000) return;
  add.last = isbn;
  add.lastAt = Date.now();
  add.busy = true;
  try {
    const existing = state.byIsbn.get(isbn);
    if (existing) {
      feedback('owned');
      renderAddStatus(existing, 'Bereits in der Sammlung', 'owned');
      return;
    }
    feedback('new');
    const el = $('#add-status');
    el.className = 'status-card';
    el.innerHTML = `<div class="meta"><span class="label">ISBN ${esc(ISBN.format(isbn))}</span><strong>Suche Buchdaten…</strong></div>`;
    el.hidden = false;

    const data = navigator.onLine ? await lookup(isbn).catch(() => null) : null;
    const book = makeBook(isbn, data);
    if (settings.quick) {
      await saveBook(book);
      renderAddStatus(book, data ? 'Hinzugefügt' : 'Hinzugefügt – Daten später nachladen', data ? 'new' : 'similar');
    } else {
      const saved = await openEditor(book, true);
      if (saved) renderAddStatus(saved, 'Hinzugefügt', 'new');
      else el.hidden = true;
    }
  } finally {
    add.busy = false;
    add.lastAt = Date.now();
  }
}

function setupAdd() {
  const quick = $('#quick-mode');
  quick.checked = settings.quick;
  quick.addEventListener('change', () => { settings.quick = quick.checked; });
  $('#add-manual').addEventListener('submit', e => {
    e.preventDefault();
    const input = e.target.elements.code;
    handleAddCode(input.value, true);
    input.value = '';
  });
  $('#add-noisbn').addEventListener('click', async () => {
    const saved = await openEditor(makeBook('', null), true);
    if (saved) renderAddStatus(saved, 'Hinzugefügt', 'new');
  });
  $('#add-status').addEventListener('click', e => {
    const id = e.target.closest('[data-edit]')?.dataset.edit;
    const book = id && state.books.find(b => b.id === id);
    if (book) openEditor(book, false).then(saved => { if (saved) renderAddStatus(saved, 'Gespeichert', 'new'); });
  });
}

// ---------- Ansicht: Einkauf / Auto-Abgleich ----------

const shop = { isbn: '', token: 0, current: null, history: [] };

const VERDICT = {
  idle: { title: 'Bereit', text: 'Halte den Barcode eines Buches in den Rahmen.' },
  owned: { title: 'Hast du schon!' },
  similar: { title: 'Ähnliche Ausgabe vorhanden' },
  new: { title: 'Nicht in deiner Sammlung' },
};

function renderShop() {
  const c = shop.current;
  const el = $('#shop-result');
  if (!c) {
    el.className = 'shop-result idle';
    el.innerHTML = `<div class="verdict">${VERDICT.idle.title}</div><p>${VERDICT.idle.text}</p>`;
    return;
  }
  const b = c.book;
  let details = '';
  if (c.kind === 'owned') {
    details = [
      `Aufgenommen am ${fmtDate(b.addedAt)}`,
      b.location && `Standort: ${b.location}`,
      b.condition && `Zustand: ${b.condition}`,
    ].filter(Boolean).map(esc).join('<br>');
  } else if (c.kind === 'similar') {
    details = c.similar.slice(0, 3).map(s =>
      `Du hast: <b>${esc(displayTitle(s))}</b>${s.year ? ` (${esc(s.year)})` : ''}${s.isbn ? ` · ISBN ${esc(ISBN.format(s.isbn))}` : ''}`
    ).join('<br>');
  } else if (c.pending) {
    details = 'Prüfe auf andere Ausgaben…';
  } else if (!b.title) {
    details = navigator.onLine ? 'Keine Buchdaten gefunden.' : 'Offline – nur ISBN-Abgleich möglich.';
  }
  const actions = c.kind === 'owned'
    ? `<button type="button" class="btn" data-shop="details">Details</button>`
    : `<button type="button" class="btn primary" data-shop="add">Zur Sammlung hinzufügen</button>`;

  el.className = `shop-result ${c.kind}`;
  el.innerHTML = `
    <div class="verdict">${VERDICT[c.kind].title}</div>
    <div class="shop-book">
      ${coverHtml(b)}
      <div class="meta">
        <strong>${esc(displayTitle(b))}</strong>
        ${b.authors?.length ? `<span>${esc(b.authors.join(', '))}</span>` : ''}
        <span class="small">ISBN ${esc(ISBN.format(c.isbn))}</span>
      </div>
    </div>
    ${details ? `<p class="details">${details}</p>` : ''}
    <div class="actions">${actions}<button type="button" class="btn ghost" data-shop="reset">Nächstes</button></div>`;
}

function pushHistory(c) {
  shop.history = shop.history.filter(h => h.isbn !== c.isbn);
  shop.history.unshift({ isbn: c.isbn, kind: c.kind, title: displayTitle(c.book), at: Date.now() });
  shop.history = shop.history.slice(0, 50);
  renderShopHistory();
}

function renderShopHistory() {
  const labels = { owned: 'Vorhanden', similar: 'Ähnlich', new: 'Neu' };
  $('#shop-history').innerHTML = shop.history.map(h => `
    <li class="hist ${h.kind}" data-isbn="${esc(h.isbn)}">
      <span class="dot"></span>
      <span class="t">${esc(h.title)}</span>
      <span class="k">${labels[h.kind]}</span>
    </li>`).join('');
  $('#shop-history-wrap').hidden = !shop.history.length;
}

async function handleShopCode(raw, manual = false) {
  if (editing) return;
  const isbn = toIsbn(raw);
  if (!isbn) {
    if (manual) toast('Ungültige ISBN');
    return;
  }
  if (!manual && isbn === shop.isbn) return;
  shop.isbn = isbn;
  const token = ++shop.token;

  const owned = state.byIsbn.get(isbn);
  if (owned) {
    feedback('owned');
    shop.current = { kind: 'owned', isbn, book: owned };
    renderShop();
    pushHistory(shop.current);
    return;
  }

  // Sofortige Antwort aus der lokalen Datenbank, danach Ähnlichkeitsprüfung mit Online-Daten
  feedback('new');
  shop.current = { kind: 'new', isbn, book: makeBook(isbn, null), pending: navigator.onLine };
  renderShop();
  if (!navigator.onLine) { pushHistory(shop.current); return; }

  const data = await lookup(isbn).catch(() => null);
  if (token !== shop.token) return;
  const book = makeBook(isbn, data);
  const similar = data ? findSimilar(book) : [];
  if (similar.length) feedback('similar');
  shop.current = { kind: similar.length ? 'similar' : 'new', isbn, book, similar };
  renderShop();
  pushHistory(shop.current);
}

function setupShop() {
  $('#shop-result').addEventListener('click', async e => {
    const action = e.target.closest('[data-shop]')?.dataset.shop;
    const c = shop.current;
    if (!action) return;
    if (action === 'reset' || !c) {
      shop.current = null;
      shop.isbn = '';
      renderShop();
      return;
    }
    if (action === 'details') {
      await openEditor(c.book, false);
      const fresh = state.books.find(b => b.id === c.book.id);
      shop.current = fresh ? { ...c, book: fresh } : null;
      if (!fresh) shop.isbn = '';
      renderShop();
    } else if (action === 'add') {
      const saved = await openEditor(c.book, true);
      if (saved) {
        shop.current = { kind: 'owned', isbn: c.isbn, book: saved };
        renderShop();
        pushHistory(shop.current);
      }
    }
  });
  $('#shop-history').addEventListener('click', e => {
    const isbn = e.target.closest('.hist')?.dataset.isbn;
    if (isbn) handleShopCode(isbn, true);
  });
  $('#shop-manual').addEventListener('submit', e => {
    e.preventDefault();
    const input = e.target.elements.code;
    handleShopCode(input.value, true);
    input.value = '';
  });
  renderShop();
  renderShopHistory();
}

// ---------- Ansicht: Mehr (Export, Import, Einstellungen) ----------

const CSV_COLUMNS = [
  ['isbn', 'ISBN'], ['title', 'Titel'], ['subtitle', 'Untertitel'], ['authors', 'Autoren'],
  ['publisher', 'Verlag'], ['year', 'Jahr'], ['pages', 'Seiten'], ['language', 'Sprache'],
  ['location', 'Standort'], ['condition', 'Zustand'], ['price', 'Preis'], ['tags', 'Tags'],
  ['notes', 'Notizen'], ['addedAt', 'Aufgenommen'],
];

function toCsv(books) {
  const q = v => {
    const s = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [CSV_COLUMNS.map(c => c[1]).join(';')];
  for (const b of books) rows.push(CSV_COLUMNS.map(([k]) => q(k === 'isbn' && b.isbn ? b.isbn : b[k])).join(';'));
  return '﻿' + rows.join('\r\n');
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split('\n')[0];
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

function booksFromCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keyFor = h => {
    const n = norm(h);
    const col = CSV_COLUMNS.find(([k, label]) => norm(k) === n || norm(label) === n);
    return col?.[0] || (n === 'autor' || n === 'author' ? 'authors' : null);
  };
  const keys = header.map(keyFor);
  return rows.map(r => {
    const raw = {};
    keys.forEach((k, i) => { if (k) raw[k] = (r[i] || '').trim(); });
    const isbn = ISBN.normalize(raw.isbn || '') || ISBN.clean(raw.isbn || '');
    const b = makeBook(isbn, null);
    Object.assign(b, {
      title: raw.title || '', subtitle: raw.subtitle || '',
      authors: (raw.authors || '').split(',').map(s => s.trim()).filter(Boolean),
      publisher: raw.publisher || '', year: raw.year || '', pages: Number(raw.pages) || null,
      language: raw.language || '', location: raw.location || '', condition: raw.condition || '',
      price: raw.price || '', tags: (raw.tags || '').split(',').map(s => s.trim()).filter(Boolean),
      notes: raw.notes || '',
    });
    if (raw.addedAt && !isNaN(Date.parse(raw.addedAt))) b.addedAt = new Date(raw.addedAt).toISOString();
    b.needsLookup = !!isbn && !b.title;
    return b;
  }).filter(b => b.isbn || b.title);
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

function backupJson() {
  return JSON.stringify({ app: 'BookScanner', version: 1, exportedAt: new Date().toISOString(), books: state.books }, null, 1);
}

function markBackup() {
  settings.lastBackup = new Date().toISOString();
  renderMore();
  renderLibrary();
}

async function importBooks(incoming) {
  const byId = new Map(state.books.map(b => [b.id, b]));
  let added = 0, updated = 0, skipped = 0;
  const toWrite = [];
  for (const raw of incoming) {
    const b = { ...makeBook(raw.isbn || '', null), ...raw };
    if (!b.id) b.id = uid();
    if (byId.has(b.id)) { toWrite.push(b); updated++; continue; }
    if (b.isbn && state.byIsbn.has(b.isbn)) { skipped++; continue; }
    toWrite.push(b);
    added++;
  }
  await db.putMany(toWrite);
  state.books = await db.getAll();
  rebuildIndex();
  renderLibrary();
  renderMore();
  return { added, updated, skipped };
}

let refreshing = false;
async function refreshMissing() {
  if (refreshing) return;
  if (!navigator.onLine) { toast('Keine Internetverbindung'); return; }
  const todo = state.books.filter(b => b.needsLookup && b.isbn);
  if (!todo.length) { toast('Nichts nachzuladen'); return; }
  refreshing = true;
  const btn = $('#btn-refresh');
  let found = 0;
  try {
    for (let i = 0; i < todo.length; i++) {
      btn.textContent = `Lade ${i + 1} / ${todo.length} …`;
      const b = todo[i];
      const data = await lookup(b.isbn).catch(() => null);
      if (data) {
        for (const k of ['title', 'subtitle', 'authors', 'publisher', 'year', 'pages', 'language', 'cover', 'description']) {
          const empty = b[k] == null || b[k] === '' || (Array.isArray(b[k]) && !b[k].length);
          if (empty) b[k] = data[k];
        }
        b.needsLookup = false;
        b.updatedAt = new Date().toISOString();
        await db.put(b);
        found++;
      }
      await new Promise(r => setTimeout(r, 250));
    }
  } finally {
    refreshing = false;
    rebuildIndex();
    renderLibrary();
    renderMore();
    toast(`${found} von ${todo.length} Büchern ergänzt`);
  }
}

async function renderMore() {
  const total = state.books.length;
  const authors = new Set(state.books.flatMap(b => b.authors || [])).size;
  const missing = state.books.filter(b => b.needsLookup).length;
  $('#stat-books').textContent = total;
  $('#stat-authors').textContent = authors;
  $('#stat-missing').textContent = missing;
  if (!refreshing) {
    $('#btn-refresh').textContent = missing ? `Fehlende Daten nachladen (${missing})` : 'Fehlende Daten nachladen';
  }
  $('#btn-refresh').disabled = !missing;
  const last = settings.lastBackup;
  $('#last-backup').textContent = last ? `Letztes Backup: ${fmtDate(last)}` : 'Noch kein Backup erstellt.';
  $('#btn-share').hidden = !(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.json', { type: 'application/json' })] }));

  let storage = '';
  try {
    const persisted = await navigator.storage?.persisted?.();
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) storage += `Belegt: ${(est.usage / 1048576).toFixed(1)} MB. `;
    storage += persisted ? 'Daten sind vor automatischem Löschen geschützt.' : 'Tipp: App installieren, damit Chrome die Daten dauerhaft behält.';
  } catch { /* egal */ }
  $('#storage-info').textContent = storage;
}

function setupMore() {
  $('#btn-export-json').addEventListener('click', () => {
    download(`buecher-backup-${stamp()}.json`, backupJson(), 'application/json');
    markBackup();
  });
  $('#btn-export-csv').addEventListener('click', () => {
    download(`buecher-${stamp()}.csv`, toCsv(filteredForExport()), 'text/csv;charset=utf-8');
  });
  $('#btn-share').addEventListener('click', async () => {
    const file = new File([backupJson()], `buecher-backup-${stamp()}.json`, { type: 'application/json' });
    try {
      await navigator.share({ files: [file], title: 'Bücher-Backup' });
      markBackup();
    } catch (err) {
      if (err?.name !== 'AbortError') toast('Teilen fehlgeschlagen');
    }
  });
  $('#import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      let books;
      if (file.name.toLowerCase().endsWith('.csv')) {
        books = booksFromCsv(text);
      } else {
        const json = JSON.parse(text);
        books = Array.isArray(json) ? json : json.books;
      }
      if (!Array.isArray(books) || !books.length) { toast('Keine Bücher in der Datei gefunden'); return; }
      const r = await importBooks(books);
      toast(`${r.added} neu, ${r.updated} aktualisiert, ${r.skipped} übersprungen`);
    } catch (err) {
      toast('Datei konnte nicht gelesen werden');
      console.error(err);
    }
  });
  $('#btn-refresh').addEventListener('click', refreshMissing);
  $('#btn-clear').addEventListener('click', async () => {
    if (!state.books.length) return;
    const answer = prompt(`Alle ${state.books.length} Bücher unwiderruflich löschen?\nZum Bestätigen LÖSCHEN eintippen.`);
    if (answer?.trim().toUpperCase() !== 'LÖSCHEN') return;
    await db.clear();
    state.books = [];
    rebuildIndex();
    renderLibrary();
    renderMore();
    toast('Sammlung gelöscht');
  });
  const sound = $('#opt-sound');
  const vib = $('#opt-vibrate');
  sound.checked = settings.sound;
  vib.checked = settings.vibrate;
  sound.addEventListener('change', () => { settings.sound = sound.checked; });
  vib.addEventListener('change', () => { settings.vibrate = vib.checked; });
  $('#btn-test').addEventListener('click', () => {
    if (!audioCtx) { try { audioCtx = new AudioContext(); } catch { /* kein Audio */ } }
    feedback('owned');
  });
}

function filteredForExport() {
  return state.books.slice().sort(SORTERS.author);
}

// ---------- Navigation ----------

const TITLES = { library: 'Meine Bücher', add: 'Bücher erfassen', shop: 'Einkaufsmodus', more: 'Mehr' };

function showView(name) {
  state.view = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tabbar button').forEach(b => b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false'));
  $('#title').textContent = TITLES[name];
  stopCameras();
  if (name === 'add') startCamera('add', code => handleAddCode(code));
  if (name === 'shop') startCamera('shop', code => handleShopCode(code));
  if (name === 'more') renderMore();
  if (name === 'library') renderLibrary();
  save('view', name);
}

function setupNav() {
  $$('.tabbar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCameras();
    else if (state.view === 'add' || state.view === 'shop') showView(state.view);
  });
  window.addEventListener('online', () => { if (state.view === 'more') renderMore(); });
}

// ---------- Start ----------

async function init() {
  setupNav();
  setupLibrary();
  setupEditor();
  setupTorchButtons();
  setupAdd();
  setupShop();
  setupMore();

  try {
    state.books = await db.getAll();
  } catch (err) {
    toast('Datenbank konnte nicht geöffnet werden');
    console.error(err);
  }
  rebuildIndex();
  db.requestPersistence();

  const params = new URLSearchParams(location.search);
  const start = params.get('view') || load('view', 'library');
  showView(TITLES[start] ? start : 'library');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline-Modus nicht verfügbar */ });
  }
}

init();
