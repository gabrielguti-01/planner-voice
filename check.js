// The planner's spelling and grammar check: one module for the phone view, the laptop view and engine/hear.mjs.
// Rule-based on purpose: the same sentence with the same personal words always gives the same result. It changes
// only the free-text parts of an inbox line (titles, reasons, solutions, notes) and never what the engine matches
// on. A changed line gets "| said <the user's own words>", so nothing is lost and any fix can be undone
// (rules/CORE.md §said). If the dictionary isn't loaded, or anything throws, callers send the line unchanged.
// Works as a plain <script> (globalThis.PlannerCheck; load spell/nspell.js first, then PlannerCheck.load(aff, dic))
// and under Node (reads spell/ next to this file on first use).

(function () {
  'use strict';

  // ---------- word lists (written for this checker) ----------
  // Everyday English words: used only to choose between equally close fixes and to accept a missing space
  // ("forthis" → "for this", not "fort his").
  const COMMON = new Set(`confirm exercise schedule review submit organize calendar appointment beginning dentist doctor homework
    assignment practice receipt believe receive separate definitely address finally necessary recommend restaurant tomorrow
    a about above across act action actually add added address after again against age ago agree ahead all allow
    almost alone along already also always am amount an and another answer any anyone anything anyway app apps are area around as ask
    asked at away back bad bank be because become been before began begin behind being believe below best better between big bill bit
    black board body book both box break bring brought build built business but buy by call called came can card care case cat cause
    certain change changed check checks city class clean clear close code cold come comes coming company complete could country
    course cover create cut daily data date day days deal decide decided design did different do does doing done door down draft
    drink drive during each early easy eat email end english enough even evening event ever every everything example far fast feel
    few figure figured file final find fine finish finished first fix follow food for form found free friday friend from front full
    fun game gave get gets getting give given go goes going gone good got grammar great group grow had half hand happen happened
    hard has have having he head hear heard help her here high him his hold home hope hour hours house how idea if important in
    info into is issue it its itself job just keep kept kind knew know last late later learn least leave left less let letter level life
    light like line list little live long look looking lot lots love low made mail main make makes making man many mark may maybe me
    mean meeting message might mind minute minutes miss moment monday money month more morning most move much must my name need
    needed needs never new news next nice night no none not note notes nothing now number of off offer often old on once one only open
    or order other our out over own page paper part pay people person phone pick place plan planner plans play please point policy
    possible post price print problem program programs project projects put question quick quite read ready real really reason receive
    remember report rest right room run said same saturday save saw say school second see seem seen sell send sent sentence sentences
    set she short should show side sign since site small so some someone something sometimes soon sort space speak specific
    specifically spend start started state step steps still stop store story study such sunday support sure system take talk task
    tasks team tell test text than thank that the their them then there these they thing things think this those though thought three
    through thursday time times to today together told too took top toward try tuesday turn two type under understand until up update
    us use used user using very wait want wanted was watch water way we website wednesday week well went were what when where whether
    which while who whole why will with without word words work worked working world would write writing wrong year yes yet you your`.split(/\s+/));
  // Real words the dictionary doesn't have yet: never flagged.
  const ALLOW = new Set(`signup signups dropdown dropdowns webhook webhooks backend frontend subreddit wifi ok todo todos repo repos config
    dev devs api apis chatbot chatbots url urls cofounder cofounders preorder preorders presale waitlist nootropic nootropics walkthrough
    walkthroughs etc app apps email emails inbox login logout signin setup username checkbox timestamp workflow workflows screenshot
    screenshots smoothie smoothies laptop online offline website websites vlog pdf pdfs tbh lol idk imo btw fyi asap diy irl omg ngl pls
    plz thx calc chem bio psych stats econ`.split(/\s+/));
  // (names of people, places, products and projects come from the personal dictionary the page builds at run time)
  // Typos the dictionary's own suggestions miss or rank badly (lowercase in, the fix out).
  const TYPOS = { teh: 'the', hte: 'the', adn: 'and', nad: 'and', taht: 'that', thta: 'that', waht: 'what', wiht: 'with', jsut: 'just',
    becuase: 'because', becasue: 'because', beacuse: 'because', alot: 'a lot', im: "I'm", ive: "I've", dont: "don't", doesnt: "doesn't",
    didnt: "didn't", isnt: "isn't", arent: "aren't", wasnt: "wasn't", werent: "weren't", shouldnt: "shouldn't", couldnt: "couldn't",
    wouldnt: "wouldn't", hasnt: "hasn't", havent: "haven't", hadnt: "hadn't", youre: "you're", theyre: "they're", thats: "that's",
    whats: "what's", theres: "there's", heres: "here's", youve: "you've", theyve: "they've", youll: "you'll", theyll: "they'll",
    itll: "it'll", wouldve: "would've", couldve: "could've", shouldve: "should've", whos: "who's", doesent: "doesn't" };
  // Short words that a missing space usually sits next to ("whatcame", "forthis"); a split needs one of them, so
  // compounds such as "runbook" or "handoff" stay whole.
  const FUNC = new Set(`the a an to of in on at for and or but if is it as by with from this that what my your our we you he she they his
    her its their be are was were am do did not no so up out into than then when where which who how all any some can will would could
    should have has had just me us them there here i`.split(/\s+/));
  // Days, months and languages: the only lowercase words given a capital.
  const NAMES = new Set('monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december english spanish american christmas thanksgiving easter halloween'.split(' '));
  // A field with Spanish in it is left as written.
  const SPANISH = new Set('de la el los las que para por con del una uno unos unas y es se al lo su sus como pero esta este son hay muy también ya donde cuando porque sin sobre entre hasta desde nos les'.split(' '));
  // Words after which "a" is a letter used as a label ("option a", "vitamin a", "plan a"), not the article.
  const LABELS = new Set('option options vitamin vitamins plan plans grade grades type types part parts step steps group groups size sizes class row column item point letter exhibit appendix section level tier version'.split(' '));
  // A doubled word that is almost always a slip ("the the"); "had had" and "that that" can be right, so they aren't here.
  const NO_DOUBLE = new Set('the a an to of in on at for and or it my me we you with this be by from as so but not your our their his her its'.split(' '));

  // ---------- the dictionary (nspell + Hunspell en_US from dictionary-en; see spell/SOURCE.md) ----------
  const NODE = typeof module !== 'undefined' && !!module.exports && typeof require === 'function' && typeof __dirname === 'string';
  let aff = null, dic = null, sp = null, broken = null;
  /** Browser: hand over the two dictionary files (text). Node reads them by itself. */
  function load(a, d) { aff = a || null; dic = d || null; sp = null; broken = null; }
  /** True when a check can run now (the dictionary is there or, under Node, can be read). */
  const ready = () => !broken && (NODE || !!(aff && dic));
  function speller() {
    if (sp) return sp;
    if (broken) throw broken;
    try {
      let NS = globalThis.NSpell;
      if (NODE && (!NS || !aff || !dic)) {
        const fs = require('fs'), path = require('path'), dir = path.join(__dirname, 'spell');
        if (!NS) NS = require(path.join(dir, 'nspell.js'));
        if (!aff || !dic) { aff = fs.readFileSync(path.join(dir, 'index.aff'), 'utf8'); dic = fs.readFileSync(path.join(dir, 'index.dic'), 'utf8'); }
      }
      if (typeof NS !== 'function' || !aff || !dic) throw new Error('the spelling dictionary is not loaded');
      sp = NS({ aff, dic });
      return sp;
    } catch (e) { broken = e; throw e; }
  }
  /** Build the speller now (it is otherwise built on first use). Returns false when it can't be built. */
  function warm() { try { speller(); return true; } catch { return false; } }

  // ---------- protected text: never changed, byte for byte ----------
  const PROTECT = [
    /`[^`]*`/g, // code
    /"[^"]*"|“[^”]*”|(?<![\w’'])['‘][^'’\n]{1,120}['’](?![\w’'])/g, // quoted text ("…", “…”, '…', ‘…’; not apostrophes)
    /\bhttps?:\/\/\S+|\bwww\.\S+/gi, // web addresses
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // email addresses
    /(?:^|\s)@\s*(?:yesterday|\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2})?|\d{1,2}:\d{2})/gi, // "@ yesterday", "@ 14:30"
    /\+?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, // phone numbers
    /\S*\\\S*|(?:^|(?<=[\s(]))\.\w[\w.-]*|\b\w[\w-]*(?:\.\w[\w-]*)+|[\w.~-]*[\w~-]\/[\w./~-]*\w|\b[\w-]+\.(?:md|js|mjs|cjs|ts|tsx|jsx|json|html|css|txt|pdf|png|jpe?g|webp|csv|xlsx|docx|py|cmd|sh|yml|yaml|com|org|net|io|ai|app|dev|co|us|edu|gov)\b(?::\d+)?/gi, // paths, files, sites
    /[$€£]\s?\d[\d,.]*\w*/g, // amounts
    /\b[\w'’]*\d[\w'’]*(?:[:.,/-]\d+)*\b%?/g, // numbers, dates, times, anything with a digit
    /\b[A-Za-z][A-Za-z0-9]*(?:[-_@][A-Za-z0-9:]+)*@[\w:-]+|\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+\b/g, // IDs: GET-DOMAIN-BUSINESS-EMAIL, X@2026-11-16
    /\b[A-Z]{2,}(?:['’]?s)?\b/g, // ACRONYMS, APIs
    /\b\w*[a-z]\w*[A-Z]\w*\b/g, // mixed case: eBay, iPhone, JavaScript
    /->|<-|=>|<=|>=/g,
  ];
  /** [start, end) ranges of protected text, merged. */
  function protectedRanges(text) {
    const r = [];
    for (const re of PROTECT) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const lead = /^\s/.test(m[0]) && re.source.startsWith('(?:^|\\s)@') ? 1 : 0;
        r.push([m.index + lead, m.index + m[0].length]);
      }
    }
    r.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const out = [];
    for (const x of r) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push([...x]); }
    return out;
  }
  // tokens: w = word, s = spaces, p = one other character, x = protected text
  function tokenize(text) {
    const toks = [], ranges = protectedRanges(text);
    let i = 0;
    const plain = (s) => { for (const m of s.matchAll(/\p{L}+(?:['’]\p{L}+)*|[ \t]+|[\s\S]/gu)) toks.push({ k: /^\p{L}/u.test(m[0]) ? 'w' : /^[ \t]+$/.test(m[0]) ? 's' : 'p', t: m[0], o: m[0] }); };
    for (const [a, b] of ranges) { if (a > i) plain(text.slice(i, a)); toks.push({ k: 'x', t: text.slice(a, b), o: text.slice(a, b) }); i = b; }
    if (i < text.length) plain(text.slice(i));
    return toks;
  }
  const join = (toks) => toks.map((t) => t.t).join('');

  // ---------- small helpers ----------
  const lc = (s) => s.toLowerCase().replace(/’/g, "'");
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const isCap = (w) => /^[A-Z][a-z'’]*$/.test(w);
  const VOWELS = 'aeiou';
  const KEYS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const NEAR = {};
  KEYS.forEach((row, r) => [...row].forEach((ch, c) => {
    const n = new Set([row[c - 1], row[c + 1], (KEYS[r - 1] || '')[c], (KEYS[r - 1] || '')[c + 1], (KEYS[r + 1] || '')[c - 1], (KEYS[r + 1] || '')[c]].filter(Boolean));
    NEAR[ch] = n;
  }));
  const subCost = (a, b) => (VOWELS.includes(a) && VOWELS.includes(b) ? 0.6 : NEAR[a] && NEAR[a].has(b) ? 0.8 : 1);
  /** Weighted edit distance: vowel slips, neighbouring keys, doubled letters, apostrophes and swaps cost less. */
  function cost(a, b) {
    const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) d[i][0] = d[i - 1][0] + (a[i - 1] === a[i - 2] || a[i - 1] === "'" ? 0.5 : 1);
    for (let j = 1; j <= b.length; j++) d[0][j] = d[0][j - 1] + (b[j - 1] === b[j - 2] || b[j - 1] === "'" ? 0.5 : 1);
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      const del = a[i - 1] === "'" ? 0.3 : a[i - 1] === a[i - 2] || a[i - 1] === b[j - 1] ? 0.5 : 1;
      const ins = b[j - 1] === "'" ? 0.3 : b[j - 1] === b[j - 2] || b[j - 1] === a[i - 1] ? 0.5 : 1;
      let v = Math.min(d[i - 1][j] + del, d[i][j - 1] + ins, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : subCost(a[i - 1], b[j - 1])));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 0.5); // a swap: the commonest typing slip
      d[i][j] = v;
    }
    return d[a.length][b.length];
  }
  /** Plain edit distance (letters only, case-insensitive): the guard's measure. */
  function lev(a, b) {
    a = lc(a); b = lc(b);
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // the fix in the word's own case: "Specefically" → "Specifically"; a fix with its own capital ("I'm") keeps it
  const withCase = (orig, fix) => (/[A-Z]/.test(fix) ? fix : isCap(orig) ? cap(fix) : fix);

  // ---------- one word ----------
  /** A clear fix for one misspelled word, or null (unclear words stay as they are). */
  function wordFix(word, o) {
    const low = lc(word);
    if (TYPOS[low]) return withCase(word, TYPOS[low]);
    if (low.length < 3 || ALLOW.has(low) || o.words.has(low) || /[^a-z']/.test(low)) return null; // accents: another language or a name
    const s = speller();
    if (s.correct(word) || s.correct(low) || knownForm(low, s)) return null;
    // a day or month typed in lowercase gets its capital
    if (word === low && NAMES.has(low)) return cap(low);
    // only two everyday words, one of them short: "Whatcame" → "What came"; a capitalized word (maybe a name) needs 6+ letters
    const split = word === low || low.length >= 6 ? splitFix(low, s, o) : null;
    if (split) return withCase(word, split);
    if (compound(low, s)) return null; // "chipset", "hardcoded": two real words written as one
    if (low.length <= 3 || low.length > 20 || o.budget.n <= 0) return null; // 3-letter words: only the TYPOS list
    o.budget.n--;
    const known = (w) => COMMON.has(w) || o.words.has(w);
    const cands = [...new Set(s.suggest(low))]
      .filter((c) => /^[a-z]+(?:'[a-z]+)?$/.test(c) && c !== low && (!c.includes("'") || c.replace("'", '') === low))
      // the first letter may be mistyped ("gigured") but not added or dropped ("iphone" isn't "phone"); a short word only becomes an everyday one
      .filter((c) => (c[0] === low[0] || (c.length === low.length && word === low && known(c))) && (low.length > 5 || known(c)))
      .map((c) => { const raw = cost(low, c); return { c, raw, v: raw + (c[0] !== low[0] ? 1 : 0) }; })
      // a capitalized word (the start of a sentence) may be a new name: it keeps its first letter and only takes a near slip
      // (a swap or a doubled letter, "Scheudle", "Reveiw"), one close edit in a longer word ("Comfirm", "Excercise"), or an
      // everyday word ("Desing" → "Design"); never "Kalena" → "Galena" or "Maira" → "Mara"
      .filter((x) => word === low || (x.c[0] === low[0] && (x.raw <= 0.5 || (known(x.c) && low.length >= 5 && x.raw <= 1))))
      .sort((a, b) => a.v - b.v || (a.c < b.c ? -1 : 1));
    // a word far from every real word is a name or a brand, not a slip: short words need one near slip, middle ones one edit
    if (!cands.length || cands[0].raw > (low.length <= 5 ? 0.8 : low.length <= 8 ? 1.3 : 2)) return null;
    // clear = the only close fix, or the only everyday word among the close ones and itself one of the closest
    const near = cands.filter((x) => x.v <= cands[0].v + 0.35);
    let pick = near.length === 1 ? near[0].c : null;
    if (!pick) { const k = near.filter((x) => known(x.c)); if (k.length === 1 && k[0].v === cands[0].v) pick = k[0].c; }
    return pick ? withCase(word, pick) : null;
  }
  /**
   * A real word the dictionary lacks in this form: an inflection of a known word ("reinstalls"), a prefix on one
   * ("unticked"), or the British spelling of one ("colour", "organise", "cancelled"). Left as written.
   */
  function knownForm(low, s) {
    for (const suf of ['s', 'es', 'ed', 'd', 'ing', 'er', 'ers', 'ly', 'ness']) if (low.endsWith(suf) && low.length - suf.length >= 4 && s.correct(low.slice(0, -suf.length))) return true;
    const pre = low.match(/^(un|re|pre|non|over|under|out|mis|sub|super|anti|multi|self)-?(.{5,})$/);
    if (pre && (s.correct(pre[2]) || knownForm(pre[2], s))) return true;
    const uk = [low.replace(/our(?=s?$|ed$|ing$|ful|ite|able)/, 'or'), low.replace(/is(e|ed|es|ing|ation|ations)$/, 'iz$1'), low.replace(/ys(e|ed|es|ing)$/, 'yz$1'),
      low.replace(/tre(s?)$/, 'ter$1'), low.replace(/ll(ed|ing|er|ers)$/, 'l$1'), low.replace(/ogue(s?)$/, 'og$1'), low.replace(/ence$/, 'ense')];
    return uk.some((v) => v !== low && s.correct(v));
  }
  function compound(low, s) {
    for (let i = 4; i <= low.length - 3; i++) if (s.correct(low.slice(0, i)) && s.correct(low.slice(i))) return true;
    return false;
  }
  /** "whatcame" → "what came", "forthis" → "for this": only when exactly one split is two everyday words, one of them short. */
  function splitFix(low, s, o) {
    if (low.length < 5 || low.includes("'")) return null;
    const known = (w) => COMMON.has(w) || FUNC.has(w) || o.words.has(w);
    const both = [];
    for (let i = 1; i < low.length; i++) {
      const a = low.slice(0, i), b = low.slice(i);
      if (a.length < 2 || b.length < 2) continue; // no one-letter parts ("iphone" isn't "I phone")
      if (!s.correct(a) || !s.correct(b)) continue;
      if (known(a) && known(b) && (FUNC.has(a) || FUNC.has(b))) both.push([a, b]);
    }
    return both.length === 1 ? `${both[0][0]} ${both[0][1]}` : null;
  }

  // ---------- one free-text field ----------
  const CAP_FIELDS = new Set(['title', 'solution', 'because', 'text']); // workflow steps follow "…: step 2 of 3, " in lowercase
  const SOUND = (w) => {
    const x = lc(w);
    if (/^(?:uni(?![nmdl])|use|usu|uti|ura|ure|uro|eu|ewe|one\b|once|ouija)/.test(x)) return false;
    if (/^(?:hour|honest|honor|honour|heir|herb)/.test(x)) return true;
    return VOWELS.includes(x[0]);
  };
  /**
   * Fix one free-text field. opts: { words: Set of lowercase personal words, field: 'title'|'step'|'solution'|'because'|
   * 'why'|'note'|'left'|'goal'|'text', budget }. Returns { text, changes: [{ from, to }] }. Throws when the dictionary
   * can't be built (callers then keep the text as it was).
   */
  function fixText(text, opts = {}) {
    const o = { words: opts.words instanceof Set ? opts.words : wordsOf(opts.words || []), budget: opts.budget || { n: 8 }, field: opts.field || 'text' };
    const src = String(text);
    if (!src.trim()) return { text: src, changes: [] };
    speller(); // build (or fail) before changing anything, so a broken dictionary changes nothing at all
    const toks = tokenize(src), other = [];
    // Spanish (accents, ¿¡, or two Spanish little words): left exactly as written
    if (/[¿¡]/.test(src) || toks.filter((t) => t.k === 'w' && (SPANISH.has(lc(t.t)) || /[áéíóúñ]/i.test(t.t))).length >= 2) return { text: src, changes: [] };
    const note = (from, to, kind) => { if (from !== to) other.push({ from, to, kind }); };
    const prevWord = (i) => { for (let j = i - 1; j >= 0; j--) { if (toks[j].k === 's') continue; return toks[j]; } return null; };
    // 1. words: "i" → "I", known typos, misspellings, missing spaces
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.k !== 'w') continue;
      if (/^i(?:['’](?:m|ve|ll|d))?$/.test(t.t)) { t.t = 'I' + t.t.slice(1); continue; }
      const before = prevWord(i);
      const abbr = before && before.t === '.' && (() => { for (let j = toks.indexOf(before) - 1; j >= 0; j--) { if (toks[j].k === 's') continue; return toks[j].k === 'w' && ABBR.has(lc(toks[j].t)); } return false; })();
      const sentenceStart = !before || (before.k === 'p' && /[.!?]/.test(before.t) && !abbr);
      if (/[A-Z]/.test(t.t) && !(sentenceStart && isCap(t.t))) continue; // a name (or an ACRONYM): left alone
      const to = wordFix(t.t, o);
      if (to) t.t = to;
    }
    // 2. doubled words ("the the")
    for (let i = 0; i + 2 < toks.length; i++) {
      const a = toks[i], s = toks[i + 1], b = toks[i + 2];
      if (a.k === 'w' && s.k === 's' && s.t === ' ' && b.k === 'w' && lc(a.t) === lc(b.t) && NO_DOUBLE.has(lc(a.t)) && !/^[A-Z]$/.test(b.t)) { note(`${a.o} ${b.o}`, a.o, 'double'); toks.splice(i + 1, 2); i--; }
    }
    // 3. a / an before a lowercase word (not a letter used as a label: "option a or b", "vitamin a and zinc")
    for (let i = 0; i + 2 < toks.length; i++) {
      const a = toks[i], s = toks[i + 1], b = toks[i + 2];
      if (a.k !== 'w' || !/^(?:a|an)$/.test(a.t) || s.k !== 's' || b.k !== 'w' || !/^[a-z]/.test(b.t) || b.t.length < 2 || o.words.has(lc(b.t))) continue;
      const before = prevWord(i);
      if (/^(?:or|and|nor|to|through|thru|plus|minus)$/i.test(b.t) || (before && before.k === 'w' && LABELS.has(lc(before.t)))) continue;
      const want = SOUND(b.t) ? 'an' : 'a';
      if (lc(a.t) !== want) a.t = a.t[0] === 'A' ? cap(want) : want;
    }
    // 4. spacing: one space between words, none before , . ; : ! ?, one after , and ; before a letter
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.k === 's' && i > 0 && i < toks.length - 1 && t.t !== ' ') { note(`"${t.t}"`, '" "', 'spacing'); t.t = ' '; }
      if (t.k === 's' && i > 0 && toks[i + 1] && toks[i + 1].k === 'p' && /^[,.;:!?]$/.test(toks[i + 1].t) && /[wx]/.test(toks[i - 1].k)
        && !(toks[i + 1].t === '.' && toks[i + 2] && toks[i + 2].k === 'p' && toks[i + 2].t === '.')) { note(`${toks[i - 1].t} ${toks[i + 1].t}`, `${toks[i - 1].t}${toks[i + 1].t}`, 'spacing'); toks.splice(i, 1); i--; continue; }
      if (t.k === 'p' && /^[,;]$/.test(t.t) && i > 0 && /[wx]/.test(toks[i - 1].k) && toks[i + 1] && toks[i + 1].k === 'w') { note(`${t.t}${toks[i + 1].t}`, `${t.t} ${toks[i + 1].t}`, 'spacing'); toks.splice(i + 1, 0, { k: 's', t: ' ', o: '' }); }
    }
    // 5. the first letter's capital, where the planner's style has one (titles, solutions, done's reasons, notes),
    //    and only in a field that had something else to fix (a capital alone isn't worth a "said")
    if (CAP_FIELDS.has(o.field) && (other.length || toks.some((t) => t.t !== t.o))) {
      const f = toks.find((t) => t.k !== 's');
      const w1 = f && f.k === 'w' ? f.t.split(' ')[0] : ''; // a split word ("what came") is checked by its first part
      if (/^[a-z]/.test(w1) && !o.words.has(lc(w1)) && (COMMON.has(lc(w1)) || speller().correct(w1))) f.t = cap(f.t);
    }
    const out = join(toks);
    if (out === src) return { text: out, changes: [] };
    // one entry per changed word (a fix and its capital together), then the doubled words and the spacing
    const words = toks.filter((t) => t.k === 'w' && t.o && t.t !== t.o).map((t) => ({ from: t.o, to: t.t, kind: lc(t.o) === lc(t.t) ? 'capitals' : 'word' }));
    return { text: out, changes: [...words, ...other] };
  }

  // ---------- inbox lines ----------
  const LINE = /^(\s*(?:-\s*)?(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*)?)([A-Za-z][A-Za-z ]*?)(\s*:\s*)([\s\S]*)$/;
  // verbs whose free text is checked; everything else (groceries, laundry, food counts, settings…) is left alone
  const MAIN = { add: 'title', event: 'title', workflow: 'title', note: 'note' };
  const LAST = { notes: 3, library: 3, write: 2 }; // "<task> | <heading> | <text>", "[<topic> |] <text>": only the text, never the names
  const TARGET = new Set(['set', 'done', 'did', 'solved', 'skip', 'cancel', 'started', 'start', 'planned', 'plan', 'waiting', 'blocked', 'move', 'remove', 'undo', 'first']);
  const OPTS = { why: 'why', note: 'note', because: 'because', solution: 'solution', left: 'left' };
  const SET_OPTS = { title: 'title', goal: 'goal' };
  const SAID_TAGS = ['text', 'title', 'why', 'note', 'because', 'solution', 'left', 'goal', 'steps'];
  /** The checkable fields of an inbox line, with exact positions so the rest stays byte for byte. */
  function parseLine(line) {
    const m = String(line).match(LINE);
    if (!m) return null;
    const verb = m[2].toLowerCase().trim();
    const segs = m[4].split('|');
    const opt = (s) => s.match(/^(\s*)([a-z_]+)(\s+)([\s\S]*?)(\s*)$/i);
    const out = { prefix: m[1] + m[2] + m[3], verb, segs, fields: [] };
    if (!(verb in MAIN) && !(verb in LAST) && !TARGET.has(verb)) { out.skip = 'verb'; return out; }
    if (verb in LAST && segs.length > LAST[verb]) { out.skip = 'bars'; return out; } // a "|" inside the text: left as written
    for (const s of segs.slice(1)) {
      const o = opt(s);
      if (o && o[2].toLowerCase() === 'said') { out.skip = 'said'; return out; } // already carries the user's words
      if (o && o[2].toLowerCase() === 'source' && /^email\b/i.test(o[4])) { out.skip = 'email'; return out; } // lines from the email app stay as written
    }
    const field = (seg, key, kind, lead, body, trail, tag) => out.fields.push({ seg, key, field: kind, lead, body, trail, tag });
    const whole = (i, kind, tag) => { const x = segs[i].match(/^(\s*)([\s\S]*?)(\s*)$/); if (x[2]) field(i, null, kind, x[1], x[2], x[3], tag); };
    if (verb in MAIN) whole(0, MAIN[verb], '');
    // the text of notes:, library: and write: is always tagged "said text:" (the text itself may begin with "said")
    if (verb in LAST) { if (segs.length === LAST[verb] || (verb === 'write' && segs.length === 1)) whole(segs.length - 1, 'text', 'text'); return out; }
    for (let i = 1; i < segs.length; i++) {
      const o = opt(segs[i]);
      if (!o) continue;
      const key = o[2].toLowerCase();
      if (key === 'steps' && verb === 'workflow') { field(i, key, 'step', o[1] + o[2] + o[3], o[4], o[5], 'steps'); continue; }
      // reasons on done/solved start with a capital (state/solved.md); on skip/cancel they are lowercase notes
      const kind = key === 'because' && !['done', 'did', 'solved'].includes(verb) ? 'reason' : OPTS[key] || (verb === 'set' ? SET_OPTS[key] : null);
      if (kind && o[4]) field(i, key, kind, o[1] + o[2] + o[3], o[4], o[5], key);
    }
    return out;
  }
  // a workflow's steps are fixed one by one, so the ";" between them stays exactly as typed
  function fixSteps(body, opts) {
    const parts = body.split(';'), changes = [];
    const fixed = parts.map((p) => { const x = p.match(/^(\s*)([\s\S]*?)(\s*)$/); if (!x[2]) return p; const r = fixText(x[2], { ...opts, field: 'step' }); changes.push(...r.changes); return x[1] + r.text + x[3]; });
    return { text: fixed.join(';'), changes };
  }
  const saidText = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  /**
   * Check one inbox line (with or without its "- "). opts: { words, use: [field texts to use instead of this check's
   * own fixes, e.g. the guarded AI answer] }. Returns { line, changed, fields: [{ field, tag, from, to, changes }],
   * changes }. A changed line ends with "| said <the user's words>" for each changed field. Throws on a broken dictionary.
   */
  function fixLine(line, opts = {}) {
    const src = String(line);
    const p = parseLine(src);
    if (!p || p.skip || !p.fields.length) return { line: src, changed: false, fields: [], changes: [] };
    const words = opts.words instanceof Set ? opts.words : wordsOf(opts.words || []);
    const budget = { n: 8 };
    const segs = [...p.segs], fields = [], said = [];
    p.fields.forEach((f, i) => {
      const own = f.field === 'step' ? fixSteps(f.body, { words, budget }) : fixText(f.body, { words, budget, field: f.field });
      const use = opts.use && typeof opts.use[i] === 'string' ? opts.use[i] : null;
      const to = use !== null ? use : own.text;
      const changes = use !== null ? diffWords(f.body, use) : own.changes;
      fields.push({ field: f.field, tag: f.tag, from: f.body, to, changes });
      if (to === f.body) return;
      segs[f.seg] = f.lead + to + f.trail;
      const words0 = saidText(f.body);
      const tagged = f.tag || (new RegExp(`^(?:${SAID_TAGS.join('|')})\\s*:`, 'i').test(words0) ? 'text' : '');
      said.push(`said ${tagged ? `${tagged}: ` : ''}${words0}`);
    });
    if (!said.length) return { line: src, changed: false, fields, changes: [] };
    const body = segs.join('|');
    const out = p.prefix + body.replace(/\s+$/, '') + said.map((s) => ` | ${s}`).join('');
    return { line: out, changed: true, fields, changes: fields.flatMap((f) => f.changes) };
  }
  /** Several lines; a line that fails stays as it was (never costs a save). */
  function fixLines(lines, opts = {}) {
    const words = opts.words instanceof Set ? opts.words : wordsOf(opts.words || []);
    return lines.map((l) => { try { return fixLine(l, { ...opts, words }); } catch { return { line: l, changed: false, fields: [], changes: [], failed: true }; } });
  }

  // ---------- "| said": the user's own words (the engine reads these) ----------
  /** "| said why: …" parts → { text|why|…: words }. The untagged part is the line's main text. */
  function saidOf(parts) {
    const out = {};
    for (const p of parts) {
      const m = String(p).match(new RegExp(`^(${SAID_TAGS.join('|')})\\s*:\\s*([\\s\\S]*)$`, 'i'));
      const key = m ? m[1].toLowerCase() : 'text', val = (m ? m[2] : p).trim();
      if (val) out[key] = val;
    }
    return out;
  }

  // ---------- comparing texts ----------
  const wordsIn = (s) => String(s).match(/[^\s]+/g) || [];
  const bare = (w) => lc(w).replace(/^[^\w']+|[^\w']+$/g, '');
  /** Word-level differences, "x → y" runs: what was fixed (for "Fixed: …" and "Last saved"). */
  function diffWords(a, b) {
    const A = wordsIn(a), B = wordsIn(b), n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0, j = 0, fa = [], fb = [];
    const flush = () => { if (fa.length || fb.length) out.push({ from: fa.join(' '), to: fb.join(' ') }); fa = []; fb = []; };
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { flush(); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) fb.push(B[j++]);
      else fa.push(A[i++]);
    }
    flush();
    return out;
  }
  // what an AI answer may never change: dates (day and month names, today…), number words, negations, names
  const DATE_WORDS = new Set([...NAMES].filter((w) => !['english', 'spanish', 'american', 'christmas', 'thanksgiving', 'easter', 'halloween'].includes(w))
    .concat('today tomorrow tonight yesterday weekend weekday noon midnight mon tue tues wed thu thur thurs fri sat sun jan feb mar apr jun jul aug sep sept oct nov dec'.split(' ')));
  const NUMBER_WORDS = new Set(`zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen
    nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion first second third fourth fifth sixth seventh eighth
    ninth tenth last once twice half double triple dozen both all none every each`.split(/\s+/));
  const isNegation = (w) => /^(?:not|no|never|none|nothing|nobody|nowhere|neither|nor|without|cannot|nope|aint|(?:do|does|did|is|are|was|were|ca|wo|would|should|could|has|have|had|must|need)nt)$/.test(w) || /n['’]t$/.test(w); // "dont" too
  // pairs that are commonly mixed up, so an AI may swap one real word for the other
  const CONFUSABLE = new Set(`affect:effect advice:advise breath:breathe lose:loose quiet:quite quit:quite then:than were:where we're:were your:you're
    its:it's there:their their:they're there:they're whose:who's to:too weather:whether principal:principle stationary:stationery
    complement:compliment desert:dessert personal:personnel lead:led past:passed peak:peek brake:break bare:bear site:sight cite:site
    planar:planner of:off a:an accept:accepts`.split(/\s+/).flatMap((p) => { const [a, b] = p.split(':'); return [`${a}:${b}`, `${b}:${a}`]; }));
  // the same consonant skeleton, first letter kept: "planar"/"planner", "there"/"their" (speech.js uses the same idea)
  function soundKey(w) {
    let s = lc(w).replace(/[^a-z]/g, '');
    if (!s) return s;
    s = s.replace(/^(kn|gn|pn|wr)/, (m) => m[1]).replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/ch/g, 'k').replace(/sh/g, 's').replace(/th/g, 't')
      .replace(/c(?=[eiy])/g, 's').replace(/[cq]/g, 'k').replace(/z/g, 's').replace(/gh/g, '').replace(/wh/g, 'w').replace(/v/g, 'f');
    return (s[0] + s.slice(1).replace(/[aeiouyhw]/g, '')).replace(/(.)\1+/g, '$1');
  }
  const ABBR = new Set('dr mr mrs ms st jr sr vs etc prof mt ft no'.split(' '));
  const englishWord = (w) => { try { return ready() && (speller().correct(w) || COMMON.has(w)); } catch { return false; } };
  /** The protected pieces of a text, in order: what an AI answer must keep exactly. */
  function protectedOf(text, words) {
    const W = words instanceof Set ? words : wordsOf(words || []);
    const out = [];
    let start = true, prev = ''; // at the start of a sentence a capital is just the sentence's
    for (const t of tokenize(String(text))) {
      if (t.k === 'x') { out.push(t.t); start = false; continue; }
      if (t.k === 'p') { if (/[.!?]/.test(t.t) && !(t.t === '.' && prev && ABBR.has(lc(prev)))) start = true; continue; }
      if (t.k !== 'w') continue;
      const w = lc(t.t);
      if (DATE_WORDS.has(w) || NUMBER_WORDS.has(w)) out.push(w); // a date or a number (its capital may change)
      else if (isNegation(w)) out.push('¬'); // a negation, added or taken away, flips the meaning
      // a name: capitalized mid-sentence, a personal word, or a capitalized word that isn't English ("Kalena" at the start);
      // kept without its capital, so capitalizing a word ("english" → "English", "i" → "I") stays free
      else if (/[A-Z]/.test(t.t) && !/^I(?:['’]\w+)?$/.test(t.t) && (!start || W.has(w) || !englishWord(w))) out.push(`name:${w}`);
      start = false; prev = t.t;
    }
    return out;
  }
  /**
   * The deterministic guard on an AI proofread (step 2). Rejects the answer when a protected piece (link, ID, number,
   * date, quote, name, number word, day or month, negation) differs, the word count moves by more than 1, a changed
   * word is more than 2 edits away, a real word becomes another real word that neither sounds the same nor is a known
   * mix-up ("hire" → "fire", "sell" → "send"), or too many words change. Capitals, punctuation, apostrophes, a/an and
   * I are free. Returns { ok, reason }.
   */
  const GUARD = { max_share: 0.15, min_words: 2 };
  function guard(before, after, opts = {}) {
    const words = opts.words instanceof Set ? opts.words : wordsOf(opts.words || []);
    if (typeof after !== 'string' || !after.trim()) return { ok: false, reason: 'empty answer' };
    if (/[|\n]/.test(after) && !/[|\n]/.test(before)) return { ok: false, reason: 'a "|" or a line break was added' };
    const pa = protectedOf(before, words), pb = protectedOf(after, words);
    const isName = (x) => x.startsWith('name:');
    const fa0 = pa.filter((x) => !isName(x)), fb0 = pb.filter((x) => !isName(x));
    if (fa0.length !== fb0.length || fa0.some((x, i) => x !== fb0[i])) return { ok: false, reason: 'a name, ID, number, date, link, quote or "not" changed' };
    // every name stays; a "new" name may only be a word of the text that got its capital ("english" → "English")
    const had = new Set(wordsIn(before).map(bare)), nb0 = pb.filter(isName).map((x) => x.slice(5));
    if (pa.filter(isName).some((x) => !nb0.includes(x.slice(5))) || nb0.some((x) => !had.has(x))) return { ok: false, reason: 'a name changed' };
    const na = wordsIn(before).length, nb = wordsIn(after).length;
    if (Math.abs(na - nb) > 1) return { ok: false, reason: 'the word count changed by more than 1' };
    const real = (w) => { try { return ready() ? speller().correct(w) || speller().correct(lc(w)) : true; } catch { return true; } };
    let changed = 0;
    for (const d of diffWords(before, after)) {
      const fa = wordsIn(d.from), fb = wordsIn(d.to);
      const same = (x, y) => bare(x) === bare(y); // only case or punctuation differs
      if (fa.length === fb.length && fa.every((x, i) => same(x, fb[i]))) continue;
      const free = (x, y) => (/^(?:a|an)$/.test(bare(x)) && /^(?:a|an)$/.test(bare(y))) || (bare(x) === 'i' && bare(y) === 'i');
      if (fa.length === 1 && fb.length === 1 && free(fa[0], fb[0])) continue;
      if (lev(fa.map(bare).join(''), fb.map(bare).join('')) > 2 * Math.max(1, Math.min(fa.length, fb.length))) return { ok: false, reason: `"${d.from}" → "${d.to}" is more than a small fix` };
      if (fa.length === fb.length) for (let i = 0; i < fa.length; i++) {
        const x = bare(fa[i]), y = bare(fb[i]);
        if (x === y || x.replace(/'/g, '') === y.replace(/'/g, '')) continue; // an apostrophe: "programs" → "program's"
        // a word form added to the same word is a grammar fix: "go" → "goes", "bag" → "bags", "broke" → "broken"
        const inflection = (a, b) => b.startsWith(a) && /^(?:s|es|ed|d|ing|en|n|'s)$/.test(b.slice(a.length));
        if (inflection(x, y)) continue;
        if (real(x) && !real(y)) return { ok: false, reason: `"${fa[i]}" is a real word and "${fb[i]}" isn't` };
        if (!real(x) && !COMMON.has(y) && !(real(y) && x[0] === y[0] && soundKey(x) === soundKey(y))) return { ok: false, reason: `"${fa[i]}" isn't an English word (a name?), and "${fb[i]}" isn't an everyday one` };
        if (real(x) && real(y) && soundKey(x) !== soundKey(y) && !CONFUSABLE.has(`${x}:${y}`)) return { ok: false, reason: `"${fa[i]}" → "${fb[i]}" changes one real word into another` };
      }
      changed += Math.max(fa.length, fb.length, 1);
    }
    if (changed > Math.max(GUARD.min_words, Math.ceil(na * GUARD.max_share))) return { ok: false, reason: 'too many words changed' };
    return { ok: true, reason: '' };
  }

  // ---------- the personal dictionary ----------
  /** Lowercase words from names, titles or vocabFrom() entries ({ t }): never changed, and preferred as fixes. */
  function wordsOf(list) {
    const out = new Set();
    for (const x of list || []) for (const w of String(x && typeof x === 'object' ? x.t : x).match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || []) out.add(lc(w));
    return out;
  }
  /** "Fixed: specefically → specifically, teh → the" (spacing-only changes are summed up as "spacing"). */
  function describe(changes) {
    const seen = new Set(), parts = [];
    let spacing = false, capitals = false;
    for (const c of changes || []) {
      const squash = (s) => lc(s).replace(/\s+/g, '');
      // without kinds (the engine compares "said" with the text): same letters, other spaces or capitals
      if (c.kind === 'spacing' || (!c.kind && squash(c.from) === squash(c.to) && /[,.;:!?]/.test(c.from + c.to))) { spacing = true; continue; }
      if (c.kind === 'capitals' || (!c.kind && c.from !== c.to && lc(c.from) === lc(c.to))) { capitals = true; continue; }
      const k = !c.to ? `“${c.from}” removed` : !c.from ? `“${c.to}” added` : `${c.from} → ${c.to}`;
      if (!seen.has(k)) { seen.add(k); parts.push(k); }
    }
    if (capitals) parts.push('capitals');
    if (spacing) parts.push('spacing');
    return parts.join(', ');
  }

  // ---------- in the page ----------
  /** Browser: fetch the two dictionary files after the first paint (base = the folder that holds spell/). */
  async function fetchDictionary(base = '') {
    const get = async (f) => { const r = await fetch(`${base}spell/${f}`, { cache: 'force-cache' }); if (!r.ok) throw new Error(`spell/${f}: ${r.status}`); return r.text(); };
    const [a, d] = await Promise.all([get('index.aff'), get('index.dic')]);
    load(a, d);
  }
  /**
   * Step 1, then (optional) step 2: the helper's AI proofread of the fixed free-text parts, each answer kept only if
   * guard() passes. Never waits longer than timeoutMs; on any failure, step 1's result stands. A line that can't be
   * checked goes out unchanged. opts: { words, url, pass, timeoutMs, fetchFn }. Returns fixLines()-style results with
   * ai: 'used' | 'kept' (answered, guard said no) | 'none'.
   */
  async function proofreadLines(lines, opts = {}) {
    const W = opts.words instanceof Set ? opts.words : wordsOf(opts.words || []);
    const base = fixLines(lines, { words: W });
    const parts = [];
    base.forEach((r, i) => (r.failed ? [] : r.fields).forEach((f, j) => parts.push({ i, j, text: f.to, field: f.field })));
    const fetchFn = opts.fetchFn || globalThis.fetch;
    if (!parts.length || !opts.url || !opts.pass || typeof fetchFn !== 'function') return base.map((r) => ({ ...r, ai: 'none' }));
    let answer = null;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    try {
      const call = fetchFn(String(opts.url).replace(/\/+$/, '') + '/api/proofread', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-planner-pass': opts.pass },
        // only the personal words these texts use (fewer tokens, and nothing else of the list leaves the device)
        body: JSON.stringify({ texts: parts.map((p) => p.text), words: [...new Set(parts.flatMap((p) => (p.text.match(/\p{L}+(?:['’]\p{L}+)*/gu) || []).map(lc)))].filter((w) => W.has(w)).slice(0, 300) }), signal: ctl ? ctl.signal : undefined,
      }).then((r) => (r.ok ? r.json() : null));
      const late = new Promise((res) => { timer = setTimeout(() => { if (ctl) ctl.abort(); res(null); }, opts.timeoutMs || 4000); });
      answer = await Promise.race([call, late]);
    } catch { answer = null; } finally { clearTimeout(timer); }
    if (!answer || !Array.isArray(answer.texts) || answer.texts.length !== parts.length) return base.map((r) => ({ ...r, ai: 'none' }));
    return lines.map((l, i) => {
      const mine = parts.filter((p) => p.i === i);
      if (!mine.length) return { ...base[i], ai: 'none' };
      let used = false;
      const use = base[i].fields.map((f, j) => {
        const k = parts.findIndex((p) => p.i === i && p.j === j), a = answer.texts[k];
        const sameSteps = f.field !== 'step' || (typeof a === 'string' && a.split(';').length === f.to.split(';').length);
        if (typeof a === 'string' && a !== f.to && sameSteps && guard(f.to, a, { words: W }).ok) { used = true; return a; }
        return f.to;
      });
      if (!used) return { ...base[i], ai: 'kept' };
      try { return { ...fixLine(l, { words: W, use }), ai: 'used' }; } catch { return { ...base[i], ai: 'kept' }; }
    });
  }
  /** "Keep my words" after a line was sent: one "keep words: <the fixed text>" per changed field (per changed step). */
  function keepWordsLines(results) {
    const out = [];
    for (const r of results || []) for (const f of (r && r.changed ? r.fields : [])) {
      if (f.from === f.to) continue;
      if (f.field === 'step') { const a = f.from.split(';'), b = f.to.split(';'); b.forEach((s, i) => { if ((a[i] || '').trim() !== s.trim() && s.trim()) out.push(`keep words: ${s.trim()}`); }); }
      else out.push(`keep words: ${f.to.trim()}`);
    }
    return out;
  }

  const api = { load, ready, warm, fixText, fixLine, fixLines, parseLine, saidOf, diffWords, protectedOf, guard, GUARD, wordsOf, describe, SAID_TAGS, fetchDictionary, proofreadLines, keepWordsLines };
  globalThis.PlannerCheck = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
