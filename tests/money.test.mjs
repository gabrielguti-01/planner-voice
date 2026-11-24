// Tests for money.js (the laptop view's Money tab). Made-up numbers only. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../money.js');
const { act, project, cents, usd } = M;
const AT = '2030-03-04T15:00:00.000Z';
const doc = (f) => f(M.emptyDoc());

test('amounts are read exactly, in whole cents, and never guessed', () => {
  assert.equal(cents('45.10'), 4510);
  assert.equal(cents('$1,234.5'), 123450);
  assert.equal(cents('.5'), 50);
  assert.equal(cents('0'), 0);
  assert.equal(cents('12'), 1200);
  for (const bad of ['', 'abc', '12.345', '1,23', '-5', '5-', '$', '1.2.3', '1e3', ' 4 5 ']) assert.equal(cents(bad), null, bad);
  assert.equal(usd(4510), '$45.10');
  assert.equal(usd(-1250), '−$12.50');
  assert.equal(usd(123456789), '$1,234,567.89');
  assert.equal(usd(5), '$0.05');
});

test('dates: months keep their day (the 31st becomes the last day), schedules and repeats land on the right days', () => {
  assert.equal(M.addMonths('2030-01-31', 1, 31), '2030-02-28');
  assert.equal(M.addMonths('2030-01-31', 2, 31), '2030-03-31');
  assert.equal(M.addMonths('2030-11-15', 3, 15), '2031-02-15');
  assert.equal(M.isDate('2030-02-30'), false);
  assert.equal(M.isDate('2030-02-28'), true);
  assert.deepEqual(M.scheduleDates('2030-02-25', '2weeks', 4), ['2030-02-25', '2030-03-11', '2030-03-25', '2030-04-08']);
  assert.deepEqual(M.scheduleDates('2030-01-31', 'month', 3), ['2030-01-31', '2030-02-28', '2030-03-31']);
  assert.deepEqual(M.scheduleDates('2030-05-01', 'once', 9), ['2030-05-01']);
  assert.deepEqual(M.occurrences({ every: 'month', from: '2030-01-31' }, '2030-01-01', '2030-04-30'), ['2030-01-31', '2030-02-28', '2030-03-31', '2030-04-30']);
  assert.deepEqual(M.occurrences({ every: '2weeks', from: '2030-01-01' }, '2030-01-20', '2030-02-20'), ['2030-01-29', '2030-02-12']);
  assert.deepEqual(M.occurrences({ every: 'week', from: '2030-01-01', until: '2030-01-16' }, '2030-01-01', '2030-02-28'), ['2030-01-01', '2030-01-08', '2030-01-15']);
});

test('payments cover the earliest payment owed first, and an extra payment carries into the next ones', () => {
  let d = doc((x) => act.addPlan(x, { who: 'Shop', what: '', cents: 4500, count: 4, every: '2weeks', first: '2030-03-01' }));
  d = act.paid(d, { date: '2030-03-01', at: AT, cents: 4500, plan: 'P1' });
  d = act.paid(d, { date: '2030-03-02', at: AT, cents: 6000, plan: 'P1' });
  const st = M.planState(d.plans[0], M.rowsOf(d));
  assert.deepEqual(st.pays.map((p) => [p.paid, p.left]), [[4500, 0], [4500, 0], [1500, 3000], [0, 4500]]);
  assert.equal(st.left, 7500);
  assert.equal(st.done, 2);
  assert.equal(st.next.due, '2030-03-29');
  assert.deepEqual(M.check(d), []);
});

test('the money you have: what you typed, then what was marked after it; earlier or already-counted rows change nothing; undo works', () => {
  let d = M.emptyDoc();
  d = act.paid(d, { date: '2030-02-27', at: AT, cents: 999 }); // before anything was typed
  d = act.have(d, { date: '2030-03-01', at: AT, cents: 15000 });
  d = act.paid(d, { date: '2030-03-02', at: AT, cents: 1000 }); // after: counts
  d = act.paid(d, { date: '2030-02-28', at: AT, cents: 700 }); // marked late, but dated before what was typed: already in it
  d = act.paid(d, { date: '2030-03-01', at: AT, cents: 300, inHave: true }); // same day, already in it
  d = act.got(d, { date: '2030-03-03', at: AT, cents: 2500 });
  assert.equal(M.cashNow(M.rowsOf(d)).cash, 15000 - 1000 + 2500);
  d = act.undo(d, { of: 'L6', at: AT }); // the 2500 that came in
  assert.equal(M.cashNow(M.rowsOf(d)).cash, 14000);
  d = act.have(d, { date: '2030-03-04', at: AT, cents: 20000 });
  assert.equal(M.cashNow(M.rowsOf(d)).cash, 20000);
  d = act.undo(d, { of: 'L8', at: AT });
  assert.equal(M.cashNow(M.rowsOf(d)).cash, 14000);
  assert.deepEqual(M.check(d), []);
});

test('no paychecks: every payment is covered, spare is the lowest point above the cushion, and paying ahead is checked', () => {
  let d = doc((x) => act.cushion(x, 20000));
  d = act.addPlan(d, { who: 'Shop', what: 'Desk', cents: 5000, count: 4, every: '2weeks', first: '2030-02-25' });
  d = act.addPlan(d, { who: '', what: '', cents: 8000, count: 1, every: 'once', first: '2030-03-20' });
  d = act.paid(d, { date: '2030-02-25', at: AT, cents: 5000, plan: 'P1' });
  d = act.have(d, { date: '2030-03-04', at: AT, cents: 50000 });
  const P = project(d, '2030-03-04');
  assert.deepEqual(P.events.map((e) => [e.date, e.dir * e.cents, e.after, e.status]), [
    ['2030-03-11', -5000, 45000, 'ok'], ['2030-03-20', -8000, 37000, 'ok'], ['2030-03-25', -5000, 32000, 'ok'], ['2030-04-08', -5000, 27000, 'ok']]);
  assert.equal(P.owed, 23000);
  assert.equal(P.low, 27000);
  assert.equal(P.lowAt, '2030-04-08');
  assert.equal(P.spare, 7000);
  assert.equal(P.until, '2030-05-05');
  assert.deepEqual(P.window, []);
  assert.deepEqual(P.ahead.P1.map((s) => [s.date, s.count, s.cents, s.total]), [['2030-03-04', 3, 15000, 3]]);
  assert.deepEqual(P.ahead.P2.map((s) => [s.count, s.cents]), [[1, 8000]]);
});

test('a paycheck opens the window: more is spare after it, and the rest can be paid ahead then', () => {
  let d = doc((x) => act.cushion(x, 20000));
  d = act.addPlan(d, { who: 'Shop', what: '', cents: 6000, count: 3, every: '2weeks', first: '2030-03-10' });
  d = act.addRepeating(d, { kind: 'in', who: 'Paycheck', cents: 40000, every: '2weeks', from: '2030-03-15' });
  d = act.have(d, { date: '2030-03-04', at: AT, cents: 30000 });
  const P = project(d, '2030-03-04');
  assert.deepEqual(P.events.slice(0, 5).map((e) => [e.date, e.dir * e.cents, e.after]), [
    ['2030-03-10', -6000, 24000], ['2030-03-15', 40000, 64000], ['2030-03-24', -6000, 58000], ['2030-03-29', 40000, 98000], ['2030-04-07', -6000, 92000]]);
  assert.equal(P.spare, 4000);
  assert.deepEqual(P.window.slice(0, 2).map((w) => [w.date, w.spare]), [['2030-03-15', 38000], ['2030-03-29', 72000]]);
  // now: only the next payment (paying two would leave 18000, under the cushion); after the paycheck: all that's left
  assert.deepEqual(P.ahead.P1.map((s) => [s.date, s.who, s.count, s.cents, s.total]), [['2030-03-04', null, 1, 6000, 3], ['2030-03-15', 'Paycheck', 2, 12000, 2]]);
});

test('overdue payments count today, unpaid bills since the last entry count, a missed payday is asked about, blank amounts are listed', () => {
  let d = doc((x) => act.cushion(x, 20000));
  d.plans.push({ id: 'P1', who: 'Shop', what: '', autopay: null, note: '', payments: [{ due: '2030-03-02', cents: 5000 }, { due: '2030-03-06', cents: 12000 }] });
  d = act.addRepeating(d, { kind: 'out', who: 'Rent', cents: null, every: 'month', from: '2030-03-01' });
  d = act.addRepeating(d, { kind: 'in', who: 'Paycheck', cents: 30000, every: 'week', from: '2030-03-02' });
  d = act.addRepeating(d, { kind: 'out', who: 'Phone', cents: 1500, every: 'month', from: '2030-02-03' });
  d = act.have(d, { date: '2030-03-01', at: AT, cents: 15000 });
  assert.deepEqual(M.check(d), []);
  const P = project(d, '2030-03-04');
  assert.deepEqual(P.events.slice(0, 4).map((e) => [e.date, e.due, e.who, e.dir * e.cents, e.after, e.status, !!e.late]), [
    ['2030-03-04', '2030-03-02', 'Shop', -5000, 10000, 'cushion', true],
    ['2030-03-04', '2030-03-03', 'Phone', -1500, 8500, 'cushion', true],
    ['2030-03-06', '2030-03-06', 'Shop', -12000, -3500, 'short', false],
    ['2030-03-09', '2030-03-09', 'Paycheck', 30000, 26500, 'in', false]]);
  assert.deepEqual(P.checks.map((c) => [c.who, c.due]), [['Paycheck', '2030-03-02']]);
  assert.deepEqual(P.gaps.map((g) => g.who), ['Rent']);
  assert.equal(P.low, -3500);
  assert.equal(P.lowAt, '2030-03-06');
  assert.equal(P.firstShort.date, '2030-03-06');
  assert.equal(P.firstCushion.date, '2030-03-04');
  assert.deepEqual(P.window.slice(0, 1).map((w) => [w.date, w.spare]), [['2030-03-09', 6500]]);
  // marking the phone bill paid takes it out of what's coming
  const d2 = act.paid(d, { date: '2030-03-03', at: AT, cents: 1500, repeating: 'R3', for: '2030-03-03' });
  assert.equal(project(d2, '2030-03-04').events.filter((e) => e.who === 'Phone' && e.due === '2030-03-03').length, 0);
});

test('the safe window only lists real room: a paycheck that still leaves you under the cushion opens nothing', () => {
  let d = doc((x) => act.cushion(x, 20000));
  d = act.addRepeating(d, { kind: 'in', who: 'Paycheck', cents: 5000, every: 'month', from: '2030-03-09' });
  d = act.have(d, { date: '2030-03-04', at: AT, cents: 1000 });
  const P = project(d, '2030-03-04');
  assert.equal(P.spare, -19000);
  assert.equal(P.lowAt, '2030-03-04');
  assert.deepEqual(P.window, []); // 6000 and 11000 after the paychecks: both still under the 20000 cushion
  // the window ends 62 days out (May 5), so May 9's paycheck isn't in it
  assert.deepEqual(project(act.have(d, { date: '2030-03-04', at: AT, cents: 18000 }), '2030-03-04').window.map((w) => [w.date, w.spare]), [['2030-03-09', 3000], ['2030-04-09', 8000]]);
});

test('nothing typed yet: the schedule still shows, with no balances and no safe numbers', () => {
  const d = doc((x) => act.addPlan(x, { who: 'Shop', what: '', cents: 5000, count: 2, every: 'month', first: '2030-03-10' }));
  const P = project(d, '2030-03-04');
  assert.equal(P.cash, null);
  assert.equal(P.events.length, 2);
  assert.ok(P.events.every((e) => e.after == null && e.status == null));
  assert.equal(P.spare, undefined);
  assert.equal(P.owed, 10000);
});

test('the file check refuses anything it cannot vouch for', () => {
  const ok = M.emptyDoc();
  assert.deepEqual(M.check(ok), []);
  assert.equal(M.check({ ...ok, format: 'other' }).length, 1);
  assert.match(M.check({ ...ok, version: 2 })[0], /version 2/);
  assert.ok(M.check({ ...ok, cushion: 1.5 }).length);
  const two = act.addPlan(act.addPlan(ok, { who: 'A', what: '', cents: 100, count: 1, every: 'once', first: '2030-01-01' }), { who: 'B', what: '', cents: 100, count: 1, every: 'once', first: '2030-01-01' });
  assert.deepEqual(M.check(two), []);
  two.plans[1].id = 'P1';
  assert.ok(M.check(two).some((x) => /repeated id/.test(x)));
  const zero = act.addPlan(ok, { who: 'A', what: '', cents: 0, count: 1, every: 'once', first: '2030-01-01' });
  assert.ok(M.check(zero).some((x) => /payments/.test(x)));
  const orphan = act.paid(ok, { date: '2030-01-01', at: AT, cents: 100, plan: 'P9' });
  assert.ok(M.check(orphan).some((x) => /its plan/.test(x)));
  const undoNothing = act.undo(ok, { of: 'L7', at: AT });
  assert.ok(M.check(undoNothing).some((x) => /undoes nothing/.test(x)));
  assert.ok(M.check(act.paid(ok, { date: '2030-02-30', at: AT, cents: 100 })).length);
});

test('a planner reminder carries a name and a date, never an amount', () => {
  const plan = { who: 'Shop | Co: x', autopay: null };
  const line = M.reminderLine(plan, '2030-03-10');
  // due the day before the payment, shown two days before that
  assert.match(line, /^add: Shop Co x payment due Sun Mar 10: check in Money that it's covered \| due 2030-03-09 \| not_before 2030-03-07 \| size small$/);
  assert.doesNotMatch(line, /\$|\d+\.\d\d/);
  assert.match(M.reminderLine({ who: '', autopay: false }, '2030-03-10'), /^add: Pay the payment by Sun Mar 10 \(the amount is in Money\) \|/);
});

test('the folder: a missing file reads as none; the first change of each day keeps the old file in backups/', async () => {
  const nf = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
  const fakeDir = (name) => {
    const files = new Map(), dirs = new Map();
    return {
      name, files, dirs,
      async getFileHandle(n, o = {}) {
        if (!files.has(n)) { if (!o.create) throw nf(); files.set(n, ''); }
        return { getFile: async () => ({ text: async () => files.get(n) }), createWritable: async () => { let buf = ''; return { write: async (s) => { buf += s; }, close: async () => { files.set(n, buf); } }; } };
      },
      async getDirectoryHandle(n, o = {}) { if (!dirs.has(n)) { if (!o.create) throw nf(); dirs.set(n, fakeDir(n)); } return dirs.get(n); },
    };
  };
  const dir = fakeDir('Money');
  let day = '2030-03-04';
  const store = M.folderStore(dir, () => day);
  assert.equal(await store.read(), null);
  const a = M.emptyDoc(), b = act.cushion(a, 100), c = act.cushion(a, 200), e = act.cushion(a, 300);
  await store.write(a, null);
  assert.equal(dir.dirs.size, 0); // nothing to keep yet
  const t1 = (await store.read()).text;
  await store.write(b, t1);
  const t2 = (await store.read()).text;
  await store.write(c, t2); // same day: the morning's copy stays
  assert.equal(dir.dirs.get('backups').files.get('money-2030-03-04.json'), t1);
  day = '2030-03-05';
  await store.write(e, (await store.read()).text);
  assert.equal(JSON.parse(dir.dirs.get('backups').files.get('money-2030-03-05.json')).cushion, 200);
  assert.equal(JSON.parse((await store.read()).text).cushion, 300);
});

test('money.js makes no network requests', () => {
  const src = readFileSync(new URL('../money.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bimport\s*\(|new\s+Image\b|\.src\s*=/);
});

test('the demo file uses made-up numbers and passes the check', () => {
  const d = M.demoDoc('2030-03-04');
  assert.deepEqual(M.check(d), []);
  const P = project(d, '2030-03-04');
  assert.ok(P.cash != null && P.events.length > 0);
});
