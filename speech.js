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

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  /** A calendar day in "October 8", "Oct 8th", "10/8", "the 8th" or "Tuesday" → YYYY-MM-DD (never in the past), or null. */
  function pullDay(t, today) {
    const y = +today.slice(0, 4), m0 = +today.slice(5, 7);
    const fix = (mo, d) => { let out = `${y}-${pad(mo)}-${pad(d)}`; if (out < today && mo < m0) out = `${y + 1}-${pad(mo)}-${pad(d)}`; return out; };
    let m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
    if (m) return fix(MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
    if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/))) return fix(+m[1], +m[2]);
    if ((m = t.match(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/i))) { const d = +m[1]; return +today.slice(8) <= d ? `${today.slice(0, 8)}${pad(d)}` : fix(m0 === 12 ? 1 : m0 + 1, d); }
    if ((m = t.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|today|tomorrow)\b/i))) return pullDate(`on ${m[1]}`, today).date;
    return null;
  }
  const NUMW = { no: 0, none: 0, zero: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const num = (w) => (w == null ? null : NUMW[w.toLowerCase()] ?? (/^\d+$/.test(w) ? +w : null));
  const FRAC = (w) => (!w ? '0' : /half/i.test(w) ? '1/2' : /three.quarter/i.test(w) ? '3/4' : /quarter/i.test(w) ? '1/4' : /third/i.test(w) ? '1/3' : (w.match(/\d\/\d/) || ['0'])[0]);
  const WD3 = { sunday: 'Sun', monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat' };
  /** "Mondays and Thursdays", "weekdays", "every day", "every 2 or 3 days", "the 1st to the 5th" → the definitions' every:: form. */
  function schedule(t) {
    const low = t.toLowerCase();
    if (/\b(every ?day|daily)\b/.test(low)) return 'daily';
    if (/\bweekdays\b/.test(low)) return 'Mon-Fri';
    if (/\bweekends?\b/.test(low)) return 'Sat-Sun';
    let m = low.match(/every (\d+|two|three|four|five) (?:to|or|-) (\d+|two|three|four|five|six|seven) days/);
    if (m) return `${num(m[1])}-${num(m[2])} days`;
    if ((m = low.match(/(?:the )?(\d{1,2})(?:st|nd|rd|th) (?:to|through|-) (?:the )?(\d{1,2})(st|nd|rd|th)/))) return `${m[1]}${['th', 'st', 'nd', 'rd'][+m[1] % 10 < 4 && (+m[1] < 11 || +m[1] > 13) ? +m[1] % 10 : 0]}-${m[2]}${m[3]}`;
    const days = Object.keys(WD3).filter((d) => new RegExp(`\\b${d}s?\\b`).test(low)).map((d) => WD3[d]);
    return days.length ? days.join(', ') : null;
  }

  /** "for 2 hours", "an hour and a half", "90 minutes" → minutes, or null. */
  function pullMinutes(low) {
    const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    let m = low.match(/(\d+(?:\.\d+)?|an?|one|two|three|four|five|six)\s*(?:and a half\s*)?(hours?|hrs?|minutes?|mins?)(\s*and a half)?/);
    if (!m) return /half an hour/.test(low) ? 30 : null;
    const n = NUM[m[1]] ?? parseFloat(m[1]);
    const half = /and a half/.test(m[0]) ? 0.5 : 0;
    return /^h/.test(m[2]) ? Math.round((n + half) * 60) : Math.round(n);
  }

  const LOAD = '(load \\d+|sheet(?: piece)? \\d+|the sheets?|the washer(?: load)?|the dryer(?: load)?|it|them|everything|all of it)';
  const normLoad = (s) => s.toLowerCase().replace(/^the /, '').replace(/sheet piece/, 'sheet').replace(/ load$/, '').replace(/^(it|them)$/, 'washer').replace(/^(everything|all of it)$/, 'all');

  function laundry(s) {
    let m;
    if (/\b(?:still|not)\s+(?:a (?:bit|little) )?(?:wet|damp|dry|done|finished|ready)\b|\bneeds? (?:more time|another (?:cycle|round))\b|\brestarted the dryer\b/i.test(s) && /\b(?:dryer|laundry|sheets?|clothes|load|it|they)\b/i.test(s)) return `laundry: ${/washer/i.test(s) ? 'washer' : 'dryer'} still`;
    if (/\b(?:made|remade) (?:the|my) bed\b|\bsheets? (?:are |is )?(?:back )?on the bed\b/i.test(s)) return 'laundry: sheets away';
    if (/\b(?:the )?sheets (?:are|is) (?:all )?(?:dry|done)\b|\b(?:took|pulled) (?:all )?the sheets out\b/i.test(s)) return 'laundry: sheets basket';
    if (/\b(?:all (?:of )?)?(?:the |my )?sheets (?:are|is) (?:all )?in the dryer\b/i.test(s)) return 'laundry: sheets dryer';
    if ((m = s.match(new RegExp(`\\b(?:moved|put|transferred|switched)\\s+${LOAD}\\s+(?:in|into|to|over to)\\s+the dryer`, 'i')))) return `laundry: ${normLoad(m[1])} dryer`;
    if ((m = s.match(new RegExp(`\\b(?:started|put|threw)\\s+${LOAD}\\s+(?:in|into)\\s+the (?:washer|wash)`, 'i')))) return `laundry: ${normLoad(m[1])} washer`;
    if (/\b(?:started|put in|threw in|put)\s+(?:the next|another|the other)\s+load\b/i.test(s)) return 'laundry: next washer';
    if ((m = s.match(/\b(?:started|put in|threw in)\s+a(?: new)? load(?: of ([a-z ]+?))?(?: in the (?:washer|wash))?$/i))) return `laundry: new ${(m[1] || 'clothes').trim()} washer`;
    if ((m = s.match(new RegExp(`\\b(?:took|pulled|unloaded)\\s+${LOAD}\\s+out(?: of the dryer)?`, 'i')))) return `laundry: ${normLoad(m[1]).replace('washer', 'dryer')} basket`;
    if ((m = s.match(new RegExp(`\\b(?:put|folded and put)\\s+${LOAD}\\s+away`, 'i')))) return `laundry: ${normLoad(m[1]).replace('washer', 'all')} away`;
    if (/\bfolded (?:the )?(?:laundry|clothes|loads?)\b/i.test(s)) return 'laundry: all away';
    if ((m = s.match(/\bput (sheet(?: piece)? \d+|the sheets?) (?:back )?on the bed/i))) return `laundry: ${normLoad(m[1])} away`;
    return null;
  }

  const DONE_VERBS = 'turned in|handed in|did|finished|completed|took|fed|brushed|scooped|ate|had|washed|cleaned|called|sent|paid|swept|showered|shaved|mopped|vacuumed|emailed|bought|submitted|uploaded|studied|watered|made|drank|filled|organized|folded|checked|refilled|clipped|put on|picked up|dropped off|talked to';

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

      if (/^(?:what'?s|what is|whats) next|^next up|^what (?:now|should i do)|^check the repo|^start (?:my|the) day|^what do i (?:need|have) to do|^where do i start/.test(low)) { out.action = out.action || 'next'; continue; }
      if (/^re-?check|^check (?:it |that |this )?again|^re-?prioriti[sz]e|^re-?calculate|^is (?:this|that|it) still (?:the )?(?:best|right|most)/.test(low)) { out.action = 'recheck'; continue; }
      if (/^(?:read me |what'?s on |what is on |show me )?(?:the |my )?(?:grocery|shopping) list\b|^what do i need (?:to buy|from the store)/.test(low)) { out.action = 'groceries'; continue; }
      if ((m = s.match(/^(?:please )?(?:add|put) (.+?) (?:to|on) (?:the |my )?(?:grocery|shopping) list$/i))) { out.commands.push(`grocery: ${m[1].replace(/\s+and\s+/gi, '; ')}`); continue; }
      if ((m = s.match(/^(?:we'?re|i'?m|we are|i am)\s+(?:almost |nearly |running )?(?:out of|low on) (.+)$/i)) || (m = s.match(/^(?:we|i)\s+(?:ran out of|are out of|need to buy|need to get) (?:more |some |new )?(.+)$/i))) { out.commands.push(`grocery: ${m[1].replace(/\s+and\s+/gi, '; ')}`); continue; }
      if ((m = s.match(/^i (?:had to )?(?:threw|throw|tossed) (?:out |away )?(.+?)(?: out| away)?$/i))) { out.commands.push(`waste: ${m[1].replace(/\s+and\s+/gi, '; ')}`); continue; }
      // a printed date on what was bought: "I bought 2 packs of bread, use by October 8"
      if ((m = s.match(/^i (?:just )?bought (.+?),?\s+(?:that'?s |it'?s |they'?re )?(?:use by|best by|good until|expires?(?: on)?|expiring)\s+(.+)$/i)) && pullDay(m[2], today)) { out.commands.push(`bought: ${m[1].replace(/\s+and\s+/gi, '; ')} use by ${pullDay(m[2], today)}`); continue; }
      if ((m = s.match(/^i (?:just )?bought (.+)$/i))) { out.commands.push(`bought: ${m[1].replace(/\s+and\s+/gi, '; ')}`); continue; }
      // avocado ripeness: "I have 2 ripe avocados and 3 green ones" / "avocados: 2 ripe, 3 green"
      if (/\bavocados?\b/i.test(s) && (m = s.match(/\b(\d+|no|one|two|three|four|five|six|seven|eight) (?:are |is )?ripe\b/i))) {
        const g = s.match(/\b(\d+|no|one|two|three|four|five|six|seven|eight) (?:are |is )?(?:green|firm|hard|unripe|not ripe)\b/i);
        out.commands.push(`avocado: ${num(m[1])} ripe ${g ? num(g[1]) : 0} green`); continue;
      }
      // a substitution: "I'll have chicken instead of a steak this week"
      if ((m = s.match(/^(?:i'?ll|i will|i'?m going to|i'?m gonna|i am going to|i'?m) (?:have|eat|make|use|get) (.+?) instead of (?:(\d+|a|an|one|two|three) )?(steaks?|sandwich(?:es)?|kiwis?|avocados?|pineapples?)(?: this week)?$/i))) { out.commands.push(`substitute: ${m[1]} for ${num(m[2]) || 1} ${m[3].toLowerCase()}`); continue; }
      // a blueberry checkpoint: "1 full bag of blueberries and half a bag open"
      if (/\bblueberr/i.test(s) && (m = s.match(/\b(\d+|no|one|two|three|four) full\b/i))) {
        const o = s.match(/\b(half|a quarter|three quarters|a third|\d\/\d)\b(?:[^.]*?)\bopen\b|\bopen (?:bag )?(?:is |at |about )?(half|a quarter|three quarters|a third|\d\/\d)/i);
        out.commands.push(`blueberries: ${num(m[1])} full ${FRAC(o && (o[1] || o[2]))} open`); continue;
      }
      // exam readiness (school §5): "I feel partly ready for the chem exam"
      if ((m = s.match(/^(?:i (?:feel|am|think i'?m)|i'?m|feeling) (not(?: at all)?|not really|partly|kind of|somewhat|mostly|half|pretty|fully|totally|very)? ?(?:ready|prepared) for (?:the |my )?(.*\b(?:exam|quiz|test|midterm|final)\b.*)$/i))) {
        const w = (m[1] || '').toLowerCase(), r = /^not/.test(w) ? 'unprepared' : /partly|kind of|somewhat|mostly|half/.test(w) ? 'partly' : 'prepared';
        out.commands.push(`set: ${m[2]} | ready ${r}`); continue;
      }
      // a recurring item changed from now on: "from now on the gym is Mondays, Wednesdays and Fridays", "stop the pool filter from now on"
      if ((m = s.match(/^(?:stop|no more) (?:the |my |doing )?(.+?) (?:from now on|for good|permanently|altogether|going forward)$/i)) || (m = s.match(/^stop repeating (?:the |my )?(.+)$/i))) { out.commands.push(`series: ${m[1]} | stop`); continue; }
      if ((m = s.match(/^(?:from now on|going forward),? (?:do |have |put |make )?(?:the |my )?(.+?) (?:only )?(after|before) (\d{1,2})(?::(\d{2}))? ?([ap]\.?m\.?)?$/i))) {
        let h = +m[3]; if (/^p/i.test(m[5] || '') && h < 12) h += 12; if (/^a/i.test(m[5] || '') && h === 12) h = 0;
        const t = `${pad(h)}:${m[4] || '00'}`;
        out.commands.push(`series: ${m[1]} | window ${/after/i.test(m[2]) ? `after ${t}` : `00:00-${t}`}`); continue;
      }
      if (((m = s.match(/^(?:from now on,? |going forward,? )(?:do |have |put |make |move )?(?:the |my )?(.+?) (?:is |are |goes |go |happens |should be |on |every |to )+(.+)$/i)) || (m = s.match(/^(?:change|make|move|set|switch) (?:the |my )?(.+?) to (?:every |be every |be on |on )?(.+?)(?: from now on| going forward)?$/i))) && schedule(m[2]) && (/from now on|going forward|every|daily|weekdays|weekends|\b(?:sun|mon|tues|wednes|thurs|fri|satur)days\b/i.test(s))) {
        out.commands.push(`series: ${m[1].replace(/ (?:every|on)$/i, '')} | every ${schedule(m[2])}`); continue;
      }
      if ((m = s.match(/^i (?:just )?(?:had|ate) (?:a |an |my )?(steak|smoothie|sandwich(?:es)?|\d+ sandwich(?:es)?)(?: for \w+)?$/i))) { out.commands.push(`ate: ${m[1].toLowerCase()}`); continue; }
      if ((m = s.match(/^(?:do|put|make) (.+?) (?:first|my (?:number one|top|first) (?:priority|thing))(?: after (?:the )?laundry)?( tomorrow)?$/i))) { out.commands.push(`first: ${m[1].replace(/^the\s+/i, '').replace(/ tomorrow$/i, '')}${m[2] || / tomorrow$/i.test(m[1]) ? ' | tomorrow' : ''}`); continue; }
      if (/^what'?s (?:my|the) plan\b|^(?:what does|how does) (?:my|the) day look|^plan (?:out )?(?:my|the) day|^today'?s plan/.test(low)) { out.action = 'plan'; continue; }
      if (/^what'?s left|^day list|^what(?:'s| is) (?:still )?(?:open|remaining)/.test(low)) { out.action = 'list'; continue; }
      if (/^week ahead|^what'?s coming up|^what(?:'s| is) (?:this|the) week/.test(low)) { out.action = 'week'; continue; }
      if (/^(?:can|should|could|may) i (?:go|hang|leave|take|join|head)|\bdo i have time\b|\bam i free\b|\bbeen invited\b|^how (?:much )?(?:free )?time do i have|^how(?:'s| is) (?:my )?pressure|^is it ok(?:ay)? (?:if i|to) (?:go|hang)/.test(low)) {
        out.action = 'free';
        out.minutes = pullMinutes(low);
        continue;
      }

      if (/\bbrain[ -]?dead\b|\bcan'?t think\b|\bbrain is (?:fried|mush|dead)\b/.test(low)) { out.commands.push(/\bnot\b|\bno longer\b|\banymore\b|\boff\b/.test(low) ? 'braindead: off' : 'braindead: on'); continue; }
      if (/\b(?:i'?m|i am|feeling)\b.*\b(?:tired|wiped|exhausted|drained|worn out)\b/.test(low) && !/\bnot\b/.test(low)) { out.commands.push('tired: on'); continue; }
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

      if ((m = s.match(/^(?:i(?:'ve| have)? |just |i just |already )?(?:started|began|am starting|i'?m starting|i'?m working on|working on|worked on|i worked on|i'?ve been working on|made progress on|did some(?: work on)?)\s+(.*)$/i))) { out.commands.push(`started: ${m[1].replace(/\s+(?:today|for (?:today|now|a while))$/i, '')}`); continue; }
      if ((m = s.match(/^(?:i(?:'ve| have)? |i just |i )?(?:finished|done with|stopped|wrapped up) (?:the |my )?(.+?) for (?:today|now|the day|tonight)$/i))) { out.commands.push(`started: ${m[1]} | note session done ${today}`); continue; }
      if ((m = s.match(/^i (?:just )?put (?:the |my )?(groceries|food|shopping) away$/i))) { out.commands.push('done: put the groceries away'); continue; }

      if ((m = s.match(new RegExp(`^(?:i(?:'ve| have)? |just |i just |i already |already )?(?:just |already )?((?:${DONE_VERBS})\\b.*)$`, 'i')))) {
        let what = m[1].replace(/^(?:did|finished|completed)\s+(?:the\s+|my\s+)?/i, '');
        const y = /\b(?:last night|yesterday)\b/i.test(what);
        what = what.replace(/\s*\b(?:last night|yesterday|just now|already|today)\b/gi, '').trim();
        out.commands.push(`done: ${what}${y ? ' @ yesterday' : ''}`);
        continue;
      }
      if ((m = s.match(/^(?:i'?m |i am )?done(?: with)?\s+(?:the\s+|my\s+)?(.+)$/i))) { out.commands.push(`done: ${m[1]}`); continue; }
      if ((m = s.match(/^(.+?)\s+(?:is|are|was|were|got|have been|has been|are all|is all) (?:all )?(?:done|finished|washed|cleaned|taken care of)$/i))) { out.commands.push(`done: ${m[1].replace(/^the\s+/i, '')}`); continue; }

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
      plan: section("Today's plan").split('**Not today:**')[0].split('\n').filter((l) => l.startsWith('- ')).map((l) => clean(l.slice(2))),
      notToday: (section("Today's plan").split('**Not today:**')[1] || '').split('\n').filter((l) => l.startsWith('- ')).map((l) => clean(l.slice(2))),
      made: field('made'), validUntil: field('valid_until'), tired: field('tired') === 'on', brainDead: field('brain_dead') === 'on',
      say: section('Say this'), after, today: bullets('Still open today'), week: bullets('Coming up'),
      attention: bullets('Needs your attention'), late: bullets('Late or waiting'), groceries: bullets('Groceries'),
      then: ((section('Now').match(/^- Then: (.*)$/m) || [])[1] || '').trim(),
      day: { zone: field('zone'), windDown: field('wind_down'), bed: field('bed'), events: section('Day').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()) }, saved: bullets('Last saved'),
      pressure: { level: field('level'), freeUntil: field('free_until'), slackH: field('slack_h'), nextAnchor: field('next_anchor'), lines: bullets('Pressure') },
    };
  }

  /**
   * Answer "can I go (for N minutes)?" from the Pressure section. Pure arithmetic on the engine's numbers.
   * @param p        parseNext(...).pressure
   * @param nowStr   "YYYY-MM-DD HH:MM" local time
   * @param minutes  how long the outing is, or null
   */
  function freeAnswer(p, nowStr, minutes) {
    const t = (s) => (/^\d{4}-/.test(s || '') ? new Date(s.replace(' ', 'T')).getTime() / 60000 : null);
    const clock = (min) => { const d = new Date(min * 60000); const h = d.getHours(), m = d.getMinutes(); return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
    const now = t(nowStr), free = t(p.freeUntil), anchor = t(p.nextAnchor);
    const verdict = (p.lines.find((l) => l.startsWith('Verdict:')) || '').replace(/^Verdict:\s*/, '');
    const present = (p.lines.find((l) => l.startsWith('You must be present for:')) || '');
    if (p.level === 'critical') return `Not a good time. ${verdict}`;
    if (minutes == null) return `Pressure is ${p.level}. ${verdict}${present ? ' ' + present : ''}`;
    const end = now + minutes;
    if (free != null && end > free) {
      const room = Math.max(0, Math.floor((free - now) / 5) * 5);
      return `Not for that long. ${verdict} You have about ${room >= 60 ? `${Math.floor(room / 60)} hour${room >= 120 ? 's' : ''}${room % 60 ? ` ${room % 60} minutes` : ''}` : `${room} minutes`}.`;
    }
    if (anchor != null && end > anchor) return `Yes, go, but be back by ${clock(anchor)}. ${present} Pressure is ${p.level}.`;
    return `Yes, go. You'd be done by ${clock(end)}, and you're free until ${free == null ? 'whenever' : clock(free)}. Pressure is ${p.level}.`;
  }

  const api = { toCommands, parseNext, pullDate, pullMinutes, freeAnswer };
  globalThis.PlannerSpeech = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
