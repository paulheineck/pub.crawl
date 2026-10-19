// Pub.Crawl auf Cloudflare: liefert die App aus web/ aus (statische Assets) und
// beantwortet /proxy?url=<feed-url> als Feed-Proxy. Der Proxy speichert nichts
// außer einem 10-Minuten-Cache am Edge.
//
// Statische Dateien (index.html, js/…) bedient Cloudflare selbst, bevor dieses
// Skript läuft – hier landen nur Anfragen, zu denen es keine Datei gibt.
//
// Sicherheit: Proxy-Antworten kommen von der eigenen Domain. Damit fremder Inhalt
// dort nie als Seite, Skript oder Service Worker laufen kann,
//   1. bedient der Proxy nur fetch()-Anfragen (Sec-Fetch-Dest: empty),
//   2. reicht er nur Dokumente weiter, die wie RSS/Atom/RDF beginnen,
//   3. liefert er alles als text/plain mit nosniff und CSP-Sandbox aus.

const UA = 'Pub.Crawl/1.0 (+https://pub-crawl.app)';
const MAX_BYTES = 5 * 1024 * 1024;
const CACHE_SECONDS = 600;

const SAFE_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',      // die App liest per res.text(), der Typ ist ihr egal
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};

// Wer darf den Proxy nutzen? Die App selbst (same origin) und localhost.
// Weitere Websites über die Variable ALLOWED_ORIGINS (kommagetrennt, "*" = alle).
function allowedOrigin(req, env) {
  // Nur fetch()/XHR. Navigation (Link, Adresszeile), <script>, <iframe>, Service Worker: abgelehnt.
  const dest = req.headers.get('Sec-Fetch-Dest');
  if (dest && dest !== 'empty') return null;

  const origin = req.headers.get('Origin');
  if (!origin) {
    // Gleiche Seite: Browser schicken bei GET keinen Origin, aber Sec-Fetch-Site.
    // Fehlt auch das (alter Browser, curl), entscheidet der Feed-Check weiter unten.
    const site = req.headers.get('Sec-Fetch-Site');
    return !site || site === 'same-origin' ? 'same' : null;
  }
  if (origin === new URL(req.url).origin) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.includes('*')) return '*';
  return list.includes(origin) ? origin : null;
}

function reply(body, status, origin, extra = {}) {
  const h = { ...SAFE_HEADERS, 'Vary': 'Origin', ...extra };
  if (origin && origin !== 'same') h['Access-Control-Allow-Origin'] = origin;
  return new Response(body, { status, headers: h });
}

// Nur normale Web-Adressen: kein localhost, keine IP-Literale, keine Zugangsdaten, keine Sonder-Ports
function checkTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  if (u.username || u.password) return null;
  if (u.port && !['80', '443'].includes(u.port)) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || !h.includes('.')) return null;
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return null;   // IPv4/IPv6
  return u;
}

// Beginnt das Dokument wie ein Feed? (nach BOM, <?xml …?>, Kommentaren, DOCTYPE)
const FEED_ROOT = /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*<(?:[\w.-]+:)?(?:rss|feed|RDF)[\s>/]/i;
export function looksLikeFeed(bytes) {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '');
  return FEED_ROOT.test(head);
}

// Body mit Obergrenze lesen (Content-Length fehlt bei gestreamten Antworten oft)
async function readLimited(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); throw new Error('zu groß'); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

async function proxy(req, env, ctx) {
  const origin = allowedOrigin(req, env);
  if (req.method === 'OPTIONS') {
    return reply(null, 204, origin, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' });
  }
  if (req.method !== 'GET') return reply('Nur GET', 405, origin);
  if (!origin) return reply('Nicht erlaubt', 403, null);

  const u = checkTarget(new URL(req.url).searchParams.get('url') || '');
  if (!u) return reply('Parameter url fehlt oder ist nicht erlaubt', 400, origin);

  // Kurz am Cloudflare-Edge cachen: schont die Verlage, wenn viele Leute dasselbe Journal lesen
  const cache = caches.default;
  const key = new Request(u.toString());
  const hit = await cache.match(key);
  let body;
  if (hit) {
    body = new Uint8Array(await hit.arrayBuffer());
  } else {
    let upstream;
    try {
      upstream = await fetch(u.toString(), {
        headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
        redirect: 'follow',
      });
    } catch (e) {
      return reply(`Upstream nicht erreichbar: ${e.message}`, 502, origin);
    }
    if (!upstream.ok) return reply(`Upstream HTTP ${upstream.status}`, 502, origin);
    if (Number(upstream.headers.get('Content-Length') || 0) > MAX_BYTES) return reply('Feed zu groß', 413, origin);
    try { body = await readLimited(upstream, MAX_BYTES); } catch { return reply('Feed zu groß', 413, origin); }
    // HTML, Skripte, Bot-Sperrseiten usw. gar nicht erst weiterreichen (die App weicht dann auf CrossRef aus)
    if (!looksLikeFeed(body)) return reply('Kein RSS/Atom-Feed unter dieser Adresse', 502, origin);
    ctx.waitUntil(cache.put(key, new Response(body.slice(), {
      headers: { ...SAFE_HEADERS, 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
    })));
  }

  return reply(body, 200, origin, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path === '/proxy' || path === '/proxy/') return proxy(req, env, ctx);
    return new Response('Nicht gefunden', { status: 404 });
  },
};
