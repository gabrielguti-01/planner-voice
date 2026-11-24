// Money (laptop view): what you owe on pay-later plans and bills, the paychecks to come, and how much is safe to use
// while an emergency cushion stays untouched. Every number is computed here, in plain code, from your own entries.
// Laptop only: the numbers live in a folder on this computer (money.json, plus a copy in backups/ before the first
// change of each day). This file makes no network requests: nothing in it is sent to GitHub or anywhere else.
// The only thing that can leave is a planner reminder you ask for, and it carries a name and a date, never an amount.
(function (root) {
  'use strict';
  const FORMAT = 'planner-money', VERSION = 1, FILE = 'money.json';

  // ---------- amounts: whole cents, never floating-point dollars ----------
  /** "$1,234.5" → 123450; anything that isn't a plain amount → null (never guessed). */
  function cents(v) {
    const t = String(v ?? '').trim().replace(/^\$\s*/, '');
    if (!/^(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|\.\d{1,2})$/.test(t)) return null;
    const [w, f = ''] = t.replace(/,/g, '').split('.');
    const n = Number(w || '0') * 100 + Number((f + '00').slice(0, 2));
    return Number.isSafeInteger(n) ? n : null;
  }
  /** 4510 → "$45.10"; −1250 → "−$12.50" */
  function usd(c) {
    if (c == null) return '—';
    const a = Math.abs(c);
    return (c < 0 ? '−$' : '$') + Math.floor(a / 100).toLocaleString('en-US') + '.' + String(a % 100).padStart(2, '0');
  }

  // ---------- dates: plain YYYY-MM-DD strings; arithmetic in UTC, so daylight saving never shifts a day ----------
  const DAY = 864e5;
  const isDate = (s) => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const t = Date.parse(s + 'T00:00:00Z'); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; };
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
  const daysFrom = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
  /** the date n months after d, on `day` (the 31st becomes the month's last day) */
  function addMonths(d, n, day) {
    const m = +d.slice(5, 7) - 1 + n, yy = +d.slice(0, 4) + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
    const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
  }
  const dayLabel = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const EVERY = { '2weeks': 'every 2 weeks', month: 'every month', week: 'every week', once: 'just once' };

  /** the due dates of `count` payments from `first`, spaced by `every` */
  function scheduleDates(first, every, count) {
    if (every === 'once') return [first];
    const out = [];
    for (let i = 0; i < count; i++) out.push(every === 'month' ? addMonths(first, i, +first.slice(8)) : addDays(first, (every === 'week' ? 7 : 14) * i));
    return out;
  }
  /** a repeating rule's dates within [from, to] */
  function occurrences(rule, from, to) {
    const out = [], end = rule.until && rule.until < to ? rule.until : to;
    if (rule.every === 'month') {
      const day = +rule.from.slice(8);
      for (let i = 0; i < 1200; i++) { const d = addMonths(rule.from, i, day); if (d > end) break; if (d >= from) out.push(d); }
    } else {
      const step = rule.every === 'week' ? 7 : 14;
      let d = rule.from;
      if (d < from) d = addDays(d, Math.floor(daysFrom(d, from) / step) * step);
      for (; d <= end; d = addDays(d, step)) if (d >= from) out.push(d);
    }
    return out;
  }

  // ---------- the file ----------
  // plans: what you owe, each a list of payments (pay-later plans, a one-off bill, a card's statement)
  // repeating: money that comes and goes on a schedule (paychecks; rent and bills); an amount may be left blank
  // ledger: what happened, in order, never edited: "have" (what you have right now), "paid", "got", and "undo"
  const emptyDoc = () => ({ format: FORMAT, version: VERSION, cushion: 30000, cushionSet: false, plans: [], repeating: [], ledger: [] });

  /** what is wrong with a money file ([] = nothing); a file that fails is never written over */
  function check(d) {
    if (!d || typeof d !== 'object' || d.format !== FORMAT) return ['This is not a planner money file.'];
    if (d.version !== VERSION) return [`This money file is version ${d.version}; this page reads version ${VERSION}.`];
    const bad = [], int = Number.isSafeInteger, ids = new Set();
    if (!int(d.cushion) || d.cushion < 0) bad.push('the cushion');
    for (const k of ['plans', 'repeating', 'ledger']) if (!Array.isArray(d[k])) bad.push(`the ${k} list`);
    if (bad.length) return bad;
    const id = (x, what) => { if (!x || typeof x.id !== 'string' || !x.id || ids.has(x.id)) bad.push(`${what}: a missing or repeated id`); else ids.add(x.id); };
    for (const p of d.plans) {
      id(p, 'a plan');
      if (typeof p.who !== 'string' || typeof p.what !== 'string') bad.push(`plan ${p.id}: its name`);
      if (!Array.isArray(p.payments) || !p.payments.length || p.payments.some((x) => !x || !isDate(x.due) || !int(x.cents) || x.cents <= 0)) bad.push(`plan ${p.id}: its payments`);
      if (p.autopay != null && typeof p.autopay !== 'boolean') bad.push(`plan ${p.id}: autopay`);
    }
    for (const r of d.repeating) {
      id(r, 'a paycheck or bill');
      if (!['in', 'out'].includes(r.kind) || typeof r.who !== 'string' || !['week', '2weeks', 'month'].includes(r.every) || !isDate(r.from) || (r.until != null && !isDate(r.until)) || (r.cents != null && (!int(r.cents) || r.cents <= 0))) bad.push(`paycheck or bill ${r.id}`);
    }
    const plans = new Set(d.plans.map((p) => p.id)), reps = new Set(d.repeating.map((r) => r.id));
    for (const x of d.ledger) {
      id(x, 'a history row');
      if (x.type === 'undo') { if (!d.ledger.some((y) => y.id === x.of && y.type !== 'undo')) bad.push(`history ${x.id}: undoes nothing`); continue; }
      if (!['have', 'paid', 'got'].includes(x.type) || !isDate(x.date) || !int(x.cents)) { bad.push(`history ${x.id}`); continue; }
      if (x.type !== 'have' && x.cents <= 0) bad.push(`history ${x.id}: its amount`);
      if (x.plan != null && !plans.has(x.plan)) bad.push(`history ${x.id}: its plan`);
      if (x.repeating != null && (!reps.has(x.repeating) || !isDate(x.for))) bad.push(`history ${x.id}: its paycheck or bill`);
    }
    return bad;
  }

  // ---------- what follows from the file ----------
  /** the history rows that still count (undone ones left out) */
  const rowsOf = (d) => { const gone = new Set(d.ledger.filter((x) => x.type === 'undo').map((x) => x.of)); return d.ledger.filter((x) => x.type !== 'undo' && !gone.has(x.id)); };
  /** the money you have: what you last typed, plus what came in and minus what went out after it. A row dated before
   *  that day, or marked as already in it, was already in what you typed. */
  function cashNow(rows) {
    let at = -1;
    rows.forEach((x, i) => { if (x.type === 'have') at = i; });
    if (at < 0) return { cash: null, snap: null, since: [] };
    const snap = rows[at], since = rows.slice(at + 1).filter((x) => x.type !== 'have' && !x.inHave && x.date >= snap.date);
    return { cash: since.reduce((t, x) => t + (x.type === 'got' ? x.cents : -x.cents), snap.cents), snap, since };
  }
  /** a plan's payments with what's been paid on each: payments cover the earliest due first */
  function planState(plan, rows) {
    let paid = rows.filter((x) => x.type === 'paid' && x.plan === plan.id).reduce((t, x) => t + x.cents, 0);
    const total = plan.payments.reduce((t, p) => t + p.cents, 0);
    const pays = plan.payments.map((p, k) => ({ ...p, k })).sort((a, b) => a.due.localeCompare(b.due) || a.k - b.k).map((p, i) => {
      const c = Math.min(paid, p.cents); paid -= c;
      return { due: p.due, cents: p.cents, n: i + 1, paid: c, left: p.cents - c };
    });
    const left = pays.reduce((t, p) => t + p.left, 0);
    return { total, left, over: paid, pays, done: pays.filter((p) => p.left === 0).length, next: pays.find((p) => p.left > 0) || null };
  }

  /**
   * Everything still to come, in order, with the money left after each, from today through `until` (about two months, or
   * the last payment owed if later). Payments and bills count until they're marked paid (an overdue one counts today);
   * bills dated from the day you last typed what you have count too. Paychecks count from tomorrow on: on payday, mark it
   * received. On one day, money out comes before money in (a charge can land before the paycheck).
   */
  function project(d, today, opts = {}) {
    const rows = rowsOf(d), { cash, snap, since } = cashNow(rows);
    const base = snap && snap.date < today ? snap.date : today;
    const events = [], checks = [], gaps = [];
    let last = today;
    const plans = d.plans.filter((p) => !p.closed).map((plan) => ({ plan, st: planState(plan, rows) }));
    for (const { plan, st } of plans) for (const p of st.pays) if (p.left > 0) {
      events.push({ date: p.due < today ? today : p.due, due: p.due, dir: -1, cents: p.left, who: plan.who, what: plan.what, plan: plan.id, n: p.n, of: st.pays.length, late: p.due < today, part: p.paid > 0 });
      if (p.due > last) last = p.due;
    }
    const soon = addDays(today, opts.days ?? 62), until = opts.until || (soon > last ? soon : last);
    for (const r of d.repeating) {
      const done = new Set(rows.filter((x) => x.repeating === r.id).map((x) => x.for));
      for (const day of occurrences(r, base, until)) {
        if (done.has(day)) continue;
        if (r.cents == null) { if (!gaps.some((g) => g.id === r.id)) gaps.push({ id: r.id, who: r.who, kind: r.kind }); continue; }
        if (r.kind === 'out') events.push({ date: day < today ? today : day, due: day, dir: -1, cents: r.cents, who: r.who, repeating: r.id, late: day < today });
        else if (day > today) events.push({ date: day, due: day, dir: 1, cents: r.cents, who: r.who, repeating: r.id });
        else checks.push({ repeating: r.id, who: r.who, due: day, cents: r.cents }); // payday is today or past: did it come in?
      }
    }
    events.forEach((e, i) => { e.k = i; });
    events.sort((a, b) => a.date.localeCompare(b.date) || a.dir - b.dir || a.due.localeCompare(b.due) || a.k - b.k);
    let bal = cash;
    for (const e of events) {
      if (bal != null) bal += e.dir * e.cents;
      e.after = bal;
      e.status = bal == null ? null : e.dir > 0 ? 'in' : bal < 0 ? 'short' : bal < d.cushion ? 'cushion' : 'ok';
    }
    const res = { today, until, cash, snap, since, events, checks, gaps, cushion: d.cushion, owed: plans.reduce((t, x) => t + x.st.left, 0), plans: Object.fromEntries(plans.map((x) => [x.plan.id, x.st])) };
    if (cash == null) return res;
    // the lowest point from each moment on, so "from then on" is one lookup
    const low = Array(events.length + 1).fill(Infinity);
    for (let i = events.length - 1; i >= 0; i--) low[i] = Math.min(events[i].after, low[i + 1]);
    res.low = Math.min(cash, low[0]);
    res.lowAt = cash <= low[0] ? today : events.find((e) => e.after === res.low).date;
    // spare: what you could use today and still keep the cushion through everything to come
    res.spare = res.low - d.cushion;
    // the safe window: each paycheck after which more is spare (only real room counts: above zero)
    res.window = [];
    let best = Math.max(res.spare, 0);
    events.forEach((e, i) => { if (e.dir > 0 && low[i] - d.cushion > best) { best = low[i] - d.cushion; res.window.push({ date: e.date, who: e.who, spare: best }); } });
    res.firstShort = events.find((e) => e.status === 'short') || null;
    res.firstCushion = events.find((e) => e.status === 'cushion') || null;
    // paying ahead, each plan on its own: now, and after each paycheck
    res.ahead = {};
    const starts = [{ i: -1, date: today, bal: cash, who: null }, ...events.map((e, i) => ({ i, date: e.date, bal: e.after, who: e.who, dir: e.dir })).filter((s) => s.dir > 0)];
    for (const { plan } of plans) {
      const steps = [];
      for (const s of starts) {
        const a = aheadFrom(events, s, d.cushion, plan.id);
        if (a.total && (s.i < 0 || a.count > (steps[steps.length - 1]?.count ?? 0) || (a.count === a.total && !steps.some((x) => x.count === x.total)))) steps.push({ ...a, date: s.date, who: s.who });
        if (a.total && a.count === a.total) break;
      }
      res.ahead[plan.id] = steps;
    }
    return res;
  }
  /** how many of a plan's next payments (whole ones, in order) could be paid at start `s` while every balance until
   *  their due dates stays at or above the cushion. Balances after the last one paid early don't change. */
  function aheadFrom(events, s, cushion, planId) {
    const mine = [];
    for (let i = s.i + 1; i < events.length; i++) if (events[i].plan === planId && events[i].date > s.date) mine.push(i);
    let best = { count: 0, cents: 0, total: mine.length, through: null }, sum = 0;
    for (let m = 0; m < mine.length; m++) {
      sum += events[mine[m]].cents;
      let ok = s.bal - sum >= cushion;
      for (let j = s.i + 1; ok && j < mine[m]; j++) {
        let early = 0; // the payments moved to the start that would otherwise come after moment j
        for (let q = 0; q <= m; q++) if (mine[q] > j) early += events[mine[q]].cents;
        if (events[j].after - early < cushion) ok = false;
      }
      if (!ok) break; // paying more early only lowers balances further
      best = { count: m + 1, cents: sum, total: mine.length, through: events[mine[m]].due };
    }
    return best;
  }

  /** the planner line for a plan's next payment: a name and a date, never an amount. It's due the day before the
   *  payment (a charge can land early in the morning) and shows up two days before that. */
  function reminderLine(plan, due) {
    const when = dayLabel(due).replace(',', ''), who = (plan.who || '').replace(/[|:]/g, ' ').replace(/\s+/g, ' ').trim();
    const title = plan.autopay === false ? `Pay ${who || 'the payment'} by ${when} (the amount is in Money)` : `${who ? who + ' payment' : 'Payment'} due ${when}: check in Money that it's covered`;
    return `add: ${title} | due ${addDays(due, -1)} | not_before ${addDays(due, -3)} | size small`;
  }

  // ---------- changes: each returns a new file; history rows are only ever added ----------
  const clone = (d) => JSON.parse(JSON.stringify(d));
  function nextId(d, p) {
    let n = 0;
    for (const x of [...d.plans, ...d.repeating, ...d.ledger]) { const m = String(x.id).match(/^([A-Z]+)(\d+)$/); if (m && m[1] === p) n = Math.max(n, +m[2]); }
    return p + (n + 1);
  }
  const row = (d, r) => { const x = clone(d); x.ledger.push({ id: nextId(x, 'L'), ...r }); return x; };
  const act = {
    have: (d, { date, at, cents: c }) => row(d, { type: 'have', date, at, cents: c }),
    paid: (d, { date, at, cents: c, plan, repeating, for: f, inHave, note }) => row(d, { type: 'paid', date, at, cents: c, ...(plan ? { plan } : {}), ...(repeating ? { repeating, for: f } : {}), ...(inHave ? { inHave: true } : {}), ...(note ? { note } : {}) }),
    got: (d, { date, at, cents: c, repeating, for: f, inHave, note }) => row(d, { type: 'got', date, at, cents: c, ...(repeating ? { repeating, for: f } : {}), ...(inHave ? { inHave: true } : {}), ...(note ? { note } : {}) }),
    undo: (d, { of, at }) => row(d, { type: 'undo', of, at }),
    cushion: (d, c) => { const x = clone(d); x.cushion = c; x.cushionSet = true; return x; },
    addPlan(d, { who, what, cents: c, count, every, first, autopay = null, note = '' }) {
      const x = clone(d);
      x.plans.push({ id: nextId(x, 'P'), who, what, autopay, note, payments: scheduleDates(first, every, count).map((due) => ({ due, cents: c })) });
      return x;
    },
    editPlan(d, id, fields) { const x = clone(d), p = x.plans.find((q) => q.id === id); Object.assign(p, fields); return x; },
    closePlan(d, id, closed = true) { const x = clone(d); x.plans.find((q) => q.id === id).closed = closed; return x; },
    removePlan(d, id) { const x = clone(d); x.plans = x.plans.filter((q) => q.id !== id); return x; },
    addRepeating(d, { kind, who, cents: c, every, from }) { const x = clone(d); x.repeating.push({ id: nextId(x, 'R'), kind, who, cents: c, every, from, until: null }); return x; },
    editRepeating(d, id, fields) { const x = clone(d); Object.assign(x.repeating.find((q) => q.id === id), fields); return x; },
    removeRepeating(d, id) { const x = clone(d); x.repeating = x.repeating.filter((q) => q.id !== id); return x; },
  };
  const used = (d, key, id) => d.ledger.some((x) => x[key] === id);

  // ---------- the screen ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }
  // the folder handle is remembered in this browser (IndexedDB), never the money itself
  const idb = (fn) => new Promise((res, rej) => {
    const o = indexedDB.open('planner-money', 1);
    o.onupgradeneeded = () => o.result.createObjectStore('handles');
    o.onerror = () => rej(o.error);
    o.onsuccess = () => { const t = o.result.transaction('handles', 'readwrite'), q = fn(t.objectStore('handles')); t.oncomplete = () => { res(q.result); o.result.close(); }; t.onerror = () => rej(t.error); };
  });
  /** money.json in a folder on this computer; before the first change of each day the old file is kept in backups/ */
  function folderStore(dir, today) {
    return {
      name: dir.name,
      async read() {
        try { const f = await (await dir.getFileHandle(FILE)).getFile(); return { text: await f.text() }; } catch (e) { if (e && e.name === 'NotFoundError') return null; throw e; }
      },
      async write(doc, before) {
        if (before != null) {
          const b = await dir.getDirectoryHandle('backups', { create: true }), name = `money-${today()}.json`;
          let kept = true;
          try { await b.getFileHandle(name); } catch (e) { if (e && e.name === 'NotFoundError') kept = false; else throw e; }
          if (!kept) { const w = await (await b.getFileHandle(name, { create: true })).createWritable(); await w.write(before); await w.close(); }
        }
        const w = await (await dir.getFileHandle(FILE, { create: true })).createWritable(); // written whole, then swapped in
        await w.write(JSON.stringify(doc, null, 2) + '\n');
        await w.close();
      },
    };
  }
  /** made-up numbers for the demo (?mock=1): kept in memory, or in the browser's private test folder with &money=opfs */
  function demoDoc(today) {
    let d = emptyDoc();
    d = act.cushion(d, 25000);
    d = act.addPlan(d, { who: 'Phone store', what: 'Headphones', cents: 4500, count: 4, every: '2weeks', first: addDays(today, -10), autopay: true });
    d = act.addPlan(d, { who: '', what: '', cents: 9000, count: 1, every: 'once', first: addDays(today, 17) });
    d = act.addRepeating(d, { kind: 'in', who: 'Paycheck', cents: 52000, every: '2weeks', from: addDays(today, 11) });
    d = act.addRepeating(d, { kind: 'out', who: 'Rent', cents: null, every: 'month', from: addMonths(today, 1, 1) });
    d = act.paid(d, { date: addDays(today, -10), at: new Date().toISOString(), cents: 4500, plan: 'P1' });
    d = act.have(d, { date: today, at: new Date().toISOString(), cents: 41000 });
    return d;
  }
  function memoryStore(text) { let t = text; return { name: 'demo', async read() { return t == null ? null : { text: t }; }, async write(doc) { t = JSON.stringify(doc, null, 2) + '\n'; } }; }

  function mount(el, opts = {}) {
    const today = opts.today || (() => new Date().toISOString().slice(0, 10));
    const S = { doc: null, store: null, need: 'wait', err: '', open: null, saved: null, dir: null };
    const chan = (() => { try { return new BroadcastChannel('planner-money'); } catch { return null; } })();
    const lock = (fn) => (navigator.locks && navigator.locks.request ? navigator.locks.request('planner-money', fn) : fn());
    const nowISO = () => new Date().toISOString();
    // clock times as this laptop shows them (dates in the file follow the planner's day, from opts.today)
    const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const localDate = (iso) => { const t = new Date(iso); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
    let uid = 0;

    async function start() {
      try {
        if (opts.mock) {
          if (/(?:^|[?&])money=opfs(?:&|$)/.test(location.search) && navigator.storage && navigator.storage.getDirectory) {
            const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('money-demo', { create: true });
            S.store = folderStore(dir, today);
            if (!(await S.store.read())) await S.store.write(demoDoc(today()), null);
          } else S.store = memoryStore(JSON.stringify(demoDoc(today())));
          return await load();
        }
        if (!('showDirectoryPicker' in window)) { S.need = 'browser'; return draw(); }
        const dir = await idb((s) => s.get('dir')).catch(() => null);
        if (!dir) { S.need = 'choose'; return draw(); }
        S.dir = dir;
        const p = await dir.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
        if (p === 'granted') { S.store = folderStore(dir, today); return await load(); }
        S.need = 'reopen'; draw();
      } catch (e) { S.err = `Money couldn't start: ${e.message}`; draw(); }
    }
    async function choose() {
      let dir;
      try { dir = await window.showDirectoryPicker({ id: 'planner-money', mode: 'readwrite' }); } catch (e) { if (e && e.name === 'AbortError') return; S.err = `That folder can't be used: ${e.message}`; return draw(); }
      S.dir = dir; S.store = folderStore(dir, today);
      await idb((s) => s.put(dir, 'dir')).catch(() => {});
      await load(true);
    }
    async function reopen() {
      try { if ((await S.dir.requestPermission({ mode: 'readwrite' })) === 'granted') { S.store = folderStore(S.dir, today); await load(); } } catch (e) { S.err = `The folder didn't open: ${e.message}`; draw(); }
    }
    /** read the file; a folder without one gets a new, empty money file; a file that can't be read is never touched */
    async function load(fresh) {
      try {
        const got = await S.store.read();
        if (!got) {
          if (!fresh && !opts.mock) { S.err = `There's no ${FILE} in “${S.store.name}” any more. Choose the folder that has it, or this one again to start a new file.`; S.doc = null; S.need = 'choose'; return draw(); }
          S.doc = emptyDoc(); await S.store.write(S.doc, null);
        } else {
          let doc;
          try { doc = JSON.parse(got.text); } catch { doc = null; }
          const bad = check(doc);
          if (bad.length) { S.doc = null; S.need = null; S.err = `${FILE} in “${S.store.name}” can't be read (${bad[0]}), so nothing was changed. Yesterday's copy is in its backups folder.`; return draw(); }
          S.doc = doc;
        }
        S.need = null; S.err = '';
      } catch (e) { S.err = `Couldn't read the money file: ${e.message}`; }
      draw();
    }
    /** every change starts from the file as it is now (another window may have changed it), passes the checks, then is saved */
    async function change(fn) {
      try {
        await lock(async () => {
          const got = await S.store.read();
          let cur = S.doc;
          if (got) { try { cur = JSON.parse(got.text); } catch { cur = null; } if (check(cur).length) throw new Error(`${FILE} changed into something this page can't read`); }
          const nx = fn(cur);
          const bad = check(nx);
          if (bad.length) throw new Error(`the change didn't pass the checks (${bad[0]})`);
          nx.saved = nowISO();
          await S.store.write(nx, got ? got.text : null);
          S.doc = nx; S.saved = nx.saved;
        });
        S.open = null; S.err = '';
        try { chan?.postMessage('changed'); } catch {}
      } catch (e) { S.err = `Not saved: ${e.message}. Nothing was changed.`; }
      draw();
    }
    if (chan) chan.onmessage = () => { if (S.store && !S.open) load(); };
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.store && !S.open && el.offsetParent !== null) load(); });

    // ---- small pieces ----
    const btn = (text, onclick, cls = 'btn small') => h('button', { class: cls, type: 'button', onclick }, text);
    // S.open = the one form that is open: { kind, id, due, at } where `at` says where it opened (checks, list or plan)
    const opener = (key) => () => { S.open = key; draw(); };
    const isOpen = (kind, id) => S.open && S.open.kind === kind && (id == null || S.open.id === id);
    const openAt = (at, id, due) => (S.open && S.open.at === at && (id == null || S.open.id === id) && (due == null || S.open.due === due) ? openForm() : null);
    /** a little form: label + input per field, Save and Cancel; save(values) returns an error to show, or nothing */
    function form(fields, save, saveText = 'Save', noCancel = false) {
      const box = h('div', { class: 'confirm mny-form' }), inputs = {};
      for (const f of fields) {
        const id = `mny-${f.name}-${++uid}`;
        const input = f.options ? h('select', { id }, f.options.map(([v, t]) => h('option', { value: v, selected: v === f.value }, t)))
          : h('input', { id, type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || null, inputmode: f.money ? 'decimal' : null, autocomplete: 'off', min: f.min || null, max: f.max || null });
        inputs[f.name] = input;
        box.appendChild(h('div', { class: 'field' }, h('label', { for: id, text: f.label }), input, f.hint ? h('small', { class: 'dim', text: f.hint }) : null));
      }
      const msg = h('p', { class: 'status bad', role: 'status' });
      const go = async () => { const v = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()])); const err = await save(v); if (err) msg.textContent = err; };
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); go(); } });
      box.append(msg, h('div', { class: 'row' }, btn(saveText, go, 'btn primary small'), noCancel ? null : btn('Cancel', () => { S.open = null; draw(); })));
      setTimeout(() => { const first = box.querySelector('input,select'); if (first) first.focus(); }, 0);
      return box;
    }
    const amountErr = 'Type an amount like 45.10.';
    const pastDate = (v) => (isDate(v) && v <= today() ? null : 'Pick today or a day before.');
    /** a payment or paycheck dated the day you last typed what you have: ask whether that amount already had it */
    function record(kind, values) {
      const { snap } = cashNow(rowsOf(S.doc));
      const base = { ...values, at: nowISO() };
      if (snap && values.date === snap.date) { S.open = { ...S.open, kind: 'same', row: { kind, base } }; draw(); return; }
      change((d) => act[kind](d, base));
    }
    function sameDay() {
      const { snap } = cashNow(rowsOf(S.doc)), { kind, base } = S.open.row;
      const what = kind === 'got' ? 'Had it already come in' : 'Had it already gone out';
      return h('div', { class: 'confirm', role: 'dialog', 'aria-label': 'Already counted?' },
        h('p', { text: `You typed ${usd(snap.cents)} at ${time(snap.at)} on ${dayLabel(snap.date)}. ${what} when you typed that?` }),
        h('div', { class: 'row' },
          btn(kind === 'got' ? 'Yes, it was already in' : 'Yes, it was already out', () => change((d) => act[kind](d, { ...base, inHave: true })), 'btn primary small'),
          btn(kind === 'got' ? 'No, add it' : 'No, take it off', () => change((d) => act[kind](d, base))),
          btn('Cancel', () => { S.open = null; draw(); })));
    }

    // ---- the parts of the screen ----
    function answer(P) {
      const card = h('section', { class: 'card', 'aria-label': 'Where you stand' });
      card.appendChild(h('div', { class: 'kicker', text: `Today · ${dayLabel(P.today)}` }));
      if (P.cash == null) {
        card.append(h('h1', { class: 'step', text: 'How much money do you have right now?' }),
          h('p', { class: 'why', text: 'Check your bank app and type what is there. Everything on this screen is counted from it.' }));
        card.appendChild(haveForm(true));
        return card;
      }
      const when = P.lowAt === P.today ? 'today' : `on ${dayLabel(P.lowAt)}`, fs = P.firstShort;
      const head = P.low < 0 ? (fs ? `Not enough for everything: ${usd(-fs.after)} short on ${dayLabel(fs.date)}${fs.who ? ` (${fs.who})` : ''}.` : `You're ${usd(-P.cash)} below zero right now.`)
        : P.low < P.cushion ? (P.lowAt === P.today ? `You have ${usd(P.cash)}, under your ${usd(P.cushion)} cushion.` : `Every payment is covered, but your cushion gets used: ${usd(P.low)} left at the lowest, ${when}.`)
          : 'Every payment is covered, and your cushion stays.';
      card.appendChild(h('h1', { class: 'step mny-head', text: head }));
      const lines = h('div', { class: 'mny-lines' });
      if (P.spare > 0) lines.appendChild(h('p', {}, 'Spare after everything through ', h('b', { text: dayLabel(P.until) }), ': ', h('b', { class: 'mny-big', text: usd(P.spare) }), `. You could use that and still keep your ${usd(P.cushion)} cushion.`));
      else if (P.spare === 0) lines.appendChild(h('p', { text: `Nothing spare: everything to come leaves exactly your ${usd(P.cushion)} cushion.` }));
      else if (P.low >= 0) {
        const first = P.firstCushion && P.firstCushion.date !== P.lowAt ? ` It's first used on ${dayLabel(P.firstCushion.date)}.` : '';
        lines.appendChild(h('p', { text: `Nothing spare yet: to keep your whole ${usd(P.cushion)} cushion through ${dayLabel(P.lowAt)} you'd need ${usd(-P.spare)} more.${first}` }));
      }
      else lines.appendChild(h('p', { text: `To cover everything through ${dayLabel(P.until)} you'd need ${usd(-P.low)} more by ${dayLabel(P.lowAt)}, plus your ${usd(P.cushion)} cushion. Move money in, or ask the lender for a later date before then.` }));
      for (const w of P.window.slice(0, 2)) lines.appendChild(h('p', { text: `After the ${w.who.toLowerCase()} on ${dayLabel(w.date)}: ${usd(w.spare)} spare.` }));
      const ahead = aheadLines(P);
      if (ahead.length) lines.append(h('div', { class: 'sub', text: ahead.length > 1 ? 'Paying extra (each line on its own, not all together)' : 'Paying extra' }), ...ahead);
      card.appendChild(lines);
      const todo = checksList(P);
      if (todo) card.appendChild(todo);
      card.appendChild(haveLine(P));
      return card;
    }
    function aheadLines(P) {
      const out = [];
      for (const plan of S.doc.plans.filter((p) => !p.closed)) {
        const steps = P.ahead[plan.id] || [], due = P.plans[plan.id]?.next?.due;
        const name = plan.who || plan.what || (due ? `The ${dayLabel(due)} payment` : 'The payment');
        if (!steps.length) continue;
        const now = steps[0].who == null && steps[0].count ? steps[0] : null, all = steps.find((s) => s.count && s.count === s.total);
        const after = (s) => `after the ${s.who.toLowerCase()} on ${dayLabel(s.date)}`;
        let t;
        if (now && all === now) t = `${name}: you could pay off the rest now (${usd(now.cents)}) and keep your cushion.`;
        else if (now) t = `${name}: you could pay the next ${now.count === 1 ? 'payment' : now.count + ' payments'} now (${usd(now.cents)}) and keep your cushion.` + (all ? ` All of it ${after(all)}.` : '');
        else if (all) t = `${name}: paying ahead isn't safe yet. You could pay it all off ${after(all)}.`;
        else { const s = steps.find((x) => x.count); t = s ? `${name}: paying ahead isn't safe yet; ${after(s)} you could pay the next ${s.count === 1 ? 'one' : s.count}.` : `${name}: paying ahead isn't safe yet; pay it as scheduled.`; }
        out.push(h('p', { text: t }));
      }
      return out;
    }
    function checksList(P) {
      const items = [];
      for (const e of P.events.filter((x) => x.late)) items.push(h('li', {}, h('span', { class: 't', text: `${e.who || 'A payment'} was due ${dayLabel(e.due)} (${usd(e.cents)}). Did it go through?` }), btn('Yes, paid', opener(e.plan ? { kind: 'paid', id: e.plan, due: e.due, at: 'checks' } : { kind: 'bill', id: e.repeating, due: e.due, at: 'checks' }))));
      for (const c of P.checks) items.push(h('li', {}, h('span', { class: 't', text: `${c.who} was due ${dayLabel(c.due)} (${usd(c.cents)}). Did it come in?` }), btn('Yes, it came in', opener({ kind: 'got', id: c.repeating, due: c.due, at: 'checks' }))));
      if (P.gaps.length) items.push(h('li', {}, h('span', { class: 't', text: `Not counted yet, no amount: ${P.gaps.map((g) => g.who).join(', ')}.` }), btn('Add the amounts', () => { S.open = { kind: 'rep', id: P.gaps[0].id }; draw(); el.querySelector('#mny-regular')?.scrollIntoView({ block: 'start' }); })));
      if (!items.length) return null;
      return h('div', {}, h('div', { class: 'sub', text: 'To check' }), h('ul', { class: 'list mny-checks' }, items), openAt('checks'));
    }
    function haveLine(P) {
      const wrap = h('div', { class: 'mny-have' });
      const moved = P.since.reduce((t, x) => t + (x.type === 'got' ? x.cents : -x.cents), 0);
      wrap.appendChild(h('p', { class: 'dim' }, 'Money you have: ', h('b', { class: 'mny-ink', text: usd(P.cash) }),
        ` · you typed ${usd(P.snap.cents)} on ${dayLabel(P.snap.date)} at ${time(P.snap.at)}` + (moved ? `, ${moved > 0 ? '+' : '−'}${usd(Math.abs(moved))} marked since` : '') + ' ',
        isOpen('have') ? null : h('button', { class: 'linkbtn', type: 'button', onclick: opener({ kind: 'have' }) }, 'Update')));
      if (isOpen('have')) wrap.appendChild(haveForm());
      return wrap;
    }
    function haveForm(first) {
      return form([{ name: 'amt', label: 'Money you have right now', money: true, placeholder: '0.00', hint: 'What your bank shows as available. A minus sign is fine if you are overdrawn.' }], (v) => {
        const neg = /^[-−]/.test(v.amt), c = cents(v.amt.replace(/^[-−]\s*/, ''));
        if (c == null) return amountErr;
        change((d) => act.have(d, { date: today(), at: nowISO(), cents: neg ? -c : c }));
      }, 'Save', first);
    }
    /** the open "paid / came in" form (or its "already counted?" question) */
    function openForm() {
      const o = S.open;
      if (o.kind === 'same') return sameDay();
      if (o.kind === 'paid' || o.kind === 'extra') {
        const plan = S.doc.plans.find((p) => p.id === o.id), st = planState(plan, rowsOf(S.doc)), nx = st.next;
        const def = o.kind === 'paid' && nx ? nx.left : null, date = o.kind === 'paid' && nx && nx.due <= today() ? nx.due : today();
        return form([{ name: 'amt', label: o.kind === 'extra' ? `Extra payment to ${plan.who || 'this plan'}` : `Paid to ${plan.who || 'this plan'}`, money: true, value: def != null ? (def / 100).toFixed(2) : '', placeholder: '0.00', hint: 'A payment covers the earliest payment still owed, then the next.' }, { name: 'date', label: 'The day it went out', type: 'date', value: date, max: today() }], (v) => {
          const c = cents(v.amt); if (c == null || c <= 0) return amountErr;
          if (c > st.left) return `That's more than the ${usd(st.left)} still owed.`;
          const bad = pastDate(v.date); if (bad) return bad;
          record('paid', { date: v.date, cents: c, plan: plan.id });
        });
      }
      if (o.kind === 'bill' || o.kind === 'got') {
        const r = S.doc.repeating.find((x) => x.id === o.id);
        return form([{ name: 'amt', label: o.kind === 'got' ? `${r.who} that came in` : `Paid for ${r.who}`, money: true, value: r.cents ? (r.cents / 100).toFixed(2) : '', placeholder: '0.00' }, { name: 'date', label: o.kind === 'got' ? 'The day it came in' : 'The day it went out', type: 'date', value: o.due <= today() ? o.due : today(), max: today() }], (v) => {
          const c = cents(v.amt); if (c == null || c <= 0) return amountErr;
          const bad = pastDate(v.date); if (bad) return bad;
          record(o.kind === 'got' ? 'got' : 'paid', { date: v.date, cents: c, repeating: r.id, for: o.due });
        });
      }
      return null;
    }

    function comingUp(P) {
      const box = h('section', { class: 'panel', 'aria-label': 'Coming up' }), pad = h('div', { class: 'pad' });
      box.appendChild(pad);
      pad.appendChild(h('h3', { class: 'mny', text: 'Coming up' }));
      pad.appendChild(h('p', { class: 'dim mny-sub', text: P.cash == null ? `Through ${dayLabel(P.until)}. Type what you have to see what's left after each one.` : `Through ${dayLabel(P.until)}, with what you'd have left after each one.` }));
      if (!P.events.length) { pad.appendChild(h('p', { class: 'dim', text: 'Nothing coming up.' })); return box; }
      const ul = h('ul', { class: 'list' });
      for (const e of P.events) {
        const label = e.plan ? (e.who || 'Who is this for?') + (e.of > 1 ? ` · payment ${e.n} of ${e.of}` : '') + (e.part ? ' (the rest of it)' : '') : e.who;
        const badge = e.late ? h('span', { class: 'badge bad', text: 'past due' }) : e.status === 'short' ? h('span', { class: 'badge bad', text: `short ${usd(-e.after)}` }) : e.status === 'cushion' ? h('span', { class: 'badge warn', text: 'uses the cushion' }) : null;
        const id = e.plan || e.repeating, key = { kind: e.plan ? 'paid' : e.dir > 0 ? 'got' : 'bill', id, due: e.due, at: 'list' };
        const open = openAt('list', id, e.due);
        ul.appendChild(h('li', { class: 'mny-row' },
          h('span', { class: 'd', text: dayLabel(e.date) }),
          h('span', { class: 't' }, label, e.plan && e.what ? h('small', { text: e.what }) : null),
          h('span', { class: 'a' + (e.dir > 0 ? ' mny-in' : '') }, (e.dir > 0 ? '+' : '−') + usd(e.cents).replace(/^−?/, ''), e.after != null ? h('small', { text: `${usd(e.after)} left` }) : null),
          badge,
          open ? null : btn(e.dir > 0 ? 'Came in' : 'Paid', opener(key))));
        if (open) ul.appendChild(h('li', { class: 'mny-formrow' }, open));
      }
      pad.appendChild(ul);
      return box;
    }

    function owe(P) {
      const box = h('section', { class: 'panel', 'aria-label': 'What you owe' }), pad = h('div', { class: 'pad' });
      box.appendChild(pad);
      const plans = S.doc.plans.filter((p) => !p.closed);
      pad.append(h('h3', { class: 'mny', text: 'What you owe' }), h('p', { class: 'dim mny-sub', text: plans.length ? `${usd(P.owed)} in all.` : 'Nothing yet.' }));
      for (const plan of plans) {
        const st = P.plans[plan.id], nx = st.next;
        const block = h('div', { class: 'mny-plan' });
        block.appendChild(h('div', { class: 'mny-ptitle' }, h('b', { text: plan.who || 'Who is this for?' }), plan.what ? h('span', { class: 'dim', text: ` · ${plan.what}` }) : null));
        const auto = plan.autopay === true ? 'autopay on' : plan.autopay === false ? 'you pay it yourself' : 'autopay: not set';
        block.appendChild(h('p', { class: 'dim', text: st.left ? `Paid ${st.done} of ${st.pays.length} · ${usd(st.left)} left · next ${usd(nx.left)} on ${dayLabel(nx.due)} · ${auto}` : `Paid off (${usd(st.total)}).` }));
        if (plan.note) block.appendChild(h('p', { class: 'dim mny-small', text: plan.note }));
        const pays = h('ul', { class: 'mny-pays' }, st.pays.map((p) => h('li', { class: p.left ? '' : 'done', text: `${dayLabel(p.due)} · ${usd(p.cents)}${p.left === 0 ? ' · paid' : p.paid ? ` · ${usd(p.paid)} paid, ${usd(p.left)} left` : ''}` })));
        block.appendChild(pays);
        const row = h('div', { class: 'row' });
        if (st.left) {
          row.append(btn('Paid', opener({ kind: 'paid', id: plan.id, at: 'plan' })), btn('Pay extra', opener({ kind: 'extra', id: plan.id, at: 'plan' })));
          const due = st.pays.find((p) => p.left > 0 && p.due >= today())?.due;
          if (opts.send && due) row.appendChild(plan.reminded === due ? h('span', { class: 'dim mny-small', text: `On the planner: ${dayLabel(due)} ✓` }) : btn('Remind me on the planner', () => remind(plan, due)));
        } else row.appendChild(btn('Put it away', () => change((d) => act.closePlan(d, plan.id))));
        row.appendChild(btn('Edit', opener({ kind: 'editPlan', id: plan.id })));
        block.appendChild(row);
        const f = openAt('plan', plan.id);
        if (f) block.appendChild(f);
        if (isOpen('editPlan', plan.id)) block.appendChild(editPlan(plan));
        pad.appendChild(block);
      }
      pad.appendChild(isOpen('addPlan') ? addPlanForm() : h('div', { class: 'row', style: 'margin-top:14px' }, btn('Add something you owe', opener({ kind: 'addPlan' }))));
      const closed = S.doc.plans.filter((p) => p.closed);
      if (closed.length) pad.appendChild(h('p', { class: 'dim mny-small', text: `Put away: ${closed.map((p) => p.who || p.what || p.id).join(', ')}.` }));
      return box;
    }
    function remind(plan, due) {
      // a name and a date only: amounts never go to GitHub
      opts.send([reminderLine(plan, due)], `a reminder for ${plan.who || 'the payment'} on ${dayLabel(due)}`);
      change((d) => act.editPlan(d, plan.id, { reminded: due }));
    }
    function addPlanForm() {
      return form([
        { name: 'who', label: 'Who you owe', placeholder: 'the lender or the store' },
        { name: 'what', label: 'What it was for (optional)' },
        { name: 'amt', label: 'Each payment', money: true, placeholder: '0.00' },
        { name: 'count', label: 'How many payments', type: 'number', value: '4', min: '1', max: '120' },
        { name: 'every', label: 'How often', options: [['2weeks', 'every 2 weeks'], ['month', 'every month'], ['week', 'every week'], ['once', 'just once']], value: '2weeks' },
        { name: 'first', label: 'The first payment still to come', type: 'date', value: addDays(today(), 14) },
      ], (v) => {
        if (!v.who && !v.what) return 'Say who you owe, or what it was for.';
        const c = cents(v.amt); if (c == null || c <= 0) return amountErr;
        const n = v.every === 'once' ? 1 : Number(v.count);
        if (!Number.isInteger(n) || n < 1 || n > 120) return 'Type how many payments, 1 to 120.';
        if (!isDate(v.first)) return 'Pick the date of the first payment.';
        change((d) => act.addPlan(d, { who: v.who, what: v.what, cents: c, count: n, every: v.every, first: v.first }));
      }, 'Add it');
    }
    function editPlan(plan) {
      const fields = [
        { name: 'who', label: 'Who you owe', value: plan.who },
        { name: 'what', label: 'What it was for', value: plan.what },
        { name: 'autopay', label: 'Autopay', options: [['', 'not set'], ['yes', 'on: they take it'], ['no', 'off: I pay it myself']], value: plan.autopay === true ? 'yes' : plan.autopay === false ? 'no' : '' },
        { name: 'note', label: 'Note', value: plan.note || '' },
      ];
      plan.payments.forEach((p, i) => fields.push({ name: `due${i}`, label: `Payment ${i + 1}: date`, type: 'date', value: p.due }, { name: `amt${i}`, label: `Payment ${i + 1}: amount`, money: true, value: (p.cents / 100).toFixed(2) }));
      const box = form(fields, (v) => {
        const payments = [];
        for (let i = 0; i < plan.payments.length; i++) { const c = cents(v[`amt${i}`]); if (c == null || c <= 0) return `Payment ${i + 1}: ${amountErr}`; if (!isDate(v[`due${i}`])) return `Payment ${i + 1}: pick a date.`; payments.push({ due: v[`due${i}`], cents: c }); }
        change((d) => act.editPlan(d, plan.id, { who: v.who, what: v.what, note: v.note, autopay: v.autopay === 'yes' ? true : v.autopay === 'no' ? false : null, payments }));
      });
      const del = used(S.doc, 'plan', plan.id)
        ? btn('Put it away (paid off or cancelled)', () => { if (confirm(`Put away ${plan.who || 'this plan'}? It stops counting; its history stays.`)) change((d) => act.closePlan(d, plan.id)); })
        : btn('Delete it (added by mistake)', () => { if (confirm(`Delete ${plan.who || 'this plan'}? Nothing was paid on it yet.`)) change((d) => act.removePlan(d, plan.id)); });
      box.appendChild(h('div', { class: 'row', style: 'margin-top:10px' }, del));
      return box;
    }

    function regular(P) {
      const box = h('section', { class: 'panel', id: 'mny-regular', 'aria-label': 'Paychecks and bills' }), pad = h('div', { class: 'pad' });
      box.appendChild(pad);
      pad.append(h('h3', { class: 'mny', text: 'Paychecks and bills' }), h('p', { class: 'dim mny-sub', text: 'Money that comes in or goes out on a schedule. Leave an amount blank until you know it: it shows as not counted.' }));
      const live = S.doc.repeating.filter((r) => !r.until || r.until >= today());
      if (!live.length) pad.appendChild(h('p', { class: 'dim', text: 'None yet.' }));
      for (const r of live) {
        const nx = occurrences(r, today(), addDays(today(), 400))[0];
        pad.appendChild(h('div', { class: 'mny-plan' },
          h('div', { class: 'mny-ptitle' }, h('b', { text: r.who }), h('span', { class: 'dim', text: r.kind === 'in' ? ' · coming in' : ' · going out' })),
          h('p', { class: 'dim', text: `${r.cents == null ? 'Amount not set' : (r.kind === 'in' ? '+' : '−') + usd(r.cents).replace(/^−?/, '')} · ${EVERY[r.every]}${nx ? ` · next ${dayLabel(nx)}` : ''}` }),
          isOpen('rep', r.id) ? editRep(r) : h('div', { class: 'row' }, btn(r.cents == null ? 'Add the amount' : 'Edit', opener({ kind: 'rep', id: r.id })))));
      }
      if (isOpen('addRep')) pad.appendChild(addRepForm(S.open.dir));
      else pad.appendChild(h('div', { class: 'row', style: 'margin-top:14px' }, btn('Add a paycheck', opener({ kind: 'addRep', dir: 'in' })), btn('Add a bill', opener({ kind: 'addRep', dir: 'out' }))));
      return box;
    }
    const repFields = (r, dir) => [
      { name: 'who', label: dir === 'in' ? 'Name' : 'What it is', value: r ? r.who : dir === 'in' ? 'Paycheck' : '', placeholder: dir === 'in' ? 'Paycheck' : 'Rent, phone, insurance…' },
      { name: 'amt', label: 'Amount (blank if you don’t know yet)', money: true, value: r && r.cents ? (r.cents / 100).toFixed(2) : '', placeholder: '0.00' },
      { name: 'every', label: 'How often', options: [['2weeks', 'every 2 weeks'], ['week', 'every week'], ['month', 'every month (same date)']], value: r ? r.every : dir === 'in' ? '2weeks' : 'month' },
      { name: 'from', label: r ? 'One of its dates' : 'The next one', type: 'date', value: r ? (occurrences(r, today(), addDays(today(), 400))[0] || r.from) : addDays(today(), 7) },
    ];
    function readRep(v) {
      if (!v.who) return { err: 'Give it a name.' };
      const c = v.amt ? cents(v.amt) : null;
      if (v.amt && (c == null || c <= 0)) return { err: amountErr };
      if (!isDate(v.from)) return { err: 'Pick a date.' };
      return { who: v.who, cents: c, every: v.every, from: v.from };
    }
    function addRepForm(dir) {
      return form(repFields(null, dir), (v) => { const r = readRep(v); if (r.err) return r.err; change((d) => act.addRepeating(d, { kind: dir, ...r })); }, 'Add it');
    }
    function editRep(r) {
      const shown = occurrences(r, today(), addDays(today(), 400))[0] || r.from;
      const box = form(repFields(r, r.kind), (v) => {
        const x = readRep(v); if (x.err) return x.err;
        // the date shown is the next one; left as it was, the schedule keeps its own start
        change((d) => act.editRepeating(d, r.id, { ...x, from: x.from === shown ? r.from : x.from }));
      });
      box.appendChild(h('div', { class: 'row', style: 'margin-top:10px' }, used(S.doc, 'repeating', r.id)
        ? btn('Stop it', () => change((d) => act.editRepeating(d, r.id, { until: addDays(today(), -1) })))
        : btn('Delete it', () => { if (confirm(`Delete ${r.who}?`)) change((d) => act.removeRepeating(d, r.id)); })));
      return box;
    }

    function cushionPart() {
      const box = h('section', { class: 'panel', 'aria-label': 'Emergency cushion' }), pad = h('div', { class: 'pad' });
      box.appendChild(pad);
      pad.append(h('h3', { class: 'mny', text: 'Emergency cushion' }),
        h('p', { class: 'dim mny-sub' }, `The money kept for something going wrong. The safe numbers above never count it. Now: `, h('b', { class: 'mny-ink', text: usd(S.doc.cushion) }), S.doc.cushionSet ? '.' : ' (a starting suggestion: set your own).'));
      pad.appendChild(isOpen('cushion') ? form([{ name: 'amt', label: 'Keep at least', money: true, value: (S.doc.cushion / 100).toFixed(2) }], (v) => { const c = cents(v.amt); if (c == null) return amountErr; change((d) => act.cushion(d, c)); })
        : h('div', { class: 'row' }, btn('Change it', opener({ kind: 'cushion' }))));
      return box;
    }

    function history() {
      const box = h('details', { class: 'panel mny-hist', open: S.histOpen || null, ontoggle: () => { S.histOpen = box.open; } }), pad = h('div', { class: 'pad' });
      box.append(h('summary', { class: 'pad', text: 'History' }), pad);
      const gone = new Set(S.doc.ledger.filter((x) => x.type === 'undo').map((x) => x.of));
      const name = (x) => { if (x.plan) return S.doc.plans.find((p) => p.id === x.plan)?.who || 'a plan'; if (x.repeating) return S.doc.repeating.find((r) => r.id === x.repeating)?.who || 'a bill'; return ''; };
      const rows = S.doc.ledger.filter((x) => x.type !== 'undo').slice(-30).reverse();
      if (!rows.length) pad.appendChild(h('p', { class: 'dim', text: 'Nothing yet.' }));
      const ul = h('ul', { class: 'list' });
      for (const x of rows) {
        const t = x.type === 'have' ? `You had ${usd(x.cents)}` : x.type === 'paid' ? `Paid ${usd(x.cents)}${name(x) ? ' to ' + name(x) : ''}` : `${usd(x.cents)} came in${name(x) ? ' (' + name(x) + ')' : ''}`;
        ul.appendChild(h('li', { class: gone.has(x.id) ? 'mny-undone' : '' },
          h('span', { class: 'd', text: dayLabel(x.date) }),
          h('span', { class: 't', text: t + (x.inHave ? ' (already in what you typed)' : '') + (gone.has(x.id) ? ' · undone' : '') }),
          gone.has(x.id) ? null : btn('Undo', () => { if (confirm(`Undo “${t}”?`)) change((d) => act.undo(d, { of: x.id, at: nowISO() })); })));
      }
      pad.appendChild(ul);
      return box;
    }

    function fileBar() {
      const saved = S.doc.saved ? ` · saved ${localDate(S.doc.saved) === today() ? time(S.doc.saved) : dayLabel(localDate(S.doc.saved))}` : '';
      return h('div', { class: 'mny-file dim' },
        h('span', { text: opts.mock ? 'Demo with made-up numbers: nothing is saved to a file.' : `Kept in your “${S.store.name}” folder on this computer${saved}.` }),
        h('span', { class: 'row' },
          h('button', { class: 'linkbtn', type: 'button', onclick: download }, 'Download a copy'),
          opts.mock ? null : h('button', { class: 'linkbtn', type: 'button', onclick: choose }, 'Use another folder')));
    }
    function download() {
      const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(S.doc, null, 2) + '\n'], { type: 'application/json' })), download: `money-copy-${today()}.json` });
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    function draw() {
      el.textContent = '';
      el.append(h('h2', { class: 'view', text: 'Money' }), h('p', { class: 'dim mny-note', text: 'Laptop only. Your numbers stay in a folder on this computer; nothing on this screen is sent to GitHub or anywhere else.' }));
      if (S.err) el.appendChild(h('div', { class: 'alert', role: 'alert' }, h('div', { text: S.err })));
      if (S.need === 'wait') { el.appendChild(h('p', { class: 'dim', text: 'Opening…' })); return; }
      if (S.need === 'browser') { el.appendChild(h('section', { class: 'card' }, h('h1', { class: 'step', text: 'Open Money on your laptop' }), h('p', { class: 'why', text: 'It needs Chrome or Edge on a computer: they can keep a file on the computer itself. Phones and other browsers can’t.' }))); return; }
      if (S.need === 'choose') {
        el.appendChild(h('section', { class: 'card' }, h('div', { class: 'kicker', text: 'Set up' }), h('h1', { class: 'step', text: 'Choose the folder for your money file' }),
          h('p', { class: 'why', text: 'Pick a folder on this laptop that isn’t synced online (not inside OneDrive and not a GitHub folder), for example a folder called Money in your user folder. The page keeps money.json there, plus a copy in backups/ each day before the first change.' }),
          h('div', { class: 'row' }, btn('Choose the folder', choose, 'btn primary'))));
        return;
      }
      if (S.need === 'reopen') {
        el.appendChild(h('section', { class: 'card' }, h('h1', { class: 'step', text: `Open your “${S.dir.name}” folder` }), h('p', { class: 'why', text: 'The browser asks before this page can read it again.' }),
          h('div', { class: 'row' }, btn('Open it', reopen, 'btn primary'), btn('Use another folder', choose))));
        return;
      }
      if (!S.doc) return;
      const P = project(S.doc, today());
      el.append(answer(P), comingUp(P), owe(P), regular(P), cushionPart(), history(), fileBar());
    }

    draw();
    start();
    return { reload: () => load(), state: S };
  }

  const api = { FORMAT, VERSION, cents, usd, isDate, addDays, addMonths, dayLabel, scheduleDates, occurrences, emptyDoc, check, rowsOf, cashNow, planState, project, aheadFrom, reminderLine, act, nextId, demoDoc, folderStore, mount };
  root.PlannerMoney = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
