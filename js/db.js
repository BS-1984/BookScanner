// IndexedDB-Speicher für die Büchersammlung.
// Bei max. ~5000 Büchern wird die ganze Sammlung beim Start in den Speicher geladen;
// Suche und Abgleich laufen danach rein im RAM.

const DB_NAME = 'bookscanner';
const DB_VERSION = 1;
const STORE = 'books';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('isbn', 'isbn', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function getAll() {
  return tx('readonly', store => new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function put(book) {
  return tx('readwrite', store => { store.put(book); return book; });
}

export function remove(id) {
  return tx('readwrite', store => { store.delete(id); });
}

export function putMany(books) {
  return tx('readwrite', store => { books.forEach(b => store.put(b)); return books.length; });
}

export function clear() {
  return tx('readwrite', store => { store.clear(); });
}

// Bittet den Browser, die Daten nicht bei Speicherknappheit zu löschen.
export async function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}
