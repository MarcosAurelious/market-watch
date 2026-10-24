/* Market Watch — front end.
 * Security model:
 *  - No API keys live here. The page only reads a public JSON feed (built by the GitHub Action, which holds the key as an encrypted secret)
 *    and CoinGecko's public, keyless price endpoint.
 *  - Every value from the network is validated against a whitelist schema before use (type, range, length, https-only links).
 *  - Nothing is ever inserted as HTML: all text goes through textContent / createTextNode, so data can't inject script.
 *  - No eval, no inline handlers, no third-party scripts; the CSP in index.html enforces this.
 */
(() => {
  'use strict';

  const CFG = Object.freeze(Object.assign({
    dataUrl: 'data/market.json',
    cryptoUrl: 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,tether,binancecoin,ripple,usd-coin,solana,tron,zcash,hyperliquid,dogecoin,monero,chainlink,leo-token,cardano&price_change_percentage=24h,7d',
    timeoutMs: 10000,
    maxBytes: 2_000_000,
  }, (window.MW_CONFIG && typeof window.MW_CONFIG === 'object') ? window.MW_CONFIG : {}));

  /* ======================= validation ======================= */
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const S = (v, max = 400) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : (typeof v === 'number' && isFinite(v) ? String(v) : ''));
  const N = (v, lo = -1e15, hi = 1e15) => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && isFinite(n) && n >= lo && n <= hi ? n : null; };
  const D = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 25) : null);
  const U = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };
  const A = (v, max = 500) => (Array.isArray(v) ? v.slice(0, max).filter(isObj) : []);
  const TICK = (v) => S(v, 24).replace(/[^A-Za-z0-9.\-, ]/g, '');

  function validate(raw) {
    if (!isObj(raw)) throw new Error('feed is not an object');
    const pf = isObj(raw.portfolio) ? raw.portfolio : {};
    const out = {
      generated_at: D(raw.generated_at) || null,
      portfolio: {
        budget: N(pf.budget, 1, 1e9) || 100, bought: D(pf.bought) || '2026-10-22',
        holdings: A(pf.holdings, 20).map((h) => ({ ticker: TICK(h.ticker), entry: N(h.entry, 0.0001, 1e7) })).filter((h) => h.ticker && h.entry),
      },
      stocks: A(raw.stocks, 200).map((r) => ({ sector: S(r.sector, 60), ticker: TICK(r.ticker), company: S(r.company, 80), close: N(r.close, 0, 1e7), prev_close: N(r.prev_close, 0, 1e7),
        adj_sep30: N(r.adj_sep30, 0, 1e7), adj_dec31: N(r.adj_dec31, 0, 1e7), adj_oct31_25: N(r.adj_oct31_25, 0, 1e7), as_of: D(r.as_of) })).filter((r) => r.ticker),
      commodities: A(raw.commodities, 20).map((r) => ({ name: S(r.name, 40), unit: S(r.unit, 20), price: N(r.price, 0, 1e7), prev_price: N(r.prev_price, 0, 1e7), as_of: D(r.as_of), source: S(r.source, 80) })).filter((r) => r.name && r.price != null),
      crypto: { as_of: S(isObj(raw.crypto) ? raw.crypto.as_of : '', 40), source: S(isObj(raw.crypto) ? raw.crypto.source : '', 40),
        rows: A(isObj(raw.crypto) ? raw.crypto.rows : [], 50).map((r) => ({ cg_id: S(r.cg_id, 40), symbol: TICK(r.symbol), name: S(r.name, 40), rank: N(r.rank, 0, 1e5), price: N(r.price, 0, 1e9),
          pct_24h: N(r.pct_24h, -100, 1e6), pct_7d: N(r.pct_7d, -100, 1e6), pct_ytd: N(r.pct_ytd, -100, 1e6), market_cap: N(r.market_cap, 0, 1e15) })).filter((r) => r.symbol) },
      sectors: A(raw.sectors, 20).map((r) => ({ sector: S(r.sector, 60), stocks: N(r.stocks, 0, 1e6), mkt_cap_t: N(r.mkt_cap_t, 0, 1e4), day_pct: N(r.day_pct, -1, 10), y1_pct: N(r.y1_pct, -1, 100),
        gainers: N(r.gainers, 0, 100), decliners: N(r.decliners, 0, 100), as_of: D(r.as_of) })).filter((r) => r.sector),
      top10: A(raw.top10, 300).map((r) => ({ sector: S(r.sector, 60), rank: N(r.rank, 0, 100), ticker: TICK(r.ticker), company: S(r.company, 80), industry: S(r.industry, 80), size: S(r.size, 30),
        close: N(r.close, 0, 1e7), day_pct: N(r.day_pct, -1, 10), mkt_cap_b: N(r.mkt_cap_b, 0, 1e6), as_of: D(r.as_of) })).filter((r) => r.ticker),
      penny: A(raw.penny, 60).map((r) => ({ rank: N(r.rank, 0, 1000), ticker: TICK(r.ticker), company: S(r.company, 80), close: N(r.close, 0, 1e4), day_pct: N(r.day_pct, -1, 1000),
        shares_traded: N(r.shares_traded, 0, 1e13), mkt_value_m: N(r.mkt_value_m, 0, 1e7), risk: S(r.risk, 40), as_of: D(r.as_of) })).filter((r) => r.ticker),
      geopolitics: A(raw.geopolitics, 20).map((r) => ({ event: S(r.event, 120), status: S(r.status, 900), market_effect: S(r.market_effect, 600), helped: S(r.helped, 300), hurt: S(r.hurt, 300),
        watch_stocks: S(r.watch_stocks, 400), next: S(r.next, 300), source: S(r.source, 200), as_of: D(r.as_of) })).filter((r) => r.event),
      congress: A(raw.congress, 60).map((r) => ({ rank: N(r.rank, 0, 1000), member: S(r.member, 60), party: S(r.party, 2).replace(/[^DRI]/g, ''), chamber: S(r.chamber, 10), state: S(r.state, 4),
        status: S(r.status, 12), trades: N(r.trades, 0, 1e6), volume_m: N(r.volume_m, 0, 1e6), last_active: S(r.last_active, 20), as_of: D(r.as_of) })).filter((r) => r.member),
      congress_stocks: A(raw.congress_stocks, 200).map((r) => ({ ticker: TICK(r.ticker), company: S(r.company, 80), total: N(r.total, 0, 1e7), members: N(r.members, 0, 600), ratio: N(r.ratio, 0, 100), as_of: D(r.as_of) }))
        .filter((r) => r.ticker && r.total != null && r.ratio != null),
      congress_recent: A(raw.congress_recent, 50).map((r) => ({ ticker: TICK(r.ticker), company: S(r.company, 80), purchases: N(r.purchases, 0, 1e6), buyers: N(r.buyers, 0, 600), as_of: D(r.as_of) })).filter((r) => r.ticker),
      trump_people: A(raw.trump_people, 20).map((r) => ({ person: S(r.person, 60), role: S(r.role, 120), disclosed: S(r.disclosed, 900), status: S(r.status, 600) })).filter((r) => r.person),
      trump_trades: A(raw.trump_trades, 2000).map((r) => ({ id: N(r.id, 0, 1e7), person: S(r.person, 60), group: S(r.group, 120), date: S(r.date, 40), asset: S(r.asset, 200), ticker: S(r.ticker, 80),
        action: S(r.action, 20), amount: S(r.amount, 80), source: S(r.source, 120), source_url: U(r.source_url), as_of: D(r.as_of) })).filter((r) => r.person),
    };
    if (!out.stocks.length) throw new Error('feed has no stock rows');
    return out;
  }

  /* ======================= network ======================= */
  async function getJSON(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), CFG.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (text.length > CFG.maxBytes) throw new Error('response too large');
      return JSON.parse(text);
    } finally { clearTimeout(t); }
  }
  function embeddedSnapshot() {
    const el = document.getElementById('mw-snapshot');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
  }
  async function liveCrypto(rows) {
    const raw = await getJSON(CFG.cryptoUrl);
    if (!Array.isArray(raw)) throw new Error('crypto feed not a list');
    const byId = new Map(raw.filter(isObj).map((c) => [S(c.id, 40), c]));
    let n = 0;
    const merged = rows.map((r) => {
      const c = byId.get(r.cg_id);
      if (!c) return r;
      const price = N(c.current_price, 0, 1e9);
      if (price == null) return r;
      n += 1;
      return Object.assign({}, r, { price, market_cap: N(c.market_cap, 0, 1e15) ?? r.market_cap,
        pct_24h: N(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h, -100, 1e6) ?? r.pct_24h,
        pct_7d: N(c.price_change_percentage_7d_in_currency, -100, 1e6) ?? r.pct_7d });
    });
    if (!n) throw new Error('no coins matched');
    return merged;
  }

  /* ======================= tiny DOM + SVG kit ======================= */
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, String(attrs[k])); return e; };
  const fmtPct = (v, d = 1) => (v == null || isNaN(v) ? '' : (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%');
  const fmtPctRaw = (v) => (v == null || isNaN(v) ? '' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%');
  const usd = (v) => (v == null || isNaN(v) ? '' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: v >= 1 ? 2 : 4, maximumFractionDigits: v >= 1 ? 2 : 4 }));
  const compact = (v) => (v == null ? '' : '$' + Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v));
  const int = (v) => (v == null ? '' : Math.round(v).toLocaleString('en-US'));
  const dShort = (s) => { if (!s) return ''; const d = new Date(s.length <= 10 ? s + 'T12:00:00Z' : s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
  const pill = (text, v) => el('span', 'pill ' + (v > 0 ? 'up' : v < 0 ? 'down' : 'flat'), text);
  const tone = (e, v) => { e.classList.remove('up', 'down'); if (v > 0) e.classList.add('up'); else if (v < 0) e.classList.add('down'); };
  const cell = (tr, content, cls) => { const td = tr.insertCell(); if (cls) td.className = cls; if (content instanceof Node) td.append(content); else td.textContent = content == null ? '' : String(content); return td; };
  const two = (a, b) => { const f = document.createDocumentFragment(); f.append(el('span', 'tk', a), el('span', 'co', b || '')); return f; };
  const C = { g: '#39ff6a', g2: '#22c24c', dim: '#1a7a33', line: '#145a26', down: '#ff5a4f', amber: '#ffc83d', blue: '#57b6ff', bg: '#030703' };
  const PALETTE = [C.g, C.amber, C.blue, '#ff7ad9', '#c4ff3d', '#ff9a3d', '#9a8cff', '#3dffe0'];

  /* original pixel-art sprites (8x8) drawn as SVG squares */
  const SPRITES = {
    coin: ['..####..', '.#$$$$#.', '#$$##$$#', '#$#$$$$#', '#$#$$$$#', '#$$##$$#', '.#$$$$#.', '..####..'],
    up: ['...#....', '..###...', '.#####..', '#######.', '..###...', '..###...', '..###...', '........'],
    down: ['..###...', '..###...', '..###...', '#######.', '.#####..', '..###...', '...#....', '........'],
    gem: ['..####..', '.#$$$$#.', '#$$$$$$#', '.#$$$$#.', '..#$$#..', '...##...', '........', '........'],
    drop: ['...#....', '..#$#...', '..#$#...', '.#$$$#..', '#$$$$$#.', '#$$$$$#.', '.#$$$#..', '..###...'],
    chart: ['.......#', '......##', '.#...#.#', '###.#..#', '#.##...#', '#......#', '########', '........'],
  };
  function sprite(name, size = 3, colors = { '#': C.g, '$': C.amber }) {
    const rows = SPRITES[name];
    const s = sv('svg', { width: 8 * size, height: 8 * size, viewBox: '0 0 8 8', class: 'sprite', 'aria-hidden': 'true' });
    rows.forEach((row, y) => [...row].forEach((ch, x) => { if (colors[ch]) s.append(sv('rect', { x, y, width: 1, height: 1, fill: colors[ch] })); }));
    return s;
  }

  /* tooltip */
  const tip = el('div', 'tip'); tip.hidden = true;
  function showTip(box, ev, lines) {
    if (tip.parentNode !== box) box.append(tip);
    tip.replaceChildren(...lines.map((l, i) => el('div', i === 0 ? 'k' : '', l)));
    tip.hidden = false;
    const r = box.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    tip.style.left = Math.max(0, Math.min(x + 12, box.clientWidth - tip.offsetWidth)) + 'px';
    tip.style.top = (y + 16) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  /* segmented "8-bit" horizontal bars, diverging around zero */
  let uid = 0;
  function blockBars(box, data, { label, value, fmt, tips, color = (v) => (v >= 0 ? C.g : C.down), rowH = 26 }) {
    box.replaceChildren();
    if (!data.length) { box.append(el('p', 'note', 'No data yet.')); return; }
    const W = Math.max(300, box.clientWidth || 600);
    const ctx = document.createElement('canvas').getContext('2d'); ctx.font = '20px VT323, monospace';
    const lw = Math.max(...data.map((d) => ctx.measureText(label(d)).width)) + 14;
    const vw = Math.max(...data.map((d) => ctx.measureText(fmt(value(d))).width)) + 12;
    const vals = data.map(value), lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const x0 = lw + (lo < 0 ? vw : 0), x1 = W - vw;
    const sx = (v) => x0 + ((v - lo) / ((hi - lo) || 1)) * (x1 - x0);
    const H = 8 + rowH * data.length + 4;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': box.getAttribute('aria-label') || 'Bar chart' });
    const defs = sv('defs', {}); svg.append(defs);
    const pat = (col) => { const id = 'p' + (++uid); const p = sv('pattern', { id, width: 8, height: 64, patternUnits: 'userSpaceOnUse' }); p.append(sv('rect', { x: 0, y: 0, width: 6, height: 64, fill: col })); defs.append(p); return `url(#${id})`; };
    const fills = new Map();
    svg.append(sv('line', { x1: sx(0), x2: sx(0), y1: 4, y2: H - 4, stroke: C.dim, 'stroke-width': 2, 'stroke-dasharray': '4 4' }));
    data.forEach((d, i) => {
      const v = value(d), y = 6 + i * rowH, h = rowH - 10, col = color(v);
      if (!fills.has(col)) fills.set(col, pat(col));
      const g = sv('g', {});
      const lab = sv('text', { x: lw - 8, y: y + h / 2 + 6, 'text-anchor': 'end', fill: C.g, 'font-size': 20 }); lab.textContent = label(d);
      const xa = Math.min(sx(0), sx(v)), w = Math.max(6, Math.abs(sx(v) - sx(0)));
      const bar = sv('rect', { x: xa, y, width: w, height: h, fill: fills.get(col) });
      const val = sv('text', { x: v >= 0 ? xa + w + 6 : xa - 6, y: y + h / 2 + 6, 'text-anchor': v >= 0 ? 'start' : 'end', fill: '#a9ffc0', 'font-size': 19 }); val.textContent = fmt(v);
      const hit = sv('rect', { x: 0, y: y - 4, width: W, height: rowH, fill: 'transparent' });
      hit.addEventListener('mousemove', (ev) => showTip(box, ev, tips(d)));
      hit.addEventListener('mouseleave', hideTip);
      g.append(lab, bar, val, hit); svg.append(g);
    });
    box.append(svg);
  }

  /* ======================= derived numbers ======================= */
  function stockReturns(stocks) {
    return stocks.map((s) => {
      const r = (b) => (s.close != null && b ? s.close / b - 1 : null);
      return Object.assign({}, s, { day_pct: r(s.prev_close), m1_pct: r(s.adj_sep30), ytd_pct: r(s.adj_dec31), y1_pct: r(s.adj_oct31_25) });
    });
  }
  function portfolio(data) {
    const P = data.portfolio, each = P.budget / Math.max(1, P.holdings.length);
    const rows = P.holdings.map((h) => {
      const s = data.stocks.find((x) => x.ticker === h.ticker) || {};
      const latest = s.close ?? h.entry, shares = each / h.entry, value = shares * latest;
      return { ticker: h.ticker, company: s.company || '', shares, entry: h.entry, latest, value, pl: value - each, pl_pct: value / each - 1, as_of: s.as_of };
    });
    const total = rows.reduce((t, r) => t + r.value, 0);
    const base = new Map(); // equal-weight benchmark across leaders priced at the buy date
    data.stocks.forEach((s) => { if (s.close != null && s.as_of) base.set(s.ticker, s); });
    return { rows, total, budget: P.budget, latest: rows.map((r) => r.as_of).filter(Boolean).sort().pop() };
  }
  function modelScores(stocks) {
    const d = stocks.filter((s) => s.close != null && s.adj_sep30 && s.adj_oct31_25).map((s) => {
      const m1 = s.close / s.adj_sep30 - 1, y1 = s.close / s.adj_oct31_25 - 1;
      return { ticker: s.ticker, company: s.company, sector: s.sector, m1, momentum: (1 + y1) / (1 + m1) - 1 };
    });
    if (d.length < 2) return [];
    const z = (k) => { const m = d.reduce((t, x) => t + x[k], 0) / d.length; const sd = Math.sqrt(d.reduce((t, x) => t + (x[k] - m) ** 2, 0) / d.length) || 1; return (x) => (x[k] - m) / sd; };
    const zm = z('momentum'), zr = z('m1');
    d.forEach((x) => { x.score = 0.7 * zm(x) - 0.3 * zr(x); });
    d.sort((a, b) => b.score - a.score);
    const seen = new Set(); let picks = 0;
    d.forEach((x, i) => { x.rank = i + 1; x.pick = picks < 4 && !seen.has(x.sector) ? (seen.add(x.sector), picks++, '★') : ''; });
    return d;
  }

  /* ======================= state ======================= */
  let DATA = null, RET = [], current = 'overview';
  const SOURCE = { feed: 'snapshot', crypto: 'snapshot' };

  /* ======================= renderers ======================= */
  function renderHeader() {
    const done = RET.filter((r) => r.ytd_pct != null);
    const take = $('#take'); take.replaceChildren();
    if (done.length) {
      const best = done.reduce((a, b) => (b.ytd_pct > a.ytd_pct ? b : a)), worst = done.reduce((a, b) => (b.ytd_pct < a.ytd_pct ? b : a));
      const avg = done.reduce((t, s) => t + s.ytd_pct, 0) / done.length, up = done.filter((s) => s.ytd_pct > 0).length;
      const b = (t) => el('b', '', t);
      take.append(document.createTextNode(`${done.length} sector leaders tracked. `), b(String(up)), document.createTextNode(' are up this year, averaging '), b(fmtPct(avg)),
        document.createTextNode('. Leader: '), b(best.ticker), document.createTextNode(` (${fmtPct(best.ytd_pct)}). Laggard: `), b(worst.ticker), document.createTextNode(` (${fmtPct(worst.ytd_pct)}).`));
    }
    const pf = portfolio(DATA);
    $('#pf-value').textContent = usd(pf.total);
    const g = $('#pf-gain'); g.textContent = (pf.total - pf.budget >= 0 ? '+' : '−') + '$' + Math.abs(pf.total - pf.budget).toFixed(2) + ' (' + fmtPct(pf.total / pf.budget - 1, 2) + ')'; tone(g, pf.total - pf.budget);
    $('#pf-since').textContent = 'Bought ' + dShort(DATA.portfolio.bought) + ' close · prices as of ' + (dShort(pf.latest) || '—');
  }

  function kpiCard(label, value, sub, icon) {
    const c = el('div', 'card px kpi');
    if (icon) { const i = el('span', 'icon'); i.append(icon); c.append(i); }
    c.append(el('span', 'label', label), el('span', 'big', value));
    if (sub) c.append(sub);
    return c;
  }
  const subLine = (...parts) => { const s = el('span', 'sub'); parts.forEach((p) => s.append(p instanceof Node ? p : document.createTextNode(p))); return s; };

  function renderOverview() {
    const k = $('#ov-kpis'); k.replaceChildren();
    const coin = (sym) => DATA.crypto.rows.find((r) => r.symbol === sym);
    const com = (n) => DATA.commodities.find((r) => r.name === n);
    [['BTC', 'Bitcoin'], ['ETH', 'Ethereum']].forEach(([sym, name]) => { const r = coin(sym); if (r) k.append(kpiCard(name, usd(r.price), subLine(pill(fmtPctRaw(r.pct_24h), r.pct_24h), ' 24h'), sprite('gem', 3, { '#': C.g, '$': sym === 'BTC' ? C.amber : C.blue }))); });
    [['Gold', 'coin'], ['WTI crude', 'drop']].forEach(([n, ic]) => { const r = com(n); if (!r) return; const chg = r.prev_price ? r.price / r.prev_price - 1 : null;
      k.append(kpiCard(`${r.name} (${r.unit})`, usd(r.price), subLine(chg == null ? 'no prior reading' : pill(fmtPct(chg, 2), chg), ' · ' + dShort(r.as_of)), sprite(ic, 3, ic === 'coin' ? { '#': C.amber, '$': '#7a5a00' } : { '#': C.g2, '$': C.g }))); });

    const heat = $('#heatmap'); heat.replaceChildren();
    const rows = RET.slice().sort((a, b) => (b.ytd_pct ?? -9) - (a.ytd_pct ?? -9));
    const maxAbs = Math.max(0.01, ...rows.map((r) => Math.abs(r.ytd_pct ?? 0)));
    rows.forEach((r) => {
      const c = el('div', 'cell px');
      const v = r.ytd_pct;
      if (v != null) {
        const lvl = Math.max(1, Math.min(4, Math.ceil(4 * Math.abs(v) / maxAbs)));
        const greens = ['#0d220f', '#123d1a', '#1b6b2d', '#2bb14b', '#39ff6a'], reds = ['#220d0c', '#3d1412', '#6e211c', '#b2352c', '#ff5a4f'];
        c.style.background = (v >= 0 ? greens : reds)[lvl];
        c.style.color = lvl >= 3 ? C.bg : (v >= 0 ? '#b8ffcb' : '#ffc2bd');
      } else c.style.color = C.dim;
      c.append(el('span', 't', r.ticker), el('span', 'v', v == null ? '...' : fmtPct(v)), el('span', 's', r.sector));
      heat.append(c);
    });

    const cb = $('#crypto-bars');
    blockBars(cb, DATA.crypto.rows.filter((r) => r.pct_24h != null && !['USDT', 'USDC'].includes(r.symbol)).sort((a, b) => b.pct_24h - a.pct_24h),
      { label: (d) => d.symbol, value: (d) => d.pct_24h / 100, fmt: (v) => fmtPct(v), tips: (d) => [d.name, usd(d.price) + ' · 24h ' + fmtPctRaw(d.pct_24h)] });
    const done = RET.filter((r) => r.ytd_pct != null).sort((a, b) => b.ytd_pct - a.ytd_pct);
    blockBars($('#ytd-mini'), done.length > 10 ? [...done.slice(0, 5), ...done.slice(-5)] : done,
      { label: (d) => d.ticker, value: (d) => d.ytd_pct, fmt: (v) => fmtPct(v, 0), tips: (d) => [d.company + ' (' + d.ticker + ')', 'YTD ' + fmtPct(d.ytd_pct) + ' · ' + usd(d.close)] });
  }

  function renderPortfolio() {
    const pf = portfolio(DATA);
    const k = $('#pf-kpis'); k.replaceChildren();
    const g = subLine((pf.total - pf.budget >= 0 ? '+' : '−') + '$' + Math.abs(pf.total - pf.budget).toFixed(2)); tone(g, pf.total - pf.budget);
    k.append(kpiCard('Portfolio value', usd(pf.total), g, sprite('coin', 3, { '#': C.amber, '$': '#7a5a00' })));
    const best = pf.rows.slice().sort((a, b) => b.pl_pct - a.pl_pct)[0];
    if (best) k.append(kpiCard('Best holding', best.ticker, subLine(pill(fmtPct(best.pl_pct, 2), best.pl_pct)), sprite('up', 3, { '#': C.g })));

    // pixel waffle: 100 squares, colored by share of value
    const wbox = $('#waffle'); wbox.replaceChildren();
    const svg = sv('svg', { viewBox: '0 0 110 110', role: 'img', 'aria-label': 'Portfolio split by holding' });
    let idx = 0; const counts = pf.rows.map((r) => Math.round(100 * r.value / pf.total));
    let diff = 100 - counts.reduce((a, b) => a + b, 0); if (counts.length) counts[0] += diff;
    counts.forEach((n, i) => { for (let j = 0; j < n && idx < 100; j++, idx++) { const sq = sv('rect', { x: (idx % 10) * 11, y: Math.floor(idx / 10) * 11, width: 9, height: 9, fill: PALETTE[i % PALETTE.length] });
      sq.addEventListener('mousemove', (ev) => showTip(wbox, ev, [pf.rows[i].ticker, usd(pf.rows[i].value)])); sq.addEventListener('mouseleave', hideTip); svg.append(sq); } });
    wbox.append(svg);

    const body = $('#pf-table tbody'); body.replaceChildren();
    pf.rows.forEach((r, i) => {
      const tr = body.insertRow();
      const c = cell(tr, ''); const sw = el('span', 'sw'); sw.style.background = PALETTE[i % PALETTE.length]; c.append(sw, el('span', 'tk', r.ticker));
      cell(tr, r.shares.toFixed(4), 'num hide-narrow'); cell(tr, usd(r.entry), 'num hide-narrow'); cell(tr, usd(r.latest), 'num'); cell(tr, usd(r.value), 'num');
      cell(tr, pill((r.pl >= 0 ? '+' : '−') + '$' + Math.abs(r.pl).toFixed(2), r.pl), 'num');
    });

    const m = modelScores(DATA.stocks);
    const mb = $('#model-table tbody'); mb.replaceChildren();
    m.forEach((r) => {
      const tr = mb.insertRow();
      cell(tr, String(r.rank), 'num'); cell(tr, two(r.ticker, r.company)); cell(tr, r.sector, 'hide-narrow');
      cell(tr, pill(fmtPct(r.momentum), r.momentum), 'num'); cell(tr, pill(fmtPct(r.m1), r.m1), 'num hide-narrow');
      cell(tr, (r.score >= 0 ? '+' : '') + r.score.toFixed(2), 'num'); const p = cell(tr, r.pick); p.style.color = C.amber;
    });
  }

  let sortKey = 'ytd_pct', sortDir = -1;
  function renderStocks() {
    blockBars($('#ytd-chart'), RET.filter((r) => r.ytd_pct != null).sort((a, b) => b.ytd_pct - a.ytd_pct),
      { label: (d) => d.ticker, value: (d) => d.ytd_pct, fmt: (v) => fmtPct(v, 0), rowH: 24, tips: (d) => [d.company + ' (' + d.ticker + ')', d.sector, 'YTD ' + fmtPct(d.ytd_pct)] });
    const sel = $('#st-sector'), q = $('#st-search').value.trim().toLowerCase();
    const secs = [...new Set(RET.map((r) => r.sector))].sort();
    if (sel.options.length !== secs.length + 1) { const k = sel.value; sel.replaceChildren(new Option('All sectors', ''), ...secs.map((s) => new Option(s, s))); sel.value = k; }
    document.querySelectorAll('#stock-table th').forEach((th) => { const b = th.querySelector('button'); th.setAttribute('aria-sort', b && b.dataset.k === sortKey ? (sortDir > 0 ? 'ascending' : 'descending') : 'none'); });
    const list = RET.filter((r) => (!sel.value || r.sector === sel.value) && (!q || (r.ticker + ' ' + r.company).toLowerCase().includes(q)))
      .sort((a, b) => { const x = a[sortKey], y = b[sortKey]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * sortDir; });
    const body = $('#stock-table tbody'); body.replaceChildren();
    list.forEach((r) => {
      const tr = body.insertRow();
      cell(tr, two(r.ticker, r.company)); cell(tr, r.sector, 'hide-narrow');
      if (r.close == null) cell(tr, 'pending', 'num pend'); else cell(tr, usd(r.close), 'num');
      cell(tr, r.day_pct == null ? '' : pill(fmtPct(r.day_pct), r.day_pct), 'num hide-narrow');
      cell(tr, r.m1_pct == null ? '' : pill(fmtPct(r.m1_pct), r.m1_pct), 'num hide-narrow');
      cell(tr, r.ytd_pct == null ? '' : pill(fmtPct(r.ytd_pct), r.ytd_pct), 'num');
      cell(tr, r.y1_pct == null ? '' : pill(fmtPct(r.y1_pct), r.y1_pct), 'num hide-narrow');
      cell(tr, dShort(r.as_of), 'hide-narrow');
    });
  }

  function renderCrypto() {
    const k = $('#crypto-kpis'); k.replaceChildren();
    const tint = { BTC: C.amber, ETH: C.blue, SOL: '#ff7ad9', XRP: C.g };
    ['BTC', 'ETH', 'SOL', 'XRP'].forEach((sym) => { const r = DATA.crypto.rows.find((x) => x.symbol === sym); if (!r) return;
      k.append(kpiCard(r.name, usd(r.price), subLine(pill(fmtPctRaw(r.pct_24h), r.pct_24h), ' 24h  ', pill(fmtPctRaw(r.pct_7d), r.pct_7d), ' 7d'), sprite('gem', 3, { '#': C.g, '$': tint[sym] }))); });
    const body = $('#crypto-table tbody'); body.replaceChildren();
    DATA.crypto.rows.slice().sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)).forEach((r) => {
      const tr = body.insertRow();
      cell(tr, String(r.rank ?? ''), 'num'); cell(tr, two(r.symbol, r.name)); cell(tr, usd(r.price), 'num');
      cell(tr, pill(fmtPctRaw(r.pct_24h), r.pct_24h), 'num'); cell(tr, pill(fmtPctRaw(r.pct_7d), r.pct_7d), 'num');
      cell(tr, compact(r.market_cap), 'num hide-narrow');
    });
    $('#crypto-src').textContent = SOURCE.crypto === 'live' ? 'LIVE from CoinGecko, refreshed when you opened this page.' : 'Live feed unreachable; showing the saved prices from ' + (DATA.crypto.as_of ? dShort(DATA.crypto.as_of) : 'the last update') + '.';
  }

  function renderCommodities() {
    const k = $('#com-tiles'); k.replaceChildren();
    const icon = { Gold: ['coin', { '#': C.amber, '$': '#7a5a00' }], Silver: ['coin', { '#': '#d8d8d8', '$': '#6d6d6d' }] };
    DATA.commodities.forEach((r) => {
      const chg = r.prev_price ? r.price / r.prev_price - 1 : null;
      const [ic, col] = icon[r.name] || ['drop', { '#': C.g2, '$': C.g }];
      k.append(kpiCard(`${r.name} (${r.unit})`, usd(r.price), subLine(chg == null ? 'no prior reading' : pill(fmtPct(chg, 2), chg), ' · ' + dShort(r.as_of)), sprite(ic, 3, col)));
    });
  }

  function renderSectors() {
    blockBars($('#sec-day'), DATA.sectors.slice().sort((a, b) => b.day_pct - a.day_pct), { label: (d) => d.sector, value: (d) => d.day_pct, fmt: (v) => fmtPct(v), tips: (d) => [d.sector, 'Day ' + fmtPct(d.day_pct, 2)] });
    blockBars($('#sec-1y'), DATA.sectors.slice().sort((a, b) => b.y1_pct - a.y1_pct), { label: (d) => d.sector, value: (d) => d.y1_pct, fmt: (v) => fmtPct(v, 0), tips: (d) => [d.sector, '1 year ' + fmtPct(d.y1_pct)] });
    const body = $('#sec-table tbody'); body.replaceChildren();
    DATA.sectors.slice().sort((a, b) => b.mkt_cap_t - a.mkt_cap_t).forEach((r) => {
      const tr = body.insertRow();
      cell(tr, el('span', 'tk', r.sector)); cell(tr, int(r.stocks), 'num hide-narrow'); cell(tr, '$' + (r.mkt_cap_t ?? 0).toFixed(2) + 'T', 'num');
      cell(tr, pill(fmtPct(r.day_pct, 2), r.day_pct), 'num'); cell(tr, pill(fmtPct(r.y1_pct), r.y1_pct), 'num');
      cell(tr, `${r.gainers ?? '-'} up / ${r.decliners ?? '-'} down`, 'hide-narrow');
    });
  }

  function renderTop10() {
    const sel = $('#t10-sector'), q = $('#t10-search').value.trim().toLowerCase();
    const secs = [...new Set(DATA.top10.map((r) => r.sector))];
    if (sel.options.length !== secs.length + 1) { const k = sel.value; sel.replaceChildren(new Option('All sectors', ''), ...secs.map((s) => new Option(s, s))); sel.value = k; }
    const body = $('#t10-table tbody'); body.replaceChildren();
    const maxV = Math.max(1, ...DATA.top10.map((r) => r.mkt_cap_b || 0));
    let last = null;
    DATA.top10.filter((r) => (!sel.value || r.sector === sel.value) && (!q || (r.ticker + ' ' + r.company + ' ' + r.industry).toLowerCase().includes(q))).forEach((r) => {
      if (r.sector !== last) { last = r.sector; const g = body.insertRow(); g.className = 'grp'; const td = g.insertCell(); td.colSpan = 7; td.textContent = r.sector; }
      const tr = body.insertRow();
      cell(tr, String(r.rank ?? ''), 'num'); cell(tr, two(r.ticker, r.company)); cell(tr, r.industry, 'hide-narrow'); cell(tr, r.size, 'hide-narrow');
      cell(tr, usd(r.close), 'num'); cell(tr, r.day_pct == null ? '' : pill(fmtPct(r.day_pct, 2), r.day_pct), 'num');
      const b = el('span', 'bar'); const i = el('i'); i.style.width = Math.max(6, Math.round(70 * Math.sqrt((r.mkt_cap_b || 0) / maxV))) + 'px'; i.style.color = C.g2;
      b.append(i, el('span', '', int(r.mkt_cap_b))); cell(tr, b, 'num');
    });
  }

  function renderGeo() {
    const box = $('#geo-cards'); box.replaceChildren();
    const chips = (text, cls) => { const w = el('div', 'chips'); String(text || '').split(/,\s*|;\s*/).filter(Boolean).forEach((t) => w.append(el('span', 'chip ' + cls, t))); return w; };
    const blk = (k, node) => { const d = el('div'); d.append(el('div', 'k', k), node); return d; };
    DATA.geopolitics.forEach((r) => {
      const c = el('article', 'card px geo-card');
      c.append(el('h3', '', r.event), el('p', '', r.status), blk('Market effect', el('p', '', r.market_effect)), blk('Helped', chips(r.helped, 'up')), blk('Hurt', chips(r.hurt, 'down')),
        blk('Stocks to watch', el('p', '', r.watch_stocks)), blk('Next to watch', el('p', '', r.next)), el('p', 'note', 'Source: ' + r.source));
      box.append(c);
    });
  }

  function renderPenny() {
    const colors = { 'Nano cap - very high risk': C.down, 'Micro cap - high risk': '#ff9a3d', 'Small cap': C.amber, 'Large co. - low share price': C.g };
    const order = Object.keys(colors), counts = new Map();
    DATA.penny.forEach((r) => counts.set(r.risk, (counts.get(r.risk) || 0) + 1));
    const bar = $('#risk-bar'), keys = $('#risk-keys'); bar.replaceChildren(); keys.replaceChildren();
    [...counts.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).forEach(([k, n]) => {
      const seg = el('span', '', n); seg.style.flex = String(n); seg.style.background = colors[k] || C.dim; seg.title = k; bar.append(seg);
      const key = el('span'); const sw = el('span', 'sw'); sw.style.background = colors[k] || C.dim; key.append(sw, document.createTextNode(`${k}: ${n}`)); keys.append(key);
    });
    const body = $('#penny-table tbody'); body.replaceChildren();
    DATA.penny.forEach((r) => {
      const tr = body.insertRow();
      cell(tr, String(r.rank ?? ''), 'num'); cell(tr, two(r.ticker, r.company)); cell(tr, usd(r.close), 'num');
      cell(tr, r.day_pct == null ? '' : pill(fmtPct(r.day_pct), r.day_pct), 'num');
      cell(tr, r.shares_traded == null ? '' : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(r.shares_traded), 'num hide-narrow');
      const rk = cell(tr, r.risk); rk.style.color = colors[r.risk] || C.g;
    });
  }

  function renderCongress() {
    const flow = DATA.congress_stocks.map((s) => Object.assign({}, s, { buys: Math.round(s.total * s.ratio / (1 + s.ratio)), sells: Math.round(s.total / (1 + s.ratio)) }));
    const tips = (d) => [d.company + ' (' + d.ticker + ')', '~' + int(d.buys) + ' buys · ~' + int(d.sells) + ' sells', (d.members ?? '?') + ' members traded it'];
    blockBars($('#cg-bought'), flow.slice().sort((a, b) => b.buys - a.buys).slice(0, 20), { label: (d) => d.ticker, value: (d) => d.buys, fmt: (v) => '~' + int(v), tips, color: () => C.g, rowH: 24 });
    blockBars($('#cg-sold'), flow.slice().sort((a, b) => b.sells - a.sells).slice(0, 10), { label: (d) => d.ticker, value: (d) => d.sells, fmt: (v) => '~' + int(v), tips, color: () => C.down, rowH: 24 });
    const rb = $('#cg-recent tbody'); rb.replaceChildren();
    DATA.congress_recent.forEach((r) => { const tr = rb.insertRow(); cell(tr, two(r.ticker, r.company)); cell(tr, int(r.buyers), 'num'); cell(tr, int(r.purchases), 'num'); });
    const pc = { D: C.blue, R: C.down, I: C.amber };
    blockBars($('#cg-members'), DATA.congress.filter((r) => (r.rank ?? 99) <= 20), { label: (d) => d.member, value: (d) => d.trades, fmt: (v) => int(v), color: () => C.g2, rowH: 24,
      tips: (d) => [d.member + ' (' + d.party + '-' + d.state + ')', int(d.trades) + ' trades · ~$' + d.volume_m + 'M', d.chamber + ' · ' + d.status] });
    const body = $('#cg-table tbody'); body.replaceChildren();
    DATA.congress.forEach((r) => {
      const tr = body.insertRow();
      cell(tr, String(r.rank ?? ''), 'num');
      const c = cell(tr, ''); const p = el('span', 'party ' + r.party.toLowerCase(), r.party); c.append(p, el('span', 'tk', r.member), document.createTextNode(' ' + r.state));
      cell(tr, r.chamber, 'hide-narrow'); cell(tr, int(r.trades), 'num'); cell(tr, '$' + (r.volume_m ?? 0).toFixed(1), 'num'); cell(tr, r.last_active, 'hide-narrow');
    });
    void pc;
  }

  function renderTrump() {
    const pbox = $('#people'); pbox.replaceChildren();
    const ini = (n) => n.replace(/\./g, '').split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('');
    DATA.trump_people.forEach((r, i) => {
      const c = el('article', 'card px person');
      const who = el('div', 'who'); const av = el('span', 'avatar', ini(r.person)); av.style.background = PALETTE[i % PALETTE.length];
      const nm = el('div'); nm.append(el('div', 'tk', r.person), el('div', 'co', r.role)); who.append(av, nm);
      c.append(who, el('p', '', r.disclosed), el('p', 'note', r.status));
      pbox.append(c);
    });
    const ps = $('#tt-person'), ac = $('#tt-action'), q = $('#tt-search').value.trim().toLowerCase();
    const people = [...new Set(DATA.trump_trades.map((r) => r.person))];
    if (ps.options.length !== people.length + 1) { const k = ps.value; ps.replaceChildren(new Option('Everyone', ''), ...people.map((x) => new Option(x, x))); ps.value = k; }
    $('#tt-count').textContent = String(DATA.trump_trades.length);
    const body = $('#tt-table tbody'); body.replaceChildren();
    let last = null;
    DATA.trump_trades.filter((r) => (!ps.value || r.person === ps.value) && (!ac.value || r.action === ac.value) && (!q || (r.asset + ' ' + r.ticker).toLowerCase().includes(q))).forEach((r) => {
      if (r.group !== last) { last = r.group; const g = body.insertRow(); g.className = 'grp'; const td = g.insertCell(); td.colSpan = 6; td.textContent = r.group; }
      const tr = body.insertRow();
      cell(tr, r.date); cell(tr, r.person, 'hide-narrow'); cell(tr, two(r.ticker, r.asset));
      cell(tr, r.action === 'Buy' ? pill('BUY', 1) : r.action === 'Sell' ? pill('SELL', -1) : el('span', 'chip', r.action));
      cell(tr, r.amount, 'num');
      const s = cell(tr, '', 'hide-narrow');
      if (r.source_url) { const a = el('a', '', r.source); a.href = r.source_url; a.target = '_blank'; a.rel = 'noopener noreferrer'; s.append(a); } else s.textContent = r.source;
    });
  }

  function asOfLabels() {
    const latest = (rows) => rows.map((r) => r.as_of).filter(Boolean).sort().pop();
    const map = { sectors: DATA.sectors, top10: DATA.top10, penny: DATA.penny, geopolitics: DATA.geopolitics, congress: DATA.congress, trump: DATA.trump_trades };
    document.querySelectorAll('[data-asof]').forEach((e) => { const d = latest(map[e.dataset.asof] || []); e.textContent = d ? 'As of ' + dShort(d) + '. ' : ''; });
  }

  const RENDER = { overview: renderOverview, portfolio: renderPortfolio, stocks: renderStocks, crypto: renderCrypto, commodities: renderCommodities, sectors: renderSectors,
    top10: renderTop10, geo: renderGeo, penny: renderPenny, congress: renderCongress, trump: renderTrump };

  function render() {
    if (!DATA) return;
    renderHeader(); asOfLabels();
    try { RENDER[current](); } catch (e) { console.error('render failed', e); }
  }

  /* ======================= tabs ======================= */
  const tabs = [...document.querySelectorAll('.tab')];
  function show(name, push = true) {
    if (!RENDER[name]) name = 'overview';
    current = name;
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    document.querySelectorAll('.page').forEach((p) => { p.hidden = p.dataset.page !== name; });
    const bar = $('.tabs'), sel = tabs.find((t) => t.dataset.tab === name);
    if (bar && sel && bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: Math.max(0, sel.offsetLeft - (bar.clientWidth - sel.offsetWidth) / 2), behavior: 'smooth' });
    if (push && /^[a-z0-9]+$/.test(name)) history.replaceState(null, '', '#' + name);
    render();
  }
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  document.querySelectorAll('#stock-table th button').forEach((b) => b.addEventListener('click', () => {
    if (sortKey === b.dataset.k) sortDir = -sortDir; else { sortKey = b.dataset.k; sortDir = ['ticker', 'sector'].includes(sortKey) ? 1 : -1; }
    renderStocks();
  }));
  [['#st-search', 'input', renderStocks], ['#st-sector', 'change', renderStocks], ['#t10-search', 'input', renderTop10], ['#t10-sector', 'change', renderTop10],
   ['#tt-person', 'change', renderTrump], ['#tt-action', 'change', renderTrump], ['#tt-search', 'input', renderTrump]].forEach(([s, ev, fn]) => { const e = $(s); if (e) e.addEventListener(ev, fn); });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(render, 200); });

  /* ======================= boot ======================= */
  function setStatus(kind, text) {
    const d = $('#status-dot'); d.className = 'dot ' + (kind === 'live' ? 'live' : 'snap');
    $('#status-text').textContent = text;
  }
  async function boot() {
    setStatus('snap', 'LOADING...');
    let raw = null;
    try { raw = await getJSON(CFG.dataUrl); SOURCE.feed = 'live'; }
    catch (e) { console.warn('feed unavailable, using snapshot:', e.message); raw = embeddedSnapshot(); SOURCE.feed = 'snapshot'; }
    try { DATA = validate(raw); }
    catch (e) {
      console.error('data rejected', e);
      const snap = embeddedSnapshot();
      if (snap && raw !== snap) { try { DATA = validate(snap); SOURCE.feed = 'snapshot'; } catch { DATA = null; } }
    }
    if (!DATA) { setStatus('snap', 'GAME OVER: no data could be loaded. Check your connection and press RELOAD.'); return; }
    RET = stockReturns(DATA.stocks);
    show(location.hash.slice(1) || 'overview', false);
    const when = DATA.generated_at ? new Date(DATA.generated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown';
    setStatus(SOURCE.feed === 'live' ? 'live' : 'snap', (SOURCE.feed === 'live' ? 'ONLINE · market feed updated ' : 'OFFLINE SNAPSHOT · saved ') + when);
    try { DATA.crypto.rows = await liveCrypto(DATA.crypto.rows); SOURCE.crypto = 'live'; DATA.crypto.as_of = new Date().toISOString(); render(); }
    catch (e) { console.warn('live crypto unavailable:', e.message); SOURCE.crypto = 'snapshot'; render(); }
  }
  /* limiter: one load at a time, and at most one manual reload every 30 seconds */
  let busy = false, lastLoad = 0;
  const COOLDOWN_MS = 30000;
  async function guardedBoot(manual) {
    const now = Date.now();
    if (busy) return;
    if (manual && now - lastLoad < COOLDOWN_MS) {
      const prevText = $('#status-text').textContent, prevDot = $('#status-dot').className;
      $('#status-text').textContent = 'Already up to date. Try RELOAD again in ' + Math.ceil((COOLDOWN_MS - (now - lastLoad)) / 1000) + 's.';
      setTimeout(() => { $('#status-text').textContent = prevText; $('#status-dot').className = prevDot; }, 2500);
      return;
    }
    busy = true; lastLoad = now;
    const btn = $('#reload'); btn.disabled = true;
    try { await boot(); } finally { busy = false; setTimeout(() => { btn.disabled = false; }, COOLDOWN_MS); }
  }
  $('#reload').addEventListener('click', () => guardedBoot(true));
  guardedBoot(false);
})();
