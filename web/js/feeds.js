// Feeds abrufen und parsen – Browser-Pendant zu fetch_one_feed() in app.py.

// ---- Text-Helfer ------------------------------------------------------------

export function htmlToText(s) {
  if (!s) return '';
  // Block-Tags durch Leerzeichen trennen, sonst klebt „…SciencesAuthor(s)" zusammen
  s = s.replace(/<(\/?(p|div|li|ul|ol|h\d|tr|td|blockquote)\b[^>]*|br\s*\/?)>/gi, ' $&');
  const doc = new DOMParser().parseFromString(s, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Verlags-Zitat-Präfix entfernen: "…Science, Volume 9, Issue 2, 2026. <Abstract>"
const CITATION = /^.{0,200}?\b(?:volume\s+\d+|ahead of print|early\s?view|online version of record|advance online publication)\b.{0,160}?\.\s+/i;
export function stripCitation(text) {
  return (text || '').replace(CITATION, '').trim();
}

const DOI_RE = /\b10\.\d{4,9}\/[^\s"<>?#]+/i;
export function findDoi(...sources) {
  for (const s of sources) {
    if (!s) continue;
    let t = s;
    try { t = decodeURIComponent(s); } catch { /* bleibt roh */ }
    const m = t.match(DOI_RE);
    if (m) return m[0].replace(/[.,;)\]]+$/, '');
  }
  return null;
}

export function extractStats(summary) {
  const out = {};
  if (!summary) return out;
  const n = summary.match(/\bN\s*=\s*(\d[\d,.]*)/i);
  if (n) out.N = n[1].replace(/,/g, '');
  if (/\bmeta-?analysis\b/i.test(summary)) out.meta = true;
  if (/\bpre-?registered|registered report\b/i.test(summary)) out.prereg = true;
  return out;
}

// Python-Muster wie "(?i)…" in JS-RegExp übersetzen
export function compilePattern(p, extraFlags = '') {
  let src = p, flags = '';
  const m = src.match(/^\(\?([a-z]+)\)/);
  if (m) {
    src = src.slice(m[0].length);
    for (const f of m[1]) if ('ims'.includes(f) && !flags.includes(f)) flags += f;
  }
  try { return new RegExp(src, flags + extraFlags); } catch { return null; }
}

export function matchFilters(text, includeRes, excludeRes) {
  if (includeRes.length && !includeRes.some(r => r.test(text))) return false;
  if (excludeRes.length && excludeRes.some(r => r.test(text))) return false;
  return true;
}

// Treffer der Include-Muster hervorheben (auf bereits escaptem Text)
export function highlight(text, includeRes) {
  let html = escapeHtml(text);
  if (!includeRes.length) return html;
  for (const r of includeRes) {
    const g = new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g');
    html = html.replace(g, m => `<mark>${m}</mark>`);
  }
  return html;
}

// SHA-1 wie in app.py → IDs bleiben zwischen lokaler und Web-Version kompatibel
export async function makeItemId(feed, link, title) {
  const data = new TextEncoder().encode(`${feed}|${link || ''}|${title || ''}`);
  const buf = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- Autoren ------------------------------------------------------------------

const INSTITUTION = /\b(University|Department|Institute|Faculty|College|School|Centre|Center|Hospital|Research|Brussels|Italy|China)\b/i;

export function cleanAuthors(rawNames) {
  const seen = new Set();
  const names = [];
  for (let n of rawNames) {
    n = n.split(/\d/)[0];                                  // "Lin Fu112496Beijing…" → "Lin Fu"
    n = n.replace(/\s*\([^)]*\)/g, '');
    n = n.replace(/,\s*(Department|Faculty|Institute|University|College|School|Center|Centre|Hospital|Research|Lab).*/i, '');
    n = n.replace(/\s+/g, ' ').trim();
    if (!n || INSTITUTION.test(n) || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    names.push(n);
  }
  if (!names.length) return ['', ''];
  const display = names.length > 3 ? names.slice(0, 3).join(', ') + ' et al.' : names.join(', ');
  return [display, names.join(', ')];
}

// ---- RSS/Atom parsen ----------------------------------------------------------

function kids(el, local) {
  return [...el.children].filter(c => c.localName.toLowerCase() === local);
}
function first(el, ...locals) {
  for (const l of locals) {
    for (const k of kids(el, l)) {
      const t = (k.textContent || '').trim();
      if (t) return t;
    }
  }
  return '';
}

function parseDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function relDate(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso + 'T00:00:00')) / 86400000);
  if (days < 0) return '';
  if (days < 1) return 'heute';
  if (days === 1) return 'gestern';
  return `vor ${days} Tagen`;
}

function atomLink(entry) {
  const links = kids(entry, 'link');
  const alt = links.find(l => !l.getAttribute('rel') || l.getAttribute('rel') === 'alternate');
  return (alt || links[0])?.getAttribute('href') || '';
}

export function parseFeed(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Feed nicht lesbar (kein gültiges XML)');

  const rssItems = [...doc.getElementsByTagNameNS('*', 'item')];
  const atomEntries = [...doc.getElementsByTagNameNS('*', 'entry')];
  const out = [];

  for (const it of rssItems) {
    const creators = kids(it, 'creator').map(c => c.textContent.trim()).filter(Boolean);
    let authors = creators.length > 1 ? creators
      : (creators[0] || first(it, 'author')).split(/;|,|\sand\s/).map(s => s.trim()).filter(Boolean);
    out.push({
      title: htmlToText(first(it, 'title')),
      link: first(it, 'link'),
      summaryHtml: first(it, 'description', 'encoded', 'summary', 'abstract'),
      authors,
      date: parseDate(first(it, 'pubdate', 'date', 'coverdate', 'published', 'updated')),
      doiHints: [first(it, 'doi'), first(it, 'identifier'), first(it, 'guid')],
    });
  }
  for (const e of atomEntries) {
    const authors = kids(e, 'author').map(a => first(a, 'name')).filter(Boolean);
    out.push({
      title: htmlToText(first(e, 'title')),
      link: atomLink(e),
      summaryHtml: first(e, 'summary', 'content'),
      authors,
      date: parseDate(first(e, 'published', 'updated', 'date')),
      doiHints: [first(e, 'doi'), first(e, 'identifier'), first(e, 'id')],
    });
  }
  return out;
}

// ---- Abrufen über den Proxy ---------------------------------------------------

export async function fetchFeedText(url, proxy, timeoutMs = 20000) {
  if (!proxy) throw new Error('Kein Feed-Proxy eingerichtet (Einstellungen → Feed-Proxy)');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);   // hängender Feed blockiert nicht ewig
  try {
    const res = await fetch(proxy + encodeURIComponent(url), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Zeitüberschreitung');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Ausweichweg: neueste Artikel eines Journals direkt von CrossRef (per ISSN).
// Für Verlage, die den Feed-Proxy sperren (Taylor & Francis blockt Cloudflare).
// CrossRef ist tagesaktuell und erlaubt Browser-Zugriffe.
async function crossrefJournal(issn, maxItems) {
  const url = `https://api.crossref.org/journals/${encodeURIComponent(issn)}/works`
    + `?sort=created&order=desc&rows=${maxItems}&filter=type:journal-article`
    + '&select=DOI,title,author,created,published-online,URL,abstract'
    + '&mailto=pubcrawl@users.noreply.github.com';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CrossRef HTTP ${res.status}`);
  const items = (await res.json()).message?.items || [];
  return items.map(it => {
    const dp = (it['published-online'] || it.created)?.['date-parts']?.[0] || [];
    return {
      title: htmlToText(it.title?.[0] || ''),
      link: it.URL || `https://doi.org/${it.DOI}`,
      summaryHtml: it.abstract || '',
      authors: (it.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
      date: dp.length === 3 ? dp.map((n, i) => (i ? String(n).padStart(2, '0') : n)).join('-') : '',
      doiHints: [it.DOI],
    };
  });
}

// Einen Feed holen und in Einträge umwandeln (ohne Metadaten-Anreicherung)
export async function fetchOneFeed(feed, ctx) {
  const { includeRes, excludeRes, maxItems, proxy } = ctx;
  try {
    let raw;
    try {
      raw = parseFeed(await fetchFeedText(feed.url, proxy)).slice(0, maxItems);
    } catch (e) {
      if (!feed.issn) throw e;
      raw = await crossrefJournal(feed.issn, maxItems);
    }
    const entries = [];
    for (const r of raw) {
      let summary = stripCitation(htmlToText(r.summaryHtml)).replace(/^abstract[:\s]+/i, '');
      if (summary === '.' ) summary = '';
      // ScienceDirect: „Publication date: … Source: … Author(s): …" statt Abstract
      const sd = summary.match(/^Publication date:\s*(.*?)\s*Source:.*?(?:Author\(s\):\s*(.*))?$/i);
      if (sd) {
        // nur echte Tagesangaben – „January 2027" ist das (künftige) Heft, nicht das Erscheinen
        const online = sd[1].match(/available online\s*(\d{1,2}\s+\w+\s+\d{4})/i);
        if (online) r.date = parseDate(online[1]);
        if (!r.authors.length && sd[2]) r.authors = sd[2].split(',').map(s => s.trim());
        summary = '';
      }
      if (!matchFilters(`${r.title} ${summary}`, includeRes, excludeRes)) continue;
      const [authors, authors_full] = cleanAuthors(r.authors);
      entries.push({
        id: await makeItemId(feed.name, r.link, r.title),
        title: r.title,
        link: r.link,
        authors, authors_full,
        date: r.date,
        summary: summary.slice(0, 4000),
        journal: feed.name,
        doi: findDoi(...r.doiHints, r.link, r.title, summary),
      });
    }
    return { name: feed.name, error: null, entries };
  } catch (e) {
    return { name: feed.name, error: String(e.message || e), entries: [] };
  }
}

// Kurz prüfen, ob eine Feed-URL etwas liefert (Einstellungen → „Feed testen")
export async function probeFeed(url, proxy) {
  try {
    const items = parseFeed(await fetchFeedText(url, proxy));
    return { ok: true, count: items.length };
  } catch (e) {
    return { ok: false, count: 0, error: String(e.message || e) };
  }
}
