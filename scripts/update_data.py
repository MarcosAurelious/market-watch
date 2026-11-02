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


def http_json(url, params=None, max_bytes=MAX_BYTES):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    if not url.startswith("https://"):
        raise ValueError("refusing non-https url")
    req = urllib.request.Request(url, headers={"User-Agent": "market-watch-updater/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as res:  # nosec: fixed https hosts only
        body = res.read(max_bytes + 1)
    if len(body) > max_bytes:
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


# ---------------------------------------------------------------------------------------------------------------
# Kalshi prediction markets (public, keyless market data). The open-event list is large, so we page through it,
# keep active markets, and save the most-traded ones (24h volume). The page then refreshes just those prices live.
KALSHI_URL = "https://api.elections.kalshi.com/trade-api/v2"
KALSHI_PAGES = int(os.environ.get("MW_KALSHI_PAGES", "40"))
KALSHI_KEEP = 60
KALSHI_PER_EVENT = 3


def text(v, n):
    return "".join(ch if ch.isprintable() else " " for ch in str(v))[:n] if isinstance(v, (str, int, float)) else ""


def ticker_ok(v):
    v = text(v, 80)
    return v if v and all(c.isalnum() or c in "-._" for c in v) else ""


def kprice(m, key):
    """Kalshi price in dollars (0-1). Newer API: '<key>_dollars' strings; older: integer cents."""
    v = num(m.get(key + "_dollars"), 0, 1)
    if v is None:
        v = num(m.get(key), 0, 100)
        if v is not None and v > 1:
            v = v / 100.0
    return v


def kqty(m, key):
    v = num(m.get(key + "_fp"), 0, 1e13)
    return v if v is not None else num(m.get(key), 0, 1e13)


def kalshi_row(ev, m, multi):
    tk = ticker_ok(m.get("ticker"))
    if not tk or str(m.get("status", "active")) not in ("active", "open"):
        return None
    series = ticker_ok(ev.get("series_ticker")) or tk.split("-")[0]
    outcome = text(m.get("yes_sub_title") or m.get("subtitle") or "", 120) if multi else ""
    row = {
        "ticker": tk, "event_ticker": ticker_ok(ev.get("event_ticker")), "series": series,
        "category": text(ev.get("category") or "Other", 40), "event": text(ev.get("title") or m.get("title") or tk, 200),
        "outcome": outcome or text(m.get("yes_sub_title") or "", 120),
        "yes_bid": kprice(m, "yes_bid"), "yes_ask": kprice(m, "yes_ask"), "last": kprice(m, "last_price"),
        "prev": kprice(m, "previous_price"), "vol_24h": kqty(m, "volume_24h"), "volume": kqty(m, "volume"),
        "oi": kqty(m, "open_interest"), "close_time": text(m.get("close_time") or "", 25),
        "url": "https://kalshi.com/markets/" + series.lower(),
    }
    return row if (row["vol_24h"] or 0) > 0 else None


def refresh_kalshi(data):
    rows, cursor, pages = [], "", 0
    while pages < KALSHI_PAGES:
        params = {"status": "open", "with_nested_markets": "true", "limit": "100"}
        if cursor:
            params["cursor"] = cursor
        page = http_json(KALSHI_URL + "/events", params, max_bytes=20_000_000)
        pages += 1
        if not isinstance(page, dict):
            raise ValueError("kalshi page not an object")
        for ev in page.get("events") or []:
            if not isinstance(ev, dict):
                continue
            ms = [m for m in (ev.get("markets") or []) if isinstance(m, dict)]
            got = [r for r in (kalshi_row(ev, m, len(ms) > 1) for m in ms) if r]
            got.sort(key=lambda r: -(r["vol_24h"] or 0))
            rows.extend(got[:KALSHI_PER_EVENT])
        cursor = text(page.get("cursor") or "", 500)
        if not cursor or not page.get("events"):
            break
        time.sleep(0.3)
    if not rows:
        raise ValueError("no active Kalshi markets with volume")
    rows.sort(key=lambda r: -(r["vol_24h"] or 0))
    data["kalshi"] = {"as_of": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "Kalshi public API",
                      "pages": pages, "rows": rows[:KALSHI_KEEP]}
    return len(data["kalshi"]["rows"])


# ---------------------------------------------------------------------------------------------------------------
# Sportsbook lines from ESPN's public scoreboard feed (keyless). ESPN shows one sportsbook's line per game.
ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/"
LEAGUES = [  # (code, label, ESPN path, ESPN web path)
    ("nfl", "NFL", "football/nfl", "nfl"),
    ("cfb", "College football", "football/college-football", "college-football"),
    ("nba", "NBA", "basketball/nba", "nba"),
    ("cbb", "College basketball", "basketball/mens-college-basketball", "mens-college-basketball"),
    ("nhl", "NHL", "hockey/nhl", "nhl"),
    ("mlb", "MLB", "baseball/mlb", "mlb"),
    ("epl", "Premier League", "soccer/eng.1", "soccer"),
]


def american(v):
    n = num(v, -100000, 100000)
    if n is None and isinstance(v, str):
        n = num(v.replace("+", ""), -100000, 100000)
    return int(n) if n is not None and abs(n) >= 100 else None


def first(*vals):
    for v in vals:
        if v is not None:
            return v
    return None


def dig(o, *path):
    for p in path:
        if not isinstance(o, dict):
            return None
        o = o.get(p)
    return o


def espn_game(ev, league):
    code, label, _, web = league
    comp = (ev.get("competitions") or [None])[0]
    if not isinstance(comp, dict):
        return None
    teams = {c.get("homeAway"): c for c in comp.get("competitors") or [] if isinstance(c, dict)}
    h, a = teams.get("home"), teams.get("away")
    if not h or not a:
        return None
    odds = next((o for o in comp.get("odds") or [] if isinstance(o, dict)), None)
    if not odds:
        return None
    total = first(num(odds.get("overUnder"), 0, 1000),
                  num(str(dig(odds, "total", "over", "close", "line") or "").lstrip("ou"), 0, 1000))
    g = {
        "league": code, "league_name": label, "id": ticker_ok(ev.get("id")),
        "date": text(ev.get("date") or "", 25), "state": text(dig(ev, "status", "type", "state") or "", 8),
        "status": text(dig(ev, "status", "type", "shortDetail") or "", 60),
        "home": text(dig(h, "team", "displayName") or "", 60), "home_abbr": text(dig(h, "team", "abbreviation") or "", 8),
        "away": text(dig(a, "team", "displayName") or "", 60), "away_abbr": text(dig(a, "team", "abbreviation") or "", 8),
        "home_score": num(h.get("score"), 0, 1000), "away_score": num(a.get("score"), 0, 1000),
        "provider": text(dig(odds, "provider", "name") or "", 40), "details": text(odds.get("details") or "", 40),
        "spread": num(odds.get("spread"), -200, 200), "total": total,
        "home_ml": first(american(dig(odds, "homeTeamOdds", "moneyLine")), american(dig(odds, "moneyline", "home", "close", "odds")),
                         american(dig(odds, "moneyline", "home", "open", "odds"))),
        "away_ml": first(american(dig(odds, "awayTeamOdds", "moneyLine")), american(dig(odds, "moneyline", "away", "close", "odds")),
                         american(dig(odds, "moneyline", "away", "open", "odds"))),
    }
    if not g["id"] or not (g["home"] and g["away"]):
        return None
    if g["details"] == "" and g["spread"] is None and g["total"] is None and g["home_ml"] is None:
        return None
    g["url"] = "https://www.espn.com/%s/%s/_/gameId/%s" % (web, "match" if web == "soccer" else "game", g["id"])
    return g


def refresh_odds(data):
    old = {}
    prev = data.get("odds", {}).get("games", []) if isinstance(data.get("odds"), dict) else []
    for g in prev:
        old.setdefault(g.get("league"), []).append(g)
    games, ok = [], 0
    for lg in LEAGUES:
        try:
            raw = http_json(ESPN_URL + lg[2] + "/scoreboard")
            evs = raw.get("events") if isinstance(raw, dict) else None
            if not isinstance(evs, list):
                raise ValueError("no events list")
            got = [g for g in (espn_game(e, lg) for e in evs[:200] if isinstance(e, dict)) if g]
            games.extend(got[:40])
            ok += 1
        except Exception as e:  # keep the previous lines for a league that failed this time
            log("odds %s skipped: %s" % (lg[0], type(e).__name__))
            games.extend(old.get(lg[0], []))
    if not ok:
        raise ValueError("no league could be fetched")
    data["odds"] = {"as_of": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "ESPN scoreboard (sportsbook lines)",
                    "games": games}
    return len(games)


def check(data):
    """Whole-file sanity check before anything is written."""
    assert isinstance(data, dict) and data.get("schema") == 1, "schema"
    assert isinstance(data.get("stocks"), list) and 1 <= len(data["stocks"]) <= 500, "stocks"
    for r in data["stocks"]:
        assert isinstance(r.get("ticker"), str) and r["ticker"], "ticker"
        for k in ("close", "prev_close", "adj_sep30", "adj_dec31", "adj_oct31_25"):
            v = r.get(k)
            assert v is None or (isinstance(v, (int, float)) and math.isfinite(v) and v >= 0), k
    k = data.get("kalshi")
    assert k is None or (isinstance(k, dict) and isinstance(k.get("rows"), list) and len(k["rows"]) <= 200), "kalshi"
    o = data.get("odds")
    assert o is None or (isinstance(o, dict) and isinstance(o.get("games"), list) and len(o["games"]) <= 400), "odds"
    for g in (o or {}).get("games", []):
        assert str(g.get("url", "")).startswith("https://www.espn.com/"), "odds url"
    for r in (k or {}).get("rows", []):
        assert str(r.get("url", "")).startswith("https://kalshi.com/"), "kalshi url"
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
    for name, fn in (("kalshi", refresh_kalshi), ("odds", refresh_odds)):
        try:
            updated[name] = fn(data)
        except Exception as e:  # optional sections; keep the last good copy if a source is down
            log("%s skipped: %s" % (name, type(e).__name__))
            updated[name] = 0
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
