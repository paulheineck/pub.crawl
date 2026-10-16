// Persistenz im Browser: ein kleiner Key-Value-Speicher auf IndexedDB.
// Fällt auf einen reinen Arbeitsspeicher zurück, wenn IndexedDB nicht
// verfügbar ist (z. B. manche Privat-Modi) – dann geht beim Schließen alles verloren.

import { DEFAULT_CONFIG } from './config.js';

const DB_NAME = 'pubcrawl';
const STORE = 'kv';
const memory = new Map();
let dbPromise = null;
export let persistent = true;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    }).catch(() => { persistent = false; return null; });
  }
  return dbPromise;
}

export async function get(key, fallback) {
  const db = await openDb();
  if (!db) return memory.has(key) ? memory.get(key) : fallback;
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result === undefined ? fallback : req.result);
    req.onerror = () => resolve(fallback);
  });
}

export async function set(key, value) {
  const db = await openDb();
  if (!db) { memory.set(key, value); return; }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Anwendungszustand ----------------------------------------------------
// config:    Feeds, Filter, Anzeige, API, Proxy (wie config.yaml)
// starred:   { id: { starred_at, snapshot, note } }        (Leseliste)
// read:      { id: { read_at, title, summary } }           (Skips / gelesen)
// meta:      { doi: { ts, abstract, authors_display, authors_full } }
// doiByTitle:{ title: { ts, doi } }
// feedCache: { ts, items: [ { name, error, entries } ] }

export const state = {
  config: structuredClone(DEFAULT_CONFIG),
  starred: {},
  read: {},
  meta: {},
  doiByTitle: {},
  feedCache: null,
};

export async function loadState() {
  const cfg = await get('config', null);
  state.config = mergeConfig(cfg);
  state.starred = await get('starred', {});
  state.read = await get('read', {});
  state.meta = await get('meta', {});
  state.doiByTitle = await get('doiByTitle', {});
  state.feedCache = await get('feedCache', null);
}

function mergeConfig(cfg) {
  const base = structuredClone(DEFAULT_CONFIG);
  if (!cfg) return base;
  return {
    ...base, ...cfg,
    filters: { ...base.filters, ...(cfg.filters || {}) },
    display: { ...base.display, ...(cfg.display || {}) },
    api: { ...base.api, ...(cfg.api || {}) },
  };
}

// Einzelne Teile speichern (Fehler nur loggen – die UI soll weiterlaufen)
export function save(...keys) {
  return Promise.all(keys.map(k => set(k, state[k]).catch(e => console.error('save', k, e))));
}
