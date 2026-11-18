// The phone and laptop views in a real browser. Two kinds of runs, both with made-up data only:
// - demo mode (?mock=1) with a verified engine (__MOCK_CAPS): a helper whose AI answers the test releases by hand,
//   saves that fail (offline) or land and lose their answer — the C2 cases;
// - the real read and save paths against a stand-in for GitHub (harness.fakeGitHub): engine/capabilities.json
//   missing, malformed, older or matching, a settings change, and lines replayed from the browser's outbox — C4.
// Nothing leaves the machine (every other request is refused). Run: see README.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, chromium, open, deferredHelper, fakeGitHub, HELPER } from './harness.mjs';

let srv, browser;
before(async () => { srv = await serve(); browser = await chromium().launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const TAGS = ['text', 'title', 'why', 'note', 'because', 'solution', 'left', 'goal', 'steps'];
const CAPS = { matching: JSON.stringify({ said: { version: 2, tags: TAGS } }), malformed: '{"said": {"version": 2, "tags": ["text",', older: JSON.stringify({ said: { version: 1, tags: TAGS } }) };

const A = 'remember to call the dentst about the bill';
const A_TYPED = 'note: to call the dentst about the bill'; // exactly as typed (the planner's reading of it, no fixes)
const A_SHOWN = 'note: to call the dentist about the bill'; // the fix, as the card shows it
const A_FULL = 'note: to call the dentist about the bill | said to call the dentst about the bill'; // for a verified engine

const state = (page, box = '#typed') => page.evaluate((sel) => {
  const b = document.querySelector(sel);
  return { inbox: globalThis.__MOCK_INBOX || [], outbox: JSON.parse(localStorage.getItem('planner.outbox') || '[]'), held: JSON.parse(localStorage.getItem('planner.outbox.held') || '[]'),
    value: b.value, sel: [b.selectionStart, b.selectionEnd] };
}, box);
// a newer draft, half typed, with part of it selected
async function draft(page, sel, text) { await page.fill(sel, text); await page.evaluate((s) => document.querySelector(s).setSelectionRange(2, 5), sel); }
const typeGo = async (page, t) => { await page.fill('#typed', t); await page.click('#typedGo'); };
const until = async (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 });
const warm = (page) => page.waitForFunction(() => globalThis.PlannerCheck && PlannerCheck.ready() && PlannerCheck.warm(), null, { timeout: 15000 });

// ================= demo mode, verified engine: C2 =================
async function phone(settings = {}, globals = { __MOCK_CAPS: CAPS.matching }) {
  const o = await open(browser, srv.base, 'index.html?mock=1&phone', settings, globals);
  await warm(o.page);
  await o.page.evaluate(() => document.getElementById('menu').click());
  await until(o.page, () => PlannerSave.engineCaps().said === !!globalThis.__MOCK_CAPS);
  return o;
}

for (const [name, how] of [['the AI answers', { mode: 'answer', fix: (t) => t }], ['the helper fails', { mode: 'fail' }]]) {
  test(`phone, saving by itself: ${name} late; the newer draft and its selection stay, the line is saved once`, async () => {
    const { ctx, page, helper, errors } = await phone({ autosend: '1' });
    await typeGo(page, A);
    const call = await helper.waitCall(1);
    await draft(page, '#typed', 'buy oat milk');
    call.release(how);
    await until(page, () => (globalThis.__MOCK_INBOX || []).length > 0);
    await page.waitForTimeout(300);
    const s = await state(page);
    assert.deepEqual(s.inbox, [A_FULL]);
    assert.deepEqual(s.outbox, []);
    assert.equal(s.value, 'buy oat milk');
    assert.deepEqual(s.sel, [2, 5]);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('phone, offline during the AI wait: both lines are kept, and the retry saves each once, in order', async () => {
  const { ctx, page, helper } = await phone({ autosend: '1' });
  await page.evaluate(() => { globalThis.__MOCK_SAVE_FAIL = true; });
  await typeGo(page, A);
  const c1 = await helper.waitCall(1);
  await typeGo(page, 'remember to buy oat milk'); // a newer line while the first waits: the first goes now
  const c2 = await helper.waitCall(2);
  c1.release({ mode: 'hang' }); c2.release({ mode: 'answer', fix: (t) => t });
  await until(page, () => JSON.parse(localStorage.getItem('planner.outbox') || '[]').length === 2);
  let s = await state(page);
  assert.deepEqual(s.inbox, []);
  assert.deepEqual(s.outbox, [A_FULL, 'note: to buy oat milk']);
  await page.evaluate(() => { globalThis.__MOCK_SAVE_FAIL = false; dispatchEvent(new Event('online')); });
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 2);
  await page.waitForTimeout(300);
  s = await state(page);
  assert.deepEqual(s.inbox, [A_FULL, 'note: to buy oat milk']);
  assert.deepEqual(s.outbox, []);
  await ctx.close();
});

test('phone: a save that landed but whose answer was lost is not saved twice on the retry', async () => {
  const { ctx, page, helper } = await phone({ autosend: '1', proofread: 'off' });
  await page.evaluate(() => { globalThis.__MOCK_SAVE_LOST = true; });
  await typeGo(page, 'remember to buy oat milk');
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 1);
  await page.waitForTimeout(200);
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForTimeout(400);
  const s = await state(page);
  assert.deepEqual(s.inbox, ['note: to buy oat milk']);
  assert.deepEqual(s.outbox, []);
  assert.equal(helper.calls.length, 0);
  await ctx.close();
});

test('phone, waiting for my Save: a Done tapped during the AI wait is saved and the typed line stays on the card', async () => {
  const { ctx, page, helper } = await phone({ autosend: '0' });
  await typeGo(page, A);
  const call = await helper.waitCall(1);
  await page.evaluate(() => document.getElementById('doneBtn').click());
  await page.evaluate(() => document.getElementById('confirmYes').click());
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 1);
  call.release({ mode: 'answer', fix: (t) => t });
  await page.waitForTimeout(300);
  const card = await page.evaluate(() => ({ shown: !document.getElementById('pending').classList.contains('hidden'), lines: [...document.querySelectorAll('#lines code')].map((c) => c.textContent) }));
  assert.deepEqual(await page.evaluate(() => globalThis.__MOCK_INBOX), ['done: WATER-PLANTS@2026-10-01']);
  assert.deepEqual(card, { shown: true, lines: [A_SHOWN] });
  await page.click('#send');
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 2);
  assert.deepEqual(await page.evaluate(() => globalThis.__MOCK_INBOX), ['done: WATER-PLANTS@2026-10-01', A_FULL]);
  await ctx.close();
});

test('phone, verified engine: "Keep my words" after the save sends one restore and says so neutrally', async () => {
  const { ctx, page } = await phone({ autosend: '1', proofread: 'off' });
  await typeGo(page, A);
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 1);
  await page.waitForTimeout(200);
  await page.click('#fixNote .keepwords');
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 2);
  await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => globalThis.__MOCK_INBOX), [A_FULL, 'keep words: to call the dentist about the bill']);
  const note = await page.textContent('#fixNote');
  assert.match(note, /^Sent your words to the planner\. It puts them back if that line hasn’t changed since\.$/); // not "kept": the planner may refuse
  await ctx.close();
});

const PROJECT_NEXT = '# Next step\n\nmade:: 2026-11-17 10:00\n\n## Say this\n\nNext: Plan the launch.\n\n## Now\n\n- Do: Plan the launch\n- Tasks: LAUNCH-CADENCE@2026-11-17\n- Why: a made-up project step\n';
async function desk(settings = {}, globals = { __MOCK_CAPS: CAPS.matching }) {
  const o = await open(browser, srv.base, 'desk/?mock=1', settings, { __MOCK_NEXT: PROJECT_NEXT, ...globals });
  await warm(o.page);
  await o.page.evaluate(() => document.querySelector('[data-view="home"]')?.click());
  await until(o.page, () => PlannerSave.engineCaps().said === !!globalThis.__MOCK_CAPS);
  return o;
}

test('laptop tell box: typing on during the AI check keeps the newer text and selection, and saves nothing stale', async () => {
  const { ctx, page, helper, errors } = await desk();
  await page.fill('#tell', 'remember to call the dentst');
  await page.press('#tell', 'Enter');
  const call = await helper.waitCall(1);
  await draft(page, '#tell', A);
  call.release({ mode: 'answer', fix: (t) => t });
  await page.waitForTimeout(300);
  let s = await state(page, '#tell');
  assert.deepEqual(s.inbox, []);
  assert.equal(s.value, A);
  assert.deepEqual(s.sel, [2, 5]);
  await page.press('#tell', 'Enter');
  (await helper.waitCall(2)).release({ mode: 'answer', fix: (t) => t });
  await until(page, () => document.getElementById('tellYes').textContent === 'Accept all');
  await page.click('#tellYes');
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 1);
  s = await state(page, '#tell');
  assert.deepEqual(s.inbox, [A_FULL]);
  assert.equal(s.value, '');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('laptop Done dialog: typing on during the AI check keeps the dialog, the newer text and selection; Save then saves that once', async () => {
  const { ctx, page, helper } = await desk();
  await page.evaluate(() => document.getElementById('doneBtn').click());
  await until(page, () => document.getElementById('solDlg').open);
  await page.fill('#solWhat', 'we picked the date');
  await page.click('#solSave');
  const call = await helper.waitCall(1);
  await draft(page, '#solWhat', 'we picked the date and teh venue');
  call.release({ mode: 'fail' }); // the fallback path would have saved the old text and closed
  await page.waitForTimeout(300);
  const s = await state(page, '#solWhat');
  assert.deepEqual(s.inbox, []);
  assert.equal(s.value, 'we picked the date and teh venue');
  assert.deepEqual(s.sel, [2, 5]);
  assert.equal(await page.evaluate(() => document.getElementById('solDlg').open), true);
  assert.match(await page.textContent('#solFix'), /changed it while it was being checked/);
  await page.click('#solSave');
  (await helper.waitCall(2)).release({ mode: 'answer', fix: (t) => t });
  await until(page, () => document.getElementById('solSave').textContent === 'Accept all');
  await page.click('#solSave');
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 1);
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => globalThis.__MOCK_INBOX), ['done: LAUNCH-CADENCE@2026-11-17 | solution We picked the date and the venue | said solution: we picked the date and teh venue']);
  await ctx.close();
});

test('laptop: a second save while the page waits for the planner is kept and saved, not dropped', async () => {
  const { ctx, page, helper } = await desk({ proofread: 'off' });
  await page.evaluate(() => { globalThis.__MOCK_SAVE_MS = 2000; });
  await page.fill('#tell', 'remember to buy oat milk'); await page.press('#tell', 'Enter');
  await until(page, () => !document.getElementById('tellYes').disabled);
  await page.click('#tellYes');
  await page.fill('#tell', 'remember to water the ferns'); await page.press('#tell', 'Enter');
  await until(page, () => !document.getElementById('tellBox').classList.contains('hidden'));
  assert.equal(await page.evaluate(() => document.getElementById('tellGo').disabled), true); // still busy with the first
  assert.deepEqual(await page.evaluate(() => globalThis.__MOCK_INBOX || []), []);
  await page.evaluate(() => { document.getElementById('tellYes').disabled = false; document.getElementById('tellYes').click(); });
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 2);
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => globalThis.__MOCK_INBOX), ['note: to buy oat milk', 'note: to water the ferns']);
  assert.equal(helper.calls.length, 0);
  await ctx.close();
});

test('laptop, offline: the save is kept in the browser and goes once when the connection is back', async () => {
  const { ctx, page } = await desk({ proofread: 'off' });
  await page.evaluate(() => { globalThis.__MOCK_SAVE_FAIL = true; });
  await page.fill('#tell', 'remember to call the dentst'); await page.press('#tell', 'Enter');
  await until(page, () => document.getElementById('tellYes').textContent === 'Accept all');
  await page.click('#tellYes');
  await until(page, () => /Not saved yet/.test(document.getElementById('status').textContent));
  let s = await state(page, '#tell');
  assert.deepEqual(s.outbox, ['note: to call the dentist | said to call the dentst']);
  await page.evaluate(() => { globalThis.__MOCK_SAVE_FAIL = false; dispatchEvent(new Event('online')); });
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 1);
  await page.waitForTimeout(300);
  s = await state(page, '#tell');
  assert.deepEqual(s.inbox, ['note: to call the dentist | said to call the dentst']);
  assert.deepEqual(s.outbox, []);
  await ctx.close();
});

// ================= the real read and save paths: engine/capabilities.json (C4) =================
const PHONE_NEXT = '# Next step\n\nmade:: 2026-11-17 10:00\n\n## Say this\n\nNext: Water the plants.\n\n## Now\n\n- Do: Water the plants\n- Tasks: WATER-PLANTS@2026-11-17\n';
const REPO = 'example/planner';
const capsFile = (kind) => (kind === 'missing' ? {} : { 'engine/capabilities.json': CAPS[kind] });
/** A view on the real paths, with synthetic settings, the fake GitHub and the hand-released helper. */
async function real(view, { caps = 'missing', settings = {}, repos = {}, offline = false } = {}) {
  const ctx = await browser.newContext();
  await ctx.route('**/*', (r) => { const u = r.request().url(); return u.startsWith(srv.base) || u.startsWith(HELPER) ? r.fallback() : r.abort(); });
  await ctx.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem('planner.' + k, v); },
    { token: 'synthetic-token', repo: REPO, helperUrl: HELPER, helperPass: 'synthetic-pass', proofread: 'on', autosend: '1', catchUpAt: '9999999999999', ...settings });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e));
  const helper = deferredHelper(page); await helper.ready;
  const gh = await fakeGitHub(page, view === 'phone' ? PHONE_NEXT : PROJECT_NEXT, { [REPO]: capsFile(caps), ...repos });
  gh.offline = offline;
  await page.goto(srv.base + (view === 'phone' ? 'index.html?phone' : 'desk/'));
  await warm(page);
  await page.waitForFunction(() => PlannerSave.engineWhy() !== 'not checked yet', null, { timeout: 8000 });
  if (view === 'phone') await page.evaluate(() => document.getElementById('menu').click());
  const inbox = (repo = REPO) => gh.repo(repo)['state/inbox.md'].split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  const capsReads = () => gh.reads.filter((r) => r.endsWith(':engine/capabilities.json'));
  const gotLines = async (n, repo = REPO) => { for (let i = 0; i < 160 && inbox(repo).length < n; i++) await page.waitForTimeout(50); assert.equal(inbox(repo).length, n); };
  return { ctx, page, helper, gh, inbox, capsReads, gotLines, errors };
}
const outboxEmpty = (page) => until(page, () => JSON.parse(localStorage.getItem('planner.outbox') || '[]').length === 0 && !document.getElementById('status').textContent.startsWith('Not saved'));

for (const caps of ['missing', 'malformed', 'older']) {
  test(`phone, capabilities ${caps}: no fixes, no AI, no "Keep my words": the line is saved exactly as typed`, async () => {
    const { ctx, page, helper, inbox, capsReads, errors } = await real('phone', { caps });
    assert.deepEqual(await page.evaluate(() => PlannerSave.engineCaps()), { said: false, keepWords: false, tags: [], version: 0 });
    await typeGo(page, A);
    await typeGo(page, 'remember to buy oat milk');
    await outboxEmpty(page);
    assert.deepEqual(inbox(), [A_TYPED, 'note: to buy oat milk']);
    assert.equal(helper.calls.length, 0);
    assert.equal(await page.$('.keepwords'), null);
    assert.deepEqual(capsReads(), [`${REPO}:engine/capabilities.json`]); // once
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('phone, capabilities matching: the fix and "| said" go, read once for many saves', async () => {
  const { ctx, page, helper, inbox, capsReads, gotLines } = await real('phone', { caps: 'matching' });
  await typeGo(page, A);
  (await helper.waitCall(1)).release({ mode: 'answer', fix: (t) => t });
  await gotLines(1);
  assert.match(await page.textContent('#fixNote'), /dentst → dentist/);
  await typeGo(page, 'remember to buy oat milk');
  (await helper.waitCall(2)).release({ mode: 'answer', fix: (t) => t });
  await gotLines(2);
  assert.deepEqual(inbox(), [A_FULL, 'note: to buy oat milk']);
  assert.deepEqual(capsReads(), [`${REPO}:engine/capabilities.json`]);
  await ctx.close();
});

test('phone, settings changed to another repository: the old answer is dropped at once, the new one is read, nothing unverified goes', async () => {
  const OTHER = 'example/older-planner';
  const { ctx, page, helper, inbox, capsReads } = await real('phone', { caps: 'matching', repos: { [OTHER]: { 'engine/capabilities.json': CAPS.older } } });
  assert.equal(await page.evaluate(() => PlannerSave.engineCaps().said), true);
  await page.evaluate((o) => { localStorage.setItem('planner.repo', o); }, OTHER); // as another tab would
  assert.equal(await page.evaluate(() => PlannerSave.engineCaps().said), false); // before any answer for it
  await typeGo(page, A);
  await outboxEmpty(page);
  assert.deepEqual(inbox(OTHER), [A_TYPED]);
  assert.deepEqual(inbox(), []);
  assert.equal(helper.calls.length, 0);
  assert.deepEqual(capsReads(), [`${REPO}:engine/capabilities.json`, `${OTHER}:engine/capabilities.json`]);
  await ctx.close();
});

for (const caps of ['missing', 'matching']) {
  test(`phone, offline replay with capabilities ${caps}: lines queued in full go out as that engine reads them, once`, async () => {
    const queued = [A_FULL, 'keep words: to call the dentist about the bill', 'add: Buy milk | why For the coffee | said buy mlik | said why: for teh coffee'];
    const { ctx, page, inbox, gh } = await real('phone', { caps, settings: { outbox: JSON.stringify(queued) } });
    await outboxEmpty(page);
    const held = await page.evaluate(() => JSON.parse(localStorage.getItem('planner.outbox.held') || '[]'));
    if (caps === 'missing') {
      assert.deepEqual(inbox(), [A_TYPED, 'add: buy mlik | why for teh coffee']); // the user's own words, field by field
      assert.deepEqual(held, ['keep words: to call the dentist about the bill']); // kept, not sent to an engine that can't read it
    } else {
      assert.deepEqual(inbox(), [A_FULL, 'keep words: to call the dentist about the bill', queued[2]]);
      assert.deepEqual(held, []);
    }
    assert.equal(gh.puts, 1);
    await ctx.close();
  });
}

test('phone, starting with no connection: not verified, so a line is queued as typed; once online it is saved and the engine asked again', async () => {
  const { ctx, page, gh, inbox, capsReads } = await real('phone', { caps: 'matching', settings: { proofread: 'off' }, offline: true });
  assert.equal(await page.evaluate(() => PlannerSave.engineWhy()), 'unreachable');
  await typeGo(page, A);
  await until(page, () => /Not saved yet/.test(document.getElementById('status').textContent));
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('planner.outbox'))), [A_TYPED]); // no fix without a verified engine
  gh.offline = false;
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await outboxEmpty(page);
  await until(page, () => PlannerSave.engineCaps().said === true); // asked again once back online
  assert.deepEqual(inbox(), [A_TYPED]);
  assert.deepEqual(capsReads(), [`${REPO}:engine/capabilities.json`]); // the offline try never got there; asked again once
  await ctx.close();
});

test('phone, real save path: a PUT that landed but lost its answer is not written twice', async () => {
  const { ctx, page, gh, inbox } = await real('phone', { caps: 'missing', settings: { proofread: 'off' } });
  gh.loseNextPut = true;
  await typeGo(page, A);
  await until(page, () => /Not saved yet/.test(document.getElementById('status').textContent));
  assert.equal(gh.puts, 1);
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await outboxEmpty(page);
  assert.equal(gh.puts, 1);
  assert.deepEqual(inbox(), [A_TYPED]);
  await ctx.close();
});

for (const caps of ['missing', 'malformed', 'matching']) {
  test(`laptop, capabilities ${caps}: the tell box ${caps === 'matching' ? 'marks the fix and saves it with "| said"' : 'saves exactly as typed, with no AI'}`, async () => {
    const { ctx, page, helper, inbox, capsReads, errors } = await real('desk', { caps });
    await page.fill('#tell', A); await page.press('#tell', 'Enter');
    if (caps === 'matching') {
      (await helper.waitCall(1)).release({ mode: 'answer', fix: (t) => t });
      await until(page, () => document.getElementById('tellYes').textContent === 'Accept all');
    } else await until(page, () => !document.getElementById('tellYes').disabled && document.getElementById('tellYes').textContent === 'Save');
    await page.click('#tellYes');
    await outboxEmpty(page);
    assert.deepEqual(inbox(), [caps === 'matching' ? A_FULL : A_TYPED]);
    assert.equal(helper.calls.length, caps === 'matching' ? 1 : 0);
    assert.deepEqual(capsReads(), [`${REPO}:engine/capabilities.json`]);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('laptop, offline replay with capabilities missing: queued full lines go as the user typed them', async () => {
  const { ctx, page, inbox } = await real('desk', { caps: 'missing', settings: { outbox: JSON.stringify(['done: LAUNCH-CADENCE@2026-11-17 | solution We picked the date | said solution: we pickd the date']) } });
  await outboxEmpty(page);
  assert.deepEqual(inbox(), ['done: LAUNCH-CADENCE@2026-11-17 | solution we pickd the date']);
  await ctx.close();
});
