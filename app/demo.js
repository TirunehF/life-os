/*
 * Life OS demo data
 *
 * LifeOSDemo.build(today, defaults) returns a complete, made-up dataset in the app's
 * export shape: {collection: {id: doc}} for all eleven collections.
 *
 *   today     'YYYY-MM-DD', the app's own idea of today
 *   defaults  {sportTypes, areas, theme}; copied into settings.main as they are
 *
 * Pure: the result depends only on the arguments (and on the local time zone, which
 * turns calendar days into ms timestamps). It never reads the clock and never rolls
 * unseeded dice. Whatever happens on a calendar day (journal, habits, sport, people,
 * the review of its week, what that week planned) is a function of that date alone, so
 * history stays put while the 60-day window slides forward. Tasks and the two short habit
 * ranges hang off the current week instead and move once a week, and so do the planned
 * tasks, the event and the chores of this week and the next.
 *
 * Every person and event in here is invented.
 */
(function(root){
  'use strict';
  const {floor, round, min, max, imul} = Math;

  /* ---------- calendar: day numbers (days since 1970-01-01) and ISO dates ---------- */
  const pad = n => String(n).padStart(2, '0');
  const dayNo = iso => { const p = iso.split('-').map(Number); return round(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5); };
  const isoOf = n => new Date(n * 864e5).toISOString().slice(0, 10);
  const yearOf = n => new Date(n * 864e5).getUTCFullYear();
  const dow = n => (n + 3) % 7;                                  // Monday = 0, like the app
  const monday = n => n - dow(n);
  const monthFirst = n => dayNo(isoOf(n).slice(0, 8) + '01');
  const weekId = m => { const th = m + 3, y = yearOf(th); return 'week_' + y + '-W' + pad(1 + floor((th - dayNo(y + '-01-01')) / 7)); };   // m is a Monday; ISO week of its Thursday
  // ms timestamp for a local wall-clock time on day n
  const at = (n, h, m) => { const d = new Date(n * 864e5); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m || 0).getTime(); };
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';   // the app's rule for sport ids

  /* ---------- seeded dice: every stream is named by a label and a number ---------- */
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
  const rnd = (tag, k) => {                                      // mulberry32
    let a = hash(tag + ':' + k);
    return () => { a = (a + 0x6D2B79F5) | 0; let t = imul(a ^ (a >>> 15), 1 | a); t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  };
  const one = (tag, k) => rnd(tag, k)();
  const shuffle = (list, r) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
  // smooth noise between 0 and 1 that changes slowly: stretches, not static
  const wave = (tag, n, span) => { const k = floor(n / span), f = n / span - k, a = one(tag, k), b = one(tag, k + 1); return a + (b - a) * f * f * (3 - 2 * f); };
  // Deal a pool out in order: day n gets the line whose number is "how many days since 1 January
  // did `used` hold", so nothing comes back before every other line has had its turn.
  // The counts are a function of tag and year only, which makes them safe to remember.
  const counts = {};
  const nth = (tag, n, used) => {
    const key = tag + yearOf(n), start = dayNo(yearOf(n) + '-01-01');
    if (!counts[key]) { const list = counts[key] = []; let k = hash(key) % 97; for (let i = 0; i < 366; i++) { list.push(k); if (used(start + i)) k++; } }
    return counts[key][n - start];
  };
  const deal = (pool, tag, n, used) => pool[nth(tag, n, used) % pool.length];

  /* ---------- the shape of a life: rough patches, days to keep, gaps, mood ---------- */
  // One rough patch of 4 to 6 days in every 37-day block; any 60 days contain one in full.
  const slump = n => {
    const b = floor((n + 22) / 37), r = rnd('slump', b), start = b * 37 - 16 + floor(r() * 10), len = 4 + floor(r() * 3), kind = floor(r() * 3);
    return n >= start && n < start + len ? {kind: kind, step: n - start === len - 1 ? 5 : n - start} : null;
  };
  // One core-memory day per 24-day block, always a Saturday, 21 or 28 days apart:
  // two or three in any 60 days. Gives the day's story (see CORE) or null.
  const coreOf = n => { const b = floor((n + 6) / 24), base = b * 24 + 1; return n === base + (12 - dow(base)) % 7 ? CORE[b * 5 % CORE.length] : null; };
  // One day per 12-day block on which nothing was written down at all.
  const isGap = n => n % 12 === floor(one('gap', floor(n / 12)) * 12) && !coreOf(n);
  const rating = n => {
    if (coreOf(n)) return 5;
    const low = slump(n), x = 2.2 + 1.9 * wave('swing', n, 5) + (dow(n) > 4 ? .4 : 0) + (one('rate', n) - .5) * 1.2;
    return low ? low.step === 5 ? 3 : x < 3.2 ? 1 : 2 : max(1, min(5, round(x)));   // a rough patch caps the day, whatever the mood
  };

  /* ---------- sport: a weekly plan, and notes that improve over a season ---------- */
  // name, preferred type, icon, season length in days, season offset (seasons are staggered)
  const SPORTS = [
    {name: 'Running', type: 'Endurance', icon: 'directions_run', len: 182, off: 117},
    {name: 'Cycling', type: 'Endurance', icon: 'directions_bike', len: 182, off: 77},
    {name: 'Gym', type: 'Strength', icon: 'fitness_center', len: 168, off: 3},
    {name: 'Bouldering', type: 'Mountain', icon: 'terrain', len: 196, off: 140},
    {name: 'Hiking', type: 'Mountain', icon: 'hiking', len: 210, off: 149},
    {name: 'Salsa', type: 'Dance', icon: 'music_note', len: 140, off: 34},
    {name: 'Swimming', type: 'Watersport', icon: 'pool', len: 154, off: 134},
    {name: 'Table tennis', type: 'Fun', icon: 'sports_tennis', len: 126, off: 114}
  ];
  const BY_DAY = [['Gym', 'Swimming'], ['Bouldering', 'Running'], ['Salsa'], ['Gym', 'Bouldering'], ['Swimming', 'Running'], ['Running', 'Hiking', 'Cycling'], ['Table tennis', 'Cycling', 'Hiking']];
  const GRADES = ['5A', '5B', '5C', '6A', '6A+', '6B', '6B+', '6C', '7A'];
  const STEPS = ['basic step and timing', 'right turn', 'cross-body lead', 'inside turn', 'footwork drills', 'spins', 'turn patterns', 'leading on a crowded floor'];
  const SCORES = ['Lost 0:3', 'Lost 1:3', 'Lost 2:3', 'Won 3:2', 'Won 3:1'];
  const half = x => round(x * 2) / 2;
  const mmss = s => floor(round(s) / 60) + ':' + pad(round(s) % 60);
  // p runs from 0 to 1 over a season, j is the day's own wobble
  const NOTE = {
    Running: (p, j, weekend) => weekend ? 'Long run: ' + half(9 + 8 * p) + ' km at ' + mmss(390 - 50 * p + 6 * j) + ' /km'
      : j < .3 ? round(5 + 3 * p) + ' x 400 m, ' + round(104 - 12 * p) + ' s each'
      : half(5 + 3 * p) + ' km easy, ' + mmss(372 - 50 * p + 8 * j) + ' /km',
    Cycling: (p, j) => round(30 + 30 * p + 6 * j) + ' km, ' + (22 + 4.5 * p + .6 * j).toFixed(1) + ' km/h on average',
    Gym: (p, j) => { const kg = 50 + 2.5 * round(12 * p); return j < .5 ? 'Squat 3x5 at ' + kg + ' kg, pull-ups 3x' + round(4 + 7 * p) : 'Deadlift 3x5 at ' + (kg + 25) + ' kg, bench 3x5 at ' + (kg - 10) + ' kg'; },
    Bouldering: (p, j) => { const g = floor(p * 7.99); return j < .35 ? 'Flashed a ' + GRADES[g] + ', worked the moves on a ' + GRADES[g + 1] : j < .7 ? round(9 + 5 * j) + ' problems, hardest a ' + GRADES[g] : 'Project day on a ' + GRADES[g + 1] + ', fell at the last hold'; },
    Hiking: (p, j) => round(10 + 8 * p + 2 * j) + ' km, ' + 50 * round(9 + 14 * p + 2 * j) + ' m of climbing',
    Salsa: (p, j, weekend, day) => 'Class ' + (1 + floor(day / 7)) + ': ' + STEPS[floor(p * STEPS.length)],
    Swimming: (p, j) => 100 * round(8 + 12 * p) + ' m, 100 m in ' + mmss(140 - 28 * p + 3 * j),
    'Table tennis': (p, j) => SCORES[max(0, min(4, floor(p * 5 + j * 1.6 - .8)))] + ' against Odo'
  };
  // m is a Monday; gives a sport name per weekday for 3 to 5 days. Rough days are avoided,
  // and a core day gets the sport its story needs, or none.
  const weekPlan = m => {
    const r = rnd('plan', m), week = [0, 1, 2, 3, 4, 5, 6], rough = week.filter(i => slump(m + i)).length, out = [];
    const days = week.map(i => { const c = coreOf(m + i); return {i: i, c: c, s: r() - (slump(m + i) ? 2 : 0) + (c ? c[5] ? 9 : -9 : 0)}; }).sort((a, b) => b.s - a.s);
    days.slice(0, rough > 2 ? 3 : 3 + floor(r() * 3)).forEach(d => {
      const opts = BY_DAY[d.i], v = r();                         // the first option half the time, the others share the rest
      out[d.i] = d.c ? d.c[5] : v < .5 || opts.length < 2 ? opts[0] : opts[1 + floor((v - .5) * 2 * (opts.length - 1))];
    });
    return out;
  };
  const session = n => {
    const name = weekPlan(monday(n))[dow(n)], core = coreOf(n);
    if (!name) return null;
    const sp = SPORTS.find(x => x.name === name), day = (n + sp.off) % sp.len, r = rnd('sport', n), weekend = dow(n) > 4;
    const note = core ? core[6] : NOTE[name](day / sp.len, r(), weekend, day) + (day < 8 && name !== 'Salsa' ? '. New block, starting easy' : '');
    return {sport: name, note: note, hour: weekend ? 10 : r() < .4 ? 7 : 18, min: floor(r() * 50)};
  };

  /* ---------- people ---------- */
  const PARTNER = {Bouldering: ['Wren', 'Bouldering', .6], Salsa: ['Tansy', 'Salsa class', .8], 'Table tennis': ['Odo', 'Table tennis', 1], Hiking: ['Wren, Juno', 'Hike', .7], Cycling: ['Juno', 'Bike ride', .4]};
  const MEET = [
    [['Juno', 'Lunch'], ['Pip', 'Dinner at home'], ['Bramble', 'Phone call'], ['Juno', 'Coffee after work'], ['Pip', 'Cooked together'], ['Odo', 'Quick drink'], ['Nim', 'Walk home'], ['Pip, Juno', 'Dinner']],
    [['Pip', 'Slow breakfast'], ['Pip, Juno', 'Board games'], ['Bramble', 'Brunch'], ['Odo, Tansy', 'Film night'], ['Pip', 'Flea market'], ['Wren', 'Walk by the river'], ['Juno, Quill', 'Cooking evening'], ['Bramble, Pip', 'Long lunch']]
  ];
  const meets = n => !isGap(n) && !coreOf(n) && one('meet', n) < (slump(n) ? .1 : dow(n) > 4 ? .6 : .3);
  const company = n => {
    const core = coreOf(n), w = dow(n) > 4 ? 1 : 0, s = session(n), pa = s && PARTNER[s.sport], out = [];
    if (core) return [[core[3], core[4]]];
    if (isGap(n)) return out;
    if (pa && one('partner', n) < pa[2]) out.push([pa[0], pa[1]]);
    if (dow(n) === 3 && !slump(n) && one('band', n) < .8) out.push(['Quill, Nim', 'Band rehearsal']);
    if (meets(n)) out.push(deal(MEET[w], 'meet' + w, n, x => meets(x) && (dow(x) > 4 ? 1 : 0) === w));
    return out;
  };

  /* ---------- habits ---------- */
  // hour: when it usually gets ticked; wd / we: share of workdays and weekend days it gets done;
  // dip: what a rough patch costs; hue: index into the colours found in the defaults.
  // span: [from, to] in days from this week's Monday (to: null = still running); no span = started long ago.
  const HABITS = [
    {id: 'h_up', name: 'Up by 7', icon: 'alarm', hour: 7, wd: .92, we: .35, dip: .45, hue: 5},
    {id: 'h_water', name: 'Two litres of water', icon: 'water_drop', hour: 20, wd: .88, we: .8, dip: .2, hue: 4},
    {id: 'h_read', name: 'Read 20 minutes', icon: 'menu_book', hour: 22, wd: .74, we: .8, dip: .35, hue: 6},
    {id: 'h_stretch', name: 'Stretch', icon: 'sports_gymnastics', hour: 7, wd: .66, we: .5, dip: .45, hue: 0},
    {id: 'h_piano', name: 'Piano practice', icon: 'piano', hour: 19, wd: .55, we: .68, dip: .45, hue: 7},
    {id: 'h_meditate', name: 'Meditate', icon: 'self_improvement', hour: 8, wd: .52, we: .4, dip: .35, hue: 3},
    {id: 'h_screens', name: 'Screens off by 22:00', icon: 'nightlight', hour: 22, wd: .66, we: .48, dip: .4, hue: 1, span: [-21, null]},
    {id: 'h_cold', name: 'Cold shower', icon: 'bolt', hour: 7, wd: .56, we: .36, dip: .4, hue: 2, span: [-49, -22]}
  ];
  // the slow wave pushes the odds up and down for days at a time: streaks and gaps
  const habitDone = (h, n) => !isGap(n) && one(h.id, n) < (dow(n) > 4 ? h.we : h.wd) + .45 * (2 * wave(h.id, n, 5) - 1) - (slump(n) ? h.dip : 0);

  /* ---------- journal ---------- */
  const FOCUS = [
    ['Finish the quarterly report', 'Draft the workshop outline', 'Clear the inbox', 'Slides for the workshop', 'Deep work: data clean-up', 'Phone calls and paperwork', 'One thing: the proposal', 'Leave on time', 'Review the budget', 'Write the first page', 'Tidy the import script', 'Prepare the interviews', 'Feedback round with Juno', 'Catch up on reading', 'Ship the small fix', 'Plan the next sprint', 'Rehearsal prep', 'Admin hour, then a focus block'],
    ['Rest', 'Long run, then nothing', 'Piano and a slow morning', 'Be outside', 'Tidy the flat', 'People, not screens', 'Cook for the week', 'Sleep in, then the market', 'No plans on purpose']
  ];
  // recap openers: workday good, middling, bad; then weekend good, middling, bad
  const RECAP = [[
    'Clear head all day. The hard thing was done before lunch.', 'Sent the draft a day early.', 'Quiet, steady day. Nothing dramatic, everything moved.',
    'One good conversation untangled a problem that was a week old.', 'The morning focus block actually held.',
    'Woke before the alarm and used the extra hour well.', 'Finished the report and closed the laptop on time.',
    'One of those days where the plan and the day agree.', 'Walked at lunch and came back with the answer.',
    'Said no to two meetings and nobody minded.', 'Got more done by four than in all of yesterday.',
    'Good energy from the first coffee to the last email.', 'Cleared a pile of small things and it felt like spring cleaning.',
    'Helped a colleague get unstuck, which fixed my own afternoon too.'
  ], [
    'Fine day. Meetings ate the morning, the afternoon was mine.', 'Got through the list without much spark.', 'Slow start, decent finish.',
    'Busy without much to show for it, but the inbox is empty.', 'A lot of small things. Tired in an ordinary way.',
    'Half the plan done. The other half moved to tomorrow.', 'Rain all day. Did the boring admin and felt virtuous.',
    'Neither good nor bad. Mostly calendar.', 'Productive until three, then the energy just left.',
    'Spent most of the day answering questions.', 'Unremarkable, in a comfortable way.', 'The morning was scattered, the evening made up for it.',
    'Answered everything that was waiting and started nothing new.', 'A day of loose ends. Tied about half of them.',
    'Long morning, short afternoon. Left it at that.', 'Worked through the queue, one small thing after another.',
    'Not much to report. Dinner was good.', 'Two meetings too many, otherwise fine.', 'Kept the plan modest and met it.',
    'Solid and slightly dull: the kind of day that keeps things running.'
  ], [
    'Slept badly and it showed. Dragged myself through the day.', 'Too much screen, not enough air. Irritable by the evening.',
    'Lost the afternoon to a problem that was not mine to fix.', 'Skipped lunch, was short with a colleague, apologised later.',
    'Headache from noon. Did the minimum and went to bed early.', 'Nothing went wrong exactly. I just was not really there.',
    'Started five things and finished none.', 'A long day of meetings that could have been messages.',
    'Felt behind from the first minute and never caught up.', 'Read the same paragraph for an hour and gave up at five.',
    'Everything took longer than it should have.'
  ], [
    'Slow breakfast, long morning outside, no clock.', 'Market in the morning, something new on the stove in the evening.',
    'Whole day offline. Felt like two days.', 'Tidied the flat first thing and enjoyed it for the rest of the day.',
    'Sun out, windows open, music on.', 'Played piano for an hour without noticing the time.',
    'Did exactly what I felt like, in exactly that order.', 'Out early, home late, pleasantly tired.',
    'A proper day off: book, bath, bed.', 'Baked bread and it actually rose.'
  ], [
    'Chores, groceries, a nap. An ordinary day off.', 'Did less than planned, which was probably right.', 'Laundry and a film. Recharged a little.',
    'Slow morning. No regrets, not much progress.', 'Pottered around the flat for most of the day.', 'Half rest, half errands, fully fine.',
    'Grey outside, cosy inside.', 'Errands first, sofa after.', 'Quiet day. Read a little, cooked a little.'
  ], [
    'Lost half the day to the phone.', 'Restless all day and could not settle on anything.', 'Felt flat. Cancelled plans, then regretted it.',
    'Worried about next week instead of living this one.', 'Too tired to rest properly, if that makes sense.'
  ]];
  // what a rough patch sounds like, day by day; the last line is the day it lifts
  const SLUMP = [[
    'Scratchy throat since the morning. Cancelled the evening.', 'Proper cold now. Tea, blanket, not much else.', 'Still foggy. Half a day of work from the sofa.',
    'The cough is easing but there is no energy for anything extra.', 'Bored of being ill. Short walk around the block.', 'First day that felt normal again. Easy does it.'
  ], [
    'The deadline moved forward. Worked late and dropped everything else.', 'Another long one. Dinner at the desk.', 'Too wired to sleep after the late push.',
    'Running on coffee. The list is not getting shorter.', 'Short with people who did not deserve it.', 'Delivered. Completely empty afterwards, but it is done.'
  ], [
    'Awake from four. Useless by the afternoon.', 'Second short night. Everything takes twice as long.', 'Napped at lunch, which helped a little.',
    'Tired and wired at the same time. Phone until midnight, of course.', 'Dragged through the day on autopilot.', 'Finally slept through. The world has colour again.'
  ]];
  const LINE = {
    Running: ['Good run.', 'The run cleared my head.'], Cycling: ['Long ride out of town.', 'Rode along the canal.'], Gym: ['Solid session at the gym.', 'Lifted and felt better for it.'],
    Bouldering: ['Bouldering after work.', 'Good session at the wall.'], Hiking: ['Up the hill and back before the rain.', 'Hours on the trail.'],
    Salsa: ['Salsa class in the evening.', 'Danced until my feet hurt.'], Swimming: ['Swam and had a lane to myself.', 'A swim to switch off.'],
    'Table tennis': ['Table tennis in the afternoon.', 'A few fast games of table tennis.']
  };
  const HIGH = ['Coffee on the balcony in the first sun.', 'Finished the chapter I kept putting off.', 'The light on the way home.', 'A stranger ran after me with my dropped glove.',
    'Got the tricky bars right three times in a row.', 'Inbox at zero for a whole hour.', 'Fresh bread, still warm.', 'An unexpected free afternoon.', 'The first quiet hour of the day.',
    'Fixed it on the first try.', 'Rain on the window while reading.', 'Praise from someone who rarely gives it.', 'A nap in the sun.', 'The first page of a new notebook.',
    'A forgotten song came on at exactly the right moment.', 'Cold air and a clear sky on the way out.', 'The soup turned out better than the recipe.', 'An hour with no notifications.', 'Clean sheets.'];
  const WITH = ['Laughing with % until it hurt.', 'A long talk with %, the good kind.', '% brought cake for no reason.', '% remembered something I said months ago.', 'Cooking next to %, not saying much.'];
  const LOW = ['Forty minutes of scrolling before bed.', 'Missed the bus by seconds.', 'Skipped lunch and paid for it at four.', 'An argument about nothing.', 'Coffee all over the notebook.',
    'Said yes when I meant no.', 'Back hurts from the bad chair.', 'Forgot to call back, again.', 'Late start, chased the day from then on.', 'Too much sugar in the afternoon.',
    'Checked work mail in bed.', 'Ate standing up, twice.', 'Left the hard task for last, and then for tomorrow.'];
  const LEARN = ['Phone out of the bedroom works. Keep it there.', 'I drift when the first hour has no plan.', 'Sport first, work second; never the other way round.', 'Late coffee costs me the next morning.',
    'Writing the plan down the evening before saves the morning.', 'One hard thing a day is enough.', 'When I am irritable I am usually just hungry or tired.', 'A ten-minute version still counts.',
    'Meetings after three are wasted on me.', 'Asking early is cheaper than fixing late.', 'If it takes two minutes, do it now.', 'Rest before I am exhausted, not after.'];
  const MEMO = ['The smell of the first cold morning of the season.', 'Pip asleep on the sofa with the book still open.', 'Everyone around the table talking at once.',
    'The street completely empty at six.', 'Music from an open window on the walk home.', 'The last light on the hills, seen from the train.'];
  // days to keep: [memory, highlight, recap, people, what we did, sport or '', sport note]
  const CORE = [
    ['Sunrise from the ridge, clouds below us, nobody speaking.', 'Reaching the top before the sun did.', 'Up at four for the ridge. Worth every minute of lost sleep.', 'Wren, Juno', 'Sunrise hike', 'Hiking', 'Up the ridge for sunrise: 14 km, 900 m of climbing'],
    ['Playing the whole piece from memory for the first time.', 'It finally sounded like music.', 'Sat down at the piano after dinner and it just came out, start to finish.', 'Pip', 'Evening at home', ''],
    ['Night swim in the lake, everyone shrieking at the cold.', 'Staying in the water until the stars came out.', 'A spontaneous trip to the lake turned into the best evening in months.', 'Pip, Juno, Odo', 'Evening at the lake', 'Swimming', 'Lake swim after dark, nobody counted lengths'],
    ['The band locking in on the last song and nobody wanting to stop.', 'The rehearsal where it all clicked.', 'Three hours of music that felt like twenty minutes.', 'Quill, Nim', 'Long rehearsal', ''],
    ['A long table in the garden, lanterns, nowhere to be.', 'A dinner that went on until midnight.', 'Cooked for six, ate for hours, laughed the whole time.', 'Pip, Bramble, Tansy', 'Dinner in the garden', ''],
    ['Crossing the line of my first race, legs gone, grinning.', 'The last kilometre.', 'Race day. Slower than planned and happier than expected.', 'Pip, Wren', 'Cheering at the finish', 'Running', 'Race day: 10 km in 53:40'],
    ['A power cut, candles, cards and bad jokes until late.', 'Nothing to do and nowhere to go.', 'The lights went out at six, so we played cards all evening.', 'Pip, Juno', 'Cards by candlelight', ''],
    ['Bramble calling with big news, both of us laughing and crying.', 'The best phone call of the year.', 'An ordinary day until the phone rang.', 'Bramble', 'Phone call', '']
  ];
  const hasFocus = n => !coreOf(n) && one('focus', n) < (slump(n) ? .3 : dow(n) > 4 ? .45 : .72);
  const focusOf = n => { const w = dow(n) > 4 ? 1 : 0; return FOCUS[w][(nth('focus' + w, n, x => hasFocus(x) && (dow(x) > 4 ? 1 : 0) === w) + (hasFocus(n) ? 0 : 5)) % FOCUS[w].length]; };
  // which recap pool an ordinary day draws from, or -1
  const tone = n => coreOf(n) || slump(n) || one('recap', n) >= .9 ? -1 : (dow(n) > 4 ? 3 : 0) + (rating(n) > 3 ? 0 : rating(n) === 3 ? 1 : 2);
  const hasHigh = n => !coreOf(n) && one('high', n) < [0, .1, .1, .25, .45, .45][rating(n)];
  const hasFriend = n => hasHigh(n) && one('with', n) < .3 && company(n).length > 0;
  const hasLow = n => !coreOf(n) && one('low', n) < (rating(n) < 3 ? .5 : .12);
  const hasLearn = n => one('learn', n) < .16;
  const hasMemo = n => !coreOf(n) && one('memo', n) < .06;
  // the journal entry for day n, as written that evening
  const entry = n => {
    const core = coreOf(n), low = core ? null : slump(n), t = tone(n), s = session(n), ppl = company(n), d = {};
    if (core || one('rated', n) < .93) d.rating = rating(n);
    if (core) d.core = true;
    if (hasFocus(n)) d.focus = focusOf(n);
    if (core) d.recap = core[2];
    else if (low) d.recap = SLUMP[low.kind][low.step];
    else if (t >= 0) {
      const v = one('more', n);
      d.recap = deal(RECAP[t], 'recap' + t, n, x => tone(x) === t)
        + (ppl.length && v < .5 ? ' ' + ppl[0][1] + ' with ' + ppl[0][0].replace(', ', ' and ') + '.' : s && v < .8 ? ' ' + LINE[s.sport][one('line', n) < .5 ? 0 : 1] : '');
    }
    if (!d.rating && !d.recap) d.rating = rating(n);
    if (core) d.highlight = core[1];
    else if (hasFriend(n)) d.highlight = deal(WITH, 'with', n, hasFriend).replace('%', ppl[0][0].split(', ')[0]);
    else if (hasHigh(n)) d.highlight = deal(HIGH, 'high', n, x => hasHigh(x) && !hasFriend(x));
    if (hasLow(n)) d.lowlight = deal(LOW, 'low', n, hasLow);
    if (hasLearn(n)) d.learnings = deal(LEARN, 'learn', n, hasLearn);
    if (core) d.memory = core[0];
    else if (hasMemo(n)) d.memory = deal(MEMO, 'memo', n, hasMemo);
    return d;
  };

  /* ---------- weekly and monthly reviews ---------- */
  const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'];
  const weekFacts = m => {
    const f = {sessions: 0, sport: {}, hab: {}, early: 0, written: 0, bad: 0, kind: 0};
    for (let n = m; n < m + 7; n++) {
      const s = session(n), low = slump(n);
      if (s) { f.sessions++; f.sport[s.sport] = (f.sport[s.sport] || 0) + 1; }
      if (low) { f.bad++; f.kind = low.kind; }
      if (!isGap(n)) f.written++;
      HABITS.forEach(h => { if (habitDone(h, n)) { f.hab[h.id] = (f.hab[h.id] || 0) + 1; if (h.id === 'h_up' && dow(n) < 5) f.early++; } });
    }
    return f;
  };
  const grade = (v, all, some) => v >= all ? 'done' : v >= some ? 'partly' : 'dropped';
  // intentions that can be checked against the week's own data: [text, why it slipped, check]
  const COUNTED = [
    ['Four sport sessions', 'Dropped one session when the week filled up.', f => grade(f.sessions, 4, 3)],
    ['Two runs', 'Swapped running for things that were easier to start.', f => grade(f.sport.Running || 0, 2, 1)],
    ['Read on five evenings', 'Phone in bed on the other nights.', f => grade(f.hab.h_read || 0, 5, 3)],
    ['Meditate on four mornings', 'Skipped whenever the morning started late.', f => grade(f.hab.h_meditate || 0, 4, 2)],
    ['Up by 7 on every workday', 'Late nights made the alarm negotiable.', f => grade(f.early, 5, 3)],
    ['Piano on four days', 'No fixed slot, so it slid to the end of the day and off it.', f => grade(f.hab.h_piano || 0, 4, 2)],
    ['Stretch every day', 'Fine on training days, forgotten on the others.', f => grade(f.hab.h_stretch || 0, 6, 4)],
    ['Journal every evening', 'One evening ended asleep on the sofa.', f => grade(f.written, 7, 5)]
  ];
  // and the ones that cannot: [text, why it slipped]
  const HOPED = [
    ['Inbox to zero by Friday', 'New requests arrived faster than I answered them.'],
    ['No work laptop at the weekend', 'Opened it on Sunday, just to check.'],
    ['Cook at home five nights', 'Two late evenings ended with takeaway.'],
    ['One evening with nothing planned', 'Said yes to everything again.'],
    ['Lights out by 23:00', 'One more episode, three times.'],
    ['Finish the draft before Thursday', 'Underestimated the last section.'],
    ['Call Bramble', 'We kept missing each other.'],
    ['Sort the paperwork pile', 'It has no deadline, so it never started.']
  ];
  const WORKED = ['Planning the day the evening before.', 'Training in the morning, before the day could argue.', 'Two evenings fully offline.', 'Keeping the first hour free of meetings.',
    'Saying no early instead of late.', 'Walking at lunch.', 'Putting the phone in another room while working.', 'Meeting people straight after work, before the sofa wins.',
    'Cooking double and eating it twice.', 'Starting with the task I wanted least.'];
  // what did not work, why, and what to change: these belong together
  const TROUBLE = [
    ['Evenings dissolved into the phone.', 'It was within reach the whole time and I was too tired to resist.', 'Charge the phone in the hallway.'],
    ['Too much planned for the middle of the week.', 'I treated the plan as a wish list instead of appointments.', 'Plan three things a day, not seven.'],
    ['Lunch at the desk on most days.', 'Meetings ran over and I never blocked the break.', 'Put lunch in the calendar and leave the building.'],
    ['In bed late three nights in a row.', 'One more episode, one more scroll: the evening had no clear end.', 'An alarm at 22:30 that means screens off.'],
    ['Kept starting new things before finishing old ones.', 'Starting feels better than finishing, and nothing forced the order.', 'Finish one open task before opening the next.'],
    ['Piano and reading lost against everything with a deadline.', 'They have no fixed time, so they are always the first to go.', 'Fifteen minutes of piano before dinner, not after.'],
    ['The week started behind and never caught up.', 'I planned on Monday morning instead of Sunday evening.', 'Decide the training days and the three big tasks on Sunday.'],
    ['Skipped the tidy-up and the desk shows it.', 'Small chores had no slot, so they waited for a free moment that never came.', 'Ten minutes of reset before closing the laptop.'],
    ['Training felt like an obligation by Thursday.', 'Too many hard sessions in a row on too little sleep.', 'One easy session after every hard one.'],
    ['Said yes to three evenings out and was tired for all of them.', 'I answer invitations at once instead of looking at the week first.', 'Reply to invitations the next morning.']
  ];
  // the same answers for a week with a rough patch in it, by kind: [short why, worked, did not, why, change]
  const ROUGH = [
    ['Was ill.', 'Resting properly instead of pushing through.', 'Everything stopped on the day I got ill.', 'Ill for most of the week, and there was no smaller version of the routine to fall back on.', 'A sick-day version of the routine: water, one page, bed.'],
    ['Lost to the deadline.', 'It got delivered, and I still moved a little.', 'Work swallowed the week whole.', 'The deadline took the evenings, and the habits live in the evenings.', 'Decide in advance which one habit survives a deadline week.'],
    ['Too tired.', 'Lowering the bar for a few days instead of fighting it.', 'Short nights, and every routine went with them.', 'Bad sleep. Whatever needs willpower went first.', 'Screens off earlier and no coffee after two.']
  ];
  const PLAN = ['Tuesday and Wednesday are full; keep Thursday evening free.', 'Long run on Saturday if the weather holds.', 'Rehearsal on Thursday: practise the bridge before.',
    'Away on Friday, so train early in the week.', 'Guests at the weekend. Shop on Thursday.', 'Quiet week. A good one for the big draft.', 'Start slowly on Monday, the weekend was long.',
    'Three evenings out. Guard the other two.'];
  const verdict = (tpl, m, f) => {
    if (tpl[2]) return tpl[2](f);
    const v = one(tpl[0], m), hard = f.bad > 1;
    return v < (hard ? .2 : .5) ? 'done' : v < (hard ? .6 : .8) ? 'partly' : 'dropped';
  };
  // two countable intentions and one or two hopeful ones; each pool goes round once in four weeks
  const fresh = m => {
    const k = (m + 3) / 7, j = 2 * (k % 4), r = rnd('pledge', floor(k / 4)), a = shuffle(COUNTED, r), b = shuffle(HOPED, r);
    return [a[j], a[j + 1], b[j]].concat(one('extra', m) < .4 ? [b[j + 1]] : []);
  };
  // this week's intentions, plus at most one that was missed last week and carried over
  const pledges = m => {
    const now = fresh(m).map(t => ({tpl: t})), before = weekFacts(m - 7);
    const old = fresh(m - 7).filter(t => verdict(t, m - 7, before) !== 'done' && now.every(x => x.tpl !== t))[0];
    if (old && one('carry', m) < .85) now.push({tpl: old, carried: true});
    return now;
  };
  // state: 'closed' (reviewed on its Sunday), 'open' (the current week) or 'next' (only pencilled in)
  const weekDoc = (m, state, stamp) => {
    const f = weekFacts(m), id = weekId(m), k = (m + 3) / 7, closed = state === 'closed', rough = f.bad > 1 && ROUGH[f.kind];
    const list = state === 'next' ? pledges(m).filter(x => !x.carried).slice(0, 2) : pledges(m);
    let missed = 0;
    const intentions = list.map((x, i) => {
      const status = closed ? verdict(x.tpl, m, f) : 'open', miss = status === 'partly' || status === 'dropped';
      const it = {id: 'i_' + id.slice(5) + '_' + (i + 1), text: x.tpl[0], status: status, why: miss ? (rough && !missed++ ? rough[0] : x.tpl[1]) : ''};
      if (x.carried) it.carried = true;
      return it;
    });
    const doc = {id: id, kind: 'week', start: isoOf(m), end: isoOf(m + 6), intentions: intentions, worked: '', didnt: '', why: '', change: '',
      plan: one('plan', m) < .6 ? PLAN[k * 3 % PLAN.length] : '', review: '', closedAt: null, updatedAt: stamp};
    if (closed) {
      const hs = HABITS.filter(h => !h.span).map(h => ({name: h.name, n: f.hab[h.id] || 0})).sort((a, b) => b.n - a.n), best = hs[0], worst = hs[hs.length - 1];
      const t = TROUBLE[k * 7 % TROUBLE.length];
      doc.worked = rough ? rough[1] : (f.sessions > 3 && one('worked', m) < .5 ? NUM[f.sessions] + ' training sessions. ' : best.n > 4 ? best.name + ': ' + best.n + ' of 7 days. ' : '') + WORKED[k * 3 % WORKED.length];
      doc.didnt = rough ? rough[2] : (worst.n < 4 ? worst.name + ': ' + worst.n + ' of 7 days. ' : '') + t[0];
      doc.why = rough ? rough[3] : t[1];
      doc.change = rough ? rough[4] : t[2];
      doc.closedAt = doc.updatedAt = at(m + 6, 19, 20 + floor(one('close', m) * 35));
    }
    return doc;
  };
  // monthly focus: [text, what made it work, why it slipped, what to change]
  const M_FOCUS = [
    ['Build the running base', 'Running on fixed days, whatever the weather.', 'Lost a week in the middle and never fully caught up.', 'After a missed week, start again with one short run the next day.'],
    ['In bed before midnight', 'An alarm for going to bed, not only for getting up.', 'Held on weekdays, fell apart every weekend.', 'The same bedtime on Friday and Saturday, give or take an hour.'],
    ['Finish the workshop project', 'Two fixed mornings a week for it, with nothing else allowed in.', 'The last ten percent took half the month.', 'Name the finish line in one sentence before starting.'],
    ['Play the new piece end to end', 'Short daily piano sessions instead of one long one.', 'Practised the easy parts and avoided the hard page.', 'Start every session with the hardest four bars.'],
    ['See friends every week', 'Fixing the next date before saying goodbye.', 'One week vanished into work.', 'One standing evening a week that work cannot have.'],
    ['Less phone, more books', 'The book on the pillow, the phone in the hallway.', 'Good until the stressful stretch, then back to the old pattern.', 'Decide what the tired version looks like: ten pages still count.'],
    ['Get the paperwork under control', 'One fixed admin hour on Monday, timer on.', 'Started twice, finished nothing.', 'One folder at a time, and the first one this Monday.'],
    ['Cook more, order less', 'Cooking at the weekend carried the weekdays.', 'Fine when the fridge was stocked, hopeless when it was not.', 'Shop on a fixed day so the fridge is never the excuse.']
  ];
  const M_WHY = ['I plan for good weeks only; a bad week has no plan at all.', 'The monthly focus never made it into the weekly intentions.',
    'When work gets busy, everything without a deadline goes first.', 'After dinner there is no plan, so the phone makes one.'];
  // first: day number of the 1st of the month. A closed month has held at least one focus and missed at least one.
  const monthDoc = (first, closed) => {
    const key = isoOf(first).slice(0, 7), last = monthFirst(first + 31) - 1, r = rnd('month', key), stamp = closed ? at(last, 20, 40) : at(first, 8, 30);
    const focus = shuffle(M_FOCUS, r).slice(0, r() < .6 ? 3 : 2).map(x => { const v = r(); return {x: x, status: v < .45 ? 'done' : v < .8 ? 'partly' : 'dropped'}; });
    if (focus.every(p => p.status === 'done')) focus[focus.length - 1].status = 'partly';
    if (focus.every(p => p.status !== 'done')) focus[0].status = 'done';
    const held = focus.filter(p => p.status === 'done')[0].x, lost = focus.filter(p => p.status !== 'done')[0];
    return {id: 'month_' + key, kind: 'month', start: isoOf(first), end: isoOf(last),
      intentions: focus.map((p, i) => ({id: 'i_' + key + '_' + (i + 1), text: p.x[0], status: closed ? p.status : 'open', why: closed && p.status !== 'done' ? p.x[2] : ''})),
      worked: closed ? held[1] : '', didnt: closed ? lost.x[0] + (lost.status === 'partly' ? ': only partly.' : ': not really.') : '',
      why: closed ? M_WHY[(yearOf(first) * 12 + Number(key.slice(5))) % M_WHY.length] : '', change: closed ? lost.x[3] : '',
      plan: '', review: '', closedAt: closed ? stamp : null, updatedAt: stamp};
  };

  /* ---------- tasks ---------- */
  // title, area, priority, planned day, done day, status while open, created day, description, subtasks ('+' = ticked)
  // Days count from this week's Monday; null = not planned / never finished.
  const TASKS = [
    // earlier weeks, done
    ['Book a dentist check-up', 'Health', 'medium', -37, -37, 'todo', -41],
    ['Submit the expense report', 'Work', 'high', -34, -33, 'todo', -38],
    ['Learn the left hand of the new piece', 'Music', 'medium', -27, -25, 'progress', -40, 'Slowly, with the metronome.', ['+Bars 1 to 16', '+Bars 17 to 32', '+Hands together at half speed']],
    ['Plan the birthday dinner for Tansy', 'Social', 'high', -23, -22, 'todo', -30, '', ['+Pick a date', '+Book a table', '+Organise the present']],
    ['Fix the squeaky bike brake', '', 'low', -20, -17, 'todo', -26],
    ['Prepare the workshop slides', 'Work', 'urgent', -16, -16, 'progress', -24, 'Thirty minutes, ten slides at most.', ['+Outline', '+Draft the slides', '+Dry run with Juno']],
    ['Cancel the unused streaming subscription', 'Admin', 'medium', -13, -12, 'todo', -15],
    ['Send the hike photos to Wren', 'Social', 'none', null, -9, 'todo', -11],
    ['Write the handover note', 'Work', 'medium', -6, -6, 'todo', -8],
    ['Back up the laptop', 'Admin', 'low', -5, -3, 'todo', -7],
    // overdue and still open
    ['Write up the user interviews', 'Work', 'high', -8, null, 'progress', -14, 'Five interviews, one page each, then a summary.', ['+Interviews 1 to 3', 'Interviews 4 and 5', 'Summary page']],
    ['File the tax paperwork', 'Admin', 'urgent', -4, null, 'stuck', -21, 'Blocked: one statement is still missing from the bank.', ['+Collect the receipts', 'Download the statements', 'Fill in the form']],
    ['Reply to Bramble about the summer trip', 'Social', 'medium', -2, null, 'todo', -9],
    // this week: something on every day
    ['Order new running shoes', 'Health', 'medium', 0, 0, 'todo', -3],
    ['Send the invoice', 'Work', 'high', 1, 1, 'todo', -2],
    ['Call the landlord about the heating', 'Admin', 'high', 1, null, 'waiting', -6, 'Left a message, waiting for the call back.'],
    ['Practise the bridge before rehearsal', 'Music', 'high', 2, 2, 'todo', -1],
    ['Draft the project proposal', 'Work', 'urgent', 3, null, 'progress', -7, 'Two pages. The budget is the hard part.', ['+Problem statement', 'Budget table', 'Timeline']],
    ['Buy a present for Odo', 'Social', 'medium', 3, 3, 'todo', -4],
    ['Book the physio appointment', 'Health', 'low', 4, null, 'todo', -10],
    ['Record a rough take of the new piece', 'Music', 'medium', 5, 5, 'todo', -5],
    ['Clean the bike chain', '', 'low', 5, 5, 'todo', -2],
    ['Cook a big batch for next week', 'Health', 'none', 6, 6, 'todo', 0],
    // coming up
    ['Prepare the quarterly review', 'Work', 'high', 7, null, 'todo', -3],
    ['Dentist check-up', 'Health', 'medium', 8, null, 'todo', -37],
    ['Bring the new set list to rehearsal', 'Music', 'medium', 10, null, 'todo', -2],
    ['Renew the transit pass', 'Admin', 'low', 11, null, 'todo', -1],
    ['Host a board game night', 'Social', 'medium', 12, null, 'progress', -6, '', ['+Invite everyone', 'Buy snacks', 'Pick three games']],
    ['Submit the talk idea', 'Work', 'medium', 16, null, 'paused', -12, 'On hold until the call for talks opens.'],
    // some day, not planned
    ['Sort the photo archive', '', 'none', null, null, 'paused', -45, 'Parked until the new drive arrives.'],
    ['Get the piano tuned', 'Music', 'low', null, null, 'waiting', -18, 'The tuner will send a date.'],
    ['Research standing desks', 'Work', 'none', null, null, 'todo', -9],
    ['Learn to bake sourdough', '', 'low', null, null, 'todo', -28]
  ];

  /* ---------- plan ---------- */
  const WHY = ['Tired', 'Work ran over', 'Weather', 'Something better', 'Overplanned', 'Others cancelled'];
  const CHORES = ['Laundry', 'Groceries', 'Clean the flat', 'Water the plants'];
  // meetings that were arranged ahead; a training partner is part of the session, not a plan of its own
  const ARRANGED = new Set(MEET[0].concat(MEET[1]).map(x => x[1]).concat(['Band rehearsal']));

  /* ---------- putting it together ---------- */
  function build(today, defaults){
    if (!/^\d{4}-\d\d-\d\d$/.test(today)) throw new Error('LifeOSDemo.build: today must be YYYY-MM-DD');
    const cfg = JSON.parse(JSON.stringify(defaults || {}));
    const T = dayNo(today), first = T - 59, mon = monday(T);
    const data = {days: {}, habits: {}, habit_log: {}, sports: {}, activities: {}, people_log: {}, tasks: {}, periods: {}, plan: {}, plan_log: {}, settings: {main: cfg}};
    const longAgo = days => monthFirst(T - days);               // a month start well before the window

    // names and colours come from the defaults; ours are only preferences among them
    const types = (cfg.sportTypes || []).map(x => x.name), areas = (cfg.areas || []).map(x => x.name), hex = /^#[0-9a-f]{6}$/i;
    const colours = (cfg.sportTypes || []).concat(cfg.areas || []).map(x => x.color).filter((c, i, a) => hex.test(c) && a.indexOf(c) === i);
    if (!colours.length) colours.push(cfg.theme && hex.test(cfg.theme.accent) ? cfg.theme.accent : '#888888');
    const wanted = TASKS.map(t => t[1]).filter((a, i, all) => a && all.indexOf(a) === i), spare = areas.filter(a => wanted.indexOf(a) < 0), areaOf = {'': ''};
    wanted.forEach(a => { areaOf[a] = areas.indexOf(a) >= 0 ? a : spare.shift() || ''; });

    // journal: the sixty days up to today; today is still in progress
    for (let n = first; n <= T; n++) {
      const iso = isoOf(n), j = n === T ? {focus: focusOf(n)} : n === first || !isGap(n) ? entry(n) : null;
      if (j) data.days[iso] = Object.assign({date: iso}, j, {updatedAt: at(n, n === T ? 7 : 21, 10 + floor(one('min', n) * 45))});
    }
    // a focus already pencilled in for some of the coming days
    for (let n = T + 1; n <= T + 14; n++) {
      const lead = 1 + floor(one('lead', n) * 9);
      if (hasFocus(n) && n - T <= lead) data.days[isoOf(n)] = {date: isoOf(n), focus: focusOf(n), updatedAt: at(n - lead, 21, 30)};
    }

    HABITS.forEach((h, i) => {
      const from = h.span ? mon + h.span[0] : longAgo(95 + 30 * i), to = h.span && h.span[1] != null ? mon + h.span[1] : null;
      const doc = {id: h.id, name: h.name, icon: h.icon, color: colours[h.hue % colours.length], order: i, archived: to != null};
      if (to != null) doc.archivedAt = isoOf(to);
      doc.ranges = [{from: isoOf(from), to: to == null ? null : isoOf(to)}];
      doc.createdAt = at(from, 9, 5 * i);
      data.habits[h.id] = doc;
      // ticked only inside its range, never ahead of time; today only what belongs to the morning
      for (let n = max(from, first); n <= (to == null ? T : to); n++) {
        if (habitDone(h, n) && (n < T || h.hour < 12)) data.habit_log[isoOf(n) + '_' + h.id] = {date: isoOf(n), habitId: h.id, done: true, at: at(n, h.hour, floor(one(h.id + '-at', n) * 50))};
      }
    });

    SPORTS.forEach((s, i) => {
      const id = 's_' + slug(s.name);
      data.sports[id] = {id: id, name: s.name, type: types.indexOf(s.type) >= 0 ? s.type : types.length ? types[i % types.length] : '', icon: s.icon, createdAt: at(longAgo(120 + 15 * i), 18, 30)};
    });
    for (let n = first; n <= T; n++) {
      const iso = isoOf(n), s = session(n);
      if (s) data.activities['a_' + iso] = {id: 'a_' + iso, date: iso, sport: s.sport, note: s.note, createdAt: at(n, s.hour, s.min)};
      if (n < T) company(n).forEach((p, i) => { const id = 'p_' + iso + '_' + (i + 1); data.people_log[id] = {id: id, date: iso, people: p[0], activity: p[1], createdAt: at(n, 21, i)}; });
    }

    TASKS.forEach((t, i) => {
      // finished once its day has come; of today's, only every other one is ticked yet
      const id = 't_demo' + pad(i + 1), done = t[4] != null && (mon + t[4] < T || mon + t[4] === T && i % 2 === 0);
      data.tasks[id] = {id: id, title: t[0], description: t[7] || '', status: done ? 'done' : t[5], priority: t[2], area: areaOf[t[1]],
        plannedFor: t[3] == null ? null : isoOf(mon + t[3]), doneOn: done ? isoOf(mon + t[4]) : null,
        subtasks: (t[8] || []).map((s, k) => ({id: 's_' + pad(i + 1) + '_' + (k + 1), title: s.replace(/^\+/, ''), done: done || s[0] === '+'})),
        createdAt: at(mon + t[6], 8 + i % 11, i * 17 % 60)};
    });

    // reviews: every full week behind us is closed, this week is open, next week is pencilled in
    const put = p => { data.periods[p.id] = p; };
    for (let m = mon - 7; m >= first; m -= 7) put(weekDoc(m, 'closed'));
    put(weekDoc(mon, 'open', at(mon, 8, 10)));
    put(weekDoc(mon + 7, 'next', at(T, 7, 55)));
    put(monthDoc(monthFirst(monthFirst(T) - 1), true));
    put(monthDoc(monthFirst(T), false));

    // plan: what each week set out to do, and what became of it. Sessions and meetings follow the
    // same dice as the journal, so a ticked item always has its row. In a past week one session
    // may have slipped a day, one may have been skipped, some just happened without a plan.
    const partOf = h => h < 12 ? 'm' : h < 17 ? 'a' : 'e';
    const planWeek = m => {
      const id = weekId(m), key = id.slice(5), ws = isoOf(m), stamp = m > mon ? at(T, 7, 55) : at(m - 1, 19, 30), base = [];   // planned on the Sunday before
      let seq = 0, k = 0, skipped = false;
      const row = (rid, kind, title, n, part, extra) => {
        const doc = Object.assign({id: rid, kind: kind, title: title, ref: null, week: ws, date: n == null ? null : isoOf(n), part: part || null, order: ++seq, time: null,
          status: 'planned', link: null, createdAt: stamp, updatedAt: stamp}, extra || {});
        data.plan[rid] = doc;
        return doc;
      };
      const keep = (r, n, part) => { base.push({id: r.id, ref: r.ref || null, date: n == null ? null : isoOf(n), part: part || null}); };
      const note = (lid, r, kind, from, to, when) => {
        data.plan_log[lid] = {id: lid, planId: r.id, title: r.title, week: ws, kind: kind, from: from, to: to, timing: 'day', reason: WHY[floor(one('why', m + lid.length) * WHY.length)], at: when};
      };
      const slip = 1 + floor(one('slip', m) * 3), loose = one('loose', m) < .45 ? 1 + floor(one('which', m) * 3) : 0;
      for (let n = m; n < m + 7; n++) {
        const iso = isoOf(n), d = n - m + 1, s = session(n), act = data.activities['a_' + iso];
        if (s) {
          k++;
          if (!(k === loose && n < T)) {                           // otherwise: a session nobody planned
            const part = partOf(s.hour), r = row('pl_' + key + '_s' + d, 'sport', s.sport, n, part, act ? {status: 'done', link: act.id, updatedAt: act.createdAt} : null);
            if (k === slip && d > 1 && n <= T && !session(n - 1)) { // first planned for the day before
              keep(r, n - 1, part);
              note('pg_' + key + '_m' + d, r, 'move', {date: isoOf(n - 1), part: part}, {date: iso, part: part}, at(n - 1, 17, 20 + d));
            } else keep(r, n, part);
          }
        } else if (!skipped && n < T && d > 1 && !slump(n) && (one('skip', n) < .5 || d === 6)) {
          skipped = true;
          const r = row('pl_' + key + '_x' + d, 'sport', BY_DAY[dow(n)][0], n, 'e', {status: 'skipped', updatedAt: at(n, 19, 5)});
          keep(r, n, 'e');
          note('pg_' + key + '_x' + d, r, 'skip', {date: iso, part: 'e'}, null, at(n, 19, 5));
        }
        if (!coreOf(n)) company(n).forEach((p, i) => {
          if (!ARRANGED.has(p[1]) || (n < T && p[1] !== 'Band rehearsal' && one('spont', n) < .35)) return;   // some meetings just happen
          const log = data.people_log['p_' + iso + '_' + (i + 1)], part = /breakfast|Brunch|market/.test(p[1]) ? 'm' : /unch|Coffee|Walk|Phone/.test(p[1]) ? 'a' : 'e';
          keep(row('pl_' + key + '_p' + d + (i + 1), 'people', p[1] + ' with ' + p[0], n, part, log ? {status: 'done', link: log.id, updatedAt: log.createdAt} : null), n, part);
        });
      }
      return {id: id, key: key, base: base, stamp: stamp, row: row, keep: keep};
    };
    for (let m = mon - 7; m >= first; m -= 7) { const w = planWeek(m), p = data.periods[w.id]; p.planBase = w.base; p.planAt = w.stamp; }
    const cur = planWeek(mon), nxt = planWeek(mon + 7), idle = SPORTS.map(x => x.name).filter(x => weekPlan(mon).indexOf(x) < 0)[0] || SPORTS[0].name;
    // this week's and next week's tasks: three in four already sit in a part of their day
    TASKS.forEach((t, i) => {
      if (t[3] == null || t[3] < 0 || t[3] > 13) return;
      const w = t[3] < 7 ? cur : nxt, tid = 't_demo' + pad(i + 1), n = mon + t[3], part = [null, 'm', 'a', 'e'][i % 4];
      const r = part ? w.row('pl_' + w.key + '_t' + pad(i + 1), 'task', t[0], n, part, {ref: tid}) : {id: 't:' + tid, ref: tid};
      if (w === cur && t[6] < 0) cur.keep(r, n, part);            // on the list before the week began
    });
    // an evening out, a session still without a day, a call that came up during the week,
    // and the chores that only help to order a day
    cur.keep(cur.row('pl_' + cur.key + '_e1', 'event', 'Concert', mon + 4, 'e', {time: '20:00', status: mon + 4 < T ? 'done' : 'planned'}), mon + 4, 'e');
    cur.keep(cur.row('pl_' + cur.key + '_f1', 'sport', idle, null, null), null, null);
    cur.row('pl_' + cur.key + '_f2', 'people', 'Call Bramble', null, null, {createdAt: at(T, 7, 40), updatedAt: at(T, 7, 40)});
    for (let n = mon; n <= T; n++) cur.row('pl_' + cur.key + '_r' + (n - mon + 1), 'routine', CHORES[n % CHORES.length], n, n % 2 ? 'm' : 'e', {status: n < T ? 'done' : 'planned'});
    nxt.row('pl_' + nxt.key + '_e1', 'event', 'Film night', mon + 12, 'e', {time: '19:30'});
    nxt.row('pl_' + nxt.key + '_f1', 'sport', idle, null, null);
    data.periods[cur.id].planBase = cur.base;
    data.periods[cur.id].planAt = cur.stamp;
    return data;
  }

  root.LifeOSDemo = {build: build};
})(typeof window!=='undefined'?window:globalThis);
