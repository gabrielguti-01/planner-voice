// Saving inbox lines from the phone and laptop views: one queue kept in the browser, so nothing typed is lost to a
// slow AI check, a busy page, a closed tab or no connection, and every line is saved exactly once.
// Works as a plain <script> after check.js (globalThis.PlannerSave) and under Node (module.exports), for the tests.
//
// What the planner engine can read (see COMPATIBILITY.md). "| said [tag: ]<the user's words>" (the spelling check's
// record of what was typed) and "keep words: …" (put the user's words back) are read only by an engine that says so
// in engine/capabilities.json, on the branch the page writes the inbox to:
//   { "said": { "version": 2, "tags": ["text", "title", "why", "note", "because", "solution", "left", "goal", "steps"] } }
// The page reads that file once per configured repository (and token), with the same GitHub contents reader as
// everything else, and turns the newer lines on only for version 2 and only for the tags this page also knows. Until
// then — no file, a file that can't be read or parsed, another version, an answer for an earlier configuration — it
// fails closed: no spelling fixes and no AI proofread, lines are saved exactly as typed, and the queue sends every
// line in the form any engine reads (a "| said" part's own words go back into its field, "keep words:" waits in the
// browser). The choice is made at the moment of sending, so a line queued offline follows what is known then.
(function () {
  'use strict';
  const NODE = typeof module !== 'undefined' && !!module.exports && typeof require === 'function';
  const Check = () => globalThis.PlannerCheck || (NODE ? require('./check.js') : null);

  // inbox lines: "[- ][[stamp] ]verb: text | option … | said [tag: ]words"
  const LINE = /^(\s*(?:-\s*)?(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*)?)([A-Za-z][A-Za-z ]*?)(\s*:\s*)([\s\S]*)$/;
  const TAGS = ['text', 'title', 'why', 'note', 'because', 'solution', 'left', 'goal', 'steps']; // check.js SAID_TAGS
  const SAID_VERSION = 2; // the "| said" form check.js writes, with "keep words:"
  const LAST = { notes: 3, library: 3, write: 2 }; // check.js: "<task> | <heading> | <text>": the text may hold a "|"
  const SAID_PART = new RegExp(`^\\s*said(?:\\s+(${TAGS.join('|')})\\s*:)?\\s+(\\S[\\s\\S]*?)\\s*$`, 'i');
  const SAID_TEXT = /^\s*said\s+text\s*:\s+\S/i;
  const isKeepWords = (line) => /^\s*(?:-\s*)?keep words\s*:/i.test(String(line));
  const NONE = Object.freeze({ said: false, keepWords: false, tags: Object.freeze([]), version: 0 });

  // ---------- engine/capabilities.json ----------
  /**
   * The capability in the file's text, or NONE with the reason. Fails closed on anything but a JSON object whose
   * "said" is { version: 2, tags: [strings] }; tags this page doesn't write are ignored, and no known tag means off.
   */
  function parseCaps(text) {
    const no = (why) => ({ caps: NONE, why });
    if (typeof text !== 'string' || !text.trim()) return no('missing');
    if (text.length > 65536) return no('too large');
    let j;
    try { j = JSON.parse(text); } catch { return no('not JSON'); }
    const s = j && typeof j === 'object' && !Array.isArray(j) ? j.said : null;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return no('no "said" entry');
    if (s.version !== SAID_VERSION) return no(typeof s.version === 'number' && s.version < SAID_VERSION ? `older version ${s.version}` : `unknown version ${JSON.stringify(s.version)}`);
    if (!Array.isArray(s.tags) || s.tags.some((t) => typeof t !== 'string')) return no('"tags" is not a list of names');
    const tags = TAGS.filter((t) => s.tags.includes(t));
    if (!tags.length) return no('no known tags');
    return { caps: Object.freeze({ said: true, keepWords: true, tags: Object.freeze(tags), version: SAID_VERSION }), why: '' };
  }

  // The verified answer belongs to one configuration (repository, branch, token): a different one fails closed at
  // once and is looked up again. read() → { status, text } (a thrown error: no connection, asked again when online).
  let gate = null, known = { key: null, caps: NONE, why: 'not checked yet', transient: false }, asking = null;
  function useEngine(opts) {
    gate = opts; known = { key: null, caps: NONE, why: 'not checked yet', transient: false }; asking = null;
    return checkEngine();
  }
  function checkEngine() {
    if (!gate) return Promise.resolve(NONE);
    const key = gate.key();
    if (known.key === key && !known.transient) return Promise.resolve(known.caps);
    if (asking && asking.key === key) return asking.p;
    const p = (async () => {
      let res;
      try {
        const r = await gate.read();
        const st = r && r.status;
        res = st === 200 ? { ...parseCaps(r.text), transient: false }
          : { caps: NONE, why: st === 404 ? 'missing' : `unreadable (${st})`, transient: st === 429 || st >= 500 }; // GitHub busy: asked again when online
      } catch (e) { res = { caps: NONE, why: 'unreachable', transient: true }; }
      if (asking && asking.key === key) asking = null;
      if (gate.key() !== key) return checkEngine(); // the configuration changed meanwhile: this answer is stale
      known = { key, ...res };
      if (gate.onChange) try { gate.onChange(known.caps, known.why); } catch {}
      return known.caps;
    })();
    asking = { key, p };
    return p;
  }
  /** What the engine reading the inbox now is verified to read: { said, keepWords, tags, version } (NONE until then). */
  function engineCaps() {
    if (!gate) return NONE;
    if (known.key !== gate.key()) { checkEngine(); return NONE; } // another repository or token: not verified for it
    return known.caps;
  }
  const engineWhy = () => (gate && known.key === gate.key() ? known.why : 'not checked yet');
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => { if (gate && known.transient) checkEngine(); });
    window.addEventListener('storage', () => { if (gate) checkEngine(); }); // settings changed in another tab
  }

  // ---------- lines in the form the engine reads ----------
  /**
   * The line with only the "| said" parts whose tags are in `tags`; every other said part's own words go back into
   * its field, so the field is as the user typed it (runs of spaces as one). A line whose said parts can't be matched
   * to a field (typed by hand) stays as it is.
   */
  function limitLine(line, tags) {
    const src = String(line), m = src.match(LINE);
    if (!m) return src;
    const verb = m[2].toLowerCase().trim(), segs = m[4].split('|');
    const keep = LAST[verb] || 1;
    let n = segs.length;
    while (n > keep && SAID_PART.test(segs[n - 1]) && (!(verb in LAST) || SAID_TEXT.test(segs[n - 1]))) n--;
    if (n === segs.length) return src;
    const allow = new Set(tags || []), prefix = m[1] + m[2] + m[3];
    const base = segs.slice(0, n), kept = [];
    const C = Check(), p = C && C.parseLine(prefix + base.join('|'));
    if (!p || p.skip) return src;
    let restored = false;
    for (const raw of segs.slice(n)) {
      const x = raw.match(SAID_PART), tag = (x[1] || 'text').toLowerCase();
      if (allow.has(tag)) { kept.push(raw.trim()); continue; }
      const f = p.fields.find((g) => (g.tag || 'text') === tag);
      if (!f) return src;
      base[f.seg] = f.lead + x[2] + f.trail; restored = true;
    }
    if (!restored) return src; // every part is read: the line exactly as it is
    return (prefix + base.join('|')).replace(/\s+$/, '') + kept.map((r) => ` | ${r}`).join(''); // check.js fixLine's form
  }
  /**
   * fixLines()/proofreadLines() results kept only for fields the engine reads: a field with another tag goes back to
   * what was typed, and a line left with no fix is the typed line itself. orig: the typed lines.
   */
  function limitResults(orig, results, c = engineCaps()) {
    const ok = (f) => c.said && c.tags.includes(f.tag || 'text');
    return results.map((r, i) => {
      if (!r || !r.changed) return r;
      const fields = r.fields.map((f) => (ok(f) ? f : { ...f, to: f.from, changes: [] }));
      if (!fields.some((f) => f.to !== f.from)) return { ...r, line: orig[i], changed: false, fields, changes: [] };
      return { ...r, line: limitLine(r.line, c.tags), fields, changes: fields.flatMap((f) => f.changes) };
    });
  }
  /** Split a batch for the engine: { send: lines to write now, held: "keep words:" lines it can't read yet }. */
  function forEngine(lines, c = engineCaps()) {
    const send = [], held = [];
    for (const l of lines) {
      if (isKeepWords(l) && !c.keepWords) held.push(l);
      else send.push(limitLine(l, c.said ? c.tags : []));
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
   * try may have been saved before its answer was lost), caps() (what the engine reads; engineCaps() by default),
   * onError(error, waitingCount), onSaved(lines), retryMs (20000), locks
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
      // the engine's answer first (asked once per configuration; never throws); a read that hangs doesn't hold the
      // saves up for more than 10 s: they then go in the form any engine reads
      if (!opts.caps) { let t; await Promise.race([checkEngine(), new Promise((r) => { t = setTimer(r, 10000); })]); clearTimer(t); }
      // "keep words:" lines held for an engine that couldn't read them go out once it can
      if ((opts.caps ? opts.caps() : engineCaps()).keepWords && held().length) { write(key, [...held(), ...waiting()]); write(heldKey, []); }
      while (waiting().length) {
        const batch = waiting();
        const out = forEngine(batch, opts.caps ? opts.caps() : engineCaps());
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

  const api = { create, useEngine, checkEngine, engineCaps, engineWhy, parseCaps, limitLine, limitResults, forEngine, isKeepWords, endsWith, TAGS, SAID_VERSION };
  globalThis.PlannerSave = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
