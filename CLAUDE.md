# Life OS: standing rules for agent sessions

Life OS is one person's private journal. It runs on their own machine, behind
Tailscale, and this repository is public. Read `README.md` and
`docs/architecture.md` before changing anything. These rules hold for every
session, whether it runs on the owner's laptop or in the cloud with only this
repository.

## Rules that override everything else

1. **Never read real data.** Do not open, copy, print or query
   `/var/lib/lifeos`, any snapshot of it, or any export file the owner
   produces, on any machine. Develop and test only with generated data
   (`app/demo.js`, the fixtures in `tests/`). If a task seems to need real
   data, stop and ask.
2. **Nothing private in the repository.** No real names, host names, IP
   addresses, home folders, tailnet names or journal entries, in code, tests,
   docs or commit messages. Notes about the owner's own machines belong in
   files that are git-ignored (`HANDOFF.md`, `DECISIONS.md`, `BRIEF.md`).
   `tests/test_static.py` checks for the common slips.
3. **The interface does not change unless the task says so.** Do not
   reformat, minify, re-indent or restructure `app/index.html`. Make small,
   targeted edits so that the diff stays reviewable. The first commit holds
   the original file; `git diff 78ea1f3 -- app/index.html` shows everything
   that has changed since.
4. **No build step, no framework.** The front-end is one hand-written HTML
   file plus static files.
5. **No outside hosts at runtime.** The running app loads nothing from and
   sends nothing to another host. Fonts live in `app/fonts/`. The
   Content-Security-Policy (in `server/lifeos/app.py` and in the page) must
   keep allowing `'self'` only.
6. **Private by construction.** The server binds `127.0.0.1` and that stays a
   constant. Access from other devices is `tailscale serve` only. Never
   `tailscale funnel`, never a router port, never `0.0.0.0`.
7. **Few dependencies.** The server uses only the Python standard library.
   If a package ever becomes necessary, pin its exact version in
   `server/requirements.txt` and say why in the commit.
8. **The lock is enforced by the server.** A locked or signed-out session
   must get no data from any endpoint, and the page must hold none. Do not
   add an endpoint that returns data without going through
   `require_unlocked()`.
9. **On the owner's machines, change only Life OS.** No reboots, no firewall
   changes, nothing that touches other services, login sessions or the
   display. Never start a privileged container or an init system in a
   container on a desktop machine; `tests/container/` is unprivileged on
   purpose.

## Map

| Path | What |
|------|------|
| `app/index.html` | The whole front-end. `Store` is the only storage layer; `Auth` holds sign-in and lock; `SCHEMA` lists the nine collections. |
| `app/demo.js` | Pure function that builds the example data for demo mode. |
| `app/config.js` | Selects demo mode. The server answers `/config.js` itself with server mode. |
| `server/lifeos/` | The server. `app.py` routes, `auth.py` login and lock, `db.py` storage and validation. |
| `deploy/` | `install.sh`, systemd units, `lifeos-update`, `lifeos-reset-password`, `uninstall.sh`. |
| `docs/data-format.md` | The contract for exports, imports and backups. Change it together with `SCHEMA` and `db.py`. |
| `tools/` | Developer tools, never used at runtime: `fetch-fonts.py`, `make-icons.py`. |

## Tests

Run all of these before committing; none needs a package to be installed.

```sh
python3 -m unittest discover -s tests     # server, validation, lock, static checks
node --test tests/demo.test.mjs           # demo data on faked dates
node tests/smoke.mjs                      # headless Chrome, both modes (Node 22+, Chrome)
tests/container/run.sh                    # installer life cycle (Docker, unprivileged)
```

`tests/run.sh` runs the first three. The smoke test fails on any console
error, uncaught exception or request to another host, so run it after every
change to `app/`. `SHOTS=/some/folder node tests/smoke.mjs` saves screenshots.

When you change behaviour, change the test that covers it in the same commit:
`tests/test_server.py` for the API and the lock, `tests/smoke.mjs` for
anything a person sees.

## Recurring tasks

- **A new icon.** Add its name to `ICON_NAMES` in `tools/fetch-fonts.py`
  (sorted), run the tool, paste the printed `@font-face` rules over the ones
  at the top of the `<style>` block, and add the name to `ICONS` in
  `index.html` if the icon picker should offer it. Font file names carry a
  content hash, so commit the new files and delete the old ones.
- **A new field.** Add it to `SCHEMA`, to `docs/data-format.md`, to the
  matching view in `db.py`, and to `app/demo.js` so the demo shows it.
- **A new collection.** Also `COLLECTIONS` and `doc_id()` in `db.py` and
  `docId()` in the page; the two id rules must agree.
- **A new quick-unlock method.** One entry in `UNLOCK_METHODS` (server) and
  one in `QUICK` (page), plus its setup flow in Settings.

## How it gets to a machine

- Every push to `main` publishes `app/` to GitHub Pages as the demo
  (`.github/workflows/pages.yml`).
- An install follows `main` of the repository it was cloned from:
  `sudo lifeos-update` fetches it, restarts the service and rolls back if
  `api/health` does not report the new commit. With update-at-boot on (the
  default) this also happens once after every boot. So **everything pushed to
  `main` goes live on the owner's machine**: keep `main` working, and never
  push anything you have not tested.
- A change under `deploy/` is not applied by an update. It needs
  `sudo /opt/lifeos/deploy/install.sh` on the machine, run by the owner.
- Commit with a clear message that says what changed and why.
