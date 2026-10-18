// Pub.Crawl – Browser-Version. Ansichten, Stapel, Leseliste, Einstellungen.

import { state, loadState, save, persistent } from './store.js';
import {
  DEFAULT_PROXY, CACHE_MINUTES, MIN_REL, MAX_SKIPS, DEPTH, STACK_H, META_CONCURRENCY,
} from './config.js';
import {
  fetchOneFeed, probeFeed, compilePattern, matchFilters, highlight, escapeHtml as esc, extractStats, relDate,
} from './feeds.js';
import { getMeta, doiByTitle, persistMeta, openAccessUrl, risFor } from './meta.js';
import { buildWeights, score, relevanceCounts, activityStats } from './relevance.js';
import { enableSwipe } from './swipe.js';

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
let includeRes = [], excludeRes = [];
let hiddenByFilter = 0;
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
  excludeRes = (state.config.filters.exclude || []).map(p => compilePattern(p)).filter(Boolean);
}

// ===========================================================================
// Feeds holen + Metadaten im Hintergrund ergänzen
// ===========================================================================

function configKey() {
  const c = state.config;
  return JSON.stringify([c.feeds.map(f => f.url).sort(), c.display.max_items_per_feed, proxyUrl()]);
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
  // Alle Feeds holen (auch ausgeschaltete) – Filter und An/Aus greifen erst beim Anzeigen,
  // so wirken Änderungen in den Einstellungen sofort ohne neuen Abruf.
  // ISSN aus dem Katalog ergänzen (Ausweichweg über CrossRef, falls der Verlag den Proxy sperrt)
  const issnByUrl = new Map((await loadCatalog()).filter(j => j.issn).map(j => [j.url, j.issn]));
  const feeds = (c.feeds || [])
    .map(f => (f.issn || !issnByUrl.has(f.url) ? f : { ...f, issn: issnByUrl.get(f.url) }));
  const ctx = { includeRes: [], excludeRes: [], maxItems: c.display.max_items_per_feed || 30, proxy: proxyUrl() };
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

const activeFeedNames = () => new Set(state.config.feeds.filter(f => !f.off).map(f => f.name));

function feedEntries() {
  const out = [], seen = new Set();
  const active = activeFeedNames();
  hiddenByFilter = 0;
  for (const f of state.feedCache?.items || []) {
    if (!active.has(f.name)) continue;
    for (const e of f.entries) {
      if (state.read[e.id] || state.starred[e.id]) continue;
      if (!matchFilters(`${e.title} ${e.summary}`, includeRes, excludeRes)) { hiddenByFilter++; continue; }
      const key = e.doi ? 'doi:' + e.doi.toLowerCase() : 'ti:' + normTitle(e.title);
      if (seen.has(key)) continue;       // gleiches Paper aus mehreren Feeds
      seen.add(key);
      out.push(e);
    }
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
    ${mode === 'feed' ? `<div class="swipe-hint like" aria-hidden="true">♥ Merken</div>
    <div class="swipe-hint skip" aria-hidden="true">✕ Weg</div>
    <div class="choicebar">
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
      const active = activeFeedNames();
      const errs = (state.feedCache?.items || []).filter(f => f.error && active.has(f.name));
      if (errs.length) {
        parts.push(`<article class="notice warn">⚠ ${errs.length} Feed(s) nicht erreichbar
          (<a href="#settings">Details</a>): ${errs.map(f => esc(f.name)).join(', ')}</article>`);
      }
      const inc = filterTerms(c.filters.include);
      if (inc.length || hiddenByFilter) {
        parts.push(`<article class="notice info filter-note">🔍 Filter aktiv${inc.length
          ? ` – nur Artikel mit ${inc.map(t => `„${esc(t.label)}"`).join(', ')}` : ''}${hiddenByFilter
          ? ` · ${hiddenByFilter} ausgeblendet` : ''} · <a href="#settings">ändern</a></article>`);
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
    maybeSwipeHint();
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
    const fly = deck ? Math.sign(dx) * Math.max(420, innerWidth) : dx;
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
  card.style.removeProperty('--swipe');          // Wisch-Stempel wieder ausblenden
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
  toast.querySelector('.toast-undo').hidden = !undoFn;
  toast.classList.add('show');
  toast.querySelector('.toast-undo').onclick = () => {
    clearTimeout(toastTimer);
    toast.classList.remove('show');
    undoFn();
  };
  toastTimer = setTimeout(() => toast.classList.remove('show'), 5000);
}

// Einmaliger Tipp für Touch-Geräte, sobald der Stapel zum ersten Mal da ist
const isTouch = () => matchMedia('(pointer: coarse)').matches;
function maybeSwipeHint() {
  if (!isTouch() || ls.get('swipeHintSeen') === '1') return;
  if (view !== 'feed' || !body.classList.contains('deck') || !visibleItems().length) return;
  ls.set('swipeHintSeen', '1');
  showToast('👉 Wischen: rechts = merken, links = weg', null);
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
    ...state.config.feeds.filter(f => !f.url.startsWith('crossref:')).map(f =>   // nur echte RSS-Feeds
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

// Komplett-Backup: Journals, Filter, Leseliste mit Notizen, Likes/Skips.
// Die Felder starred/read sind kompatibel mit der lokalen Python-Version.
function exportState() {
  const c = state.config;
  const data = {
    version: 1, app: 'Pub.Crawl (web)', exported_at: nowIso(),
    config: { feeds: c.feeds, filters: { include: c.filters.include, exclude: c.filters.exclude } },
    starred: Object.entries(state.starred).map(([id, s]) =>
      ({ id, starred_at: s.starred_at, snapshot: s.snapshot, note: s.note || '' })),
    read: Object.entries(state.read).map(([id, r]) =>
      ({ id, read_at: r.read_at, title: r.title || '', summary: r.summary || '' })),
  };
  const day = new Date().toISOString().slice(0, 10);
  download(`pubcrawl-backup-${day}.json`, JSON.stringify(data, null, 2), 'application/json');
}

// Python-Version speichert "YYYY-MM-DD HH:MM:SS" (UTC) → in ISO umwandeln
function normTs(t) {
  if (!t) return nowIso();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) return t.replace(' ', 'T') + 'Z';
  return t;
}

// Führt zusammen – überschreibt und löscht nichts
function importState(text) {
  const data = JSON.parse(text);
  const c = state.config;
  let f = 0, s = 0, r = 0;
  for (const feed of data.config?.feeds || []) {
    if (!feed?.url || c.feeds.some(x => x.url === feed.url || x.name === feed.name)) continue;
    c.feeds.push(feed);
    f++;
  }
  for (const key of ['include', 'exclude']) {
    for (const p of data.config?.filters?.[key] || []) {
      if (compilePattern(p) && !c.filters[key].includes(p)) c.filters[key].push(p);
    }
  }
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
  save('config', 'starred', 'read');
  return [f, s, r];
}

// ===========================================================================
// Filter: Wörter statt Regex. Gespeichert wird weiter als Muster-Liste,
// ein Wort „depress" wird zu (?i)\bdepress (findet auch depression, depressive).
// ===========================================================================

const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function filterTerms(patterns) {
  const out = [];
  for (const p of patterns || []) {
    const body = p.replace(/^\(\?i\)/, '');
    const parts = body.split('|').map(x => x.replace(/^\\b/, '').replace(/\\b$/, ''));
    if (parts.every(x => x && !/(^|[^\\])[()[\]{}^$*+?.]/.test(x))) {
      for (const x of parts) out.push({ label: x.replace(/\\(.)/g, '$1'), pattern: null });
    } else {
      out.push({ label: p, pattern: p });     // echtes Regex-Muster bleibt unverändert
    }
  }
  return out;
}

const termToPattern = (t) => t.pattern || `(?i)\\b${escRe(t.label)}`;

function chipsEditor(key, placeholder) {
  return `<div class="term-box" data-list="${key}">
    ${filterTerms(state.config.filters[key]).map(t => `<span class="term${t.pattern ? ' raw' : ''}"
      data-label="${esc(t.label)}"${t.pattern ? ` data-pattern="${esc(t.pattern)}"` : ''}>${esc(t.label)}<button
      type="button" data-act="term-del" aria-label="${esc(t.label)} entfernen">×</button></span>`).join('')}
    <input type="text" class="term-input" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">
  </div>`;
}

async function saveTerms(box) {
  const terms = $$('.term', box).map(el => ({ label: el.dataset.label, pattern: el.dataset.pattern || null }));
  state.config.filters[box.dataset.list] = terms.map(termToPattern);
  await save('config');
  const ok = $('#view-settings .saved');
  if (ok) { ok.hidden = false; clearTimeout(ok._t); ok._t = setTimeout(() => { ok.hidden = true; }, 1500); }
}

function addTerm(input) {
  const label = input.value.replace(/,$/, '').trim();
  input.value = '';
  const box = input.closest('.term-box');
  if (!label || $$('.term', box).some(el => el.dataset.label.toLowerCase() === label.toLowerCase())) return;
  const chip = document.createElement('span');
  chip.className = 'term';
  chip.dataset.label = label;
  chip.innerHTML = `${esc(label)}<button type="button" data-act="term-del" aria-label="${esc(label)} entfernen">×</button>`;
  box.insertBefore(chip, input);
  saveTerms(box);
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

const tip = (text) => `<span class="tip" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(text)}">?</span>`;

async function renderSettings() {
  const c = state.config;
  const catalog = await loadCatalog();
  const subscribed = new Set(c.feeds.map(f => f.url));
  const groups = {};
  for (const j of catalog) if (!subscribed.has(j.url)) (groups[j.category || 'Sonstige'] ||= []).push(j);
  const active = activeFeedNames();
  const errors = (state.feedCache?.items || []).filter(f => f.error && active.has(f.name));
  const msg = flash; flash = '';

  $('#view-settings').innerHTML = `
  <h2 style="margin-top:1rem;">Einstellungen</h2>
  ${msg ? `<article class="notice info">${esc(msg)}</article>` : ''}
  ${errors.length ? `<article class="notice warn"><strong>⚠ ${errors.length} Journal(s) gerade nicht erreichbar</strong>
    <ul style="margin:.4rem 0 0 0;">${errors.map(f => `<li>${esc(f.name)}
    <span class="muted">— ${esc(f.error)}</span></li>`).join('')}</ul></article>` : ''}

  <section class="set">
    <h3>📚 Deine Journals ${tip('Aus diesen Journals kommen die Artikel im Feed. Mit dem Schalter blendest du ein Journal vorübergehend aus, ohne es zu löschen.')}</h3>
    ${c.feeds.length ? `<table class="journals"><tbody>
      ${c.feeds.map(f => `<tr class="${f.off ? 'off' : ''}">
        <td style="width:1%;"><input type="checkbox" role="switch" data-toggle="feed" data-name="${esc(f.name)}"
          ${f.off ? '' : 'checked'} aria-label="${esc(f.name)} im Feed zeigen"></td>
        <td><span title="${esc(f.url)}">${esc(f.name)}</span></td>
        <td style="width:1%;"><button class="secondary outline" data-act="remove-feed" data-name="${esc(f.name)}"
          title="Journal entfernen">Entfernen</button></td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">Noch keine Journals – wähle unten welche aus dem Katalog.</p>'}

    ${Object.keys(groups).length ? `<details ${c.feeds.length ? '' : 'open'}><summary>➕ Journals aus dem Katalog hinzufügen</summary>
      <form data-form="catalog">
        ${Object.entries(groups).map(([cat, items]) => `<fieldset><legend><strong>${esc(cat)}</strong></legend>
          <div class="row" style="gap:1.25rem;">${[...items].sort((x, y) => x.name.localeCompare(y.name, 'de')).map(j =>
            `<label><input type="checkbox" name="catalog" value="${esc(j.url)}"> ${esc(j.name)}</label>`).join('')}</div>
        </fieldset>`).join('')}
        <button type="submit" style="width:auto;">Ausgewählte hinzufügen</button>
      </form>
    </details>` : ''}

    <details><summary>➕ Anderes Journal per RSS-Link hinzufügen ${tip('Fast jedes Journal hat einen RSS-Feed: Auf der Journal-Website nach „RSS", „Feeds" oder dem orangen Feed-Symbol suchen (oft bei „Latest articles" oder „Alerts") und den Link kopieren.')}</summary>
      <form data-form="add-feed">
        <label>Name <input name="name" required placeholder="z. B. Journal of Experimental Social Psychology"></label>
        <label>RSS-Link <input name="url" required placeholder="https://…"></label>
        <div class="row"><button type="button" class="secondary" data-act="test-feed">Link testen</button><span id="testOut" class="muted"></span></div>
        <button type="submit" style="width:auto;">Hinzufügen</button>
      </form>
    </details>
  </section>

  <section class="set">
    <h3>🔍 Filter ${tip('Wörter werden in Titel und Abstract gesucht, Groß-/Kleinschreibung egal. Ein Wortanfang reicht: „depress" findet auch depression und depressive. Wort eintippen und Enter drücken.')}
      <span class="saved muted" hidden>✓ gespeichert</span></h3>
    <label class="term-label">Nur Artikel zeigen, die eines dieser Wörter enthalten <span class="muted">(leer = alle Artikel)</span></label>
    ${chipsEditor('include', 'Wort eingeben + Enter, z. B. loneliness')}
    <label class="term-label">Artikel mit diesen Wörtern ausblenden</label>
    ${chipsEditor('exclude', 'Wort eingeben + Enter, z. B. erratum')}
  </section>

  <section class="set">
    <h3>💾 Sichern &amp; auf anderes Gerät übertragen ${tip('Deine Daten liegen nur in diesem Browser. Mit dem Backup sicherst du sie oder nimmst sie auf einen anderen Rechner oder Browser mit: dort einfach „Backup laden".')}</h3>
    <p class="muted">Ein Backup enthält alles: deine Journals, Filter, die Leseliste mit Notizen und deine Likes/Skips
      (fürs „Für mich"-Ranking). Laden <strong>ergänzt</strong> nur – es wird nichts überschrieben oder gelöscht.</p>
    <div class="row">
      <button type="button" data-act="export-state">⬇️ Backup herunterladen</button>
      <label role="button" class="secondary outline file-btn">⬆️ Backup laden
        <input type="file" data-file="state" accept=".json,application/json" hidden></label>
    </div>
    <details><summary>Journal-Liste für andere Feed-Reader (OPML) ${tip('OPML ist ein Standardformat für Feed-Listen. Das brauchst du nur, wenn du deine Journals in Feedly, Inoreader o. Ä. übernehmen willst – oder von dort hierher.')}</summary>
      <div class="row">
        <button type="button" class="secondary outline" data-act="export-opml">⬇️ Als OPML herunterladen</button>
        <label role="button" class="secondary outline file-btn">⬆️ OPML laden
          <input type="file" data-file="opml" accept=".opml,.xml,text/xml" hidden></label>
      </div>
    </details>
  </section>

  <section class="set">
    <h3>📄 PDF-Links ${tip('Der „📄 PDF"-Link sucht über den Dienst Unpaywall nach einer frei zugänglichen Version des Artikels. Unpaywall verlangt dafür eine E-Mail-Adresse; sie wird nur an Unpaywall geschickt. Ohne Adresse öffnet der Link die Verlagsseite.')}</h3>
    <form data-form="unpaywall" class="row">
      <input type="email" name="email" value="${esc(c.api.unpaywall_email || '')}" placeholder="E-Mail für Unpaywall (optional)"
        aria-label="E-Mail für Unpaywall" style="flex:1;min-width:220px;margin:0;">
      <button type="submit" class="secondary">Speichern</button>
    </form>
  </section>

  <section class="set">
    <h3>🎨 Darstellung</h3>
    <label style="display:flex;align-items:center;gap:.5rem;">
      <input type="checkbox" role="switch" data-toggle="anim" ${ls.get('animateCards') !== '0' ? 'checked' : ''}>
      Karten beim Liken/Ausblenden wegfliegen lassen
    </label>
  </section>

  <p class="muted" style="margin-top:2rem;">🔒 Alles liegt nur in diesem Browser auf diesem Gerät – kein Konto, kein Server.
    Wer die Browserdaten löscht, löscht auch Pub.Crawl. Lade ab und zu ein Backup herunter.</p>`;
}

function settingsMsg(m) {
  flash = m;
  renderSettings();
  window.scrollTo({ top: 0 });
}

async function onSettingsSubmit(ev) {
  ev.preventDefault();
  const form = ev.target;
  const fd = new FormData(form);
  const c = state.config;
  switch (form.dataset.form) {
    case 'add-feed': {
      const name = String(fd.get('name')).trim(), url = String(fd.get('url')).trim();
      if (c.feeds.some(f => f.name === name)) return settingsMsg('Ein Journal mit diesem Namen gibt es schon');
      form.querySelector('[type=submit]').setAttribute('aria-busy', 'true');
      const p = await probeFeed(url, proxyUrl());
      if (!p.ok) return settingsMsg(`Unter diesem Link wurde kein Feed gefunden (${p.error})`);
      c.feeds.push({ name, url });
      await save('config');
      return settingsMsg(`„${name}" hinzugefügt (${p.count} Artikel)`);
    }
    case 'catalog': {
      const byUrl = new Map((await loadCatalog()).map(j => [j.url, j]));
      let n = 0;
      for (const u of fd.getAll('catalog')) {
        const j = byUrl.get(u);
        if (!j || c.feeds.some(f => f.url === u || f.name === j.name)) continue;
        c.feeds.push(j.issn ? { name: j.name, url: j.url, issn: j.issn } : { name: j.name, url: j.url });
        n++;
      }
      await save('config');
      return settingsMsg(`${n} Journal(s) hinzugefügt – im Feed geht's los.`);
    }
    case 'unpaywall':
      c.api.unpaywall_email = String(fd.get('email') || '').trim();
      await save('config');
      return settingsMsg(c.api.unpaywall_email ? 'E-Mail gespeichert' : 'E-Mail entfernt');
  }
}

async function onSettingsClick(ev) {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const c = state.config;
  switch (b.dataset.act) {
    case 'remove-feed': {
      const name = b.dataset.name;
      if (!confirm(`„${name}" wirklich entfernen?`)) return;
      c.feeds = c.feeds.filter(f => f.name !== name);
      await save('config');
      return settingsMsg(`„${name}" entfernt`);
    }
    case 'test-feed': {
      const out = $('#testOut');
      const url = b.form.elements.url.value.trim();
      if (!url) { out.textContent = 'Bitte Link eingeben.'; return; }
      out.textContent = 'Teste …';
      const p = await probeFeed(url, proxyUrl());
      out.textContent = p.ok ? `✓ funktioniert – ${p.count} Artikel` : `✕ kein Feed gefunden (${p.error})`;
      return;
    }
    case 'term-del': {
      const box = b.closest('.term-box');
      b.closest('.term').remove();
      saveTerms(box);
      return;
    }
    case 'export-opml': exportOpml(); return;
    case 'export-state': exportState(); return;
  }
}

function onSettingsKeydown(ev) {
  const input = ev.target.closest('.term-input');
  if (!input) return;
  if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); addTerm(input); }
  else if (ev.key === 'Backspace' && !input.value) {       // Backspace im leeren Feld: letztes Wort weg
    const last = input.previousElementSibling;
    if (last?.classList.contains('term')) { last.remove(); saveTerms(input.closest('.term-box')); }
  }
}

async function onSettingsChange(ev) {
  const t = ev.target;
  if (t.dataset.toggle === 'anim') { ls.set('animateCards', t.checked ? '1' : '0'); return; }
  if (t.dataset.toggle === 'feed') {
    const f = state.config.feeds.find(x => x.name === t.dataset.name);
    if (f) { if (t.checked) delete f.off; else f.off = true; }
    t.closest('tr').classList.toggle('off', !t.checked);
    await save('config');
    return;
  }
  if (t.classList.contains('term-input')) { addTerm(t); return; }      // Feld verlassen = Wort übernehmen
  if (!t.dataset.file || !t.files?.[0]) return;
  try {
    const text = await t.files[0].text();
    if (t.dataset.file === 'opml') {
      const n = importOpml(text);
      await save('config');
      settingsMsg(`${n} Journal(s) aus OPML übernommen`);
    } else {
      const [f, s, r] = importState(text);
      settingsMsg(`Backup geladen: +${f} Journals, +${s} auf der Leseliste, +${r} Likes/Skips`);
    }
  } catch (e) {
    settingsMsg(`Laden fehlgeschlagen: ${e.message}`);
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
  enableSwipe(listEl, {
    canSwipe: (card) => view === 'feed' && body.classList.contains('deck')
      && card.classList.contains('d0') && !card.classList.contains('leaving'),
    onSwipe: (card, dir) => {
      const e = current.get(card.dataset.id);
      if (!e) return;
      navigator.vibrate?.(10);                    // kurzes Feedback (Android)
      if (dir === 'right') like(e, card); else skip(e, card);
    },
  });

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
  settings.addEventListener('keydown', onSettingsKeydown);

  // Hilfe-Bubbles am rechten Bildschirmrand nach links rücken, damit sie ganz sichtbar sind
  const placeTip = (ev) => {
    const t = ev.target.closest?.('.tip');
    if (!t) return;
    const w = Math.min(340, innerWidth * 0.78);
    const overflow = t.getBoundingClientRect().left - 8 + w - (document.documentElement.clientWidth - 12);
    t.style.setProperty('--tip-dx', `${Math.min(0, -overflow)}px`);
  };
  document.addEventListener('mouseover', placeTip);
  document.addEventListener('focusin', placeTip);
  // „?" in einer Aufklapp-Zeile: nur die Hilfe zeigen, nicht auf-/zuklappen
  // Antippen schaltet die Bubble an/aus (Touch-Geräte); Tippen woanders schließt sie
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest?.('.tip');
    $$('.tip.open').forEach(x => { if (x !== t) x.classList.remove('open'); });
    if (t) { ev.preventDefault(); placeTip(ev); t.classList.toggle('open'); }
  });

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

// Alte Allowlist (nur diese Journals zeigen) → An/Aus-Schalter je Journal
function migrateAllowlist() {
  const allow = state.config.filters.journal_allowlist || [];
  if (!allow.length) return;
  for (const f of state.config.feeds) if (!allow.includes(f.name)) f.off = true;
  state.config.filters.journal_allowlist = [];
  save('config');
}

setupHandlers();
await loadState();
migrateAllowlist();
await route();
