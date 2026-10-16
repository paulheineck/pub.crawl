// Pub.Crawl auf Cloudflare: liefert die App aus web/ aus (statische Assets) und
// beantwortet /proxy?url=<feed-url> als Feed-Proxy. Der Proxy speichert nichts.
//
// Statische Dateien (index.html, js/…) bedient Cloudflare selbst, bevor dieses
// Skript läuft – hier landen nur Anfragen, zu denen es keine Datei gibt.

const UA = 'Pub.Crawl/1.0 (+browser research feed reader)';
const MAX_BYTES = 5 * 1024 * 1024;

// Wer darf den Proxy nutzen? Immer: die App selbst (same origin) und localhost.
// Weitere Websites über die Variable ALLOWED_ORIGINS (kommagetrennt, "*" = alle).
function allowedOrigin(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return 'same';                                  // gleiche Seite: Browser schickt keinen Origin
  if (origin === new URL(req.url).origin) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.includes('*')) return '*';
  return list.includes(origin) ? origin : null;
}

function reply(body, status, origin, extra = {}) {
  const h = { 'Vary': 'Origin', ...extra };
  if (origin && origin !== 'same') h['Access-Control-Allow-Origin'] = origin;
  return new Response(body, { status, headers: h });
}

async function proxy(req, env, ctx) {
  const origin = allowedOrigin(req, env);
  if (req.method === 'OPTIONS') {
    return reply(null, 204, origin, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' });
  }
  if (req.method !== 'GET') return reply('Nur GET', 405, origin);
  if (!origin) return reply('Origin nicht erlaubt', 403, null);

  const target = new URL(req.url).searchParams.get('url') || '';
  let u;
  try { u = new URL(target); } catch { return reply('Parameter url fehlt oder ist ungültig', 400, origin); }
  if (!['http:', 'https:'].includes(u.protocol)) return reply('Nur http(s)', 400, origin);

  // Kurz am Cloudflare-Edge cachen: schont die Verlage, wenn viele Leute dasselbe Journal lesen
  const cache = caches.default;
  const key = new Request(u.toString());
  let upstream = await cache.match(key);
  if (!upstream) {
    try {
      upstream = await fetch(u.toString(), {
        headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
        redirect: 'follow',
      });
    } catch (e) {
      return reply(`Upstream nicht erreichbar: ${e.message}`, 502, origin);
    }
    if (!upstream.ok) return reply(`Upstream HTTP ${upstream.status}`, 502, origin);
    const len = Number(upstream.headers.get('Content-Length') || 0);
    if (len > MAX_BYTES) return reply('Feed zu groß', 413, origin);
    upstream = new Response(upstream.body, upstream);
    upstream.headers.set('Cache-Control', 'public, max-age=600');
    ctx.waitUntil(cache.put(key, upstream.clone()));
  }

  return reply(upstream.body, 200, origin, {
    'Content-Type': upstream.headers.get('Content-Type') || 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=600',
  });
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path === '/proxy' || path === '/proxy/') return proxy(req, env, ctx);
    return new Response('Nicht gefunden', { status: 404 });
  },
};
