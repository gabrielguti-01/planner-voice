// The phone and laptop views in a real browser, in demo mode (?mock=1): made-up plan and settings, a helper whose AI
// answers the test releases by hand, saves that can fail (offline) or be lost after landing. Nothing leaves the
// machine (harness.mjs refuses every other request). Run: node --test tests/
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, chromium, open, fakeGitHub } from './harness.mjs';

let srv, browser;
before(async () => { srv = await serve(); browser = await chromium().launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const A = 'remember to call the dentst about the bill';
const A_SAVED = 'note: to call the dentist about the bill'; // step 1's fix, as an engine not verified for "| said" gets it
const A_FULL = 'note: to call the dentist about the bill | said to call the dentst about the bill';

async function phone(settings = {}) {
  const o = await open(browser, srv.base, 'index.html?mock=1&phone', settings);
  await o.page.waitForFunction(() => globalThis.PlannerCheck && PlannerCheck.ready() && PlannerCheck.warm(), null, { timeout: 15000 });
  await o.page.evaluate(() => document.getElementById('menu').click());
  return o;
}
const state = (page, box = '#typed') => page.evaluate((sel) => {
  const b = document.querySelector(sel);
  return { inbox: globalThis.__MOCK_INBOX || [], outbox: JSON.parse(localStorage.getItem('planner.outbox') || '[]'), held: JSON.parse(localStorage.getItem('planner.outbox.held') || '[]'),
    value: b.value, sel: [b.selectionStart, b.selectionEnd], focused: document.activeElement === b };
}, box);
// a newer draft, half typed, with part of it selected
async function draft(page, sel, text) { await page.fill(sel, text); await page.evaluate((s) => document.querySelector(s).setSelectionRange(2, 5), sel); }
const typeGo = async (page, t) => { await page.fill('#typed', t); await page.click('#typedGo'); };
const until = async (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 });

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
    assert.deepEqual(s.inbox, [A_SAVED]);
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
  assert.deepEqual(s.outbox, [A_FULL, 'note: to buy oat milk']); // kept in full on the phone
  await page.evaluate(() => { globalThis.__MOCK_SAVE_FAIL = false; dispatchEvent(new Event('online')); });
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 2);
  await page.waitForTimeout(300);
  s = await state(page);
  assert.deepEqual(s.inbox, [A_SAVED, 'note: to buy oat milk']);
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
  assert.deepEqual(card, { shown: true, lines: [A_SAVED] });
  await page.click('#send');
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 2);
  assert.deepEqual(await page.evaluate(() => globalThis.__MOCK_INBOX), ['done: WATER-PLANTS@2026-10-01', A_SAVED]);
  await ctx.close();
});

test('phone, engine not verified: "Keep my words" after the save sends nothing an older engine could misread', async () => {
  const { ctx, page } = await phone({ autosend: '1', proofread: 'off' });
  await typeGo(page, A);
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 1);
  await page.waitForTimeout(200);
  await page.click('#fixNote .keepwords');
  await page.waitForTimeout(300);
  const s = await state(page);
  assert.deepEqual(s.inbox, [A_SAVED]);
  assert.deepEqual(s.outbox, []);
  assert.match(await page.textContent('#fixNote'), /can’t put your words back yet/);
  await ctx.close();
});

test('phone, offline replay: lines queued in full go out in the form the engine is verified for at sending time', async () => {
  const { ctx, page } = await phone({ autosend: '1', proofread: 'off', outbox: JSON.stringify([A_FULL, 'keep words: Call the dentist']) });
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 1);
  await page.waitForTimeout(200);
  let s = await state(page);
  assert.deepEqual(s.inbox, [A_SAVED]);
  assert.deepEqual(s.held, ['keep words: Call the dentist']); // waits, not lost and not misread
  // once the engine is verified (by whatever the engine change provides), the held line and new full lines go
  await page.evaluate(() => { PlannerSave.setEngineCaps({ said: true, keepWords: true }); });
  await typeGo(page, 'remember to call the dentst again');
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 3);
  s = await state(page);
  assert.deepEqual(s.inbox, [A_SAVED, 'keep words: Call the dentist', 'note: to call the dentist again | said to call the dentst again']);
  assert.deepEqual(s.held, []);
  await ctx.close();
});

test('phone, real save path: a PUT that landed but lost its answer is not written twice; an unverified engine gets no "| said"', async () => {
  const NEXT = '# Next step\n\nmade:: 2026-11-17 10:00\n\n## Say this\n\nNext: Water the plants.\n\n## Now\n\n- Do: Water the plants\n- Tasks: WATER-PLANTS@2026-11-17\n';
  const ctx = await browser.newContext();
  await ctx.route('**/*', (r) => (r.request().url().startsWith(srv.base) ? r.fallback() : r.abort()));
  await ctx.addInitScript(() => { for (const [k, v] of Object.entries({ token: 'synthetic-token', repo: 'example/planner', autosend: '1', proofread: 'off', catchUpAt: '9999999999999' })) localStorage.setItem('planner.' + k, v); });
  const page = await ctx.newPage();
  const gh = await fakeGitHub(page, NEXT);
  await page.goto(srv.base + 'index.html?phone');
  await page.waitForFunction(() => globalThis.PlannerCheck && PlannerCheck.ready() && PlannerCheck.warm(), null, { timeout: 15000 });
  await page.evaluate(() => document.getElementById('menu').click());
  gh.loseNextPut = true;
  await typeGo(page, A);
  await until(page, () => /Not saved yet/.test(document.getElementById('status').textContent));
  assert.equal(gh.puts, 1);
  assert.match(gh.files['state/inbox.md'], /- note: to call the dentist about the bill\n$/); // it got there
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await until(page, () => JSON.parse(localStorage.getItem('planner.outbox') || '[]').length === 0);
  assert.equal(gh.puts, 1); // the retry saw it at the end of the inbox and wrote nothing
  assert.equal(gh.files['state/inbox.md'], '# Inbox\n- ' + A_SAVED + '\n');
  await ctx.close();
});

// ---------- the laptop view ----------
const PROJECT_NEXT = '# Next step\n\nmade:: 2026-11-17 10:00\n\n## Say this\n\nNext: Plan the launch.\n\n## Now\n\n- Do: Plan the launch\n- Tasks: LAUNCH-CADENCE@2026-11-17\n- Why: a made-up project step\n';
async function desk(settings = {}) {
  const o = await open(browser, srv.base, 'desk/?mock=1', settings, { __MOCK_NEXT: PROJECT_NEXT });
  await o.page.waitForFunction(() => globalThis.PlannerCheck && PlannerCheck.ready() && PlannerCheck.warm(), null, { timeout: 15000 });
  await o.page.evaluate(() => document.querySelector('[data-view="home"]')?.click());
  return o;
}

test('laptop tell box: typing on during the AI check keeps the newer text and selection, and saves nothing stale', async () => {
  const { ctx, page, helper, errors } = await desk();
  await page.fill('#tell', 'remember to call the dentst');
  await page.press('#tell', 'Enter');
  const call = await helper.waitCall(1);
  await draft(page, '#tell', 'remember to call the dentst about the bill');
  call.release({ mode: 'answer', fix: (t) => t });
  await page.waitForTimeout(300);
  let s = await state(page, '#tell');
  assert.deepEqual(s.inbox, []);
  assert.equal(s.value, 'remember to call the dentst about the bill');
  assert.deepEqual(s.sel, [2, 5]);
  // the newer text, checked and saved: once, and the box empties
  await page.press('#tell', 'Enter');
  (await helper.waitCall(2)).release({ mode: 'answer', fix: (t) => t });
  await until(page, () => document.getElementById('tellYes').textContent === 'Accept all');
  await page.click('#tellYes');
  await until(page, () => (globalThis.__MOCK_INBOX || []).length === 1);
  s = await state(page, '#tell');
  assert.deepEqual(s.inbox, [A_SAVED]);
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
  let s = await state(page, '#solWhat');
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
  assert.deepEqual(await page.evaluate(() => globalThis.__MOCK_INBOX), ['done: LAUNCH-CADENCE@2026-11-17 | solution We picked the date and the venue']);
  await ctx.close();
});

test('laptop: a second save while the page waits for the planner is kept and saved, not dropped', async () => {
  const { ctx, page, helper } = await desk({ proofread: 'off' });
  await page.evaluate(() => { globalThis.__MOCK_SAVE_MS = 2000; }); // the first save takes a while: the page is busy
  await page.fill('#tell', 'remember to buy oat milk'); await page.press('#tell', 'Enter');
  await until(page, () => !document.getElementById('tellYes').disabled);
  await page.click('#tellYes');
  await page.fill('#tell', 'remember to water the ferns'); await page.press('#tell', 'Enter');
  await until(page, () => !document.getElementById('tellBox').classList.contains('hidden'));
  assert.equal(await page.evaluate(() => document.getElementById('tellGo').disabled), true); // still busy with the first
  assert.deepEqual(await page.evaluate(() => globalThis.__MOCK_INBOX || []), []);
  await page.evaluate(() => { document.getElementById('tellYes').disabled = false; document.getElementById('tellYes').click(); }); // greyed while busy; reached anyway
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
  assert.deepEqual(s.inbox, ['note: to call the dentist']);
  assert.deepEqual(s.outbox, []);
  await ctx.close();
});
