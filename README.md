# Life OS

**Try the demo: <https://tirunehf.github.io/life-os/>** (example data, nothing is saved)

Life OS is a private journal, habit tracker, sport log and task list in one
page: a calendar where each day has a rating, a focus, habits, sport, people
and notes, plus weekly and monthly reviews. It runs on a machine you own, such
as a Raspberry Pi, keeps everything in one SQLite file there, and is reachable
only from your own devices.

- **Yours.** The data never leaves your machine. The running app loads nothing
  from the internet and sends nothing to it.
- **Private by construction.** The server listens on `127.0.0.1` only. Your
  phone and laptop reach it through [Tailscale](https://tailscale.com), over
  HTTPS, and nobody else can.
- **Small.** One hand-written HTML file, a Python server that uses only the
  standard library, no build step, no packages to install.
- **Locked.** One password per install, a device session that lasts, and an
  optional pattern that re-locks each device after a few minutes away. The
  lock is enforced by the server, not by the page.

## What you need

- A Linux machine that stays on, with systemd (Raspberry Pi OS, Debian, Ubuntu).
- Python 3.9 or newer and git, both from the OS.
- A free Tailscale account, with Tailscale on that machine and on your devices.

## Install

On the machine that will host it:

```sh
git clone https://github.com/TirunehF/life-os.git
cd life-os
sudo ./deploy/install.sh
```

The installer creates a system user `lifeos` without a login, puts the code in
`/opt/lifeos` and the data in `/var/lib/lifeos` (readable by `lifeos` only), and
starts a locked-down service on `127.0.0.1:8787`. It does not touch anything
else on the machine. Run `./deploy/install.sh --help` for the options; running
it again later changes an option and keeps the rest.

## Reach it from your devices

1. Install Tailscale on the host and sign in: `sudo tailscale up`.
2. In the Tailscale admin console, under DNS, enable MagicDNS and HTTPS
   certificates (once per account).
3. Expose the local port to your own devices, and only to them:

   ```sh
   sudo tailscale serve --bg 8787
   ```

   It prints an address like `https://<machine>.<tailnet>.ts.net`.
4. Install Tailscale on your phone and laptop with the same account, and open
   that address.

Never use `tailscale funnel` for this, and do not open a router port: both
would put your journal on the public internet.

## First start

The first visit shows a setup screen: choose a password of at least 10
characters and, if you like, draw a pattern. Do this right after installing;
until a password exists, whoever opens the page first chooses it.

- **Password** signs a device in. The session lasts 90 days and renews itself
  whenever you use the app, so you rarely type it.
- **Pattern** is the quick way back in on a device that is already signed in.
  A device locks itself after a period without activity (5 minutes by default;
  "when I leave the app", 15 minutes or 1 hour are the other choices). Five
  wrong patterns end the session, and the password is needed again.
- Both are set per install; whether a device uses the pattern, and how soon it
  locks, is chosen per device in Settings, under Security.

On Android, open the address in Chrome and choose "Add to Home screen" to get
a full-screen app named Life OS.

## Backups

A snapshot of the database is taken every night (03:30 unless you pass
`--backup-time`), as `lifeos-YYYY-MM-DD.db`. The last 30 daily and 12 monthly
snapshots are kept.

By default they go to an external disk if exactly one is mounted, and
otherwise to `/var/lib/lifeos/backups`, on the same disk as the data. That
protects you from mistakes and from a damaged database, not from a dead disk.
To use another disk:

```sh
sudo /opt/lifeos/deploy/install.sh --backup-dir /mnt/your-disk/lifeos-backups
```

A disk formatted as exFAT, FAT or NTFS has no file permissions; the installer
then tells you the mount options that keep the snapshots private.

You can also download everything from the app at any time: Settings, Schema
and data, "Export everything (JSON)".

```sh
sudo systemctl start lifeos-backup          # take a snapshot now
sudo ls -l /var/lib/lifeos/backups          # list them
```

To restore a snapshot (this also brings back the password of that day):

```sh
sudo systemctl stop lifeos
sudo rm -f /var/lib/lifeos/lifeos.db-wal /var/lib/lifeos/lifeos.db-shm
sudo -u lifeos cp /var/lib/lifeos/backups/lifeos-YYYY-MM-DD.db /var/lib/lifeos/lifeos.db
sudo systemctl start lifeos
```

## Forgot the password

```sh
sudo lifeos-reset-password
```

clears the password, the pattern and every sign-in. The setup screen appears
again; the journal is untouched.

## Updates

```sh
sudo lifeos-update
```

fetches the newest commit of this repository's `main` branch, restarts the
service, and checks that it answers. If it does not, the previous version is
restored. By default the same check also runs once after each boot; install
with `--no-auto-update` if you prefer to update by hand. An install follows
the repository it was cloned from, so fork it if you want to decide what your
machine runs.

## Uninstall

```sh
sudo /opt/lifeos/deploy/uninstall.sh                  # keeps your data
sudo /opt/lifeos/deploy/uninstall.sh --delete-data    # deletes it, after asking
```

## How it is built

```
phone / laptop --Tailscale--> tailscale serve (HTTPS) --> 127.0.0.1:8787
                                                          Life OS server (user: lifeos)
                                                          |- serves app/ (the front-end)
                                                          '- /api --> /var/lib/lifeos/lifeos.db
                                                                       '- nightly snapshot
```

| Folder    | What is in it |
|-----------|---------------|
| `app/`    | The front-end: `index.html`, fonts, icons, and the demo data generator. |
| `server/` | The Python server (`python -m lifeos`), standard library only. |
| `deploy/` | Installer, systemd units, update, reset and uninstall. |
| `tests/`  | Server tests, a headless-browser smoke test, an installer test. |
| `docs/`   | [`data-format.md`](docs/data-format.md): every collection and field, for importers. [`architecture.md`](docs/architecture.md): how the parts fit and what the security rests on. |

The same `app/` folder is this repository's demo page: `app/config.js` selects
demo mode there, while an installed server answers `/config.js` itself and
selects server mode.

## Development

```sh
tests/run.sh                 # everything: needs Python 3, Node 22+ and Chrome
tests/container/run.sh       # the installer, in a throwaway Docker container

# run the server against an empty local database
LIFEOS_DATA=/tmp/lifeos-dev python3 -m lifeos        # from the server/ folder
```

Then open <http://127.0.0.1:8787>. To look at the demo locally, serve `app/`
with any static file server.

The fonts in `app/fonts/` are Instrument Sans and seven other text faces under
the SIL Open Font License, and Material Symbols under the Apache License 2.0;
the licence texts are next to the files.
