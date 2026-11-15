#!/usr/bin/env bash
# Life OS installer. Sets up one machine; safe to run again.
#
#   git clone <this repository> && cd life-os
#   sudo ./deploy/install.sh
#
# What it does (and nothing else):
#   - creates the system user "lifeos" (no login, no password)
#   - puts the code in /opt/lifeos (owned by root, read-only for the service)
#   - keeps the data in /var/lib/lifeos (owned by lifeos, mode 700)
#   - installs a locked-down systemd service that listens on 127.0.0.1 only
#   - installs the nightly snapshot, the update command and the reset command
#
# It does not install or configure Tailscale, a firewall, or anything else.
set -euo pipefail

CODE=/opt/lifeos
DATA=/var/lib/lifeos
ETC=/etc/lifeos
ENV_FILE=$ETC/lifeos.env
UNIT_DIR=/etc/systemd/system
SBIN=/usr/local/sbin
SERVICE_USER=lifeos

usage() {
  cat <<'EOF'
Usage: sudo ./deploy/install.sh [options]

  --backup-time HH:MM      When the nightly snapshot runs (default 03:30).
  --port N                 Local port (default 8787). The server always listens on
                           127.0.0.1 only.
  --allowed-hosts A,B      Extra host names to accept, if you use a reverse proxy
                           other than "tailscale serve".
  --repo URL               Repository to pull updates from (default: the origin of
                           this checkout).
  --no-auto-update         Do not update by itself; only when you run lifeos-update.
  --auto-update            Check for a tested update every five minutes (the
                           default).
  -h, --help               Show this help.

Run again at any time to change an option; options you leave out keep their value.
EOF
}

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\nError: %s\n' "$*" >&2; exit 1; }

# ---------- options ----------
BACKUP_TIME="" PORT="" ALLOWED_HOSTS="" REPO_URL="" AUTO_UPDATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --backup-time)    BACKUP_TIME=${2:?--backup-time needs a value}; shift 2 ;;
    --port)           PORT=${2:?--port needs a value}; shift 2 ;;
    --allowed-hosts)  ALLOWED_HOSTS=${2:?--allowed-hosts needs a value}; shift 2 ;;
    --repo)           REPO_URL=${2:?--repo needs a value}; shift 2 ;;
    --no-auto-update) AUTO_UPDATE=no; shift ;;
    --auto-update)    AUTO_UPDATE=yes; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                usage >&2; die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this with sudo."
command -v systemctl >/dev/null || die "systemd is required."
command -v git >/dev/null || die "git is required (sudo apt install git)."
command -v python3 >/dev/null || die "python3 is required."
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
  || die "Python 3.9 or newer is required (found $(python3 -V 2>&1))."
python3 -c 'import sqlite3, hashlib; hashlib.scrypt' 2>/dev/null \
  || die "this Python lacks sqlite3 or hashlib.scrypt."

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
[ -f "$SRC/server/lifeos/__main__.py" ] || die "run this script from a checkout of the repository."

# Values from an earlier run are the defaults for this one.
old_value() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 || true; }
PORT=${PORT:-$(old_value LIFEOS_PORT)};                   PORT=${PORT:-8787}
ALLOWED_HOSTS=${ALLOWED_HOSTS:-$(old_value LIFEOS_ALLOWED_HOSTS)}
BACKUP_TIME=${BACKUP_TIME:-$(old_value LIFEOS_BACKUP_TIME)}; BACKUP_TIME=${BACKUP_TIME:-03:30}
AUTO_UPDATE=${AUTO_UPDATE:-$(old_value LIFEOS_AUTO_UPDATE)}; AUTO_UPDATE=${AUTO_UPDATE:-yes}

case "$PORT" in ''|*[!0-9]*) die "--port must be a number." ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "--port must be between 1024 and 65535."
printf '%s' "$BACKUP_TIME" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$' || die "--backup-time must look like 03:30."
case "$ALLOWED_HOSTS" in *[!A-Za-z0-9.,:_-]*) die "--allowed-hosts may only contain host names and commas." ;; esac

# ---------- user and folders ----------
say "System user and folders"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  note "user $SERVICE_USER exists"
else
  useradd --system --user-group --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  note "created user $SERVICE_USER (no login shell, no password)"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$DATA"
note "data folder $DATA (owner $SERVICE_USER, mode 700)"

# ---------- code ----------
say "Code in $CODE"
if [ "$SRC" = "$CODE" ]; then
  note "running from the installed copy"
elif [ -d "$CODE/.git" ]; then
  note "already installed at commit $(git -C "$CODE" rev-parse --short HEAD); use lifeos-update to update it"
else
  [ -e "$CODE" ] && die "$CODE exists but is not a Life OS checkout. Move it away first."
  [ -d "$SRC/.git" ] || die "$SRC is not a git checkout; clone the repository instead of copying it."
  # The checkout usually belongs to the person running sudo, not to root, and git
  # refuses to read a repository owned by someone else. Vouch for this one
  # checkout through a temporary git configuration, for these commands only.
  git_home=$(mktemp -d)
  printf '[safe]\n\tdirectory = %s\n\tdirectory = %s/.git\n' "$SRC" "$SRC" > "$git_home/.gitconfig"
  src_git() { HOME=$git_home XDG_CONFIG_HOME=$git_home/.config git "$@"; }
  REPO_URL=${REPO_URL:-$(src_git -C "$SRC" remote get-url origin 2>/dev/null || true)}
  [ -n "$REPO_URL" ] || { rm -rf "$git_home"; die "this checkout has no origin; pass --repo URL so that updates know where to look."; }
  src_git clone --quiet --no-hardlinks "$SRC" "$CODE" || { rm -rf "$git_home"; die "could not copy the checkout to $CODE."; }
  rm -rf "$git_home"
  note "cloned commit $(git -C "$CODE" rev-parse --short HEAD)"
fi
if [ -n "$REPO_URL" ]; then
  git -C "$CODE" remote set-url origin "$REPO_URL"
fi
REPO_URL=$(git -C "$CODE" remote get-url origin)
note "updates come from $REPO_URL"
chown -R root:root "$CODE"
chmod -R u+rwX,go+rX,go-w "$CODE"

# ---------- Python environment ----------
say "Python environment"
VENV=$CODE/venv
if ! "$VENV/bin/python" -c 'import sys' >/dev/null 2>&1; then
  rm -rf "$VENV"
  python3 -m venv "$VENV" >/dev/null 2>&1 || python3 -m venv --without-pip "$VENV" \
    || die "could not create a virtualenv (sudo apt install python3-venv)."
fi
if grep -Eqv '^[[:space:]]*(#|$)' "$CODE/server/requirements.txt"; then
  [ -x "$VENV/bin/pip" ] || die "pip is missing in the virtualenv (sudo apt install python3-venv, then run again)."
  "$VENV/bin/pip" install --quiet --no-input --disable-pip-version-check -r "$CODE/server/requirements.txt"
  note "installed the pinned packages from server/requirements.txt"
else
  note "no third-party packages needed ($("$VENV/bin/python" -V 2>&1))"
fi
chown -R root:root "$VENV"; chmod -R go+rX,go-w "$VENV"

# ---------- backup folder ----------
say "Backup folder"
BACKUP_DIR=$DATA/backups
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$BACKUP_DIR"
note "snapshots: $BACKUP_DIR, every night at $BACKUP_TIME, 30 daily and 12 monthly kept"

# ---------- settings ----------
say "Settings in $ENV_FILE"
install -d -m 755 "$ETC"
cat > "$ENV_FILE" <<EOF
# Life OS settings, written by deploy/install.sh. Change them by running the
# installer again with options; see: sudo $CODE/deploy/install.sh --help
LIFEOS_PORT=$PORT
LIFEOS_DATA=$DATA
LIFEOS_BACKUP_TIME=$BACKUP_TIME
LIFEOS_ALLOWED_HOSTS=$ALLOWED_HOSTS
LIFEOS_AUTO_UPDATE=$AUTO_UPDATE
EOF
chmod 644 "$ENV_FILE"

# ---------- systemd units and commands ----------
say "Service, snapshot timer and commands"
for unit in lifeos.service lifeos-backup.service lifeos-backup.timer lifeos-update.service lifeos-update.timer; do
  install -m 644 "$CODE/deploy/systemd/$unit" "$UNIT_DIR/$unit"
done

install -d -m 755 "$UNIT_DIR/lifeos-backup.timer.d"
cat > "$UNIT_DIR/lifeos-backup.timer.d/10-time.conf" <<EOF
# Written by deploy/install.sh (--backup-time).
[Timer]
OnCalendar=
OnCalendar=*-*-* $BACKUP_TIME:00
EOF
rm -rf "$UNIT_DIR/lifeos-backup.service.d"   # written by earlier versions of this installer

install -m 755 "$CODE/deploy/lifeos-update" "$SBIN/lifeos-update"
install -m 700 "$CODE/deploy/lifeos-reset-password" "$SBIN/lifeos-reset-password"
note "commands: lifeos-update, lifeos-reset-password (both need sudo)"

systemctl daemon-reload
systemctl enable --quiet lifeos.service lifeos-backup.timer
systemctl restart lifeos.service lifeos-backup.timer
if [ "$AUTO_UPDATE" = yes ]; then
  systemctl enable --quiet lifeos-update.timer
  systemctl restart lifeos-update.timer
  note "updates: checked every five minutes (lifeos-update.timer)"
else
  systemctl disable --now --quiet lifeos-update.timer 2>/dev/null || true
  note "updates: only when you run sudo lifeos-update"
fi

# ---------- check ----------
say "Check"
healthy=no
for _ in $(seq 1 30); do
  if "$VENV/bin/python" - "$PORT" <<'EOF' 2>/dev/null
import json, sys, urllib.request
with urllib.request.urlopen("http://127.0.0.1:%s/api/health" % sys.argv[1], timeout=3) as resp:
    sys.exit(0 if json.load(resp).get("ok") else 1)
EOF
  then healthy=yes; break; fi
  sleep 1
done
[ "$healthy" = yes ] || die "the service did not answer on 127.0.0.1:$PORT. Look at: journalctl -u lifeos -n 50"
note "service is running and healthy on http://127.0.0.1:$PORT (this machine only)"
NET_NOTE=""
if journalctl -b --no-pager -q 2>/dev/null | grep -q "does not support BPF/cgroup firewalling"; then
  NET_NOTE="Note: this kernel cannot apply the service's IPAddressDeny network lock (no cgroup BPF). The service still listens on 127.0.0.1 only."
fi

cat <<EOF

Life OS is installed.

  Code      $CODE  (commit $(git -C "$CODE" rev-parse --short HEAD), read-only for the service)
  Data      $DATA  (only the "$SERVICE_USER" user can read it)
  Snapshots $BACKUP_DIR  (nightly at $BACKUP_TIME, on the same disk as the data)
  Service   systemctl status lifeos
${NET_NOTE:+
  $NET_NOTE
}
Next steps
  1. Make it reachable from your own devices only, with Tailscale:
       sudo tailscale serve --bg $PORT
     and open the https://<machine>.<tailnet>.ts.net address it prints.
  2. Choose your password (and a pattern) on the setup screen. Do this soon:
     until a password is set, the first visitor chooses it.
  3. Later:  sudo lifeos-update            update to the newest version
             sudo systemctl start lifeos-backup   take a snapshot now
             sudo lifeos-reset-password    forgot the password (data is kept)
EOF
