#!/usr/bin/env node
/* A short check in Firefox's engine (Gecko), over WebDriver BiDi:

     node tests/firefox-check.mjs

   tests/smoke.mjs is the thorough test and drives Chrome. This one covers
   what could differ in Firefox, at phone size: the setup screen, drawing the
   pattern by touch, saving an entry, the lock and unlocking, and the demo.
   It fails on any console error or uncaught exception.

   Needs Node 22+, Python 3 and Firefox (FIREFOX=/path/to/firefox to choose).
   FIREFOX_PROFILE_DIR=/some/folder if Firefox cannot use the system temp
   folder (the snap package cannot). SHOTS=/some/folder saves screenshots. */
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {createServer as createTcp} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openBackup} from '../tools/open-backup.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'firefox check password';
const PATTERN = [0, 3, 6, 7, 8];
const cleanups = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => console.log('  ' + msg);
function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg); }

const freePort = () => new Promise((resolve, reject) => {
  const s = createTcp();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); });
});

function findFirefox() {
  for (const name of [process.env.FIREFOX, 'firefox', 'firefox-esr'].filter(Boolean)) {
    const found = spawnSync('sh', ['-c', 'command -v "$0"', name], {encoding: 'utf8'}).stdout.trim();
    if (found) return found;
  }
  throw new Error('No Firefox found. Set FIREFOX=/path/to/firefox.');
}

class Firefox {
  static async launch() {
    const base = process.env.FIREFOX_PROFILE_DIR || tmpdir();
    mkdirSync(base, {recursive: true});
    const profile = mkdtempSync(path.join(base, 'lifeos-firefox-'));
    /* Downloads go to a set folder without a question, as in a profile that is kept for Life OS only. */
    const downloads = path.join(profile, 'downloads');
    mkdirSync(downloads);
    writeFileSync(path.join(profile, 'user.js'), [
      'user_pref("browser.download.dir", ' + JSON.stringify(downloads) + ');',
      'user_pref("browser.download.folderList", 2);',
      'user_pref("browser.download.useDownloadDir", true);',
      'user_pref("browser.download.alwaysOpenPanel", false);',
    ].join('\n') + '\n');
    const port = await freePort();
    const proc = spawn(findFirefox(), ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(port), 'about:blank'],
      {stdio: ['ignore', 'ignore', 'pipe']});
    cleanups.push(() => { proc.kill('SIGKILL'); try { rmSync(profile, {recursive: true, force: true}); } catch (e) {} });
    await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('Firefox did not start: ' + buf.slice(-400))), 40000);
      proc.stderr.on('data', chunk => { buf += chunk; if (/WebDriver BiDi listening on/.test(buf)) { clearTimeout(timer); resolve(); } });
      proc.on('exit', code => reject(new Error('Firefox exited early (' + code + '): ' + buf.slice(-400))));
    });
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/session');
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('BiDi socket failed')); });
    const ff = new Firefox(ws);
    ff.downloads = downloads;
    await ff.send('session.new', {capabilities: {}});
    await ff.send('session.subscribe', {events: ['log.entryAdded']});
    ff.context = (await ff.send('browsingContext.getTree', {})).contexts[0].context;
    await ff.send('browsingContext.setViewport', {context: ff.context, viewport: {width: 412, height: 915}});
    return ff;
  }

  constructor(ws) {
    this.ws = ws; this.next = 1; this.waiting = new Map(); this.problems = [];
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const w = this.waiting.get(msg.id); this.waiting.delete(msg.id);
        if (w) msg.type === 'error' ? w.reject(new Error(w.method + ': ' + msg.message)) : w.resolve(msg.result);
      } else if (msg.method === 'log.entryAdded' && msg.params.level === 'error') {
        this.problems.push(msg.params.type + ': ' + msg.params.text);
      }
    };
  }

  send(method, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => { this.waiting.set(id, {resolve, reject, method}); this.ws.send(JSON.stringify({id, method, params})); });
  }

  async eval(expression) {
    const r = await this.send('script.evaluate', {expression, target: {context: this.context}, awaitPromise: true, serializationOptions: {maxObjectDepth: 4}});
    if (r.type === 'exception') throw new Error('eval failed: ' + r.exceptionDetails.text + '\n    in: ' + expression.slice(0, 160));
    const v = r.result;
    const plain = x => x.type === 'object' ? Object.fromEntries(x.value.map(([k, val]) => [k, plain(val)])) : x.type === 'array' ? x.value.map(plain) : x.value;
    return plain(v);
  }

  async wait(expression, what, timeout = 12000) {
    const end = Date.now() + timeout;
    for (;;) {
      if (await this.eval('Promise.resolve(' + expression + ').then(v=>!!v)')) return;
      if (Date.now() > end) throw new Error('Timed out waiting for ' + (what || expression) + '\n    problems: ' + JSON.stringify(this.problems));
      await sleep(80);
    }
  }

  async goto(url) { await this.send('browsingContext.navigate', {context: this.context, url, wait: 'complete'}); }
  async reload() { await this.send('browsingContext.reload', {context: this.context, wait: 'complete'}); }

  check(label, allowed = []) {
    const bad = this.problems.filter(t => !allowed.some(a => t.includes(a)));
    this.problems = [];
    if (bad.length) throw new Error(label + ': Firefox reported problems:\n    ' + bad.join('\n    '));
    log('ok  ' + label);
  }

  async rect(selector) {
    await this.wait(`document.querySelector(${JSON.stringify(selector)})`, selector);
    return this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()`);
  }

  /* A real pointer gesture: touch or mouse, press at the first point, move through the rest, release. */
  async gesture(points, pointerType) {
    const actions = [{type: 'pointerMove', x: Math.round(points[0].x), y: Math.round(points[0].y)}, {type: 'pointerDown', button: 0}];
    for (const p of points.slice(1)) actions.push({type: 'pointerMove', x: Math.round(p.x), y: Math.round(p.y), duration: 90});
    actions.push({type: 'pointerUp', button: 0});
    await this.send('input.performActions', {context: this.context, actions: [{type: 'pointer', id: pointerType + '1', parameters: {pointerType}, actions}]});
    await this.send('input.releaseActions', {context: this.context});
  }

  async tap(selector, pointerType = 'touch') {
    const r = await this.rect(selector);
    await this.gesture([{x: r.left + r.width / 2, y: r.top + r.height / 2}], pointerType);
  }

  async draw(selector, seq, pointerType = 'touch') {
    const r = await this.rect(selector);
    await this.gesture(seq.map(i => ({x: r.left + (50 + 100 * (i % 3)) / 300 * r.width, y: r.top + (50 + 100 * Math.floor(i / 3)) / 300 * r.height})), pointerType);
  }

  /* Typing: focus the field and send real key presses. */
  async type(selector, text) {
    await this.tap(selector);
    await this.wait(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`, 'focus on ' + selector);
    const actions = [];
    for (const ch of text) actions.push({type: 'keyDown', value: ch}, {type: 'keyUp', value: ch});
    await this.send('input.performActions', {context: this.context, actions: [{type: 'key', id: 'keys', actions}]});
    await this.send('input.releaseActions', {context: this.context});
  }

  async shot(name) {
    if (!process.env.SHOTS) return;
    mkdirSync(process.env.SHOTS, {recursive: true});
    await sleep(300);
    const {data} = await this.send('browsingContext.captureScreenshot', {context: this.context});
    writeFileSync(path.join(process.env.SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  }

  ready() { return this.wait(`!document.getElementById('gate').classList.contains('show')&&/\\b(ok|warn)\\b/.test(document.getElementById('status').className)&&document.getElementById('nav').children.length>0`, 'the app to be open'); }
  gate(selector) { return this.wait(`document.querySelector('#gate.show ${selector}')`, 'gate ' + selector); }
}

async function startLifeOS() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'lifeos-ff-data-'));
  const port = await freePort();
  const proc = spawn('python3', ['-m', 'lifeos'], {cwd: path.join(ROOT, 'server'),
    env: {...process.env, LIFEOS_DATA: dataDir, LIFEOS_PORT: String(port), PYTHONDONTWRITEBYTECODE: '1'}, stdio: 'ignore'});
  cleanups.push(() => { proc.kill('SIGTERM'); try { rmSync(dataDir, {recursive: true, force: true}); } catch (e) {} });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return base; } catch (e) {}
    await sleep(100);
  }
  throw new Error('The Life OS server did not start');
}

async function startStatic() {
  const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'};
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/life-os\//, '')) || 'index.html';
    const file = path.join(ROOT, 'app', rel);
    if (rel.includes('..') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream'});
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => server.close());
  return 'http://127.0.0.1:' + server.address().port + '/life-os/';
}

let failed = false;
try {
  const ff = await Firefox.launch();
  log('Firefox ' + (await ff.eval(`navigator.userAgent.match(/Firefox\\/[\\d.]+/)[0]`)));

  console.log('Server mode');
  const base = await startLifeOS();
  await ff.goto(base + '/');
  await ff.gate('form[data-gate="setup"]');
  await ff.type('#gate [data-g="pw"]', PASSWORD);
  await ff.type('#gate [data-g="pw2"]', PASSWORD);
  await ff.tap('#gate [data-action="gate-pat-open"]');
  await ff.draw('#gate .pgrid', PATTERN);
  await ff.wait(`/again/.test(document.getElementById('gate').textContent)`, 'the prompt to repeat the pattern');
  await ff.draw('#gate .pgrid', PATTERN);
  await ff.wait(`/Pattern ready/.test(document.getElementById('gate').textContent)`, 'the pattern to be accepted');
  assert(await ff.eval(`document.querySelector('#gate [data-g="pw"]').value`) === PASSWORD, 'typed password is kept');
  await ff.shot('firefox-1-setup');
  await ff.tap('#gate button[type="submit"]');
  await ff.ready();
  assert(await ff.eval(`document.fonts.check('20px "Material Symbols Outlined"')&&document.documentElement.classList.contains('ico')`), 'icon font loaded');
  ff.check('set a password and a pattern by touch');

  /* phone layout: a day opens as a sheet; rate it and write a line */
  const today = await ff.eval(`(()=>{const d=new Date();if(d.getHours()<4)d.setDate(d.getDate()-1);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})()`);
  await ff.tap('.mblock .cell.today');
  await ff.wait(`document.querySelector('#sheet .editor')`, 'the day sheet');
  await ff.tap('#sheet .rb[data-n="4"]');
  await ff.type('#sheet textarea[data-field="recap"]', 'Written in Firefox');
  await sleep(900);
  await ff.wait(`document.getElementById('status').classList.contains('ok')`, 'status "Saved"');
  const stored = await ff.eval(`fetch('api/data',{cache:'no-store'}).then(r=>r.json()).then(d=>d.days[${JSON.stringify(today)}])`);
  assert(stored && stored.rating === 4 && stored.recap === 'Written in Firefox', 'the entry reached the server: ' + JSON.stringify(stored));
  await ff.shot('firefox-2-day');
  ff.check('rate a day and write a recap');

  /* lock, then unlock by drawing the pattern with a finger */
  await ff.eval(`fetch('api/auth/lock',{method:'POST',headers:{'X-LifeOS':'1'}}).then(r=>r.status)`);
  await ff.reload();
  await ff.gate('.pgrid[data-pat="unlock"]');
  assert(await ff.eval(`document.getElementById('app').innerHTML===''`), 'nothing is rendered while locked');
  await ff.shot('firefox-3-locked');
  await ff.draw('#gate .pgrid', [2, 1, 0, 3]);
  await ff.wait(`/Wrong pattern\\. 4 tries left/.test(document.getElementById('gmsg').textContent)`, 'the wrong-pattern message');
  await sleep(750);
  await ff.draw('#gate .pgrid', PATTERN);
  await ff.ready();
  await ff.wait(`document.querySelector('.mblock .cell.today.rated')`, 'the rated day after unlocking');
  ff.check('lock, wrong pattern, unlock by touch', ['403']);

  for (const view of ['review', 'tasks', 'settings']) {
    await ff.eval(`location.hash='#${view}'`);
    await ff.wait(`document.getElementById('app').children.length>0`, view);
  }
  await ff.wait(`[...document.querySelectorAll('.sec h2')].some(h=>h.textContent==='Security')`, 'the Security section');
  await ff.shot('firefox-4-settings');
  ff.check('review, tasks and settings');

  /* encrypted backup: sealed by Firefox, saved without a question, opened outside the browser */
  await ff.eval(`document.querySelector('.schema details').open=true`);
  await ff.tap('[data-action="backup-open"]');
  await ff.type('#sheet [data-sk="pw"]', PASSWORD);
  await ff.tap('[data-action="backup-go"]');
  let backup = null;
  for (let i = 0; i < 150 && !backup; i++) {
    backup = readdirSync(ff.downloads).find(f => /^life-os-backup-\d{4}-\d\d-\d\d-\d{4}\.json$/.test(f)) || null;
    if (!backup) await sleep(100);
  }
  assert(backup, 'no backup file in the download folder: ' + JSON.stringify(readdirSync(ff.downloads)));
  await sleep(300);
  const envelope = JSON.parse(readFileSync(path.join(ff.downloads, backup), 'utf8'));
  const inside = JSON.parse(openBackup(envelope, PASSWORD));
  assert(Object.keys(inside).length === 11 && Object.values(inside.days).some(d => d.recap === 'Written in Firefox'), 'the backup holds the data');
  let opened = true;
  try { openBackup(envelope, 'not the password'); } catch (e) { opened = false; }
  assert(!opened, 'a wrong password must not open the backup');
  ff.check('encrypted backup lands in the download folder and opens with the password');

  console.log('Demo mode');
  await ff.goto(await startStatic());
  await ff.ready();
  assert(await ff.eval(`document.querySelectorAll('.mblock .cell.rated:not(.out)').length`) >= 40, 'the demo calendar is filled');
  await ff.shot('firefox-5-demo');
  for (const view of ['review', 'tasks', 'settings', 'calendar']) {
    await ff.eval(`location.hash='#${view}'`);
    await ff.wait(`document.getElementById('app').children.length>0`, view);
  }
  ff.check('demo opens and every view renders');
  console.log('Firefox check passed.');
} catch (err) {
  failed = true;
  console.error('\nFirefox check FAILED\n  ' + (err && err.message || err));
} finally {
  for (const fn of cleanups.reverse()) { try { fn(); } catch (e) {} }
}
process.exit(failed ? 1 : 0);
