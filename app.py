import os, re, time, sqlite3, hashlib, datetime as dt, pathlib, traceback
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as xml_escape
from concurrent.futures import ThreadPoolExecutor, as_completed

import yaml
import feedparser
import requests
from dateutil import parser as dparser
from bs4 import BeautifulSoup
import json 
import random

from flask import (
    Flask, render_template, request, abort,
    make_response, jsonify, Response, redirect, url_for
)

# ----------------------------- Config & Constants -----------------------------

APP_ROOT = pathlib.Path(__file__).parent.resolve()
DB_PATH  = APP_ROOT / "dashboard.db"
CATALOG_PATH = APP_ROOT / "journals.yaml"
USER_AGENT = "ResearchDashboard/1.0 (+local)"

CACHE_MINUTES = 10
MAX_WORKERS = 6


# ----------------------------- Flask -----------------------------------------

app = Flask(__name__)
app.secret_key = os.environ.get("DASHBOARD_SECRET", "dev-secret")  # für Flash/Cookies

# Security Headers
@app.after_request
def add_security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # relativ lockere CSP, damit externe Feeds/Links ok sind
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "img-src 'self' data: https:; "
        "style-src 'self' https://unpkg.com 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline'; "
        "connect-src 'self' https:; "
        "frame-ancestors 'none'"
    )
    return resp

# ----------------------------- Utilities -------------------------------------

def load_cfg():
    with open(APP_ROOT / "config.yaml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

def load_catalog():
    """Mitgelieferter Journal-Katalog (journals.yaml) für die Schnellauswahl."""
    if not CATALOG_PATH.exists():
        return []
    try:
        with open(CATALOG_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or []
        return [c for c in data if c.get("name") and c.get("url")]
    except Exception:
        return []

def norm_title(t):
    """Normalisierter Titel für Dedup über Feeds hinweg."""
    return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()

def clean_html(s):
    txt = BeautifulSoup(s or "", "html.parser").get_text(" ")
    return re.sub(r"\s+", " ", txt).strip()

def parse_date(entry):
    for key in ("published","updated","pubDate"):
        if key in entry:
            try:
                return dparser.parse(entry[key]).strftime("%Y-%m-%d")
            except Exception:
                pass
    return ""

def rel_datetime(iso_str):
    try:
        dt_obj = dparser.parse(iso_str)
        delta = dt.datetime.now() - dt_obj
        days = delta.days
        if days < 1:
            hours = int(delta.total_seconds() // 3600)
            if hours <= 0:
                mins = int(delta.total_seconds() // 60)
                return f"vor {mins} Min"
            return f"vor {hours} Std"
        if days == 1: return "gestern"
        return f"vor {days} Tagen"
    except Exception:
        return iso_str

def match_filters(title, summary, include_res, exclude_res):
    text = f"{title} {summary}"
    if include_res and not any(r.search(text) for r in include_res):
        return False
    if exclude_res and any(r.search(text) for r in exclude_res):
        return False
    return True

def highlight_terms(text, regexes):
    if not text or not regexes: 
        return text, False
    hit = False
    def repl(m):
        nonlocal hit
        hit = True
        return f"<mark>{m.group(0)}</mark>"
    s = text
    for r in regexes:
        s = r.sub(repl, s)
    return s, hit

def extract_stats(summary):
    # sehr einfache Heuristiken
    if not summary: 
        return {}
    out = {}
    mN = re.search(r'\bN\s*=\s*(\d[\d,\.]*)', summary, flags=re.I)
    if mN: out["N"] = mN.group(1).replace(",", "")
    if re.search(r'\bmeta-?analysis\b', summary, flags=re.I):
        out["meta"] = True
    if re.search(r'\bpre-?registered|registered report\b', summary, flags=re.I):
        out["prereg"] = True
    return out

def find_doi(title, summary):
    # 1) direkter DOI im Text
    text = f"{title} {summary}"
    m = re.search(r'\b10\.\d{4,9}/\S+\b', text, flags=re.I)
    if m:
        return m.group(0).rstrip('.,;)')
    # 2) einige Feeds liefern doi in Links; lassen wir hier minimal
    return None

def http_get(url, timeout=10):
    return requests.get(url, timeout=timeout, headers={"User-Agent": USER_AGENT})


API_TTL_DAYS = 7

def cache_get(key):
    con = db()
    row = con.execute("SELECT payload, cached_at FROM api_cache WHERE key=?", (key,)).fetchone()
    con.close()
    if not row:
        return None
    try:
        ts = dparser.parse(row["cached_at"])
        if (dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - ts).days > API_TTL_DAYS:
            return None
    except Exception:
        return None
    return json.loads(row["payload"])

def cache_put(key, payload: dict):
    con = db()
    con.execute("INSERT OR REPLACE INTO api_cache(key,payload,cached_at) VALUES(?,?,datetime('now'))",
                (key, json.dumps(payload),))
    con.commit()
    con.close()

def fetch_crossref(doi: str):
    if not doi: return None
    key = f"cr:{doi}"
    hit = cache_get(key)
    if hit: return hit
    r = http_get(f"https://api.crossref.org/works/{doi}", timeout=10)
    r.raise_for_status()
    data = r.json()
    cache_put(key, data)
    return data


def ris_from_crossref(cr: dict):
    # robustes Minimal-RIS
    try:
        it = cr["message"]
    except Exception:
        return None
    lines = []
    lines.append("TY  - JOUR")
    if it.get("title"): lines.append(f"TI  - {it['title'][0]}")
    for au in it.get("author", []):
        name = ", ".join(filter(None, [au.get("family"), au.get("given")]))
        lines.append(f"AU  - {name}")
    if it.get("container-title"): lines.append(f"JO  - {it['container-title'][0]}")
    if it.get("volume"): lines.append(f"VL  - {it['volume']}")
    if it.get("issue"):  lines.append(f"IS  - {it['issue']}")
    if it.get("page"):
        try:
            sp, ep = it["page"].split("-")[0], it["page"].split("-")[-1]
            lines.append(f"SP  - {sp}")
            lines.append(f"EP  - {ep}")
        except Exception:
            lines.append(f"SP  - {it['page']}")
    # Jahr
    y = (it.get("issued") or {}).get("date-parts", [[None]])[0][0]
    if y: lines.append(f"PY  - {y}")
    if it.get("DOI"): lines.append(f"DO  - {it['DOI']}")
    if it.get("URL"): lines.append(f"UR  - {it['URL']}")
    lines.append("ER  - ")
    return "\r\n".join(lines)

# ----------------------------- DB (read/star state) --------------------------

def db():
    # timeout = Busy-Timeout: warte statt sofort "database is locked" zu werfen
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    return con

def init_db():
    con = db()
    # WAL: Leser blockieren Schreiber nicht (und umgekehrt) – robuster bei
    # parallelen Feed-Fetches.
    try:
        con.execute("PRAGMA journal_mode=WAL")
    except Exception:
        pass
    con.executescript("""
    CREATE TABLE IF NOT EXISTS items(
        id TEXT PRIMARY KEY,
        feed TEXT,
        link TEXT,
        title TEXT,
        first_seen TEXT
    );
    CREATE TABLE IF NOT EXISTS read_items(
        id TEXT PRIMARY KEY,
        read_at TEXT
    );
    CREATE TABLE IF NOT EXISTS starred(
        id TEXT PRIMARY KEY,
        starred_at TEXT,
        snapshot TEXT    -- JSON mit Titel/Link/Feed/Date/Summary/DOI
    );
    CREATE TABLE IF NOT EXISTS api_cache(
    key TEXT PRIMARY KEY,
    payload TEXT,
    cached_at TEXT
    );                  
    """)
    # Nachrüsten falls ältere DB ohne 'snapshot'
    try:
        con.execute("ALTER TABLE starred ADD COLUMN snapshot TEXT")
    except Exception:
        pass
    con.commit()
    con.close()


def make_item_id(feed_name, link, title):
    base = f"{feed_name}|{link or ''}|{title or ''}"
    return hashlib.sha1(base.encode("utf-8","ignore")).hexdigest()

def mark_read(iid):
    con = db()
    con.execute("INSERT OR REPLACE INTO read_items(id, read_at) VALUES(?, datetime('now'))", (iid,))
    con.commit()
    con.close()

def get_read_ids():
    con = db()
    rows = con.execute("SELECT id FROM read_items").fetchall()
    con.close()
    return {r["id"] for r in rows}

def get_starred_ids():
    con = db()
    rows = con.execute("SELECT id FROM starred").fetchall()
    con.close()
    return {r["id"] for r in rows}


# ----------------------------- Feed Fetching (parallel + cache) --------------

# Modul-weiter Feed-Cache: hält die (netzwerk-teuren) geparsten Feeds für
# CACHE_MINUTES vor. Read-/Starred-Status wird NICHT mitgecacht, sondern pro
# Request frisch angewandt – so verschwinden gelikte/ausgeblendete Artikel
# auch nach einem Reload sofort.
_FEED_CACHE = {"bucket": None, "items": None}

def clear_feed_cache():
    _FEED_CACHE["bucket"] = None
    _FEED_CACHE["items"] = None

def cached_feed_errors():
    """Feed-Fehler aus dem letzten Fetch (ohne erneutes Laden); leer wenn kein Cache."""
    items = _FEED_CACHE.get("items") or []
    return [{"name": f["name"], "error": f["error"]} for f in items if f.get("error")]

def fetch_one_feed(feed_cfg, include_res, exclude_res, max_items):
    name = feed_cfg["name"]
    url  = feed_cfg["url"]
    try:
        r = http_get(url, timeout=10)
        r.raise_for_status()
        d = feedparser.parse(r.content)
        entries = []
        seen_rows = []   # (iid, name, link, title) – wird am Ende in einem Rutsch geschrieben
        for e in d.entries[:max_items]:
            title = e.get("title","").strip()
            link  = e.get("link","")
            raw_summary = e.get("summary", "") or e.get("description", "") or ""
            summary_raw = clean_html(raw_summary)
            authors_display, authors_full = extract_authors_from_feedentry(e)
            if summary_raw.strip() in {".", ""}:
                summary_raw = ""
            if not match_filters(title, summary_raw, include_res, exclude_res):
                continue

            iid = make_item_id(name, link, title)
            seen_rows.append((iid, name, link, title))

            # DOI & kleine Stats
            doi = find_doi(title, summary_raw)
            stats = extract_stats(summary_raw)

            # Falls kein DOI, Crossref versuchen
            if not doi and title:
                doi = find_doi_via_crossref(title)

            # Highlight terms
            highlight_regexes = include_res or []
            h_title, t_hit = highlight_terms(title, highlight_regexes)
            h_summary, s_hit = highlight_terms(summary_raw, highlight_regexes)

            entries.append({
                "id": iid,
                "title": title,
                "title_html": h_title if (t_hit) else title,
                "link": link,
                "authors": authors_display,
                "authors_full": authors_full,
                "date": parse_date(e),
                "date_rel": rel_datetime(parse_date(e)) if parse_date(e) else "",
                "summary": summary_raw[:800] + ("…" if len(summary_raw)>800 else ""),
                "summary_html": h_summary if (s_hit) else summary_raw[:800] + ("…" if len(summary_raw)>800 else ""),
                "journal": name,
                "doi": doi,
                "stats": stats
            })

        # DB erst NACH der Netzwerk-Arbeit anfassen: kurze Schreib-Transaktion,
        # damit die SQLite-Sperre nicht über die langsamen HTTP-Calls gehalten wird.
        if seen_rows:
            con = db()
            try:
                con.executemany(
                    "INSERT OR IGNORE INTO items(id, feed, link, title, first_seen) "
                    "VALUES(?,?,?,?,datetime('now'))",
                    seen_rows
                )
                con.commit()
            finally:
                con.close()
        return {"name": name, "entries": entries, "error": None, "count": len(entries)}
    except Exception as ex:
        return {"name": name, "entries": [], "error": str(ex), "count": 0}

def fetch_all_feeds(cfg):
    bucket = int(time.time() // (CACHE_MINUTES * 60))
    if _FEED_CACHE["items"] is not None and _FEED_CACHE["bucket"] == bucket:
        return _FEED_CACHE["items"]

    filters = cfg.get("filters") or {}
    include_patterns = filters.get("include") or []           # << robust
    exclude_patterns = filters.get("exclude") or []           # << robust
    allowlist = set(filters.get("journal_allowlist") or [])   # << robust

    include_res = [re.compile(p) for p in include_patterns]
    exclude_res = [re.compile(p) for p in exclude_patterns]

    max_items = (cfg.get("display") or {}).get("max_items_per_feed", 15)

    feeds_cfg = cfg.get("feeds") or []
    feeds = [f for f in feeds_cfg if not allowlist or f["name"] in allowlist]
    items = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = [ex.submit(fetch_one_feed, f, include_res, exclude_res, max_items) for f in feeds]
        for fu in as_completed(futs):
            items.append(fu.result())
    # sortiere Feeds nach Name
    items.sort(key=lambda x: x["name"].lower())

    _FEED_CACHE["bucket"] = bucket
    _FEED_CACHE["items"] = items
    return items



def get_starred_entries():
    con = db()
    rows = con.execute("SELECT id, starred_at, snapshot FROM starred ORDER BY starred_at DESC").fetchall()
    con.close()
    entries = []
    for r in rows:
        try:
            snap = json.loads(r["snapshot"]) if r["snapshot"] else {}
        except Exception:
            snap = {}
        entries.append({
            "id": snap.get("id") or r["id"],
            "title": snap.get("title") or "(ohne Titel)",
            "title_html": snap.get("title") or "(ohne Titel)",
            "link": snap.get("link") or "",
            "date": snap.get("date") or "",
            "date_rel": rel_datetime(snap.get("date")) if snap.get("date") else "",
            "summary": snap.get("summary") or "",
            "summary_html": snap.get("summary") or "",
            "journal": snap.get("feed") or "",
            "doi": snap.get("doi"),
            "crossref_url": (f"https://api.crossref.org/works/{snap.get('doi')}" if snap.get("doi") else None),
            "starred": True,
            "authors": snap.get("authors") or "",
            "authors_full": snap.get("authors_full") or snap.get("authors") or "",
            "stats": extract_stats(snap.get("summary") or "")
        })
    return entries

def save_cfg(cfg: dict):
    tmp = APP_ROOT / "config.yaml.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f, sort_keys=False, allow_unicode=True)
    os.replace(tmp, APP_ROOT / "config.yaml")

def probe_feed(url: str):
    try:
        r = http_get(url, timeout=10)
        r.raise_for_status()
        d = feedparser.parse(r.content)
        cnt = len(getattr(d, "entries", []))
        title = ""
        try:
            title = d.feed.get("title", "")
        except Exception:
            pass
        return True, cnt, title
    except Exception as ex:
        return False, 0, str(ex)
    

def find_doi_via_crossref(title):
    if not title.strip():
        return None
    key = f"title:{hashlib.sha1(title.encode()).hexdigest()}"
    hit = cache_get(key)
    if hit:
        return hit.get("doi")

    try:
        cr = requests.get(
            "https://api.crossref.org/works",
            params={"query.title": title, "rows": 1},
            headers={"User-Agent": USER_AGENT},
            timeout=3
        )
        if cr.ok:
            data = cr.json()
            items = data.get("message", {}).get("items", [])
            if items:
                doi = items[0].get("DOI")
                cache_put(key, {"doi": doi})
                return doi
    except Exception:
        pass

def extract_authors_from_feedentry(e):
    """Return (authors_display, authors_full) from a feedparser entry."""
    names = []

    # 1) feedparser's structured authors
    for a in e.get("authors", []) or []:
        nm = a.get("name") or a.get("fullname") or ""
        if nm: names.append(nm.strip())

    # 2) common string fallback
    if not names:
        for key in ("author", "dc_creator", "creator"):
            val = e.get(key)
            if val:
                parts = [p.strip() for p in re.split(r";|,|\sand\s", val) if p.strip()]
                names = parts if len(parts) > 1 else [val.strip()]
                break

    # --- 🔽 Affiliations & Sonderzeichen entfernen ---
    clean = []
    for n in names:
        # Entfernt Klammerteile (z. B. "(University of X)")
        n = re.sub(r"\s*\([^)]*\)", "", n)
        # Entfernt nachgestellte Komma-Institutionen
        n = re.sub(r",\s*(Department|Faculty|Institute|University|College|School|Center|Centre|Hospital|Research|Lab).*", "", n, flags=re.I)
        # Kürzt Leerzeichen
        n = re.sub(r"\s+", " ", n).strip()
        if n:
            clean.append(n)
    names = clean

    # De-duplizieren
    seen = set(); dedup = []
    for n in names:
        if n.lower() not in seen:
            seen.add(n.lower()); dedup.append(n)
    names = dedup

    if not names:
        return "", ""

    # Display: bis 3 Namen, sonst et al.
    max_show = 3
    if len(names) > max_show:
        display = ", ".join(names[:max_show]) + " et al."
    else:
        display = ", ".join(names)
    return display, ", ".join(names)
# ----------------------------- Routes ----------------------------------------

@app.route("/")
def index():
    cfg = load_cfg()
    mode = request.args.get("mode", "feeds")  # "feeds", "stars", "sources"

    if mode == "stars":
        entries = get_starred_entries()
        list_title = "⭐ Leseliste"
    elif mode == "sources":
        feeds = cfg.get("feeds") or []
        allow = set((cfg.get("filters") or {}).get("journal_allowlist") or [])
        include = (cfg.get("filters") or {}).get("include") or []
        exclude = (cfg.get("filters") or {}).get("exclude") or []
        # Katalog für Schnellauswahl; bereits abonnierte URLs ausgrauen
        existing_urls = {f.get("url") for f in feeds}
        catalog = [c for c in load_catalog() if c["url"] not in existing_urls]
        catalog_groups = {}
        for c in catalog:
            catalog_groups.setdefault(c.get("category") or "Sonstige", []).append(c)
        resp = make_response(render_template(
            "sources.html",
            now=dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
            feeds=feeds,
            allow=allow,
            include=include,
            exclude=exclude,
            catalog_groups=catalog_groups,
            feed_errors=cached_feed_errors(),
            flash_msg=request.args.get("msg",""),
            mode=mode
        ))
        resp.set_cookie("last_seen", dt.datetime.now(dt.timezone.utc).isoformat(), max_age=60*60*24*90)
        return resp
    else:
        # feeds → flach + dedup + shuffle + Gelesene/Sterne raus
        all_feeds = fetch_all_feeds(cfg)
        read_ids = get_read_ids()
        starred_ids = get_starred_ids()
        feed_errors = [{"name": f["name"], "error": f["error"]} for f in all_feeds if f.get("error")]
        flat = []
        seen_keys = set()
        for f in all_feeds:
            for it in f.get("entries", []):
                if it["id"] in read_ids or it["id"] in starred_ids:
                    continue   # bereits gelesen oder auf Leseliste → raus
                # Dedup über Feeds hinweg (gleiches Paper in mehreren Feeds)
                key = ("doi:" + it["doi"].lower()) if it.get("doi") else ("ti:" + norm_title(it.get("title")))
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                it["starred"] = False
                flat.append(it)
        random.shuffle(flat)
        entries = flat
        list_title = ""

    last_seen = request.cookies.get("last_seen")
    resp = make_response(render_template(
        "index.html",
        now=dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        entries=entries,
        list_title=list_title,
        mode=mode,
        no_new=(len(entries) == 0),
        feed_errors=(feed_errors if mode == "feeds" else []),
        last_seen=last_seen
    ))
    resp.set_cookie("last_seen", dt.datetime.now(dt.timezone.utc).isoformat(), max_age=60*60*24*90)
    return resp





@app.post("/mark_read")
def route_mark_read():
    iid = request.form.get("id","")
    if not iid:
        abort(400)
    mark_read(iid)
    return jsonify({"ok": True})

@app.post("/unread")
def route_unread():
    """Macht 'Gelesen'/Skip rückgängig (für den Undo-Toast)."""
    iid = request.form.get("id","")
    if not iid:
        abort(400)
    con = db()
    con.execute("DELETE FROM read_items WHERE id=?", (iid,))
    con.commit()
    con.close()
    return jsonify({"ok": True})

@app.post("/star")
def route_star():
    iid = request.form.get("id", "")
    action = request.form.get("action", "toggle")
    if not iid:
        abort(400)

    # Snapshot nur speichern, wenn sinnvolle Daten vorhanden
    title = (request.form.get("title") or "").strip()
    link  = (request.form.get("link")  or "").strip()
    if not title and not link:
        # leere/kaputte Einträge nicht zulassen
        return jsonify({"ok": False, "error": "invalid item"})

    snap = {
        "id": iid,
        "title": title,
        "link": link,
        "feed": request.form.get("feed") or "",
        "date": request.form.get("date") or "",
        "summary": request.form.get("summary") or "",
        "doi": request.form.get("doi") or None,
        "authors": request.form.get("authors") or "",
        "authors_full": request.form.get("authors_full") or request.form.get("authors") or ""
    }
    snap_json = json.dumps(snap, ensure_ascii=False)

    con = db()
    try:
        cur = con.execute("SELECT 1 FROM starred WHERE id=?", (iid,)).fetchone()
        if action == "off" or (action == "toggle" and cur):
            con.execute("DELETE FROM starred WHERE id=?", (iid,))
            starred = False
        else:
            con.execute(
                "INSERT OR REPLACE INTO starred(id, starred_at, snapshot) VALUES(?, datetime('now'), ?)",
                (iid, snap_json)
            )
            starred = True
        con.commit()
    finally:
        con.close()

    return jsonify({"ok": True, "starred": starred})


@app.get("/stars")
def route_stars():
    con = db()
    rows = con.execute("""
      SELECT s.id, i.title, i.link, i.feed, s.starred_at
      FROM starred s LEFT JOIN items i ON i.id=s.id
      ORDER BY s.starred_at DESC
    """).fetchall()
    con.close()
    return jsonify([dict(r) for r in rows])

@app.post("/settings/test_feed")
def settings_test_feed():
    url = (request.form.get("url") or "").strip()
    ok, count, title_or_err = probe_feed(url)
    return jsonify({"ok": ok, "count": count, "title": title_or_err if ok else "", "error": None if ok else title_or_err})

@app.post("/settings/add_feed")
def settings_add_feed():
    cfg = load_cfg()
    name = (request.form.get("name") or "").strip()
    url  = (request.form.get("url") or "").strip()
    if not name or not url:
        return redirect(url_for("index", mode="sources", msg="Name und URL erforderlich"))
    # Validierung
    ok, count, _ = probe_feed(url)
    if not ok:
        return redirect(url_for("index", mode="sources", msg="Feed-URL nicht abrufbar"))
    # Duplikate verhindern
    feeds = cfg.get("feeds") or []
    if any(f.get("name") == name for f in feeds):
        return redirect(url_for("index", mode="sources", msg="Name bereits vorhanden"))
    feeds.append({"name": name, "url": url})
    cfg["feeds"] = feeds
    save_cfg(cfg)
    clear_feed_cache()
    return redirect(url_for("index", mode="sources", msg=f"Feed '{name}' hinzugefügt ({count} Einträge)"))

@app.post("/settings/remove_feed")
def settings_remove_feed():
    cfg = load_cfg()
    name = (request.form.get("name") or "").strip()
    feeds = cfg.get("feeds") or []
    new_feeds = [f for f in feeds if f.get("name") != name]
    if len(new_feeds) == len(feeds):
        return redirect(url_for("index", mode="sources", msg="Feed nicht gefunden"))
    cfg["feeds"] = new_feeds
    save_cfg(cfg)
    clear_feed_cache()
    return redirect(url_for("index", mode="sources", msg=f"Feed '{name}' entfernt"))

@app.post("/settings/update_allowlist")
def settings_update_allowlist():
    cfg = load_cfg()
    selected = request.form.getlist("allow")  # Liste der Namen
    filters = cfg.get("filters") or {}
    filters["journal_allowlist"] = selected  # leere Liste => alle
    cfg["filters"] = filters
    save_cfg(cfg)
    clear_feed_cache()
    return redirect(url_for("index", mode="sources", msg="Allowlist aktualisiert"))

@app.post("/settings/update_filters")
def settings_update_filters():
    cfg = load_cfg()

    def parse_patterns(raw):
        return [ln.strip() for ln in (raw or "").splitlines() if ln.strip()]

    include = parse_patterns(request.form.get("include"))
    exclude = parse_patterns(request.form.get("exclude"))

    # Regex validieren, damit ein Tippfehler die App nicht crasht
    for p in include + exclude:
        try:
            re.compile(p)
        except re.error as ex:
            return redirect(url_for("index", mode="sources",
                                    msg=f"Ungültiges Regex-Muster '{p}': {ex}"))

    filters = cfg.get("filters") or {}
    filters["include"] = include
    filters["exclude"] = exclude
    cfg["filters"] = filters
    save_cfg(cfg)
    clear_feed_cache()
    return redirect(url_for("index", mode="sources", msg="Filter gespeichert"))

@app.post("/settings/add_from_catalog")
def settings_add_from_catalog():
    cfg = load_cfg()
    selected = request.form.getlist("catalog")   # Liste von URLs
    feeds = cfg.get("feeds") or []
    existing_urls = {f.get("url") for f in feeds}
    existing_names = {f.get("name") for f in feeds}
    by_url = {c["url"]: c for c in load_catalog()}
    added = 0
    for u in selected:
        c = by_url.get(u)
        if not c or c["url"] in existing_urls or c["name"] in existing_names:
            continue
        feeds.append({"name": c["name"], "url": c["url"]})
        existing_urls.add(c["url"]); existing_names.add(c["name"])
        added += 1
    if added:
        cfg["feeds"] = feeds
        save_cfg(cfg)
        clear_feed_cache()
    return redirect(url_for("index", mode="sources", msg=f"{added} Feed(s) aus Katalog hinzugefügt"))

@app.get("/export/feeds.opml")
def export_feeds_opml():
    feeds = (load_cfg().get("feeds") or [])
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<opml version="2.0">',
             '  <head><title>readr feeds</title></head>',
             '  <body>']
    for f in feeds:
        name = xml_escape(f.get("name") or "", {'"': "&quot;"})
        url  = xml_escape(f.get("url") or "", {'"': "&quot;"})
        lines.append(f'    <outline text="{name}" title="{name}" type="rss" xmlUrl="{url}"/>')
    lines += ['  </body>', '</opml>']
    data = "\n".join(lines)
    return Response(data, mimetype="text/x-opml",
                    headers={"Content-Disposition": "attachment; filename=readr-feeds.opml"})

@app.post("/settings/import_opml")
def settings_import_opml():
    file = request.files.get("opml")
    if not file or not file.filename:
        return redirect(url_for("index", mode="sources", msg="Keine OPML-Datei gewählt"))
    try:
        root = ET.fromstring(file.read())
    except ET.ParseError as ex:
        return redirect(url_for("index", mode="sources", msg=f"OPML nicht lesbar: {ex}"))

    cfg = load_cfg()
    feeds = cfg.get("feeds") or []
    existing_urls = {f.get("url") for f in feeds}
    existing_names = {f.get("name") for f in feeds}
    added = 0
    for outline in root.iter("outline"):
        url = (outline.get("xmlUrl") or "").strip()
        name = (outline.get("text") or outline.get("title") or url).strip()
        if not url or url in existing_urls or name in existing_names:
            continue
        feeds.append({"name": name, "url": url})
        existing_urls.add(url); existing_names.add(name)
        added += 1
    if added:
        cfg["feeds"] = feeds
        save_cfg(cfg)
        clear_feed_cache()
    return redirect(url_for("index", mode="sources", msg=f"{added} Feed(s) aus OPML importiert"))

@app.get("/dl/ris")
def dl_ris():
    doi = (request.args.get("doi") or "").strip()
    title = (request.args.get("title") or "").strip()
    if not doi and not title:
        abort(400)
    ris = None
    if doi:
        try:
            cr = fetch_crossref(doi)
            ris = ris_from_crossref(cr)
        except Exception:
            ris = None
    if not ris:
        # Fallback-Minimal-RIS nur mit Titel/DOI
        lines = ["TY  - JOUR"]
        if title: lines.append(f"TI  - {title}")
        if doi:   lines.append(f"DO  - {doi}")
        lines.append("ER  - ")
        ris = "\r\n".join(lines)
    fn = f"cite_{(doi or title)[:40].replace('/','_')}.ris"
    return Response(ris, mimetype="application/x-research-info-systems",
                    headers={"Content-Disposition": f"attachment; filename={fn}"})

@app.get("/export/starred.ris")
def export_starred_ris():
    entries = get_starred_entries()
    chunks = []
    for e in entries:
        doi = e.get("doi")
        title = e.get("title")
        ris = None
        if doi:
            try:
                cr = fetch_crossref(doi)
                ris = ris_from_crossref(cr)
            except Exception:
                pass
        if not ris:
            lines = ["TY  - JOUR"]
            if title: lines.append(f"TI  - {title}")
            if doi:   lines.append(f"DO  - {doi}")
            lines.append("ER  - ")
            ris = "\r\n".join(lines)
        chunks.append(ris)
    data = "\r\n".join(chunks)
    return Response(data, mimetype="application/x-research-info-systems",
                    headers={"Content-Disposition": "attachment; filename=starred.ris"})


# ----------------------------- Scheduler (prefetch) --------------------------

def prefetch_job():
    try:
        cfg = load_cfg()
        clear_feed_cache()
        _ = fetch_all_feeds(cfg)
        app.logger.info("Prefetch OK")
    except Exception as ex:
        app.logger.error("Prefetch failed: %s\n%s", ex, traceback.format_exc())

def start_scheduler():
    # vermeide Doppelstart im Debug-Reloader
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not app.debug:
        from apscheduler.schedulers.background import BackgroundScheduler
        sched = BackgroundScheduler(daemon=True)
        sched.add_job(prefetch_job, "interval", minutes=CACHE_MINUTES)
        sched.start()
        app.logger.info("Scheduler started")

# ----------------------------- Main ------------------------------------------

if __name__ == "__main__":
    # Debug standardmäßig AUS (der Werkzeug-Debugger erlaubt sonst Code-
    # Ausführung). Zum Entwickeln: FLASK_DEBUG=1 setzen.
    app.debug = os.environ.get("FLASK_DEBUG") == "1"
    init_db()
    start_scheduler()
    app.run(debug=app.debug, port=5000)
