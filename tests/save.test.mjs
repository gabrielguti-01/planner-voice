// save.js: what goes to an engine that isn't verified to read the newer grammar lines, and the queue that saves each
// line exactly once. Synthetic lines only; the "inbox" is an array in memory. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../save.js');

test('the engine capability starts unverified, and only a literal true turns it on', () => {
  S.setEngineCaps(null);
  assert.deepEqual(S.engineCaps(), { said: false, keepWords: false });
  S.setEngineCaps({ said: 'yes', keepWords: 1 });
  assert.deepEqual(S.engineCaps(), { said: false, keepWords: false });
  S.setEngineCaps({ said: true });
  assert.deepEqual(S.engineCaps(), { said: true, keepWords: false });
  S.setEngineCaps(null);
});

test('legacyLine leaves off only the "| said" parts the spelling check adds', () => {
  const L = S.legacyLine;
  assert.equal(L('add: Call the dentist | said call the dentst'), 'add: Call the dentist');
  assert.equal(L('- add: Call the dentist friday | why: Pain | said call the dentst | said why: pian'), '- add: Call the dentist friday | why: Pain');
  assert.equal(L('done: X-1@2026-11-17 | because Fixed it | said because: fixd it'), 'done: X-1@2026-11-17 | because Fixed it');
  assert.equal(L('workflow: Morning | steps wash; dress | said steps: wsh; dress'), 'workflow: Morning | steps wash; dress');
  // notes / library / write: only "said text:" goes, so a "|" in the user's own text stays
  assert.equal(L('notes: T-1 | Answers | The plan is set | said text: teh plan is set'), 'notes: T-1 | Answers | The plan is set');
  assert.equal(L('notes: T-1 | Answers | she | said hi'), 'notes: T-1 | Answers | she | said hi');
  // lines without said, other verbs, and text that merely contains the word stay byte for byte
  for (const l of ['add: Tell Sam what she said', 'done: X-1@2026-11-17', 'groceries: milk', 'add: a | said', 'not a line', 'add: Plan | why: said so']) assert.equal(L(l), l);
});

test('forEngine: legacy form and held "keep words:" until verified, the full lines once verified', () => {
  const lines = ['add: Call the dentist | said call the dentst', 'keep words: Call the dentist', 'done: A-1@2026-11-17'];
  assert.deepEqual(S.forEngine(lines, { said: false, keepWords: false }), { send: ['add: Call the dentist', 'done: A-1@2026-11-17'], held: ['keep words: Call the dentist'] });
  assert.deepEqual(S.forEngine(lines, { said: true, keepWords: true }), { send: lines, held: [] });
  assert.deepEqual(S.forEngine(lines, { said: true, keepWords: false }).held, ['keep words: Call the dentist']);
});

test('endsWith compares whole lines at the end of the inbox', () => {
  assert.equal(S.endsWith('# Inbox\n\n- a: 1\n- b: 2\n', ['b: 2']), true);
  assert.equal(S.endsWith('# Inbox\n\n- a: 1\n- b: 2\n', ['a: 1', 'b: 2']), true);
  assert.equal(S.endsWith('# Inbox\n\n- a: 1\n- xb: 2\n', ['b: 2']), false);
  assert.equal(S.endsWith(['a: 1'], ['a: 1', 'b: 2']), false);
});

// a queue over an in-memory store and inbox; the inbox can fail (offline) or save and then fail (the answer lost)
function rig({ caps } = {}) {
  const mem = new Map(), inbox = [], timers = [];
  let mode = 'ok';
  S.setEngineCaps(caps || null);
  const q = S.create({
    get: (k) => mem.get(k) ?? '', set: (k, v) => mem.set(k, v), key: 'outbox',
    append: async (lines, { maybeSaved }) => {
      await null;
      if (maybeSaved && S.endsWith(inbox, lines)) return;
      if (mode === 'offline') throw new Error('offline');
      inbox.push(...lines);
      if (mode === 'lost') { mode = 'ok'; throw new Error('answer lost'); }
    },
    setTimer: (f) => { timers.push(f); return timers.length; }, clearTimer: () => {},
  });
  return { q, mem, inbox, timers, set mode(m) { mode = m; } };
}

test('queue: offline keeps every line, the retry saves each exactly once, in order', async () => {
  const r = rig();
  r.mode = 'offline';
  r.q.queue(['add: One']);
  assert.equal(await r.q.flush(), false);
  r.q.queue(['add: Two | said tow']);
  assert.deepEqual(r.q.waiting(), ['add: One', 'add: Two | said tow']); // the full line is kept…
  r.mode = 'ok';
  assert.equal(r.timers.length, 1);
  assert.equal(await r.q.flush(), true);
  assert.deepEqual(r.inbox, ['add: One', 'add: Two']); // …and goes out in the form an unverified engine reads
  assert.deepEqual(r.q.waiting(), []);
});

test('queue: a save whose answer was lost is not written again on the retry', async () => {
  const r = rig();
  r.mode = 'lost';
  r.q.queue(['add: Once']);
  assert.equal(await r.q.flush(), false);
  assert.deepEqual(r.inbox, ['add: Once']);
  assert.equal(await r.q.flush(), true);
  assert.deepEqual(r.inbox, ['add: Once']);
  assert.deepEqual(r.q.waiting(), []);
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
  assert.equal(r.q.flush(), p); // one saver
  assert.equal(await p, true);
  assert.deepEqual(r.inbox, ['add: First', 'add: Second']);
});

test('queue: "keep words:" waits in the browser until the engine is verified, then goes once', async () => {
  const r = rig();
  r.q.queue(['add: Call the dentist | said call the dentst', 'keep words: Call the dentist']);
  await r.q.flush();
  assert.deepEqual(r.inbox, ['add: Call the dentist']);
  assert.deepEqual(r.q.held(), ['keep words: Call the dentist']);
  await r.q.flush();
  assert.deepEqual(r.q.held(), ['keep words: Call the dentist']); // still held, not lost
  S.setEngineCaps({ said: true, keepWords: true });
  r.q.queue(['add: Later | said latr']);
  await r.q.flush();
  assert.deepEqual(r.inbox, ['add: Call the dentist', 'keep words: Call the dentist', 'add: Later | said latr']);
  assert.deepEqual(r.q.held(), []);
  S.setEngineCaps(null);
});

test('queue: a verified engine gets the full lines; an outbox written by an older page still loads', async () => {
  const r = rig({ caps: { said: true, keepWords: true } });
  r.mem.set('outbox', JSON.stringify(['add: Old | said olde', 42, null])); // what an earlier page left
  await r.q.flush();
  assert.deepEqual(r.inbox, ['add: Old | said olde']);
  S.setEngineCaps(null);
});
