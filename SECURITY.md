# Security design

## Secrets
- The only secret is the Alpha Vantage API key. It is stored as a **GitHub Actions encrypted secret**
  (encrypted at rest with libsodium sealed boxes; GitHub masks it in logs).
- It is used only by `scripts/update_data.py` on GitHub's servers, read from an environment variable.
  It is never written to disk, never placed in `data/market.json` (the script refuses to save if it finds the key in the output),
  and is scrubbed from any log line.
- The website and the shared file contain **no keys of any kind**. Crypto prices come from CoinGecko's public, keyless endpoint.
- To rotate: create a new key at alphavantage.co, update the secret, and delete the old key.

## Encryption in transit
- Every connection is HTTPS (TLS): GitHub Pages, the Alpha Vantage API and CoinGecko.
  The updater refuses non-HTTPS URLs; the page sets `upgrade-insecure-requests`.

## Protection against malicious code and data (XSS / injection)
- **Content-Security-Policy** on every page: no third-party scripts, styles or fonts; no inline code except the exact
  hashed blocks in the shared file; network access limited to the data feed and CoinGecko; no forms, frames, plugins or `<base>` changes;
  **Trusted Types** required, which blocks HTML-string injection sinks.
- The app never inserts data as HTML. All text goes through `textContent`, so a malicious value in the feed is shown as text, not run.
- Every field from the network is validated against a whitelist schema (type, numeric range, max length); links must be `https://`
  and open with `rel="noopener noreferrer"`. Responses over 2 MB are rejected, requests time out after 10 s, credentials are never sent.
- `no-referrer` policy: viewers' browsing isn't leaked to linked sites.

## Supply chain
- **Zero third-party JavaScript or Python packages.** The updater uses only the Python standard library.
- The one GitHub Action used (`actions/checkout`) is **pinned to a full commit SHA**, so a hijacked tag can't change it.
- The workflow has **least-privilege permissions** (`contents: write` only), a 15-minute timeout, and no access to pull requests from forks.

## Integrity
- The updater validates the whole file before saving and writes it atomically, so a failed or rate-limited run can never publish a
  broken or partial file; the previous good data stays live.

## Limits to be aware of
- GitHub Pages sites and their data are **public**. Everything in `data/market.json` is public market data and published disclosures,
  so nothing sensitive should ever be added there.
- GitHub Pages can't set HTTP security headers; the policy is applied with a `<meta>` CSP, which covers scripts, styles and connections
  but not clickjacking (`frame-ancestors`). If you need that, put the site behind Cloudflare (free) and add the header there.
- This is a demo, not a trading system: no user accounts, no payments, no personal data are collected.
