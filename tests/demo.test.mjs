// Tests for app/demo.js, the demo-data generator.
// Run from the repository root with
//   node --test                      (any current Node; finds tests/*.test.mjs by itself)
//   node --test tests/               (Node 20; newer versions read the argument as a glob,
//                                     so there it is  node --test "tests/*.test.mjs")
//
// Nothing from the app is re-implemented here. The date helpers, periodOf, docId, slug,
// the icon list, the schema and the defaults are cut out of app/index.html and evaluated,
// so the demo data is always checked against the app's own rules.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
const demoSrc = fs.readFileSync(path.join(ROOT, 'app', 'demo.js'), 'utf8');

/* ---------- the app's own helpers, straight from index.html ---------- */
function extractApp() {
  const lines = html.split(/\r?\n/);
  const find = (start, from = 0) => {
    const i = lines.findIndex((l, k) => k >= from && l.startsWith(start));
    assert.ok(i >= 0, `app/index.html has no line starting with "${start}"`);
    return i;
  };
  const a = find('const DAYS=['), b = find('function periodOf(', a);            // date helpers ... periodOf
  const s0 = find('const SCHEMA={'), s1 = find('};', s0);                        // the eleven collections
  const single = ['const slug=', 'const ICONS=', 'const DEFAULT_TYPES=', 'const DEFAULT_AREAS=', 'const FONTS=', 'const PRESETS=',
    'const STATUS=', 'const PRIO=', 'function docId('].map(s => lines[find(s)]);
  const names = 'toISO addDays dow weekStart addMonths isoWeek range periodOf slug ICONS DEFAULT_TYPES DEFAULT_AREAS FONTS PRESETS STATUS PRIO SCHEMA docId';
  const src = [...lines.slice(a, b + 1), ...single, ...lines.slice(s0, s1 + 1), `({${names.split(' ').join(',')}})`].join('\n');
  return vm.runInContext(src, vm.createContext({}), { filename: 'app/index.html (extract)' });
}
const app = extractApp();
const { addDays, range } = app;

// Objects made inside a vm context have foreign prototypes; a JSON round trip makes them
// comparable with deepEqual (and proves the data survives export as JSON).
const plain = x => JSON.parse(JSON.stringify(x));
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };

// What the app passes in: its default sport types and areas, and the first preset as theme.
const { name: _presetName, ...preset } = plain(app.PRESETS[0]);
const DEFAULTS = freeze({ sportTypes: plain(app.DEFAULT_TYPES), areas: plain(app.DEFAULT_AREAS), theme: { ...preset, font: app.FONTS[0].name } });

/* ---------- demo.js, loaded as a plain script with the clock and the dice locked away ---------- */
function loadDemo() {
  const ctx = vm.createContext({});
  vm.runInContext(`
    Math.random = () => { throw new Error('demo.js called Math.random()'); };
    Date = class extends Date {
      constructor(...a) { if (!a.length) throw new Error('demo.js called new Date() without arguments'); super(...a); }
      static now() { throw new Error('demo.js called Date.now()'); }
    };`, ctx);
  vm.runInContext(demoSrc, ctx, { filename: 'app/demo.js' });
  assert.equal(typeof ctx.LifeOSDemo?.build, 'function', 'demo.js defines LifeOSDemo.build');
  return ctx.LifeOSDemo;
}
const demo = loadDemo();
const build = today => plain(demo.build(today, DEFAULTS));

/* ---------- small helpers ---------- */
const ID = /^[A-Za-z0-9_\-.~:@+]+$/;                 // the app's rule for importable ids (see importRows)
const ISO = /^\d{4}-\d\d-\d\d$/;
const COLLS = Object.keys(app.SCHEMA);
const rows = (data, c) => Object.values(data[c]);
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const endOfDay = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).getTime(); };
const localDate = ms => app.toISO(new Date(ms));
const names = list => list.map(x => x.name);
const MISSED = ['partly', 'dropped'], MARKED = ['done', 'partly', 'dropped'];
// Mondays of the calendar weeks that lie completely inside [from, to]
const fullWeeks = (from, to) => range(from, to).filter(iso => app.dow(iso) === 0 && addDays(iso, 6) <= to);

/* ---------- the checks; each takes {today, data, next}, next being the data one day later ---------- */

// 1. All eleven collections; every key is a valid id and the id the app would derive.
function checkCollections({ data }) {
  assert.equal(COLLS.length, 11);
  assert.deepEqual(Object.keys(data).sort(), [...COLLS].sort());
  for (const c of COLLS) {
    assert.ok(isObj(data[c]), `${c} is an object of {id: doc}`);
    assert.ok(Object.keys(data[c]).length > 0, `${c} has rows`);
    const known = Object.keys(app.SCHEMA[c].cols).concat(c === 'habits' ? ['archivedAt'] : []);
    for (const [id, doc] of Object.entries(data[c])) {
      assert.match(id, ID, `${c} id`);
      assert.equal(app.docId(c, doc), id, `${c}/${id} is keyed by the id the app derives`);
      for (const k of Object.keys(doc)) assert.ok(known.includes(k), `${c}/${id}: field "${k}" is in the app's schema`);
    }
  }
  for (const s of rows(data, 'sports')) assert.equal(s.id, 's_' + app.slug(s.name), 'sport ids follow addSport()');
  assert.deepEqual(Object.keys(data.settings), ['main']);
}

// 2. Sixty days of journal up to today, and nothing logged in the future.
function checkCoverage({ today, data }) {
  const first = addDays(today, -59), window = range(first, today);
  assert.equal(window.length, 60);
  assert.ok(data.days[today], 'today has an entry');
  assert.ok(data.days[first], 'today-59 has an entry');
  const written = window.filter(iso => data.days[iso]);
  assert.ok(written.length >= 50, `${written.length} of 60 days have an entry`);
  assert.ok(written.length < 60, 'a few days are left empty');
  for (const d of rows(data, 'days')) {
    assert.match(d.date, ISO);
    assert.ok(d.date >= first && d.date <= addDays(today, 14), `${d.date} lies in the window or the next two weeks`);
    if (d.rating !== undefined) assert.ok(Number.isInteger(d.rating) && d.rating >= 1 && d.rating <= 5, 'rating is 1..5');
    for (const k of ['focus', 'recap', 'highlight', 'lowlight', 'learnings', 'memory']) if (k in d) assert.ok(typeof d[k] === 'string' && d[k].trim(), `${d.date}.${k} is not empty`);
    if (d.date > today) assert.deepEqual(Object.keys(d).sort(), ['date', 'focus', 'updatedAt'], `${d.date}: a future day holds a focus and nothing else`);
  }
  for (const c of ['habit_log', 'activities', 'people_log']) {
    for (const r of rows(data, c)) assert.ok(r.date >= first && r.date <= today, `${c} ${r.date} lies inside the window`);
  }
  // it reads like a used journal
  const past = written.map(iso => data.days[iso]), count = k => past.filter(d => d[k]).length;
  assert.ok(count('rating') >= 40, 'most days are rated');
  assert.ok(count('recap') >= 40, 'most days have a recap');
  assert.ok(count('focus') >= 15, 'many days have a focus');
  for (const k of ['highlight', 'lowlight', 'learnings', 'memory']) assert.ok(count(k) >= 1, `some days have a ${k}`);
  assert.ok(count('core') >= 2 && count('core') <= 3, `${count('core')} core days`);
  assert.ok(new Set(past.map(d => d.rating).filter(Boolean)).size >= 3, 'ratings vary');
  assert.ok(data.days[today].focus, 'today has a focus');
  assert.ok(!data.days[today].recap, 'today is still in progress');
  assert.ok(new Set(rows(data, 'people_log').map(p => p.date)).size >= 15, 'people on a good share of days');
  for (const p of rows(data, 'people_log')) assert.ok(p.people.trim() && p.activity.trim());
}

// 3. Same input, same output; and yesterday's history is today's history.
function checkDeterminism({ today, data, next }) {
  assert.deepEqual(build(today), data, 'two calls with the same date agree');
  const first = addDays(today, -59), shared = range(addDays(first, 1), addDays(today, -1));   // in both windows and strictly before today
  for (const iso of shared) {
    // The one permitted difference: the oldest day of a window always has an entry, even on
    // a date that is otherwise one of the empty ones.
    if (iso === shared[0] && !data.days[iso]) { assert.ok(next.days[iso]); continue; }
    assert.deepEqual(next.days[iso], data.days[iso], `days[${iso}] is the same one day later`);
  }
  const inShared = r => r.date >= shared[0] && r.date < today;
  for (const c of ['activities', 'people_log']) assert.deepEqual(rows(next, c).filter(inShared), rows(data, c).filter(inShared), `${c} history is stable`);
  // habit history is stable too, for every habit that ran through all of those days in both
  // (the newer and the archived habit hang off the current week and move on Mondays)
  const throughout = d => id => d.habits[id].ranges.some(r => r.from <= shared[0] && (!r.to || r.to >= today));
  const steady = Object.keys(data.habits).filter(id => throughout(data)(id) && throughout(next)(id));
  const ticks = d => rows(d, 'habit_log').filter(r => inShared(r) && steady.includes(r.habitId));
  assert.ok(steady.length >= 4);
  assert.deepEqual(ticks(next), ticks(data), 'habit_log history is stable');
  for (const p of rows(data, 'periods')) if (p.closedAt && next.periods[p.id]) assert.deepEqual(next.periods[p.id], p, `closed review ${p.id} is stable`);
}

// 4. Every reference points at something that exists.
function checkReferences({ data }) {
  const usable = icon => app.ICONS.includes(icon);
  for (const l of rows(data, 'habit_log')) {
    const hb = data.habits[l.habitId];
    assert.ok(hb, `habit_log ${l.date}: habit ${l.habitId} exists`);
    assert.equal(l.done, true);
    assert.ok(hb.ranges.some(r => r.from <= l.date && (!r.to || l.date <= r.to)), `${l.habitId} was active on ${l.date}`);
  }
  const sportNames = names(rows(data, 'sports')), typeNames = names(DEFAULTS.sportTypes), areaNames = names(DEFAULTS.areas);
  assert.equal(new Set(sportNames).size, sportNames.length, 'sport names are unique');
  for (const a of rows(data, 'activities')) assert.ok(sportNames.includes(a.sport), `activity sport "${a.sport}" is defined`);
  for (const s of rows(data, 'sports')) {
    assert.ok(typeNames.includes(s.type), `sport type "${s.type}" is a default type`);
    assert.ok(s.icon === '' || usable(s.icon), `sport icon "${s.icon}" is in ICONS`);
  }
  for (const t of typeNames) assert.ok(rows(data, 'sports').some(s => s.type === t), `some sport has type ${t}`);
  for (const h of rows(data, 'habits')) assert.ok(usable(h.icon), `habit icon "${h.icon}" is in ICONS`);
  for (const x of [...data.settings.main.sportTypes, ...data.settings.main.areas]) assert.ok(usable(x.icon), `settings icon "${x.icon}" is in ICONS`);
  for (const t of rows(data, 'tasks')) assert.ok(t.area === '' || areaNames.includes(t.area), `task area "${t.area}" is a default area`);
}

// 5. Five to seven active habits and one archived one with a closed range.
function checkHabits({ today, data }) {
  const first = addDays(today, -59), habits = rows(data, 'habits'), ticks = rows(data, 'habit_log');
  const active = habits.filter(h => !h.archived), archived = habits.filter(h => h.archived);
  assert.ok(active.length >= 5 && active.length <= 7, `${active.length} active habits`);
  assert.equal(archived.length, 1, 'exactly one archived habit');
  assert.deepEqual(habits.map(h => h.order).sort((a, b) => a - b), habits.map((h, i) => i), 'order is 0..n-1');
  for (const h of habits) {
    assert.ok(h.name && /^#[0-9A-Fa-f]{6}$/.test(h.color), `${h.id} has a name and a hex colour`);
    assert.equal(typeof h.archived, 'boolean');
    assert.ok(Array.isArray(h.ranges) && h.ranges.length >= 1);
    for (const r of h.ranges) assert.ok(ISO.test(r.from) && (r.to === null || (ISO.test(r.to) && r.to >= r.from)), `${h.id} range`);
    assert.ok(ticks.some(l => l.habitId === h.id), `${h.id} was ticked at least once`);
  }
  for (const h of active) { assert.equal(h.ranges.at(-1).to, null, `${h.id} is still running`); assert.ok(!('archivedAt' in h)); }
  assert.ok(active.filter(h => h.ranges[0].from < first).length >= 4, 'most habits started before the window');
  assert.ok(active.some(h => h.ranges[0].from > first && h.ranges[0].from <= today), 'one habit is newer and starts inside the window');
  const [old] = archived, [span] = old.ranges;
  assert.equal(old.ranges.length, 1);
  assert.ok(span.to && span.from >= first && span.to < today, 'the archived habit has a closed range inside the window');
  assert.equal(old.archivedAt, span.to);
  // different adherence per habit
  const share = h => ticks.filter(l => l.habitId === h.id).length / range(h.ranges[0].from < first ? first : h.ranges[0].from, today).length;
  const shares = active.map(share);
  assert.ok(Math.max(...shares) - Math.min(...shares) >= 0.15, 'habits differ in how well they are kept');
  assert.ok(Math.max(...shares) < 1, 'no habit is perfect');
}

// 6. Three to five sport sessions in every full calendar week of the window.
function checkSport({ today, data }) {
  const weeks = fullWeeks(addDays(today, -59), today), acts = rows(data, 'activities');
  assert.ok(weeks.length >= 7);
  for (const ws of weeks) {
    const n = acts.filter(a => a.date >= ws && a.date <= addDays(ws, 6)).length;
    assert.ok(n >= 3 && n <= 5, `week of ${ws} has ${n} sessions`);
  }
  for (const a of acts) assert.ok(typeof a.note === 'string' && a.note.trim(), 'every session has a note');
  assert.ok(new Set(acts.map(a => a.sport)).size >= 4, 'several different sports were done');
}

// 7. Tasks in every status, priority and area, planned on both sides of today.
function checkTasks({ today, data }) {
  const tasks = rows(data, 'tasks'), has = (k, v) => tasks.some(t => t[k] === v);
  assert.ok(tasks.length >= 25 && tasks.length <= 35, `${tasks.length} tasks`);
  for (const s of Object.keys(app.STATUS)) assert.ok(has('status', s), `a task with status ${s}`);
  for (const p of Object.keys(app.PRIO)) assert.ok(has('priority', p), `a task with priority ${p}`);
  for (const a of names(DEFAULTS.areas)) assert.ok(has('area', a), `a task in area ${a}`);
  assert.ok(tasks.filter(t => t.area === '').length >= 2, 'a couple of tasks without an area');
  for (const t of tasks) {
    assert.ok(t.title.trim() && typeof t.description === 'string');
    assert.ok(t.status in app.STATUS && t.priority in app.PRIO);
    assert.ok(t.plannedFor === null || ISO.test(t.plannedFor));
    if (t.status === 'done') assert.ok(ISO.test(t.doneOn) && t.doneOn <= today && localDate(t.createdAt) <= t.doneOn, `${t.id} was done on or before today`);
    else assert.equal(t.doneOn, null, `${t.id} is open and has no done date`);
    assert.ok(Array.isArray(t.subtasks));
    for (const s of t.subtasks) assert.ok(s.id && s.title.trim() && typeof s.done === 'boolean');
    if (t.status === 'done') assert.ok(t.subtasks.every(s => s.done));
  }
  const planned = tasks.filter(t => t.plannedFor);
  assert.ok(planned.some(t => t.plannedFor < today), 'tasks planned before today');
  assert.ok(planned.filter(t => t.plannedFor < today && t.status !== 'done').length >= 2, 'overdue open tasks');
  assert.ok(planned.filter(t => t.plannedFor > today && t.plannedFor <= addDays(today, 14)).length >= 3, 'tasks planned in the next 14 days');
  assert.ok(tasks.filter(t => !t.plannedFor).length >= 2, 'a few unplanned tasks');
  assert.ok(tasks.some(t => t.description), 'some tasks have a description');
  const withSubs = tasks.filter(t => t.subtasks.length);
  assert.ok(withSubs.length >= 2, 'at least two tasks have subtasks');
  assert.ok(withSubs.some(t => t.subtasks.some(s => s.done) && t.subtasks.some(s => !s.done)), 'one is partly ticked off');
}

// 8. Reviews: past weeks closed, this week open, last month closed, this month open.
function checkPeriods({ today, data }) {
  const first = addDays(today, -59), periods = data.periods;
  const thisWeek = app.periodOf('week', today), thisMonth = app.periodOf('month', today), lastMonth = app.periodOf('month', app.addMonths(today, -1));
  for (const [id, p] of Object.entries(periods)) {
    const ref = app.periodOf(p.kind, p.start);
    assert.ok(p.kind === 'week' || p.kind === 'month');
    assert.equal(id, ref.id, 'period ids come from periodOf()');
    assert.equal(p.start, ref.start);
    assert.equal(p.end, ref.end);
    assert.ok(Array.isArray(p.intentions));
    for (const it of p.intentions) {
      assert.ok(it.id && it.text.trim() && typeof it.why === 'string');
      assert.ok(p.closedAt ? MARKED.includes(it.status) : it.status === 'open', `${id}: "${it.text}" is ${it.status}`);
      if (MISSED.includes(it.status)) assert.ok(it.why.trim(), `${id}: a missed intention says why`);
      if ('carried' in it) assert.equal(it.carried, true);
    }
    assert.equal(new Set(p.intentions.map(it => it.id)).size, p.intentions.length);
    for (const k of ['worked', 'didnt', 'why', 'change', 'plan', 'review']) assert.equal(typeof p[k], 'string');
  }
  const concluded = p => ['worked', 'didnt', 'why', 'change'].every(k => p[k].trim());
  // every full week that lies inside today-59 .. today-1 and ends before this week
  const pastWeeks = fullWeeks(first, addDays(today, -1)).filter(ws => addDays(ws, 6) < thisWeek.start);
  assert.ok(pastWeeks.length >= 7, `${pastWeeks.length} full past weeks`);
  for (const ws of pastWeeks) {
    const ref = app.periodOf('week', ws), p = periods[ref.id];
    assert.ok(p, `${ref.id} exists`);
    assert.equal(p.start, ws);
    assert.equal(p.end, addDays(ws, 6));
    assert.ok(Number.isFinite(p.closedAt), `${ref.id} is closed`);
    assert.ok(localDate(p.closedAt) >= p.end, `${ref.id} was closed once it was over`);
    assert.ok(concluded(p), `${ref.id} has conclusions`);
    assert.ok(p.intentions.length >= 2, `${ref.id} has intentions`);
  }
  assert.ok(pastWeeks.some(ws => periods[app.periodOf('week', ws).id].intentions.some(it => MISSED.includes(it.status))), 'some intention was missed, with a reason');
  const cur = periods[thisWeek.id];
  assert.ok(cur, 'the current week has a period');
  assert.equal(cur.closedAt, null);
  assert.ok(cur.intentions.length >= 2 && cur.intentions.every(it => it.status === 'open'), 'the current week has open intentions');
  const next = periods[app.periodOf('week', addDays(today, 7)).id];
  assert.ok(next && next.closedAt === null && (next.plan.trim() || next.intentions.length > 0), 'next week is pencilled in');
  const lm = periods[lastMonth.id], tm = periods[thisMonth.id];
  assert.ok(lm && Number.isFinite(lm.closedAt) && concluded(lm) && lm.intentions.length >= 2, 'last month is closed, with conclusions');
  assert.ok(tm && tm.closedAt === null, 'this month is open');
  assert.ok(tm.intentions.length >= 2 && tm.intentions.length <= 3 && tm.intentions.every(it => it.status === 'open'), 'this month has 2-3 focus intentions');
}

// 9. Settings are the defaults passed in; no timestamp lies in the future.
function checkSettingsAndTime({ today, data }) {
  assert.deepEqual(data.settings.main, plain(DEFAULTS));
  const latest = endOfDay(today), earliest = endOfDay(addDays(today, -500));
  let seen = 0;
  const walk = (x, where) => {
    if (Array.isArray(x)) return x.forEach((v, i) => walk(v, `${where}[${i}]`));
    if (!isObj(x)) return;
    for (const [k, v] of Object.entries(x)) {
      if (['at', 'createdAt', 'updatedAt', 'closedAt'].includes(k) && v !== null) {
        assert.ok(Number.isFinite(v) && Number.isInteger(v), `${where}.${k} is a ms timestamp`);
        assert.ok(v <= latest, `${where}.${k} is not later than the end of today`);
        assert.ok(v > earliest, `${where}.${k} is plausible`);
        seen++;
      } else walk(v, `${where}.${k}`);
    }
  };
  walk(data, 'data');
  assert.ok(seen > 200);
  for (const c of ['days', 'habits', 'sports', 'activities', 'people_log', 'tasks', 'periods']) {
    for (const r of rows(data, c)) assert.ok(Number.isFinite(r.createdAt ?? r.updatedAt), `${c} rows carry a timestamp`);
  }
  // things logged for a day were logged on that day
  for (const l of rows(data, 'habit_log')) assert.equal(localDate(l.at), l.date);
  for (const c of ['activities', 'people_log']) for (const r of rows(data, c)) assert.equal(localDate(r.createdAt), r.date);
  for (const d of rows(data, 'days')) assert.ok(localDate(d.updatedAt) <= d.date);
}

// 10. No emoji: nothing outside the Basic Multilingual Plane, nothing from U+2600..U+27BF.
const EMOJI = /[\u{10000}-\u{10FFFF}☀-➿️\uD800-\uDFFF]/u;
function checkNoEmoji({ data }) {
  const hit = EMOJI.exec(JSON.stringify(data));
  assert.equal(hit, null, hit ? `no emoji (found U+${hit[0].codePointAt(0).toString(16).toUpperCase()})` : '');
}

// 11. The plan: every item belongs to a week, what is ticked links to the row that was logged,
//     every change points at an item, and the weeks up to this one have a committed plan.
function checkPlan({ today, data }) {
  const KINDS = ['sport', 'people', 'task', 'event', 'routine'], PARTS = ['m', 'a', 'e', null], thisWeek = app.periodOf('week', today);
  const kinds = new Set();
  for (const r of rows(data, 'plan')) {
    assert.ok(KINDS.includes(r.kind) && ['planned', 'done', 'skipped'].includes(r.status) && PARTS.includes(r.part), `${r.id}: kind, status and part`);
    assert.ok(r.title.trim() && Number.isFinite(r.order));
    assert.equal(app.dow(r.week), 0, `${r.id}: week is a Monday`);
    if (r.date !== null) assert.equal(app.weekStart(r.date), r.week, `${r.id}: its day lies in its week`);
    if (r.time !== null) assert.match(r.time, /^\d\d:\d\d$/);
    if (r.kind === 'task') assert.ok(data.tasks[r.ref] && data.tasks[r.ref].plannedFor === r.date, `${r.id}: its task is planned for the same day`);
    else assert.equal(r.ref, null);
    if (r.link !== null) {
      const log = r.kind === 'sport' ? data.activities[r.link] : data.people_log[r.link];
      assert.ok(log && log.date === r.date && r.status === 'done', `${r.id}: linked to what was logged that day`);
      if (r.kind === 'sport') assert.equal(log.sport, r.title);
    }
    if (r.kind === 'sport') assert.ok(names(rows(data, 'sports')).includes(r.title), `${r.id}: "${r.title}" is a sport`);
    if (r.date !== null && r.date > today) assert.equal(r.status, 'planned', `${r.id}: nothing ahead is ticked`);
    kinds.add(r.kind);
  }
  assert.deepEqual([...kinds].sort(), [...KINDS].sort(), 'every kind of item is there');
  assert.ok(rows(data, 'plan').some(r => r.date === null), 'something floats in its week');
  assert.ok(rows(data, 'plan').some(r => r.date > today), 'something is planned ahead');
  const links = rows(data, 'plan').map(r => r.link).filter(Boolean);
  assert.equal(new Set(links).size, links.length, 'a logged row belongs to one item');
  for (const l of rows(data, 'plan_log')) {
    const r = data.plan[l.planId];
    assert.ok(r, `${l.id}: its item exists`);
    assert.ok(['place', 'move', 'skip', 'restore'].includes(l.kind) && ['ahead', 'day', 'after'].includes(l.timing) && typeof l.reason === 'string');
    if (l.kind === 'move') assert.ok(l.from.date !== l.to.date && r.date === l.to.date, `${l.id}: the item sits where it was moved to`);
    if (l.kind === 'skip') assert.equal(r.status, 'skipped');
    if (l.kind === 'move' || l.kind === 'skip') assert.ok(l.reason.trim(), `${l.id}: says why`);
  }
  assert.ok(rows(data, 'plan_log').some(l => l.kind === 'move') || rows(data, 'plan_log').some(l => l.kind === 'skip'));
  for (const p of rows(data, 'periods')) {
    if (p.kind !== 'week') continue;
    if (p.start > thisWeek.start) { assert.ok(!('planAt' in p), `${p.id}: a week ahead has no committed plan yet`); continue; }
    assert.ok(Number.isFinite(p.planAt) && localDate(p.planAt) <= p.start, `${p.id}: its plan was committed before it began`);
    assert.ok(Array.isArray(p.planBase) && p.planBase.length >= 1, `${p.id}: the committed plan has items`);
    for (const q of p.planBase) {
      assert.ok(q.ref ? data.tasks[q.ref] : data.plan[q.id], `${p.id}: ${q.id} of the committed plan exists`);
      assert.ok(q.date === null || (q.date >= p.start && q.date <= p.end));
    }
  }
}

const CHECKS = [
  ['1. eleven collections, keyed by the ids the app derives', checkCollections],
  ['2. sixty days of journal, nothing logged in the future', checkCoverage],
  ['3. deterministic, and history is stable from one day to the next', checkDeterminism],
  ['4. references and icons resolve', checkReferences],
  ['5. habits: five to seven active, one archived', checkHabits],
  ['6. sport: three to five sessions in every full week', checkSport],
  ['7. tasks cover statuses, priorities, areas and dates', checkTasks],
  ['8. reviews: past weeks closed, this week open, last month closed', checkPeriods],
  ['9. settings are the defaults; no timestamp after today', checkSettingsAndTime],
  ['10. no emoji', checkNoEmoji],
  ['11. the plan: items, links, changes and committed weeks', checkPlan]
];

/* ---------- the tests ---------- */
const DATES = {
  '2026-01-01': 'year boundary; ISO week 1 of 2026 starts on 2025-12-29',
  '2024-03-01': 'leap year; the window includes 29 February',
  '2025-06-18': 'an ordinary Wednesday'
};

test('the helpers cut out of index.html are the real ones', () => {
  assert.equal(app.periodOf('week', '2026-01-01').id, 'week_2026-W01');
  assert.equal(app.periodOf('week', '2026-01-01').start, '2025-12-29');
  assert.equal(app.periodOf('month', '2024-02-10').end, '2024-02-29');
  assert.equal(app.dow('2025-06-16'), 0, 'Monday is day 0');
  assert.equal(app.docId('habit_log', { date: '2025-06-18', habitId: 'h_x' }), '2025-06-18_h_x');
  assert.ok(html.includes('/' + ID.source + '/'), 'the id rule used here is the one in importRows()');
  assert.deepEqual(Object.keys(DEFAULTS.theme).sort(), ['accent', 'bg', 'font', 'ink', 'surface']);
});

for (const [today, why] of Object.entries(DATES)) {
  test(`demo data for today = ${today} (${why})`, async t => {
    const ctx = { today, data: build(today), next: build(addDays(today, 1)) };
    assert.deepEqual(plain(loadDemo().build(today, DEFAULTS)), ctx.data, 'a freshly loaded copy of demo.js gives the same data');
    if (today === '2026-01-01') assert.ok(ctx.data.periods['week_2026-W01'] && ctx.data.periods['week_2025-W52'] && ctx.data.periods['month_2025-12']);
    if (today === '2024-03-01') assert.ok(range(addDays(today, -59), today).includes('2024-02-29') && ctx.data.periods['month_2024-02'].end === '2024-02-29');
    for (const [name, check] of CHECKS) await t.test(name, () => check(ctx));
  });
}

// Fourteen months by default, so every weekday, month length and year change is met.
// For a longer run:  DEMO_SWEEP=2020-01-01:2031-12-31 node --test
const [sweepFrom, sweepTo] = (process.env.DEMO_SWEEP || '2023-12-20:2025-02-20').split(':');
test(`every check holds on each day from ${sweepFrom} to ${sweepTo}`, () => {
  let data = build(sweepFrom);
  for (const today of range(sweepFrom, sweepTo)) {
    const ctx = { today, data, next: build(addDays(today, 1)) };
    for (const [name, check] of CHECKS) {
      try { check(ctx); } catch (e) { throw new Error(`today = ${today}, check ${name}: ${e.message}`, { cause: e }); }
    }
    data = ctx.next;
  }
});

test('the generator keeps to its contract', () => {
  // a pure script: no clock, no unseeded randomness, no network, no modules
  for (const banned of [/Math\.random/, /Date\.now/, /new Date\(\s*\)/, /\bfetch\(/, /XMLHttpRequest/, /\brequire\(/, /^\s*(import|export)\s/m]) {
    assert.ok(!banned.test(demoSrc), `demo.js does not use ${banned}`);
  }
  for (const ch of demoSrc) assert.ok(ch.codePointAt(0) < 0x2600, 'demo.js contains no emoji or symbols');
  // in a browser it hangs itself on window
  const win = {};
  vm.runInContext(demoSrc, vm.createContext({ window: win }));
  assert.equal(typeof win.LifeOSDemo.build, 'function');
  // the defaults are copied, not kept and not changed (DEFAULTS is frozen)
  const data = demo.build('2025-06-18', DEFAULTS);
  assert.notEqual(data.settings.main.theme, DEFAULTS.theme);
  assert.throws(() => demo.build('18.06.2025', DEFAULTS), /YYYY-MM-DD/);
  // names and colours are picked from whatever defaults come in, not from a built-in list
  const other = plain(demo.build('2025-06-18', {
    sportTypes: [{ name: 'Outdoors', color: '#112233', icon: 'hiking' }, { name: 'Indoors', color: '#445566', icon: 'fitness_center' }],
    areas: [{ name: 'Home', color: '#778899', icon: 'home' }, { name: 'Job', color: '#AABBCC', icon: 'work' }],
    theme: { bg: '#000000', surface: '#111111', ink: '#EEEEEE', accent: '#FF8800', font: 'Inter' }
  }));
  for (const s of rows(other, 'sports')) assert.ok(['Outdoors', 'Indoors'].includes(s.type));
  for (const t of rows(other, 'tasks')) assert.ok(['', 'Home', 'Job'].includes(t.area));
  for (const a of ['Home', 'Job']) assert.ok(rows(other, 'tasks').some(t => t.area === a));
  for (const h of rows(other, 'habits')) assert.ok(['#112233', '#445566', '#778899', '#AABBCC'].includes(h.color));
});
