// Buchdaten zu einer ISBN aus öffentlichen Quellen holen.
// Alle Quellen werden parallel abgefragt; fehlende Felder werden aus der nächsten Quelle ergänzt.

const TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function https(url) {
  return url ? url.replace(/^http:\/\//, 'https://') : '';
}

function year(dateStr) {
  const m = String(dateStr || '').match(/\d{4}/);
  return m ? m[0] : '';
}

async function googleBooks(isbn) {
  const res = await fetchWithTimeout(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
  const data = await res.json();
  const v = data.items?.[0]?.volumeInfo;
  if (!v) return null;
  return {
    title: v.title || '',
    subtitle: v.subtitle || '',
    authors: v.authors || [],
    publisher: v.publisher || '',
    year: year(v.publishedDate),
    pages: v.pageCount || null,
    language: v.language || '',
    cover: https(v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || ''),
    description: v.description || '',
  };
}

async function openLibrary(isbn) {
  const key = `ISBN:${isbn}`;
  const res = await fetchWithTimeout(`https://openlibrary.org/api/books?bibkeys=${key}&format=json&jscmd=data`);
  const data = await res.json();
  const v = data[key];
  if (!v) return null;
  return {
    title: v.title || '',
    subtitle: v.subtitle || '',
    authors: (v.authors || []).map(a => a.name),
    publisher: v.publishers?.[0]?.name || '',
    year: year(v.publish_date),
    pages: v.number_of_pages || null,
    language: '',
    cover: https(v.cover?.medium || ''),
    description: '',
  };
}

// Deutsche Nationalbibliothek (SRU, Dublin Core). Gut für deutschsprachige Titel.
async function dnb(isbn) {
  const q = encodeURIComponent(`num=${isbn}`);
  const res = await fetchWithTimeout(
    `https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=${q}&recordSchema=oai_dc&maximumRecords=1`
  );
  const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
  const get = tag => [...xml.getElementsByTagNameNS('*', tag)].map(n => n.textContent.trim());
  const rawTitle = get('title')[0];
  if (!rawTitle) return null;
  // DNB-Titel haben die Form "Titel : Untertitel / Verfasserangabe"
  // ggf. vorangestelltes "[Autor] ; " entfernen
  const [titlePart] = rawTitle.replace(/^\[[^\]]*\]\s*;\s*/, '').split(' / ');
  const [title, subtitle = ''] = titlePart.split(' : ');
  const authors = get('creator')
    .map(c => c.replace(/\s*\[.*?\]\s*/g, '').trim())
    .map(c => {
      const [last, first] = c.split(',').map(s => s.trim());
      return first ? `${first} ${last}` : last;
    });
  return {
    title: title.trim(),
    subtitle: subtitle.trim(),
    authors,
    publisher: (get('publisher')[0] || '').replace(/^.*?:\s*/, ''),
    year: year(get('date')[0]),
    pages: Number((get('format')[0] || '').match(/(\d+)\s*S\./)?.[1]) || null,
    language: get('language')[0] || '',
    cover: '', // DNB-Cover sind hinter einem Bot-Schutz und laden nicht als <img>
    description: '',
  };
}

const FIELDS = ['title', 'subtitle', 'authors', 'publisher', 'year', 'pages', 'language', 'cover', 'description'];

function isEmpty(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

export async function lookup(isbn) {
  const results = await Promise.allSettled([googleBooks(isbn), dnb(isbn), openLibrary(isbn)]);
  const found = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  if (!found.length) return null;

  const merged = {};
  for (const f of FIELDS) {
    const src = found.find(r => !isEmpty(r[f]));
    merged[f] = src ? src[f] : (f === 'authors' ? [] : f === 'pages' ? null : '');
  }
  if (!merged.cover) {
    // Fallback-Cover über die ISBN; lädt nicht, falls keins existiert.
    merged.cover = `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;
  }
  return merged;
}
