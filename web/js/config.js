// Grundeinstellungen der Browser-Version.

// Feed-Proxy. Standard: derselbe Server, der die App ausliefert – der Cloudflare
// Worker (web/proxy/worker.js) bzw. lokal dev_server.py antworten unter /proxy.
// Nur wenn die App woanders liegt als der Worker (z. B. GitHub Pages), hier die
// volle Worker-Adresse eintragen: 'https://<name>.<account>.workers.dev/proxy?url='
// In der App unter Einstellungen → „Feed-Proxy" lässt er sich auch überschreiben.
export const WORKER_PROXY = '';
export const DEFAULT_PROXY = WORKER_PROXY || '/proxy?url=';

export const CACHE_MINUTES = 10;     // so lange gilt ein geholter Feed-Stand als frisch
export const META_TTL_DAYS = 7;      // Cache für Abstracts/Autoren/DOIs
export const MIN_REL = 10;           // ab so vielen Likes UND Skips: Relevanz-Ranking
export const MAX_SKIPS = 2000;       // so viele Skips (mit Text) werden vorgehalten
export const DEPTH = 5;              // sichtbare Karten im Stapel
export const STACK_H = 340;          // Höhe der hinteren Stapelkarten (px)
export const META_CONCURRENCY = 3;   // parallele CrossRef/OpenAlex-Anfragen
export const MAILTO = 'pubcrawl@users.noreply.github.com';   // höflicher API-Pool

export const DEFAULT_CONFIG = {
  feeds: [],
  filters: {
    include: [],
    exclude: ['(?i)erratum|corrigendum|call for papers'],
    journal_allowlist: [],
  },
  display: { max_items_per_feed: 30 },
  api: { unpaywall_email: '' },
  proxy: '',          // leer = DEFAULT_PROXY
};
