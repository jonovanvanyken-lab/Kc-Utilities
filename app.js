/* Kč Utilities — gas, electricity and water readings with photo evidence, tracked against your advances.
   This public code contains no data. See README.md for how your data is protected. */
(() => {
'use strict';

/* ================= defaults ================= */
const DEFAULT_CONFIG = {
  version: 1,
  budgetMonthly: 2450,
  period: { start: '2026-10-15', end: '2027-10-14' },
  gas: {
    eic: '',
    kwhPerM3: 10.6,
    supplierPerKWh: 1.30, supplierMonthly: 113.74,
    bands: [
      { upToKWh: 1890, supplierMonthly: 113.74, distPerKWh: 0.91460, distMonthly: 134.24 },
      { upToKWh: 7560, supplierMonthly: 125.84, distPerKWh: 0.49771, distMonthly: 199.76 },
      { upToKWh: 15000, supplierMonthly: 163.35, distPerKWh: 0.45154, distMonthly: 228.27 },
      { upToKWh: 25000, supplierMonthly: 163.35, distPerKWh: 0.41815, distMonthly: 268.85 },
      { upToKWh: 45000, supplierMonthly: 163.35, distPerKWh: 0.34915, distMonthly: 410.69 },
      { upToKWh: 63000, supplierMonthly: 163.35, distPerKWh: 0.28342, distMonthly: 653.71 }
    ],
    bandMode: 'auto',
    baseKWhMonth: 60,
    heatingPriorKWh: 3000, lowKWh: 2000, coldKWh: 4500,
    heatSplit: [20, 17, 14, 8, 2, 0, 0, 0, 0, 8, 13, 18],
    advances: [{ from: '2026-10-25', amount: 1890 }],
    lastAdvance: '2027-09-25',
    meters: [{ id: 'main', name: 'Gas meter', serial: '' }]
  },
  elec: {
    supplierPerKWh: 3.49, supplierMonthly: 163.35,
    distPerKWh: 3.45963, distMonthly: 165.61,
    fallbackPerDay: 1.7,
    advances: [{ from: '2026-10-25', amount: 510 }],
    lastAdvance: '2027-09-25',
    meters: [{ id: 'main', name: 'Electricity meter', serial: '' }]
  },
  water: {
    pricePerM3: 112.99, monthlyFixed: 0,
    fallbackPerDay: 0.1,
    period: { start: '', end: '' },
    advances: [],
    lastAdvance: '2027-09-25',
    meters: [{ id: 'cold', name: 'Cold water', serial: '' }]
  },
  checks: []
};

/* CALC-START */
const DAY = 864e5, MD = 30.436875;
function pd(s) { const [y, m, d] = String(s).split('-').map(Number); return Date.UTC(y, (m || 1) - 1, d || 1); }
function iso(t) { return new Date(t).toISOString().slice(0, 10); }
function dim(t) { const d = new Date(t); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); }
function monthStart(t) { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
function addMonths(t, k, day) { const d = new Date(t); const y = d.getUTCFullYear(), m = d.getUTCMonth() + k; const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return Date.UTC(y, m, Math.min(day || d.getUTCDate(), last)); }
function rT(r) {
  let t = pd(r.date);
  if (r.time && /^\d{1,2}:\d{2}/.test(r.time)) { const [h, mi] = r.time.split(':').map(Number); t += (h * 60 + mi) * 60000; }
  else t += 12 * 3600000;
  return t;
}
function integrate(fn, a, b) {
  if (b === a) return 0;
  if (b < a) return -integrate(fn, b, a);
  let s = 0, t = a;
  while (t < b) { const nx = Math.min(b, (Math.floor(t / DAY) + 1) * DAY); s += fn(t) * (nx - t) / DAY; t = nx; }
  return s;
}
const OFFICIAL = new Set(['gasnet', 'estimate']);
function compSet(readings, util, meter) {
  const rs = readings.filter(r => r.utility === util && (r.meter || 'main') === meter && isFinite(+r.value) && r.date)
    .map(r => ({ t: rT(r), v: +r.value, src: r.source, replaced: !!r.replaced, id: r.id }))
    .sort((a, b) => a.t - b.t);
  const own = rs.filter(r => !OFFICIAL.has(r.src));
  const keep = rs.filter(r => !OFFICIAL.has(r.src) || !own.some(o => Math.abs(o.t - r.t) <= 3 * DAY));
  const out = []; let off = 0;
  for (const r of keep) {
    const last = out[out.length - 1];
    if (last && r.t === last.t) continue;
    if (last && r.replaced) { off = last.v - r.v; out.push({ t: r.t, v: r.v + off, id: r.id }); continue; }
    if (last && r.v + off < last.v - 1e-9) continue;
    out.push({ t: r.t, v: r.v + off, id: r.id });
  }
  return out;
}
function valueAt(set, rate, t) {
  const n = set.length; if (!n) return null;
  if (t <= set[0].t) return set[0].v - integrate(rate, t, set[0].t);
  if (t >= set[n - 1].t) return set[n - 1].v + integrate(rate, set[n - 1].t, t);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (set[mid].t <= t) lo = mid; else hi = mid; }
  const a = set[lo], b = set[hi];
  return a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
}
function heatShare(g, t) { return (g.heatSplit[new Date(t).getUTCMonth()] || 0) / 100 / dim(t); }
function gasDailyKWh(g, H, t) { return g.baseKWhMonth / MD + H * heatShare(g, t); }
function fitH(g, set) {
  const K = 0.004; let num = K * g.heatingPriorKWh, den = K, sumS = 0;
  const lastT = set.length ? set[set.length - 1].t : 0;
  for (let i = 1; i < set.length; i++) {
    const a = set[i - 1], b = set[i];
    if (b.t < lastT - 240 * DAY) continue;
    const obs = (b.v - a.v) * g.kwhPerM3;
    const base = g.baseKWhMonth / MD * (b.t - a.t) / DAY;
    const S = integrate(t => heatShare(g, t), a.t, b.t);
    num += (obs - base) * S; den += S * S; sumS += S;
  }
  return { H: Math.max(0, Math.min(20000, num / den)), weight: (den - K) / den, sumS };
}
function fitRate(set, fallback) {
  if (set.length < 2) return { rate: fallback, fitted: false };
  const last = set[set.length - 1];
  let first = set.find(r => r.t >= last.t - 120 * DAY) || set[0];
  if (first === last) first = set[set.length - 2];
  const days = (last.t - first.t) / DAY;
  if (days < 5) return { rate: fallback, fitted: false };
  return { rate: Math.max(0, (last.v - first.v) / days), fitted: true, days };
}
function engine(cfg, readings, util) {
  const uc = cfg[util];
  const meters = (uc.meters && uc.meters.length) ? uc.meters : [{ id: 'main' }];
  const ms = meters.map(m => ({ meter: m, set: compSet(readings, util, m.id) }));
  let fit;
  if (util === 'gas') {
    fit = fitH(uc, ms[0].set);
    const rate = t => gasDailyKWh(uc, fit.H, t) / uc.kwhPerM3;
    ms.forEach(x => { x.rate = rate; });
  } else {
    const per = (+uc.fallbackPerDay || 0) / meters.length;
    ms.forEach(x => { x.fit = fitRate(x.set, per); const r = x.fit.rate; x.rate = () => r; });
    fit = { rate: ms.reduce((s, x) => s + (x.set.length ? x.fit.rate : 0), 0), fitted: ms.some(x => x.fit.fitted) };
  }
  const live = ms.filter(x => x.set.length);
  const units = (a, b) => live.reduce((s, x) => s + valueAt(x.set, x.rate, b) - valueAt(x.set, x.rate, a), 0);
  const energy = (a, b) => util === 'gas' ? units(a, b) * uc.kwhPerM3 : units(a, b);
  return { util, uc, ms, live, fit, units, energy, hasData: live.length > 0 };
}
function periodOf(cfg, util) {
  const wp = cfg.water && cfg.water.period;
  const p = (util === 'water' && wp && wp.start && wp.end) ? wp : cfg.period;
  return { s: pd(p.start), en: pd(p.end) + DAY };
}
function tariff(cfg, util, annual) {
  const uc = cfg[util];
  if (util === 'gas') {
    let bi;
    if (uc.bandMode === 'auto' || uc.bandMode == null || uc.bandMode === '') { bi = uc.bands.findIndex(b => annual <= b.upToKWh); if (bi < 0) bi = uc.bands.length - 1; }
    else bi = Math.min(uc.bands.length - 1, Math.max(0, +uc.bandMode));
    const b = uc.bands[bi];
    return { v: uc.supplierPerKWh + b.distPerKWh, f: (b.supplierMonthly != null && b.supplierMonthly !== '' ? +b.supplierMonthly : uc.supplierMonthly) + b.distMonthly, band: bi };
  }
  if (util === 'elec') return { v: uc.supplierPerKWh + uc.distPerKWh, f: uc.supplierMonthly + uc.distMonthly };
  return { v: uc.pricePerM3, f: +uc.monthlyFixed || 0 };
}
function schedule(uc) {
  const segs = (uc.advances || []).filter(s => s && s.from).map(s => ({ t: pd(s.from), a: +s.amount || 0 })).sort((a, b) => a.t - b.t);
  if (!segs.length) return [];
  const day = new Date(segs[0].t).getUTCDate();
  const end = uc.lastAdvance ? pd(uc.lastAdvance) : addMonths(segs[0].t, 11, day);
  const out = [];
  for (let k = 0; k < 72; k++) {
    const t = addMonths(segs[0].t, k, day); if (t > end) break;
    let a = 0; for (const s of segs) if (s.t <= t) a = s.a;
    if (a > 0) out.push({ t, a });
  }
  return out;
}
function summarize(cfg, readings, util, now) {
  const e = engine(cfg, readings, util);
  const { s, en } = periodOf(cfg, util);
  const sched = schedule(cfg[util]);
  const advYear = sched.reduce((a, p) => a + p.a, 0);
  const advPaid = sched.filter(p => p.t <= now).reduce((a, p) => a + p.a, 0);
  const remaining = sched.filter(p => p.t > now).length;
  const out = { util, e, s, en, sched, advYear, advPaid, remaining, nextAdv: sched.find(p => p.t > now) || null, hasAdv: sched.length > 0 };
  if (!e.hasData) return out;
  const annual = e.energy(s, en);
  const tf = tariff(cfg, util, annual);
  const cost = (a, b) => tf.v * e.energy(a, b) + tf.f * (b - a) / DAY / MD;
  const tNow = Math.min(Math.max(now, s), en);
  out.annual = annual; out.annualUnits = e.units(s, en); out.tf = tf; out.cost = cost;
  out.costNow = cost(s, tNow); out.costYear = cost(s, en);
  out.balanceNow = advPaid - out.costNow;
  out.settlement = advYear - out.costYear;
  out.suggested = remaining ? Math.max(0, Math.ceil(((out.costYear * 1.05) - advPaid) / remaining / 10) * 10) : null;
  return out;
}
function gasScenario(cfg, sum, H) {
  const g = cfg.gas, x = sum.e.ms[0];
  const base0 = valueAt(x.set, x.rate, sum.s);
  const rate = t => gasDailyKWh(g, H, t) / g.kwhPerM3;
  return t => base0 + integrate(rate, sum.s, t);
}
function impliedGasH(cfg, sum) {
  if (!sum.hasAdv || !sum.tf) return null;
  const g = cfg.gas; let lo = 0, annual = 0;
  for (let i = 0; i < g.bands.length; i++) {
    const b = g.bands[i];
    const v = g.supplierPerKWh + b.distPerKWh, f = (b.supplierMonthly != null && b.supplierMonthly !== '' ? +b.supplierMonthly : g.supplierMonthly) + b.distMonthly;
    annual = (sum.advYear - f * 12) / v;
    if (annual <= b.upToKWh || i === g.bands.length - 1) break;
    lo = b.upToKWh;
  }
  return Math.max(0, annual - g.baseKWhMonth * 12);
}
/* CALC-END */

/* ================= helpers ================= */
const UTILS = ['gas', 'elec', 'water'];
const ICON = {
  gas: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.6 2.4c.6 3.3 4.9 5.7 4.9 10.4a5.4 5.4 0 0 1-10.8 0c0-2.7 1.4-4.3 2.8-5.5.2 1.7.9 2.9 2 3.4-.3-3.5.2-5.9 1.1-8.3z"/></svg>',
  elec: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.6 2 5 13.6h5.7L9.6 22 19 9.8h-5.8z"/></svg>',
  water: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.6s6.4 7 6.4 11.8a6.4 6.4 0 0 1-12.8 0C5.6 9.6 12 2.6 12 2.6z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M3.5 7.6h3.7l1.8-2.7h6l1.8 2.7h3.7v11.5H3.5z"/><circle cx="12" cy="13.2" r="3.6" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6"/></svg>'
};
const U = {
  gas: { label: 'Gas', unit: 'm³', intD: 5, decD: 3, c: 'var(--gas)', wash: 'var(--gas-wash)' },
  elec: { label: 'Electricity', unit: 'kWh', intD: 6, decD: 0, c: 'var(--elec)', wash: 'var(--elec-wash)' },
  water: { label: 'Water', unit: 'm³', intD: 5, decD: 3, c: 'var(--water)', wash: 'var(--water-wash)' }
};
const SOURCES = { own: 'My reading', gasnet: 'GasNet (remote)', distributor: 'Distributor reading', estimate: 'Estimate', bill: 'From a bill', landlord: 'Landlord reading' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nfmt = (v, d = 0) => (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
const kc = v => nfmt(Math.round(v)) + ' Kč';
const kc2 = v => nfmt(v, 2) + ' Kč';
const skc = v => (Math.round(v) >= 0 ? '+' : '−') + Math.abs(Math.round(v)).toLocaleString('en-GB') + ' Kč';
const fd = (t, o) => new Date(t).toLocaleDateString('en-GB', Object.assign({ day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }, o || {}));
const fdShort = t => fd(t, { year: undefined });
const mlabel = t => { const d = new Date(t); const m = d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }); return d.getUTCMonth() === 0 ? m + ' ’' + String(d.getUTCFullYear()).slice(2) : m; };
const kfmt = v => Math.abs(v) >= 1000 ? nfmt(v / 1000, Math.abs(v) % 1000 ? 1 : 0) + 'k' : nfmt(v, Math.abs(v) < 10 && v % 1 ? 1 : 0);
const clone = o => JSON.parse(JSON.stringify(o));
function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? clone(base) : over;
  const out = clone(base);
  if (over && typeof over === 'object') for (const k of Object.keys(over)) out[k] = (k in base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) ? merge(base[k], over[k]) : over[k];
  return out;
}
function clean(o) { return JSON.parse(JSON.stringify(o, (k, v) => v === undefined ? null : v)); }
function parseNum(s) {
  if (s == null) return NaN; s = String(s).trim().replace(/[\s ]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.'); else s = s.replace(/,/g, '');
  return Number(s);
}
const nowT = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes()); };
const ago = (t, now) => { const d = Math.floor((now - t) / DAY); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago'; };
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmtBytes = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const valFmt = (util, v) => util === 'elec' ? nfmt(v, v % 1 ? 1 : 0) : nfmt(v, 3);
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };

/* ================= state ================= */
const S = {
  cfg: clone(DEFAULT_CONFIG), readings: [], bills: [],
  key: null, raw: null, keys: null, docs: null, urls: new Map(), remembered: false,
  tab: 'overview', logFilter: 'all', logView: 'list',
  draft: null, rolled: new Map(), animated: new Set()
};
const TABS = [['overview', 'Overview'], ['gas', 'Gas'], ['elec', 'Electricity'], ['water', 'Water'], ['log', 'Readings'], ['bills', 'Bills'], ['settings', 'Settings']];
{ const h = (location.hash || '').slice(1); const saved = lsGet('kcm-tab'); const pick = TABS.find(t => t[0] === h) ? h : (TABS.find(t => t[0] === saved) ? saved : 'overview'); S.tab = pick; }

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
let JOBS = [];

/* ================= meter register ================= */
const DIGITS = '<span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span>9</span>';
function registerHTML(v, util, size, key) {
  const u = U[util];
  let dec = u.decD; if (util === 'elec') dec = (Math.round(v * 10) % 10) ? 1 : 0;
  const str = Math.abs(v).toFixed(dec);
  let [ip, fp = ''] = str.split('.');
  ip = ip.padStart(u.intD, '0');
  const prev = S.rolled.get(key);
  const settled = prev === v || reduceMotion();
  const drum = (ch, red, i) => `<span class="drum${red ? ' red' : ''}"><span class="strip" data-d="${ch}" style="--d:${settled ? ch : 0};transition-delay:${i * 70}ms">${DIGITS}</span></span>`;
  let i = 0;
  const html = `<div class="reg" style="--rs:${size}px" role="img" aria-label="${esc(valFmt(util, v))} ${u.unit}">` +
    [...ip].map(ch => drum(ch, false, i++)).join('') +
    (fp ? '<span class="reg-sep"></span>' + [...fp].map(ch => drum(ch, true, i++)).join('') : '') +
    `<span class="reg-unit">${u.unit}</span></div>`;
  S.rolled.set(key, v);
  return html;
}
function rollRegisters() {
  const strips = main.querySelectorAll('.strip');
  requestAnimationFrame(() => requestAnimationFrame(() => strips.forEach(s => s.style.setProperty('--d', s.dataset.d))));
}

/* ================= charts ================= */
function niceStep(range, count) { const raw = range / Math.max(1, count); const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const f = raw / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }
function ticks(min, max, count) { const st = niceStep(max - min || 1, count || 4); const a = Math.floor(min / st) * st, b = Math.ceil(max / st) * st; const out = []; for (let v = a; v <= b + st / 2; v += st) out.push(+v.toFixed(10)); return out; }
function monthStarts(a, b) { const out = []; let t = monthStart(a); if (t < a) t = addMonths(t, 1, 1); for (; t <= b; t = addMonths(t, 1, 1)) out.push(t); return out; }
function interp(pts, t) {
  if (!pts.length || t < pts[0][0] - 1 || t > pts[pts.length - 1][0] + 1) return null;
  let lo = 0, hi = pts.length - 1;
  if (t <= pts[0][0]) return pts[0][1];
  if (t >= pts[hi][0]) return pts[hi][1];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= t) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi]; if (b[0] === a[0]) return b[1];
  return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
}
function animateLines(host, key) {
  if (reduceMotion() || S.animated.has(key)) return;
  S.animated.add(key);
  host.querySelectorAll('path.ln[data-anim="1"]').forEach(p => {
    let L = 0; try { L = p.getTotalLength(); } catch (e) { return; }
    p.style.strokeDasharray = L; p.style.strokeDashoffset = L; p.getBoundingClientRect();
    p.style.transition = 'stroke-dashoffset 1.3s cubic-bezier(.2,.8,.2,1)'; p.style.strokeDashoffset = 0;
    p.addEventListener('transitionend', () => { p.style.strokeDasharray = ''; p.style.transition = ''; }, { once: true });
  });
}
function placeTip(tip, host, px) {
  tip.hidden = false;
  const w = host.clientWidth, tw = tip.offsetWidth;
  let left = px + 14; if (left + tw > w) left = px - 14 - tw; tip.style.left = Math.max(0, left) + 'px'; tip.style.top = '6px';
}
function tipRows(rows) {
  return rows.map(r => `<div class="tip-r"><i class="lk${r.dash ? ' dash' : ''}${r.c ? '' : ' none'}" style="--k:${r.c || 'transparent'}"></i><span>${esc(r.label)}</span><b>${esc(r.value)}</b></div>`).join('');
}
function lineChart(host, o) {
  const W = Math.max(280, Math.round(host.clientWidth || 340)), H = o.height || 230;
  const m = { l: o.ml || 46, r: o.mr || 74, t: 18, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const vals = o.series.flatMap(s => s.pts.map(p => p[1])).concat((o.dots || []).flatMap(d => d.pts.map(p => p[1])));
  if (!vals.length) { host.innerHTML = '<p class="muted small">No data yet.</p>'; return; }
  let lo = o.yMin ?? Math.min(...vals), hi = o.yMax ?? Math.max(...vals);
  if (o.zero) lo = Math.min(0, lo);
  if (hi === lo) hi = lo + 1;
  if (!o.zero) lo -= (hi - lo) * .05;
  hi += (hi - lo) * .05;
  const yt = ticks(lo, hi, o.yTicks || 4); const y0 = yt[0], y1 = yt[yt.length - 1];
  const X = t => m.l + (t - o.x0) / (o.x1 - o.x0) * iw, Y = v => m.t + ih - (v - y0) / (y1 - y0) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.aria || '')}">`;
  yt.forEach(v => { s += `<line class="${v === y0 ? 'base' : 'grid'}" x1="${m.l}" x2="${m.l + iw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ax" x="${m.l - 8}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${esc(o.yFmt(v))}</text>`; });
  const months = monthStarts(o.x0, o.x1); const every = Math.max(1, Math.ceil(months.length / Math.max(1, Math.floor(iw / 44))));
  months.forEach((t, i) => { if (i % every) return; const x = X(t); s += `<line class="base" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${m.t + ih}" y2="${m.t + ih + 4}"/><text class="ax" x="${(x + 3).toFixed(1)}" y="${H - 8}">${esc(mlabel(t))}</text>`; });
  if (o.today && o.today > o.x0 && o.today < o.x1) { const x = X(o.today).toFixed(1); s += `<line class="todayl" x1="${x}" x2="${x}" y1="${m.t - 6}" y2="${m.t + ih}"/><text class="ax" x="${(+x + 4).toFixed(1)}" y="${m.t - 2}">Today</text>`; }
  o.series.forEach(se => {
    if (se.pts.length < 2) return;
    const d = se.pts.map((p, j) => (j ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
    if (se.area) { const b = Y(Math.max(y0, 0)).toFixed(1); s += `<path d="${d}L${X(se.pts[se.pts.length - 1][0]).toFixed(1)} ${b}L${X(se.pts[0][0]).toFixed(1)} ${b}Z" fill="${se.color}" fill-opacity=".1" stroke="none"/>`; }
    s += `<path class="ln" d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.w || 2}" stroke-linejoin="round" stroke-linecap="round"${se.dash ? ` stroke-dasharray="${se.dash}"` : ''} data-anim="${se.dash ? 0 : 1}"/>`;
  });
  (o.dots || []).forEach(ds => ds.pts.forEach(p => { if (p[0] < o.x0 || p[0] > o.x1) return; s += `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="4.5" fill="${ds.color}" stroke="var(--surface)" stroke-width="2"/>`; }));
  const labs = o.series.filter(se => se.end && se.pts.length).map(se => { const p = se.pts[se.pts.length - 1]; return { y: Y(p[1]), y0: Y(p[1]), x: X(p[0]), t: se.end(p[1]), c: se.color }; }).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labs.length; i++) if (labs[i].y - labs[i - 1].y < 14) labs[i].y = labs[i - 1].y + 14;
  const over = labs.length ? labs[labs.length - 1].y - (m.t + ih) : 0;
  if (over > 0) labs.forEach(l => { l.y -= over; });
  for (let i = labs.length - 2; i >= 0; i--) if (labs[i + 1].y - labs[i].y < 14) labs[i].y = labs[i + 1].y - 14;
  labs.forEach(l => {
    const lx = m.l + iw + 10;
    if (Math.abs(l.y - l.y0) > 2) s += `<line x1="${(l.x + 4).toFixed(1)}" y1="${l.y0.toFixed(1)}" x2="${lx - 3}" y2="${l.y.toFixed(1)}" stroke="var(--line-2)" stroke-width="1"/>`;
    s += `<circle cx="${l.x.toFixed(1)}" cy="${l.y0.toFixed(1)}" r="4" fill="${l.c}" stroke="var(--surface)" stroke-width="2"/><text class="endl" x="${lx}" y="${(l.y + 4).toFixed(1)}">${esc(l.t)}</text>`;
  });
  s += `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/><g class="hd"></g><rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent" tabindex="0" aria-label="Chart readout: use left and right arrows"/></svg><div class="tip" hidden></div>`;
  host.innerHTML = s;
  const svg = host.querySelector('svg'), tip = host.querySelector('.tip'), xh = svg.querySelector('.xh'), hd = svg.querySelector('.hd'), hit = svg.querySelector('.hit');
  let cur = o.today && o.today > o.x0 && o.today < o.x1 ? o.today : o.x0;
  const show = t => {
    cur = t; const rows = []; let g = '';
    o.series.forEach(se => { if (se.noTip) return; const v = interp(se.pts, t); if (v == null) return; rows.push({ c: se.color, dash: !!se.dash, label: se.label, value: (o.tipFmt || o.yFmt)(v, se) }); g += `<circle cx="${X(t).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="4" fill="${se.color}" stroke="var(--surface)" stroke-width="2"/>`; });
    if (o.extra) o.extra(t).forEach(r => rows.push({ label: r[0], value: r[1] }));
    xh.setAttribute('x1', X(t)); xh.setAttribute('x2', X(t)); xh.setAttribute('visibility', 'visible'); hd.innerHTML = g;
    tip.innerHTML = `<div class="tip-h">${esc(fd(t))}</div>` + tipRows(rows);
    const r = svg.getBoundingClientRect(); placeTip(tip, host, X(t) * r.width / W);
  };
  const fromEvent = ev => { const r = svg.getBoundingClientRect(); const sx = (ev.clientX - r.left) * W / r.width; return o.x0 + (Math.min(Math.max(sx, m.l), m.l + iw) - m.l) / iw * (o.x1 - o.x0); };
  const hide = () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); hd.innerHTML = ''; };
  hit.addEventListener('pointermove', ev => show(fromEvent(ev)));
  hit.addEventListener('pointerdown', ev => show(fromEvent(ev)));
  hit.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse') hide(); });
  hit.addEventListener('focus', () => show(cur));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', ev => { const step = (o.x1 - o.x0) / 40; if (ev.key === 'ArrowRight') { ev.preventDefault(); show(Math.min(o.x1, cur + step)); } if (ev.key === 'ArrowLeft') { ev.preventDefault(); show(Math.max(o.x0, cur - step)); } if (ev.key === 'Escape') hide(); });
  animateLines(host, o.key);
}
function barPath(x, y, w, h, r) { r = Math.min(r, h, w / 2); if (h <= 0) return ''; return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`; }
function barChart(host, o) {
  const W = Math.max(280, Math.round(host.clientWidth || 340)), H = o.height || 210;
  const m = { l: 44, r: 10, t: 22, b: 30 }; const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const totals = o.cats.map(c => c.segs.reduce((a, s) => a + Math.max(0, s.v), 0));
  const top = Math.max(1, ...totals, o.ref ? o.ref.v * 1.08 : 0);
  const yt = ticks(0, top, 4); const y1 = yt[yt.length - 1];
  const Y = v => m.t + ih - v / y1 * ih;
  const band = iw / o.cats.length, bw = Math.min(24, band * .64);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.aria || '')}">`;
  yt.forEach(v => { s += `<line class="${v === 0 ? 'base' : 'grid'}" x1="${m.l}" x2="${m.l + iw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ax" x="${m.l - 8}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${esc(o.yFmt(v))}</text>`; });
  const every = Math.max(1, Math.ceil(o.cats.length / Math.floor(iw / 30)));
  let bars = '', hits = '';
  o.cats.forEach((c, i) => {
    const x = m.l + band * i + (band - bw) / 2; let acc = 0;
    const live = c.segs.filter(sg => sg.v > 0); let g = '';
    live.forEach((sg, j) => {
      const yTop = Y(acc + sg.v), yBot = Y(acc) - (acc > 0 ? 2 : 0); const h = yBot - yTop;
      if (h > 0.4) g += `<path d="${j === live.length - 1 ? barPath(x, yTop, bw, h, 4) : `M${x} ${yTop}h${bw}v${h}h${-bw}Z`}" fill="${sg.color}"${sg.fc ? ' fill-opacity=".4"' : ''}/>`;
      acc += sg.v;
    });
    hits += `<rect class="bar-hit" data-i="${i}" x="${(m.l + band * i).toFixed(1)}" y="${m.t}" width="${band.toFixed(1)}" height="${ih}" fill="transparent" tabindex="0" aria-label="${esc(c.label)}"/><g>${g}</g>`;
    if (i % every === 0) s += `<text class="ax" x="${(x + bw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(c.short)}</text>`;
  });
  s += `<g class="bars" style="transform-origin:0 ${m.t + ih}px">${hits}</g>`;
  if (o.ref) { const y = Y(o.ref.v).toFixed(1); s += `<line x1="${m.l}" x2="${m.l + iw}" y1="${y}" y2="${y}" stroke="var(--ink)" stroke-width="1.5"/><text class="reft" x="${m.l + iw}" y="${(+y - 6).toFixed(1)}" text-anchor="end">${esc(o.ref.label)}</text>`; }
  s += '</svg><div class="tip" hidden></div>';
  host.innerHTML = s;
  const svg = host.querySelector('svg'), tip = host.querySelector('.tip');
  const show = i => {
    const c = o.cats[i]; const rows = c.segs.filter(sg => sg.v > 0 || sg.always).map(sg => ({ c: sg.color, label: sg.label + (sg.fc ? ' (forecast)' : ''), value: o.vFmt(sg.v) }));
    if (c.segs.length > 1) rows.push({ label: 'Total', value: o.vFmt(totals[i]) });
    tip.innerHTML = `<div class="tip-h">${esc(c.label)}</div>` + tipRows(rows);
    const r = svg.getBoundingClientRect(); placeTip(tip, host, (m.l + band * (i + .5)) * r.width / W);
  };
  svg.querySelectorAll('.bar-hit').forEach(h => { const i = +h.dataset.i; h.addEventListener('pointerenter', () => show(i)); h.addEventListener('pointerdown', () => show(i)); h.addEventListener('focus', () => show(i)); h.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse') tip.hidden = true; }); h.addEventListener('blur', () => { tip.hidden = true; }); });
  if (!reduceMotion() && !S.animated.has(o.key)) {
    S.animated.add(o.key);
    const g = svg.querySelector('.bars'); g.style.transition = 'none'; g.style.transform = 'scaleY(0)'; g.getBoundingClientRect(); g.style.transition = ''; requestAnimationFrame(() => { g.style.transform = 'scaleY(1)'; });
  }
}
function legend(items) {
  return `<div class="legend">${items.map(it => `<span>${it.sq ? `<i class="sq${it.fc ? ' fc' : ''}" style="--k:${it.c}"></i>` : `<i class="lk${it.dash ? ' dash' : ''}" style="--k:${it.c}"></i>`}${esc(it.label)}</span>`).join('')}</div>`;
}

/* ================= data helpers ================= */
function rawReadings(util, meter) {
  return S.readings.filter(r => r.utility === util && (!meter || (r.meter || 'main') === meter) && r.date && isFinite(+r.value)).sort((a, b) => rT(a) - rT(b));
}
function latest(util) { const rs = rawReadings(util); return rs[rs.length - 1] || null; }
function sumsAll(now) { const o = {}; UTILS.forEach(u => { o[u] = summarize(S.cfg, S.readings, u, now); }); return o; }
function withDeltas(list) {
  const byKey = {};
  return list.map(r => {
    const k = r.utility + '|' + (r.meter || 'main'); const prev = byKey[k]; byKey[k] = r;
    if (!prev) return { r };
    const dt = (rT(r) - rT(prev)) / DAY; const dv = +r.value - +prev.value;
    return { r, prev, dt, dv, rate: dt > 0 ? dv / dt : null };
  });
}
function meterName(util, id) { const m = (S.cfg[util].meters || []).find(x => x.id === (id || 'main')); return m ? m.name : ''; }

/* ================= views ================= */
function render() {
  renderTabs();
  if (S.tab === 'settings' && S.draft && S.draftDirty) return; // keep edits in progress
  JOBS = [];
  const now = nowT();
  let html = '';
  if (S.tab === 'overview') html += vOverview(now);
  else if (UTILS.includes(S.tab)) html += vUtility(S.tab, now);
  else if (S.tab === 'log') html += vLog(now);
  else if (S.tab === 'bills') html += vBills(now);
  else if (S.tab === 'settings') html += vSettings();
  main.innerHTML = html;
  JOBS.forEach(j => { const el = document.getElementById(j.id); if (el) j.fn(el); });
  rollRegisters();
  main.querySelectorAll('.dv-bar[data-w]').forEach(b => requestAnimationFrame(() => requestAnimationFrame(() => { b.style.width = b.dataset.w + '%'; })));
  hydratePhotos(main);
}
function renderTabs() {
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button class="tab" role="tab" type="button" data-tab="${k}" aria-selected="${S.tab === k}">${U[k] ? `<i class="dot" style="--c:${U[k].c}"></i>` : ''}${l}</button>`).join('');
  setSyncUI();
}
function setTab(t) {
  if (S.tab === 'settings' && t !== 'settings') { S.draft = null; S.draftDirty = false; }
  S.tab = t; lsSet('kcm-tab', t); render(); window.scrollTo({ top: 0 });
}

/* ---------- overview ---------- */
function vOverview(now) {
  const sums = sumsAll(now);
  const any = UTILS.some(u => sums[u].e.hasData);
  if (!any) return `<section class="empty"><h3>No readings yet</h3><p class="lede">Add a reading for each meter with a photo. The dashboard then tracks your costs against the ČEZ advances and forecasts the next bill.</p><div class="btnrow"><button class="btn primary" data-act="add" data-u="gas">Add your first reading</button><button class="btn" data-act="import">Import from the Claude page</button></div></section>`;
  const counted = UTILS.filter(u => sums[u].e.hasData && sums[u].hasAdv);
  const total = counted.reduce((a, u) => a + sums[u].settlement, 0);
  const endT = pd(S.cfg.period.end);
  const good = total >= 0;
  const maxAbs = Math.max(1, ...UTILS.filter(u => sums[u].e.hasData && sums[u].hasAdv).map(u => Math.abs(sums[u].settlement)));
  const rows = UTILS.map(u => {
    const x = sums[u];
    let bar = '', val;
    if (!x.e.hasData) val = `<span class="muted">No readings</span>`;
    else if (!x.hasAdv) val = `<span class="muted">No advance set</span><small>cost ~${kc(x.costYear / 12)}/mo</small>`;
    else {
      const w = Math.min(50, Math.abs(x.settlement) / maxAbs * 50);
      bar = `<i class="dv-bar ${x.settlement >= 0 ? 'pos' : 'neg'}" data-w="${w.toFixed(1)}"></i>`;
      val = `<span class="${x.settlement >= 0 ? 'pos-t' : 'neg-t'}">${skc(x.settlement)}</span><small>${x.settlement >= 0 ? 'refund' : 'to pay'}</small>`;
    }
    return `<div class="dv-row"><span class="dv-name"><i style="--c:${U[u].c}"></i>${U[u].label}</span><span class="dv-track"><i class="dv-axis"></i>${bar}</span><span class="dv-val">${val}</span></div>`;
  }).join('');
  const advMonthly = counted.reduce((a, u) => a + (sums[u].sched.find(p => p.t > now) || sums[u].sched[sums[u].sched.length - 1] || { a: 0 }).a, 0);
  const costMonthly = UTILS.filter(u => sums[u].e.hasData).reduce((a, u) => a + sums[u].costYear / 12, 0);
  const waterNote = sums.water.e.hasData && !sums.water.hasAdv ? ' Water is left out until you add the landlord’s advance in Settings.' : (!sums.water.e.hasData ? ' Water joins once you log its first reading.' : '');
  let html = `<section class="hero">
    <div>
      <p class="kick">At the ČEZ bill after ${esc(fd(endT))}</p>
      <div class="hero-fig">${good ? '+' : '−'}${Math.abs(Math.round(total)).toLocaleString('en-GB')}<span class="cur">Kč</span></div>
      <span class="verdict ${good ? 'good' : 'bad'}">${good ? '▲ On track for a refund' : '▼ Heading for a top-up'}</span>
      <p class="hero-sub" style="margin-top:12px">If you keep using energy at the pace your readings show, this is what the reconciliation should come to.${waterNote}</p>
    </div>
    <div class="card">
      <div class="card-h"><h3>Projected settlement</h3><span class="aside">advances − forecast cost</span></div>
      <div class="dv">${rows}<div class="dv-scale"><span></span><span><span>◂ to pay</span><span>refund ▸</span></span><span></span></div></div>
      <p class="small muted" style="margin:0">Advances ${kc(advMonthly)}/month · forecast cost ~${kc(costMonthly)}/month · budget ${kc(S.cfg.budgetMonthly)}</p>
    </div>
  </section>`;
  html += `<section class="sec"><div class="sec-h"><h2>Meters</h2><span class="aside">Tap a card for detail</span></div><div class="ucards">${UTILS.map(u => uCard(u, sums[u], now)).join('')}</div></section>`;
  // monthly cost chart
  const ms0 = monthStart(sums.gas.s || pd(S.cfg.period.start));
  const cats = []; for (let k = 0; k < 12; k++) {
    const a = addMonths(ms0, k, 1), b = addMonths(ms0, k + 1, 1);
    const mid = (a + b) / 2;
    cats.push({ label: fd(a, { day: undefined }) + (a <= now && b > now ? ' (this month)' : ''), short: mlabel(a), segs: UTILS.map(u => ({ label: U[u].label, color: U[u].c, fc: !(sums[u].e.hasData && rT(rawReadings(u)[rawReadings(u).length - 1]) >= mid), v: sums[u].e.hasData ? sums[u].cost(a, b) : 0, always: sums[u].e.hasData })) });
  }
  JOBS.push({ id: 'ch-monthly', fn: el => barChart(el, { key: 'monthly', cats, yFmt: kfmt, vFmt: kc, ref: { v: S.cfg.budgetMonthly, label: 'Budget ' + kc(S.cfg.budgetMonthly) }, aria: 'Monthly utility cost by month, stacked by utility, against the monthly budget' }) });
  html += `<section class="card"><div class="card-h"><h3>Monthly cost</h3>${legend([{ c: 'var(--gas)', label: 'Gas', sq: 1 }, { c: 'var(--elec)', label: 'Electricity', sq: 1 }, { c: 'var(--water)', label: 'Water', sq: 1 }, { c: 'var(--ink-2)', label: 'Forecast', sq: 1, fc: 1 }])}</div><div class="chart" id="ch-monthly"></div><p class="small muted" style="margin:0">Heating months carry the cost; the advances spread it evenly, which is why summer shows a surplus building up.</p></section>`;
  // coming up + checks
  const nextRows = [];
  const nextDate = Math.min(...UTILS.map(u => sums[u].nextAdv ? sums[u].nextAdv.t : Infinity));
  if (isFinite(nextDate)) { const parts = UTILS.filter(u => sums[u].nextAdv && sums[u].nextAdv.t === nextDate).map(u => `${U[u].label.toLowerCase()} ${kc(sums[u].nextAdv.a)}`); nextRows.push(`<div class="check" style="cursor:default"><span class="chip">${esc(fdShort(nextDate))}</span><span>Advances due: ${esc(parts.join(' + '))}</span></div>`); }
  const me = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 0);
  nextRows.push(`<div class="check" style="cursor:default"><span class="chip">${esc(fdShort(me))}</span><span>Month-end readings. GasNet reads the gas meter remotely that day, so a photo of your own lets you compare.</span></div>`);
  if (now < pd('2026-12-05')) nextRows.push(`<div class="check" style="cursor:default"><span class="chip">30 Nov</span><span>Gas advance check. The Gas tab tells you whether to lower the 1,890 Kč advance.</span></div>`);
  const checks = (S.cfg.checks || []);
  html += `<section class="ucards">
    <div class="card"><h3>Coming up</h3><div>${nextRows.join('')}</div></div>
    <div class="card"><div class="card-h"><h3>Open checks</h3><span class="aside">${checks.filter(c => !c.done).length} left</span></div><div>${checks.length ? checks.map(c => `<label class="check${c.done ? ' done' : ''}"><input type="checkbox" data-check="${esc(c.id)}"${c.done ? ' checked' : ''}><span>${esc(c.text)}</span></label>`).join('') : '<p class="muted small" style="margin:0">Nothing to check.</p>'}</div></div>
  </section>`;
  return html;
}
function uCard(u, x, now) {
  const last = latest(u);
  const head = `<div class="uhead"><span class="uico" style="--c:${U[u].c};--wash:${U[u].wash}">${ICON[u]}</span><span class="uname">${U[u].label}</span><span class="umeta">${last ? 'Read ' + ago(rT(last), now) : 'No readings'}</span></div>`;
  if (!x.e.hasData) return `<div class="ucard" role="link" tabindex="0" data-tab="${u}" aria-label="${U[u].label} details">${head}<p class="muted small" style="margin:0">${u === 'water' ? 'Photograph the water meter (or meters) to start tracking. Water is billed through your landlord.' : 'Add a reading to start tracking.'}</p><button class="btn sm" type="button" data-act="add" data-u="${u}" style="width:max-content">Add ${U[u].label.toLowerCase()} reading</button></div>`;
  const bal = x.hasAdv ? `<span class="${x.balanceNow >= 0 ? 'pos-t' : 'neg-t'}">${skc(x.balanceNow)}</span>` : '—';
  const st = x.hasAdv ? `<span class="${x.settlement >= 0 ? 'pos-t' : 'neg-t'}">${skc(x.settlement)}</span>` : '—';
  return `<div class="ucard" role="link" tabindex="0" data-tab="${u}" aria-label="${U[u].label} details">${head}${registerHTML(+last.value, u, 20, 'card-' + u)}
    <dl class="kv">
      <div><dt>Advances paid</dt><dd>${x.hasAdv ? kc(x.advPaid) : '—'}</dd></div>
      <div><dt>Cost so far</dt><dd>${kc(x.costNow)}</dd></div>
      <div><dt>Balance today</dt><dd>${bal}</dd></div>
      <div><dt>At the bill</dt><dd>${st}</dd></div>
    </dl></div>`;
}

/* ---------- utility pages ---------- */
function vUtility(u, now) {
  const x = summarize(S.cfg, S.readings, u, now);
  const last = latest(u);
  const uc = S.cfg[u];
  const metaBits = u === 'gas' ? [`Honeywell BK-G4ETe`, `no. ${esc(uc.meters[0].serial || '')}`, `EIC ${esc(uc.eic || '')}`] : u === 'elec' ? [`Single tariff`, `no. ${esc(uc.meters[0].serial || '')}`] : (uc.meters || []).map(m => esc(m.name + (m.serial ? ' · no. ' + m.serial : '')));
  let html = `<section class="sec"><div class="uhead"><span class="uico" style="--c:${U[u].c};--wash:${U[u].wash}">${ICON[u]}</span><span class="kick">${metaBits.join(' · ')}</span></div><h2 class="ptitle">${U[u].label}</h2></section>`;
  if (!x.e.hasData) {
    return html + `<section class="empty"><h3>No ${U[u].label.toLowerCase()} readings yet</h3><p class="lede">${u === 'water' ? 'Take a photo of the water meter and type the number in, black digits then red. If you find a second meter (hot water, or a second riser), add it in Settings first.' : 'Take a photo of the meter and type in the number shown.'}</p><button class="btn primary" data-act="add" data-u="${u}">${ICON.camera}Add first reading</button></section>`;
  }
  html += `<section class="card"><div class="card-h"><div style="display:flex;flex-direction:column;gap:10px;min-width:0">${registerHTML(+last.value, u, 30, 'page-' + u)}<span class="small muted">Last read ${esc(fd(rT(last)))}${last.time ? ' at ' + esc(last.time) : ''} · ${ago(rT(last), now)} · ${esc(SOURCES[last.source] || last.source || '')}</span></div><button class="btn primary" data-act="add" data-u="${u}">${ICON.camera}Add reading</button></div></section>`;
  const unit = U[u].unit;
  const annualTxt = u === 'gas' ? `${nfmt(x.annual)} kWh` : `${nfmt(x.annualUnits, u === 'water' ? 1 : 0)} ${unit}`;
  const annualSub = u === 'gas' ? `${nfmt(x.annualUnits)} m³ · band ${bandLabel(x.tf.band)}` : `~${nfmt(x.annualUnits / 12, u === 'water' ? 1 : 0)} ${unit} a month`;
  const rateTxt = u === 'gas' ? `${nfmt(x.e.fit.H)} kWh` : `${nfmt(x.e.fit.rate, u === 'water' ? 3 : 2)} ${unit}`;
  const rateSub = u === 'gas' ? `heating per year · ${x.e.fit.weight < .5 ? 'mostly the 3,000 kWh starting estimate' : 'fitted to your readings'}` : `per day ${x.e.fit.fitted ? 'from your readings' : '(starting estimate)'}`;
  html += `<section class="tiles">
    <div class="tile"><span class="l">Balance today</span><span class="v ${x.hasAdv ? (x.balanceNow >= 0 ? 'pos-t' : 'neg-t') : ''}">${x.hasAdv ? skc(x.balanceNow) : kc(-x.costNow)}</span><span class="s">${x.hasAdv ? `${kc(x.advPaid)} paid − ${kc(x.costNow)} used` : 'cost so far, no advance set'}</span></div>
    <div class="tile"><span class="l">At the bill</span><span class="v ${x.hasAdv ? (x.settlement >= 0 ? 'pos-t' : 'neg-t') : ''}">${x.hasAdv ? skc(x.settlement) : '—'}</span><span class="s">${x.hasAdv ? `${x.settlement >= 0 ? 'refund' : 'to pay'} · cost ~${kc(x.costYear)} for the year` : `cost ~${kc(x.costYear)} for the year`}</span></div>
    <div class="tile"><span class="l">Year forecast</span><span class="v">${annualTxt}</span><span class="s">${annualSub}</span></div>
    <div class="tile"><span class="l">${u === 'gas' ? 'Heating estimate' : 'Daily use'}</span><span class="v">${rateTxt}</span><span class="s">${rateSub}</span></div>
  </section>`;
  if (u === 'gas') html += gasAdvanceCard(x, now) + gasExpectedCard(x, now);
  else if (x.hasAdv) html += advanceCard(u, x, now);
  html += balanceCard(u, x, now) + monthlyUseCard(u, x, now);
  if (u !== 'elec') html += leakCard(u);
  html += recentCard(u, now) + tariffFoot(u, x);
  return html;
}
function bandLabel(i) { const b = S.cfg.gas.bands; const lo = i ? b[i - 1].upToKWh : 0; return `${nfmt(lo / 1000, 2)}–${nfmt(b[i].upToKWh / 1000, 2)} MWh`; }
function currentAdvance(x, now) { const nx = x.sched.find(p => p.t > now); return nx ? nx.a : (x.sched.length ? x.sched[x.sched.length - 1].a : 0); }
function gasAdvanceCard(x, now) {
  const rule = pd('2026-11-30') + DAY - 60000;
  const cen = gasScenario(S.cfg, x, S.cfg.gas.heatingPriorKWh)(rule);
  const ih = impliedGasH(S.cfg, x); const cez = ih != null ? gasScenario(S.cfg, x, ih)(rule) : null;
  const cur = currentAdvance(x, now);
  const conf = x.e.fit.weight;
  let body;
  if (now < pd('2026-12-01')) {
    body = `<p style="margin:0">Check your reading on <b>30 Nov</b>. If it is about <b>${nfmt(Math.round(cen / 5) * 5)} m³</b> or below, you are on the central track: lower the gas advance to about <b>1,300 Kč</b> in Můj ČEZ and raise electricity to 600–650 Kč. If it is near <b>${cez != null ? nfmt(Math.round(cez / 5) * 5) : '—'} m³</b>, ČEZ's estimate was right and 1,890 Kč stays.</p>`;
  } else {
    body = `<p style="margin:0">Your readings since the heating came on put the year at about ${nfmt(x.annual)} kWh.</p>`;
  }
  const sug = x.suggested;
  let sugLine;
  if (sug == null) sugLine = 'No payments left in this billing year.';
  else if (conf < .5) {
    const g = S.cfg.gas, coldAnnual = g.baseKWhMonth * 12 + g.coldKWh, tc = tariff(S.cfg, 'gas', coldAnnual);
    const costCold = tc.v * coldAnnual + tc.f * (x.en - x.s) / DAY / MD;
    const safe = Math.max(0, Math.ceil((costCold * 1.05 - x.advPaid) / x.remaining / 10) * 10);
    sugLine = `A safe gas advance for now is about <b>${kc(safe)}</b> a month, enough for a cold winter (now ${kc(cur)}). At the pace of your readings so far it would be ${kc(sug)}, but that rests on very little heating data.`;
  } else sugLine = `Suggested gas advance: <b>${kc(sug)}</b> a month (now ${kc(cur)}). It covers the forecast plus 5% headroom, spread over the ${x.remaining} remaining payments.`;
  return `<section class="card"><div class="card-h"><h3>Advance check</h3><span class="chip ${conf < .5 ? 'warn' : 'ok'}">${conf < .5 ? '! Early estimate' : '✓ Based on heating data'}</span></div>${body}
    <div class="note info"><span class="ic">≈</span><span>${sugLine}</span></div></section>`;
}
function advanceCard(u, x, now) {
  const cur = currentAdvance(x, now); const sug = x.suggested; if (sug == null) return '';
  const diff = sug - cur; const ok = Math.abs(diff) <= Math.max(30, cur * .08);
  return `<section class="card"><div class="card-h"><h3>Advance check</h3><span class="chip ${ok ? 'ok' : 'warn'}">${ok ? '✓ About right' : diff > 0 ? '! Too low' : '! Too high'}</span></div><p style="margin:0">To finish the billing year near zero you would pay about <b>${kc(sug)}</b> a month (now ${kc(cur)}). ${ok ? 'No change needed.' : diff > 0 ? `Raising it avoids a ${kc(-x.settlement)} top-up at the bill.` : 'Lowering it keeps more money with you during the year.'}</p></section>`;
}
function gasExpectedCard(x, now) {
  const g = S.cfg.gas, set = x.e.ms[0].set;
  const ih = impliedGasH(S.cfg, x);
  const scen = [
    { k: 'pace', label: 'Your pace', H: x.e.fit.H },
    { k: 'central', label: `Central (${nfmt(g.heatingPriorKWh)} kWh heating)`, H: g.heatingPriorKWh },
    { k: 'cold', label: `Cold (${nfmt(g.coldKWh)} kWh)`, H: g.coldKWh },
    { k: 'cez', label: `ČEZ advance (~${nfmt((ih + g.baseKWhMonth * 12) / 1000, 1)} MWh)`, H: ih }
  ].filter(s => s.H != null);
  const fns = Object.fromEntries(scen.map(s => [s.k, gasScenario(S.cfg, x, s.H)]));
  const raw = rawReadings('gas');
  const x0 = Math.max(rT(raw[0]) - 5 * DAY, x.s - 80 * DAY), x1 = pd(addMonthsISO(S.cfg.period.start, 8)) ;
  const lastT = set[set.length - 1].t;
  const pts = (fn, a, b, step) => { const out = []; for (let t = a; t < b; t += step) out.push([t, fn(t)]); out.push([b, fn(b)]); return out; };
  const rd = t => valueAt(set, x.e.ms[0].rate, t);
  const series = [
    { label: 'Readings', color: 'var(--gas)', pts: pts(rd, x0, Math.min(lastT, x1), 2 * DAY), w: 2.5 },
    { label: 'Your pace (forecast)', color: 'var(--gas)', dash: '5 4', pts: pts(rd, lastT, x1, 3 * DAY), end: v => nfmt(Math.round(v)) },
    { label: 'Central', color: 'var(--muted)', w: 1.5, pts: pts(fns.central, x.s, x1, 3 * DAY), end: v => 'Central ' + nfmt(Math.round(v)) },
    { label: 'Cold', color: 'var(--ink-2)', w: 1.5, pts: pts(fns.cold, x.s, x1, 3 * DAY), end: v => 'Cold ' + nfmt(Math.round(v)) }
  ];
  if (fns.cez) series.push({ label: 'ČEZ advance', color: 'var(--ink)', w: 1.5, dash: '2 3', pts: pts(fns.cez, x.s, x1, 3 * DAY), end: v => 'ČEZ ' + nfmt(Math.round(v)) });
  const dots = [{ color: 'var(--gas)', pts: raw.map(r => [rT(r), +r.value]).filter(p => p[0] >= x0) }];
  JOBS.push({ id: 'ch-gas-exp', fn: el => lineChart(el, { key: 'gas-exp', series, dots, x0, x1, today: now, yFmt: v => nfmt(v), tipFmt: v => nfmt(v, 1) + ' m³', height: 250, mr: 96, aria: 'Gas meter reading against expected readings for the central, cold and ČEZ scenarios' }) });
  // month-end table
  const rows = []; let me = Date.UTC(new Date(x.s).getUTCFullYear(), new Date(x.s).getUTCMonth() + 1, 0);
  for (let k = 0; k < 8; k++) {
    const t = me + DAY - 60000;
    const near = raw.filter(r => Math.abs(rT(r) - t) <= 2 * DAY).sort((a, b) => Math.abs(rT(a) - t) - Math.abs(rT(b) - t))[0];
    let act = '—';
    if (near) {
      const v = +near.value; const c = fns.central(t), co = fns.cold(t);
      const tag = v <= c + 3 ? '<span class="chip ok">✓ central or below</span>' : v <= co + 3 ? '<span class="chip warn">! central–cold</span>' : '<span class="chip bad">✕ above cold</span>';
      act = `${nfmt(v, near.value % 1 ? 1 : 0)} ${tag}`;
    } else if (t < now) act = '<span class="muted">no reading</span>';
    rows.push(`<tr><td>${esc(fd(me, { year: '2-digit' }))}</td><td>${nfmt(Math.round(fns.pace(t)))}</td><td>${nfmt(Math.round(fns.central(t)))}</td><td>${nfmt(Math.round(fns.cold(t)))}</td>${fns.cez ? `<td>${nfmt(Math.round(fns.cez(t)))}</td>` : ''}<td>${act}</td></tr>`);
    me = Date.UTC(new Date(me).getUTCFullYear(), new Date(me).getUTCMonth() + 2, 0);
  }
  return `<section class="card"><div class="card-h"><h3>Meter reading vs expected</h3>${legend([{ c: 'var(--gas)', label: 'Your readings' }, { c: 'var(--gas)', label: 'Your pace', dash: 1 }, { c: 'var(--muted)', label: 'Central' }, { c: 'var(--ink-2)', label: 'Cold' }, { c: 'var(--ink)', label: 'ČEZ advance', dash: 1 }])}</div>
    <div class="chart" id="ch-gas-exp"></div>
    <div class="tblw"><table class="tbl"><thead><tr><th>Month end</th><th>Your pace</th><th>Central</th><th>Cold</th>${fns.cez ? '<th>ČEZ</th>' : ''}<th>Actual (m³)</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <p class="small muted" style="margin:0">After May, add about ${nfmt(g.baseKWhMonth / g.kwhPerM3, 1)} m³ a month for hot water. Readings within two days of a month end count as actual.</p></section>`;
}
function addMonthsISO(s, k) { const t = pd(s); return iso(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + k + 1, 0)); }
function balanceCard(u, x, now) {
  const step = 2 * DAY; const costPts = [], fcPts = [];
  const tNow = Math.min(Math.max(now, x.s), x.en);
  for (let t = x.s; t <= x.en; t += step) { const p = [t, x.cost(x.s, t)]; if (t <= tNow) costPts.push(p); if (t >= tNow - step) fcPts.push(p); }
  if (costPts.length) costPts.push([tNow, x.cost(x.s, tNow)]);
  fcPts.push([x.en, x.costYear]);
  const series = [];
  if (x.hasAdv) {
    const adv = [[x.s, 0]]; let acc = 0; x.sched.forEach(p => { if (p.t < x.s || p.t > x.en) return; adv.push([p.t, acc]); acc += p.a; adv.push([p.t, acc]); }); adv.push([x.en, acc]);
    series.push({ label: 'Advances paid', color: 'var(--ink-2)', pts: adv, end: v => kc(v) });
  }
  series.push({ label: 'Cost', color: U[u].c, pts: costPts, area: true });
  series.push({ label: 'Cost (forecast)', color: U[u].c, pts: fcPts, dash: '5 4', end: v => kc(v) });
  const extra = x.hasAdv ? t => { let paid = 0; x.sched.forEach(p => { if (p.t <= t) paid += p.a; }); return [['Balance', skc(paid - x.cost(x.s, t))]]; } : null;
  JOBS.push({ id: 'ch-bal-' + u, fn: el => lineChart(el, { key: 'bal-' + u, series, x0: x.s, x1: x.en, today: now, zero: true, yFmt: kfmt, tipFmt: v => kc(v), extra, height: 220, mr: 82, aria: `${U[u].label}: cumulative advances against cumulative cost over the billing year` }) });
  const lg = [{ c: U[u].c, label: 'Cost so far' }, { c: U[u].c, label: 'Forecast', dash: 1 }]; if (x.hasAdv) lg.unshift({ c: 'var(--ink-2)', label: 'Advances paid' });
  return `<section class="card"><div class="card-h"><h3>Running balance</h3>${legend(lg)}</div><div class="chart" id="ch-bal-${u}"></div><p class="small muted" style="margin:0">Billing year ${esc(fd(x.s))} – ${esc(fd(x.en - DAY))}. The gap between the lines at the right edge is the projected ${x.hasAdv ? (x.settlement >= 0 ? 'refund' : 'top-up') : 'cost'}.</p></section>`;
}
function monthlyUseCard(u, x, now) {
  const raw = rawReadings(u); const first = rT(raw[0]);
  const lastT = rT(raw[raw.length - 1]);
  let a = monthStart(Math.max(first, x.s - 92 * DAY)); const endM = monthStart(x.en - DAY);
  const cats = [];
  for (; a <= endM && cats.length < 16; a = addMonths(a, 1, 1)) {
    const b = addMonths(a, 1, 1);
    const s0 = Math.max(a, first);
    const act = lastT > s0 ? x.e.units(s0, Math.min(b, lastT)) : 0;
    const fcv = b > lastT ? x.e.units(Math.max(a, lastT, first), b) : 0;
    cats.push({ label: fd(a, { day: undefined }) + (a <= lastT && b > lastT ? ' (readings + forecast)' : ''), short: mlabel(a), segs: [{ label: U[u].label, color: U[u].c, v: Math.max(0, act), fc: false, always: true }, { label: U[u].label, color: U[u].c, v: Math.max(0, fcv), fc: true }] });
  }
  const dec = u === 'elec' ? 0 : 1;
  JOBS.push({ id: 'ch-use-' + u, fn: el => barChart(el, { key: 'use-' + u, cats, yFmt: v => nfmt(v), vFmt: v => nfmt(v, dec) + ' ' + U[u].unit, height: 190, aria: `${U[u].label} use per month` }) });
  return `<section class="card"><div class="card-h"><h3>Monthly use</h3>${legend([{ c: U[u].c, label: 'From readings', sq: 1 }, { c: U[u].c, label: 'Forecast', sq: 1, fc: 1 }])}</div><div class="chart" id="ch-use-${u}"></div><p class="small muted" style="margin:0">Months between readings are split in proportion to the days.${u === 'gas' ? ' Forecast months follow the heating curve, scaled to your readings.' : ''}</p></section>`;
}
function leakCard(u) {
  const rs = rawReadings(u).filter(r => r.time);
  let found = null;
  for (let i = rs.length - 1; i > 0; i--) { const a = rs[i - 1], b = rs[i]; if ((a.meter || 'main') !== (b.meter || 'main')) continue; const h = (rT(b) - rT(a)) / 3600000; if (h > .15 && h < 24) { found = { a, b, h, flow: (+b.value - +a.value) / h }; break; } }
  const how = 'Take a reading, run nothing that uses ' + (u === 'gas' ? 'gas (no hot water, heating off)' : 'water') + ' for a few hours, then take another. Overnight works well. Both readings need a time.';
  if (!found) return `<section class="card"><h3>Leak test</h3><p class="small" style="margin:0;color:var(--ink-2)">${how}</p></section>`;
  const per = U[u].unit + '/h';
  const ok = found.flow <= (u === 'gas' ? 0.002 : 0.001);
  return `<section class="card"><div class="card-h"><h3>Leak test</h3><span class="chip ${ok ? 'ok' : 'warn'}">${ok ? '✓ No flow' : '! Flow while idle'}</span></div><p style="margin:0">Last test: <b>${nfmt(found.flow, 4)} ${per}</b> over ${nfmt(found.h, 1)} hours (${esc(fdShort(rT(found.a)))} ${esc(found.a.time)} → ${esc(found.b.time)}). ${ok ? 'Nothing was flowing.' : 'Something used ' + (u === 'gas' ? 'gas' : 'water') + ' while it should have been idle. If nothing was on, repeat the test; a steady flow means a leak' + (u === 'gas' ? ' (gas emergency line 1239).' : ', often a running toilet.')}</p><p class="small muted" style="margin:0">${how}</p></section>`;
}
function recentCard(u, now) {
  const list = withDeltas(rawReadings(u)).reverse().slice(0, 5);
  return `<section class="card"><div class="card-h"><h3>Recent readings</h3><button class="btn sm ghost" data-act="log" data-u="${u}">All readings</button></div><div class="rows">${list.map(d => readingRow(d, now)).join('')}</div></section>`;
}
function tariffFoot(u, x) {
  const c = S.cfg;
  if (u === 'gas') { const b = c.gas.bands[x.tf.band]; return `<p class="foot">Gas: ${nfmt(x.tf.v, 2)} Kč/kWh all-in (ČEZ ${nfmt(c.gas.supplierPerKWh, 2)} + GasNet ${nfmt(b.distPerKWh, 2)}, band ${bandLabel(x.tf.band)}) plus ${kc2(x.tf.f)} a month. 1 m³ = ${nfmt(c.gas.kwhPerM3, 2)} kWh. GasNet rates reset each January; update them in Settings.</p>`; }
  if (u === 'elec') { const dm = +c.elec.distMonthly; const br = Math.abs(dm - 165.61) < .5 ? ', assuming a 3×25 A breaker' : Math.abs(dm - 76.07) < .5 ? ', 1×25 A breaker' : ''; return `<p class="foot">Electricity: ${nfmt(x.tf.v, 2)} Kč/kWh (ČEZ ${nfmt(c.elec.supplierPerKWh, 2)} + distribution ${nfmt(c.elec.distPerKWh, 2)}: ČEZ Distribuce D01d 2026, system services and electricity tax; the renewables fee is state-paid in 2026) plus ${kc2(x.tf.f)} a month (ČEZ ${kc2(c.elec.supplierMonthly)}, breaker and OTE ${kc2(dm)}${br}).</p>`; }
  return `<p class="foot">Water: ${nfmt(c.water.pricePerM3, 2)} Kč/m³ (OVAK 2026, water and sewage incl. VAT). Your landlord bills it through the service charges, so the advance and settlement dates are theirs; set both in Settings.</p>`;
}
function readingRow(d, now) {
  const r = d.r, u = r.utility;
  const th = r.photo && r.photo.id ? `<img class="thumb" data-photo="${esc(r.photo.id)}" alt="">` : `<span class="thumb">${ICON.camera}</span>`;
  let sub = `${fd(rT(r))}${r.time ? ' · ' + r.time : ''}`;
  if (d.prev && d.dt > 0) sub += ` · ${d.dv >= 0 ? '+' : '−'}${valFmt(u, Math.abs(d.dv))} ${U[u].unit} in ${nfmt(d.dt, d.dt < 2 ? 1 : 0)} days`;
  const multi = (S.cfg[u].meters || []).length > 1 ? ` <span class="chip">${esc(meterName(u, r.meter))}</span>` : '';
  const src = r.source && r.source !== 'own' ? ` <span class="chip">${esc(SOURCES[r.source] || r.source)}</span>` : '';
  const neg = d.prev && d.dv < 0 && !r.replaced && !['gasnet', 'estimate'].includes(r.source) ? ' <span class="chip bad">✕ lower than before</span>' : '';
  return `<button class="row" type="button" data-act="reading" data-id="${esc(r.id)}">${th}<span class="row-main"><span class="row-v"><span style="color:${U[u].c}">●</span>${esc(valFmt(u, +r.value))} ${U[u].unit}${multi}${src}${neg}</span><span class="row-s">${esc(sub)}</span></span><span class="chev" aria-hidden="true">›</span></button>`;
}

/* ---------- log ---------- */
function vLog(now) {
  const f = S.logFilter;
  const all = withDeltas(S.readings.filter(r => r.date && isFinite(+r.value)).sort((a, b) => rT(a) - rT(b))).filter(d => f === 'all' || d.r.utility === f).reverse();
  const withPhoto = all.filter(d => d.r.photo && d.r.photo.id);
  const chips = [['all', 'All'], ['gas', 'Gas'], ['elec', 'Electricity'], ['water', 'Water']].map(([k, l]) => `<button class="tab" type="button" data-act="logf" data-f="${k}" aria-pressed="${f === k}" ${f === k ? 'aria-selected="true"' : ''}>${l}</button>`).join('');
  const views = `<button class="btn sm${S.logView === 'list' ? ' primary' : ''}" data-act="logv" data-v="list">List</button><button class="btn sm${S.logView === 'photos' ? ' primary' : ''}" data-act="logv" data-v="photos">Photos (${withPhoto.length})</button>`;
  let body;
  if (!all.length) body = `<div class="empty"><h3>No readings here yet</h3><button class="btn primary" data-act="add" data-u="${f === 'all' ? 'gas' : f}">Add a reading</button></div>`;
  else if (S.logView === 'photos') body = withPhoto.length ? `<div class="pgrid">${withPhoto.map(d => `<button class="pcell" data-act="reading" data-id="${esc(d.r.id)}"><img data-photo="${esc(d.r.photo.id)}" alt="${esc(U[d.r.utility].label)} meter photo, ${esc(fd(rT(d.r)))}"><span>${esc(U[d.r.utility].label)} · ${esc(fdShort(rT(d.r)))}<br><b>${esc(valFmt(d.r.utility, +d.r.value))} ${U[d.r.utility].unit}</b></span></button>`).join('')}</div>` : `<p class="muted">No photos yet. Readings you add with a photo collect here as evidence.</p>`;
  else body = `<div class="card" style="padding:4px 12px"><div class="rows">${all.map(d => readingRow(d, now)).join('')}</div></div>`;
  return `<section class="sec"><h2 class="ptitle">Readings</h2><p class="lede">Every reading with its photo and the photo's own timestamp, so you can show what the meter said and when.</p></section>
    <section class="sec"><div class="fbar">${chips}<span class="sp"></span>${views}</div>${body}</section>`;
}

/* ---------- bills ---------- */
function checkBill(b, now) {
  const u = b.utility; if (!U[u]) return [];
  const x = summarize(S.cfg, S.readings, u, now); if (!x.e.hasData) return [];
  const a = pd(b.from), z = pd(b.to) + DAY - 60000;
  const set = x.e.ms[0].set; const near = t => Math.min(...set.map(r => Math.abs(r.t - t))) / DAY;
  const cov = Math.max(near(a), near(z));
  const est = cov > 10 ? ' <span class="chip warn">estimated</span>' : '';
  const out = [];
  const pct = (bv, yv) => yv ? (bv - yv) / yv * 100 : 0;
  if (isFinite(b.endReading) && b.endReading !== null && x.e.ms.length === 1) {
    const yv = valueAt(set, x.e.ms[0].rate, z); const d = b.endReading - yv;
    const ok = Math.abs(d) <= (u === 'elec' ? 10 : 1.5);
    out.push({ label: 'End reading', bill: valFmt(u, b.endReading) + ' ' + U[u].unit, yours: valFmt(u, yv) + ' ' + U[u].unit + (near(z) > 10 ? est : ''), st: ok ? 'ok' : 'warn', note: ok ? 'Matches' : `${d > 0 ? '+' : '−'}${valFmt(u, Math.abs(d))} ${U[u].unit}` });
  }
  const yu = x.e.units(a, z);
  if (isFinite(b.units) && b.units !== null) { const p = pct(b.units, yu); const ok = Math.abs(p) <= 5; out.push({ label: 'Usage', bill: nfmt(b.units, 1) + ' ' + U[u].unit, yours: nfmt(yu, 1) + ' ' + U[u].unit + est, st: ok ? 'ok' : 'warn', note: ok ? 'Within 5%' : `${p > 0 ? '+' : '−'}${nfmt(Math.abs(p), 0)}% vs yours` }); }
  if (u === 'gas' && isFinite(b.kwh) && b.kwh !== null && isFinite(b.units) && b.units) { const f = b.kwh / b.units; out.push({ label: 'kWh per m³', bill: nfmt(f, 3), yours: nfmt(S.cfg.gas.kwhPerM3, 2), st: Math.abs(f - S.cfg.gas.kwhPerM3) < .25 ? 'ok' : 'warn', note: 'Update Settings if different' }); }
  if (isFinite(b.cost) && b.cost !== null) {
    const yc = x.tf.v * (u === 'gas' ? yu * S.cfg.gas.kwhPerM3 : yu) + x.tf.f * (z - a) / DAY / MD;
    const p = pct(b.cost, yc); const ok = Math.abs(p) <= 5;
    out.push({ label: 'Cost', bill: kc2(b.cost), yours: kc(yc) + est, st: ok ? 'ok' : 'warn', note: ok ? 'Within 5%' : `${p > 0 ? '+' : '−'}${nfmt(Math.abs(p), 0)}% vs your tariff` });
    const months = (z - a) / DAY / MD; const impl = (b.cost - x.tf.f * months) / x.tf.v;
    const implU = u === 'gas' ? impl / S.cfg.gas.kwhPerM3 : impl;
    out.push({ label: 'Usage the cost implies', bill: nfmt(Math.max(0, implU), 1) + ' ' + U[u].unit, yours: nfmt(yu, 1) + ' ' + U[u].unit + est, st: 'info', note: 'At current tariffs' });
  }
  if ([b.advances, b.cost, b.balance].every(v => isFinite(v) && v !== null)) { const d = b.advances - b.cost - b.balance; out.push({ label: 'Arithmetic', bill: `${kc2(b.advances)} − ${kc2(b.cost)}`, yours: kc2(b.balance), st: Math.abs(d) < 1 ? 'ok' : 'bad', note: Math.abs(d) < 1 ? 'Adds up' : `Off by ${kc2(d)}` }); }
  return out;
}
function vBills(now) {
  const bills = [...S.bills].sort((a, b) => pd(b.to) - pd(a.to) || (a.utility > b.utility ? 1 : -1));
  const cards = bills.map(b => {
    const rows = checkBill(b, now);
    const bal = isFinite(b.balance) && b.balance !== null ? b.balance : (isFinite(b.advances) && isFinite(b.cost) && b.advances !== null && b.cost !== null ? b.advances - b.cost : null);
    const chip = bal == null ? '' : `<span class="chip ${bal >= 0 ? 'ok' : 'bad'}">${bal >= 0 ? '▲ Refund ' : '▼ Top-up '}${esc(kc2(Math.abs(bal)))}</span>`;
    const att = b.file && b.file.id ? (/^image\//.test(b.file.type || '') ? `<button class="thumb-btn" type="button" data-act="open-file" data-id="${esc(b.file.id)}" data-name="${esc(U[b.utility].label)} bill" aria-label="Open the bill attachment"><img class="thumb" data-photo="${esc(b.file.id)}" alt=""></button>` : `<button class="btn sm" type="button" data-act="open-file" data-id="${esc(b.file.id)}" data-name="${esc(U[b.utility].label)} bill">${ICON.doc}Open ${esc(b.file.name || 'attachment')}</button>`) : '';
    return `<article class="card"><div class="card-h"><div style="display:flex;flex-direction:column;gap:4px"><span class="uhead"><span class="uico" style="--c:${U[b.utility].c};--wash:${U[b.utility].wash}">${ICON[b.utility]}</span><h3>${U[b.utility].label} bill</h3></span><span class="small muted">${esc(fd(pd(b.from)))} – ${esc(fd(pd(b.to)))}${b.issued ? ' · issued ' + esc(fd(pd(b.issued))) : ''}</span></div>${chip}</div>
      ${rows.length ? `<div class="tblw"><table class="tbl"><thead><tr><th>Check</th><th>Bill</th><th>Your readings</th><th>Result</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(r.bill)}</td><td>${r.yours}</td><td>${r.st === 'info' ? `<span class="muted small">${esc(r.note)}</span>` : `<span class="chip ${r.st}">${r.st === 'ok' ? '✓' : r.st === 'bad' ? '✕' : '!'} ${esc(r.note)}</span>`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small" style="margin:0">Add readings or bill figures to check this bill.</p>'}
      ${b.note ? `<p class="small" style="margin:0;color:var(--ink-2)">${esc(b.note)}</p>` : ''}
      <div class="btnrow">${att}<span style="flex:1"></span><button class="btn sm" data-act="bill" data-id="${esc(b.id)}">Edit</button></div></article>`;
  }).join('');
  return `<section class="sec"><div class="card-h"><h2 class="ptitle">Bills</h2><button class="btn primary" data-act="bill-add">Add a bill</button></div><p class="lede">Enter the figures from each vyúčtování. They're checked against your own readings and tariffs: end reading, usage, kWh conversion, cost and whether the balance adds up.</p></section>
    <section class="sec">${cards || `<div class="empty"><h3>No bills yet</h3><p class="lede">Add the first reconciliation bill to check it against your readings.</p><button class="btn primary" data-act="bill-add">Add a bill</button></div>`}</section>`;
}

/* ---------- settings ---------- */
const FIELDS = {
  billing: [['period.start', 'ČEZ billing year starts', 'date'], ['period.end', 'ČEZ billing year ends', 'date'], ['budgetMonthly', 'Utilities budget (Kč/month)']],
  gas: [['gas.kwhPerM3', 'kWh per m³'], ['gas.supplierPerKWh', 'ČEZ price (Kč/kWh)'], ['gas.supplierMonthly', 'ČEZ standing charge if a band has none (Kč/month)'], ['gas.baseKWhMonth', 'Hot water and cooking (kWh/month)'], ['gas.heatingPriorKWh', 'Heating, central estimate (kWh/year)'], ['gas.lowKWh', 'Heating, mild year (kWh/year)'], ['gas.coldKWh', 'Heating, cold year (kWh/year)'], ['gas.eic', 'Supply point EIC', 'text'], ['gas.meters.0.serial', 'Meter number', 'text']],
  elec: [['elec.supplierPerKWh', 'ČEZ price (Kč/kWh)'], ['elec.supplierMonthly', 'ČEZ standing charge (Kč/month)'], ['elec.distPerKWh', 'Distribution etc. (Kč/kWh)'], ['elec.distMonthly', 'Breaker + OTE (Kč/month)'], ['elec.fallbackPerDay', 'Starting estimate (kWh/day)'], ['elec.meters.0.serial', 'Meter number', 'text']],
  water: [['water.pricePerM3', 'Water + sewage (Kč/m³)'], ['water.monthlyFixed', 'Fixed charge (Kč/month)'], ['water.fallbackPerDay', 'Starting estimate (m³/day)'], ['water.period.start', 'Landlord year starts (blank = ČEZ year)', 'date'], ['water.period.end', 'Landlord year ends', 'date']]
};
const getP = (o, p) => p.split('.').reduce((a, k) => a == null ? a : a[k], o);
const setP = (o, p, v) => { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach(k => { if (a[k] == null) a[k] = {}; a = a[k]; }); a[ks[ks.length - 1]] = v; };
function fieldHTML([p, label, type]) { const v = getP(S.draft, p); return `<label class="fld"><span>${esc(label)}</span><input class="in" id="f-${p.replace(/\./g, '-')}" data-path="${p}" data-type="${type || 'num'}" ${type === 'date' ? 'type="date"' : type === 'text' ? 'type="text"' : 'type="text" inputmode="decimal"'} value="${esc(v ?? '')}"></label>`; }
function vSettings() {
  if (!S.draft) { S.draft = clone(S.cfg); S.draftDirty = false; }
  const d = S.draft;
  const advBlock = u => `<fieldset class="card"><div class="card-h"><h3>${U[u].label} advances</h3><span class="aside">${u === 'water' ? 'from your landlord' : 'set in Můj ČEZ'}</span></div>
    ${(d[u].advances || []).map((a, i) => `<div class="arow"><label class="fld"><span>From</span><input class="in" type="date" id="adv-${u}-${i}-from" data-adv="${u}" data-i="${i}" data-k="from" value="${esc(a.from)}"></label><label class="fld"><span>Kč a month</span><input class="in" type="text" inputmode="decimal" id="adv-${u}-${i}-amount" data-adv="${u}" data-i="${i}" data-k="amount" value="${esc(a.amount)}"></label><button class="btn sm ghost danger" type="button" data-act="adv-del" data-u="${u}" data-i="${i}" aria-label="Remove">✕</button></div>`).join('') || '<p class="muted small" style="margin:0">No advance set.</p>'}
    <div class="arow"><label class="fld"><span>Last payment</span><input class="in" type="date" id="f-${u}-lastAdvance" data-path="${u}.lastAdvance" data-type="date" value="${esc(d[u].lastAdvance || '')}"></label><span></span><button class="btn sm" type="button" data-act="adv-add" data-u="${u}">Add a change</button></div>
    <p class="hint" style="margin:0">Payments repeat monthly on the day of the first date. To change the amount from a given month, add a row with that date.</p></fieldset>`;
  const bands = d.gas.bands.map((b, i) => `<div class="fgrid"><label class="fld"><span>Band ${i + 1} up to (kWh/yr)</span><input class="in" type="text" inputmode="decimal" id="band-${i}-up" data-path="gas.bands.${i}.upToKWh" data-type="num" value="${b.upToKWh}"></label><label class="fld"><span>ČEZ (Kč/month)</span><input class="in" type="text" inputmode="decimal" id="band-${i}-s" data-path="gas.bands.${i}.supplierMonthly" data-type="num" value="${b.supplierMonthly ?? ''}"></label><label class="fld"><span>GasNet (Kč/kWh)</span><input class="in" type="text" inputmode="decimal" id="band-${i}-v" data-path="gas.bands.${i}.distPerKWh" data-type="num" value="${b.distPerKWh}"></label><label class="fld"><span>GasNet (Kč/month)</span><input class="in" type="text" inputmode="decimal" id="band-${i}-f" data-path="gas.bands.${i}.distMonthly" data-type="num" value="${b.distMonthly}"></label></div>`).join('');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hs = d.gas.heatSplit.map((v, i) => `<label>${mon[i]}<input class="in" type="text" inputmode="decimal" id="hs-${i}" data-path="gas.heatSplit.${i}" data-type="num" value="${v}"></label>`).join('');
  const meters = (d.water.meters || []).map((m, i) => `<div class="arow"><label class="fld"><span>Meter name</span><input class="in" type="text" id="wm-${i}-name" data-path="water.meters.${i}.name" data-type="text" value="${esc(m.name)}"></label><label class="fld"><span>Number</span><input class="in" type="text" id="wm-${i}-serial" data-path="water.meters.${i}.serial" data-type="text" value="${esc(m.serial || '')}"></label>${d.water.meters.length > 1 ? `<button class="btn sm ghost danger" type="button" data-act="wm-del" data-i="${i}" aria-label="Remove meter">✕</button>` : '<span></span>'}</div>`).join('');
  return `<section class="sec"><div class="card-h"><h2 class="ptitle">Settings</h2><div class="btnrow"><button class="btn" data-act="set-reset" type="button">Discard changes</button><button class="btn primary" data-act="set-save" type="button">Save settings</button></div></div><p class="lede">Prices include VAT. Change them when a bill shows different figures or when the distribution rates reset in January.</p></section>
  <form id="settings-form" class="sec" style="gap:14px" onsubmit="return false">
    <fieldset class="card"><h3>Billing</h3><div class="fgrid">${FIELDS.billing.map(fieldHTML).join('')}</div></fieldset>
    ${advBlock('gas')}${advBlock('elec')}${advBlock('water')}
    <fieldset class="card"><h3>Gas</h3><div class="fgrid">${FIELDS.gas.map(fieldHTML).join('')}</div>
      <label class="fld"><span>GasNet distribution band</span><select class="in" id="f-gas-bandMode" data-path="gas.bandMode" data-type="text"><option value="auto"${d.gas.bandMode === 'auto' ? ' selected' : ''}>Pick from forecast use</option>${d.gas.bands.map((b, i) => `<option value="${i}"${String(d.gas.bandMode) === String(i) ? ' selected' : ''}>Band ${i + 1}: up to ${nfmt(b.upToKWh / 1000, 2)} MWh</option>`).join('')}</select></label>
      <details class="more"><summary>GasNet band rates (2026)</summary><div class="sec" style="margin-top:10px">${bands}</div></details>
      <details class="more"><summary>Heating split by month (% of the year)</summary><div class="hs" style="margin-top:10px">${hs}</div><p class="hint">Should add up to 100. Now ${nfmt(d.gas.heatSplit.reduce((a, b) => a + (+b || 0), 0))}.</p></details></fieldset>
    <fieldset class="card"><h3>Electricity</h3><div class="fgrid">${FIELDS.elec.map(fieldHTML).join('')}</div><p class="hint" style="margin:0">Breaker charge: 3×25 A is 150.04 Kč/month, 1×25 A is 60.50 Kč/month (ČEZ Distribuce 2026, incl. VAT). Add 15.57 Kč/month for OTE. Your bill shows which you have.</p></fieldset>
    <fieldset class="card"><h3>Water</h3><div class="fgrid">${FIELDS.water.map(fieldHTML).join('')}</div><div class="sec" style="gap:8px">${meters}<div><button class="btn sm" type="button" data-act="wm-add">Add a water meter</button></div></div></fieldset>
    <div class="btnrow"><button class="btn" data-act="set-reset" type="button">Discard changes</button><button class="btn primary" data-act="set-save" type="button">Save settings</button></div>
  </form>` + appSettingsHTML();
}
function readSettingsForm() {
  const d = S.draft;
  main.querySelectorAll('[data-path]').forEach(el => { const t = el.dataset.type; let v = el.value; if (t === 'num') { v = parseNum(v); if (!isFinite(v)) v = getP(d, el.dataset.path); } setP(d, el.dataset.path, v); });
  main.querySelectorAll('[data-adv]').forEach(el => { const a = d[el.dataset.adv].advances[+el.dataset.i]; if (!a) return; a[el.dataset.k] = el.dataset.k === 'amount' ? (isFinite(parseNum(el.value)) ? parseNum(el.value) : 0) : el.value; });
}

/* ================= sheets ================= */
const sheet = $('#sheet'), sheetBody = $('#sheet-body');
let sheetCleanup = null, lastFocus = null;
function openSheet(html, onMount) {
  lastFocus = document.activeElement;
  sheetBody.innerHTML = html; sheet.hidden = false; document.body.style.overflow = 'hidden';
  if (sheetCleanup) sheetCleanup(); sheetCleanup = onMount ? onMount(sheetBody) : null;
  const f = sheetBody.querySelector('[autofocus]') || sheetBody.querySelector('h2'); if (f) { f.setAttribute('tabindex', f.getAttribute('tabindex') || '-1'); f.focus({ preventScroll: true }); }
}
function closeSheet() { sheet.hidden = true; sheetBody.innerHTML = ''; document.body.style.overflow = ''; if (sheetCleanup) { sheetCleanup(); sheetCleanup = null; } if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true }); }
sheet.addEventListener('click', e => { if (e.target.dataset.close) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600); }

/* ---------- photo metadata ---------- */
function parseExif(buf) {
  const dv = new DataView(buf), n = dv.byteLength; let tiff = -1;
  const isTiff = o => o >= 0 && o + 8 <= n && ((dv.getUint16(o) === 0x4949 && dv.getUint16(o + 2, true) === 42) || (dv.getUint16(o) === 0x4D4D && dv.getUint16(o + 2, false) === 42));
  if (n > 4 && dv.getUint16(0) === 0xFFD8) {
    let o = 2;
    while (o + 4 < n) { const mk = dv.getUint16(o); if ((mk & 0xFF00) !== 0xFF00 || mk === 0xFFDA || mk === 0xFFD9) break; const len = dv.getUint16(o + 2); if (mk === 0xFFE1 && o + 10 < n && dv.getUint32(o + 4) === 0x45786966 && isTiff(o + 10)) { tiff = o + 10; break; } o += 2 + len; }
  }
  if (tiff < 0) { const lim = Math.min(n - 12, 8 * 1048576); for (let i = 0; i < lim; i++) { if (dv.getUint8(i) === 0x45 && dv.getUint32(i) === 0x45786966 && dv.getUint16(i + 4) === 0 && isTiff(i + 6)) { tiff = i + 6; break; } } }
  if (tiff < 0) return null;
  const le = dv.getUint16(tiff) === 0x4949;
  const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le), s32 = o => dv.getInt32(o, le);
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const readVal = (type, c, o) => {
    if (type === 2) { let s = ''; for (let i = 0; i < c && i < 256; i++) { const ch = dv.getUint8(o + i); if (!ch) break; s += String.fromCharCode(ch); } return s.trim(); }
    const arr = []; for (let i = 0; i < Math.min(c, 8); i++) { if (type === 3) arr.push(u16(o + i * 2)); else if (type === 4) arr.push(u32(o + i * 4)); else if (type === 9) arr.push(s32(o + i * 4)); else if (type === 5) arr.push(u32(o + i * 8) / (u32(o + i * 8 + 4) || 1)); else if (type === 10) arr.push(s32(o + i * 8) / (s32(o + i * 8 + 4) || 1)); else arr.push(dv.getUint8(o + i)); }
    return c === 1 ? arr[0] : arr;
  };
  const ifd = off => { const out = {}; const p = tiff + off; if (!off || p + 2 > n) return out; const cnt = u16(p); for (let k = 0; k < cnt && k < 400; k++) { const e = p + 2 + k * 12; if (e + 12 > n) break; const tag = u16(e), type = u16(e + 2), c = u32(e + 4); const sz = (SZ[type] || 1) * c; const vo = sz > 4 ? tiff + u32(e + 8) : e + 8; if (vo + Math.min(sz, 2048) > n) continue; try { out[tag] = readVal(type, c, vo); } catch (er) { } } return out; };
  const i0 = ifd(u32(tiff + 4)); const ex = typeof i0[0x8769] === 'number' ? ifd(i0[0x8769]) : {}; const gp = typeof i0[0x8825] === 'number' ? ifd(i0[0x8825]) : {};
  const dms = a => Array.isArray(a) && a.length >= 3 ? a[0] + a[1] / 60 + a[2] / 3600 : null;
  let lat = dms(gp[2]), lon = dms(gp[4]); if (lat != null && gp[1] === 'S') lat = -lat; if (lon != null && gp[3] === 'W') lon = -lon;
  const taken = ex[0x9003] || ex[0x9004] || i0[0x0132] || null;
  return { taken, takenKind: ex[0x9003] ? 'original' : ex[0x9004] ? 'digitized' : i0[0x0132] ? 'modified' : null, offset: ex[0x9011] || ex[0x9010] || null, make: i0[0x010F] || null, model: i0[0x0110] || null, software: i0[0x0131] || null, lens: ex[0xA434] || null, w: ex[0xA002] || null, h: ex[0xA003] || null, orient: i0[0x0112] || null, lat, lon, alt: typeof gp[6] === 'number' ? Math.round(gp[6]) : null };
}
function exifDate(s) { const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/.exec(s || ''); return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` } : null; }
async function readPhoto(file) {
  const buf = await file.arrayBuffer();
  const meta = { name: file.name || 'photo', bytes: file.size, type: file.type || '', fileModified: file.lastModified ? new Date(file.lastModified).toISOString() : null };
  try { const h = await crypto.subtle.digest('SHA-256', buf); meta.sha256 = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''); } catch (e) { meta.sha256 = null; }
  try { meta.exif = parseExif(buf); } catch (e) { meta.exif = null; }
  const ed = meta.exif && exifDate(meta.exif.taken);
  if (ed) { meta.stamp = ed; meta.stampFrom = 'camera'; }
  else if (file.lastModified) { const d = new Date(file.lastModified); meta.stamp = { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }; meta.stampFrom = 'file'; }
  return meta;
}
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
async function toJpeg(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) {
    bmp = await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
  }
  const scale = Math.min(1, 4032 / Math.max(bmp.width, bmp.height)); const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('convert')), 'image/jpeg', .9));
}
async function storeFile(file) {
  let blob = file, converted = false;
  if (!OK_TYPES.includes(file.type) || (file.type !== 'application/pdf' && file.size > 8 * 1048576)) { blob = await toJpeg(file); converted = true; }
  if (blob.size > 20 * 1048576) throw { code: 'too_large' };
  const type = converted ? 'image/jpeg' : file.type;
  const id = await putFile(await blob.arrayBuffer(), type);
  return { id, type, storedBytes: blob.size, converted };
}
function assetError(e) {
  const c = e && (e.code || e.name);
  return c === 'QuotaExceededError' ? 'This device is out of storage for photos.' : c === 'too_large' ? 'That file is over 20 MB.' : c === 'unsupported_type' ? 'That file type can’t be stored. Use a JPEG or PNG photo.' : c === 'quota_or_state' ? 'Photo storage is full. Delete some old photos first.' : c === 'rate_limited' ? 'Too many uploads at once. Wait a moment and try again.' : 'The photo couldn’t be saved. Try again.';
}
function metaListHTML(meta) {
  const ex = meta.exif || {};
  const rows = [];
  if (meta.stamp) rows.push(['Taken', `${fd(pd(meta.stamp.date))} at ${meta.stamp.time}${meta.stampFrom === 'camera' ? (ex.offset ? ' (UTC' + ex.offset + ')' : '') + ' · camera clock' : ' · file date, no camera timestamp'}`]);
  if (ex.make || ex.model) rows.push(['Camera', [ex.make, ex.model].filter(Boolean).join(' ')]);
  if (ex.lat != null) rows.push(['Location', `${ex.lat.toFixed(5)}, ${ex.lon.toFixed(5)}`]);
  rows.push(['File', `${meta.name} · ${fmtBytes(meta.bytes)}`]);
  if (meta.sha256) rows.push(['SHA-256', meta.sha256.slice(0, 16) + '…']);
  return `<div class="meta">${rows.map(r => `<div><span class="k">${esc(r[0])}</span><span class="v">${esc(r[1])}</span></div>`).join('')}</div>`;
}

/* ---------- reading sheet ---------- */
function openReadingSheet(util, edit) {
  const R = { util: edit ? edit.utility : (util || 'gas'), meter: edit ? (edit.meter || 'main') : null, file: null, meta: null, url: null, dateTouched: !!edit, saving: false };
  if (!R.meter) R.meter = (S.cfg[R.util].meters[0] || { id: 'main' }).id;
  const d0 = new Date(); const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  const segs = UTILS.map(u => `<input type="radio" name="r-util" id="ru-${u}" value="${u}"${R.util === u ? ' checked' : ''}${edit ? ' disabled' : ''}><label for="ru-${u}" style="--c:${U[u].c}">${ICON[u]}${U[u].label}</label>`).join('');
  const html = `<div class="sheet-h"><h2 id="sheet-title">${edit ? 'Edit reading' : 'Add a reading'}</h2><button class="x" type="button" data-close="1" aria-label="Close">✕</button></div>
  <form id="rf" class="sec" style="gap:14px" novalidate>
    <div class="seg" role="radiogroup" aria-label="Utility">${segs}</div>
    <div id="r-meter-wrap"></div>
    <div id="r-photo"></div>
    <div class="fgrid"><label class="fld"><span>Date</span><input class="in" type="date" id="r-date" value="${esc(edit ? edit.date : today)}" required></label><label class="fld"><span>Time</span><input class="in" type="time" id="r-time" value="${esc(edit ? (edit.time || '') : '')}"></label></div>
    <label class="fld"><span>Reading</span><span class="unitbox"><input class="in big" id="r-value" inputmode="decimal" autocomplete="off" placeholder="${R.util === 'elec' ? '374' : '1602.345'}" value="${esc(edit ? String(edit.value) : '')}" autofocus><em id="r-unit">${U[R.util].unit}</em></span><span class="hint" id="r-hint"></span></label>
    <div id="r-check"></div>
    <div class="fgrid"><label class="fld"><span>Source</span><select class="in" id="r-source">${Object.entries(SOURCES).map(([k, l]) => `<option value="${k}"${(edit ? edit.source : 'own') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="fld"><span>Note</span><input class="in" id="r-note" type="text" value="${esc(edit ? edit.note || '' : '')}" placeholder="Optional"></label></div>
    <label class="check" style="border:0;padding:0"><input type="checkbox" id="r-replaced"${edit && edit.replaced ? ' checked' : ''}><span>New or reset meter (starts a new count)</span></label>
    <div id="r-err"></div>
    <div class="btnrow"><button class="btn" type="button" data-close="1">Cancel</button><span style="flex:1"></span><button class="btn primary" type="submit" id="r-save">${edit ? 'Save changes' : 'Save reading'}</button></div>
  </form>`;
  openSheet(html, root => {
    const f = root.querySelector('#rf');
    const meterWrap = () => {
      const ms = S.cfg[R.util].meters || [];
      root.querySelector('#r-meter-wrap').innerHTML = ms.length > 1 ? `<label class="fld"><span>Meter</span><select class="in" id="r-meter">${ms.map(m => `<option value="${esc(m.id)}"${m.id === R.meter ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>` : '';
      const sel = root.querySelector('#r-meter'); if (sel) sel.addEventListener('change', () => { R.meter = sel.value; check(); });
      root.querySelector('#r-unit').textContent = U[R.util].unit;
      root.querySelector('#r-hint').textContent = R.util === 'gas' ? 'Main screen, all digits: black then red (Vtb m³). The display is cracked, so check the middle digits.' : R.util === 'water' ? 'Black digits are m³; red digits are litres (after the point).' : 'Whole kWh from the register.';
    };
    const photo = () => {
      const box = root.querySelector('#r-photo');
      const old = edit && edit.photo && edit.photo.id && !R.file;
      if (R.meta) {
        box.innerHTML = `<div class="pv">${R.url ? `<img src="${R.url}" alt="Selected meter photo" id="r-pv">` : '<span class="ph">No preview</span>'}<div class="sec" style="gap:8px">${metaListHTML(R.meta)}<label class="btn sm" style="width:max-content">Change photo<input type="file" accept="image/*" id="r-file" style="position:absolute;opacity:0;width:1px;height:1px"></label></div></div>`;
        const pv = box.querySelector('#r-pv'); if (pv) pv.addEventListener('error', () => { pv.replaceWith(Object.assign(document.createElement('span'), { className: 'ph', textContent: 'Preview not available. It will be converted to JPEG.' })); });
      } else if (old) {
        box.innerHTML = `<div class="pv"><img data-photo="${esc(edit.photo.id)}" alt="Stored meter photo"><div class="sec" style="gap:8px">${edit.photo.meta ? metaListHTML(edit.photo.meta) : ''}<label class="btn sm" style="width:max-content">Replace photo<input type="file" accept="image/*" id="r-file" style="position:absolute;opacity:0;width:1px;height:1px"></label></div></div>`;
      } else {
        box.innerHTML = `<label class="drop">${ICON.camera}<span><b>Add a photo of the meter</b><br><span class="small muted">The photo's own date and camera details are saved with the reading.</span></span><input type="file" accept="image/*" id="r-file"></label>`;
      }
      const fi = box.querySelector('#r-file'); if (fi) fi.addEventListener('change', onFile);
      hydratePhotos(box);
    };
    async function onFile(ev) {
      const file = ev.target.files && ev.target.files[0]; if (!file) return;
      R.file = file; if (R.url) URL.revokeObjectURL(R.url); R.url = URL.createObjectURL(file);
      R.meta = await readPhoto(file);
      if (R.meta.stamp && !R.dateTouched) { root.querySelector('#r-date').value = R.meta.stamp.date; root.querySelector('#r-time').value = R.meta.stamp.time; }
      photo(); check();
    }
    const check = () => {
      const out = root.querySelector('#r-check');
      const v = parseNum(root.querySelector('#r-value').value); const date = root.querySelector('#r-date').value; const time = root.querySelector('#r-time').value;
      const notes = [];
      const stamp = R.meta ? R.meta.stamp : (edit && edit.photo && edit.photo.meta ? edit.photo.meta.stamp : null);
      if (stamp && date && stamp.date !== date) notes.push(['warn', '!', `The photo was taken on ${fd(pd(stamp.date))}${R.meta && R.meta.stampFrom === 'file' ? ' (file date)' : ''}, not ${fd(pd(date))}.`]);
      if (isFinite(v) && date) {
        const t = rT({ date, time });
        const list = rawReadings(R.util, R.meter).filter(r => !edit || r.id !== edit.id);
        const prev = [...list].reverse().find(r => rT(r) < t), next = list.find(r => rT(r) > t);
        const replaced = root.querySelector('#r-replaced').checked;
        const sum = summarize(S.cfg, S.readings, R.util, nowT());
        const xm = sum.e.ms.find(m => m.meter.id === R.meter) || sum.e.ms[0];
        if (prev) {
          const dt = (t - rT(prev)) / DAY, dv = v - +prev.value, unit = U[R.util].unit;
          const exp = dt > 0 && xm ? integrate(xm.rate, rT(prev), t) : null;
          const official = ['gasnet', 'estimate'].includes(prev.source);
          if (dv < -(official ? 1 : 0.0005) && !replaced) notes.push(['bad', '✕', `Lower than the ${fd(rT(prev))} reading (${valFmt(R.util, +prev.value)} ${unit}). Check the digits, or tick “New or reset meter”.`]);
          else if (exp != null && dt > .5 && exp > .05 && dv > Math.max(exp * 4, exp + (R.util === 'elec' ? 30 : 3))) notes.push(['warn', '!', `That's ${valFmt(R.util, dv)} ${unit} in ${nfmt(dt, 1)} days; about ${nfmt(exp, 1)} was expected. Double-check the middle digits.`]);
          else if (dt > 0) notes.push(['ok', '✓', `${dv >= 0 ? '+' : '−'}${valFmt(R.util, Math.abs(dv))} ${unit} since ${fd(rT(prev))} (${nfmt(dt, dt < 2 ? 1 : 0)} days, ${nfmt(dv / dt, R.util === 'elec' ? 1 : 3)} ${unit}/day).`]);
        }
        if (next && v > +next.value + 0.0005 && !['gasnet', 'estimate'].includes(next.source)) notes.push(['bad', '✕', `Higher than the later reading on ${fd(rT(next))} (${valFmt(R.util, +next.value)}).`]);
      }
      out.innerHTML = notes.map(n => `<div class="note ${n[0]}"><span class="ic">${n[1]}</span><span>${esc(n[2])}</span></div>`).join('');
      return !notes.some(n => n[0] === 'bad');
    };
    root.querySelectorAll('input[name="r-util"]').forEach(r => r.addEventListener('change', () => { R.util = r.value; R.meter = (S.cfg[R.util].meters[0] || { id: 'main' }).id; meterWrap(); check(); root.querySelector('#r-value').placeholder = R.util === 'elec' ? '374' : '1602.345'; }));
    root.querySelector('#r-value').addEventListener('input', check);
    root.querySelector('#r-date').addEventListener('input', () => { R.dateTouched = true; check(); });
    root.querySelector('#r-time').addEventListener('input', () => { R.dateTouched = true; check(); });
    root.querySelector('#r-replaced').addEventListener('change', check);
    meterWrap(); photo(); check();
    f.addEventListener('submit', async ev => {
      ev.preventDefault(); if (R.saving) return;
      const err = root.querySelector('#r-err'); err.innerHTML = '';
      const v = parseNum(root.querySelector('#r-value').value); const date = root.querySelector('#r-date').value;
      if (!isFinite(v) || v < 0) { err.innerHTML = '<div class="note bad"><span class="ic">✕</span><span>Type the number shown on the meter.</span></div>'; return; }
      if (!date) { err.innerHTML = '<div class="note bad"><span class="ic">✕</span><span>Pick the date of the reading.</span></div>'; return; }
      if (!check()) { err.innerHTML = '<div class="note bad"><span class="ic">✕</span><span>Fix the reading above before saving.</span></div>'; return; }
      R.saving = true; const btn = root.querySelector('#r-save'); btn.disabled = true; btn.textContent = R.file ? 'Uploading photo…' : 'Saving…';
      try {
        let photoRec = edit ? (edit.photo || null) : null; let oldAsset = null;
        if (R.file) {
          try { const st = await storeFile(R.file); oldAsset = photoRec && photoRec.id; photoRec = Object.assign({ id: st.id, type: st.type, storedBytes: st.storedBytes, converted: st.converted, uploadedAt: new Date().toISOString() }, { meta: R.meta }); }
          catch (e) { R.saving = false; btn.disabled = false; btn.textContent = edit ? 'Save changes' : 'Save reading'; err.innerHTML = `<div class="note bad"><span class="ic">✕</span><span>${esc(assetError(e))}</span></div>`; return; }
        }
        const doc = clean({ utility: R.util, meter: R.meter, date, time: root.querySelector('#r-time').value || '', value: v, source: root.querySelector('#r-source').value, note: root.querySelector('#r-note').value.trim(), replaced: root.querySelector('#r-replaced').checked, photo: photoRec, createdAt: edit ? (edit.createdAt || new Date().toISOString()) : new Date().toISOString(), updatedAt: new Date().toISOString() });
        await putRecord('readings', edit ? edit.id : null, doc);
        if (oldAsset) await deleteFile(oldAsset);
        closeSheet(); toast(edit ? 'Reading updated' : 'Reading saved');
      } catch (e) {
        R.saving = false; btn.disabled = false; btn.textContent = edit ? 'Save changes' : 'Save reading';
        err.innerHTML = `<div class="note bad"><span class="ic">✕</span><span>The reading couldn’t be saved on this device. Try again.</span></div>`;
      }
    });
    return () => { if (R.url) URL.revokeObjectURL(R.url); };
  });
}

/* ---------- reading detail ---------- */
function openReadingDetail(id) {
  const r = S.readings.find(x => x.id === id); if (!r) return;
  const u = r.utility, p = r.photo, meta = p && p.meta, ex = (meta && meta.exif) || {};
  const rows = [];
  rows.push(['Reading', `${valFmt(u, +r.value)} ${U[u].unit}`]);
  rows.push(['Logged for', `${fd(rT(r))}${r.time ? ' at ' + r.time : ''}`]);
  rows.push(['Source', SOURCES[r.source] || r.source || '—']);
  if ((S.cfg[u].meters || []).length > 1) rows.push(['Meter', meterName(u, r.meter)]);
  if (r.note) rows.push(['Note', r.note]);
  let dateCheck = '';
  if (meta && meta.stamp) {
    rows.push(['Photo taken', `${fd(pd(meta.stamp.date))} at ${meta.stamp.time}${meta.stampFrom === 'camera' ? (ex.offset ? ' (UTC' + ex.offset + ')' : '') + ', camera clock' : ', file date only'}`]);
    const same = meta.stamp.date === r.date;
    dateCheck = `<div class="note ${same ? 'ok' : 'warn'}"><span class="ic">${same ? '✓' : '!'}</span><span>${same ? 'The photo was taken on the same day as the reading.' : `The photo was taken on ${fd(pd(meta.stamp.date))}, the reading is logged for ${fd(rT(r))}.`}</span></div>`;
  }
  if (ex.make || ex.model) rows.push(['Camera', [ex.make, ex.model].filter(Boolean).join(' ') + (ex.lens ? ' · ' + ex.lens : '')]);
  if (ex.software) rows.push(['Software', ex.software]);
  if (ex.w && ex.h) rows.push(['Image', `${ex.w} × ${ex.h} px`]);
  if (ex.lat != null) rows.push(['Location', `${ex.lat.toFixed(5)}, ${ex.lon.toFixed(5)}${ex.alt != null ? ' · ' + ex.alt + ' m' : ''}`]);
  if (meta) rows.push(['Original file', `${meta.name} · ${fmtBytes(meta.bytes)}${meta.type ? ' · ' + meta.type : ''}`]);
  if (meta && meta.fileModified) rows.push(['File modified', new Date(meta.fileModified).toLocaleString('en-GB')]);
  if (p && p.uploadedAt) rows.push(['Uploaded', new Date(p.uploadedAt).toLocaleString('en-GB') + (p.converted ? ' · converted to JPEG' : '')]);
  const hash = meta && meta.sha256 ? `<div class="sec" style="gap:6px"><span class="kick">SHA-256 of the original file</span><div class="hash" id="hash">${esc(meta.sha256)}</div><div><button class="btn sm" type="button" id="copy-hash">Copy fingerprint</button></div><p class="hint" style="margin:0">Hash the original photo on your phone later and compare: matching fingerprints show the file hasn't changed.</p></div>` : '';
  const html = `<div class="sheet-h"><h2 id="sheet-title">${U[u].label} reading</h2><button class="x" type="button" data-close="1" aria-label="Close">✕</button></div>
    ${p && p.id ? `<button class="photo-btn" type="button" id="open-photo" aria-label="Open the full photo"><img class="bigphoto" data-photo="${esc(p.id)}" alt="${esc(U[u].label)} meter photo for ${esc(fd(rT(r)))}"></button>` : `<div class="note info"><span class="ic">i</span><span>No photo with this reading.</span></div>`}
    ${dateCheck}
    <dl class="mtable">${rows.map(x => `<dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd>`).join('')}</dl>
    ${hash}
    <div class="btnrow"><button class="btn danger" type="button" id="del">Delete</button><span style="flex:1"></span><button class="btn primary" type="button" id="edit">Edit</button></div>`;
  openSheet(html, root => {
    root.querySelector('#edit').addEventListener('click', () => { closeSheet(); openReadingSheet(u, r); });
    const del = root.querySelector('#del'); let armed = false, tm;
    del.addEventListener('click', async () => {
      if (!armed) { armed = true; del.textContent = 'Tap again to delete'; tm = setTimeout(() => { armed = false; del.textContent = 'Delete'; }, 4000); return; }
      clearTimeout(tm); del.disabled = true;
      try { await delRecord('readings', r.id); if (p && p.id && !S.readings.some(x => x.photo && x.photo.id === p.id)) await deleteFile(p.id); closeSheet(); toast('Reading deleted'); }
      catch (e) { del.disabled = false; del.textContent = 'Delete'; toast('Couldn’t delete. Try again.'); }
    });
    const cp = root.querySelector('#copy-hash');
    if (cp) cp.addEventListener('click', () => { const t = meta.sha256; const done = () => toast('Fingerprint copied'); try { navigator.clipboard.writeText(t).then(done, () => selectText(root.querySelector('#hash'))); } catch (e) { selectText(root.querySelector('#hash')); } });
    hydratePhotos(root);
    const op = root.querySelector('#open-photo'); if (op) op.addEventListener('click', () => openFile(p.id, `${U[u].label} meter ${r.date}`));
  });
}
function selectText(el) { if (!el) return; const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); toast('Selected. Copy it from the menu.'); }

/* ---------- bill sheet ---------- */
function openBillSheet(edit) {
  const b = edit || { utility: 'gas', from: '', to: '', issued: '' };
  const B = { file: null, meta: null, saving: false };
  const num = v => v == null || !isFinite(v) ? '' : String(v);
  const html = `<div class="sheet-h"><h2 id="sheet-title">${edit ? 'Edit bill' : 'Add a bill'}</h2><button class="x" type="button" data-close="1" aria-label="Close">✕</button></div>
  <form id="bf" class="sec" style="gap:14px" novalidate>
    <div class="seg" role="radiogroup" aria-label="Utility">${UTILS.map(u => `<input type="radio" name="b-util" id="bu-${u}" value="${u}"${b.utility === u ? ' checked' : ''}><label for="bu-${u}" style="--c:${U[u].c}">${ICON[u]}${U[u].label}</label>`).join('')}</div>
    <div class="fgrid"><label class="fld"><span>Period from</span><input class="in" type="date" id="b-from" value="${esc(b.from)}"></label><label class="fld"><span>Period to</span><input class="in" type="date" id="b-to" value="${esc(b.to)}"></label><label class="fld"><span>Issued</span><input class="in" type="date" id="b-issued" value="${esc(b.issued || '')}"></label></div>
    <div class="fgrid">
      <label class="fld"><span>End reading</span><input class="in" id="b-end" inputmode="decimal" value="${num(b.endReading)}"></label>
      <label class="fld"><span id="b-units-l">Usage billed (m³)</span><input class="in" id="b-units" inputmode="decimal" value="${num(b.units)}"></label>
      <label class="fld" id="b-kwh-w"><span>Gas billed (kWh)</span><input class="in" id="b-kwh" inputmode="decimal" value="${num(b.kwh)}"></label>
    </div>
    <div class="fgrid">
      <label class="fld"><span>Total cost (Kč incl. VAT)</span><input class="in" id="b-cost" inputmode="decimal" value="${num(b.cost)}"></label>
      <label class="fld"><span>Advances paid (Kč)</span><input class="in" id="b-adv" inputmode="decimal" value="${num(b.advances)}"></label>
      <label class="fld"><span>Balance (+ refund, − top-up)</span><input class="in" id="b-bal" inputmode="decimal" value="${num(b.balance)}"></label>
    </div>
    <label class="fld"><span>Note</span><input class="in" id="b-note" value="${esc(b.note || '')}" placeholder="Optional"></label>
    <div id="b-file-box"></div>
    <div id="b-err"></div>
    <div class="btnrow">${edit ? '<button class="btn danger" type="button" id="b-del">Delete</button>' : ''}<span style="flex:1"></span><button class="btn" type="button" data-close="1">Cancel</button><button class="btn primary" type="submit" id="b-save">Save bill</button></div>
  </form>`;
  openSheet(html, root => {
    const util = () => root.querySelector('input[name="b-util"]:checked').value;
    const sync = () => { const u = util(); root.querySelector('#b-units-l').textContent = `Usage billed (${U[u].unit})`; root.querySelector('#b-kwh-w').hidden = u !== 'gas'; };
    root.querySelectorAll('input[name="b-util"]').forEach(r => r.addEventListener('change', sync)); sync();
    const fileBox = () => { const box = root.querySelector('#b-file-box'); const has = B.file ? B.file.name : (b.file && b.file.id ? b.file.name || 'attachment' : null); box.innerHTML = `<label class="drop">${ICON.doc}<span><b>${has ? esc(has) : 'Attach the bill (photo or PDF)'}</b><br><span class="small muted">${has ? 'Tap to replace' : 'Optional, kept with the bill'}</span></span><input type="file" accept="image/*,application/pdf" id="b-file"></label>`; box.querySelector('#b-file').addEventListener('change', async ev => { const f = ev.target.files && ev.target.files[0]; if (!f) return; B.file = f; B.meta = await readPhoto(f); fileBox(); }); };
    fileBox();
    const del = root.querySelector('#b-del');
    if (del) { let armed = false; del.addEventListener('click', async () => { if (!armed) { armed = true; del.textContent = 'Tap again to delete'; setTimeout(() => { armed = false; del.textContent = 'Delete'; }, 4000); return; } try { await delRecord('bills', edit.id); if (edit.file && edit.file.id) await deleteFile(edit.file.id); closeSheet(); toast('Bill deleted'); } catch (e) { toast('Couldn’t delete. Try again.'); } }); }
    root.querySelector('#bf').addEventListener('submit', async ev => {
      ev.preventDefault(); if (B.saving) return; const err = root.querySelector('#b-err'); err.innerHTML = '';
      const from = root.querySelector('#b-from').value, to = root.querySelector('#b-to').value;
      if (!from || !to || pd(to) < pd(from)) { err.innerHTML = '<div class="note bad"><span class="ic">✕</span><span>Enter the billing period: both dates, end after start.</span></div>'; return; }
      B.saving = true; const btn = root.querySelector('#b-save'); btn.disabled = true; btn.textContent = 'Saving…';
      const n = id => { const v = parseNum(root.querySelector(id).value); return isFinite(v) ? v : null; };
      let file = edit ? edit.file || null : null, oldAsset = null;
      if (B.file) { try { const st = await storeFile(B.file); oldAsset = file && file.id; file = { id: st.id, type: st.type, name: B.file.name, bytes: B.file.size, sha256: B.meta && B.meta.sha256, uploadedAt: new Date().toISOString() }; } catch (e) { B.saving = false; btn.disabled = false; btn.textContent = 'Save bill'; err.innerHTML = `<div class="note bad"><span class="ic">✕</span><span>${esc(assetError(e))}</span></div>`; return; } }
      const u = util();
      const doc = clean({ utility: u, from, to, issued: root.querySelector('#b-issued').value || '', endReading: n('#b-end'), units: n('#b-units'), kwh: u === 'gas' ? n('#b-kwh') : null, cost: n('#b-cost'), advances: n('#b-adv'), balance: n('#b-bal'), note: root.querySelector('#b-note').value.trim(), file, updatedAt: new Date().toISOString(), createdAt: edit ? edit.createdAt || new Date().toISOString() : new Date().toISOString() });
      try { await putRecord('bills', edit ? edit.id : null, doc); if (oldAsset) await deleteFile(oldAsset); closeSheet(); toast('Bill saved'); }
      catch (e) { B.saving = false; btn.disabled = false; btn.textContent = 'Save bill'; err.innerHTML = '<div class="note bad"><span class="ic">✕</span><span>The bill couldn’t be saved. Try again.</span></div>'; }
    });
  });
}

/* ================= events ================= */
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
$('#fab').addEventListener('click', () => openReadingSheet(UTILS.includes(S.tab) ? S.tab : (S.logFilter !== 'all' && S.tab === 'log' ? S.logFilter : 'gas')));
main.addEventListener('click', async e => {
  const a = e.target.closest('[data-act]');
  if (a) {
    e.stopPropagation(); const act = a.dataset.act;
    if (APP_ACTS[act]) return APP_ACTS[act](a, e);
    if (act === 'add') return openReadingSheet(a.dataset.u);
    if (act === 'reading') return openReadingDetail(a.dataset.id);
    if (act === 'log') { S.logFilter = a.dataset.u || 'all'; return setTab('log'); }
    if (act === 'logf') { S.logFilter = a.dataset.f; return render(); }
    if (act === 'logv') { S.logView = a.dataset.v; return render(); }
    if (act === 'bill-add') return openBillSheet(null);
    if (act === 'bill') return openBillSheet(S.bills.find(b => b.id === a.dataset.id));
    if (act === 'set-reset') { S.draft = null; S.draftDirty = false; render(); return toast('Changes discarded'); }
    if (act === 'set-save') {
      readSettingsForm();
      ['gas', 'elec', 'water'].forEach(u => { S.draft[u].advances = (S.draft[u].advances || []).filter(x => x.from); });
      try { await saveConfig(clean(S.draft)); S.draftDirty = false; S.draft = null; toast('Settings saved'); render(); } catch (er) { toast('Settings couldn’t be saved. Try again.'); }
      return;
    }
    if (act === 'adv-add') { readSettingsForm(); const u = a.dataset.u; const list = S.draft[u].advances; const lastA = list[list.length - 1]; list.push({ from: '', amount: lastA ? lastA.amount : 0 }); S.draftDirty = true; rerenderSettings(); return; }
    if (act === 'adv-del') { readSettingsForm(); S.draft[a.dataset.u].advances.splice(+a.dataset.i, 1); S.draftDirty = true; rerenderSettings(); return; }
    if (act === 'wm-add') { readSettingsForm(); const ms = S.draft.water.meters; ms.push({ id: 'm' + Date.now().toString(36), name: ms.length === 1 ? 'Hot water' : 'Water meter ' + (ms.length + 1), serial: '' }); S.draftDirty = true; rerenderSettings(); return; }
    if (act === 'wm-del') { readSettingsForm(); const i = +a.dataset.i; const m = S.draft.water.meters[i]; if (S.readings.some(r => r.utility === 'water' && r.meter === m.id)) return toast('That meter has readings. Delete them first.'); S.draft.water.meters.splice(i, 1); S.draftDirty = true; rerenderSettings(); return; }
    return;
  }
  const t = e.target.closest('[data-tab]'); if (t && t.classList.contains('ucard')) setTab(t.dataset.tab);
});
main.addEventListener('change', async e => {
  const c = e.target.closest('[data-check]');
  if (c) {
    const checks = clone(S.cfg.checks || []); const it = checks.find(x => x.id === c.dataset.check); if (!it) return; it.done = c.checked;
    try { await saveConfig(clean(Object.assign(clone(S.cfg), { checks }))); } catch (er) { toast('Couldn’t save. Try again.'); c.checked = !c.checked; }
  }
});
main.addEventListener('keydown', e => { const t = e.target; if (t.classList && t.classList.contains('ucard') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setTab(t.dataset.tab); } });
main.addEventListener('input', e => { if (S.tab === 'settings' && e.target.closest('#settings-form')) S.draftDirty = true; });
function rerenderSettings() { const keep = S.draftDirty; S.draftDirty = false; const y = window.scrollY; render(); S.draftDirty = keep; window.scrollTo(0, y); }
let rzT; let lastW = 0;
new ResizeObserver(() => { const w = main.clientWidth; if (Math.abs(w - lastW) < 8) return; lastW = w; clearTimeout(rzT); rzT = setTimeout(() => JOBS.forEach(j => { const el = document.getElementById(j.id); if (el) j.fn(el); }), 120); }).observe(main);

/* ================= on-device storage, encryption and sync =================
   Everything is encrypted on the device with a random 256-bit data key (AES-GCM). That key is wrapped with a
   key derived from your passphrase (PBKDF2-SHA256, 600,000 rounds). Sync stores only the encrypted vault and
   encrypted photos in a PRIVATE GitHub repository. The access token lives inside this device's encrypted copy
   (docs._device) and is never synced or put in backups. */
const APP_VERSION = '1.2';
const te = new TextEncoder(), td = new TextDecoder();
const ITER = 600000;
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const byId = id => document.getElementById(id);
function b64(buf) { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
const uid = p => (p || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function passKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const importKey = raw => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
async function wrapRaw(raw, wk) { const iv = rnd(12); return { iv: b64(iv), ct: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk, raw)) }; }
async function unwrapRaw(w, wk) { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, wk, unb64(w.ct))); }
async function passWrap(raw, pass) { const salt = rnd(16); return Object.assign({ salt: b64(salt), iter: ITER, ts: Date.now() }, await wrapRaw(raw, await passKey(pass, salt, ITER))); }
async function sealObj(obj) { const iv = rnd(12); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, S.key, te.encode(JSON.stringify(obj))); return { kind: 'kc-meters-vault', v: 1, keys: S.keys, iv: b64(iv), ct: b64(ct), saved: Date.now() }; }
async function openBody(k, rec) { return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, k, unb64(rec.ct)))); }
async function openWithPass(rec, pass) {
  const p = rec.keys.pass; const raw = await unwrapRaw(p, await passKey(pass, unb64(p.salt), p.iter));
  const k = await importKey(raw); return { raw, key: k, docs: await openBody(k, rec) };
}
async function encBytes(bytes, key) { const iv = rnd(12); return { iv: b64(iv), ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key || S.key, bytes) }; }
async function decBytes(rec, key) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, key || S.key, rec.ct instanceof ArrayBuffer ? rec.ct : unb64(rec.ct)); }

/* ---------- IndexedDB ---------- */
let dbp = null;
function idb() {
  if (!dbp) dbp = new Promise((res, rej) => { const r = indexedDB.open('kc-meters', 1); r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('files'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return dbp;
}
async function tx(store, mode, fn) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
const kvGet = k => tx('kv', 'readonly', s => s.get(k));
const kvPut = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));
const kvDel = k => tx('kv', 'readwrite', s => s.delete(k));
const fileGet = id => tx('files', 'readonly', s => s.get(id));
const filePut = (id, v) => tx('files', 'readwrite', s => s.put(v, id));
const fileDel = id => tx('files', 'readwrite', s => s.delete(id));

/* ---------- documents ---------- */
function blankDocs() { return { config: {}, readings: [], bills: [] }; }
function ensureShape(d) {
  d = d && typeof d === 'object' ? d : {};
  if (!d.config || typeof d.config !== 'object' || Array.isArray(d.config)) d.config = {};
  if (!Array.isArray(d.readings)) d.readings = [];
  if (!Array.isArray(d.bills)) d.bills = [];
  return d;
}
const device = () => (S.docs._device = S.docs._device || {});
function stripDevice(d) { const o = Object.assign({}, d); delete o._device; return o; }
function applyDocs() {
  S.cfg = merge(DEFAULT_CONFIG, S.docs.config || {});
  S.readings = S.docs.readings.filter(r => r && r.id).map(r => Object.assign({}, r));
  S.bills = S.docs.bills.filter(b => b && b.id).map(b => Object.assign({}, b));
}
let saving = Promise.resolve();
function persist() {
  saving = saving.then(async () => { if (!S.key) return; await kvPut('vault', await sealObj(S.docs)); });
  syncSoon(2500);
  return saving.catch(e => toast('Couldn’t save on this device: ' + ((e && e.message) || e)));
}
async function commit() { applyDocs(); render(); await persist(); }
async function putRecord(coll, id, doc) {
  const list = S.docs[coll];
  const rec = Object.assign({}, doc, { id: id || uid(coll === 'readings' ? 'r' : 'b'), updatedAt: new Date().toISOString() });
  const i = list.findIndex(x => x.id === rec.id);
  if (i >= 0) list[i] = rec; else list.push(rec);
  await commit();
  return rec.id;
}
async function delRecord(coll, id) { S.docs[coll] = S.docs[coll].filter(x => x.id !== id); await commit(); }
async function saveConfig(cfg) { S.docs.config = cfg; await commit(); }
async function rememberDevice(on) {
  S.remembered = !!on;
  if (!on) { await kvDel('devkey'); return; }
  const dk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = rnd(12); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dk, S.raw);
  await kvPut('devkey', { dk, iv, ct });
}

/* ---------- photos and attachments ---------- */
async function putFile(bytes, type) {
  const id = uid('f'); const e = await encBytes(bytes);
  await filePut(id, { iv: e.iv, ct: e.ct, type });
  const dev = device(); dev.pendingImgs = (dev.pendingImgs || []).concat(id);
  return id;
}
async function deleteFile(id) {
  if (!id) return;
  try { await fileDel(id); } catch (e) { }
  const p = S.urls.get(id); if (p) { S.urls.delete(id); p.then(u => { if (u) URL.revokeObjectURL(u); }).catch(() => { }); }
  const dev = device(); dev.pendingImgs = (dev.pendingImgs || []).filter(x => x !== id);
  if (syncCfg()) dev.pendingDel = (dev.pendingDel || []).concat(id);
  await persist();
}
async function loadFileRec(id) {
  let rec = await fileGet(id).catch(() => null);
  if (!rec) {
    const cfg = syncCfg(); if (!cfg || !navigator.onLine) return null;
    const f = await ghGetFile(cfg, 'img/' + id + '.json'); if (!f) return null;
    const o = JSON.parse(f.text); rec = { iv: o.iv, ct: unb64(o.ct).buffer, type: o.type };
    await filePut(id, rec);
  }
  return rec;
}
async function fileBlob(id) { const rec = await loadFileRec(id); if (!rec) return null; return new Blob([await decBytes(rec)], { type: rec.type || 'image/jpeg' }); }
function photoUrl(id) {
  if (!S.urls.has(id)) {
    const p = fileBlob(id).then(b => b ? URL.createObjectURL(b) : null);
    S.urls.set(id, p);
    p.then(u => { if (!u) S.urls.delete(id); }, () => S.urls.delete(id));
  }
  return S.urls.get(id);
}
function phFor(img) { const ph = document.createElement('span'); ph.className = (img.className || '') + ' ph'; ph.innerHTML = ICON.camera; img.replaceWith(ph); }
function hydratePhotos(root) {
  root.querySelectorAll('img[data-photo]:not([data-h])').forEach(img => {
    img.setAttribute('data-h', '1');
    photoUrl(img.dataset.photo).then(u => { if (u) img.src = u; else phFor(img); }).catch(() => phFor(img));
  });
}
const extFor = t => /pdf/.test(t) ? '.pdf' : /png/.test(t) ? '.png' : /webp/.test(t) ? '.webp' : /gif/.test(t) ? '.gif' : '.jpg';
async function openFile(id, name) {
  const rec = await loadFileRec(id).catch(() => null);
  if (!rec) return toast('That file isn’t on this device yet. Sync, then try again.');
  const blob = new Blob([await decBytes(rec)], { type: rec.type || 'application/octet-stream' });
  const fname = (name || 'kc-utilities-file').replace(/[^\w.-]+/g, '-') + extFor(blob.type);
  if (/^image\//.test(blob.type)) {
    const u = await photoUrl(id);
    openSheet(`<div class="sheet-h"><h2 id="sheet-title">${esc(name || 'Photo')}</h2><button class="x" type="button" data-close="1" aria-label="Close">✕</button></div><div class="viewer"><img src="${u}" alt=""></div><div class="btnrow"><button class="btn" type="button" id="v-save">Save a copy</button><span class="hint">The copy is the file exactly as it was added, with its camera details.</span></div>`, root => { root.querySelector('#v-save').addEventListener('click', () => saveBlob(blob, fname)); });
    return;
  }
  const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 120000);
}
async function saveBlob(blob, filename) {
  try {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && window.matchMedia('(pointer: coarse)').matches && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return true; }
  } catch (e) { if (e && e.name === 'AbortError') return false; }
  const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 120000);
  return true;
}
function pickFile(accept) { return new Promise(res => { const inp = byId('pickFile'); inp.value = ''; inp.accept = accept || ''; inp.onchange = () => res((inp.files && inp.files[0]) || null); inp.click(); }); }
function confirmTap(btn, msg) {
  if (btn.dataset.armed) { delete btn.dataset.armed; return true; }
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = msg;
  setTimeout(() => { if (btn.isConnected && btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = old; } }, 4000);
  return false;
}
const stampToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/* ---------- import, backup, restore ---------- */
async function importClaudeFile(file) {
  let o = null; try { o = JSON.parse(await file.text()); } catch (e) { o = null; }
  if (!o || o.kind !== 'kc-meters-import') return toast('That file isn’t a Kč Utilities export.');
  const n = { readings: 0, bills: 0 };
  ['readings', 'bills'].forEach(coll => (o[coll] || []).forEach(r => {
    if (!r || !r.id) return;
    const i = S.docs[coll].findIndex(x => x.id === r.id);
    if (i < 0) { S.docs[coll].push(r); n[coll]++; }
    else if ((r.updatedAt || '') > (S.docs[coll][i].updatedAt || '')) { S.docs[coll][i] = r; n[coll]++; }
  }));
  if (o.config && typeof o.config === 'object') S.docs.config = o.config;
  for (const [id, f] of Object.entries(o.files || {})) {
    if (await fileGet(id).catch(() => null)) continue;
    const e = await encBytes(unb64(f.data)); await filePut(id, { iv: e.iv, ct: e.ct, type: f.type });
    const dev = device(); dev.pendingImgs = (dev.pendingImgs || []).concat(id);
  }
  await commit();
  toast(`Imported ${n.readings} readings and ${n.bills} bills, plus your settings`);
}
function referencedFiles() {
  const ids = new Set();
  S.docs.readings.forEach(r => { if (r.photo && r.photo.id) ids.add(r.photo.id); });
  S.docs.bills.forEach(b => { if (b.file && b.file.id) ids.add(b.file.id); });
  return [...ids];
}
async function makeBackup(withPhotos) {
  toast('Preparing the backup…');
  const out = { kind: 'kc-meters-backup', v: 1, made: new Date().toISOString(), vault: await sealObj(stripDevice(S.docs)) };
  let missing = 0;
  if (withPhotos) {
    out.files = {};
    for (const id of referencedFiles()) {
      const rec = await loadFileRec(id).catch(() => null);
      if (!rec) { missing++; continue; }
      out.files[id] = { iv: rec.iv, ct: b64(rec.ct), type: rec.type };
    }
  }
  const ok = await saveBlob(new Blob([JSON.stringify(out)], { type: 'application/json' }), `kc-utilities-backup-${stampToday()}${withPhotos ? '-photos' : ''}.json`);
  if (!ok) return;
  device().lastBackup = Date.now(); await persist();
  toast(missing ? `Backup saved. ${missing} photos weren’t on this device.` : 'Backup saved');
  render();
}
async function readBackup(file, pass) {
  let o = null; try { o = JSON.parse(await file.text()); } catch (e) { o = null; }
  if (!o || o.kind !== 'kc-meters-backup' || !o.vault) throw new Error('notbackup');
  let opened; try { opened = await openWithPass(o.vault, pass); } catch (e) { throw new Error('pass'); }
  return { o, opened };
}
const backupError = e => e && e.message === 'notbackup' ? 'That file isn’t a Kč Utilities backup.' : e && e.message === 'pass' ? 'That passphrase doesn’t open this backup.' : 'The backup couldn’t be read.';
function openRestoreSheet() {
  openSheet(`<div class="sheet-h"><h2 id="sheet-title">Restore a backup</h2><button class="x" type="button" data-close="1" aria-label="Close">✕</button></div>
  <form id="rsf" class="sec" style="gap:14px" novalidate>
    <p class="lede" style="margin:0">This replaces the readings, bills and settings on this device with the ones in the backup. Your passphrase and sync settings stay as they are.</p>
    <label class="fld"><span>Backup file</span><input class="in" type="file" id="rs-file" accept="application/json,.json"></label>
    <label class="fld"><span>The backup’s passphrase</span><input class="in" type="password" id="rs-pass" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <div id="rs-err"></div>
    <div class="btnrow"><button class="btn" type="button" data-close="1">Cancel</button><span style="flex:1"></span><button class="btn primary" type="submit" id="rs-go">Replace with the backup</button></div>
  </form>`, root => {
    root.querySelector('#rsf').addEventListener('submit', async ev => {
      ev.preventDefault(); const err = root.querySelector('#rs-err'); err.innerHTML = '';
      const f = root.querySelector('#rs-file').files[0]; if (!f) { err.innerHTML = '<div class="note bad"><span class="ic">✕</span><span>Choose the backup file.</span></div>'; return; }
      const btn = root.querySelector('#rs-go'); if (!confirmTap(btn, 'Tap again to replace')) return;
      btn.disabled = true; btn.textContent = 'Restoring…';
      try {
        const { o, opened } = await readBackup(f, root.querySelector('#rs-pass').value);
        for (const [id, fr] of Object.entries(o.files || {})) {
          const bytes = await decBytes({ iv: fr.iv, ct: fr.ct }, opened.key);
          const e = await encBytes(bytes); await filePut(id, { iv: e.iv, ct: e.ct, type: fr.type });
          const dev = device(); if (syncCfg()) dev.pendingImgs = (dev.pendingImgs || []).concat(id);
        }
        const dev = S.docs._device; S.docs = ensureShape(stripDevice(opened.docs)); if (dev) S.docs._device = dev;
        S.draft = null; S.draftDirty = false;
        await commit(); closeSheet(); toast('Backup restored');
      } catch (e) { btn.disabled = false; btn.textContent = 'Replace with the backup'; err.innerHTML = `<div class="note bad"><span class="ic">✕</span><span>${esc(backupError(e))}</span></div>`; }
    });
  });
}
function openPassSheet() {
  openSheet(`<div class="sheet-h"><h2 id="sheet-title">Change passphrase</h2><button class="x" type="button" data-close="1" aria-label="Close">✕</button></div>
  <form id="pwf" class="sec" style="gap:14px" novalidate>
    <label class="fld"><span>Current passphrase</span><input class="in" type="password" id="pw-old" autocomplete="current-password" autocapitalize="off" spellcheck="false"></label>
    <label class="fld"><span>New passphrase (10 characters or more)</span><input class="in" type="password" id="pw-new" autocomplete="new-password" autocapitalize="off" spellcheck="false"></label>
    <label class="fld"><span>New passphrase again</span><input class="in" type="password" id="pw-new2" autocomplete="new-password" autocapitalize="off" spellcheck="false"></label>
    <div id="pw-err"></div>
    <div class="btnrow"><button class="btn" type="button" data-close="1">Cancel</button><span style="flex:1"></span><button class="btn primary" type="submit">Change passphrase</button></div>
  </form>`, root => {
    root.querySelector('#pwf').addEventListener('submit', async ev => {
      ev.preventDefault(); const err = root.querySelector('#pw-err');
      const bad = m => { err.innerHTML = `<div class="note bad"><span class="ic">✕</span><span>${esc(m)}</span></div>`; };
      const p0 = root.querySelector('#pw-old').value, p1 = root.querySelector('#pw-new').value, p2 = root.querySelector('#pw-new2').value;
      if (p1.length < 10) return bad('Use at least 10 characters.');
      if (p1 !== p2) return bad('The two new passphrases don’t match.');
      try { const p = S.keys.pass; await unwrapRaw(p, await passKey(p0, unb64(p.salt), p.iter)); } catch (e) { return bad('The current passphrase isn’t right.'); }
      S.keys = { pass: await passWrap(S.raw, p1) }; await persist(); closeSheet();
      toast(syncCfg() ? 'Passphrase changed. Your other devices pick it up at their next sync.' : 'Passphrase changed');
    });
  });
}
async function forceUpdate() {
  toast('Fetching the latest version…');
  try { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())); } catch (e) { }
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (e) { }
  location.replace(location.pathname + '?u=' + Date.now());
}
async function lockNow() { await kvDel('devkey').catch(() => { }); location.reload(); }

/* ---------- settings: sync, backups, this device ---------- */
function appSettingsHTML() {
  const c = syncCfg(); const dev = device();
  const when = t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const pending = (dev.pendingImgs || []).length;
  const sync = c
    ? `<p style="margin:0">Syncing with <b>${esc(c.repo)}</b>${c.last ? ` · last synced ${esc(when(c.last))}` : ''}.${pending ? ` ${pending} photo${pending > 1 ? 's' : ''} waiting to upload.` : ''}</p>${c.error ? `<div class="note bad"><span class="ic">✕</span><span>${esc(c.error)}</span></div>` : ''}<div class="btnrow"><button class="btn" data-act="sync-now" type="button">Sync now</button><button class="btn ghost danger" data-act="sync-off" type="button">Stop syncing on this device</button></div>`
    : `<p class="small" style="margin:0;color:var(--ink-2)">Keeps your phone and laptop in step through a <b>private</b> GitHub repository, for example <span class="mono">your-username/Kc-Utilities-Data</span>. Use a fine-grained access token limited to that one repository, with Contents: read and write. Everything is encrypted here before upload, and the token never leaves this device.</p>
      <div class="fgrid"><label class="fld"><span>Private repository</span><input class="in" id="sync-repo" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="your-username/Kc-Utilities-Data"></label><label class="fld"><span>Access token</span><input class="in" id="sync-token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…"></label></div>
      <div class="btnrow"><button class="btn primary" data-act="sync-connect" type="button">Connect</button><span class="hint" id="sync-hint"></span></div>`;
  const last = dev.lastBackup ? `Last backup ${when(dev.lastBackup)}.` : 'No backup made on this device yet.';
  return `<section class="sec" id="app-settings" style="gap:14px;margin-top:10px">
    <div class="sec-h"><h2>This app</h2><span class="aside">Kč Utilities ${APP_VERSION}</span></div>
    <div class="card" id="app-sync"><div class="card-h"><h3>Sync between devices</h3><span class="chip ${c ? (c.error ? 'bad' : 'ok') : ''}">${c ? (c.error ? '✕ Sync issue' : '✓ On') : 'Off'}</span></div>${sync}</div>
    <div class="card"><h3>Backups and import</h3><p class="small" style="margin:0;color:var(--ink-2)">${esc(last)} A backup is encrypted and opens with your passphrase. Keep it somewhere safe, such as iCloud Drive. Never upload it to the public app repository.</p>
      <div class="btnrow"><button class="btn" data-act="backup" type="button">Save a backup</button><button class="btn" data-act="backup-photos" type="button">Backup with photos</button><button class="btn" data-act="restore" type="button">Restore a backup</button></div>
      <div class="btnrow"><button class="btn ghost" data-act="import" type="button">Import from the Claude page</button></div></div>
    <div class="card"><h3>This device</h3>
      <label class="check" style="border:0;padding:0"><input type="checkbox" id="remember"${S.remembered ? ' checked' : ''}><span>Keep unlocked on this device. Turn it off to ask for the passphrase every time the app opens.</span></label>
      <div class="btnrow"><button class="btn" data-act="passphrase" type="button">Change passphrase</button><button class="btn" data-act="lock" type="button">Lock now</button><button class="btn ghost" data-act="update" type="button">Check for a new version</button></div></div>
  </section>`;
}
async function connectSync() {
  const h = byId('sync-hint'); const repo = cleanRepo(byId('sync-repo').value), token = byId('sync-token').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) { h.textContent = 'Enter the repository as owner/name and paste the token.'; return; }
  h.textContent = 'Checking the repository…';
  try {
    const info = await gh({ repo, token }, 'GET', ''); if (!info) throw Object.assign(new Error('x'), { status: 404 });
    if (!info.private) throw new Error('public');
    const dev = device(); dev.sync = { repo, token, branch: info.default_branch || 'main' }; delete dev.base;
    dev.pendingImgs = [...new Set((dev.pendingImgs || []).concat(referencedFiles()))];
    await persist(); render(); await syncNow(true);
  } catch (e) { h.textContent = syncError(e); }
}
const APP_ACTS = {
  'import': async () => { const f = await pickFile('application/json,.json'); if (f) importClaudeFile(f); },
  'open-file': a => openFile(a.dataset.id, a.dataset.name || 'Bill'),
  'sync-now': () => syncNow(true),
  'sync-connect': () => connectSync(),
  'sync-off': async a => { if (!confirmTap(a, 'Tap again to stop syncing')) return; const dev = device(); delete dev.sync; delete dev.base; delete dev.pendingDel; await persist(); render(); setSyncUI(); toast('Sync is off on this device. The copy on GitHub stays as it is.'); },
  'backup': () => makeBackup(false),
  'backup-photos': () => makeBackup(true),
  'restore': () => openRestoreSheet(),
  'passphrase': () => openPassSheet(),
  'lock': () => lockNow(),
  'update': () => forceUpdate()
};
main.addEventListener('change', async e => {
  if (e.target.id !== 'remember') return;
  try { await rememberDevice(e.target.checked); toast(e.target.checked ? 'This device stays unlocked' : 'The passphrase is needed each time the app opens'); } catch (er) { e.target.checked = !e.target.checked; toast('Couldn’t change that. Try again.'); }
});

/* ---------- sync through a private GitHub repository ---------- */
let syncT = null, inSync = false;
const syncCfg = () => (S.docs && S.docs._device && S.docs._device.sync) || null;
const cleanRepo = v => String(v).trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
function syncSoon(ms) { clearTimeout(syncT); if (S.key && syncCfg()) syncT = setTimeout(() => syncNow(false), ms); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.key) syncSoon(400); });
window.addEventListener('online', () => syncSoon(400));
async function gh(cfg, method, path, body) {
  const r = await fetch('https://api.github.com/repos/' + cfg.repo + path, {
    method, cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit',
    headers: Object.assign({ Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) { const e = new Error('github ' + r.status); e.status = r.status; throw e; }
  return r.status === 204 ? null : r.json();
}
async function ghGetFile(cfg, path) {
  const j = await gh(cfg, 'GET', '/contents/' + path); if (!j) return null; let c = j.content;
  if (!c || j.encoding === 'none') { const bl = await gh(cfg, 'GET', '/git/blobs/' + j.sha); c = bl.content; }
  return { sha: j.sha, text: td.decode(unb64(String(c).replace(/\s/g, ''))) };
}
const ghPut = (cfg, path, text, sha) => gh(cfg, 'PUT', '/contents/' + path, Object.assign({ message: 'Kč Utilities sync', content: b64(te.encode(text)) }, sha ? { sha } : {}));
function canon(v) { if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'; return JSON.stringify(v); }
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function mergeVal(b, l, r, depth) {
  const cb = canon(b), cl = canon(l), cr = canon(r);
  if (cl === cr) return l; if (cl === cb) return r; if (cr === cb) return l;
  if (Array.isArray(l) && Array.isArray(r) && l.concat(r).every(x => isObj(x) && x.id)) return mergeList(Array.isArray(b) ? b : [], l, r);
  if (isObj(l) && isObj(r) && depth < 4) { const o = {}; const ks = new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(isObj(b) ? b : {})]); ks.forEach(k => { const v = mergeVal(isObj(b) ? b[k] : undefined, l[k], r[k], depth + 1); if (v !== undefined) o[k] = v; }); return o; }
  return l !== undefined ? l : r;
}
function mergeList(b, l, r) { const by = a => Object.fromEntries(a.map(x => [x.id, x])); const B = by(b), L = by(l), R = by(r); const order = [...l.map(x => x.id), ...r.map(x => x.id).filter(id => !(id in L))]; const out = []; order.forEach(id => { const v = mergeVal(B[id], L[id], R[id], 1); if (v !== undefined) out.push(v); }); return out; }
function syncError(e) {
  if (!e) return '';
  if (e.status === 401) return 'GitHub rejected the access token. It may have expired: make a new one and connect again.';
  if (e.status === 403 || e.status === 404) return 'The token can’t reach that repository. Check the name and that the token has read and write access to its contents.';
  if (e.message === 'public') return 'That repository is public. Make it private on GitHub first.';
  if (e.message === 'otherkey') return 'That repository holds Kč Utilities data encrypted with a different passphrase. Use “Join one that’s already synced” on a fresh device instead.';
  return 'Couldn’t reach GitHub. It will try again when you’re online.';
}
function setSyncUI(state) {
  const c = syncCfg(); const b = byId('sync'), t = byId('sync-text'); if (!b) return;
  let s = 'local', label = 'On this device';
  if (state === 'busy') { s = 'busy'; label = 'Syncing…'; }
  else if (c && c.error) { s = 'bad'; label = 'Sync issue'; }
  else if (c) { s = 'ok'; label = 'Synced'; }
  b.dataset.s = s; t.textContent = label;
  b.title = c && c.last ? 'Last synced ' + new Date(c.last).toLocaleString('en-GB') : '';
}
async function syncNow(manual) {
  const cfg = syncCfg(); if (!cfg || !S.key || inSync) return;
  if (!navigator.onLine) { if (manual) toast('You’re offline. Sync runs when you’re back online.'); return; }
  inSync = true; setSyncUI('busy');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      await saving;
      const dev = S.docs._device;
      for (const id of (dev.pendingImgs || []).slice()) {
        const f = await fileGet(id).catch(() => null);
        if (f) { const ex = await gh(cfg, 'GET', '/contents/img/' + id + '.json'); if (!ex) await ghPut(cfg, 'img/' + id + '.json', JSON.stringify({ iv: f.iv, ct: b64(f.ct), type: f.type })); }
        dev.pendingImgs = (dev.pendingImgs || []).filter(x => x !== id);
      }
      for (const id of (dev.pendingDel || []).slice()) {
        const ex = await gh(cfg, 'GET', '/contents/img/' + id + '.json');
        if (ex) await gh(cfg, 'DELETE', '/contents/img/' + id + '.json', { message: 'Kč Utilities sync', sha: ex.sha });
        dev.pendingDel = (dev.pendingDel || []).filter(x => x !== id);
      }
      const remote = await ghGetFile(cfg, 'vault.json'); let rDocs = null, rRec = null;
      if (remote) { rRec = JSON.parse(remote.text); try { rDocs = await openBody(S.key, rRec); } catch (e) { throw new Error('otherkey'); } }
      if (rRec && rRec.keys && rRec.keys.pass && S.keys && S.keys.pass && (rRec.keys.pass.ts || 0) > (S.keys.pass.ts || 0)) S.keys = rRec.keys;
      const local = clone(stripDevice(S.docs)); const base = dev.base || null;
      const merged = rDocs ? mergeVal(base || {}, local, rDocs, 0) : local;
      if (!rDocs || canon(merged) !== canon(rDocs) || (rRec && canon(rRec.keys) !== canon(S.keys))) {
        const rec = await sealObj(merged);
        try { await ghPut(cfg, 'vault.json', JSON.stringify(rec), remote && remote.sha); } catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
      }
      const nowLocal = stripDevice(S.docs); let fin = merged;
      if (canon(nowLocal) !== canon(local)) fin = mergeVal(local, clone(nowLocal), merged, 0);
      S.docs = ensureShape(clone(fin)); S.docs._device = dev; dev.base = clone(merged); dev.sync.last = Date.now(); delete dev.sync.error;
      await kvPut('vault', await sealObj(S.docs));
      applyDocs(); setSyncUI(); if (manual) toast('Synced');
      render();
      return;
    }
    throw new Error('busy');
  } catch (e) {
    const c = syncCfg(); if (c) { c.error = syncError(e); try { await kvPut('vault', await sealObj(S.docs)); } catch (er) { } }
    setSyncUI(); if (manual) toast(syncError(e));
    if (S.tab === 'settings') render();
  } finally { inSync = false; }
}

/* ================= lock screen and start-up ================= */
function showOnly(id) { ['unlockForm', 'startChoice', 'newForm', 'joinForm', 'restoreForm'].forEach(x => { byId(x).hidden = x !== id; }); }
function hint(id, msg, err) { const h = byId(id); h.className = 'hint' + (err ? ' err' : ''); h.textContent = msg; }
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => { });
  let vault = null;
  try { vault = await kvGet('vault'); } catch (e) { byId('lockSub').textContent = 'This browser is blocking storage. Open Kč Utilities in Safari or Chrome directly, not in a private window.'; return; }
  if (!vault) { byId('lockSub').textContent = 'Set up this device.'; showOnly('startChoice'); return; }
  const dev = await kvGet('devkey').catch(() => null);
  if (dev) {
    try { const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dev.iv }, dev.dk, dev.ct)); const k = await importKey(raw); const docs = await openBody(k, vault); S.remembered = true; return start(raw, k, docs, vault.keys); }
    catch (e) { await kvDel('devkey').catch(() => { }); }
  }
  byId('lockSub').textContent = 'Locked.'; showOnly('unlockForm'); byId('unlockPass').focus();
}
function start(raw, k, docs, keys) {
  S.raw = raw; S.key = k; S.keys = keys; S.docs = ensureShape(docs);
  applyDocs();
  byId('lock').hidden = true; byId('app').hidden = false;
  render(); setSyncUI(); syncSoon(600);
}
byId('unlockForm').addEventListener('submit', async e => {
  e.preventDefault(); hint('unlockHint', 'Unlocking…');
  try { const vault = await kvGet('vault'); const o = await openWithPass(vault, byId('unlockPass').value); start(o.raw, o.key, o.docs, vault.keys); await rememberDevice(byId('unlockRemember').checked); byId('unlockPass').value = ''; }
  catch (err) { hint('unlockHint', 'That passphrase doesn’t open Kč Utilities.', true); }
});
byId('startNew').addEventListener('click', () => { showOnly('newForm'); byId('newPass').focus(); });
byId('startJoin').addEventListener('click', () => showOnly('joinForm'));
byId('startRestore').addEventListener('click', () => showOnly('restoreForm'));
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => showOnly('startChoice')));
byId('newForm').addEventListener('submit', async e => {
  e.preventDefault(); const p1 = byId('newPass').value, p2 = byId('newPass2').value;
  if (p1.length < 10) return hint('newHint', 'Use at least 10 characters.', true);
  if (p1 !== p2) return hint('newHint', 'The two passphrases don’t match.', true);
  hint('newHint', 'Setting up encryption…');
  const raw = rnd(32); const k = await importKey(raw); const keys = { pass: await passWrap(raw, p1) };
  start(raw, k, blankDocs(), keys); await persist(); await rememberDevice(byId('newRemember').checked);
  byId('newPass').value = byId('newPass2').value = '';
});
byId('joinForm').addEventListener('submit', async e => {
  e.preventDefault(); hint('joinHint', 'Checking the repository…');
  const repo = cleanRepo(byId('joinRepo').value), token = byId('joinToken').value.trim();
  try {
    const info = await gh({ repo, token }, 'GET', ''); if (!info) throw Object.assign(new Error('x'), { status: 404 }); if (!info.private) throw new Error('public');
    const f = await ghGetFile({ repo, token }, 'vault.json'); if (!f) return hint('joinHint', 'There’s no Kč Utilities data in that repository yet. Start on your first device and connect sync there, then join here.', true);
    const rec = JSON.parse(f.text); let o; try { o = await openWithPass(rec, byId('joinPass').value); } catch (er) { return hint('joinHint', 'That passphrase doesn’t open the synced data.', true); }
    o.docs._device = { sync: { repo, token, branch: info.default_branch || 'main', last: Date.now() }, base: clone(o.docs) };
    start(o.raw, o.key, o.docs, rec.keys); await persist(); await rememberDevice(byId('joinRemember').checked);
    byId('joinToken').value = byId('joinPass').value = ''; toast('Joined. Photos download when you open them.');
  } catch (err) { hint('joinHint', syncError(err), true); }
});
byId('restoreForm').addEventListener('submit', async e => {
  e.preventDefault(); const f = byId('restoreFile').files[0]; if (!f) return hint('restoreHint', 'Choose the backup file.', true);
  hint('restoreHint', 'Opening the backup…');
  try {
    const { o, opened } = await readBackup(f, byId('restorePass').value);
    for (const [id, fr] of Object.entries(o.files || {})) await filePut(id, { iv: fr.iv, ct: unb64(fr.ct).buffer, type: fr.type });
    start(opened.raw, opened.key, stripDevice(opened.docs), o.vault.keys); await persist(); await rememberDevice(byId('restoreRemember').checked);
    byId('restorePass').value = ''; toast('Backup restored');
  } catch (err) { hint('restoreHint', backupError(err), true); }
});
byId('sync').addEventListener('click', () => { if (syncCfg()) syncNow(true); else { setTab('settings'); setTimeout(() => { const s = byId('app-sync'); if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60); } });
byId('lockBtn').addEventListener('click', () => lockNow());
boot();
})();
