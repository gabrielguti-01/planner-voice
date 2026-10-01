// Turns what the user said into inbox lines for the planner engine (see AGENTS.md).
// Rule-based on purpose: the same sentence always gives the same lines. Anything it can't
// classify becomes a "note:" marked uncertain, so the screen can ask before sending.
// Works as a plain <script> (sets globalThis.PlannerSpeech) and under node for tests.

(function () {
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /** "by friday", "tomorrow", "today", "on tuesday" → { rest, date } (date as YYYY-MM-DD or null). */
  function pullDate(text, today) {
    const base = new Date(`${today}T12:00:00`);
    let m = text.match(/\s*\b(?:by|on|for|before)?\s*(today|tonight|tomorrow)\b/i);
    if (m) {
      const d = new Date(base);
      if (/tomorrow/i.test(m[1])) d.setDate(d.getDate() + 1);
      return { rest: text.replace(m[0], '').trim(), date: iso(d) };
    }
    m = text.match(/\s*\b(?:by|on|for|before|this|next)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    if (m) {
      const want = WEEKDAYS.indexOf(m[1].toLowerCase());
      const d = new Date(base);
      let add = (want - d.getDay() + 7) % 7;
      if (add === 0) add = 7;
      d.setDate(d.getDate() + add);
      return { rest: text.replace(m[0], '').trim(), date: iso(d) };
    }
    return { rest: text, date: null };
  }

  const LOAD = '(load \\d+|sheet(?: piece)? \\d+|the sheets?|the washer(?: load)?|the dryer(?: load)?|it|them|everything|all of it)';
  const normLoad = (s) => s.toLowerCase().replace(/^the /, '').replace(/sheet piece/, 'sheet').replace(/ load$/, '').replace(/^(it|them)$/, 'washer').replace(/^(everything|all of it)$/, 'all');

  function laundry(s) {
    let m;
    if ((m = s.match(new RegExp(`\\b(?:moved|put|transferred|switched)\\s+${LOAD}\\s+(?:in|into|to|over to)\\s+the dryer`, 'i')))) return `laundry: ${normLoad(m[1])} dryer`;
    if ((m = s.match(new RegExp(`\\b(?:started|put|threw)\\s+${LOAD}\\s+(?:in|into)\\s+the (?:washer|wash)`, 'i')))) return `laundry: ${normLoad(m[1])} washer`;
    if ((m = s.match(/\b(?:started|put in|threw in)\s+a(?: new)? load(?: of ([a-z ]+?))?(?: in the (?:washer|wash))?$/i))) return `laundry: new ${(m[1] || 'clothes').trim()} washer`;
    if ((m = s.match(new RegExp(`\\b(?:took|pulled|unloaded)\\s+${LOAD}\\s+out(?: of the dryer)?`, 'i')))) return `laundry: ${normLoad(m[1]).replace('washer', 'dryer')} basket`;
    if ((m = s.match(new RegExp(`\\b(?:put|folded and put)\\s+${LOAD}\\s+away`, 'i')))) return `laundry: ${normLoad(m[1]).replace('washer', 'all')} away`;
    if (/\bfolded (?:the )?(?:laundry|clothes|loads?)\b/i.test(s)) return 'laundry: all away';
    if ((m = s.match(/\bput (sheet(?: piece)? \d+|the sheets?) (?:back )?on the bed/i))) return `laundry: ${normLoad(m[1])} away`;
    return null;
  }

  const DONE_VERBS = 'did|finished|completed|took|fed|brushed|scooped|ate|had|washed|cleaned|called|sent|paid|swept|showered|shaved|mopped|vacuumed|emailed|bought|submitted|uploaded|studied|watered|made|drank|filled|organized|folded|checked|refilled|clipped|put on|picked up|dropped off|talked to';

  /**
   * @param {string} said    transcript
   * @param {string} today   YYYY-MM-DD (the user's local date)
   * @returns {{ commands: string[], action: null|'next'|'list'|'week', uncertain: boolean }}
   */
  function toCommands(said, today) {
    const out = { commands: [], action: null, uncertain: false };
    let text = said.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
    if (!text) return out;

    // "wait, pause, I just finished X. what's next?" → handle each sentence
    const parts = text.split(/(?<=[.?!])\s+|\s*;\s*|\s+(?:and then|then)\s+(?=i\b)/i).map((p) => p.trim().replace(/[.?!]+$/, '')).filter(Boolean);
    for (let s of parts) {
      s = s.replace(/^(?:ok(?:ay)?|hey|so|well|alright|all right|yeah|um+|uh+)[, ]+/i, '').replace(/^(?:wait[, ]+)?pause[, ]*/i, '').trim();
      if (!s) continue;
      const low = s.toLowerCase();
      let m;

      if (/^(?:what'?s|what is|whats) next|^next up|^what (?:now|should i do)|^check the repo/.test(low)) { out.action = out.action || 'next'; continue; }
      if (/^what'?s left|^day list|^what(?:'s| is) (?:still )?(?:open|remaining)/.test(low)) { out.action = 'list'; continue; }
      if (/^week ahead|^what'?s coming up|^what(?:'s| is) (?:this|the) week/.test(low)) { out.action = 'week'; continue; }

      if (/\b(?:i'?m|i am|feeling)\b.*\b(?:tired|wiped|exhausted|drained|brain ?dead|worn out)\b/.test(low) && !/\bnot\b/.test(low)) { out.commands.push('tired: on'); continue; }
      if (/^(?:i'?m|i am) (?:fine|ok|okay|good|better)(?: now)?$|\bnot tired\b/.test(low)) { out.commands.push('tired: off'); continue; }

      if (/\b(?:trash|garbage)\b/.test(low) && /\bnot (?:ready|full)\b/.test(low)) { out.commands.push('not ready: trash'); continue; }

      if ((m = s.match(/^(?:undo|actually,? i (?:didn'?t|did not)|i (?:didn'?t|did not) actually|i (?:didn'?t|did not))\s+(.*)$/i))) { out.commands.push(`undo: ${m[1].replace(/^(?:do|finish|take|actually)\s+/i, '')}`); continue; }
      if ((m = s.match(/^(?:skip|skipping|i'?m skipping|no)\s+(?:the\s+)?(.*?)(?:\s+today)?$/i)) && /^(skip|skipping|i'?m skipping)/i.test(s)) { out.commands.push(`skip: ${m[1]}`); continue; }
      if ((m = s.match(/^(?:cancel|i don'?t need(?: to do)?|delete)\s+(?:the\s+)?(.*?)(?:\s+anymore)?$/i))) { out.commands.push(`cancel: ${m[1]}`); continue; }

      const l = laundry(s);
      if (l) { out.commands.push(l); continue; }

      if ((m = s.match(/^(?:add|put|new task)\b:?\s*(?:a task (?:to|for)\s+)?(.*?)(?:\s+(?:to|on) (?:the|my) (?:list|to-?do(?: list)?))?$/i)) || (m = s.match(/^(?:i need to|i have to|i should|i gotta|remind me to)\s+(.*)$/i))) {
        const { rest, date } = pullDate(m[1], today);
        const title = rest.charAt(0).toUpperCase() + rest.slice(1);
        if (title) { out.commands.push(`add: ${title}${date ? ` | target ${date}` : ''}`); continue; }
      }
      if ((m = s.match(/^(?:note|remember|remind me)(?: that| about)?\s+(.*)$/i))) { out.commands.push(`note: ${m[1]}`); continue; }

      if ((m = s.match(/^(?:i(?:'ve| have)? |just |i just |already )?(?:started|began|am starting|i'?m starting|i'?m working on|working on)\s+(.*)$/i))) { out.commands.push(`started: ${m[1]}`); continue; }

      if ((m = s.match(new RegExp(`^(?:i(?:'ve| have)? |just |i just |i already |already )?(?:just |already )?((?:${DONE_VERBS})\\b.*)$`, 'i')))) {
        let what = m[1].replace(/^(?:did|finished|completed)\s+(?:the\s+|my\s+)?/i, '');
        const y = /\b(?:last night|yesterday)\b/i.test(what);
        what = what.replace(/\s*\b(?:last night|yesterday|just now|already|today)\b/gi, '').trim();
        out.commands.push(`done: ${what}${y ? ' @ yesterday' : ''}`);
        continue;
      }
      if ((m = s.match(/^(?:i'?m |i am )?done(?: with)?\s+(?:the\s+|my\s+)?(.+)$/i))) { out.commands.push(`done: ${m[1]}`); continue; }
      if ((m = s.match(/^(.+?)\s+(?:is|are) (?:done|finished)$/i))) { out.commands.push(`done: ${m[1].replace(/^the\s+/i, '')}`); continue; }

      out.commands.push(`note: ${s}`);
      out.uncertain = true;
    }
    return out;
  }

  /** Pull the readable parts out of state/next.md. */
  function parseNext(md) {
    const text = md.replace(/\r\n/g, '\n');
    const section = (name) => {
      const m = text.match(new RegExp(`\\n## ${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`));
      return m ? m[1].trim() : '';
    };
    const field = (k) => (text.match(new RegExp(`^${k}::\\s*(.*)$`, 'm')) || [])[1] || '';
    const clean = (s) => s.replace(/\s*\([A-Z0-9][A-Z0-9@#., -]+\)\s*$/g, '').replace(/[`*_]/g, '').trim();
    const after = section('After that').split('\n').filter((l) => /^\d+\./.test(l)).map((l) => clean(l.replace(/^\d+\.\s*/, '').split(' — ')[0]));
    const bullets = (name) => section(name).split('\n').filter((l) => l.startsWith('- ')).map((l) => clean(l.slice(2)));
    return {
      made: field('made'), validUntil: field('valid_until'), tired: field('tired') === 'on',
      say: section('Say this'), after, today: bullets('Still open today'), week: bullets('Coming up'),
      attention: bullets('Needs your attention'), saved: bullets('Last saved'),
    };
  }

  const api = { toCommands, parseNext, pullDate };
  globalThis.PlannerSpeech = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
