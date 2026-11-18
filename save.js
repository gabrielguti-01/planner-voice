// Saving inbox lines from the phone and laptop views: one queue kept in the browser, so nothing typed is lost to a
// slow AI check, a busy page, a closed tab or no connection, and every line is saved exactly once.
// Works as a plain <script> (globalThis.PlannerSave) and under Node (module.exports), for the tests.
//
// What the planner engine can read. "| said <the user's words>" (the spelling check's record of what was typed) and
// "keep words: …" (put the user's words back) are newer than some planner engines, and an older engine may read them
// as part of a title or note, or as an unknown report. Until the page has VERIFIED that the engine reading the inbox
// understands them, every line goes out in the form any engine reads: the "| said" parts the spelling check added are
// left off (the text itself stays exactly as the user saw and accepted it), and "keep words:" lines wait in the
// browser ("held") instead of going out. The queue itself always keeps the full lines, so the choice is made at the
// moment of sending: a line queued offline and sent later follows what is known then.
//
// Nothing here guesses the engine's version: the capability starts unverified, and only setEngineCaps() — called by
// code that has a verified answer from the engine — turns the newer form on. (The engine side is a separate change;
// see the commit message.)
(function () {
  'use strict';

  let caps = { said: false, keepWords: false };
  /** What the engine is verified to read: { said, keepWords }, both false until set. */
  const engineCaps = () => ({ ...caps });
  /** Only for a verified answer from the engine (or a test). Anything that isn't literally true counts as no. */
  function setEngineCaps(c) { caps = { said: !!c && c.said === true, keepWords: !!c && c.keepWords === true }; }

  // inbox lines: "[- ][[stamp] ]verb: text | option … | said [tag: ]words"
  const LINE = /^(\s*(?:-\s*)?(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*)?)([A-Za-z][A-Za-z ]*?)(\s*:\s*)([\s\S]*)$/;
  const TAGS = ['text', 'title', 'why', 'note', 'because', 'solution', 'left', 'goal', 'steps']; // check.js SAID_TAGS
  const LAST = { notes: 3, library: 3, write: 2 }; // check.js: "<task> | <heading> | <text>": the text may hold a "|"
  const SAID_ANY = new RegExp(`^\\s*said(?:\\s+(?:${TAGS.join('|')})\\s*:)?\\s+\\S`, 'i');
  const SAID_TEXT = /^\s*said\s+text\s*:\s+\S/i;
  const isKeepWords = (line) => /^\s*(?:-\s*)?keep words\s*:/i.test(String(line));
  /**
   * The line as any engine reads it: the "| said …" parts at its end left off. In notes:, library: and write: lines
   * only "| said text: …" parts go (that is all the spelling check adds there), so a "|" in the user's own text stays.
   */
  function legacyLine(line) {
    const src = String(line), m = src.match(LINE);
    if (!m) return src;
    const verb = m[2].toLowerCase().trim(), segs = m[4].split('|');
    const keep = LAST[verb] || 1, said = verb in LAST ? SAID_TEXT : SAID_ANY;
    let n = segs.length;
    while (n > keep && said.test(segs[n - 1])) n--;
    return n === segs.length ? src : (m[1] + m[2] + m[3] + segs.slice(0, n).join('|')).replace(/\s+$/, '');
  }
  /** Split a batch for the engine: { send: lines to write now, held: "keep words:" lines it can't read yet }. */
  function forEngine(lines, c = caps) {
    const send = [], held = [];
    for (const l of lines) {
      if (isKeepWords(l) && !c.keepWords) held.push(l);
      else send.push(c.said ? l : legacyLine(l));
    }
    return { send, held };
  }
  /** True when the inbox (its "- line" list, or its text) already ends with exactly these lines. */
  function endsWith(inbox, lines) {
    if (!lines.length) return true;
    const have = Array.isArray(inbox) ? inbox.map(String) : String(inbox).replace(/\s+$/, '').split('\n').map((l) => l.replace(/^- /, ''));
    if (have.length < lines.length) return false;
    const tail = have.slice(have.length - lines.length);
    return tail.every((l, i) => l === lines[i]);
  }

  /**
   * The queue. opts: { get(key), set(key, value) (strings, e.g. localStorage), key ('outbox'), append(lines, { maybeSaved })
   * (writes the lines to the inbox; with maybeSaved it first checks they aren't already at its end, because the last
   * try may have been saved before its answer was lost), onError(error, waitingCount), onSaved(lines), retryMs (20000), locks
   * (navigator.locks: one saver across tabs), setTimer/clearTimer }.
   */
  function create(opts) {
    const key = opts.key || 'outbox', tryKey = key + '.try', heldKey = key + '.held';
    const read = (k) => { try { const v = JSON.parse(opts.get(k) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
    const write = (k, v) => opts.set(k, JSON.stringify(v));
    const setTimer = opts.setTimer || ((f, ms) => setTimeout(f, ms)), clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
    let running = null, timer = 0;
    const waiting = () => read(key), held = () => read(heldKey);
    /** Add lines to the end of the queue (kept at once, before any save starts). */
    function queue(lines) { const l = (lines || []).map(String).filter((x) => x.trim()); if (l.length) write(key, [...waiting(), ...l]); return l.length; }
    async function drain() {
      // "keep words:" lines held for an engine that couldn't read them go out once it can
      if (caps.keepWords && held().length) { write(key, [...held(), ...waiting()]); write(heldKey, []); }
      while (waiting().length) {
        const batch = waiting();
        const out = forEngine(batch);
        if (out.send.length) {
          const last = opts.get(tryKey) || '';
          const maybeSaved = last === JSON.stringify(out.send); // the same lines were being saved when it stopped
          opts.set(tryKey, JSON.stringify(out.send));
          await opts.append(out.send, { maybeSaved });
        }
        if (out.held.length) write(heldKey, [...held(), ...out.held]);
        write(key, waiting().slice(batch.length)); // lines queued meanwhile stay for the next round
        opts.set(tryKey, '');
        if (opts.onSaved) try { opts.onSaved(out.send); } catch {}
      }
    }
    /** Save everything waiting, in order. Resolves true when the queue is empty, false when it will try again. */
    function flush() {
      if (!running) running = (async () => {
        try {
          const lk = opts.locks;
          if (lk && typeof lk.request === 'function') await lk.request('planner.' + key, () => drain());
          else await drain();
          return true;
        } catch (e) {
          if (opts.onError) try { opts.onError(e, waiting().length); } catch {}
          clearTimer(timer); timer = setTimer(() => flush(), opts.retryMs ?? 20000);
          return false;
        } finally { running = null; }
      })();
      return running;
    }
    return { queue, flush, waiting, held, busy: () => !!running };
  }

  const api = { create, engineCaps, setEngineCaps, legacyLine, forEngine, isKeepWords, endsWith };
  globalThis.PlannerSave = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
