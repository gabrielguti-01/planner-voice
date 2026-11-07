/* Talk it through (user, 2026-11-07): when a project step is done, the user talks (or types) everything at once:
 * what came out of it, why, and what needs doing next. Claude (through the planner's helper on Vercel, which holds
 * the API key) organizes it into "What came out of it" and "Reasoning" (as bullet points and as a flowchart of the
 * logic) plus new steps, and marks every unclear spot with a yellow "!" and a question. The user answers by talking
 * more until nothing is unclear; Claude then checks back ("Just to double check…") and only a "Yes" saves it into the
 * planner. "Do this later" marks the step done with an orange dot and keeps the exact words and the questions in
 * reasoning/pending/<ID>.json until they are verified ("To verify").
 *
 * Shared by the laptop view (desk/) and, later, the phone view. The page passes in its own GitHub calls (hooks).
 */
(function () {
  'use strict';
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const PENDING = (id) => `reasoning/pending/${id}.json`, DONE = (id) => `reasoning/done/${id}.json`;
  const clip = (t) => String(t || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const el = (tag, cls, text, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; };
  const btn = (text, cls, onclick, parent) => { const b = el('button', 'btn small' + (cls ? ' ' + cls : ''), text, parent); b.type = 'button'; b.onclick = onclick; return b; };

  const CSS = `
  .rs { display: flex; flex-direction: column; gap: 14px; }
  .rs .rhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .rs .rhead h3 { font: 500 26px/1.2 var(--serif, Georgia, serif); margin: 4px 0 0; }
  .rs { min-width: 0; }
  .rs .rgrid { display: grid; gap: 18px; align-items: start; grid-template-columns: minmax(0, 1fr); }
  .rs .rgrid > div, .rs .rbox { min-width: 0; }
  .rs > .rgrid > div { display: flex; flex-direction: column; gap: 14px; }
  .rs .rgrid.list-main { grid-template-columns: 260px minmax(0, 1fr); }
  .rs .rgrid.main-q { grid-template-columns: minmax(0, 1fr) minmax(300px, 40%); }
  @media (max-width: 900px) { .rs .rgrid.list-main, .rs .rgrid.main-q { grid-template-columns: 1fr; } }
  .rs .rbox { border: 1px solid var(--line, #333); border-radius: 14px; background: var(--panel, #1c2124); padding: 16px 18px; }
  .rs .rlist button { display: block; width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--row, #2a2f33); padding: 10px 4px; color: var(--ink, #eee); cursor: pointer; }
  .rs .rlist button:hover, .rs .rlist button.on { color: var(--brass-hi, #f2c47a); }
  .rs .rlist small { display: block; color: var(--dim, #999); margin-top: 2px; }
  .rs .seg2 { display: inline-flex; border: 1px solid var(--btn-line, #444); border-radius: 999px; padding: 3px; }
  .rs .seg2 button { border: none; background: none; padding: 6px 16px; border-radius: 999px; color: var(--dim, #999); cursor: pointer; }
  .rs .seg2 button.on { background: var(--active, #2b3236); color: var(--brass-hi, #f2c47a); }
  .rs h4 { font: 500 12.5px var(--sans, sans-serif); letter-spacing: .12em; text-transform: uppercase; color: var(--brass-hi, #f2c47a); margin: 16px 0 8px; }
  .rs h4:first-child { margin-top: 0; }
  .rs ul.rb { list-style: none; margin: 0; padding: 0; }
  .rs ul.rb li { display: flex; gap: 10px; align-items: flex-start; margin: 0 0 9px; font-size: 15.5px; line-height: 1.55; }
  .rs ul.rb li .dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--ink, #ddd); margin-top: 9px; opacity: .8; }
  .rs .warn { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; border-radius: 50%; background: #f2c94c; color: #111; font: 800 13px/1 var(--sans, sans-serif); border: none; padding: 0; cursor: pointer; margin-top: 3px; }
  .rs .warn.sel, .rs .rnode.qsel { box-shadow: 0 0 0 3px rgba(242,201,76,.45); }
  .rs ul.rb li.qsel span.t { background: rgba(242,201,76,.12); border-radius: 4px; }
  .rs .rqs { list-style: none; margin: 0; padding: 0; }
  .rs .rqs li button { display: flex; gap: 10px; width: 100%; text-align: left; background: none; border: none; border-top: 1px solid var(--row, #2a2f33); padding: 9px 2px; color: var(--ink, #eee); cursor: pointer; font-size: 14.5px; line-height: 1.45; }
  .rs .rqs li button b { color: #f2c94c; min-width: 16px; }
  .rs .rqs li button.on { background: rgba(242,201,76,.08); }
  .rs .rflowbox { position: relative; overflow: auto; max-height: 460px; border-radius: 10px; }
  .rs .rflow { position: relative; }
  .rs .rflow svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .rs .rnode { position: absolute; border: 1px solid var(--line, #3a4247); border-radius: 10px; background: var(--side, #171b1e); padding: 8px 10px; font-size: 13.5px; line-height: 1.3; color: var(--ink, #eee); box-sizing: border-box; cursor: default; }
  .rs .rnode .k { display: block; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--dim, #999); margin-bottom: 2px; }
  .rs .rnode.start { border-color: #8a949a; } .rs .rnode.outcome { border-color: var(--moss, #7fa38a); } .rs .rnode.next { border-color: var(--brass, #e0a050); }
  .rs .rnode.rejected { opacity: .7; border-style: dashed; } .rs .rnode.rejected .lbl { text-decoration: line-through; text-decoration-color: rgba(255,255,255,.35); }
  .rs .rnode .warn { position: absolute; top: -9px; right: -9px; margin: 0; }
  .rs .rnode.hasq { cursor: pointer; border-color: #f2c94c; }
  .rs .elab { font: 11px var(--sans, sans-serif); fill: var(--dim, #9aa); }
  .rs textarea { width: 100%; box-sizing: border-box; min-height: 130px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--btn-line, #444); background: var(--side, #171b1e); color: var(--ink, #eee); font: inherit; font-size: 15.5px; line-height: 1.5; resize: vertical; }
  .rs .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .rs .mic.on { background: #b3412e; color: #fff; border-color: #b3412e; }
  .rs .hint { color: var(--dim, #999); font-size: 13.5px; margin: 0; }
  .rs .quote { border-left: 3px solid #f2c94c; padding: 4px 0 4px 12px; margin: 8px 0 10px; color: var(--ink, #eee); font-style: italic; }
  .rs .check { border: 1px solid var(--moss, #7fa38a); border-radius: 12px; padding: 14px 16px; background: rgba(127,163,138,.07); font-size: 15.5px; line-height: 1.55; }
  .rs .thinking { color: var(--brass-hi, #f2c47a); }
  .rs .err { color: #e07a6a; }
  .vdot { position: absolute; top: 6px; right: 6px; width: 11px; height: 11px; border-radius: 50%; background: #e8862a; box-shadow: 0 0 0 2px rgba(0,0,0,.35); }
  `;
  function addCss() { if (document.getElementById('reason-css')) return; const s = el('style'); s.id = 'reason-css'; s.textContent = CSS; document.head.appendChild(s); }

  // ---- the microphone: the browser's own speech recognition when it has one; else the device's dictation ----
  function micFor(textarea, button, onState) {
    const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!SR) { button.textContent = '🎤 Dictate'; button.onclick = () => { textarea.focus(); onState?.('Your browser can\'t listen here: press Windows + H (laptop) or the microphone on your keyboard (phone).'); }; return { stop() {} }; }
    let rec = null, on = false, base = '';
    const stop = () => { on = false; button.classList.remove('on'); button.textContent = '🎤 Talk'; try { rec?.stop(); } catch {} };
    button.textContent = '🎤 Talk';
    button.onclick = () => {
      if (on) { stop(); return; }
      rec = new SR(); rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
      base = textarea.value ? textarea.value.replace(/\s*$/, ' ') : '';
      let finals = '';
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finals += t.trim() + ' '; else interim += t; }
        textarea.value = base + finals + interim;
        textarea.dispatchEvent(new Event('input'));
      };
      rec.onerror = (e) => { onState?.(e.error === 'not-allowed' ? 'The microphone is blocked for this page: allow it in the browser, or use Windows + H.' : `The microphone stopped (${e.error}).`); stop(); };
      rec.onend = () => { if (on) { try { rec.start(); } catch { stop(); } } }; // keeps listening through pauses
      on = true; button.classList.add('on'); button.textContent = '■ Stop'; onState?.('Listening… say it all, then press Stop.');
      try { rec.start(); } catch { stop(); }
    };
    return { stop };
  }

  // ---- the logic as a flowchart: columns by how far each thought is from the start ----
  function drawGraph(box, u, selQ, onQ) {
    box.innerHTML = '';
    const nodes = (u.flow?.nodes || []).filter((n) => n && n.id);
    if (!nodes.length) { el('p', 'hint', 'No flowchart for this one yet.', box); return; }
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (u.flow?.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
    const preds = new Map(nodes.map((n) => [n.id, []])); for (const e of edges) preds.get(e.to).push(e.from);
    const lv = new Map();
    const level = (id, seen = new Set()) => { if (lv.has(id)) return lv.get(id); if (seen.has(id)) return 0; seen.add(id); const p = preds.get(id); const v = p.length ? 1 + Math.max(...p.map((x) => level(x, seen))) : 0; lv.set(id, v); return v; };
    nodes.forEach((n) => level(n.id));
    const cols = []; nodes.forEach((n) => (cols[lv.get(n.id)] ||= []).push(n));
    const W = 200, H = 78, GX = 74, GY = 20, TOP = 12, LEFT = 12;
    const tall = Math.max(...cols.map((c) => (c ? c.length : 0))) * (H + GY) - GY;
    const pos = new Map();
    cols.forEach((c, ci) => { if (!c) return; let y = TOP + (tall - (c.length * (H + GY) - GY)) / 2; for (const n of c) { pos.set(n.id, { x: LEFT + ci * (W + GX), y }); y += H + GY; } });
    const width = LEFT * 2 + cols.length * (W + GX) - GX, height = TOP * 2 + tall;
    // fits the width it has (no sideways scrollbar); only a very long chain scrolls, never below 65% size
    const wrap = el('div', 'rflowbox', null, box), sizer = el('div', '', null, wrap), flow = el('div', 'rflow', null, sizer);
    flow.style.width = width + 'px'; flow.style.height = height + 'px';
    const k = Math.max(0.65, Math.min(1, (wrap.clientWidth || width) / width));
    flow.style.transformOrigin = '0 0'; if (k < 1) flow.style.transform = `scale(${k})`;
    sizer.style.width = Math.ceil(width * k) + 'px'; sizer.style.height = Math.ceil(height * k) + 'px'; sizer.style.overflow = 'hidden';
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', width); svg.setAttribute('height', height);
    svg.innerHTML = '<defs><marker id="rsA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#8a949a"/></marker></defs>';
    for (const e of edges) {
      const p = pos.get(e.from), q = pos.get(e.to);
      const back = q.x <= p.x;
      const x1 = back ? p.x + W / 2 : p.x + W, y1 = back ? p.y + H : p.y + H / 2, x2 = back ? q.x + W / 2 : q.x - 4, y2 = back ? q.y + H + 4 : q.y + H / 2, mx = (x1 + x2) / 2;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', back ? `M${x1} ${y1}C${x1} ${y1 + 40} ${x2} ${y2 + 40} ${x2} ${y2}` : `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`);
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#8a949a'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('marker-end', 'url(#rsA)');
      svg.appendChild(path);
      if (e.label) { const t = document.createElementNS(NS, 'text'); t.setAttribute('class', 'elab'); t.setAttribute('x', mx); t.setAttribute('y', (y1 + y2) / 2 - 5); t.setAttribute('text-anchor', 'middle'); t.textContent = e.label.length > 26 ? e.label.slice(0, 25) + '…' : e.label; svg.appendChild(t); }
    }
    flow.appendChild(svg);
    const KIND = { start: 'Start', idea: 'Idea', reason: 'Because', option: 'Option', rejected: 'Dropped', outcome: 'Came out of it', next: 'Next step' };
    let first = null;
    for (const n of nodes) {
      const p = pos.get(n.id), d = el('div', `rnode ${n.kind || ''}` + (n.question ? ' hasq' : '') + (selQ && n.question === selQ ? ' qsel' : ''), null, flow);
      d.style.left = p.x + 'px'; d.style.top = p.y + 'px'; d.style.width = W + 'px'; d.style.minHeight = H + 'px';
      el('span', 'k', KIND[n.kind] || '', d); el('span', 'lbl', n.label, d);
      if (n.question) {
        const w = el('button', 'warn' + (selQ === n.question ? ' sel' : ''), '!', d); w.title = 'Needs checking: click for the question';
        d.onclick = () => onQ(n.question);
        if (selQ === n.question && !first) first = d;
      }
    }
    // a chosen question jumps the chart to its spot when it is out of view
    if (first) requestAnimationFrame(() => first.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }

  // ---- the same logic as bullet points; an unclear one has the yellow "!" instead of the dot ----
  function drawBullets(box, u, selQ, onQ, opts = {}) {
    box.innerHTML = '';
    const sec = (title, items) => {
      if (!items.length) return;
      el('h4', '', title, box);
      const ul = el('ul', 'rb', null, box);
      for (const p of items) {
        const li = el('li', p.question && p.question === selQ ? 'qsel' : '', null, ul);
        li.style.marginLeft = Math.min(3, Math.max(0, p.depth || 0)) * 24 + 'px';
        if (p.question) { const w = el('button', 'warn' + (selQ === p.question ? ' sel' : ''), '!', li); w.title = 'Needs checking: click for the question'; w.onclick = () => onQ(p.question); }
        else el('span', 'dot', null, li);
        el('span', 't', p.text, li);
      }
    };
    sec('What came out of it', (u.points || []).filter((p) => p.section === 'came_out'));
    sec('Reasoning', (u.points || []).filter((p) => p.section === 'reasoning'));
    if (!opts.noSteps) sec(opts.stepsTitle || 'New steps it will add', (u.new_steps || []).map((s) => ({ text: s.why ? `${s.title} (why: ${s.why})` : s.title, depth: 0, question: s.question })));
  }

  // ---- what goes into the planner: "A; B (example); C" ----
  function flatten(points) {
    const out = [];
    for (const p of points) { if ((p.depth || 0) > 0 && out.length) out[out.length - 1].subs.push(p.text); else out.push({ text: p.text, subs: [] }); }
    const join = (list) => list.reduce((a, t) => (!a ? t : /[.!?;:]$/.test(a) ? `${a} ${t}` : `${a}; ${t}`), '');
    return join(out.map((x) => (x.subs.length ? `${x.text.replace(/[.;]$/, '')} (${join(x.subs).replace(/\.$/, '')})` : x.text)));
  }
  function linesFor(rec) {
    const u = rec.understanding || {}, id = rec.id;
    const adds = (u.new_steps || []).map((s) => [`add: ${clip(s.title)}`, rec.project && `project ${rec.project}`, rec.area && `area ${rec.area}`, `after ${id}`, `why ${clip(s.why ? `${s.why} (came out of: ${rec.title})` : `came out of: ${rec.title}`)}`].filter(Boolean).join(' | '));
    const sol = clip(flatten((u.points || []).filter((p) => p.section === 'came_out'))), bec = clip(flatten((u.points || []).filter((p) => p.section === 'reasoning')));
    const fin = [`${rec.done ? 'solved' : 'done'}: ${id}`, sol && `solution ${sol}`, bec && `because ${bec}`].filter(Boolean).join(' | ');
    return rec.done && !sol && !bec ? adds : [...adds, fin];
  }

  function create(h) {
    addCss();
    const helperReady = () => { const c = h.helper(); return !!(c && c.url && c.pass) || !!h.mockThink; };
    async function think(rec) {
      const body = { step: { title: rec.title, project: rec.projectName || rec.project || '', came_up: rec.came_up || '', notes: rec.notes || '' }, said: rec.said, current: rec.understanding || null };
      let out;
      if (h.mockThink) out = await h.mockThink(body);
      else {
        const c = h.helper();
        const r = await fetch(c.url.replace(/\/+$/, '') + '/api/think', { method: 'POST', headers: { 'content-type': 'application/json', 'x-planner-pass': c.pass }, body: JSON.stringify(body) });
        let j = null; try { j = await r.json(); } catch {}
        if (!r.ok) throw new Error(j?.error || `The helper answered ${r.status}.`);
        out = j;
      }
      rec.understanding = out.understanding;
      rec.usd = Math.round(((rec.usd || 0) + (out.usage?.usd || 0)) * 1000) / 1000;
      rec.updated = new Date().toISOString();
    }
    const pendingIds = async () => new Set((await h.listDir('reasoning/pending')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)));
    const doneIds = async () => new Set((await h.listDir('reasoning/done')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)));
    async function load(id, kind = 'pending') { const t = await h.getFile(kind === 'pending' ? PENDING(id) : DONE(id)); try { return t ? JSON.parse(t) : null; } catch { return null; } }
    const savePending = (rec) => h.putFile(PENDING(rec.id), JSON.stringify(rec, null, 2) + '\n', `Reasoning to verify: ${rec.title}`.slice(0, 70));

    /** The workspace. opts: { mode: 'done' | 'verify' | 'view', rec?, recs?: [rec] (verify), onClose(changed) } */
    function open(box, opts) {
      const S = { mode: opts.mode, recs: opts.recs || null, rec: opts.rec || null, view: 'flow', q: null, phase: 'talk', err: '', note: '', changed: false };
      if (S.rec?.understanding) S.phase = 'review';
      const draftKey = (r) => `reasonDraft.${r.id}`;
      let mic = null;
      const close = () => { mic?.stop(); opts.onClose?.(S.changed); };
      const lettersOf = (u) => new Map((u?.questions || []).map((q, i) => [q.id, LETTERS[i] || '?']));
      const pick = (r) => { mic?.stop(); S.rec = r; S.q = null; S.err = ''; S.phase = r.understanding ? 'review' : 'saved'; draw(); };
      const selQ = (id) => { S.q = id; S.err = ''; draw(); };

      async function run(text, answering) {
        const r = S.rec, t = String(text || '').trim();
        if (t) r.said.push({ text: t, ...(answering ? { answering } : {}), at: new Date().toISOString() });
        if (!r.said.length) { S.err = 'Say or type something first.'; draw(); return; }
        mic?.stop(); S.phase = 'thinking'; S.err = ''; draw();
        try {
          await think(r);
          try { localStorage.removeItem('planner.' + draftKey(r)); } catch {}
          const qs = r.understanding.questions || [];
          if (S.q && !qs.some((q) => q.id === S.q)) S.q = qs[0]?.id || null; // that one is settled: on to the next
          S.phase = 'review';
          if (r.pendingSaved) { await savePending(r); S.changed = true; } // a saved one stays up to date
        } catch (e) { S.err = `${e.message || e} Your words are kept: try again.`; S.phase = r.understanding ? 'review' : 'talk'; }
        draw();
      }
      async function later() {
        const r = S.rec; mic?.stop();
        const ta = box.querySelector('textarea.say'); if (ta && ta.value.trim()) r.said.push({ text: ta.value.trim(), at: new Date().toISOString() });
        S.phase = 'saving'; draw();
        try {
          const wasDone = !!r.done;
          r.pendingSaved = true; r.done = true; r.updated = new Date().toISOString();
          await savePending(r);
          if (!wasDone) await h.send([`done: ${r.id}`], `“${r.title}” done; its reasoning is saved to verify later`);
          S.changed = true;
          if (S.mode === 'verify') { S.rec = null; S.phase = 'talk'; draw(); } else close();
        } catch (e) { S.err = `Not saved: ${e.message}`; S.phase = r.understanding ? 'review' : 'talk'; draw(); }
      }
      async function confirm() {
        const r = S.rec; S.phase = 'saving'; draw();
        try {
          const lines = linesFor(r);
          r.confirmed = new Date().toISOString(); r.wasPending = !!r.pendingSaved; delete r.pendingSaved;
          await h.putFile(DONE(r.id), JSON.stringify(r, null, 2) + '\n', `Reasoning: ${r.title}`.slice(0, 70));
          if (r.wasPending) await h.deleteFile(PENDING(r.id), `Verified: ${r.title}`.slice(0, 70));
          S.changed = true;
          if (S.mode === 'verify') { S.recs = S.recs.filter((x) => x.id !== r.id); S.rec = null; S.q = null; S.phase = 'talk'; }
          await h.send(lines, `“${r.title}”: what came out of it, the reasoning${(r.understanding.new_steps || []).length ? ` and ${r.understanding.new_steps.length} new step${r.understanding.new_steps.length === 1 ? '' : 's'}` : ''} saved`);
          if (S.mode !== 'verify' || !S.recs.length) close(); else draw();
        } catch (e) { S.err = `Not saved: ${e.message}`; S.phase = 'review'; draw(); }
      }

      function talkBox(parent, { answering, prompt: label, quiet } = {}) {
        const wrap = el('div', '', null, parent);
        if (label) el('p', 'hint', label, wrap);
        const ta = el('textarea', 'say', null, wrap); ta.placeholder = answering ? 'Your answer: talk or type' : 'Say it all here: what came out of it, why, and anything that needs doing next';
        try { ta.value = localStorage.getItem('planner.' + draftKey(S.rec) + (answering || '')) || ''; } catch {}
        ta.oninput = () => { try { localStorage.setItem('planner.' + draftKey(S.rec) + (answering || ''), ta.value); } catch {} };
        const row = el('div', 'row', null, wrap); row.style.marginTop = '8px';
        const m = btn('🎤 Talk', 'mic', null, row);
        mic = micFor(ta, m, (t) => { info.textContent = t; });
        btn(answering ? 'Send answer' : S.rec.understanding ? 'Add this' : 'Organize it', 'primary', () => { const v = ta.value; try { localStorage.removeItem('planner.' + draftKey(S.rec) + (answering || '')); } catch {} run(v, answering); }, row);
        if (!quiet && S.mode !== 'view') btn('Do this later', '', later, row);
        const info = el('p', 'hint', '', wrap); info.style.marginTop = '6px';
        setTimeout(() => ta.focus(), 30);
        return ta;
      }

      function main(parent) {
        const r = S.rec, u = r.understanding;
        if (S.phase === 'thinking') { el('p', 'thinking', 'Claude is reading what you said… usually 10 to 30 seconds.', parent); }
        if (S.phase === 'saving') { el('p', 'thinking', 'Saving…', parent); return; }
        if (S.err) el('p', 'err', S.err, parent);
        if (!u) {
          if (r.said.length && S.phase !== 'thinking') {
            const b = el('div', 'rbox', null, parent);
            el('h4', '', 'Your saved words', b);
            for (const s of r.said) el('p', '', s.text, b);
            const row = el('div', 'row', null, b); btn('Organize it now', 'primary', () => run(''), row);
          }
          if (S.phase !== 'thinking') talkBox(el('div', 'rbox', null, parent), { prompt: 'Talk it through in one go: what came out of it, the reasoning, and what needs doing next. Tap Talk (or press Windows + H, or the microphone on your phone\'s keyboard). You can also type.' });
          return;
        }
        const top = el('div', 'row', null, parent);
        const seg = el('div', 'seg2', null, top);
        for (const [k, t] of [['flow', 'Flowchart'], ['bullets', 'Bullet points']]) { const b = btn(t, k === S.view ? 'on' : '', () => { S.view = k; draw(); }, seg); b.className = k === S.view ? 'on' : ''; }
        const qs = u.questions || [], L = lettersOf(u);
        el('span', 'hint', qs.length ? `${qs.length} thing${qs.length === 1 ? '' : 's'} to check: click a yellow ! or a question.` : 'Nothing unclear.', top);
        const body = el('div', 'rbox', null, parent);
        if (S.view === 'flow') { drawGraph(body, u, S.q, selQ); if ((u.new_steps || []).length) { const ns = el('div', '', null, body); drawBullets(ns, { points: [], new_steps: u.new_steps }, S.q, selQ, { stepsTitle: 'New steps it will add' }); } }
        else drawBullets(body, u, S.q, selQ);
        if (qs.length && !(S.view === 'bullets' && S.q)) {
          const qb = el('div', 'rbox', null, parent); el('h4', '', 'To check', qb);
          const ol = el('ul', 'rqs', null, qb);
          for (const q of qs) { const li = el('li', '', null, ol); const b = el('button', S.q === q.id ? 'on' : '', null, li); b.type = 'button'; el('b', '', L.get(q.id), b); el('span', '', q.text, b); b.onclick = () => selQ(q.id); }
        }
        if (S.mode === 'view') {
          const row = el('div', 'row', null, parent); btn('Change it: say more', '', () => { S.mode = 'edit'; S.phase = 'more'; draw(); }, row);
          return;
        }
        if (!qs.length && u.check_back && S.phase !== 'thinking') {
          const c = el('div', 'check', null, parent); el('p', '', u.check_back, c).style.margin = '0 0 12px';
          const row = el('div', 'row', null, c);
          btn('Yes, that\'s correct: save it', 'primary', confirm, row);
          btn('Not quite: say more', '', () => { S.phase = 'more'; draw(); }, row);
          btn('Do this later', '', later, row);
        } else if (S.phase !== 'thinking') {
          const row = el('div', 'row', null, parent);
          btn('Say more', '', () => { S.phase = 'more'; draw(); }, row);
          btn('Do this later', '', later, row);
        }
        if (S.phase === 'more') talkBox(el('div', 'rbox', null, parent), { quiet: true, prompt: 'Add or correct anything: talk or type.' });
      }

      function questionPanel(parent) {
        const u = S.rec.understanding, q = (u?.questions || []).find((x) => x.id === S.q);
        if (!q) return;
        const b = el('div', 'rbox', null, parent);
        const head = el('div', 'row', null, b); head.style.justifyContent = 'space-between';
        el('h4', '', `Question ${lettersOf(u).get(q.id)}`, head).style.margin = '0';
        btn('Back', '', () => { S.q = null; draw(); }, head);
        if (q.quote) { el('p', 'hint', 'You said:', b).style.marginTop = '10px'; el('div', 'quote', `“${q.quote}”`, b); }
        el('p', '', q.text, b).style.cssText = 'font-size:16.5px;line-height:1.5;margin:6px 0 12px';
        if (S.phase === 'thinking') { el('p', 'thinking', 'Claude is checking your answer…', b); return; }
        if (S.err) el('p', 'err', S.err, b);
        if (S.mode !== 'view') talkBox(b, { answering: q.id, quiet: true });
      }

      function draw() {
        mic?.stop(); mic = null;
        box.innerHTML = '';
        const rs = el('div', 'rs', null, box);
        const head = el('div', 'rhead', null, rs);
        const hl = el('div', '', null, head);
        el('div', 'kicker', S.mode === 'verify' ? 'To verify' : S.mode === 'view' ? 'Train of thought' : S.mode === 'edit' ? 'Change the train of thought' : 'Mark done: talk it through', hl);
        el('h3', '', S.rec ? S.rec.title : `${(S.recs || []).length} step${(S.recs || []).length === 1 ? '' : 's'} with reasoning to check`, hl);
        const hr = el('div', 'row', null, head);
        if (S.mode === 'verify' && S.rec && S.q) btn('← All steps to verify', '', () => { S.rec = null; S.q = null; draw(); }, hr);
        btn('Close', '', close, hr);
        if (S.mode === 'verify' && !S.recs.length) { el('p', 'hint', 'Everything is verified.', rs); return; }
        const grid = el('div', 'rgrid', null, rs);
        const showList = S.mode === 'verify' && !S.q;
        if (showList) {
          grid.classList.add(S.rec ? 'list-main' : 'x');
          const lb = el('div', 'rbox rlist', null, grid);
          for (const r of S.recs) {
            const b = el('button', S.rec?.id === r.id ? 'on' : '', null, lb); b.type = 'button';
            el('span', '', r.title, b);
            const n = r.understanding?.questions?.length || 0;
            el('small', '', r.understanding ? (n ? `${n} to check` : 'ready to confirm') : 'not organized yet', b);
            b.onclick = () => pick(r);
          }
          if (!S.rec) return;
        }
        if (S.q) grid.classList.add('main-q');
        main(el('div', '', null, grid));
        if (S.q) questionPanel(el('div', '', null, grid));
      }
      draw();
      return { redraw: draw };
    }

    return { helperReady, pendingIds, doneIds, load, open, linesFor, flatten, drawBullets, drawGraph };
  }

  globalThis.PlannerReason = { create, flatten, linesFor };
})();
