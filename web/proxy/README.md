# Feed proxy (Cloudflare Worker)

Browsers may not read RSS feeds from other websites directly (CORS). This
small worker fetches a feed and passes it on to Pub.Crawl with the right
header. It stores nothing apart from a 10-minute edge cache. The free
Cloudflare plan (100,000 requests/day) is plenty.

## Setup (once, about 5 minutes)

**Option A – in the browser, nothing to install**

1. Create a free account at <https://dash.cloudflare.com>.
2. *Workers & Pages* → *Create* → *Create Worker* → name it `pubcrawl-proxy` → *Deploy*.
3. *Edit code* → paste the contents of [`worker.js`](worker.js) → *Deploy*.
4. Optional: *Settings → Variables* → `ALLOWED_ORIGINS` = `https://<your-github-name>.github.io`
   (otherwise any website may use the proxy).

**Option B – command line** (needs Node.js)

```bash
cd web/proxy
npx wrangler deploy
```

## Tell Pub.Crawl about it

The worker address looks like `https://pubcrawl-proxy.<account>.workers.dev`.

- **For everyone using your deployment:** set it in [`web/js/config.js`](../js/config.js) and commit:
  ```js
  export const WORKER_PROXY = 'https://pubcrawl-proxy.<account>.workers.dev/?url=';
  ```
- **Just for yourself:** in the app under *Settings → Feed proxy*.

Keep the `/?url=` at the end – Pub.Crawl appends the feed URL to it.
