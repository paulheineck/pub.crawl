"""Lokaler Testserver für die Browser-Version (nur Python-Standardbibliothek).

Liefert web/ statisch aus und spielt unter /proxy?url=… den Feed-Proxy –
so lässt sich alles ohne Cloudflare-Worker ausprobieren.

    python web/dev_server.py        →  http://localhost:8765
"""
import http.server
import os
import urllib.parse
import urllib.request

PORT = int(os.environ.get("PORT", 8765))
ROOT = os.path.dirname(os.path.abspath(__file__))
UA = "Mozilla/5.0 (Pub.Crawl dev proxy)"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/proxy":
            return super().do_GET()
        target = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
        if not target.startswith(("http://", "https://")):
            return self.send_error(400, "url fehlt oder ungültig")
        try:
            req = urllib.request.Request(target, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"})
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read()
                ctype = r.headers.get("Content-Type", "application/xml")
        except Exception as e:  # noqa: BLE001
            return self.send_error(502, f"Upstream: {e}")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"Pub.Crawl (Browser-Version) läuft auf http://localhost:{PORT}  – Beenden mit Strg+C")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
