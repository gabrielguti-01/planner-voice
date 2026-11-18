// Shared harness for the page tests: a static server for this folder, a browser page in demo mode (?mock=1) with
// synthetic settings, and a helper (AI proofread) whose answers the test releases by hand. Nothing leaves the machine:
// every request that isn't this server or the routed helper is refused.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.aff': 'text/plain', '.dic': 'text/plain', '.json': 'application/json' };
export const HELPER = 'https://helper.invalid'; // synthetic; routed below, never resolved

export function serve() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const f = p.endsWith('/') ? path.join(p, 'index.html') : p;
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}/` })));
}

export function chromium() {
  const require = createRequire(import.meta.url);
  try { return require('playwright').chromium; } catch { return require('/opt/node22/lib/node_modules/playwright').chromium; }
}

/**
 * A helper whose proofread answers wait until the test releases them. mode per call: 'answer' (texts mapped by
 * fixFn), 'fail' (HTTP 500), 'hang' (never answers: the page's own timeout decides).
 */
export function deferredHelper(page) {
  const calls = [];
  const route = page.route(`${HELPER}/**`, async (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    let release;
    const gate = new Promise((res) => { release = res; });
    const call = { body, release: (how = { mode: 'answer', fix: (t) => t }) => release(how) };
    calls.push(call);
    const how = await gate;
    if (how.mode === 'fail') return r.fulfill({ status: 500, body: '' });
    if (how.mode === 'hang') return; // left pending; the page aborts it
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ texts: body.texts.map(how.fix) }) });
  });
  return { calls, ready: route, waitCall: async (n) => { for (let i = 0; i < 200 && calls.length < n; i++) await page.waitForTimeout(25); if (calls.length < n) throw new Error(`helper call ${n} never came`); return calls[n - 1]; } };
}

/** A page with synthetic settings in localStorage, the network closed except this server and the helper route. */
/** globals: demo switches set before the page's own code runs (e.g. __MOCK_NEXT, a made-up plan). */
export async function open(browser, base, url, settings = {}, globals = {}) {
  const ctx = await browser.newContext();
  await ctx.route('**/*', (r) => { const u = r.request().url(); return u.startsWith(base) || u.startsWith(HELPER) ? r.fallback() : r.abort(); });
  await ctx.addInitScript(([s, g]) => { for (const [k, v] of Object.entries(s)) localStorage.setItem('planner.' + k, v); Object.assign(globalThis, g); }, [{ helperUrl: HELPER, helperPass: 'synthetic-pass', proofread: 'on', ...settings }, globals]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  const helper = deferredHelper(page);
  await helper.ready;
  await page.goto(base + url);
  return { ctx, page, helper, errors };
}

/**
 * A stand-in for GitHub's contents API for one made-up repository (state/next.md and state/inbox.md), so the real save
 * path runs without the network. loseNextPut: the next PUT is stored, then the connection is cut (the page never hears).
 */
export async function fakeGitHub(page, nextMd) {
  const files = { 'state/next.md': nextMd, 'state/inbox.md': '# Inbox\n' };
  const gh = { files, puts: 0, loseNextPut: false };
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  await page.route('https://api.github.com/**', async (r) => {
    const path = decodeURIComponent(new URL(r.request().url()).pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ''));
    if (!(path in files)) return r.fulfill({ status: 404, body: '{}' });
    if (r.request().method() === 'PUT') {
      const body = JSON.parse(r.request().postData());
      files[path] = Buffer.from(body.content, 'base64').toString('utf8'); gh.puts++;
      if (gh.loseNextPut) { gh.loseNextPut = false; return r.abort('connectionreset'); }
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: b64(files[path]), sha: 'sha-' + files[path].length }) });
  });
  return gh;
}
