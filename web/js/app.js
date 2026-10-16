// Pub.Crawl – Browser-Version. Ansichten, Stapel, Leseliste, Einstellungen.

import { state, loadState, save, persistent } from './store.js';
import {
  DEFAULT_PROXY, CACHE_MINUTES, MIN_REL, MAX_SKIPS, DEPTH, STACK_H, META_CONCURRENCY,
} from './config.js';
import {
  fetchOneFeed, probeFeed, compilePattern, highlight, escapeHtml as esc, extractStats, relDate,
} from './feeds.js';
import { getMeta, doiByTitle, persistMeta, openAccessUrl, risFor } from './meta.js';
import { buildWeights, score, relevanceCounts, activityStats } from './relevance.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const body = document.body;
const listEl = $('#list');
const q = $('#q');

const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } },
};

let view = 'feed';
let current = new Map();      // id → Eintrag der gerade gerenderten Liste
let whyById = new Map();      // nur im Modus „Für mich"
let includeRes = [];
let initialCount = 0, lastN = 0, _remaining = 0, _searching = false;
let enriching = false, enrichRetries = 0;
let flash = '';
let catalogCache = null;

const proxyUrl = () => (state.config.proxy || DEFAULT_PROXY || '').trim();
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const nowIso = () => new Date().toISOString();

function compileFilters() {
  includeRes = (state.config.filters.include || []).map(p => compilePattern(p)).filter(Boolean);
}

// ===========================================================================
// Feeds holen + Metadaten im Hintergrund ergänzen
// ===========================================================================

function configKey() {
  const c = state.config;
  return JSON.stringify([c.feeds, c.filters, c.display.max_items_per_feed, proxyUrl()]);
}

function cacheFresh() {
  const c = state.feedCache;
  return !!(c && c.items && Date.now() - c.ts < CACHE_MINUTES * 60000 && c.configKey === configKey());
}

function needsMeta(e) {
  const s = (e.summary || '').trim();
  const truncated = !s || s.length < 350 || s.endsWith('…') || s.endsWith('...');
  return truncated || !e.authors || /\d/.test(e.authors);
}

function applyMeta(e, m) {
  if (!m) return false;
  let changed = false;
  if (!e.date && m.date) { e.date = m.date; changed = true; }
  if ((m.abstract || '').length > (e.summary || '').length) { e.summary = m.abstract.slice(0, 4000); changed = true; }
  if (m.authors_display && m.authors_display !== e.authors) {
    e.authors = m.authors_display; e.authors_full = m.authors_full; changed = true;
  }
  return changed;
}

async function fetchAllFeeds() {
  const c = state.config;
  compileFilters();
  const excludeRes = (c.filters.exclude || []).map(p => compilePattern(p)).filter(Boolean);
  const allow = new Set(c.filters.journal_allowlist || []);
  const feeds = (c.feeds || []).filter(f => !allow.size || allow.has(f.name));
  const ctx = { includeRes, excludeRes, maxItems: c.display.max_items_per_feed || 30, proxy: proxyUrl() };
  const items = await Promise.all(feeds.map(f => fetchOneFeed(f, ctx)));
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const f of items) for (const e of f.entries) {
    if (e.doi && needsMeta(e)) applyMeta(e, state.meta[e.doi]);   // schon bekannte Abstracts sofort
  }
  state.feedCache = { ts: Date.now(), configKey: configKey(), items };
  await save('feedCache');
}

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      try { await fn(it); } catch (err) { console.warn(err); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

async function enrichInBackground() {
  if (enriching || !state.feedCache) return;
  enriching = true;
  try {
    const todo = [];
    for (const f of state.feedCache.items) for (const e of f.entries) if (!e.enriched) todo.push(e);
    let done = 0;
    await pool(todo, META_CONCURRENCY, async (e) => {
      let failed = false, changed = false;
      if (!e.doi && e.title) {
        const doi = await doiByTitle(e.title);
        if (doi === undefined) failed = true;
        else if (doi) { e.doi = doi; changed = true; }
      }
      if (e.doi && needsMeta(e)) {
        const m = await getMeta(e.doi);
        if (m.ok === false) failed = true;
        changed = applyMeta(e, m) || changed;
      }
      if (!failed) e.enriched = true;      // sonst beim nächsten Durchlauf erneut versuchen
      if (changed) updateCard(e);
      if (++done % 25 === 0) { persistMeta(); save('feedCache'); }
    });
  } finally {
    enriching = false;
    await persistMeta();
    await save('feedCache');
  }
  // Was wegen Netzwerk/Rate-Limit scheiterte, in einer Minute noch einmal versuchen
  const left = state.feedCache.items.some(f => f.entries.some(e => !e.enriched));
  if (left && enrichRetries++ < 3) setTimeout(enrichInBackground, 60000);
}

async function refresh() {
  $('#loading').hidden = false;
  try { await fetchAllFeeds(); }
  finally { $('#loading').hidden = true; }
  enrichRetries = 0;
  render();
  enrichInBackground();
}

// ===========================================================================
// Listen bauen
// ===========================================================================

function feedEntries() {
  const out = [], seen = new Set();
  for (const f of state.feedCache?.items || []) for (const e of f.entries) {
    if (state.read[e.id] || state.starred[e.id]) continue;
    const key = e.doi ? 'doi:' + e.doi.toLowerCase() : 'ti:' + normTitle(e.title);
    if (seen.has(key)) continue;       // gleiches Paper aus mehreren Feeds
    seen.add(key);
    out.push(e);
  }
  return out;
}

function starredEntries() {
  return Object.entries(state.starred)
    .sort((a, b) => (b[1].starred_at || '').localeCompare(a[1].starred_at || ''))
    .map(([id, s]) => {
      const p = s.snapshot || {};
      return {
        id, title: p.title || '(ohne Titel)', link: p.link || '', journal: p.feed || '',
        date: p.date || '', summary: p.summary || '', doi: p.doi || null,
        authors: p.authors || '', authors_full: p.authors_full || p.authors || '', note: s.note || '',
      };
    });
}

function sortModes() {
  const [l, s] = relevanceCounts(state);
  return (l >= MIN_REL && s >= MIN_REL ? ['relevance'] : []).concat(['new', 'shuffle']);
}

function currentSort() {
  const modes = sortModes();
  let s = ls.get('sortPref') || (modes[0] === 'relevance' ? 'relevance' : 'shuffle');
  if (!modes.includes(s)) s = modes[0];
  return s;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ===========================================================================
// Karten
// ===========================================================================

const HEART = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12.1 21.35l-1.1-1.01C5.14 15.24 2 12.39 2 8.98 2 6.24 4.24 4 6.98 4c1.64 0 3.22.76 4.22 2 .99-1.24 2.58-2 4.22-2C18.76 4 21 6.24 21 8.98c0 3.41-3.14 6.26-8.9 11.36l-1 .91z"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7a1 1 0 0 0-1.41 1.42L10.59 12l-4.9 4.89a1 1 0 1 0 1.41 1.42L12 13.41l4.89 4.9a1 1 0 0 0 1.42-1.42L13.41 12l4.9-4.89a1 1 0 0 0-.01-1.4z"/></svg>';

function linksHtml(e) {
  const scholar = `<a class="meta-link" href="https://scholar.google.com/scholar?q=${encodeURIComponent(e.title)}"
    target="_blank" rel="noopener" title="Auf Google Scholar suchen">🎓 Scholar</a>`;
  if (!e.doi) return scholar;
  return `<button type="button" class="meta-link" data-act="pdf" title="Frei verfügbares PDF suchen (Unpaywall)">📄 PDF</button>`
    + scholar
    + `<button type="button" class="meta-link" data-act="ris" title="Zitation als RIS herunterladen">Cite (RIS)</button>`;
}

function metaLineHtml(e) {
  const rel = e.date ? relDate(e.date) : '';
  return esc(e.journal) + (e.date ? ` · ${esc(e.date)}${rel ? ` (${rel})` : ''}` : '')
    + `<span class="links">${linksHtml(e)}</span>`;
}

function chipsHtml(e) {
  const st = extractStats(e.summary);
  const why = whyById.get(e.id);
  return [
    why?.length ? `<span class="chip rel" title="Passt zu deinen Interessen">🧠 ${esc(why.join(', '))}</span>` : '',
    st.N ? `<span class="chip">N=${esc(st.N)}</span>` : '',
    st.meta ? '<span class="chip">Meta-Analysis</span>' : '',
    st.prereg ? '<span class="chip">Preregistered/RR</span>' : '',
  ].join('');
}

function cardHtml(e, mode) {
  const stars = mode === 'stars';
  return `<div class="item${stars ? ' item-star' : ''}" data-id="${esc(e.id)}"
      data-search="${esc(`${e.title} ${e.summary}`.toLowerCase())}">
    ${stars ? '<button class="trash-btn" type="button" data-act="trash" title="Aus der Leseliste entfernen">🗑</button>' : ''}
    <h4 style="margin:0 0 .25rem 0;"><a href="${esc(safeUrl(e.link))}" target="_blank" rel="noopener">${highlight(e.title, includeRes)}</a></h4>
    <p class="authors" title="${esc(e.authors_full)}"${e.authors ? '' : ' hidden'}>${esc(e.authors)}</p>
    <p class="meta" style="margin:.1rem 0 .6rem 0;">${metaLineHtml(e)}</p>
    <div class="abstract clamped"${e.summary ? '' : ' hidden'}>${highlight(e.summary, includeRes)}</div>
    <button class="more-btn" type="button" data-act="more" hidden>mehr ▾</button>
    ${stars ? `<div class="note-wrap"><span class="note-label">📝 Deine Notiz</span>
      <textarea class="note" data-id="${esc(e.id)}" rows="1" placeholder="Notiz oder #tags hinzufügen …">${esc(e.note)}</textarea></div>` : ''}
    <div class="chips">${chipsHtml(e)}</div>
    ${mode === 'feed' ? `<div class="choicebar">
      <button class="choice skip" type="button" data-act="skip" title="Ausblenden (D)">${CROSS}</button>
      <button class="choice like" type="button" data-act="like" title="Auf Leseliste (L)">${HEART}</button>
    </div>` : ''}
  </div>`;
}

// Karte nach nachgeladenen Metadaten aktualisieren (ohne neu zu mischen)
function updateCard(e) {
  const card = listEl.querySelector(`.item[data-id="${CSS.escape(e.id)}"]`);
  if (!card || current.get(e.id) !== e) return;
  const au = card.querySelector('.authors');
  au.textContent = e.authors; au.title = e.authors_full; au.hidden = !e.authors;
  const ab = card.querySelector('.abstract');
  ab.innerHTML = highlight(e.summary, includeRes); ab.hidden = !e.summary;
  card.querySelector('.meta').innerHTML = metaLineHtml(e);
  card.querySelector('.chips').innerHTML = chipsHtml(e);
  card.dataset.search = `${e.title} ${e.summary}`.toLowerCase();
  if (body.classList.contains('deck')) {
    if (card.classList.contains('d0')) updateView();
  } else {
    checkClamp(card);
  }
}

// ===========================================================================
// Rendern
// ===========================================================================

function render() {
  $$('[data-nav]').forEach(a => a.classList.toggle('contrast', a.dataset.nav === view));
  $$('.feed-only').forEach(b => { b.hidden = view !== 'feed'; });
  q.hidden = view === 'settings';
  $('#view-list').hidden = view === 'settings';
  $('#view-settings').hidden = view !== 'settings';
  if (view === 'settings') {
    body.classList.remove('deck');
    renderSettings();
  } else {
    renderList();
  }
}

function renderNotices(entriesCount) {
  const c = state.config;
  const parts = [];
  if (view === 'feed') {
    if (!c.feeds.length) {
      parts.push(`<article class="onboard"><h3 style="margin-top:0;">👋 Willkommen bei Pub.Crawl!</h3>
        <p>Du hast noch keine Journals abonniert. Wähle welche aus dem Katalog – nach Fachbereich sortiert und sofort einsatzbereit.</p>
        <a href="#settings" role="button" class="contrast">📚 Journals aus dem Katalog wählen</a></article>`);
    } else if (!proxyUrl()) {
      parts.push(`<article class="notice warn"><strong>Feed-Proxy fehlt.</strong> Ohne ihn kann der Browser
        keine Journal-Feeds laden. <a href="#settings">In den Einstellungen einrichten →</a></article>`);
    } else {
      const errs = (state.feedCache?.items || []).filter(f => f.error);
      if (errs.length) {
        parts.push(`<article class="notice warn">⚠ ${errs.length} Feed(s) nicht erreichbar
          (<a href="#settings">Details</a>): ${errs.map(f => esc(f.name)).join(', ')}</article>`);
      }
      if (!entriesCount) parts.push('<article class="notice warn">Es sind keine neuen Artikel verfügbar.</article>');
    }
  } else if (!entriesCount) {
    parts.push('<article class="notice info">Deine Leseliste ist noch leer – im Feed mit ♥ Artikel merken.</article>');
  }
  if (!persistent) {
    parts.push(`<article class="notice warn">Dieser Browser erlaubt keine dauerhafte Speicherung (Privatmodus?).
      Deine Daten gehen beim Schließen verloren.</article>`);
  }
  $('#notices').innerHTML = parts.join('');
}

function renderList() {
  compileFilters();
  body.classList.remove('deck');            // im Listenlayout messen
  whyById = new Map();
  const isFeed = view === 'feed';
  $('#listTitle').hidden = isFeed;
  $('#listTitle').textContent = isFeed ? '' : '⭐ Leseliste';
  $('#exportStars').hidden = isFeed;

  let entries;
  if (isFeed) {
    entries = feedEntries();
    const sort = currentSort();
    if (sort === 'relevance') {
      const weights = buildWeights(state);
      entries = entries
        .map(e => { const [s, why] = score(`${e.title} ${e.summary}`, weights); whyById.set(e.id, why); return [s, e]; })
        .sort((a, b) => b[0] - a[0]).map(x => x[1]);
    } else if (sort === 'new') {
      entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    } else {
      shuffle(entries);
    }
    $('#sortBtn').textContent = { relevance: '🧠 Für mich', new: '🆕 Neueste', shuffle: '🔀 Zufall' }[sort];
  } else {
    entries = starredEntries();
  }

  renderNotices(entries.length);
  current = new Map(entries.map(e => [e.id, e]));
  listEl.innerHTML = entries.map(e => cardHtml(e, isFeed ? 'feed' : 'stars')).join('');
  applySearch(false);
  initialCount = visibleItems().length;
  lastN = initialCount;
  checkClampAll();
  $$('textarea.note', listEl).forEach(grow);
  applyView(false);
  checkRel();
}

// ===========================================================================
// Stapel / Liste
// ===========================================================================

const visibleItems = () =>
  $$('#list .item').filter(el => !el.classList.contains('hidden') && !el.classList.contains('gone'));

function measureContent(card) {
  const padB = parseFloat(getComputedStyle(card).paddingBottom) || 0;
  let bottom = 0;
  for (const ch of card.children) {
    if (ch.hidden) continue;
    bottom = Math.max(bottom, ch.offsetTop + ch.offsetHeight);
  }
  return Math.ceil(bottom + padB) + 2;
}

function checkClamp(card) {
  const ab = card.querySelector('.abstract');
  const btn = card.querySelector('.more-btn');
  if (!ab || !btn) return;
  if (ab.hidden) { btn.hidden = true; return; }
  if (!ab.classList.contains('clamped')) { btn.hidden = false; return; }
  btn.hidden = !(ab.scrollHeight > ab.clientHeight + 4);
}

function checkClampAll() {
  const cards = $$('#list .item');
  // erst alles messen, dann schreiben – vermeidet ständige Reflows
  const over = cards.map(c => {
    const ab = c.querySelector('.abstract');
    return ab && !ab.hidden && ab.classList.contains('clamped') ? ab.scrollHeight > ab.clientHeight + 4 : null;
  });
  cards.forEach((c, i) => {
    const btn = c.querySelector('.more-btn');
    if (btn && over[i] !== null) btn.hidden = !over[i];
  });
}

function updateView() {
  const items = visibleItems();
  const n = items.length;
  const searching = q.value.trim() !== '';
  const deck = body.classList.contains('deck');

  $$('#list .item.d0, #list .item.d1, #list .item.d2, #list .item.d3, #list .item.d4')
    .forEach(el => el.classList.remove('d0', 'd1', 'd2', 'd3', 'd4'));
  if (deck) items.slice(0, DEPTH).forEach((el, i) => el.classList.add('d' + i));
  listEl.classList.toggle('empty', n === 0);

  // Frontkarte = natürliche Höhe; hintere Karten einheitlich, nie höher als die Front
  if (deck) {
    const top = items[0] || null;
    if (top) checkClamp(top);
    const naturalH = top ? measureContent(top) : 0;
    const backH = Math.min(STACK_H, naturalH || STACK_H);
    items.slice(0, DEPTH).forEach((el, i) => { el.style.height = (i === 0 ? naturalH : backH) + 'px'; });
  } else {
    $$('#list .item').forEach(el => { el.style.height = ''; });
  }

  _remaining = n; _searching = searching;
  renderStatus();

  const doneEl = $('#done');
  if (view === 'feed' && n === 0 && initialCount > 0 && !searching) {
    doneEl.hidden = false;
    if (lastN > 0) celebrate();
    lastN = n;
  } else {
    doneEl.hidden = true;
    if (!searching) lastN = n;
  }
}

function applyView(animate) {
  const deck = view === 'feed' && ls.get('viewMode') !== 'list';
  const doIt = () => {
    body.classList.toggle('deck', deck);
    $('#viewBtn').textContent = deck ? '📄 Liste' : '🃏 Stapel';
    if (!deck) checkClampAll();
    updateView();
  };
  if (animate) {
    listEl.style.opacity = '0';
    setTimeout(() => { window.scrollTo({ top: 0 }); doIt(); listEl.style.opacity = '1'; }, 120);
  } else {
    doIt();
  }
}

function hideCard(card, dx) {
  card.classList.add('leaving');
  const deck = body.classList.contains('deck');
  if (ls.get('animateCards') !== '0') {
    const fly = deck ? dx * 6 : dx;
    card.style.transition = 'transform .3s ease, opacity .3s ease';
    card.style.transform = `translateX(${fly}px) rotate(${dx < 0 ? -8 : 8}deg)`;
    card.style.opacity = '0';
    card.style.zIndex = '60';
    card._hideT = setTimeout(() => { card.classList.add('gone'); card.style.zIndex = ''; updateView(); }, 280);
  } else {
    card.classList.add('gone');
    updateView();
  }
}

function restoreCard(card) {
  clearTimeout(card._hideT);
  card.classList.remove('gone', 'leaving');
  card.style.transition = card.style.transform = card.style.opacity = card.style.zIndex = '';
  updateView();
}

function celebrate() {
  if (ls.get('animateCards') === '0') return;
  const colors = ['#ff9500', '#34c759', '#007aff', '#ff2d55', '#af52de'];
  for (let i = 0; i < 28; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = (Math.random() * 100) + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = (1 + Math.random()) + 's';
    c.style.animationDelay = (Math.random() * 0.3) + 's';
    body.appendChild(c);
    setTimeout(() => c.remove(), 2600);
  }
}

function renderStatus() {
  const bar = $('#statusbar');
  if (view !== 'feed') { bar.hidden = true; return; }
  const [streak, today] = activityStats(state);
  const parts = [];
  if (streak > 0 || today > 0) parts.push(`🔥 ${streak} · heute ${today}`);
  if (_searching) parts.push(`${_remaining} Treffer`);
  else if (_remaining) parts.push(`noch ${_remaining}`);
  $('#statustext').textContent = parts.join('   ·   ');
  bar.hidden = parts.length === 0;
}

function checkRel() {
  const note = $('#relNote');
  if (view !== 'feed') { note.hidden = true; return; }
  const [l, s] = relevanceCounts(state);
  $('#relLiked').textContent = l;
  $('#relSkipped').textContent = s;
  note.hidden = !(l >= MIN_REL && s >= MIN_REL && ls.get('relSeen') !== '1');
}

function applySearch(update = true) {
  const t = q.value.trim().toLowerCase();
  $$('#list .item').forEach(it => it.classList.toggle('hidden', !!t && !it.dataset.search.includes(t)));
  if (update) updateView();
}

function grow(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

// ===========================================================================
// Aktionen
// ===========================================================================

let toastTimer = null;
function showToast(msg, undoFn) {
  const toast = $('#toast');
  clearTimeout(toastTimer);
  toast.querySelector('.toast-msg').textContent = msg;
  toast.classList.add('show');
  toast.querySelector('.toast-undo').onclick = () => {
    clearTimeout(toastTimer);
    toast.classList.remove('show');
    undoFn();
  };
  toastTimer = setTimeout(() => toast.classList.remove('show'), 5000);
}

function pruneReads() {
  const ids = Object.keys(state.read);
  if (ids.length <= MAX_SKIPS) return;
  ids.sort((a, b) => (state.read[a].read_at || '').localeCompare(state.read[b].read_at || ''));
  for (const id of ids.slice(0, ids.length - MAX_SKIPS)) delete state.read[id];
}

function like(e, card) {
  state.starred[e.id] = {
    starred_at: nowIso(), note: '',
    snapshot: {
      id: e.id, title: e.title, link: e.link, feed: e.journal, date: e.date,
      summary: e.summary, doi: e.doi, authors: e.authors, authors_full: e.authors_full,
    },
  };
  save('starred');
  hideCard(card, 70);          // Like → nach rechts
  renderStatus(); checkRel();
  showToast('⭐ Auf Leseliste', () => {
    delete state.starred[e.id]; save('starred');
    restoreCard(card); renderStatus();
  });
}

function skip(e, card) {
  state.read[e.id] = { read_at: nowIso(), title: e.title, summary: e.summary };   // Text fürs Relevanz-Modell
  pruneReads();
  save('read');
  hideCard(card, -70);         // Dislike → nach links
  renderStatus(); checkRel();
  showToast('✕ Ausgeblendet', () => {
    delete state.read[e.id]; save('read');
    restoreCard(card); renderStatus();
  });
}

function unstar(e, card) {
  const backup = state.starred[e.id];
  delete state.starred[e.id];
  save('starred');
  hideCard(card, 70);
  showToast('🗑 Entfernt', () => {
    state.starred[e.id] = backup; save('starred');
    restoreCard(card);
  });
}

function toggleMore(card, btn) {
  const ab = card.querySelector('.abstract');
  const clamped = ab.classList.toggle('clamped');
  btn.textContent = clamped ? 'mehr ▾' : 'weniger ▴';
  if (body.classList.contains('deck') && card.classList.contains('d0')) {
    card.style.height = measureContent(card) + 'px';
  }
}

async function openPdf(e) {
  const email = state.config.api.unpaywall_email;
  if (!email) { window.open(`https://doi.org/${e.doi}`, '_blank', 'noopener'); return; }
  const w = window.open('', '_blank');          // sofort öffnen, sonst blockt der Popup-Blocker
  const url = await openAccessUrl(e.doi, email);
  if (w) w.location.href = url; else window.open(url, '_blank', 'noopener');
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function downloadRis(e) {
  const ris = await risFor(e.doi, e.title);
  download(`cite_${(e.doi || e.title).slice(0, 40).replace(/[^\w.-]+/g, '_')}.ris`, ris,
    'application/x-research-info-systems');
}

async function exportStarsRis(btn) {
  const list = starredEntries();
  btn.setAttribute('aria-busy', 'true');
  const out = new Array(list.length);
  await pool(list.map((e, i) => [e, i]), 4, async ([e, i]) => { out[i] = await risFor(e.doi, e.title); });
  btn.removeAttribute('aria-busy');
  download('pubcrawl-leseliste.ris', out.join('\r\n'), 'application/x-research-info-systems');
}

// ===========================================================================
// Import / Export
// ===========================================================================

function exportOpml() {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">',
    '  <head><title>Pub.Crawl feeds</title></head>', '  <body>',
    ...state.config.feeds.map(f =>
      `    <outline text="${esc(f.name)}" title="${esc(f.name)}" type="rss" xmlUrl="${esc(f.url)}"/>`),
    '  </body>', '</opml>',
  ];
  download('pubcrawl-feeds.opml', lines.join('\n'), 'text/x-opml');
}

function importOpml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('OPML nicht lesbar');
  const feeds = state.config.feeds;
  const urls = new Set(feeds.map(f => f.url)), names = new Set(feeds.map(f => f.name));
  let added = 0;
  for (const o of doc.getElementsByTagName('outline')) {
    const url = (o.getAttribute('xmlUrl') || '').trim();
    const name = (o.getAttribute('text') || o.getAttribute('title') || url).trim();
    if (!url || urls.has(url) || names.has(name)) continue;
    feeds.push({ name, url });
    urls.add(url); names.add(name);
    added++;
  }
  return added;
}

function exportState() {
  const data = {
    version: 1, app: 'Pub.Crawl (web)', exported_at: nowIso(),
    starred: Object.entries(state.starred).map(([id, s]) =>
      ({ id, starred_at: s.starred_at, snapshot: s.snapshot, note: s.note || '' })),
    read: Object.entries(state.read).map(([id, r]) =>
      ({ id, read_at: r.read_at, title: r.title || '', summary: r.summary || '' })),
  };
  download('pubcrawl-state.json', JSON.stringify(data, null, 2), 'application/json');
}

// Python-Version speichert "YYYY-MM-DD HH:MM:SS" (UTC) → in ISO umwandeln
function normTs(t) {
  if (!t) return nowIso();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) return t.replace(' ', 'T') + 'Z';
  return t;
}

function importState(text) {
  const data = JSON.parse(text);
  let s = 0, r = 0;
  for (const it of data.starred || []) {
    if (!it?.id || state.starred[it.id]) continue;
    state.starred[it.id] = { starred_at: normTs(it.starred_at), snapshot: it.snapshot || {}, note: it.note || '' };
    s++;
  }
  for (const it of data.read || []) {
    const id = typeof it === 'string' ? it : it?.id;
    if (!id || state.read[id]) continue;
    state.read[id] = {
      read_at: normTs(typeof it === 'string' ? null : it.read_at),
      title: it.title || '', summary: it.summary || '',
    };
    r++;
  }
  pruneReads();
  save('starred', 'read');
  return [s, r];
}

// ===========================================================================
// Einstellungen
// ===========================================================================

async function loadCatalog() {
  if (!catalogCache) {
    try { catalogCache = await (await fetch('journals.json')).json(); } catch { catalogCache = []; }
  }
  return catalogCache;
}

async function renderSettings() {
  const c = state.config;
  const catalog = await loadCatalog();
  const subscribed = new Set(c.feeds.map(f => f.url));
  const groups = {};
  for (const j of catalog) if (!subscribed.has(j.url)) (groups[j.category || 'Sonstige'] ||= []).push(j);
  const errors = (state.feedCache?.items || []).filter(f => f.error);
  const allow = new Set(c.filters.journal_allowlist || []);
  const msg = flash; flash = '';

  $('#view-settings').innerHTML = `
  <h2 style="margin-top:1rem;">Einstellungen</h2>
  ${msg ? `<article class="notice info">${esc(msg)}</article>` : ''}
  ${!proxyUrl() ? `<article class="notice warn"><strong>Feed-Proxy fehlt.</strong> Ohne Proxy kann der Browser keine
    Journal-Feeds abrufen – siehe „Feed-Proxy" weiter unten.</article>` : ''}
  ${errors.length ? `<article class="notice warn"><strong>⚠ ${errors.length} Feed(s) nicht erreichbar</strong>
    <ul style="margin:.4rem 0 0 0;">${errors.map(f => `<li><code>${esc(f.name)}</code>
    <span class="muted">— ${esc(f.error)}</span></li>`).join('')}</ul></article>` : ''}

  <h3>Aktive Feeds</h3>
  ${c.feeds.length ? `<p class="muted">Die Journals, die im Feed erscheinen. Mit der Allowlist weiter unten kannst du einzelne vorübergehend ausblenden.</p>
  <table><thead><tr><th>Name</th><th>RSS-URL</th><th style="width:1%;"></th></tr></thead><tbody>
    ${c.feeds.map(f => `<tr><td>${esc(f.name)}</td>
      <td><a target="_blank" rel="noopener" href="${esc(safeUrl(f.url))}">${esc(f.url)}</a></td>
      <td><button class="secondary outline" style="width:auto;" data-act="remove-feed" data-name="${esc(f.name)}">Entfernen</button></td></tr>`).join('')}
  </tbody></table>` : '<p class="muted">Noch keine Feeds – wähle unten welche aus dem Katalog.</p>'}

  <details><summary>Neuen Feed hinzufügen</summary>
    <form data-form="add-feed">
      <label>Name <input name="name" required placeholder="z. B. JESP"></label>
      <label>RSS-URL <input name="url" required placeholder="https://…/rss"></label>
      <div class="row"><button type="button" data-act="test-feed">Feed testen</button><span id="testOut" class="muted"></span></div>
      <button type="submit" style="width:auto;">Hinzufügen</button>
    </form>
  </details>

  ${Object.keys(groups).length ? `<details ${c.feeds.length ? '' : 'open'}><summary>Aus Katalog hinzufügen</summary>
    <p class="muted">Bekannte Journals zum Anhaken – schneller als URLs raussuchen.</p>
    <form data-form="catalog">
      ${Object.entries(groups).map(([cat, items]) => `<fieldset><legend><strong>${esc(cat)}</strong></legend>
        <div class="row" style="gap:1.25rem;">${items.map(j =>
          `<label><input type="checkbox" name="catalog" value="${esc(j.url)}"> ${esc(j.name)}</label>`).join('')}</div>
      </fieldset>`).join('')}
      <button type="submit" style="width:auto;">Ausgewählte hinzufügen</button>
    </form>
  </details>` : ''}

  <details><summary>Import / Export (OPML)</summary>
    <p class="muted">OPML ist das Standardformat für Feed-Listen – kompatibel mit Feedly, Inoreader &amp; Co.</p>
    <label>OPML importieren <input type="file" data-file="opml" accept=".opml,.xml,text/xml"></label>
    <button type="button" class="secondary outline" style="width:auto;" data-act="export-opml">⬇️ Feeds als OPML exportieren</button>
  </details>

  <details><summary>Leseliste &amp; Status sichern / syncen</summary>
    <p class="muted">Exportiert Leseliste, Notizen und Gelesen-Markierungen als JSON. Der Import <strong>führt zusammen</strong>
      (überschreibt nichts) – auch Exporte aus der lokalen Python-Version funktionieren.</p>
    <label>Status importieren <input type="file" data-file="state" accept=".json,application/json"></label>
    <button type="button" class="secondary outline" style="width:auto;" data-act="export-state">⬇️ Status als JSON exportieren</button>
  </details>

  <details><summary>Allowlist (welche Feeds zeigen?)</summary>
    <p class="muted">Leer = alle Feeds. Andernfalls erscheinen nur die angehakten.</p>
    <form data-form="allowlist">
      <div class="row" style="gap:1.25rem;">${c.feeds.map(f =>
        `<label><input type="checkbox" name="allow" value="${esc(f.name)}" ${allow.has(f.name) ? 'checked' : ''}> ${esc(f.name)}</label>`).join('')}</div>
      <div class="row">
        <button type="button" data-act="allow-all">Alle</button>
        <button type="button" data-act="allow-none">Keine</button>
        <button type="submit">Speichern</button>
      </div>
    </form>
  </details>

  <details><summary>Filter (Regex)</summary>
    <p class="muted">Je Zeile ein Muster. <code>include</code> wird ODER-verknüpft; nur Treffer werden angezeigt.
      <code>exclude</code> wird verworfen. <code>(?i)</code> am Anfang = Groß-/Kleinschreibung egal.</p>
    <form data-form="filters">
      <label>Include-Muster <textarea name="include">${esc((c.filters.include || []).join('\n'))}</textarea></label>
      <label>Exclude-Muster <textarea name="exclude">${esc((c.filters.exclude || []).join('\n'))}</textarea></label>
      <button type="submit" style="width:auto;">Filter speichern</button>
    </form>
  </details>

  <details ${proxyUrl() ? '' : 'open'}><summary>Feed-Proxy</summary>
    <p class="muted">Browser dürfen Journal-Feeds nicht direkt abrufen (CORS). Ein kleiner Proxy reicht die Feeds
      durch und speichert nichts. Auf Cloudflare bringt Pub.Crawl ihn selbst mit (<code>/proxy</code>).</p>
    <form data-form="proxy">
      <label>Proxy-URL (die Feed-URL wird angehängt)
        <input name="proxy" value="${esc(c.proxy || '')}" placeholder="${esc(DEFAULT_PROXY)}">
      </label>
      <p class="muted">Leer lassen = Standard${DEFAULT_PROXY ? ` (<code>${esc(DEFAULT_PROXY)}</code>)` : ' (keiner eingerichtet)'}.</p>
      <button type="submit" style="width:auto;">Speichern</button>
    </form>
  </details>

  <details><summary>Open Access (Unpaywall)</summary>
    <p class="muted">Für den „📄 PDF"-Link fragt Pub.Crawl Unpaywall nach einer frei verfügbaren Version. Unpaywall
      verlangt dafür eine E-Mail-Adresse. Ohne Adresse führt der Link zur DOI-Seite.</p>
    <form data-form="unpaywall">
      <label>E-Mail <input type="email" name="email" value="${esc(c.api.unpaywall_email || '')}" placeholder="du@uni.de"></label>
      <button type="submit" style="width:auto;">Speichern</button>
    </form>
  </details>

  <h3>Darstellung</h3>
  <label style="display:flex;align-items:center;gap:.5rem;">
    <input type="checkbox" data-toggle="anim" ${ls.get('animateCards') !== '0' ? 'checked' : ''}>
    Kartenbewegung beim Liken/Ausblenden animieren
  </label>

  <p class="muted" style="margin-top:2rem;">🔒 Feeds, Leseliste und Notizen liegen nur in diesem Browser auf diesem
    Gerät. Wer die Browserdaten löscht, löscht sie mit. Sichere sie ab und zu per „Status als JSON exportieren".</p>`;
}

function settingsMsg(m) {
  flash = m;
  renderSettings();
  window.scrollTo({ top: 0 });
}

const lines = (s) => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);

async function onSettingsSubmit(ev) {
  ev.preventDefault();
  const form = ev.target;
  const fd = new FormData(form);
  const c = state.config;
  switch (form.dataset.form) {
    case 'add-feed': {
      const name = String(fd.get('name')).trim(), url = String(fd.get('url')).trim();
      if (c.feeds.some(f => f.name === name)) return settingsMsg('Name bereits vorhanden');
      form.querySelector('[type=submit]').setAttribute('aria-busy', 'true');
      const p = await probeFeed(url, proxyUrl());
      if (!p.ok) return settingsMsg(`Feed nicht abrufbar: ${p.error}`);
      c.feeds.push({ name, url });
      await save('config');
      return settingsMsg(`Feed „${name}" hinzugefügt (${p.count} Einträge)`);
    }
    case 'catalog': {
      const byUrl = new Map((await loadCatalog()).map(j => [j.url, j]));
      let n = 0;
      for (const u of fd.getAll('catalog')) {
        const j = byUrl.get(u);
        if (!j || c.feeds.some(f => f.url === u || f.name === j.name)) continue;
        c.feeds.push({ name: j.name, url: j.url });
        n++;
      }
      await save('config');
      return settingsMsg(`${n} Feed(s) aus dem Katalog hinzugefügt – im Feed geht's los.`);
    }
    case 'allowlist':
      c.filters.journal_allowlist = fd.getAll('allow');
      await save('config');
      return settingsMsg('Allowlist gespeichert');
    case 'filters': {
      const inc = lines(fd.get('include')), exc = lines(fd.get('exclude'));
      const bad = [...inc, ...exc].find(p => !compilePattern(p));
      if (bad) return settingsMsg(`Ungültiges Regex-Muster: ${bad}`);
      c.filters.include = inc;
      c.filters.exclude = exc;
      await save('config');
      return settingsMsg('Filter gespeichert');
    }
    case 'proxy': {
      const v = String(fd.get('proxy') || '').trim();
      if (v && !/^(https?:\/\/|\/)/i.test(v)) return settingsMsg('Die Proxy-URL muss mit https:// beginnen');
      c.proxy = v;
      await save('config');
      return settingsMsg(v ? 'Proxy gespeichert' : 'Proxy zurückgesetzt');
    }
    case 'unpaywall':
      c.api.unpaywall_email = String(fd.get('email') || '').trim();
      await save('config');
      return settingsMsg('E-Mail gespeichert');
  }
}

async function onSettingsClick(ev) {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const c = state.config;
  switch (b.dataset.act) {
    case 'remove-feed': {
      const name = b.dataset.name;
      if (!confirm(`Feed „${name}" wirklich entfernen?`)) return;
      c.feeds = c.feeds.filter(f => f.name !== name);
      c.filters.journal_allowlist = (c.filters.journal_allowlist || []).filter(n => n !== name);
      await save('config');
      return settingsMsg(`Feed „${name}" entfernt`);
    }
    case 'test-feed': {
      const out = $('#testOut');
      const url = b.form.elements.url.value.trim();
      if (!url) { out.textContent = 'Bitte URL eingeben.'; return; }
      out.textContent = 'Teste …';
      const p = await probeFeed(url, proxyUrl());
      out.textContent = p.ok ? `OK – ${p.count} Einträge` : `Fehler: ${p.error}`;
      return;
    }
    case 'allow-all': $$('input[name=allow]', b.form).forEach(cb => { cb.checked = true; }); return;
    case 'allow-none': $$('input[name=allow]', b.form).forEach(cb => { cb.checked = false; }); return;
    case 'export-opml': exportOpml(); return;
    case 'export-state': exportState(); return;
  }
}

async function onSettingsChange(ev) {
  const t = ev.target;
  if (t.dataset.toggle === 'anim') { ls.set('animateCards', t.checked ? '1' : '0'); return; }
  if (!t.dataset.file || !t.files?.[0]) return;
  try {
    const text = await t.files[0].text();
    if (t.dataset.file === 'opml') {
      const n = importOpml(text);
      await save('config');
      settingsMsg(`${n} Feed(s) aus OPML importiert`);
    } else {
      const [s, r] = importState(text);
      settingsMsg(`Status importiert: +${s} Leseliste, +${r} Gelesen`);
    }
  } catch (e) {
    settingsMsg(`Import fehlgeschlagen: ${e.message}`);
  }
}

// ===========================================================================
// Ereignisse + Start
// ===========================================================================

function setCurrent(el) {
  $$('#list .item.active').forEach(i => i.classList.remove('active'));
  if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

function setupHandlers() {
  listEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.item');
    const e = current.get(card?.dataset.id);
    if (!e || card.classList.contains('leaving')) return;
    switch (btn.dataset.act) {
      case 'like': like(e, card); break;
      case 'skip': skip(e, card); break;
      case 'trash':
        if (confirm(`„${e.title.slice(0, 60)}" wirklich aus der Leseliste entfernen?`)) unstar(e, card);
        break;
      case 'more': toggleMore(card, btn); break;
      case 'pdf': openPdf(e); break;
      case 'ris': downloadRis(e); break;
    }
  });

  listEl.addEventListener('input', (ev) => {
    const ta = ev.target.closest('textarea.note');
    if (!ta) return;
    grow(ta);
    const s = state.starred[ta.dataset.id];
    if (!s) return;
    s.note = ta.value;
    clearTimeout(ta._t);
    ta._t = setTimeout(() => save('starred'), 500);
  });

  q.addEventListener('input', () => applySearch(true));

  $('#exportStars').addEventListener('click', (ev) => { ev.preventDefault(); exportStarsRis(ev.currentTarget); });

  $('#sortBtn').addEventListener('click', () => {
    const modes = sortModes();
    ls.set('sortPref', modes[(modes.indexOf(currentSort()) + 1) % modes.length]);
    renderList();
  });

  $('#viewBtn').addEventListener('click', () => {
    ls.set('viewMode', body.classList.contains('deck') ? 'list' : 'deck');
    applyView(true);
  });

  $('#refreshBtn').addEventListener('click', () => {
    if (state.config.feeds.length && proxyUrl()) refresh();
  });

  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    ls.set('theme', next);
  });

  $('#relUse').addEventListener('click', () => {
    ls.set('sortPref', 'relevance'); ls.set('relSeen', '1');
    renderList();
  });
  $('#relDismiss').addEventListener('click', () => { ls.set('relSeen', '1'); $('#relNote').hidden = true; });

  const settings = $('#view-settings');
  settings.addEventListener('submit', onSettingsSubmit);
  settings.addEventListener('click', onSettingsClick);
  settings.addEventListener('change', onSettingsChange);

  $('#help').addEventListener('click', (ev) => { if (ev.target.id === 'help') ev.target.classList.remove('show'); });

  document.addEventListener('keydown', (ev) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (ev.key === '/' && !typing && view !== 'settings') { ev.preventDefault(); q.focus(); return; }
    if (typing) { if (ev.key === 'Escape') document.activeElement.blur(); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const help = $('#help');
    if (ev.key === '?') { help.classList.toggle('show'); ev.preventDefault(); return; }
    if (ev.key === 'Escape') { help.classList.remove('show'); return; }
    if (view === 'settings') return;
    const items = visibleItems();
    if (!items.length) return;
    const deck = body.classList.contains('deck');
    const cur = deck ? items[0] : (items.find(el => el.classList.contains('active')) || items[0]);
    const idx = items.indexOf(cur);
    switch (ev.key) {
      case 'j': if (!deck) setCurrent(items[Math.min(idx + 1, items.length - 1)]); break;
      case 'k': if (!deck) setCurrent(items[Math.max(idx - 1, 0)]); break;
      case 'l': cur.querySelector('[data-act=like]')?.click(); break;
      case 'd': (cur.querySelector('[data-act=skip]') || cur.querySelector('[data-act=trash]'))?.click(); break;
      default: return;
    }
    ev.preventDefault();
  });

  window.addEventListener('hashchange', route);
}

async function route() {
  const h = location.hash.replace('#', '');
  view = ['feed', 'stars', 'settings'].includes(h) ? h : 'feed';
  if (view === 'feed' && state.config.feeds.length && proxyUrl() && !cacheFresh()) {
    $$('[data-nav]').forEach(a => a.classList.toggle('contrast', a.dataset.nav === view));
    await refresh();
    return;
  }
  render();
  if (view === 'feed') enrichInBackground();
}

setupHandlers();
await loadState();
await route();
