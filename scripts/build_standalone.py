#!/usr/bin/env python3
"""Build market-watch-demo.html: one self-contained file to email or AirDrop to investors.

It inlines the CSS, JS and pixel fonts, embeds the current data/market.json as an offline fallback, and points the app at
the live feed on GitHub Pages. A strict Content-Security-Policy with SHA-256 hashes allows only these exact inline
scripts/styles to run and only two network destinations (your feed and CoinGecko).

Usage:  python3 scripts/build_standalone.py https://<user>.github.io/<repo>/data/market.json
"""
import base64
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEED = sys.argv[1] if len(sys.argv) > 1 else "https://marcosaurelious.github.io/market-watch/data/market.json"
if not FEED.startswith("https://"):
    sys.exit("feed URL must be https")
FEED_ORIGIN = "/".join(FEED.split("/")[:3])


def read(p, mode="r"):
    with open(os.path.join(ROOT, p), mode, **({} if "b" in mode else {"encoding": "utf-8"})) as f:
        return f.read()


def sha(s):
    return "'sha256-" + base64.b64encode(hashlib.sha256(s.encode("utf-8")).digest()).decode() + "'"


css = read("styles.css")
for name in ("press-start-2p", "vt323"):
    b64 = base64.b64encode(read("fonts/%s.woff2" % name, "rb")).decode()
    css = css.replace('url("fonts/%s.woff2")' % name, 'url("data:font/woff2;base64,%s")' % b64)
js = read("app.js")
cfg = "window.MW_CONFIG=" + json.dumps({"dataUrl": FEED}) + ";"
snapshot = json.dumps(json.loads(read("data/market.json")), separators=(",", ":")).replace("</", "<\\/")

html = read("index.html")
csp = ("default-src 'none'; script-src %s %s; style-src %s; font-src data:; img-src data:; connect-src %s https://api.coingecko.com; "
       "base-uri 'none'; form-action 'none'; object-src 'none'; require-trusted-types-for 'script'"
       % (sha(cfg), sha(js), sha(css), FEED_ORIGIN))
start = html.index('<meta http-equiv="Content-Security-Policy"')
end = html.index(">", start) + 1
html = html[:start] + '<meta http-equiv="Content-Security-Policy" content="%s">' % csp + html[end:]
html = html.replace('<link rel="stylesheet" href="styles.css">', "<style>" + css + "</style>")
html = html.replace('<link rel="preload" href="fonts/press-start-2p.woff2" as="font" type="font/woff2" crossorigin>\n', "")
html = html.replace('<link rel="preload" href="fonts/vt323.woff2" as="font" type="font/woff2" crossorigin>\n', "")
html = html.replace("<!--MW-SNAPSHOT-->", '<script type="application/json" id="mw-snapshot">' + snapshot + "</script>")
html = html.replace("<!--MW-CONFIG-->", "<script>" + cfg + "</script>")
html = html.replace('<script src="app.js"></script>', "<script>" + js + "</script>")
out = os.path.join(ROOT, "market-watch-demo.html")
with open(out, "w", encoding="utf-8") as f:
    f.write(html)
print("wrote", out, len(html), "bytes; feed:", FEED)
