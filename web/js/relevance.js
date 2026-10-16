// Relevanz-Ranking „Für mich" (Naive-Bayes-Log-Odds) und Streak-Statistik.
// Gleiche Logik wie in app.py.

import { stripCitation } from './feeds.js';

const STOPWORDS = new Set((
  'the a an of and or to in for on with we our this that these those is are was were be by as at ' +
  'from it its their they them than then so such can may might also more most into over under between ' +
  'across using used use within whether when what which where while there here been have has had ' +
  'does did doing done being will would could should about onto upon after before during through ' +
  'because however therefore thus both each other others some many much very only same per via ' +
  'your ours out not but toward towards based given likely often whose whom ' +
  'study studies results result effect effects research paper article papers articles journal ' +
  'volume issue abstract author authors published university department online print ahead early view ' +
  'association copyright findings finding data analysis examine examined examines investigate ' +
  'investigated present current advances directions bulletin review science sciences psychological ' +
  'psychology approach approaches model models method methods evidence associated level ' +
  'levels role roles factor factors higher lower among ' +
  'der die das und oder ein eine einer den dem des mit für auf bei aus dass wir dieser diese dieses ' +
  'von im am zur zum durch sowie wurde wurden werden ist sind war waren nicht auch nach über unter ' +
  'dabei zwischen einem eines beim hierbei wobei deren dessen welche welcher'
).split(/\s+/));

const NOISE = /\b(ahead of print|early ?view|online version of record|advance online publication)\b/gi;

export function tok(text) {
  const t = stripCitation((text || '').toLowerCase()).replace(NOISE, ' ');
  const words = t.match(/[a-zäöüß]{4,}/g) || [];
  return new Set(words.filter(w => !STOPWORDS.has(w)));
}

export function relevanceCounts(state) {
  const nLiked = Object.keys(state.starred).length;
  const nSkipped = Object.values(state.read).filter(r => r.title || r.summary).length;
  return [nLiked, nSkipped];
}

export function buildWeights(state) {
  const liked = new Map(), skipped = new Map();
  let nL = 0, nS = 0;
  for (const s of Object.values(state.starred)) {
    const snap = s.snapshot || {};
    for (const w of tok(`${snap.title || ''} ${snap.summary || ''}`)) liked.set(w, (liked.get(w) || 0) + 1);
    nL++;
  }
  for (const r of Object.values(state.read)) {
    if (!r.title && !r.summary) continue;
    for (const w of tok(`${r.title || ''} ${r.summary || ''}`)) skipped.set(w, (skipped.get(w) || 0) + 1);
    nS++;
  }
  const weights = new Map();
  for (const w of new Set([...liked.keys(), ...skipped.keys()])) {
    const l = liked.get(w) || 0, s = skipped.get(w) || 0;
    if (l + s < 2) continue;                  // zu selten → Rauschen
    weights.set(w, Math.log(((l + 1) / (nL + 2)) / ((s + 1) / (nS + 2))));
  }
  return weights;
}

export function score(text, weights) {
  const contrib = [...tok(text)].map(w => [weights.get(w) || 0, w]).sort((a, b) => b[0] - a[0]);
  const total = contrib.reduce((sum, [v]) => sum + v, 0);
  const why = contrib.filter(([v]) => v > 0).slice(0, 2).map(([, w]) => w);
  return [total, why];
}

// ---- Streak / heute gesichtet ------------------------------------------------

const localDay = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function activityStats(state) {
  const days = new Map();
  for (const r of Object.values(state.read)) if (r.read_at) { const k = localDay(r.read_at); days.set(k, (days.get(k) || 0) + 1); }
  for (const s of Object.values(state.starred)) if (s.starred_at) { const k = localDay(s.starred_at); days.set(k, (days.get(k) || 0) + 1); }
  const today = localDay(Date.now());
  let streak = 0;
  const d = new Date();
  while (days.has(localDay(d))) { streak++; d.setDate(d.getDate() - 1); }
  return [streak, days.get(today) || 0];
}
