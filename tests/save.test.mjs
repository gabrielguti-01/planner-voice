// save.js: reading engine/capabilities.json (fail closed), lines in the form the engine is verified for, and the queue
// that saves each line exactly once. Synthetic lines only; the "inbox" is an array in memory. Run: see README.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../save.js');

const ALL = ['text', 'title', 'why', 'note', 'because', 'solution', 'left', 'goal', 'steps'];
const MATCHING = JSON.stringify({ said: { version: 2, tags: ALL } }); // what the engine branch publishes
const ON = S.parseCaps(MATCHING).caps;
const OFF = S.parseCaps('').caps;

test('capabilities: the published file turns everything on', () => {
  assert.deepEqual(S.parseCaps(MATCHING), { caps: { said: true, keepWords: true, tags: ALL, version: 2 }, why: '' });
});

test('capabilities: missing, malformed, other versions and unknown tags all fail closed', () => {
  const cases = {
    missing: [undefined, null, '', '   '],
    malformed: ['{', 'null', '[]', '"said"', '{"said":2}', '{"said":[]}', '{"said":null}', '{}', '{"said":{"tags":["text"]}}'],
    versions: [{ version: 1, tags: ALL }, { version: 0, tags: ALL }, { version: 3, tags: ALL }, { version: '2', tags: ALL }, { version: 2.5, tags: ALL }, { version: null, tags: ALL }],
    tags: [{ version: 2 }, { version: 2, tags: 'text' }, { version: 2, tags: [1, 2] }, { version: 2, tags: ['text', 7] }, { version: 2, tags: [] }, { version: 2, tags: ['Text', 'TITLE', 'summary'] }],
  };
  for (const t of [...cases.missing, ...cases.malformed]) assert.deepEqual(S.parseCaps(t).caps, OFF, String(t));
  for (const said of [...cases.versions, ...cases.tags]) assert.deepEqual(S.parseCaps(JSON.stringify({ said })).caps, OFF, JSON.stringify(said));
  assert.match(S.parseCaps(JSON.stringify({ said: { version: 1, tags: ALL } })).why, /older version 1/);
  assert.equal(S.parseCaps('x'.repeat(70000)).why, 'too large');
});

test('capabilities: unknown tags are ignored, and only known ones are kept, in the page\'s order', () => {
  const c = S.parseCaps(JSON.stringify({ said: { version: 2, tags: ['why', 'mood', 'text', 'text'] }, extra: true })).caps;
  assert.deepEqual(c, { said: true, keepWords: true, tags: ['text', 'why'], version: 2 });
});

test('limitLine: a said part the engine does not read puts the typed words back in its field', () => {
  const L = S.limitLine;
  assert.equal(L('add: Call the dentist | said call the dentst', []), 'add: call the dentst');
  assert.equal(L('- add: Call the dentist | why Pain | said call the dentst | said why: pian', []), '- add: call the dentst | why pian');
  assert.equal(L('- add: Call the dentist | why Pain | said call the dentst | said why: pian', ['text']), '- add: call the dentst | why pian'.replace('call the dentst', 'Call the dentist') + ' | said call the dentst');
  assert.equal(L('done: X-1@2026-11-17 | because Fixed it | said because: fixd it', []), 'done: X-1@2026-11-17 | because fixd it');
  assert.equal(L('workflow: Morning | steps Wash; dress | said steps: wsh; dress', []), 'workflow: Morning | steps wsh; dress');
  assert.equal(L('notes: T-1 | Answers | The plan is set | said text: teh plan is set', []), 'notes: T-1 | Answers | teh plan is set');
  assert.equal(L('add: Why it hurts | said text: why: it hurts', []), 'add: why: it hurts'); // main text that began with a tag word
  // all allowed: unchanged
  assert.equal(L('add: Call the dentist | said call the dentst', ALL), 'add: Call the dentist | said call the dentst');
  // a "|" in the user's own text, said typed by hand, lines without said: exactly as they are
  for (const l of ['notes: T-1 | Answers | she | said hi', 'add: Tell Sam what she said', 'done: X-1@2026-11-17', 'groceries: milk', 'add: a | said', 'not a line', 'add: Plan | why said so', 'add: Plan | said goal: x'])
    assert.equal(L(l, []), l, l);
});

test('limitResults: only fixes in fields with a verified tag stay; a line left with none is the typed line', () => {
  const C = require('../check.js');
  const typed = ['add: call the dentst | why teh tooth', 'add: buy milk'];
  const res = C.fixLines(typed);
  const some = S.limitResults(typed, res, S.parseCaps(JSON.stringify({ said: { version: 2, tags: ['why'] } })).caps);
  assert.equal(some[0].line, 'add: call the dentst | why the tooth | said why: teh tooth');
  assert.deepEqual(some[0].changes.map((c) => c.to), ['the']);
  const none = S.limitResults(typed, res, OFF);
  assert.deepEqual(none.map((r) => [r.line, r.changed]), [[typed[0], false], [typed[1], false]]);
  assert.deepEqual(S.limitResults(typed, res, ON).map((r) => r.line), res.map((r) => r.line));
});

test('forEngine: typed words and held "keep words:" until verified; the full lines once verified', () => {
  const lines = ['add: Call the dentist | said call the dentst', 'keep words: Call the dentist', 'done: A-1@2026-11-17'];
  assert.deepEqual(S.forEngine(lines, OFF), { send: ['add: call the dentst', 'done: A-1@2026-11-17'], held: ['keep words: Call the dentist'] });
  assert.deepEqual(S.forEngine(lines, ON), { send: lines, held: [] });
});

test('endsWith compares whole lines at the end of the inbox', () => {
  assert.equal(S.endsWith('# Inbox\n\n- a: 1\n- b: 2\n', ['b: 2']), true);
  assert.equal(S.endsWith('# Inbox\n\n- a: 1\n- b: 2\n', ['a: 1', 'b: 2']), true);
  assert.equal(S.endsWith('# Inbox\n\n- a: 1\n- xb: 2\n', ['b: 2']), false);
  assert.equal(S.endsWith(['a: 1'], ['a: 1', 'b: 2']), false);
});

// ---------- the gate: one answer per configuration ----------
function engine(files) {
  const cfg = { key: 'me/planner' }, reads = [];
  let hold = null;
  const read = async () => {
    const k = cfg.key; reads.push(k);
    if (hold) await hold;
    const f = files[k];
    if (f instanceof Error) throw f;
    return f === undefined ? { status: 404 } : typeof f === 'number' ? { status: f } : { status: 200, text: f };
  };
  return { cfg, reads, start: () => S.useEngine({ key: () => cfg.key, read }), holdReads: () => { let r; hold = new Promise((x) => { r = x; }); return () => { hold = null; r(); }; } };
}

test('gate: not verified until the file is read; read once per repository; another repository fails closed at once', async () => {
  const e = engine({ 'me/planner': MATCHING, 'me/other': undefined });
  const p = e.start();
  assert.deepEqual(S.engineCaps(), OFF); // before the answer
  await p;
  assert.deepEqual(S.engineCaps(), ON);
  await S.checkEngine(); await S.checkEngine();
  assert.deepEqual(e.reads, ['me/planner']); // once
  e.cfg.key = 'me/other';
  assert.deepEqual(S.engineCaps(), OFF); // the old answer doesn't carry over
  await S.checkEngine();
  assert.deepEqual(S.engineCaps(), OFF);
  assert.equal(S.engineWhy(), 'missing');
  e.cfg.key = 'me/planner';
  assert.deepEqual(S.engineCaps(), OFF); // back again: asked again, not taken from memory of another configuration
  await S.checkEngine();
  assert.deepEqual(S.engineCaps(), ON);
  assert.deepEqual(e.reads, ['me/planner', 'me/other', 'me/planner']);
});

test('gate: an answer that arrives after the configuration changed is stale and never used', async () => {
  const e = engine({ 'me/planner': MATCHING, 'me/old-engine': JSON.stringify({ said: { version: 1, tags: ALL } }) });
  const release = e.holdReads();
  const p = e.start(); // asks for me/planner…
  e.cfg.key = 'me/old-engine'; // …and the settings change before the answer
  release();
  await p;
  assert.deepEqual(S.engineCaps(), OFF);
  assert.match(S.engineWhy(), /older version 1/);
});

test('gate: no connection or a busy GitHub fails closed and is asked again; a refusal is an answer', async () => {
  const files = { 'me/planner': new Error('offline') };
  const e = engine(files);
  await e.start();
  assert.deepEqual(S.engineCaps(), OFF);
  assert.equal(S.engineWhy(), 'unreachable');
  files['me/planner'] = 503;
  await S.checkEngine();
  assert.deepEqual(S.engineCaps(), OFF);
  files['me/planner'] = MATCHING;
  await S.checkEngine();
  assert.deepEqual(S.engineCaps(), ON);
  const e2 = engine({ 'me/planner': 403 });
  await e2.start(); await S.checkEngine();
  assert.deepEqual(S.engineCaps(), OFF);
  assert.deepEqual(e2.reads, ['me/planner']);
});

// ---------- the queue ----------
function rig(caps = OFF) {
  const mem = new Map(), inbox = [], timers = [];
  let mode = 'ok';
  const r = { caps, mem, inbox, timers };
  r.q = S.create({
    get: (k) => mem.get(k) ?? '', set: (k, v) => mem.set(k, v), key: 'outbox', caps: () => r.caps,
    append: async (lines, { maybeSaved }) => {
      await null;
      if (maybeSaved && S.endsWith(inbox, lines)) return;
      if (mode === 'offline') throw new Error('offline');
      inbox.push(...lines);
      if (mode === 'lost') { mode = 'ok'; throw new Error('answer lost'); }
    },
    setTimer: (f) => { timers.push(f); return timers.length; }, clearTimer: () => {},
  });
  Object.defineProperty(r, 'mode', { set: (m) => { mode = m; } });
  return r;
}

test('queue: offline keeps every line in full; the retry saves each once, in order, as the engine then allows', async () => {
  const r = rig();
  r.mode = 'offline';
  r.q.queue(['add: One']);
  assert.equal(await r.q.flush(), false);
  r.q.queue(['add: Two | said tow']);
  assert.deepEqual(r.q.waiting(), ['add: One', 'add: Two | said tow']);
  r.mode = 'ok';
  assert.equal(r.timers.length, 1);
  assert.equal(await r.q.flush(), true);
  assert.deepEqual(r.inbox, ['add: One', 'add: tow']); // not verified: the typed words
  assert.deepEqual(r.q.waiting(), []);
});

test('queue: a save whose answer was lost is not written again on the retry', async () => {
  const r = rig();
  r.mode = 'lost';
  r.q.queue(['add: Once']);
  assert.equal(await r.q.flush(), false);
  assert.equal(await r.q.flush(), true);
  assert.deepEqual(r.inbox, ['add: Once']);
});

test('queue: the same line saved again later (not a retry) is written again', async () => {
  const r = rig();
  r.q.queue(['done: A-1@2026-11-17']); await r.q.flush();
  r.q.queue(['done: A-1@2026-11-17']); await r.q.flush();
  assert.deepEqual(r.inbox, ['done: A-1@2026-11-17', 'done: A-1@2026-11-17']);
});

test('queue: lines queued while a save runs go in the next round, nothing twice', async () => {
  const r = rig();
  r.q.queue(['add: First']);
  const p = r.q.flush();
  r.q.queue(['add: Second']);
  assert.equal(r.q.flush(), p);
  assert.equal(await p, true);
  assert.deepEqual(r.inbox, ['add: First', 'add: Second']);
});

test('queue: "keep words:" waits in the browser until the engine is verified, then goes once', async () => {
  const r = rig();
  r.q.queue(['add: Call the dentist | said call the dentst', 'keep words: Call the dentist']);
  await r.q.flush(); await r.q.flush();
  assert.deepEqual(r.inbox, ['add: call the dentst']);
  assert.deepEqual(r.q.held(), ['keep words: Call the dentist']);
  r.caps = ON;
  r.q.queue(['add: Later | said latr']);
  await r.q.flush();
  assert.deepEqual(r.inbox, ['add: call the dentst', 'keep words: Call the dentist', 'add: Later | said latr']);
  assert.deepEqual(r.q.held(), []);
});

test('queue: an outbox written by an older page still loads', async () => {
  const r = rig(ON);
  r.mem.set('outbox', JSON.stringify(['add: Old | said olde', 42, null]));
  await r.q.flush();
  assert.deepEqual(r.inbox, ['add: Old | said olde']);
});
