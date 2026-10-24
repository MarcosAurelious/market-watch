# Market Watch

A retro, 8-bit style market dashboard: stocks, crypto, commodities, sectors, penny stocks, Congress trading and disclosed political trades.
**Demo for discussion only. Not financial advice.**

## How it works

```
GitHub Actions (back end, runs on GitHub's servers)
  └─ scripts/update_data.py  ── uses your Alpha Vantage key (encrypted secret) ──► writes data/market.json
GitHub Pages (front end, public website)
  └─ index.html + app.js + styles.css  ── reads data/market.json + CoinGecko live crypto (no key)
market-watch-demo.html  (one file to share)  ── same app; loads the live feed on open, falls back to a built-in snapshot
```

Your API key never reaches the website or the shared file.

## Set it up (about 10 minutes, all in the GitHub website)

1. **Create the repo.** On github.com: **New repository** → name it **`market-watch`** → Public → Create.
   (Use exactly this name so the shared file finds its feed. If you choose another name, see step 6.)
2. **Upload the files.** In the new repo: **Add file → Upload files**, then drag in everything from this folder
   (including the hidden `.github` folder and `.nojekyll`; on a Mac press Cmd+Shift+. in Finder to show them).
   Commit.
   *If the `.github/workflows` folder doesn't upload:* **Add file → Create new file**, type the name
   `.github/workflows/update-data.yml`, and paste in the contents of that file.
3. **Add your key as an encrypted secret.** **Settings → Secrets and variables → Actions → New repository secret**.
   Name: `ALPHAVANTAGE_API_KEY`. Value: your Alpha Vantage key. Save.
   Tip: get a **separate free key** for this app at alphavantage.co so it doesn't share the 25-a-day limit with anything else.
4. **Let the job save data.** **Settings → Actions → General → Workflow permissions → Read and write permissions** → Save.
5. **Turn on the website.** **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main / (root)** → Save.
   After a minute your app is at `https://marcosaurelious.github.io/market-watch/`.
6. **Run the first update.** **Actions → Update market data → Run workflow.** After that it runs by itself every weekday
   after the close, and refreshes crypto every 4 hours.
   *Different repo name?* Run `python3 scripts/build_standalone.py https://<you>.github.io/<repo>/data/market.json`
   to rebuild the shareable file.

## Sharing with investors

- Send the **website link**, or the single file **`market-watch-demo.html`** (email/AirDrop/Drive).
- Opening either one pulls the newest data from your feed and live crypto prices every time.
- If someone opens the file offline, it shows the built-in snapshot and says "OFFLINE SNAPSHOT".

## What updates automatically

| Section | Source | When |
|---|---|---|
| Crypto | CoinGecko (no key) | Every time the page opens |
| Stocks, commodities, $100 portfolio | Alpha Vantage via the back end | Weekdays after the close (25 free calls/day, so each stock refreshes at least every other day) |
| Sectors, Top 10s, Penny, Geopolitics, Congress, Trump & co. | Researched snapshots in `data/market.json` | When you replace `data/market.json` with a newer one |

## Files

- `index.html`, `app.js`, `styles.css`, `fonts/` — the front end (no third-party code; fonts are bundled, SIL OFL).
- `data/market.json` — the data feed.
- `scripts/update_data.py` — the back end updater (Python standard library only).
- `scripts/build_standalone.py` — rebuilds `market-watch-demo.html`.
- `.github/workflows/update-data.yml` — the schedule.
- `SECURITY.md` — the security design.
