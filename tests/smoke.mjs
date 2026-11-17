#!/usr/bin/env node
/* Browser smoke test: drives a real headless Chrome through both modes.

     node tests/smoke.mjs            both modes
     node tests/smoke.mjs server     only the self-hosted mode
     node tests/smoke.mjs demo       only the demo
     DEMO_URL=https://... node tests/smoke.mjs demo    a published demo page

   Needs Node 22+ (built-in WebSocket), Python 3 and Chrome or Chromium
   (set CHROME=/path/to/browser to choose one). No npm packages.

   Server mode starts the real server on a free loopback port with an empty
   temporary data folder, then sets a password and pattern, creates, edits and
   deletes entries, locks and unlocks, exports and imports. Demo mode serves
   app/ under a sub-path, like GitHub Pages. Both fail on any console error,
   uncaught exception, or request to another host.

   SHOTS=/some/folder saves screenshots of the main screens there. */
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {createServer as createTcp} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openBackup} from '../tools/open-backup.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'smoke test password';
const PATTERN = [0, 3, 6, 7, 8];          // an "L"
const WRONG = [2, 1, 0, 3];
const cleanups = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => console.log('  ' + msg);

function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg); }

function findChrome() {
  const names = [process.env.CHROME, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const name of names) {
    const found = spawnSync('sh', ['-c', 'command -v "$0"', name], {encoding: 'utf8'}).stdout.trim();
    if (found) return found;
  }
  throw new Error('No Chrome or Chromium found. Set CHROME=/path/to/browser.');
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createTcp();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); });
});

/* ---------- Chrome over the DevTools protocol ---------- */
class Browser {
  static async launch() {
    const profile = mkdtempSync(path.join(tmpdir(), 'lifeos-chrome-'));
    const args = ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run',
      '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--window-size=1280,900', 'about:blank'];
    if (process.env.CHROME_NO_SANDBOX) args.unshift('--no-sandbox');
    const proc = spawn(findChrome(), args, {stdio: ['ignore', 'ignore', 'pipe']});
    cleanups.push(() => { proc.kill('SIGKILL'); try { rmSync(profile, {recursive: true, force: true}); } catch (e) {} });
    const url = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('Chrome did not start: ' + buf.slice(-400))), 20000);
      proc.stderr.on('data', chunk => {
        buf += chunk;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.on('exit', code => reject(new Error('Chrome exited early (' + code + '): ' + buf.slice(-400))));
    });
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools socket failed')); });
    return new Browser(ws);
  }

  constructor(ws) {
    this.ws = ws; this.next = 1; this.waiting = new Map(); this.listeners = [];
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const w = this.waiting.get(msg.id); this.waiting.delete(msg.id);
        if (w) msg.error ? w.reject(new Error(w.method + ': ' + msg.error.message)) : w.resolve(msg.result);
      } else this.listeners.forEach(fn => fn(msg));
    };
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, {resolve, reject, method});
      this.ws.send(JSON.stringify(sessionId ? {id, method, params, sessionId} : {id, method, params}));
    });
  }

  async page(origin) {
    const {targetId} = await this.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await this.send('Target.attachToTarget', {targetId, flatten: true});
    const page = new Page(this, sessionId, origin);
    this.listeners.push(msg => { if (msg.sessionId === sessionId) page.event(msg.method, msg.params); });
    for (const domain of ['Page', 'Runtime', 'Log', 'Network', 'DOM']) await page.cdp(domain + '.enable');
    return page;
  }
}

class Page {
  constructor(browser, sessionId, origin) {
    this.browser = browser; this.sessionId = sessionId; this.origin = origin;
    this.problems = [];      // console errors and exceptions
    this.failed = [];        // HTTP responses with an error status
    this.outside = [];       // requests that left the origin
    this.requests = [];
  }

  cdp(method, params) { return this.browser.send(method, params, this.sessionId); }

  event(method, p) {
    if (method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) {
      this.problems.push('console.' + p.type + ': ' + p.args.map(a => a.value ?? a.description ?? '').join(' '));
    } else if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails;
      this.problems.push('exception: ' + (d.exception?.description || d.text));
    } else if (method === 'Log.entryAdded' && p.entry.level === 'error') {
      if (p.entry.source === 'network' && /status of \d+/.test(p.entry.text)) this.failed.push(p.entry.text + ' ' + (p.entry.url || ''));
      else this.problems.push('log: ' + p.entry.text + ' ' + (p.entry.url || ''));
    } else if (method === 'Network.requestWillBeSent') {
      const url = p.request.url;
      this.requests.push(p.request.method + ' ' + url);
      if (!url.startsWith(this.origin + '/') && !/^(data|blob|about):/.test(url)) this.outside.push(url);
    } else if (method === 'Network.loadingFailed' && !p.canceled) {
      this.problems.push('request failed: ' + p.errorText + ' ' + (p.blockedReason || ''));
    }
  }

  /* Everything since the last check must be clean; `allowed` lists the HTTP statuses that were provoked on purpose. */
  check(label, allowed = []) {
    const bad = this.failed.filter(t => !allowed.some(code => t.includes('status of ' + code)));
    const all = [...this.problems, ...bad, ...this.outside.map(u => 'request to another host: ' + u)];
    this.problems = []; this.failed = []; this.outside = [];
    if (all.length) throw new Error(label + ': the browser reported problems:\n    ' + all.join('\n    '));
    log('ok  ' + label);
  }

  async eval(expression) {
    const r = await this.cdp('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n    in: ' + expression.slice(0, 200));
    return r.result.value;
  }

  async wait(expression, what, timeout = 10000) {
    const end = Date.now() + timeout;
    for (;;) {
      if (await this.eval('Promise.resolve(' + expression + ').then(v=>!!v)')) return;
      if (Date.now() > end) {
        const gate = await this.eval(`document.getElementById('gate')?.innerText.slice(0,200)||''`);
        const status = await this.eval(`document.getElementById('status')?.innerText||''`);
        throw new Error('Timed out waiting for ' + (what || expression) + '\n    status: ' + status + ' | gate: ' + JSON.stringify(gate) + '\n    problems: ' + JSON.stringify(this.problems.concat(this.failed)));
      }
      await sleep(60);
    }
  }

  async goto(url) { await this.cdp('Page.navigate', {url}); await this.wait(`document.readyState==='complete'`, 'page load'); }
  async reload() { await this.cdp('Page.reload'); await sleep(150); await this.wait(`document.readyState==='complete'`, 'reload'); }

  async point(selector) {
    await this.wait(`document.querySelector(${JSON.stringify(selector)})`, selector);
    return this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,left:r.left,top:r.top,width:r.width,height:r.height};})()`);
  }

  async mouse(type, x, y, extra = {}) { await this.cdp('Input.dispatchMouseEvent', {type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra}); }

  async click(selector) {
    const p = await this.point(selector);
    await this.mouse('mouseMoved', p.x, p.y, {buttons: 0});
    await this.mouse('mousePressed', p.x, p.y);
    await this.mouse('mouseReleased', p.x, p.y);
  }

  async type(selector, text) {
    await this.click(selector);
    await this.wait(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`, 'focus on ' + selector);
    await this.cdp('Input.insertText', {text});
  }

  async press(key) {
    const code = {Enter: 13, Escape: 27}[key];
    const base = {key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code};
    await this.cdp('Input.dispatchKeyEvent', {type: 'keyDown', ...base, text: key === 'Enter' ? '\r' : undefined});
    await this.cdp('Input.dispatchKeyEvent', {type: 'keyUp', ...base});
  }

  async dots(selector, seq) {
    const r = await this.point(selector);
    return seq.map(i => ({x: r.left + (50 + 100 * (i % 3)) / 300 * r.width, y: r.top + (50 + 100 * Math.floor(i / 3)) / 300 * r.height}));
  }

  /* Draw a pattern with the mouse. */
  async draw(selector, seq) {
    const pts = await this.dots(selector, seq);
    await this.mouse('mouseMoved', pts[0].x, pts[0].y, {buttons: 0});
    await this.mouse('mousePressed', pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      for (let s = 1; s <= 4; s++) {
        await this.mouse('mouseMoved', pts[i - 1].x + (pts[i].x - pts[i - 1].x) * s / 4, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * s / 4);
      }
    }
    const last = pts[pts.length - 1];
    await this.mouse('mouseReleased', last.x, last.y);
  }

  /* Draw a pattern with a finger. */
  async swipe(selector, seq) {
    const pts = await this.dots(selector, seq);
    const touch = (type, p) => this.cdp('Input.dispatchTouchEvent', {type, touchPoints: p ? [{x: Math.round(p.x), y: Math.round(p.y)}] : []});
    await touch('touchStart', pts[0]);
    for (let i = 1; i < pts.length; i++) {
      for (let s = 1; s <= 4; s++) {
        await touch('touchMove', {x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * s / 4, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * s / 4});
      }
    }
    await touch('touchEnd');
  }

  ready() { return this.wait(`!document.getElementById('gate').classList.contains('show')&&/\\b(ok|warn)\\b/.test(document.getElementById('status').className)&&document.getElementById('nav').children.length>0`, 'the app to be open'); }
  saved() { return this.wait(`document.getElementById('status').classList.contains('ok')`, 'status "Saved"'); }
  gate(selector) { return this.wait(`document.querySelector('#gate.show ${selector}')`, 'gate ' + selector); }
  toast(text) { return this.wait(`document.getElementById('toast').classList.contains('show')&&document.getElementById('toast').textContent.includes(${JSON.stringify(text)})`, 'toast "' + text + '"'); }
  api(pathname) { return this.eval(`fetch(${JSON.stringify(pathname)},{cache:'no-store'}).then(async r=>({status:r.status,body:await r.json()}))`); }
  async shot(name) {
    if (!process.env.SHOTS) return;
    mkdirSync(process.env.SHOTS, {recursive: true});
    await sleep(250);
    const {data} = await this.cdp('Page.captureScreenshot', {format: 'png'});
    writeFileSync(path.join(process.env.SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  }
  async relock(seconds) {   // Settings > Security > "Lock again"
    await this.wait(`document.querySelector('[data-change="sec-relock"]')`, 'the "Lock again" setting');
    await this.eval(`(()=>{const s=document.querySelector('[data-change="sec-relock"]');s.value='${seconds}';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await this.wait(`fetch('api/auth/state').then(r=>r.json()).then(s=>s.relock===${seconds})`, 'the re-lock setting to be saved');
    await this.wait(`document.querySelector('[data-change="sec-relock"]')?.value==='${seconds}'`, 'the setting to show');
  }
  visibility(state) { return this.eval(`(()=>{Object.defineProperty(document,'visibilityState',{value:'${state}',configurable:true});document.dispatchEvent(new Event('visibilitychange'));})()`); }
}

/* ---------- the two servers ---------- */
async function startLifeOS() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'lifeos-smoke-data-'));
  const port = await freePort();
  const proc = spawn('python3', ['-m', 'lifeos'], {cwd: path.join(ROOT, 'server'),
    env: {...process.env, LIFEOS_DATA: dataDir, LIFEOS_PORT: String(port), PYTHONDONTWRITEBYTECODE: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '';
  proc.stdout.on('data', c => { out += c; }); proc.stderr.on('data', c => { out += c; });
  cleanups.push(() => { proc.kill('SIGTERM'); try { rmSync(dataDir, {recursive: true, force: true}); } catch (e) {} });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return {base, output: () => out}; } catch (e) {}
    await sleep(100);
  }
  throw new Error('The Life OS server did not start:\n' + out);
}

/* A static file server for app/ under /life-os/, the way GitHub Pages publishes a project site. */
async function startStatic() {
  const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain'};
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/life-os/')) { res.writeHead(404); res.end('not found'); return; }
    let rel = decodeURIComponent(url.pathname.slice('/life-os/'.length)) || 'index.html';
    const file = path.join(ROOT, 'app', rel);
    if (rel.includes('..') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => server.close());
  return 'http://127.0.0.1:' + server.address().port;
}

async function downloads(browser, page) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lifeos-smoke-dl-'));
  cleanups.push(() => { try { rmSync(dir, {recursive: true, force: true}); } catch (e) {} });
  await browser.send('Browser.setDownloadBehavior', {behavior: 'allow', downloadPath: dir});
  const seen = new Set();
  return async () => {
    for (let i = 0; i < 100; i++) {
      const files = readdirSync(dir).filter(f => /\.(json|csv)$/.test(f) && !seen.has(f));   // Chrome may drop files of its own here
      if (files.length) { seen.add(files[0]); await sleep(100); return path.join(dir, files[0]); }
      await sleep(100);
    }
    throw new Error('No file was downloaded');
  };
}

const todayISO = `(()=>{const d=new Date();if(d.getHours()<4)d.setDate(d.getDate()-1);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})()`;

/* ---------- server mode ---------- */
async function serverMode(browser) {
  console.log('Server mode');
  const {base} = await startLifeOS();
  const page = await browser.page(base);
  const nextDownload = await downloads(browser, page);

  await page.goto(base + '/');
  await page.gate('form[data-gate="setup"]');
  assert(await page.eval(`document.getElementById('app').innerHTML===''`), 'nothing is rendered behind the setup screen');
  await page.type('#gate [data-g="pw"]', PASSWORD);
  await page.type('#gate [data-g="pw2"]', PASSWORD);
  await page.click('#gate [data-action="gate-pat-open"]');
  await page.draw('#gate .pgrid', PATTERN);
  await page.wait(`/again/.test(document.getElementById('gate').textContent)`, 'the prompt to repeat the pattern');
  await page.draw('#gate .pgrid', PATTERN);
  await page.wait(`/Pattern ready/.test(document.getElementById('gate').textContent)`, 'the pattern to be accepted');
  assert(await page.eval(`document.querySelector('#gate [data-g="pw"]').value`) === PASSWORD, 'the password survives the redraw');
  await page.shot('server-1-setup');
  await page.click('#gate button[type="submit"]');
  await page.ready();
  assert(await page.eval(`document.getElementById('status').classList.contains('ok')`), 'status is "Saved"');
  const cookies = (await page.cdp('Network.getCookies', {urls: [base + '/']})).cookies.filter(c => c.name === 'lifeos_session');
  assert(cookies.length === 1 && cookies[0].httpOnly && cookies[0].secure && cookies[0].sameSite === 'Strict', 'session cookie is HttpOnly, Secure, SameSite=Strict');
  assert(await page.eval(`document.cookie`) === '', 'the cookie is not readable by scripts');
  assert(await page.eval(`document.fonts.check('20px "Material Symbols Outlined"')&&document.documentElement.classList.contains('ico')`), 'icon font loaded from this origin');
  await page.eval(`document.fonts.ready`);
  assert(await page.eval(`document.fonts.check('15px "Instrument Sans"')`), 'text font loaded from this origin');
  page.check('set a password and a pattern, first load');

  /* create */
  const today = await page.eval(todayISO);
  await page.click('.side .rb[data-n="4"]');
  await page.type('.side textarea[data-field="recap"]', 'Smoke test recap');
  await page.click(`.side .pband[data-drop="slot:${today}:m"] .pplus`);
  await page.type('.side .pin input', 'Smoke task');
  await page.press('Enter');
  assert(await page.eval(`!document.querySelector('.side .padd')`), 'the day has no separate add row');
  await page.click('.side .ebox[data-at$=":people"] .ebh');
  await page.type('.side input[data-enter="ent-add"][data-k="people"]', 'Smoke friend');
  await page.press('Enter');
  await page.wait(`document.activeElement===document.querySelector('.side input[data-scope="ppl"][data-field="activity"]')`, 'the people row added at once, the cursor on what you did');
  await sleep(900);                         // the typing debounce
  await page.saved();
  let data = (await page.api('api/data')).body;
  assert(data.days[today] && data.days[today].rating === 4 && data.days[today].recap === 'Smoke test recap', 'day entry created on the server');
  let tasks = Object.values(data.tasks);
  assert(tasks.length === 1 && tasks[0].title === 'Smoke task' && tasks[0].plannedFor === today, 'task created on the server');
  assert(Object.keys(data.people_log).length === 1 && Object.values(data.people_log)[0].people === 'Smoke friend', 'people row created on the server');
  await page.shot('server-2-calendar');
  page.check('create a day entry, a task and a people row');

  /* edit */
  await page.type('.side textarea[data-field="recap"]', ', edited');
  await page.click('.side .pchip .pst[data-action="plan-toggle"]');
  await sleep(900);
  await page.saved();
  data = (await page.api('api/data')).body;
  assert(data.days[today].recap === 'Smoke test recap, edited', 'recap edited on the server');
  assert(Object.values(data.tasks)[0].status === 'done' && Object.values(data.tasks)[0].doneOn === today, 'task marked done on the server');
  page.check('edit the entry and the task');

  /* the plan: a session is planned, placed in a part of the day, ticked into the sport log,
     and something else is moved to tomorrow, which asks why */
  const drag = (from, to) => page.eval(`(()=>{const a=document.querySelector(${JSON.stringify(from)}),b=document.querySelector(${JSON.stringify(to)});if(!a||!b)return false;const dt=new DataTransfer();a.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));b.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));b.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));a.dispatchEvent(new DragEvent('dragend',{bubbles:true}));return true;})()`);
  const planKind = kind => page.click(`.side .pin [data-action="plan-kind-pick"][data-v="${kind}"]`);
  const tomorrow = await page.eval(`(()=>{const [y,m,d]=${JSON.stringify(today)}.split('-').map(Number);const t=new Date(y,m-1,d+1);return t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0');})()`);
  await page.click(`.side .pband[data-drop="slot:${today}:a"] .pl`);   // the part of the day itself takes a new item
  await planKind('sport');
  await page.type('.side .pin input', 'Running');
  await page.press('Enter');
  await planKind('people');
  await page.type('.side .pin input', 'Dinner out');
  await page.press('Enter');
  await page.wait(`document.querySelectorAll('.side .pband[data-drop$=":a"] .pchip[draggable]').length===2`, 'the two items in the afternoon');
  await page.press('Escape');
  await page.wait(`!document.querySelector('.side .pin')`, 'Escape closes the new item');
  assert(await drag('.side .pband[data-drop$=":a"] .pchip[draggable]', `.side .pband[data-drop="slot:${today}:e"]`), 'drag onto the evening');
  await page.wait(`document.querySelector('.side .pband[data-drop$=":e"] .pchip')&&!document.getElementById('why').classList.contains('show')`, 'the session in the evening, with no question asked');
  await page.click('.side .pband[data-drop$=":e"] .pchip .pst');
  await page.wait(`document.querySelector('.side select[data-change="act-sport"]')?.value==='Running'`, 'the ticked session in the sport log');
  assert(await drag('.side .pband[data-drop$=":a"] .pchip[draggable]', `.cell[data-date="${tomorrow}"]`), 'drag onto tomorrow');
  await page.wait(`document.getElementById('why').classList.contains('show')`, 'the question why');
  await page.click('#why [data-v="Weather"]');
  await page.wait(`!document.getElementById('why').classList.contains('show')&&document.querySelector('.side .pchip.ghost')`, 'the reason taken, a trace left on the day');
  await page.saved();
  data = (await page.api('api/data')).body;
  const planned = Object.values(data.plan), logged = Object.values(data.plan_log), run = planned.find(x => x.kind === 'sport'), dinner = planned.find(x => x.kind === 'people'), smoke = planned.find(x => x.kind === 'task');
  assert(smoke && smoke.date === today && smoke.part === 'm' && data.tasks[smoke.ref].plannedFor === today, 'the task added in the morning is planned there');
  assert(planned.length === 3 && run.title === 'Running' && run.date === today && run.part === 'e' && run.status === 'done', 'the session is planned, placed and done on the server');
  assert(Object.keys(data.activities).length === 1 && data.activities[run.link].sport === 'Running' && data.activities[run.link].date === today, 'ticking it wrote the sport session it links to');
  assert(dinner.date === tomorrow && dinner.status === 'planned', 'the other item moved to tomorrow');
  const place = logged.find(l => l.kind === 'place'), move = logged.find(l => l.kind === 'move');
  assert(logged.length === 2 && place.planId === run.id && place.reason === '' && place.to.part === 'e', 'placing was logged without a reason');
  assert(move.planId === dinner.id && move.reason === 'Weather' && move.timing === 'day' && move.from.date === today && move.to.date === tomorrow, 'moving was logged with its reason');
  const week = Object.values(data.periods).find(p => p.kind === 'week' && p.start <= today && p.end >= today);
  assert(week && Number.isFinite(week.planAt) && Array.isArray(week.planBase), 'the week has a committed plan');
  await page.click('.side [data-action="act-del"]');
  await page.wait(`document.querySelectorAll('.side .pchip.done').length===1`, 'the session back to planned once its log row is gone');
  await page.click('.side .pband[data-drop$=":e"] .pchip .ptt');
  await page.wait(`document.querySelector('.side .pband[data-drop$=":e"] .pmenu')&&!document.querySelector('#sheet .sheet')`, 'a small menu under the item, not a sheet');
  await page.click('.side .pmenu [data-action="plan-part"][data-v="m"]');
  await page.wait(`document.querySelector('.side .pband[data-drop$=":m"] .pmenu')`, 'the item and its menu moved to the morning');
  await page.click('.side .plab');
  await page.wait(`!document.querySelector('.side .pmenu')`, 'a click elsewhere closes the menu');
  page.check('plan, place, tick, move with a reason, the item menu');

  /* the data survives a reload, and comes back from the server */
  await page.reload();
  await page.ready();
  await page.wait(`document.querySelector('.side .rb.on[data-n="4"]')&&document.querySelector('.side textarea[data-field="recap"]').value==='Smoke test recap, edited'`, 'the saved entry after a reload');
  page.check('reload shows the saved data');

  /* a change made elsewhere shows up when the tab becomes visible again */
  await page.eval(`fetch('api/data/tasks/t_elsewhere',{method:'PUT',headers:{'X-LifeOS':'1','Content-Type':'application/json'},body:JSON.stringify({id:'t_elsewhere',title:'Added on the phone',description:'',status:'todo',priority:'none',area:'',plannedFor:${JSON.stringify(today)},doneOn:null,subtasks:[],createdAt:Date.now()})}).then(r=>r.status)`);
  await page.visibility('hidden');
  await page.visibility('visible');
  await page.wait(`[...document.querySelectorAll('.side .pchip .ptt')].some(e=>e.textContent==='Added on the phone')`, 'the task written by another device');
  page.check('refresh on becoming visible');

  /* delete */
  await page.click('.side [data-action="ppl-del"]');
  await page.eval(`[...document.querySelectorAll('.side .pchip .ptt')].find(e=>e.textContent.includes('Smoke task')).click()`);
  await page.click('.side .pmenu [data-action="plan-open"]');
  await page.click('#sheet [data-action="task-open"]');
  await page.click('#sheet [data-action="task-del"]');
  await page.wait(`!document.querySelector('#sheet .sheet')`, 'the sheets to close');
  await page.saved();
  data = (await page.api('api/data')).body;
  assert(Object.keys(data.people_log).length === 0, 'people row deleted on the server');
  assert(Object.values(data.tasks).every(t => t.title !== 'Smoke task'), 'task deleted on the server');
  page.check('delete the people row and the task');

  /* every view renders */
  for (const view of ['review', 'tasks', 'calendar']) {
    await page.click(`[data-nav="${view}"]`);
    await page.wait(`location.hash==='#${view}'&&document.getElementById('app').children.length>0`, view + ' view');
  }
  await page.click('[data-action="rv-kind"][data-k="month"]').catch(() => {});
  page.check('calendar, review and tasks views');

  /* export downloads a real file; importing it back goes through the server in one request */
  await page.click('#gear');
  await page.wait(`[...document.querySelectorAll('.sec h2')].some(h=>h.textContent==='Security')`, 'the Security section');
  await page.eval(`document.querySelector('.sec .devrow').scrollIntoView({block:'center'})`);
  await page.shot('server-3-settings-security');
  const hint = await page.eval(`document.querySelector('.schema .hint').textContent`);
  assert(/on your own server/.test(hint), 'storage hint describes server mode: ' + hint);
  await page.click('.schema details > summary');
  await page.click('[data-action="export-all"]');
  const file = await nextDownload();
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  assert(/^life-os-\d{4}-\d\d-\d\d\.json$/.test(path.basename(file)), 'export file name: ' + path.basename(file));
  assert(Object.keys(exported).length === 11 && exported.days[today].rating === 4, 'export holds the eleven collections');
  const {result} = await page.cdp('Runtime.evaluate', {expression: `document.querySelector('input[data-import="__all"]')`});
  const before = page.requests.length;
  await page.cdp('DOM.setFileInputFiles', {files: [file], objectId: result.objectId});
  await page.toast('Imported ' + Object.values(exported).reduce((n, c) => n + Object.keys(c).length, 0) + ' rows');
  const sent = page.requests.slice(before).filter(r => r.includes('/api/'));
  assert(sent.length === 1 && sent[0] === 'POST ' + base + '/api/import', 'import is one request: ' + JSON.stringify(sent));
  assert(JSON.stringify((await page.api('api/data')).body) === JSON.stringify(exported), 'export, import, export gives the same data');
  page.check('export to a file and import it again');

  /* encrypted backup: the password is checked by the server, the file is sealed in the browser */
  const openDialog = async () => {
    if (!(await page.eval(`document.querySelector('.schema details').open`))) await page.click('.schema details > summary');
    await page.click('[data-action="backup-open"]');
    await page.wait(`!!document.querySelector('#sheet [data-sk="pw"]')`, 'the backup dialog');
  };
  await openDialog();
  await page.type('#sheet [data-sk="pw"]', 'not the password');
  await page.click('[data-action="backup-go"]');
  await page.toast('Wrong password.');
  await page.click('#sheet [data-action="sheet-close"]');
  await openDialog();
  await page.type('#sheet [data-sk="pw"]', PASSWORD);
  await page.press('Enter');
  const backupFile = await nextDownload();
  assert(/^life-os-backup-\d{4}-\d\d-\d\d-\d{4}\.json$/.test(path.basename(backupFile)), 'backup file name: ' + path.basename(backupFile));
  await page.wait(`!document.querySelector('#sheet [data-sk="pw"]')`, 'the backup dialog to close');
  const sealed = readFileSync(backupFile, 'utf8');
  const envelope = JSON.parse(sealed);
  assert(envelope.lifeos_backup === 1 && envelope.kdf === 'PBKDF2-HMAC-SHA256' && envelope.cipher === 'AES-256-GCM' && envelope.iterations >= 600000, 'backup header: ' + sealed.slice(0, 160));
  const locked = Buffer.from(envelope.data, 'base64');
  assert(!locked.includes('"days"') && !locked.includes(today) && !sealed.includes('"days"'), 'the backup file shows nothing of its contents');
  assert(JSON.stringify(JSON.parse(openBackup(envelope, PASSWORD))) === JSON.stringify(exported), 'the backup opens with the password and holds the same data as the export');
  let opened = true;
  try { openBackup(envelope, 'not the password'); } catch (e) { opened = false; }
  assert(!opened, 'a wrong password must not open the backup');
  const tampered = Object.assign({}, envelope, {data: envelope.data.slice(0, 40) + (envelope.data[40] === 'A' ? 'B' : 'A') + envelope.data.slice(41)});
  opened = true;
  try { openBackup(tampered, PASSWORD); } catch (e) { opened = false; }
  assert(!opened, 'a changed backup file must not open');
  /* importing the encrypted file asks for its password first */
  const pickFile = async file => {                      // the page is drawn again after every dialog, so look the input up each time
    const picker = await page.cdp('Runtime.evaluate', {expression: `document.querySelector('input[data-import="__all"]')`});
    await page.cdp('DOM.setFileInputFiles', {files: [file], objectId: picker.result.objectId});
  };
  const beforeImport = page.requests.length;
  await pickFile(backupFile);
  await page.wait(`document.querySelector('#sheet h2')?.textContent==='Open backup'`, 'the dialog that asks for the backup password');
  await page.type('#sheet [data-sk="pw"]', 'not the password');
  await page.click('[data-action="backup-go"]');
  await page.toast('That password does not open this backup.');
  assert(!page.requests.slice(beforeImport).some(r => r.includes('/api/')), 'a wrong backup password sends nothing to the server');
  await page.click('#sheet [data-action="sheet-close"]');
  await pickFile(backupFile);
  await page.wait(`document.querySelector('#sheet h2')?.textContent==='Open backup'`, 'the dialog again');
  await page.type('#sheet [data-sk="pw"]', PASSWORD);
  await page.click('[data-action="backup-go"]');
  await page.toast('Imported ' + Object.values(exported).reduce((n, c) => n + Object.keys(c).length, 0) + ' rows');
  assert(JSON.stringify((await page.api('api/data')).body) === JSON.stringify(exported), 'importing the backup gives the same data');
  page.check('encrypted backup: save, open outside the app, import', [403]);

  /* closing a week offers the backup; "Not now" leaves the week closed */
  await page.click('[data-nav="review"]');
  await page.click('[data-action="rv-kind"][data-k="week"]');
  await page.click('[data-action="rv-close"]');
  await page.wait(`/^Week \\d+ is closed\\./.test(document.querySelector('#sheet .hint')?.textContent||'')`, 'the backup offer after closing a week');
  await page.shot('server-3b-close-week-backup');
  await page.click('#sheet .acts [data-action="sheet-close"]');
  await page.wait(`!document.querySelector('#sheet [data-sk="pw"]')&&!!document.querySelector('[data-action="rv-reopen"]')`, 'the closed week without the dialog');
  await page.saved();
  assert(Object.values((await page.api('api/data')).body.periods).some(p => p.closedAt), 'the week is closed on the server');
  await page.click('[data-action="rv-reopen"]');
  await page.saved();
  await page.click('[data-action="rv-kind"][data-k="month"]');
  await page.click('[data-action="rv-close"]');
  await page.wait(`!!document.querySelector('[data-action="rv-reopen"]')`, 'the closed month');
  assert(!(await page.eval(`!!document.querySelector('#sheet [data-sk="pw"]')`)), 'closing a month does not offer a backup');
  await page.click('[data-action="rv-reopen"]');
  await page.saved();
  await page.click('#gear');
  await page.wait(`[...document.querySelectorAll('.sec h2')].some(h=>h.textContent==='Security')`, 'the Security section again');
  page.check('closing a week offers a backup');

  /* settings: all fonts come from this origin */
  await page.click('[data-action="font-toggle"]');
  await page.wait(`document.querySelectorAll('link[id^="font-"]').length===8`, 'the font stylesheets');
  await page.click('[data-font="Lora"]');
  await page.eval(`document.fonts.ready`);
  await page.wait(`document.fonts.check('15px "Lora"')`, 'the Lora font');
  await page.click('[data-action="font-toggle"]');
  await page.click('[data-font="Instrument Sans"]');
  await page.saved();
  page.check('font picker loads local fonts only');

  /* lock when leaving the app; unlocking brings the data back */
  await page.relock(0);
  await page.visibility('hidden');
  await page.gate('.pgrid[data-pat="unlock"]');
  await page.visibility('visible');
  await page.shot('server-4-locked');
  assert(await page.eval(`document.getElementById('app').innerHTML===''&&document.getElementById('sheet').innerHTML===''`), 'no data is left in the page while locked');
  assert(!(await page.eval(`document.body.innerText`)).includes('Smoke test recap'), 'no journal text is visible while locked');
  await page.wait(`fetch('api/auth/state').then(r=>r.json()).then(s=>s.locked===true)`, 'the server to report the session as locked');
  await page.draw('#gate .pgrid', PATTERN);
  await page.ready();
  await page.wait(`location.hash==='#settings'&&document.querySelector('[data-change="sec-relock"]').value==='0'`, 'settings after unlocking');
  page.check('lock on leaving, unlock with the pattern');

  await page.reload();                      // "when I leave": a fresh page starts locked
  await page.gate('.pgrid[data-pat="unlock"]');
  await page.cdp('Emulation.setTouchEmulationEnabled', {enabled: true});
  await page.swipe('#gate .pgrid', PATTERN);
  await page.ready();
  await page.cdp('Emulation.setTouchEmulationEnabled', {enabled: false});
  await page.click('[data-nav="calendar"]');
  await page.wait(`document.querySelector('.side .rb.on[data-n="4"]')`, 'the data after unlocking by touch');
  page.check('fresh page starts locked; unlock by touch');

  /* refused attempts: these provoke 4xx answers on purpose */
  await page.click('#gear');
  await page.relock(300);
  await page.eval(`fetch('api/auth/lock',{method:'POST',headers:{'X-LifeOS':'1'}}).then(r=>r.status)`);
  assert((await page.api('api/data')).status === 423, 'a locked session gets no data');
  await page.reload();
  await page.gate('.pgrid[data-pat="unlock"]');
  await page.draw('#gate .pgrid', WRONG);
  await page.wait(`/Wrong pattern\\. 4 tries left/.test(document.getElementById('gmsg').textContent)`, 'the wrong-pattern message');
  await page.shot('server-5-wrong-pattern');
  await sleep(750);
  await page.click('#gate [data-action="gate-use-password"]');
  await page.gate('form[data-gate="login"]');
  await page.type('#gate [data-g="pw"]', 'not the password');
  await page.press('Enter');
  await page.wait(`/Wrong password/.test(document.getElementById('gmsg').textContent)`, 'the wrong-password message');
  await page.shot('server-6-login');
  await page.click('#gate [data-action="gate-use-quick"]');
  await page.gate('.pgrid[data-pat="unlock"]');
  await page.draw('#gate .pgrid', PATTERN);
  await page.ready();
  page.check('wrong pattern and wrong password are refused', [403, 423]);

  /* change the pattern and the password, then sign out and back in */
  await page.click('#gear');
  await page.click('[data-action="sec-pattern"]');
  await page.type('#sheet [data-sk="cur"]', PASSWORD);
  const second = [2, 5, 8, 7, 6];
  await page.draw('#sheet .pgrid', second);
  await page.wait(`/again/.test(document.querySelector('#sheet .sheet').textContent)`, 'the prompt to repeat the new pattern');
  await page.shot('server-7-pattern-sheet');
  await page.draw('#sheet .pgrid', second);
  await page.wait(`/Pattern ready/.test(document.querySelector('#sheet .sheet').textContent)`, 'the new pattern to be accepted');
  assert(await page.eval(`document.querySelector('#sheet [data-sk="cur"]').value`) === PASSWORD, 'the typed password survives the sheet redraw');
  await page.click('#sheet [data-action="sec-pattern-save"]');
  await page.toast('Pattern saved');
  const newPassword = PASSWORD + ' two';
  await page.click('[data-action="sec-password"]');
  await page.type('#sheet [data-sk="cur"]', PASSWORD);
  await page.type('#sheet [data-sk="p1"]', newPassword);
  await page.type('#sheet [data-sk="p2"]', newPassword);
  await page.click('#sheet [data-action="sec-password-save"]');
  await page.toast('Password changed');
  await page.click('[data-action="sec-signout"]');
  await page.gate('form[data-gate="login"]');
  assert(await page.eval(`document.getElementById('app').innerHTML===''`), 'nothing is rendered after signing out');
  await page.type('#gate [data-g="pw"]', newPassword);
  await page.press('Enter');
  await page.ready();
  await page.eval(`fetch('api/auth/lock',{method:'POST',headers:{'X-LifeOS':'1'}}).then(r=>r.status)`);
  await page.reload();
  await page.gate('.pgrid[data-pat="unlock"]');
  await page.draw('#gate .pgrid', second);
  await page.ready();
  page.check('change pattern and password, sign out, sign in');

  const manifest = await page.cdp('Page.getAppManifest');
  assert(manifest.url.endsWith('/manifest.webmanifest') && !manifest.errors.length, 'manifest loads without errors');
  assert(JSON.parse(manifest.data).name === 'Life OS' && JSON.parse(manifest.data).display === 'standalone', 'manifest names the app and opens it standalone');
  const install = (await page.cdp('Page.getInstallabilityErrors')).installabilityErrors.map(e => e.errorId);
  log('installability: ' + (install.length ? install.join(', ') : 'no errors'));
  assert(!page.requests.some(r => r.includes('demo.js')), 'server mode never asks for the demo data');
  page.check('web app manifest');
}

/* ---------- demo mode ---------- */
async function demoMode(browser) {
  console.log('Demo mode');
  const live = process.env.DEMO_URL;                    // test a published demo instead of the local files
  const origin = live ? new URL(live).origin : await startStatic();
  const base = live || origin + '/life-os/';
  const page = await browser.page(origin);
  const nextDownload = await downloads(browser, page);
  await page.goto(base);
  await page.ready();
  assert(await page.eval(`document.getElementById('status').textContent`) === 'Example data', 'status says "Example data"');
  const banner = await page.eval(`document.querySelector('.banner.demo')?.innerText||''`);
  assert(/Example data/.test(banner) && /not saved|Nothing you change here is saved/.test(banner), 'banner explains the demo: ' + banner);
  assert(await page.eval(`!!document.querySelector('.banner.demo a[href^="https://github.com/"]')`), 'banner links to the repository');
  assert(await page.eval(`!document.getElementById('gate').classList.contains('show')`), 'no login in demo mode');
  const rated = await page.eval(`document.querySelectorAll('.mblock .cell.rated:not(.out)').length`);
  assert(rated >= 40, 'the calendar shows rated days: ' + rated);
  assert(await page.eval(`document.querySelectorAll('.side .hb').length`) >= 5, 'habits in the day editor');
  await page.eval(`document.fonts.ready`);
  assert(await page.eval(`document.fonts.check('15px "Instrument Sans"')&&document.fonts.check('20px "Material Symbols Outlined"')`), 'fonts load under a sub-path');
  await page.shot('demo-1-calendar');
  assert(await page.eval(`document.querySelectorAll('.side .pbands .pband').length===3&&document.querySelectorAll('.side .pchip').length>=2`), 'the day editor shows the plan in three parts of the day');
  assert(await page.eval(`[...document.querySelectorAll('.side .pband .pl')].every(e=>e.querySelector('.ms')&&e.textContent.trim()===e.querySelector('.ms').textContent.trim())`), 'the parts of the day are icons, with no word or status beside them');
  assert(await page.eval(`!document.querySelector('.mlabel')&&!document.querySelector('.calhead button[data-action="cal-mode"]')`), 'one month title, no separate mode button');
  assert(await page.eval(`(()=>{const a=document.querySelector('.calhead .cal-nav').getBoundingClientRect(),b=document.querySelector('.calhead .tools').getBoundingClientRect();return Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2)<8;})()`), 'the month title and the filters share one row');
  await page.click('.cal-title');
  await page.wait(`document.querySelectorAll('.wblock[data-week] .wcard .wplan .pchip').length>=10&&document.querySelector('.ptray')`, 'the week view with the plan and its tray');
  const bandTops = sel => `(()=>{const b=[...document.querySelectorAll('.wblock')].find(x=>x.getBoundingClientRect().left>=0&&x.getBoundingClientRect().left<200);return [0,1,2].every(i=>new Set([...b.querySelectorAll('${sel}')].map(w=>Math.round(w.querySelectorAll('.wb')[i].getBoundingClientRect().top))).size===1);})()`;
  assert(await page.eval(bandTops('.wcard')), 'each part of the day starts at the same height across the week');
  await page.eval(`[...document.querySelectorAll('.wblock')].find(x=>x.getBoundingClientRect().left>=0&&x.getBoundingClientRect().left<200).querySelector('.ptray .lbl').click()`);
  await page.wait(`document.activeElement&&document.activeElement.matches('.ptray .pin input[data-week]')`, 'typing straight into sometime this week');
  await page.type('.ptray .pin input[data-week]', 'Repot the plants');
  await page.press('Enter');
  await page.wait(`[...document.querySelectorAll('.ptray .pchip .ptt')].some(e=>e.textContent==='Repot the plants')`, 'the task floating in the week');
  await page.shot('demo-1b-week');
  await page.click('.cal-title');
  await page.wait(`document.querySelector('.mblock')`, 'the month view again');
  page.check('demo opens with example data');

  await page.click('[data-nav="review"]');
  await page.wait(`document.querySelectorAll('.rvc').length===7`, 'the review cards');
  await page.click('[data-action="rv-prev"]');
  await page.wait(`/Closed/.test(document.querySelector('.rv-head').textContent)`, 'last week to be a closed review');
  for (const key of ['rating', 'habits', 'sport', 'people', 'tasks', 'journal', 'intent']) {
    await page.click(`.rvc[data-rvm="${key}"]`);
    await page.wait(`document.querySelector('#rvdock .dk-b').children.length>0`, 'review detail ' + key);
  }
  assert(/^\d+%/.test(await page.eval(`document.querySelector('.rvc[data-rvm="tasks"] .v').textContent`)), 'last week shows how much of its plan was done');
  await page.click('[data-action="rv-next"]');
  await page.wait(`document.querySelectorAll('.pgrid7 .pday').length===7&&document.querySelector('.rvbox .ptray .pplus')&&!document.querySelector('.rvbox .ptray select')`, 'the plan for next week in this week’s review, with nothing but a faint plus to add');
  assert(await page.eval(`[0,1,2,3].every(i=>new Set([...document.querySelectorAll('.pgrid7 .pday')].map(d=>Math.round(d.querySelectorAll('.wb')[i].getBoundingClientRect().top))).size===1)`), 'next week’s parts of the day line up across the days');
  await page.click('.rvbox .ptray .pplus');
  await page.wait(`document.activeElement&&document.activeElement.matches('.rvbox .ptray .pin input[data-week]')`, 'adding to next week in place');
  await page.shot('demo-2b-review-plan');
  await page.press('Escape');
  await page.click('[data-action="rv-prev"]');
  await page.wait(`/Closed/.test(document.querySelector('.rv-head').textContent)`, 'last week again');
  await page.shot('demo-2-review-week');
  await page.click('[data-action="rv-kind"][data-k="month"]');
  await page.wait(`document.querySelector('.rvmonth')`, 'the month review');
  await page.shot('demo-3-review-month');
  await page.click('[data-nav="tasks"]');
  await page.wait(`document.querySelectorAll('.trk').length>=8`, 'the task list');
  await page.click('.tgroup .trk:not(.sub)');
  await page.wait(`document.querySelector('.tgroup .trk.open + .tdet .tpb[data-f="status"]')&&!document.querySelector('#sheet .sheet')&&!document.querySelector('.pop.open')`, 'a task opens in place, showing only the values it has');
  await page.click('.tgroup .trk.open .tpb[data-f="priority"]');
  await page.wait(`document.querySelectorAll('.pop.open').length===1&&document.activeElement.matches('.pop.open .pt')`, 'the priority tag opens a small menu, focused');
  await page.shot('demo-4-tasks');
  await page.click('.pop.open .pt[data-v="low"]');
  await page.wait(`!document.querySelector('.pop.open')&&document.querySelector('.tgroup .trk.open .tpb[data-f="priority"] .tag.pr')`, 'the priority chosen, the menu closed');
  await page.click('.tgroup .trk.open .tpb[data-f="area"]');
  await page.click('h1');
  await page.wait(`!document.querySelector('.pop.open')`, 'a click elsewhere closes the menu');
  await page.click('[data-action="task-view"][data-v="columns"]');
  await page.click('.kcard');
  await page.wait(`document.querySelector('.kcard.open + .tdet.card')&&!document.querySelector('#sheet .sheet')`, 'a card opens in place in its column');
  await page.shot('demo-4b-tasks-columns');
  await page.click('[data-action="task-view"][data-v="list"]');
  await page.click('#gear');
  await page.wait(`document.querySelectorAll('.tile').length>=6`, 'the habits in Settings');
  assert(await page.eval(`![...document.querySelectorAll('.sec h2')].some(h=>h.textContent==='Security')`), 'no Security section in the demo');
  assert(/Nothing is saved/.test(await page.eval(`document.querySelector('.schema .hint').textContent`)), 'storage hint describes the demo');
  page.check('review, tasks and settings views');

  /* changes work but are not saved */
  await page.type('#task-new', 'A change that is not kept').catch(async () => { await page.click('[data-nav="tasks"]'); await page.type('#task-new', 'A change that is not kept'); });
  await page.press('Enter');
  await page.wait(`[...document.querySelectorAll('.tte')].some(e=>e.textContent==='A change that is not kept')`, 'the new task');
  await page.click('#gear');
  await page.click('.schema details > summary');
  await page.click('[data-action="export-all"]');
  const exported = JSON.parse(readFileSync(await nextDownload(), 'utf8'));
  assert(Object.keys(exported).length === 11 && Object.values(exported.tasks).some(t => t.title === 'A change that is not kept'), 'export works in the demo');
  await page.click('[data-action="backup-open"]');
  await page.type('#sheet [data-sk="pw"]', 'any password works here');
  await page.click('[data-action="backup-go"]');
  const demoBackup = JSON.parse(readFileSync(await nextDownload(), 'utf8'));
  assert(JSON.stringify(JSON.parse(openBackup(demoBackup, 'any password works here'))) === JSON.stringify(exported), 'an encrypted backup works in the demo');
  assert(!page.requests.some(r => r.includes('/api/')), 'the demo never calls the API');
  await page.reload();
  await page.ready();
  await page.click('[data-nav="tasks"]');
  await page.wait(`document.querySelectorAll('.trk').length>=8`, 'the task list after a reload');
  assert(await page.eval(`![...document.querySelectorAll('.tte')].some(e=>e.textContent==='A change that is not kept')`), 'changes are gone after a reload');
  page.check('edits are not saved');

  /* phone size: a day opens as a sheet; the note can be hidden */
  await page.cdp('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 3, mobile: true});
  await page.goto(base + '#calendar');
  await page.ready();
  await page.click('.banner.demo [data-action="banner-off"]');
  await page.wait(`!document.querySelector('.banner.demo')`, 'the banner to hide');
  await page.shot('demo-5-phone-calendar');
  await page.eval(`document.querySelector('.mblock .cell.today').click()`);
  await page.wait(`document.querySelector('#sheet .editor .pbands')`, 'the day sheet on a phone, with the plan');
  await page.shot('demo-6-phone-day');
  await page.click('#sheet .pband[data-drop$=":m"] .pl');
  await page.wait(`document.activeElement===document.querySelector('#sheet .pin input')`, 'typing straight into the morning');
  await page.shot('demo-6b-phone-day-add');
  await page.press('Escape');
  await page.wait(`!document.querySelector('#sheet .pin')&&document.querySelector('#sheet .sheet')`, 'Escape closes the new item, not the day');
  await page.click('#sheet .pband .pchip .ptt');
  await page.wait(`document.querySelector('#sheet .pmenu')&&document.querySelectorAll('#sheet .sheet').length===1`, 'the item menu inside the day sheet');
  await page.shot('demo-6c-phone-day-menu');
  const sessions = await page.eval(`document.querySelectorAll('#sheet [data-change="act-sport"]').length`);
  await page.click('#sheet .ebox[data-at$=":sport"] .ebh');
  await page.type('#sheet input[data-enter="ent-add"][data-k="sport"]', 'Climbing');
  await page.press('Enter');
  await page.wait(`document.querySelectorAll('#sheet [data-change="act-sport"]').length===${sessions + 1}&&document.activeElement.matches('#sheet input[data-scope="act"][data-field="note"]')&&document.activeElement.value===''`, 'the session added at once, the cursor on its note');
  await page.shot('demo-6d-phone-day-sport');
  page.check('phone layout');
  await page.cdp('Emulation.clearDeviceMetricsOverride');
}

/* ---------- run ---------- */
const which = process.argv[2] || 'all';
let failed = false;
try {
  const browser = await Browser.launch();
  if (which === 'all' || which === 'server') await serverMode(browser);
  if (which === 'all' || which === 'demo') await demoMode(browser);
  console.log('Smoke test passed.');
} catch (err) {
  failed = true;
  console.error('\nSmoke test FAILED\n  ' + (err && err.message || err));
} finally {
  for (const fn of cleanups.reverse()) { try { fn(); } catch (e) {} }
}
process.exit(failed ? 1 : 0);
