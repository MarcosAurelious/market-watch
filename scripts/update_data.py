#!/usr/bin/env python3
"""Market Watch back end: refresh data/market.json.

Runs inside GitHub Actions. Standard library only (no third-party packages = nothing to compromise in the supply chain).

Security:
  * The Alpha Vantage key is read ONLY from the ALPHAVANTAGE_API_KEY environment variable, which GitHub injects from an
    encrypted repository secret. It is never written to disk, logged, or put in the output file; error messages are scrubbed.
  * All network responses are size-limited, parsed as JSON, and every number is range-checked before it is saved.
  * The output is validated as a whole and written atomically, so a bad run can never publish a broken or partial file.

Free-plan budget: Alpha Vantage allows 25 calls/day. This script makes at most MAX_CALLS and stops at the first
rate-limit message, keeping whatever it already fetched. Stocks that were never priced go first, then commodities,
then the stalest prices.
"""
import json
import math
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT, "data", "market.json")
AV_URL = "https://www.alphavantage.co/query"
CG_URL = "https://api.coingecko.com/api/v3/coins/markets"
MAX_CALLS = int(os.environ.get("MW_MAX_CALLS", "24"))
SPACING_S = float(os.environ.get("MW_SPACING_S", "13"))  # free plan also caps calls per minute
MAX_BYTES = 5_000_000
API_KEY = os.environ.get("ALPHAVANTAGE_API_KEY", "").strip()


class RateLimited(Exception):
    pass


def log(msg):
    if API_KEY:
        msg = msg.replace(API_KEY, "***")
    print(msg, flush=True)


def http_json(url, params=None):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    if not url.startswith("https://"):
        raise ValueError("refusing non-https url")
    req = urllib.request.Request(url, headers={"User-Agent": "market-watch-updater/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as res:  # nosec: fixed https hosts only
        body = res.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise ValueError("response too large")
    return json.loads(body.decode("utf-8"))


def num(v, lo=-1e15, hi=1e15):
    try:
        n = float(str(v).replace("%", "").strip())
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) and lo <= n <= hi else None


calls = 0


def av(function, **params):
    """One Alpha Vantage call with budget, spacing and rate-limit detection."""
    global calls
    if not API_KEY:
        raise RateLimited("no API key configured")
    if calls >= MAX_CALLS:
        raise RateLimited("daily call budget used")
    if calls:
        time.sleep(SPACING_S)
    calls += 1
    data = http_json(AV_URL, dict(params, function=function, apikey=API_KEY))
    if not isinstance(data, dict):
        raise ValueError("unexpected response")
    for k in ("Note", "Information", "Error Message"):
        if k in data:
            text = str(data[k])
            if k == "Error Message":
                raise ValueError("Alpha Vantage error for %s" % params.get("symbol", function))
            raise RateLimited(text[:160])
    return data


def refresh_monthly(row):
    d = av("TIME_SERIES_MONTHLY_ADJUSTED", symbol=row["ticker"])
    series = d.get("Monthly Adjusted Time Series") or {}
    if not isinstance(series, dict) or not series:
        raise ValueError("no monthly series")
    dates = sorted(series.keys(), reverse=True)
    latest = series[dates[0]]
    close = num(latest.get("4. close"), 0, 1e7)
    if close is None:
        raise ValueError("bad close")

    def month_end(prefix):
        for dt in dates:
            if dt.startswith(prefix):
                return num(series[dt].get("5. adjusted close"), 0, 1e7)
        return None

    row.update(close=close, as_of=dates[0][:10], adj_sep30=month_end("2026-09"), adj_dec31=month_end("2025-12"),
               adj_oct31_25=month_end("2025-10"), source="Alpha Vantage")


def refresh_quote(row):
    d = av("GLOBAL_QUOTE", symbol=row["ticker"])
    q = d.get("Global Quote") or {}
    price, prev = num(q.get("05. price"), 0, 1e7), num(q.get("08. previous close"), 0, 1e7)
    day = str(q.get("07. latest trading day", ""))[:10]
    if price is None or len(day) != 10:
        raise ValueError("bad quote")
    row.update(close=price, prev_close=prev, as_of=day, source="Alpha Vantage")


def refresh_commodity(row):
    name = row["name"]
    if name in ("Gold", "Silver"):
        d = av("GOLD_SILVER_SPOT", symbol=name.upper())
        price = None
        for k, v in d.items():
            if "price" in str(k).lower():
                price = num(v, 0, 1e6)
        if price is None:
            raise ValueError("bad spot")
        row.update(prev_price=row.get("price"), price=price, as_of=datetime.now(timezone.utc).strftime("%Y-%m-%d"), source="Alpha Vantage")
        return
    fn = {"WTI crude": "WTI", "Brent crude": "BRENT", "Natural gas": "NATURAL_GAS"}.get(name)
    if not fn:
        return
    d = av(fn, interval="daily")
    pts = [p for p in d.get("data", []) if isinstance(p, dict) and num(p.get("value"), 0, 1e6) is not None]
    if len(pts) < 2:
        raise ValueError("not enough points")
    row.update(price=num(pts[0]["value"]), prev_price=num(pts[1]["value"]), as_of=str(pts[0].get("date", ""))[:10], source="Alpha Vantage")


def refresh_crypto(crypto):
    ids = ",".join(r["cg_id"] for r in crypto["rows"] if r.get("cg_id"))
    raw = http_json(CG_URL, {"vs_currency": "usd", "ids": ids, "price_change_percentage": "24h,7d"})
    if not isinstance(raw, list):
        raise ValueError("crypto feed not a list")
    by_id = {str(c.get("id")): c for c in raw if isinstance(c, dict)}
    n = 0
    for r in crypto["rows"]:
        c = by_id.get(r.get("cg_id"))
        p = num(c.get("current_price"), 0, 1e9) if c else None
        if p is None:
            continue
        r["price"] = p
        r["market_cap"] = num(c.get("market_cap"), 0, 1e15) or r.get("market_cap")
        r["pct_24h"] = num(c.get("price_change_percentage_24h_in_currency"), -100, 1e6)
        r["pct_7d"] = num(c.get("price_change_percentage_7d_in_currency"), -100, 1e6)
        n += 1
    if n:
        crypto["as_of"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        crypto["source"] = "CoinGecko"
    return n


def check(data):
    """Whole-file sanity check before anything is written."""
    assert isinstance(data, dict) and data.get("schema") == 1, "schema"
    assert isinstance(data.get("stocks"), list) and 1 <= len(data["stocks"]) <= 500, "stocks"
    for r in data["stocks"]:
        assert isinstance(r.get("ticker"), str) and r["ticker"], "ticker"
        for k in ("close", "prev_close", "adj_sep30", "adj_dec31", "adj_oct31_25"):
            v = r.get(k)
            assert v is None or (isinstance(v, (int, float)) and math.isfinite(v) and v >= 0), k
    blob = json.dumps(data)
    assert len(blob) < MAX_BYTES, "size"
    if API_KEY:
        assert API_KEY not in blob, "key leak"


def main():
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    check(data)
    stocks, coms = data["stocks"], data.get("commodities", [])
    order = [r for r in stocks if r.get("close") is None]
    work = [("stock-monthly", r) for r in order] + [("commodity", r) for r in coms]
    rest = sorted([r for r in stocks if r.get("close") is not None], key=lambda r: (r.get("as_of") or "", stocks.index(r)))
    work += [("stock-quote", r) for r in rest]
    updated = {"stocks": 0, "commodities": 0}
    for kind, row in work:
        try:
            if kind == "stock-monthly":
                refresh_monthly(row); updated["stocks"] += 1
            elif kind == "commodity":
                refresh_commodity(row); updated["commodities"] += 1
            else:
                refresh_quote(row); updated["stocks"] += 1
        except RateLimited as e:
            log("stopping Alpha Vantage calls: %s" % e)
            break
        except (ValueError, KeyError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            log("skipped %s (%s): %s" % (row.get("ticker") or row.get("name"), kind, type(e).__name__))
    try:
        updated["crypto"] = refresh_crypto(data["crypto"])
    except Exception as e:  # crypto is optional; the browser also fetches it live
        log("crypto skipped: %s" % type(e).__name__)
        updated["crypto"] = 0
    data["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    check(data)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(DATA_PATH), suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, DATA_PATH)
    log("done: %s, %d Alpha Vantage calls" % (updated, calls))
    return 0


if __name__ == "__main__":
    sys.exit(main())
