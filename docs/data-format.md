# Life OS data format

This describes everything Life OS stores, precisely enough to write an importer
from another tool without reading the code. The same format is used by

- **Export everything (JSON)** in Settings,
- **Import JSON export** in Settings and the `POST api/import` endpoint,
- `GET api/data`, which is how the app loads its data,
- the demo data generator (`app/demo.js`).

## The export file

One JSON object with nine keys, one per collection. Each collection is an
object that maps a document id to a document:

```json
{
  "days":       {"2026-03-09": {"date": "2026-03-09", "rating": 4, "recap": "..."}},
  "habits":     {"h_read": {"id": "h_read", "name": "Read 20 minutes", "...": "..."}},
  "habit_log":  {"2026-03-09_h_read": {"date": "2026-03-09", "habitId": "h_read", "done": true}},
  "sports":     {},
  "activities": {},
  "people_log": {},
  "tasks":      {},
  "periods":    {},
  "settings":   {"main": {"sportTypes": [], "areas": [], "theme": {}}}
}
```

An import may leave collections out, and may contain only some documents. It
**upserts**: a document with an existing id replaces the stored one as a whole
(there is no field-level merge), and nothing is ever deleted by an import.

## Rules for every document

| Rule | Detail |
|------|--------|
| Collections | Exactly these nine names. Anything else is refused. |
| Id characters | `^[A-Za-z0-9_\-.~:@+]+$`, at most 200 characters. No spaces, slashes or non-ASCII letters. |
| Id and document agree | The key a document is stored under must equal the id derived from the document (next table). |
| Document | A JSON object. Standard JSON only (no `NaN`, no `Infinity`), UTF-8. |
| Size | At most 256 KiB per document as stored (compact JSON). At most 64 MiB per import request. |
| Unknown fields | Kept as they are. The app ignores fields it does not know. |

How the id is derived:

| Collection | Id |
|------------|----|
| `days` | the `date` field, for example `2026-03-09` |
| `habit_log` | `date` + `_` + `habitId`, for example `2026-03-09_h_read` |
| `settings` | always `main` |
| all others | the `id` field |

Conventions used throughout:

- **date**: a calendar day as `YYYY-MM-DD` in the user's local time. No time
  zone is stored. In the interface "today" lasts until 04:00 the next morning.
- **timestamp**: milliseconds since the Unix epoch, as a number
  (`Date.now()` in JavaScript).
- **text**: free text, may contain line breaks.
- Empty and missing mean the same: leave out what you do not have. Use `null`
  only where the tables below say so.
- Ids only need to be unique within their collection. The app itself generates
  ids like `t_mf3k2a9cq1` (a prefix, the time in base 36, four random
  characters); an importer can use anything that fits the pattern, for example
  `t_notion_1f3a`. Deterministic ids make an import safe to run twice.

## Collections

### `days`: the journal, one document per calendar day

| Field | Type | Meaning |
|-------|------|---------|
| `date` | date | The day. Also the id. Required. |
| `rating` | integer 1 to 5, or `null` | How the day was. |
| `core` | boolean | A "core memory" day, shown in gold. |
| `focus` | string | The focus of the day, one line. |
| `recap` | text | What happened. |
| `highlight` | text | |
| `lowlight` | text | |
| `learnings` | text | Shown as "Drifts and learnings". |
| `memory` | text | Something to remember. |
| `updatedAt` | timestamp | Last change. |

A day without a document is simply an empty day.

### `habits`: habit definitions

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Required. |
| `name` | string | |
| `icon` | string | A symbol name from the list at the end, for example `menu_book`. |
| `color` | string | `#RRGGBB`. |
| `order` | integer | Position in the row of habits, from 0. |
| `archived` | boolean | An archived habit is no longer offered for new days. |
| `archivedAt` | date | When it was archived (only when `archived`). |
| `ranges` | list of `{from, to}` | The periods in which the habit was active: `from` is a date, `to` is a date or `null` for "still running". A day only counts for or against a habit inside one of its ranges. |
| `createdAt` | timestamp | |

A habit that was always active has `"ranges": [{"from": "2020-01-01", "to": null}]`.
An archived one has only closed ranges, for example
`[{"from": "2025-09-01", "to": "2025-11-30"}]`.

### `habit_log`: one document per habit per day, only when done

| Field | Type | Meaning |
|-------|------|---------|
| `date` | date | Required. |
| `habitId` | string | The `id` of a habit. Required. |
| `done` | boolean | Always `true`. |
| `at` | timestamp | When it was ticked. |

A habit that was not done on a day has no document for that day.

### `sports`: sport definitions

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Required. The app uses `s_` plus the name in lower case with every run of other characters replaced by `-`, for example `s_table-tennis`. |
| `name` | string | Must be unique; activities refer to it. |
| `type` | string | The `name` of an entry in `settings.main.sportTypes`, or `""`. The type gives the colour. |
| `icon` | string | A symbol name, or `""` to let the app choose from the name. |
| `createdAt` | timestamp | |

### `activities`: sport sessions

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Required. |
| `date` | date | The day of the session. |
| `sport` | string | The `name` of a sport. If no such sport exists the app creates one without a type when it next loads. |
| `note` | string | What, and how it went. |
| `createdAt` | timestamp | Also orders several sessions on one day. |

### `people_log`: who you spent time with

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Required. |
| `date` | date | |
| `people` | string | One or more names. Several names are separated by `,`, `&`, `+`, ` and ` or ` und `; the app counts each name on its own. |
| `activity` | string | What you did. |
| `createdAt` | timestamp | |

Several documents per day are fine.

### `tasks`

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Required. |
| `title` | string | |
| `description` | text | Notes. |
| `status` | string | `todo`, `progress`, `waiting`, `paused`, `stuck` or `done`. |
| `priority` | string | `none`, `low`, `medium`, `high` or `urgent`. |
| `area` | string | The `name` of an entry in `settings.main.areas`, or `""`. |
| `plannedFor` | date or `null` | The day the task is planned for. |
| `doneOn` | date or `null` | The day it was done. Set it exactly when `status` is `done`. |
| `subtasks` | list of `{id, title, done}` | `id` is unique within the task, `done` a boolean. |
| `createdAt` | timestamp | Shown as "added on". |

### `periods`: weekly and monthly reviews

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Required. `week_YYYY-Www` or `month_YYYY-MM` (see below). |
| `kind` | string | `week` or `month`. |
| `start` | date | Monday of the week, or the first day of the month. |
| `end` | date | Sunday of the week, or the last day of the month. |
| `intentions` | list | What you set out to do. Each entry: `{id, text, status, why, carried}`. |
| `worked` | text | What worked. |
| `didnt` | text | What did not. |
| `why` | text | Why it did not. |
| `change` | text | What to change next time. |
| `plan` | text | Notes written when planning the period. |
| `review` | text | Free-form review notes from earlier versions; shown only when not empty. |
| `closedAt` | timestamp or `null` | When the review was closed. `null` means open. |
| `updatedAt` | timestamp | |

An intention is `{"id": "i_1", "text": "Two runs", "status": "partly", "why": "Rain"}`:
`status` is `open` (not yet marked), `done`, `partly` or `dropped`; `why` says
what got in the way; `carried: true` marks one carried over from the period
before.

Weeks are ISO 8601 weeks: they start on Monday, and week 1 is the week that
contains 4 January. The year in the id is the ISO week-year, which differs from
the calendar year around New Year: Monday 29 December 2025 starts
`week_2026-W01`. The week number always has two digits (`week_2026-W07`).

### `settings`: one document, `main`

| Field | Type | Meaning |
|-------|------|---------|
| `sportTypes` | list of `{name, color, icon}` | The sport types, in display order. |
| `areas` | list of `{name, color, icon}` | The task areas, in display order. |
| `theme` | `{bg, surface, ink, accent, font}` | Four `#RRGGBB` colours and the name of one of the offered fonts. |

If `sportTypes` or `areas` is missing or empty, the built-in defaults apply.
An import that contains `settings.main` replaces the whole settings document,
so leave `settings` out of an importer unless you mean to set all three.

## Importing

### In the app

Settings, Schema and data, "Import JSON export". The file goes to the server
in one request. Documents whose id cannot be derived or does not match the
pattern are skipped by the app before sending, and the message says how many
rows were imported.

### With a script

The endpoint is strict where the app is forgiving: if anything in the request
is invalid, nothing is imported and the answer names the first problem.

```sh
BASE=https://<machine>.<tailnet>.ts.net

# sign in (creates a device session; the cookie lands in ./jar)
curl -sS -c jar -H 'X-LifeOS: 1' -H 'Content-Type: application/json' \
     -d '{"password": "your password"}' "$BASE/api/auth/login"

# import
curl -sS -b jar -H 'X-LifeOS: 1' -H 'Content-Type: application/json' \
     --data-binary @export.json "$BASE/api/import"
# -> {"ok":true,"imported":1234}

# sign the script out again
curl -sS -b jar -X POST -H 'X-LifeOS: 1' "$BASE/api/auth/logout"
```

- Every request that changes something needs the header `X-LifeOS: 1`.
- The whole import is one transaction: all of it or none of it.
- A refusal looks like `{"error": "tasks/t 1: ...", "code": "invalid"}` with
  status 400. Status 401 means not signed in, 423 means the session is locked.
- Try an importer against a test install first: `LIFEOS_DATA=/tmp/lifeos-test
  python3 -m lifeos`, run from the `server/` folder, gives you an empty one on
  `http://127.0.0.1:8787`. The session cookie is marked Secure and curl does
  not send such a cookie over plain HTTP, so there you copy the
  `lifeos_session=...` value from the login answer (`curl -i`) and pass it
  yourself with `-H 'Cookie: lifeos_session=...'` instead of `-b jar`.

## The other endpoints

| Request | Does |
|---------|------|
| `GET api/data` | Everything, in the export format (gzip when accepted). |
| `PUT api/data/{collection}/{id}` | Stores one document (the body). Last write wins. |
| `DELETE api/data/{collection}/{id}` | Deletes one document. |
| `POST api/import` | Upserts an export, as above. |
| `GET api/health` | `{"ok": true, "commit": "..."}`; needs no sign-in. |

## Reading the data with SQL

The database is `/var/lib/lifeos/lifeos.db` (SQLite, readable by the `lifeos`
user only). Documents live in one table,
`docs(collection, id, json, updated_at)`, and each collection has a read-only
view with the main fields as columns:

| View | Columns |
|------|---------|
| `v_days` | `date, rating, core, focus, recap, highlight, lowlight, learnings, memory, updated_at` |
| `v_habits` | `id, name, icon, color, sort_order, archived, archived_at, ranges, created_at` |
| `v_habit_log` | `date, habit_id, done, at` |
| `v_sports` | `id, name, type, icon, created_at` |
| `v_activities` | `id, date, sport, note, created_at` |
| `v_people_log` | `id, date, people, activity, created_at` |
| `v_tasks` | `id, title, description, status, priority, area, planned_for, done_on, subtasks, subtask_count, created_at` |
| `v_periods` | `id, kind, start_date, end_date, intentions, worked, didnt, why, change, plan, review, closed_at, updated_at` |
| `v_settings` | `id, sport_types, areas, theme` |

Lists and objects (`ranges`, `subtasks`, `intentions`, `theme`) come back as
JSON text. For example, the average rating per month:

```sql
SELECT substr(date, 1, 7) AS month, round(avg(rating), 2) AS rating, count(*) AS days
FROM v_days WHERE rating IS NOT NULL GROUP BY month ORDER BY month;
```

## Symbol names

`icon` fields hold one of these names (Material Symbols). The app's font
contains only these, so another name shows nothing:

`alarm`, `archive`, `auto_awesome`, `bedtime`, `bolt`, `brush`, `build`,
`camera_alt`, `celebration`, `chat`, `check_circle`, `checklist`,
`cleaning_services`, `code`, `cottage`, `directions_bike`, `directions_car`,
`directions_run`, `directions_walk`, `downhill_skiing`, `eco`, `edit`,
`emoji_events`, `favorite`, `fitness_center`, `flag`, `flight`, `forest`,
`groups`, `headphones`, `hiking`, `home`, `hotel`, `ice_skating`, `kayaking`,
`kitesurfing`, `landscape`, `language`, `laptop`, `local_cafe`,
`local_florist`, `lunch_dining`, `mail`, `menu_book`, `mic`, `movie`,
`music_note`, `nightlight`, `nordic_walking`, `nutrition`, `palette`, `park`,
`pets`, `phone`, `piano`, `pool`, `psychology`, `restaurant`, `rowing`,
`sailing`, `savings`, `school`, `science`, `self_improvement`,
`shopping_cart`, `skateboarding`, `snowboarding`, `spa`, `sports_bar`,
`sports_basketball`, `sports_esports`, `sports_gymnastics`, `sports_handball`,
`sports_martial_arts`, `sports_soccer`, `sports_tennis`, `sports_volleyball`,
`star`, `sunny`, `surfing`, `terrain`, `theater_comedy`, `timer`,
`travel_explore`, `videocam`, `volunteer_activism`, `water_drop`, `work`,
`yard`.
