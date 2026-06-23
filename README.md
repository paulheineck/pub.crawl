# 📰 readr — A Minimal Local Research Feed Reader

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)
<!-- Nach dem Zenodo-Release hier den DOI-Badge einsetzen:
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.XXXXXXX.svg)](https://doi.org/10.5281/zenodo.XXXXXXX) -->

**readr** is a lightweight, privacy-friendly Flask web app that aggregates journal RSS feeds for academic researchers.
It lets you **skim, star, and organize** new papers,
with Open Access and citation tools built right in.

---

## 📸 Screenshots

> _Lege deine Screenshots unter `docs/` ab (z. B. mit Windows: <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>) — dann erscheinen sie hier._

| Stapelmodus (Feed) | Leseliste |
|---|---|
| ![Stapelmodus](docs/feed.png) | ![Leseliste](docs/reading-list.png) |

---

## 🚀 Features

* 🧠 Collects and displays entries from multiple RSS/Atom feeds (e.g., journals, preprint servers)
* 🃏 Swipeable **card-stack mode** (default) for fast Tinder-style triage — or a classic list view
* 💡 “Like” (add to reading list) / “Skip” (hide) with one-tap **undo**
* 🔀 Sort by shuffle, newest-first, or **“For me”** — a local relevance ranking that learns from your likes/skips (unlocks automatically after enough triage, shows *why* each paper matched)
* 📈 Daily streak, “seen today” counter, progress + inbox-zero celebration
* 🌗 Auto dark/light mode via Pico.css
* 🔍 Local full-text search in title & abstract
* 📖 Clean, expandable abstracts & author lists — strips publisher cruft and normalizes metadata via CrossRef (with OpenAlex fallback) when a feed only ships a teaser
* 📄 Open-Access (Unpaywall) & 🎓 Scholar links per paper
* ⭐ Persistent reading list with notes/#tags and RIS export
* 🧾 DOI & CrossRef integration for citation metadata
* 📚 Built-in journal catalog for one-click feed selection
* 🔁 OPML import/export + JSON state sync between machines
* ⚠️ Feed-health warning for broken feeds
* ⚙ Simple YAML configuration (`config.yaml`) — no database setup required
* 🕓 Offline caching and read-state persistence (SQLite)

---

## 🧩 Installation

```bash
# Clone the repository
git clone git@github.com:paulheineck/readr.git
cd readr

# (Optional) Create and activate a virtual environment
python -m venv .venv
.venv\Scripts\activate   # Windows
# or
source .venv/bin/activate   # macOS/Linux

# Install dependencies
pip install -r requirements.txt
```

---

## 🧩 Run locally

For easiest startup, use the included launcher files:

**Windows:**

```bash
"start Windows.bat"
```

**macOS:**

```bash
bash "start Mac.sh"
```

**Linux:**

```bash
bash "start Linux.sh"
```

These automatically set up the virtual environment (if needed), install dependencies, wait until the server is ready, and open your browser — readr then shows a loading screen while it fetches the latest papers on first start. Keep the launcher window open; closing it stops readr.

You can also start it manually and open
👉 [http://localhost:5000](http://localhost:5000)

Your personal database (`dashboard.db`) and config (`config.yaml`) will be created automatically on first run.

---

## 🧩 Configuration

Edit `config.yaml` to manage feeds and filters.

Example:

```yaml
feeds:
  - name: Personality and Social Psychology Bulletin
    url: https://journals.sagepub.com/rss/current/pspb.xml
  - name: Nature Human Behaviour
    url: https://www.nature.com/nathumbehav.rss

filters:
  include:
    - "(discrimination|inequality|prototypicality)"
  exclude:
    - "(animal|clinical|neuroscience)"

display:
  show_abstract: true
  max_items_per_feed: 15
```

---

## ⚙ Options

* **Mode toggle:** switch between *Feed*, *Reading List*, and *Settings*
* **View toggle:** card **stack** (default) ⇄ **list** — your choice is remembered per device
* **Sort toggle:** shuffle ⇄ newest-first — remembered per device
* **Dark/light mode:** toggle via 🌓 button (stored in localStorage)
* **Keyboard shortcuts:**

  * `l` → Like / add to list
  * `d` → Dislike / hide
  * `j` / `k` → Move down/up (list view)
  * `/` → Focus search bar
  * `?` → Show keyboard-shortcut help

---

## 💾 File structure

```
readr/
│
├── app.py               # Flask backend
├── templates/
│   ├── index.html       # main UI
│   └── sources.html     # settings view
├── static/              # optional local CSS/images
├── config.example.yaml  # template, copied to config.yaml on first run
├── config.yaml          # your personal feeds & filters (auto-created, gitignored)
├── journals.yaml        # curated journal catalog for quick-add
├── verify_feeds.py      # checks the catalog for dead feeds
├── dashboard.db         # auto-created local database
├── start Windows.bat    # quick start for Windows
├── start Mac.sh         # quick start for macOS
├── start Linux.sh       # quick start for Linux
├── requirements.txt
└── README.md
```

---

## 📦 Dependencies

Minimal and lightweight:

```
Flask
feedparser
PyYAML
beautifulsoup4
requests
python-dateutil
apscheduler
```

---

## 💡 Tips

* To disable the Tinder-style animations, toggle the setting in “⚙ Einstellungen”.
* If you ever delete `dashboard.db`, it will automatically regenerate empty on next start.
* You can safely share your project folder without the database — all local state is recreated.

---

## 📑 Citation

If readr is useful for your work, a citation is appreciated. GitHub shows a
**“Cite this repository”** button (powered by [`CITATION.cff`](CITATION.cff)).

After minting a DOI via Zenodo (see below), cite as:

```bibtex
@software{heineck_readr,
  author  = {Heineck, Paul},
  title   = {readr — A Minimal Local Research Feed Reader},
  year    = {2026},
  url     = {https://github.com/paulheineck/readr},
  version = {1.0.0},
  doi     = {10.5281/zenodo.XXXXXXX}
}
```

**Get a citable DOI (one-time, ~10 min):**

1. Sign in at [zenodo.org](https://zenodo.org) with your GitHub account.
2. Go to **Account → GitHub**, find `paulheineck/readr`, and flip the switch **On**.
3. On GitHub, create a release: **Releases → Draft a new release →** tag `v1.0.0`, title “readr 1.0.0”, publish.
   - locally: `git tag -a v1.0.0 -m "readr 1.0.0" && git push origin v1.0.0`
4. Zenodo automatically archives the release and mints a DOI.
5. Copy the DOI badge from Zenodo into the top of this README and into `CITATION.cff`.

---

## 🧑‍💻 License & Credits

MIT License © 2026 [Paul Heineck](https://github.com/paulheineck)

Built with ❤️ for researchers who want to stay up to date — without the noise.
