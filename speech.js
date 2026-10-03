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

  // ---- events: "I have a haircut at 12:30 today", "Dentist Friday at 3 PM", "Party Saturday from 7 to 10 PM" ----
  const p2 = (n) => String(n).padStart(2, '0');
  function to24(h, mm, ap, pmHint) {
    h = +h; mm = +(mm || 0);
    if (ap) { if (/^p/i.test(ap) && h < 12) h += 12; if (/^a/i.test(ap) && h === 12) h = 0; }
    else if (pmHint && h < 12) h += 12;
    else if (h >= 1 && h <= 6) h += 12; // "at 3" means the afternoon; 7-11 means the morning; 12 is noon
    return h * 60 + mm;
  }
  /** The time in an event sentence → { start, end, text } in minutes after midnight, or null. */
  function eventClock(t) {
    const pm = /\b(?:tonight|this evening|in the evening|this afternoon)\b/i.test(t);
    let m = t.match(/\b(?:from |between )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|until|till|and)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if (m && (m[3] || m[6] || m[2] || m[5] || /\b(?:from|between)\b/i.test(m[0]))) {
      const endAp = m[6], startAp = m[3] || (endAp && +m[1] <= +m[4] ? endAp : null);
      const start = to24(m[1], m[2], startAp, pm), end = to24(m[4], m[5], endAp, pm || (startAp && /p/i.test(startAp)));
      return { start, end: end > start ? end : start + 60, text: m[0] };
    }
    m = t.match(/\b(?:at |@ ?)?(\d{1,2}):(\d{2})\s*(am|pm)?\b/i) || t.match(/\b(?:at )?(\d{1,2})()\s*(am|pm)\b/i) || t.match(/\bat (\d{1,2})()()\b(?!\s*(?:minutes|mins|hours|%))/i);
    if (m) { const start = to24(m[1], m[2], m[3], pm); return { start, end: start + 60, text: m[0] }; }
    if ((m = t.match(/\bat noon\b/i))) return { start: 720, end: 780, text: m[0] };
    return null;
  }
  const EVENT_WORDS = /\b(?:appointment|appt|meeting|class|party|dinner with|lunch with|breakfast with|call with|haircut|dentist|doctor|therapy|interview|game|practice|flight|session|event|reservation|concert|show|visit|checkup|check-up|shift|pickup|pick-up|ceremony|birthday|wedding|movie)\b/i;
  const EVENT_LEAD = /^(?:i (?:have|'ve got|got|'ve|am going to|'m going to|'ll be at|need to be at|have got)|i'?ve got|there(?:'s| is)|we have|(?:add|put|schedule|book)(?: an?)?(?: event| appointment)?:?)\s+/i;
  function eventOf(s, today) {
    if (/^(?:i )?(?:had|went|did|got back|finished|was|attended|left|came back)\b/i.test(s)) return null; // past: a report, not an event
    if (/^(?:i (?:need|have) to|i should|remind me|i gotta)\b/i.test(s)) return null; // a task with a time is a task
    const t = s.replace(/\b([ap])\.?\s?m\.?(?=\W|$)/gi, '$1m');
    const clock = eventClock(t);
    if (!clock || (!EVENT_LEAD.test(t) && !EVENT_WORDS.test(t))) return null;
    let date = /\btonight\b/i.test(t) ? today : pullDay(t, today) || today;
    const wd = (t.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i) || [])[1];
    if (wd && WEEKDAYS.indexOf(wd.toLowerCase()) === new Date(`${today}T12:00:00`).getDay() && !/\bnext\b/i.test(t)) date = today; // "Friday" said on a Friday
    const title = t.replace(clock.text, ' ')
      .replace(/\b(?:today|tonight|tomorrow|this (?:morning|afternoon|evening)|in the (?:morning|afternoon|evening)|(?:on |this |next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|(?:on )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?|(?:on )?\d{1,2}\/\d{1,2}|on the \d{1,2}(?:st|nd|rd|th))\b/gi, ' ')
      .replace(EVENT_LEAD, '').replace(/^\s*(?:a|an|my|the|to)\s+/i, '').replace(/\s+(?:at|on|from|for|in the|this)\s*$/i, '').replace(/\s+/g, ' ').trim();
    if (!title) return null;
    const hm = (x) => `${p2(Math.floor(x / 60) % 24)}:${p2(x % 60)}`;
    return `event: ${title.charAt(0).toUpperCase() + title.slice(1)} | ${date} ${hm(clock.start)}-${hm(clock.end)} | confirmed`;
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

  // Words speech recognition often gets wrong for this planner, fixed before anything is parsed.
  const FIXES = [
    [/\bbaby[ -]?(?:men|mann|maan|band|ben|bman|mean|moon|ma'?am)\b/gi, 'baby man'], [/\bbabyman\b/gi, 'baby man'], [/\b(?:maybe|baby) man'?s\b/gi, "baby man's"],
    [/\b(?:new|neu|nu|neo)[ -]?tropic(?:al)?\b(?= drink|$)/gi, 'nootropic'], [/\bnootropics? drinks?\b/gi, 'nootropic drink'],
    [/\b(scoop(?:ed)?|change(?:d)?|clean(?:ed)?|empt(?:y|ied)) (?:the )?(?:letter|liter|litre)(?: box)?\b/gi, '$1 the litter'], [/\bletter box\b/gi, 'litter box'],
    [/\b(?:cal|calk|calcs|calculus|count) ?(?:three|3|iii)\b/gi, 'calc 3'], [/\b(?:chem|kem|chemistry) (?:two|2|ii)\b/gi, 'chem 2'],
    [/\bsmooth(?:y|ie|ies| he| e)\b/gi, 'smoothie'], [/\blandry\b/gi, 'laundry'], [/\b(?:drier|dryer's|dyer)\b/gi, 'dryer'], [/\bwashing machine\b/gi, 'washer'],
    [/\bdeodorants?\b|\bdeodor ant\b/gi, 'deodorant'], [/\bvitamin d3?\b|\bvitamin dee\b/gi, 'vitamin D'], [/\bgallon (?:of )?water\b/gi, 'water bottle'],
  ];
  const fix = (t) => FIXES.reduce((x, [re, to]) => x.replace(re, to), t);
  // A whole sentence that only says the current step is finished ("done", "did it", "ok next"), and its misheard forms.
  // ---- every common way to say "finished" with nothing else: the step on screen is done ----
  // Shared with the engine (engine/commands.mjs imports this file), so the phone and the planner always agree.
  const DONE_SAID = new Set(['done', 'dun', 'don', 'dawn', 'finished', 'finish', 'complete', 'completed', 'did it', 'did that', 'did this', 'did this one', 'did that one',
    'done it', 'done that', 'done that one', 'done this one', 'finished it', 'finished that', 'finished this', 'finished this one', 'finished that one', 'completed it', 'completed that',
    'got it', 'got it done', 'got that done', 'got this done', 'got that one done', 'nailed it', 'knocked it out', 'crushed it', 'handled', 'handled it', 'handled that',
    'taken care of', 'took care of it', 'took care of that', 'wrapped up', 'wrapped it up', 'sorted', 'all set', 'set', 'through', 'over', 'over with', 'been done',
    'accomplished', 'accomplished it', 'done with it', 'done with that', 'done with this', 'done with this one', 'done with that one', 'finished with it', 'finished with that',
    'through with it', 'checked', 'checked off', 'checked it off', 'ticked off', 'crossed off', 'squared away', 'a wrap', 'it', 'that', 'that one', 'this one', 'done and done',
    'finito', 'mission accomplished', 'success', 'boom', 'there we go', 'there you go', 'check', 'next', 'next one', 'next step', 'next task', 'next thing', 'next please',
    'moving on', 'move on', 'on to the next', 'onto the next', 'on to the next one', 'onto the next one', 'ready for the next one', 'give me the next one', 'whats the next one',
    'the next one', 'and done', 'all good here', 'thats that', 'it is done', 'it is finished', 'it is complete', 'it is completed']);
  const SUBJECTS = ["i'm ", 'im ', 'i am ', "we're ", 'we are ', "it's ", 'its ', 'it is ', "that's ", 'thats ', 'that is ', 'this is ', "this one's ", "that one's ", 'that one is ', 'this one is ',
    'all ', "i'm all ", "it's all ", "that's all ", "i've ", 'ive ', 'i have ', 'i ', 'already ', 'i already ', 'just ', 'i just ', "i've just ", 'i have just ', 'task ', 'step ', 'the task is ',
    'the step is ', "it's been ", 'it has been ', "that's been ", 'yes ', 'totally ', 'completely ', 'fully ', 'officially ', 'finally ', 'now ', "i'm finally ", "i'm officially "];
  const MARK = /^(?:(?:go ahead and|please|you can|can you|could you) )?(?:mark|check|cross|tick|strike|scratch)(?: it| that| this| this one| that one)?(?: off| out| done| as done| complete| as complete| completed| as completed| finished| as finished)?(?: the list| my list)?$/;
  const norm = (t, tails = true) => {
    let s = String(t).toLowerCase().replace(/[’]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/\b([a-z']+)( \1\b)+/g, '$1'); // "done done", "done, done"
    for (let i = 0; i < 4; i++) s = s.replace(/^(?:ok|okay|k|yes|yep|yup|yeah|ya|alright|all right|so|well|great|cool|good|perfect|awesome|sweet|nice|um+|uh+|and|right|sure|hey|alrighty)\s+/, '');
    if (tails) for (let i = 0; i < 3; i++) s = s.replace(/\s+(?:now|already|thanks|thank you|please|for now|for today|today|too|as well|then|here|bro|man|dude|yay|lol|whats next|what's next|next|next one|next please|on to the next(?: one)?|onto the next(?: one)?|and next|so next|so what's next)$/, '');
    return s.trim();
  };
  /** True when the sentence only says "finished" (in any common way) and names nothing. */
  function isBareDone(t) {
    if (/\?\s*$/.test(String(t)) && !/what'?s next\?\s*$/i.test(String(t))) return false; // "is it done?" is a question
    if (/\b(?:not|almost|nearly|half|haven'?t|hasn'?t|didn'?t|isn'?t|wasn'?t|never|barely|partly|kinda|kind of|mostly)\b/i.test(String(t))) return false;
    const said = (s) => !!s && (DONE_SAID.has(s) || MARK.test(s) || SUBJECTS.some((p) => s.startsWith(p) && (DONE_SAID.has(s.slice(p.length)) || MARK.test(s.slice(p.length)))));
    return said(norm(t, false)) || said(norm(t)); // "on to the next one" as it is, or "done, next" without its tail
  }
  const SKIP_SAID = new Set(['skip', 'skip it', 'skip that', 'skip this', 'skip this one', 'skip that one', 'not now', 'not today', 'not right now', 'pass', 'later', 'maybe later',
    'do it later', "i'll do it later", 'ill do it later', 'next time', 'postpone', 'postpone it', 'push it', 'push it back', 'not doing that', 'not doing it', "can't right now",
    'cant right now', "can't do it now", 'cant do it now', "won't do it today", 'wont do it today', 'not this one', 'skip for now', 'skip for today']);
  const isBareSkip = (t) => [norm(t, false), norm(t)].some((x) => SKIP_SAID.has(x.replace(/^i'?m going to |^gonna /, '')));

  // Does a report cover the whole step on screen? Every part of the step ("X and Y") must share a word with it.
  const PAST = { fed: 'feed', ate: 'eat', eaten: 'eat', took: 'take', taken: 'take', did: 'do', done: 'do', made: 'make', swept: 'sweep', drank: 'drink', bought: 'buy', went: 'go', gave: 'give', sent: 'send', paid: 'pay', threw: 'throw', put: 'put', wrote: 'write', ran: 'run', had: 'have', brought: 'bring', got: 'get', hung: 'hang', called: 'call', showered: 'shower' };
  const STOPW = new Set(['the', 'a', 'an', 'my', 'your', 'i', 'to', 'of', 'for', 'and', 'with', 'on', 'in', 'at', 'it', 'is', 'just', 'already', 'today', 'that', 'this', 'up', 'out', 'me', 'have', 'done', 'do', 'if', 'you', 'can', 'outside', 'quick', 'then', 'now', 'some', 'all', 'his', 'her', 'their', 'still', 'there', 'are', 'last', 'night', 'next']);
  const words = (t) => (t.toLowerCase().match(/[a-z0-9]+/g) || []).map((w) => PAST[w] || (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w)).filter((w) => !STOPW.has(w));
  function coversStep(report, stepSay) {
    if (!stepSay) return false;
    const r = new Set(words(report));
    const parts = stepSay.replace(/^(?:Saved\. )?Next: /, '').replace(/[.,]$/, '').split(/\s+and\s+|,\s*/i).map(words).filter((p) => p.length);
    return parts.length > 0 && parts.every((p) => p.some((w) => r.has(w)));
  }

  // ---- inferring misheard words from the situation ----
  // Words that are real everyday English: never replaced on their own (only inside a two-word phrase that sounds
  // exactly like a planner phrase, e.g. "came lab" → "chem lab").
  const COMMON = new Set(`a an the i me my mine we us our you your he him his she her it its they them their this that these those
    is am are was were be been being do does did done doing have has had having will would can could should shall may might must
    and or but if then so because as at by for from in into of off on onto out over to up with without about after before again all any
    some no not only just also very too now today tonight tomorrow yesterday here there where when what which who how why
    go goes went gone going get got getting make made making take took taken taking put give gave come came see saw know knew
    think thought say said tell told want need like feel felt look looked use used find found try tried call called work worked
    eat ate eaten fed feed drink drank one two three four five six seven eight nine ten first second next last more less
    ok okay yes yeah yep no nope please thanks thank finished start started stop stopped skip later back good bad big small
    little time minute minutes hour hours day night morning evening afternoon week still already ready late early swept brushed
    cleaned washed showered scooped watered paid sent bought turned handed set let run ran keep kept left right well much many`.split(/\s+/));
  // Sound key: letters that are easy to confuse by ear (b/p, d/t, g/k, v/f, s/z, c/k) count as the same; vowels after the first letter drop.
  function soundKey(w) {
    let s = String(w).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!s || /^\d+$/.test(s)) return s;
    s = s.replace(/^(kn|gn|pn|wr)/, (m) => m[1]).replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/sch/g, 'sk').replace(/ch/g, 'k').replace(/sh/g, 's')
      .replace(/th/g, 't').replace(/c(?=[eiy])/g, 's').replace(/[cq]/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's').replace(/dg/g, 'j').replace(/gh/g, '')
      .replace(/wh/g, 'w').replace(/v/g, 'f').replace(/d/g, 't').replace(/b/g, 'p').replace(/g/g, 'k');
    return (s[0] + s.slice(1).replace(/[aeiouyhw]/g, '')).replace(/(.)\1+/g, '$1');
  }
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  const baseOf = (w) => w.replace(/(ings?|ed|es|s|er)$/, '');
  // Everyday planner words, always known, plus whatever the screen shows (the step on screen counts most).
  const STATIC_VOCAB = ['Baby Man', 'litter box', 'nootropic drink', 'smoothie', 'laundry', 'washer', 'dryer', 'basket', 'sheets', 'dishes', 'groceries',
    'avocado', 'blueberries', 'pineapple', 'kiwi', 'steak', 'sandwich', 'deodorant', 'medication', 'vitamin D', 'water bottle', 'Grandma', 'chem lab',
    'calc', 'quiz', 'exam', 'homework', 'checkpoint', 'training program', 'workout', 'haircut', 'therapy', 'Purina', 'Tender Selects', 'ginger', 'bread', 'cheese'];
  function vocabFrom(next) {
    if (!next) return STATIC_VOCAB.map((t) => ({ t, w: 1 }));
    const L = (arr, w) => (arr || []).map((t) => ({ t: String(t).replace(/^(?:now|later|~?\d{1,2}:\d{2}|at \d{1,2}:\d{2}): /, ''), w }));
    return [...L([next.step], 3), ...L(next.after, 2), ...L(next.today, 1.5), ...L(next.plan, 1.5), ...L(next.week, 1), ...L(next.groceries, 1), ...L(STATIC_VOCAB, 1)];
  }
  // Single words (4+ letters, not everyday English) and 2-3 word phrases that start and end with a real content word.
  function termsOf(vocab) {
    const seen = new Map();
    for (const { t, w } of vocab) {
      const ws = (String(t).toLowerCase().match(/[a-z0-9']+/g) || []);
      for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= ws.length; i++) {
        const g = ws.slice(i, i + n);
        if (COMMON.has(g[0]) || COMMON.has(g[g.length - 1]) || g.some((x) => /^\d+$/.test(x))) continue;
        if (n === 1 && g[0].length < 4) continue;
        const k = g.join(' '), prev = seen.get(k);
        if (!prev || prev.w < w) seen.set(k, { t: k, n, key: soundKey(g.join('')), w });
      }
    }
    return [...seen.values()];
  }
  /** Replace words that were probably misheard with the planner word that sounds closest. Returns { text, changes }. */
  function infer(text, vocab) {
    if (!vocab || !vocab.length) return { text, changes: [] };
    const terms = termsOf(vocab), known = new Set(terms.map((t) => t.t));
    const toks = text.split(' '), out = [], changes = [];
    for (let i = 0; i < toks.length;) {
      let hit = null;
      for (const n of [3, 2, 1]) {
        if (i + n > toks.length) continue;
        const win = toks.slice(i, i + n).map((w) => w.toLowerCase().replace(/[^a-z0-9']/g, ''));
        const phrase = win.join(' ');
        if (win.some((w) => !w || /^\d/.test(w)) || known.has(phrase) || win.every((w) => COMMON.has(w))) continue;
        if (n === 1 && (COMMON.has(win[0]) || win[0].length < 4)) continue;
        const key = soundKey(win.join(''));
        let best = null;
        for (const t of terms) {
          if (Math.abs(t.n - n) > 1 || t.t === phrase) continue;
          if (n > 1 && t.n !== n && (COMMON.has(win[0]) || COMMON.has(win[n - 1]))) continue; // "the training pogram" keeps its "the"
          const kd = lev(key, t.key), ld = lev(win.join(''), t.t.replace(/ /g, '')) / Math.max(win.join('').length, t.t.length);
          const ok = n === 1 && t.n === 1
            ? (kd === 0 && ld <= 0.5) || (kd === 1 && key.length >= 4 && ld <= 0.34)
            : (kd === 0 && ld <= 0.5) || (kd === 1 && key.length >= 5 && ld <= 0.3);
          if (!ok) continue;
          if (n === 1 && t.n === 1 && baseOf(win[0]) === baseOf(t.t)) continue; // "swept"/"sweep", "dishes"/"dish": same word
          if (n > 1 && win.filter((w, j) => !COMMON.has(w) && !known.has(w)).length === 0 && kd > 0) continue;
          const score = kd * 2 + ld - t.w * 0.1;
          if (!best || score < best.score) best = { t, score };
        }
        if (best) { hit = { n, to: best.t.t, from: toks.slice(i, i + n).join(' ') }; break; }
      }
      if (hit) { out.push(hit.to); changes.push({ from: hit.from, to: hit.to }); i += hit.n; } else { out.push(toks[i]); i++; }
    }
    return { text: out.join(' '), changes };
  }
  /** Of the recogniser's guesses, the one that makes the most sense here. */
  function bestGuess(alts, today, ctx = {}) {
    let best = null;
    alts.forEach((alt, idx) => {
      const r = toCommands(alt, today, ctx);
      const content = (r.text || alt).toLowerCase().match(/[a-z']+/g) || [];
      const terms = new Set(termsOf(ctx.vocab || []).flatMap((t) => t.t.split(' ')));
      const fit = content.filter((w) => terms.has(w)).length;
      const score = (r.action ? 2 : 0) + (r.commands.length && !r.uncertain ? 3 : 0) + (r.closesCurrent ? 2 : 0) + fit * 0.5 - (r.changes || []).length * 0.4 - idx * 0.3;
      if (!best || score > best.score) best = { alt, score };
    });
    return best ? best.alt : alts[0];
  }

  const DONE_VERBS = 'turned in|handed in|did|finished|completed|took|fed|brushed|scooped|ate|had|washed|cleaned|called|sent|paid|swept|showered|shaved|mopped|vacuumed|emailed|bought|submitted|uploaded|studied|watered|made|drank|filled|organized|folded|checked|refilled|clipped|put on|picked up|dropped off|talked to';

  /**
   * @param {string} said    transcript
   * @param {string} today   YYYY-MM-DD (the user's local date)
   * @returns {{ commands: string[], action: null|'next'|'list'|'week', uncertain: boolean }}
   */
  function toCommands(said, today, ctx = {}) {
    const out = { commands: [], action: null, uncertain: false };
    let text = fix(said.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, ''))
      .replace(/\b(?:um+|uh+|erm|hmm+|uh-huh)\b,?\s*/gi, '').replace(/\b(\w+)( \1\b)+/gi, '$1').trim(); // fillers and stutters ("I I fed")
    if (ctx.vocab) { const inf = infer(text, ctx.vocab); text = inf.text; out.changes = inf.changes; }
    out.text = text;
    if (!text) return out;
    // "done, what's next" / "fed him what's next": the question at the end is its own request
    const tail = text.match(/^(.*?\S)[,.]?\s+(?:so |and |ok(?:ay)? |now )?(?:what'?s|what is) next\??$/i);
    if (tail) { out.action = 'next'; text = tail[1]; }
    const cur = (ctx.tasks || []).filter(Boolean);

    // "wait, pause, I just finished X. what's next?" → handle each sentence
    const parts = text.split(/(?<=[.?!])\s+|\s*;\s*|\s+(?:and then|then)\s+(?=i\b)/i).map((p) => p.trim().replace(/[.?!]+$/, '')).filter(Boolean);
    for (let s of parts) {
      s = s.replace(/^(?:ok(?:ay)?|hey|so|well|alright|all right|yeah|um+|uh+)[, ]+/i, '').replace(/^(?:wait[, ]+)?pause[, ]*/i, '').trim();
      if (!s) continue;
      const low = s.toLowerCase();
      let m;

      // the workout, however it is said
      if (/^i (?:went to|hit|got back from) the gym$|^i (?:worked out|exercised|trained|did (?:my |a |the )?work ?out|finished (?:my |the )?work ?out)$/i.test(s)) { out.commands.push('done: gym'); continue; }
      // a machine that finished is not a report about a load: the planner says which load to move
      if (/^(?:the )?(?:washer|dryer) (?:is|was|just)? ?(?:done|finished|ready|beeped|went off)$/i.test(s)) { out.action = out.action || 'next'; continue; }
      // "done" on its own: the step on screen is finished (its task IDs come from the screen)
      if (isBareDone(s)) { if (cur.length) { out.commands.push(`done: ${cur.join(', ')}`); out.closesCurrent = true; } else out.action = out.action || 'next'; continue; }
      if (isBareSkip(s) && cur.length) { out.commands.push(`skip: ${cur.join(', ')}`); out.closesCurrent = true; continue; }

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

      const ev = eventOf(s, today);
      if (ev) { out.commands.push(ev); continue; }

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
    out.commands = [...new Set(out.commands)];
    // a report that covers the whole step on screen closes it: the screen can move on at once
    if (!out.closesCurrent && ctx.step && out.commands.length && out.commands.every((c) => /^done:/.test(c))) out.closesCurrent = coversStep(out.commands.map((c) => c.slice(5)).join(' and '), ctx.step);
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
    const afterLines = section('After that').split('\n').filter((l) => /^\d+\./.test(l));
    const after = afterLines.map((l) => clean(l.replace(/^\d+\.\s*/, '').split(' — ')[0]));
    const afterIds = afterLines.map((l) => ((l.match(/\(([A-Z0-9][A-Z0-9@#., -]*)\)\s*$/) || [])[1] || '').split(',').map((x) => x.trim()).filter((x) => x && x !== '-'));
    const bullets = (name) => section(name).split('\n').filter((l) => l.startsWith('- ')).map((l) => clean(l.slice(2)));
    return {
      plan: section("Today's plan").split('**Not today:**')[0].split('\n').filter((l) => l.startsWith('- ')).map((l) => clean(l.slice(2))),
      notToday: (section("Today's plan").split('**Not today:**')[1] || '').split('\n').filter((l) => l.startsWith('- ')).map((l) => clean(l.slice(2))),
      made: field('made'), validUntil: field('valid_until'), tired: field('tired') === 'on', brainDead: field('brain_dead') === 'on',
      say: section('Say this'), after, afterIds, today: bullets('Still open today'), week: bullets('Coming up'),
      attention: bullets('Needs your attention'), late: bullets('Late or waiting'), groceries: bullets('Groceries'),
      then: ((section('Now').match(/^- Then: (.*)$/m) || [])[1] || '').trim(),
      step: ((section('Now').match(/^- Do: (.*)$/m) || [])[1] || '').trim(),
      tasks: (((section('Now').match(/^- Tasks: (.*)$/m) || [])[1] || '').split(',').map((x) => x.trim()).filter((x) => x && x !== '-')),
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

  const api = { toCommands, parseNext, pullDate, pullMinutes, freeAnswer, infer, vocabFrom, bestGuess, soundKey, isBareDone, isBareSkip };
  globalThis.PlannerSpeech = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
