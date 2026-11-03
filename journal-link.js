// The journal link: an optional "Keep in mind today" strip and "Why:" tags, served by the owner's private journal app
// running on this same computer (http://127.0.0.1:<port>). Owner request, 2026-11-02.
//
// Privacy, on purpose:
// - Off unless switched on in this browser (?journal=1 sets it, ?journal=0 clears it). While off, this file never
//   makes a request, so a phone never sees Chrome's "apps on this device" prompt.
// - What the journal sends is only drawn on the screen (textContent, never innerHTML). It is never stored, logged,
//   put in a URL, or handed to the planner's GitHub code; it lives in this file's memory until the page closes.
// - The planner side sends the journal only task ids and titles (POST /v1/tasks) and the why a person picks.
// - Any failure (journal not running, timeout, bad answer) hides everything without a word.
// - The test copy (test/) only reads: it never sends its made-up tasks or tags to the journal.
// Sets globalThis.PlannerJournal; the page calls PlannerJournal.drawn(next) at the end of each render.
(function () {
  const FLAG = 'planner.journalLink', PORT = 'planner.journalPort', DEFAULT_PORT = 47613, WAIT_MS = 1500;
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

  // ?journal=1 / ?journal=0 switch the link for this browser; the switch leaves the address at once
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('journal')) {
      const v = u.searchParams.get('journal');
      try { if (v === '1') localStorage.setItem(FLAG, '1'); else if (v === '0') localStorage.removeItem(FLAG); } catch {}
      u.searchParams.delete('journal');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    }
  } catch {}

  const api = { drawn() {} };
  globalThis.PlannerJournal = api;
  if (get(FLAG) !== '1') return; // off: nothing below runs, no connection is ever tried

  const port = (() => { const n = +(get(PORT) || ''); return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT; })();
  const BASE = `http://127.0.0.1:${port}`;
  const READ_ONLY = !!globalThis.__plannerTestFs; // the test copy
  const $ = (id) => document.getElementById(id);

  let data = null; // the journal's last good answer (memory only)
  let last = null; // the plan as last drawn (the page's own object; never changed here)
  let loadedAt = 0, tasksSent = false, editing = null, refocus = null; // editing: where the why picker is open ('<list>|<stable id>')

  async function call(method, path, body) {
    const stop = new AbortController(), timer = setTimeout(() => stop.abort(), WAIT_MS);
    try {
      const init = { method, signal: stop.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', targetAddressSpace: 'loopback' };
      if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
      const r = await fetch(BASE + path, init);
      if (!r.ok) return null;
      if (method !== 'GET') return true;
      return await r.json();
    } catch { return null; } finally { clearTimeout(timer); }
  }

  // only the expected shape, trimmed and capped; anything else counts as no answer
  const str = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  function accept(j) {
    if (!j || typeof j !== 'object' || j.v !== 1) return null;
    const lines = (Array.isArray(j.lines) ? j.lines : []).slice(0, 3).map((x) => ({ text: str(x && x.text, 400), label: str(x && x.label, 80) })).filter((x) => x.text);
    const whys = new Map();
    if (j.whys && typeof j.whys === 'object' && !Array.isArray(j.whys)) {
      for (const [id, w] of Object.entries(j.whys)) { const text = str(w && w.text, 400); if (id && text) whys.set(id, { key: str(w.key, 200), text }); }
    }
    const labels = (Array.isArray(j.labels) ? j.labels : []).slice(0, 200).map((x) => ({ key: str(x && x.key, 200), text: str(x && x.text, 400), label: str(x && x.label, 80) })).filter((x) => x.key && x.text);
    return { lines, whys, labels };
  }

  // A routine's id carries the day it is due (TEETH-AM@2026-10-01); its why belongs to the routine (TEETH-AM).
  const isRoutine = (id) => /@\d{4}-\d{2}-\d{2}/.test(id);
  const stable = (id) => (isRoutine(id) ? id.replace(/@.*$/, '') : id);
  const whyFor = (id) => (data && (data.whys.get(id) || data.whys.get(stable(id)))) || null;
  const tidy = (t) => String(t || '').replace(/^(now|later|~\d{1,2}:\d{2}): /, '').trim();

  async function load() {
    loadedAt = Date.now();
    data = accept(await call('GET', '/v1/keep-in-mind'));
    paint();
    sendTasks();
  }

  // the tasks and routines the planner knows today (ids, titles, routine or not), once per page load
  function sendTasks() {
    if (READ_ONLY || tasksSent || !data || !last) return;
    tasksSent = true;
    const out = new Map(), n = last;
    const one = (ids, title) => {
      if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string' || !tidy(title)) return;
      const id = stable(ids[0]);
      if (!out.has(id)) out.set(id, { id, title: tidy(title).slice(0, 200), routine: isRoutine(ids[0]) });
    };
    one(n.tasks, n.step);
    (n.plan || []).forEach((t, i) => one((n.planIds || [])[i], t));
    (n.anchorGroups || []).forEach((g) => (g.items || []).forEach((x) => one(x.ids, x.text)));
    (n.today || []).forEach((t, i) => one((n.todayIds || [])[i], t));
    (n.after || []).forEach((t, i) => one((n.afterIds || [])[i], t));
    (n.projects || []).forEach((p) => (p.steps || []).forEach((s) => one(s.ids, s.text)));
    if (out.size) call('POST', '/v1/tasks', { tasks: [...out.values()].slice(0, 500) });
  }

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; e.dataset.jl = ''; return e; };

  // "Why: …" (when tagged) and the small "why?" control, added to one task's place on the screen
  function decorate(box, rawId, title, place) {
    const w = whyFor(rawId);
    if (w) box.appendChild(el('span', 'jl-why', 'Why: ' + w.text));
    if (READ_ONLY || !data.labels.length) return;
    const id = stable(rawId), at = place + '|' + id;
    if (editing === at) { box.appendChild(picker(id, w, title)); return; }
    const b = el('button', 'jl-btn', w ? 'change why' : 'why?');
    b.type = 'button';
    b.setAttribute('aria-label', (w ? 'Change the why for: ' : 'Choose a why for: ') + title);
    b.onclick = () => { editing = at; paint(); };
    if (refocus === at) { refocus = null; setTimeout(() => b.focus && b.focus(), 0); }
    box.appendChild(b);
  }
  function picker(id, w, title) {
    const f = el('div', 'jl-edit'), sel = el('select'), save = el('button', '', 'Save'), cancel = el('button', '', 'Cancel'), note = el('span', 'jl-why');
    sel.setAttribute('aria-label', 'Why for: ' + title);
    sel.appendChild(el('option', '', 'None')).value = '';
    for (const l of data.labels) { const o = el('option', '', l.label ? `${l.text} (${l.label})` : l.text); o.value = l.key; sel.appendChild(o); }
    sel.value = w && data.labels.some((l) => l.key === w.key) ? w.key : '';
    save.type = cancel.type = 'button';
    const close = () => { refocus = editing; editing = null; paint(); };
    cancel.onclick = close;
    f.onkeydown = (e) => { if (e.key === 'Escape') close(); };
    save.onclick = async () => {
      save.disabled = cancel.disabled = sel.disabled = true;
      const ok = await call('POST', '/v1/why', { taskId: id, key: sel.value || null });
      if (!ok) { save.disabled = cancel.disabled = sel.disabled = false; note.textContent = 'Not saved. Is the journal open?'; return; }
      refocus = editing; editing = null;
      await load();
    };
    f.append(sel, save, cancel, note);
    setTimeout(() => sel.focus && sel.focus(), 0);
    return f;
  }

  function paint() {
    document.querySelectorAll('[data-jl]').forEach((e) => e.remove());
    const strip = $('journalStrip');
    if (strip) {
      const ul = $('journalLines');
      if (ul) for (const l of data ? data.lines : []) { const li = el('li', '', l.text); if (l.label) li.appendChild(el('span', 'jl-label', l.label)); ul.appendChild(li); }
      strip.classList.toggle('hidden', !(data && data.lines.length));
    }
    if (!data || !last) { editing = null; return; }
    // the step on screen
    const say = $('say');
    if (say && Array.isArray(last.tasks) && last.tasks.length === 1) {
      const box = el('div', 'jl-next');
      decorate(box, last.tasks[0], tidy(last.step) || 'this step', 'now');
      if (box.childNodes.length) say.after(box);
    }
    // Today's plan and the routine lists: row i of each list is drawn from ids i
    const lists = [['plan', last.plan || [], last.planIds || []]];
    (last.anchorGroups || []).slice(0, 2).forEach((g, k) => lists.push(['anchors' + 'AB'[k], (g.items || []).map((x) => x.text), (g.items || []).map((x) => x.ids)]));
    for (const [listId, texts, idsList] of lists) {
      const ul = $(listId);
      if (!ul) continue;
      texts.forEach((t, i) => {
        const ids = idsList[i], txt = ul.children[i] && ul.children[i].querySelector('.txt');
        if (txt && Array.isArray(ids) && ids.length === 1) decorate(txt, ids[0], tidy(t), listId);
      });
    }
  }

  api.drawn = (next) => { last = next || null; paint(); sendTasks(); };
  load();
  // back to the page after a while: the lines may have changed
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - loadedAt > 10 * 60e3) load(); });
})();
