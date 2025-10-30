# 📰 readr — A Minimal Local Research Feed Reader

**readr** is a lightweight, privacy-friendly Flask web app that aggregates journal RSS feeds for academic researchers.
It lets you **skim, star, and organize** new papers (like a minimalist Tinder for research articles),
with Open Access and citation tools built right in.

---

## 🚀 Features

* 🧠 Collects and displays entries from multiple RSS/Atom feeds (e.g., journals, preprint servers)
* 🌗 Auto dark/light mode via Pico.css
* 🔍 Local full-text search in title & abstract
* 💡 “Like” (add to reading list) / “Skip” (hide) buttons with Tinder-style animations
* ⭐ Persistent reading list with RIS export
* 🧾 DOI & CrossRef integration for citation metadata
* 🔓 Unpaywall lookup for Open Access versions
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
start.bat
```

**macOS / Linux:**

```bash
bash start.sh
```

These automatically create the virtual environment (if needed), install dependencies, and start the Flask app.

Then open your browser at
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

api:
  unpaywall_email: "you@example.com"
```

---

## ⚙ Options

* **Mode toggle:** switch between *Feed*, *Reading List*, and *Settings*
* **Dark/light mode:** toggle via 🌙 button (stored in localStorage)
* **Keyboard shortcuts:**

  * `l` → Like / add to list
  * `d` → Dislike / hide
  * `j` / `k` → Move down/up
  * `/` → Focus search bar

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
├── config.yaml          # feeds and filters
├── dashboard.db         # auto-created local database
├── start.bat            # quick start for Windows
├── start.sh             # quick start for macOS/Linux
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

## 🧑‍💻 License & Credits

MIT License © 2025 [Paul Heineck](https://github.com/paulheineck)

Built with ❤️ for researchers who want to stay up to date — without the noise.
