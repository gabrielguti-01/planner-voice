// The test copy. This runs before the app's own code and swaps out three things, leaving the app itself unchanged:
// 1. GitHub: the app still "reads and writes" state/next.md and state/inbox.md, but here those files live only in
//    this browser, and the real planner engine runs right here instead of in GitHub Actions. Nothing is ever
//    written to GitHub. The engine's code and the routines are read (read-only) from the planner repository with
//    the token already in Settings, so the test copy always runs the current engine.
// 2. Settings: the app's saved settings get their own names, so the real app's are never touched.
// 3. The clock: a test clock that can be moved forward (the bar at the top) to try mornings, evenings, day changes.
(function () {
  const realGet = Storage.prototype.getItem, realSet = Storage.prototype.setItem, realRemove = Storage.prototype.removeItem;
  const realFetch = window.fetch.bind(window), RealDate = Date;
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname); // a dev server serving the planner repo
  const own = (k, v) => { try { if (v === undefined) return realGet.call(localStorage, 'plannerTest.' + k); if (v === null) realRemove.call(localStorage, 'plannerTest.' + k); else realSet.call(localStorage, 'plannerTest.' + k, v); } catch { return null; } };

  // ---- 2. settings under their own names; the token and repository fall back to the real app's (read only)
  const mapKey = (k) => (typeof k === 'string' && k.startsWith('planner.') ? 'plannerTest.app.' + k.slice(8) : k);
  Storage.prototype.getItem = function (k) {
    const v = realGet.call(this, mapKey(k));
    if (v == null && (k === 'planner.token' || k === 'planner.repo')) return realGet.call(this, k);
    return v;
  };
  Storage.prototype.setItem = function (k, v) { return realSet.call(this, mapKey(k), v); };
  Storage.prototype.removeItem = function (k) { return realRemove.call(this, mapKey(k)); };

  // ---- 3. the test clock: real time plus an offset
  let offset = +(own('clockOffset') || 0) || 0;
  class TestDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  window.Date = TestDate;

  // ---- the files: everything the planner would keep in the repository, kept in this browser
  let files = null;
  try { files = JSON.parse(own('files') || 'null'); } catch { files = null; }
  const save = () => { try { own('files', JSON.stringify(files)); } catch (e) { note('Could not save the test data: ' + e.message, true); } };
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\/v\/?/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  globalThis.__plannerTestFs = {
    read(p) { const k = norm(p); if (!(k in files)) { const e = new Error('ENOENT: no such file ' + p); e.code = 'ENOENT'; throw e; } return files[k]; },
    write(p, s) { files[norm(p)] = String(s); },
    exists(p) { const k = norm(p); return k in files || Object.keys(files).some((f) => f.startsWith(k + '/')); },
    list(p) { const k = norm(p) + '/'; return [...new Set(Object.keys(files).filter((f) => f.startsWith(k)).map((f) => f.slice(k.length).split('/')[0]))]; },
  };

  // ---- reading the planner's own files (engine code, constants, routines): read only
  const repo = () => own('app.repo') || realGet.call(localStorage, 'planner.repo') || '';
  const token = () => own('app.token') || realGet.call(localStorage, 'planner.token') || '';
  async function source(path) {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined; // a stalled read fails instead of waiting forever
    const r = LOCAL
      ? await realFetch(new URL('../' + path, document.baseURI), { cache: 'no-store', signal })
      : await realFetch(`https://api.github.com/repos/${repo()}/contents/${path}`, { cache: 'no-store', signal, headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 404 && !token() ? 'The test copy needs your GitHub token (Settings) to read the planner engine. It only reads.' : `Could not read ${path} (${r.status}).`);
    return r.text();
  }

  // ---- 1. the engine, loaded as modules from its source; node:fs and node:path point at the files above
  const blob = (code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const SHIMS = {
    'node:fs': blob(`const F = globalThis.__plannerTestFs;
export const readFileSync = (p) => F.read(p);
export const writeFileSync = (p, s) => F.write(p, s);
export const existsSync = (p) => F.exists(p);
export const readdirSync = (p) => F.list(p);
export const mkdirSync = () => {};
export default { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync };`),
    'node:path': blob(`const clean = (p) => { const out = []; for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); } return (p.startsWith('/') ? '/' : '') + out.join('/'); };
export const join = (...a) => clean(a.filter(Boolean).join('/'));
export const resolve = (...a) => { let p = ''; for (const s of a) p = s.startsWith('/') ? s : p + '/' + s; return clean(p.startsWith('/') ? p : '/' + p); };
export const dirname = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i <= 0 ? (c.startsWith('/') ? '/' : '.') : c.slice(0, i); };
export const basename = (p) => clean(p).split('/').pop();
export default { join, resolve, dirname, basename };`),
    'speech': blob('// the page already loaded speech.js (globalThis.PlannerSpeech)\n'),
  };
  const built = new Map();
  const resolvePath = (from, spec) => { const parts = from.split('/').slice(0, -1); for (const s of spec.split('/')) { if (s === '..') parts.pop(); else if (s !== '.') parts.push(s); } return parts.join('/'); };
  function build(path) {
    if (!built.has(path)) built.set(path, (async () => {
      let code = await source(path);
      if (path === 'engine/score.mjs') {
        if (!/export const ROOT = [^\n]*/.test(code)) throw new Error('engine/score.mjs changed: the test copy cannot find ROOT');
        code = code.replace(/export const ROOT = [^\n]*/, "export const ROOT = '/v';");
      }
      const specs = [...new Set([...code.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])([^'"]+)\1/g)].map((m) => m[2]))];
      const urls = {};
      for (const s of specs) urls[s] = SHIMS[s] || (/app\/speech\.js$/.test(s) ? SHIMS.speech : /^\.\.?\//.test(s) ? await build(resolvePath(path, s)) : null);
      code = code.replace(/(\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g, (m, kw, q, s) => (urls[s] ? `${kw}${q}${urls[s]}${q}` : m));
      return blob(code);
    })());
    return built.get(path);
  }
  let engine = null;
  async function loadEngine() {
    if (!globalThis.process) globalThis.process = { argv: [], env: {} };
    if (!engine) engine = Promise.all([import(await build('engine/run.mjs')), import(await build('engine/time.mjs'))]).then(([run, time]) => ({ run, time }))
      .catch((e) => { engine = null; built.clear(); console.error('test copy: engine did not load', e); throw e; });
    return engine;
  }

  // the planner's own files the test copy needs from the repository
  async function freshFiles() {
    const seed = globalThis.PlannerTestSeed;
    const f = {};
    f['rules/CONSTANTS.md'] = await source('rules/CONSTANTS.md');
    for (const n of ['daily', 'weekly', 'monthly']) f[`definitions/${n}.md`] = seed.routines(n, await source(`definitions/${n}.md`));
    return f;
  }
  async function runEngine() {
    const { run } = await loadEngine();
    run.runPass({ root: '/v' }); // the time is the test clock's
    save();
  }
  async function reset() {
    const seed = globalThis.PlannerTestSeed;
    const base = await freshFiles();
    files = { ...base }; // the engine reads its constants as it loads
    const { run, time } = await loadEngine();
    const today = run.plannerDay(time.nyNow());
    files = { ...base, ...seed.files(today) };
    await runEngine(); // the day starts
    files['state/inbox.md'] = files['state/inbox.md'].replace(/\n*$/, '\n') + seed.inbox(today).map((l) => `- ${l}`).join('\n') + '\n';
    await runEngine(); // the made-up tasks arrive
  }
  let ready = null;
  // a failure is kept for 10 seconds, so an app that retries doesn't start the engine over and over
  const ensure = () => (ready ||= (async () => { if (!files || !files['state/now.md']) await reset(); })().catch((e) => { setTimeout(() => { ready = null; }, 10000); console.error('test copy:', e); throw e; }));

  // ---- the GitHub contents API, answered here
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(16) + s.length; };
  const b64 = (s) => { let bin = ''; for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
  const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  let runTimer = null;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    if (!/^https:\/\/api\.github\.com\//.test(url)) return realFetch(input, init);
    const m = url.match(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/([^?]+)/);
    if (!m) return json(404, { message: 'Not available in the test copy' }); // never reaches GitHub
    const path = decodeURIComponent(m[1]);
    const method = (init.method || 'GET').toUpperCase();
    try { await ensure(); } catch (e) { note(e.message, true); return json(503, { message: e.message }); }
    if (method === 'GET') return path in files ? json(200, { path, sha: hash(files[path]), encoding: 'base64', content: b64(files[path]) }) : json(404, { message: 'Not Found' });
    if (method === 'PUT' && path.startsWith('state/')) {
      const body = JSON.parse(init.body || '{}');
      if (path in files && body.sha !== hash(files[path])) return json(409, { message: 'sha does not match' });
      files[path] = unb64(body.content || '');
      save();
      // what the GitHub workflow does on a push: run the engine (here after a short pause, not a minute)
      clearTimeout(runTimer);
      runTimer = setTimeout(() => runEngine().then(() => note('')).catch((e) => note('Engine error: ' + e.message, true)), 1500);
      return json(200, { content: { path, sha: hash(files[path]) } });
    }
    return json(403, { message: 'The test copy only changes its own state files' });
  };

  // ---- the test bar
  const pad = (n) => String(n).padStart(2, '0');
  // the planner's time zone, whatever the device's
  const TZ = 'America/New_York';
  const clockText = () => { const d = new Date(); return d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }); };
  let noteEl = null;
  function note(t, bad) { if (noteEl) { noteEl.textContent = t; noteEl.className = 'tc-note' + (bad ? ' bad' : ''); } }
  let busy = false; // one bar action at a time
  async function moveClock(ms, label) {
    if (busy) return;
    busy = true;
    offset = ms == null ? 0 : offset + ms;
    own('clockOffset', String(offset));
    note(label + '…');
    try { await ensure(); await runEngine(); } catch (e) { note(e.message, true); busy = false; return; } // the schedule runs at the new time
    location.reload();
  }
  function nextMorning() { // to the next 7:00 AM New York time
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, +x.value]));
    let min = 7 * 60 - (p.hour * 60 + p.minute);
    if (min <= 0) min += 1440;
    return (min * 60 - p.second) * 1000;
  }
  function showFile() {
    const box = document.getElementById('tc-files');
    if (!box.classList.toggle('hidden')) { const sel = document.getElementById('tc-pick'); sel.innerHTML = Object.keys(files || {}).sort().map((k) => `<option>${k}</option>`).join(''); sel.value = 'state/next.md'; document.getElementById('tc-text').textContent = files?.['state/next.md'] || ''; }
  }
  function bar() {
    const css = document.createElement('style');
    css.textContent = `#tc-bar{position:sticky;top:0;z-index:50;background:#20160a;color:#f3e4c0;border-bottom:1px solid #c9a24a;font:13px/1.35 system-ui,sans-serif;padding:6px 12px calc(6px);padding-top:max(6px,env(safe-area-inset-top))}
#tc-bar .tc-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
#tc-bar b{letter-spacing:.08em;color:#e8c46a;font-weight:700;margin-right:4px}
#tc-bar button,#tc-bar select{all:unset;box-sizing:border-box;cursor:pointer;font:13px/1 system-ui,sans-serif;letter-spacing:0;text-transform:none;color:#f3e4c0;background:#20160a;border:1px solid #8a6f33;border-radius:6px;padding:0 9px;height:30px;display:inline-flex;align-items:center}
#tc-bar select{padding-right:22px;background-image:linear-gradient(45deg,transparent 50%,#c9a24a 50%),linear-gradient(135deg,#c9a24a 50%,transparent 50%);background-position:calc(100% - 12px) 13px,calc(100% - 8px) 13px;background-size:4px 4px;background-repeat:no-repeat}
#tc-bar button:active{background:#3a2a12}
#tc-bar .tc-clock{margin-right:auto}
#tc-bar .tc-note{width:100%;color:#d9c79c;font-size:12px;margin-top:4px}#tc-bar .tc-note.bad{color:#ff9b8a}#tc-bar .tc-note:empty{display:none}
#tc-files{margin-top:6px}#tc-files.hidden{display:none}
#tc-text{max-height:45vh;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#140d05;border:1px solid #5a4620;border-radius:6px;padding:8px;margin:6px 0 0;font:12px/1.4 ui-monospace,monospace;color:#eadbb8}`;
    document.head.appendChild(css);
    const el = document.createElement('div');
    el.id = 'tc-bar';
    el.innerHTML = `<div class="tc-row"><b>TEST COPY</b><span class="tc-clock" id="tc-clock"></span>
<select id="tc-move" aria-label="Move the test clock"><option value="">Move clock</option><option value="15">+15 min</option><option value="60">+1 hour</option><option value="180">+3 hours</option><option value="morning">Next morning, 7 AM</option><option value="real">Back to real time</option></select><button id="tc-show">Files</button><button id="tc-reset">Start over</button></div>
<div class="tc-note" id="tc-note">Made-up tasks. Nothing here touches your real list.</div>
<div id="tc-files" class="hidden"><div class="tc-row"><select id="tc-pick" aria-label="File"></select><button id="tc-copy">Copy</button></div><pre id="tc-text"></pre></div>`;
    document.body.prepend(el);
    noteEl = el.querySelector('#tc-note');
    const tick = () => { el.querySelector('#tc-clock').textContent = clockText() + (offset ? '' : ' (real time)'); };
    tick(); setInterval(tick, 15000);
    el.querySelector('#tc-move').addEventListener('change', (e) => {
      const v = e.target.value; e.target.value = '';
      if (v === 'morning') moveClock(nextMorning(), 'Going to 7 AM');
      else if (v === 'real') moveClock(null, 'Back to real time');
      else if (v) moveClock(+v * 60e3, 'Moving the clock');
    });
    el.querySelector('#tc-show').addEventListener('click', showFile);
    el.querySelector('#tc-pick').addEventListener('change', (e) => { document.getElementById('tc-text').textContent = files?.[e.target.value] || ''; });
    el.querySelector('#tc-copy').addEventListener('click', () => { const k = document.getElementById('tc-pick').value; navigator.clipboard?.writeText(`${k} (test copy, ${clockText()})\n\n${files?.[k] || ''}`).then(() => note('Copied ' + k + '.')); });
    el.querySelector('#tc-reset').addEventListener('click', async () => {
      if (busy || !confirm('Start the test copy over with fresh made-up tasks?')) return;
      busy = true;
      note('Starting over…');
      try { files = null; ready = null; offset = 0; own('clockOffset', '0'); await ensure(); location.reload(); } catch (e) { note(e.message, true); busy = false; }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bar); else bar();
  globalThis.__plannerTest = { reset, runEngine, files: () => files };
})();
