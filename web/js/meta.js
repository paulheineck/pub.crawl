// Abstracts, Autoren, DOIs, Open Access, RIS – direkt aus dem Browser.
// CrossRef, OpenAlex und Unpaywall erlauben Browser-Zugriffe (CORS), daher kein Proxy nötig.

import { state, save } from './store.js';
import { META_TTL_DAYS, MAILTO } from './config.js';
import { htmlToText } from './feeds.js';

const TTL = META_TTL_DAYS * 86400000;
const fresh = (entry) => entry && Date.now() - entry.ts < TTL;
const doiPath = (doi) => encodeURIComponent(doi).replace(/%2F/gi, '/');

function jatsToText(s) {
  return htmlToText(s).replace(/^abstract[:\s]+/i, '');
}

function authorsFromNames(names) {
  if (!names.length) return ['', ''];
  const display = names.length > 3 ? names.slice(0, 3).join(', ') + ' et al.' : names.join(', ');
  return [display, names.join(', ')];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 404 = „gibt es nicht" (Ergebnis), alles andere = Fehler (später erneut versuchen)
class NotFound extends Error {}

async function getJson(url, tries = 3) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      // Rate-Limit-Antworten kommen oft ohne CORS-Header → im Browser nur „Failed to fetch"
      if (i < tries - 1) { await sleep(2000 * (i + 1)); continue; }
      throw e;
    }
    if (res.ok) return res.json();
    if (res.status === 404) throw new NotFound(url);
    if ((res.status === 429 || res.status >= 500) && i < tries - 1) {   // Rate-Limit: kurz warten
      await sleep((Number(res.headers.get('Retry-After')) || 1 + i) * 1000);
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
}

// CrossRef-Werk (für Abstract, Autoren und RIS)
export async function crossrefWork(doi) {
  const j = await getJson(`https://api.crossref.org/works/${doiPath(doi)}?mailto=${MAILTO}`);
  return j.message || {};
}

async function crossrefMeta(doi) {
  try {
    const msg = await crossrefWork(doi);
    const names = (msg.author || [])
      .map(a => [a.given, a.family].filter(Boolean).join(' ').trim()).filter(Boolean);
    const [display, full] = authorsFromNames(names);
    const dp = (msg['published-online'] || msg.created)?.['date-parts']?.[0] || [];
    const date = dp.length === 3 ? dp.map((n, i) => (i ? String(n).padStart(2, '0') : n)).join('-') : '';
    return { ok: true, abstract: jatsToText(msg.abstract || ''), authors_display: display, authors_full: full, date };
  } catch (e) {
    return { ok: e instanceof NotFound, abstract: '', authors_display: '', authors_full: '' };
  }
}

async function openalexMeta(doi) {
  try {
    const j = await getJson(`https://api.openalex.org/works/doi:${doiPath(doi)}?mailto=${MAILTO}`);
    let abstract = '';
    const inv = j.abstract_inverted_index;
    if (inv) {
      const words = [];
      for (const [w, positions] of Object.entries(inv)) for (const p of positions) words.push([p, w]);
      abstract = words.sort((a, b) => a[0] - b[0]).map(x => x[1]).join(' ');
    }
    const names = (j.authorships || []).map(a => a.author?.display_name).filter(Boolean);
    const [display, full] = authorsFromNames(names);
    return { ok: true, abstract, authors_display: display, authors_full: full };
  } catch (e) {
    return { ok: e instanceof NotFound, abstract: '', authors_display: '', authors_full: '' };
  }
}

// Abstract + saubere Autoren zu einer DOI – CrossRef primär, OpenAlex als Fallback (gecacht)
export async function getMeta(doi) {
  if (fresh(state.meta[doi])) return state.meta[doi];
  const m = await crossrefMeta(doi);
  let ok = m.ok;
  if (!m.abstract || !m.authors_display) {
    const oa = await openalexMeta(doi);
    ok = ok || oa.ok;
    if (oa.abstract.length > m.abstract.length) m.abstract = oa.abstract;
    if (!m.authors_display && oa.authors_display) {
      m.authors_display = oa.authors_display;
      m.authors_full = oa.authors_full;
    }
  }
  const entry = { ts: Date.now(), ok, abstract: m.abstract, date: m.date || '',
                  authors_display: m.authors_display, authors_full: m.authors_full };
  if (ok) state.meta[doi] = entry;   // Netzwerkfehler nicht als "kein Abstract" cachen
  return entry;
}

const normTitle = (t) => (t || '').toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// DOI per Titelsuche (wenn der Feed keine liefert).
// Gibt die DOI zurück, null (nichts Passendes) oder undefined (Fehler → später erneut).
export async function doiByTitle(title) {
  if (!title) return null;
  const hit = state.doiByTitle[title];
  if (fresh(hit)) return hit.doi;
  try {
    const q = encodeURIComponent(title);
    const j = await getJson(`https://api.crossref.org/works?query.title=${q}&rows=3&select=DOI,title&mailto=${MAILTO}`);
    const want = normTitle(title);
    // nur übernehmen, wenn der Titel wirklich passt – sonst lieber keine als eine falsche DOI
    const item = (j.message?.items || []).find(it => {
      const got = normTitle(it.title?.[0]);
      return got && (got === want || (want.length > 30 && (got.startsWith(want) || want.startsWith(got))));
    });
    const doi = item?.DOI || null;
    state.doiByTitle[title] = { ts: Date.now(), doi };
    return doi;
  } catch {
    return undefined;
  }
}

export function persistMeta() {
  return save('meta', 'doiByTitle');
}

// Open-Access-Link: Unpaywall, sonst DOI-Seite
export async function openAccessUrl(doi, email) {
  if (email) {
    try {
      const j = await getJson(`https://api.unpaywall.org/v2/${doiPath(doi)}?email=${encodeURIComponent(email)}`);
      const loc = j.best_oa_location || (j.oa_locations || [])[0] || {};
      const url = loc.url_for_pdf || loc.url;
      if (url) return url;
    } catch { /* fällt auf DOI zurück */ }
  }
  return `https://doi.org/${doi}`;
}

// ---- RIS ------------------------------------------------------------------

function risFromWork(w) {
  const lines = ['TY  - JOUR'];
  if (w.title?.[0]) lines.push(`TI  - ${w.title[0]}`);
  for (const a of w.author || []) {
    const name = [a.family, a.given].filter(Boolean).join(', ');
    if (name) lines.push(`AU  - ${name}`);
  }
  if (w['container-title']?.[0]) lines.push(`JO  - ${w['container-title'][0]}`);
  if (w.volume) lines.push(`VL  - ${w.volume}`);
  if (w.issue) lines.push(`IS  - ${w.issue}`);
  if (w.page) {
    const [sp, ep] = w.page.split('-');
    lines.push(`SP  - ${sp}`);
    if (ep) lines.push(`EP  - ${ep}`);
  }
  const year = w.issued?.['date-parts']?.[0]?.[0];
  if (year) lines.push(`PY  - ${year}`);
  if (w.DOI) lines.push(`DO  - ${w.DOI}`);
  if (w.URL) lines.push(`UR  - ${w.URL}`);
  lines.push('ER  - ');
  return lines.join('\r\n');
}

export async function risFor(doi, title) {
  if (doi) {
    try { return risFromWork(await crossrefWork(doi)); } catch { /* minimal */ }
  }
  const lines = ['TY  - JOUR'];
  if (title) lines.push(`TI  - ${title}`);
  if (doi) lines.push(`DO  - ${doi}`);
  lines.push('ER  - ');
  return lines.join('\r\n');
}
