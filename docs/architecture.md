# Architecture

```
phone / laptop --Tailscale--> tailscale serve (HTTPS) --> 127.0.0.1:8787
                                                          Life OS server (user: lifeos)
                                                          |- serves app/ (the front-end)
                                                          '- /api --> /var/lib/lifeos/lifeos.db
                                                                       '- nightly snapshot --> /var/lib/lifeos/backups
GitHub repository (public, code only) --> GitHub Pages: the same front-end in demo mode
                                      '-> an install pulls updates from it
```

## The parts

**Front-end (`app/`).** One hand-written `index.html` with inline CSS and
JavaScript, plus static files: fonts, icons, a web app manifest, `config.js`
and `demo.js`. No framework, no build step, no service worker. Every URL is
relative, so the same files work at a domain root (an install) and under a
sub-path (GitHub Pages).

All reading and writing goes through one object, `Store`. It has two modes:

| Mode | Chosen by | Data |
|------|-----------|------|
| `server` | the server's own answer to `/config.js` | Loaded once with `GET api/data`, written document by document through the API, reloaded when the tab becomes visible again. |
| `demo` | `app/config.js` as published in the repository | Built in memory by `app/demo.js` from today's date. Nothing is saved, the API is never called. |

**The plan.** What you set out to do is one list of items (the `plan`
collection, plus every task that has a planned day), shown at two zoom levels:
the week view and the review place an item on a day, the day editor places it
in a part of the day. Both read the same index (`planIdx()`, rebuilt after
every write), so nothing is synchronised. Placing an item is logged silently
in `plan_log`; moving it to another day or skipping it is logged and asks why.
The plan a week started with is frozen on that week's `periods` document, and
the review compares against it. `docs/data-format.md` has the fields.

The mode is never guessed. If `config.js` is missing or the server cannot be
reached, the page says so; it does not fall back to demo data that someone
could type into by mistake. A real install does not serve `demo.js` at all.

Writes are optimistic: the page changes first, then the document is sent.
Each document has its own queue, so writes to one document arrive in order,
and the status dot shows "Saving" until every queue is empty. The last write
to a document wins. A reload skips documents that still have a write pending.

**Server (`server/lifeos/`).** Python, standard library only: `http.server`
for HTTP, `sqlite3` for storage, `hashlib.scrypt` for secrets. It runs as
`python -m lifeos` and always binds `127.0.0.1`; the address is a constant,
not a setting.

| Module | Role |
|--------|------|
| `httpd.py` | Thin adapter from `http.server` to `App.handle()`: body size limits, no access log. |
| `app.py` | Routes, the API, static files, security headers. Takes a request object and returns a response object, so tests call it directly with a fake clock. |
| `auth.py` | Password, sessions, the lock, per-device choices. |
| `db.py` | Tables, validation of collections, ids and documents, export and import, SQL views. |
| `backup.py` | Snapshot with SQLite's backup API, and pruning. |
| `admin.py` | `reset-auth`. |
| `config.py` | Environment variables; reads the running commit from `.git`. |

**Database.** `lifeos.db` in WAL mode. `docs(collection, id, json, updated_at)`
holds every document. `auth` (password hash, pattern hash, failure counter) and
`sessions` are separate tables, which is why a password reset cannot touch the
journal. Views named `v_days`, `v_tasks` and so on expose the main fields for
plain SQL (see `data-format.md`).

**Deployment (`deploy/`).** `install.sh` creates the `lifeos` user, clones the
checkout to `/opt/lifeos` (root-owned), creates `/var/lib/lifeos` (owned by
`lifeos`, mode 700) and installs the systemd units:

| Unit | Role |
|------|------|
| `lifeos.service` | The server. |
| `lifeos-backup.timer` and `.service` | Nightly snapshot, `Persistent=true`. |
| `lifeos-update.timer` and `.service` | An update check every five minutes (optional). |

Options are kept in `/etc/lifeos/lifeos.env`, which is also the units'
`EnvironmentFile`. The snapshot time is a small drop-in file written by the
installer.

## What the privacy rests on

| Layer | What it does |
|-------|--------------|
| Network | The server listens on `127.0.0.1` only. `tailscale serve` is the only way in from other devices, and it only accepts devices of the same tailnet, over HTTPS. No router port, no `tailscale funnel`. |
| Host header | Requests whose `Host` is not a loopback name, a `*.ts.net` name or a name listed in `LIFEOS_ALLOWED_HOSTS` are refused. This stops DNS-rebinding against the loopback port. |
| Service sandbox | Runs as `lifeos` with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, write access to `/var/lib/lifeos` only, no capabilities, and `IPAddressDeny=any` with `IPAddressAllow=localhost`: the process cannot open a connection to any other machine. The code it runs is owned by root. |
| File permissions | `/var/lib/lifeos` and the snapshots are mode 700, owned by `lifeos`. Other accounts on the machine cannot read them without root. |
| Password | scrypt (N = 2^15, r = 8, p = 1) with a random salt per secret, compared in constant time. After five wrong passwords in a row each further attempt must wait, 5 seconds doubling up to 15 minutes; the counter lives in the database, so a restart does not reset it. |
| Session | A random 256-bit token in a cookie that is `HttpOnly`, `Secure` and `SameSite=Strict`. Only its SHA-256 hash is stored. 90 days, renewed with use. |
| Lock | Each session is locked or unlocked, in the database. A locked session gets status 423 from every data endpoint. The page then drops everything it holds in memory and renders only the lock screen. |
| Cross-site requests | Every request that changes something must carry the header `X-LifeOS: 1`, and its `Origin`, when present, must be the app's own. Browsers cannot send that header across origins without a preflight, which the server never grants. |
| Page | A Content-Security-Policy, as a response header and in the page itself, allows only the app's own origin: scripts, styles, fonts, images and connections. Nothing can be loaded from or sent to another host, even by mistake. |

### The lock in detail

A pattern (or, later, another quick-unlock method) never replaces the
password; it only re-opens a session that already exists on that device.

- A session with quick unlock on locks itself when it has been idle for its
  re-lock period. "Idle" is measured on the server: the page reports activity
  at most every 30 seconds, and the server allows 45 seconds of slack.
- With "when I leave the app" the page locks the session when it is hidden,
  after pending writes have been sent, and a freshly opened page always starts
  locked. As a backstop the server locks such a session when the page has not
  been heard from for 75 seconds.
- A correct pattern unlocks. Five wrong ones delete the session.
- Quick unlock is a per-session choice (`pattern` or `none`). A device with
  `none` stays signed in without locking.
- Methods are entries in `UNLOCK_METHODS` (server) and `QUICK` (page). Adding
  one, for example passkeys, means adding an entry to each and a setup flow;
  sessions, the lock state and the screens stay as they are.

### What is not defended

- **Root on the host** can read everything. So can anyone who can become root:
  keep `sudo` behind a password on the host.
- **The repository is the update authority.** With automatic updates on,
  whatever passes the tests on the tracked repository's `main` branch runs on
  the machine within minutes, and `lifeos-update` itself runs as root. Protect the GitHub
  account (two-factor sign-in), or install with `--no-auto-update`.
- **The setup window.** Until a password is set, the first visitor sets it.
  This includes other software on the host itself, which can reach the
  loopback port directly.
- **Lock-out by a tailnet device.** Repeated wrong passwords from any device
  that can reach the server delay everyone's next attempt, by up to 15 minutes.
- **The database is not encrypted at rest.** A stolen disk can be read.
- **Snapshots on the same disk** do not survive that disk.

## Updates and rollback

`lifeos-update` asks the repository where its branches `tested` and `main`
are (one `git ls-remote`) and follows `tested`, or `main` when there is no
`tested`. The Tests workflow moves `tested` to a commit of `main` once every
test has passed for it, so a push that breaks a test never reaches a machine.
The command refuses anything that is not a fast-forward, moves the checkout,
restarts the service and polls `api/health` until it reports the new commit.
If that does not happen within 30 seconds it moves the checkout back and
restarts again, and the timer leaves that commit alone from then on. The timer
runs every five minutes and logs nothing unless it changes something. Unit files and the
installed commands are copies made by `install.sh`; when an update changes
`deploy/`, the update says so and `install.sh` has to be run again.

## Backups

`python -m lifeos.backup` opens the live database, copies it with SQLite's
online backup API to `lifeos-YYYY-MM-DD.db.partial`, runs an integrity check
on the copy and renames it into place. Then it prunes: the newest 30 snapshots
stay, and so does the first snapshot of each of the newest 12 months. The
snapshots live in `/var/lib/lifeos/backups`, on the same disk as the data.

## HTTP interface

| Request | Sign-in | Does |
|---------|---------|------|
| `GET /` and static files | none | The front-end. `index.html` and `config.js` are `no-cache`; font files have a content hash in their name and are cached for a year. |
| `GET /config.js` | none | `window.LIFEOS_MODE='server';` |
| `GET api/health` | none | `{ok, commit}` |
| `GET api/auth/state` | none | `{configured, signedIn, locked, methods, quick, relock}` |
| `POST api/auth/setup` | none, only while no password exists | `{password, pattern?}` |
| `POST api/auth/login` | none | `{password, device?}`; a new unlocked session |
| `POST api/auth/unlock` | session | `{method, secret}` |
| `POST api/auth/lock`, `logout` | session | |
| `POST api/auth/ping`, `device`, `password`, `pattern`, `logout-all` | unlocked session | Activity; per-device choices; change the password or the pattern (both need the current password) |
| `POST api/auth/verify` | unlocked session | `{password}`; says whether it is the current password, counting wrong ones like wrong sign-ins. The page asks before it locks a backup with that password. |
| `GET api/data`, `PUT`/`DELETE api/data/{collection}/{id}`, `POST api/import` | unlocked session | See `data-format.md` |

Answers are JSON. Errors have the shape `{"error": "...", "code": "..."}`:
401 `auth` (not signed in) or `setup` (no password yet), 423 `locked`, 403
`wrong` or `csrf`, 429 `throttled` with `retry_after`, 400 `invalid`.
