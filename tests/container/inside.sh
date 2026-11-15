#!/usr/bin/env bash
# Runs inside the test container (see run.sh). Exercises the whole life cycle
# of an install. The container is unprivileged and has no systemd; "systemctl"
# is the stand-in from fake-systemctl.
set -euo pipefail

step() { printf '\n--- %s\n' "$*"; }
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }
api()  { curl -fsS -H 'X-LifeOS: 1' -H 'Content-Type: application/json' "$@"; }
health_commit() { curl -fsS http://127.0.0.1:"${PORT:-8787}"/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"]; print(d["commit"])'; }
commit() { git -C /work -c user.name=test -c user.email=test@example.com commit -q -am "$1"; git -C /work push -q origin main; }

step "A stand-in for the public repository, and a fresh clone of it"
mkdir /tmp/githome && printf '[safe]\n\tdirectory = *\n' > /tmp/githome/.gitconfig
HOME=/tmp/githome git clone -q --bare /src /srv/origin.git      # /src belongs to the host user
git clone -q /srv/origin.git /work
useradd -m someone
# The usual situation: a normal user clones the repository, then runs the installer as root.
# (The stand-in repository is a local folder owned by root, which a real remote never is.)
runuser -u someone -- git config --global --add safe.directory /srv/origin.git
runuser -u someone -- git clone -q /srv/origin.git /home/someone/life-os

step "install.sh on a clean machine"
/home/someone/life-os/deploy/install.sh --backup-time 02:40
[ "$(git -C /opt/lifeos remote get-url origin)" = /srv/origin.git ] || fail "origin of the installed copy"
[ "$(stat -c '%U' /opt/lifeos/server/lifeos/app.py)" = root ] || fail "installed code is not owned by root"
systemctl is-active --quiet lifeos.service || fail "service not active"
for unit in lifeos.service lifeos-backup.service lifeos-backup.timer lifeos-update.service lifeos-update.timer; do
  [ "$(stat -c '%U %a' /etc/systemd/system/$unit)" = "root 644" ] || fail "unit file $unit"
done
grep -q '^OnCalendar=\*-\*-\* 02:40:00$' /etc/systemd/system/lifeos-backup.timer.d/10-time.conf || fail "backup time not written"
grep -q '^Persistent=true$' /etc/systemd/system/lifeos-backup.timer || fail "timer is not persistent"
systemctl is-enabled --quiet lifeos.service || fail "service not enabled"
systemctl is-enabled --quiet lifeos-backup.timer || fail "backup timer not enabled"
systemctl is-enabled --quiet lifeos-update.timer || fail "update timer not enabled"
[ "$(health_commit)" = "$(git -C /opt/lifeos rev-parse HEAD | cut -c1-12)" ] || fail "health does not report the installed commit"

step "Only 127.0.0.1"
listeners=$(ss -Hltn | awk '{print $4}' | sort | tr '\n' ' ')      # every listening socket in this container
echo "listening: $listeners"
[ "$listeners" = "127.0.0.1:8787 " ] || fail "unexpected listeners: $listeners"

step "User, ownership and permissions"
getent passwd lifeos
getent passwd lifeos | grep -q ':/usr/sbin/nologin$' || fail "lifeos has a login shell"
passwd -S lifeos | awk '{print $2}' | grep -qx 'L' || fail "lifeos has a usable password"
[ "$(stat -c '%U:%G %a' /var/lib/lifeos)" = "lifeos:lifeos 700" ] || fail "data folder ownership or mode"
[ "$(stat -c '%U:%G %a' /var/lib/lifeos/backups)" = "lifeos:lifeos 700" ] || fail "backup folder ownership or mode"
[ "$(stat -c '%a' /var/lib/lifeos/lifeos.db)" = "600" ] || fail "database mode"
if runuser -u someone -- ls /var/lib/lifeos >/dev/null 2>&1; then fail "another user can read the data folder"; fi
if runuser -u lifeos -- test -w /opt/lifeos/server/lifeos/app.py; then fail "the service user can write the code"; fi
if runuser -u lifeos -- touch /opt/lifeos/x 2>/dev/null; then fail "the service user can write into /opt/lifeos"; fi
[ "$(stat -c '%U %a' /usr/local/sbin/lifeos-reset-password)" = "root 700" ] || fail "reset command must be root-only"
if runuser -u someone -- /usr/local/sbin/lifeos-reset-password --yes >/dev/null 2>&1; then fail "reset ran without root"; fi

step "Set a password and write something (through the API, as the browser would)"
jar=/tmp/jar
# curl only sends Secure cookies over https, so pass the cookie by hand.
token=$(api -D - -o /dev/null -X POST -d '{"password":"container test password","pattern":"01258"}' http://127.0.0.1:8787/api/auth/setup | sed -n 's/^Set-Cookie: \(lifeos_session=[^;]*\).*/\1/p' | tr -d '\r')
[ -n "$token" ] || fail "no session cookie"
api -o /dev/null -X PUT -b "$token" -d '{"id":"t_1","title":"survives everything"}' http://127.0.0.1:8787/api/data/tasks/t_1
api -b "$token" http://127.0.0.1:8787/api/data | grep -q 'survives everything' || fail "document not stored"
echo "ok"

step "Snapshot now"
systemctl start lifeos-backup.service
ls /var/lib/lifeos/backups | grep -Eq '^lifeos-[0-9]{4}-[0-9]{2}-[0-9]{2}\.db$' || fail "no snapshot file"
[ "$(stat -c '%U %a' /var/lib/lifeos/backups/lifeos-*.db)" = "lifeos 600" ] || fail "snapshot mode"

step "install.sh again changes options and keeps everything else"
/opt/lifeos/deploy/install.sh --backup-time 01:15 --no-auto-update >/dev/null
grep -q '^OnCalendar=\*-\*-\* 01:15:00$' /etc/systemd/system/lifeos-backup.timer.d/10-time.conf || fail "backup time not changed"
if systemctl is-enabled --quiet lifeos-update.timer; then fail "update timer still enabled"; fi
/opt/lifeos/deploy/install.sh --auto-update >/dev/null
systemctl is-enabled --quiet lifeos-update.timer || fail "update timer not re-enabled"
grep -q '^LIFEOS_BACKUP_TIME=01:15$' /etc/lifeos/lifeos.env || fail "options are not remembered"
api -b "$token" http://127.0.0.1:8787/api/data | grep -q 'survives everything' || fail "data or session lost by a re-install"
echo "ok"

step "lifeos-update: nothing new"
lifeos-update

step "lifeos-update: a good commit goes live"
echo "# a harmless change" >> /work/server/requirements.txt
commit "harmless change"
lifeos-update
[ "$(health_commit)" = "$(git -C /work rev-parse HEAD | cut -c1-12)" ] || fail "the new commit is not running"

step "lifeos-update: a broken commit is rolled back"
good=$(health_commit)
echo "this is not python" >> /work/server/lifeos/app.py
commit "broken change"
if lifeos-update; then fail "a broken update reported success"; fi
[ "$(health_commit)" = "$good" ] || fail "not rolled back to $good"
[ "$(git -C /opt/lifeos rev-parse HEAD | cut -c1-12)" = "$good" ] || fail "checkout not rolled back"
started=$(pgrep -o -u lifeos -f -- '-m lifeos$')
out=$(lifeos-update --auto 2>&1) || fail "the timer's run failed on a commit that was already rolled back"
[ -z "$out" ] || fail "the timer tried the rolled-back commit again: $out"
[ "$(pgrep -o -u lifeos -f -- '-m lifeos$')" = "$started" ] || fail "the service was restarted for a commit that had already failed"
git -C /work -c user.name=test -c user.email=test@example.com revert --no-edit HEAD >/dev/null
git -C /work push -q origin main
lifeos-update
[ "$(health_commit)" = "$(git -C /work rev-parse HEAD | cut -c1-12)" ] || fail "the fixed commit is not running"

step "lifeos-update follows the tested branch once the repository has one"
git -C /work push -q origin main:tested                       # the tests passed for the running commit
tested=$(health_commit)
echo "# not tested yet" >> /work/server/requirements.txt
commit "a change whose tests have not passed"
lifeos-update | grep -q 'has not passed the tests' || fail "no word about the untested commit on main"
[ -z "$(lifeos-update --auto 2>&1)" ] || fail "the timer's run is not quiet when there is nothing to do"
[ "$(health_commit)" = "$tested" ] || fail "an untested commit went live"
git -C /work push -q origin main:tested                       # now they passed
lifeos-update
[ "$(health_commit)" = "$(git -C /work rev-parse HEAD | cut -c1-12)" ] || fail "the tested commit is not running"
git -C /work push -q -f origin HEAD~1:tested                  # tested behind the installed commit
lifeos-update | grep -q 'nothing to do' || fail "an install ahead of tested should stay where it is"
[ "$(health_commit)" = "$(git -C /work rev-parse HEAD | cut -c1-12)" ] || fail "moved backwards to an older tested commit"
git -C /work push -q origin main:tested
echo "ok"

step "lifeos-update --auto: an unreachable repository is not an error; the timer's unit works"
git -C /opt/lifeos remote set-url origin /srv/missing.git
out=$(timeout 60 lifeos-update --auto 2>&1) || fail "the timer's run failed because the repository was unreachable"
[ -z "$out" ] || fail "the timer's run is not quiet when the repository is unreachable: $out"
if lifeos-update >/dev/null 2>&1; then fail "manual update should fail when the repository is unreachable"; fi
git -C /opt/lifeos remote set-url origin /srv/origin.git
systemctl start lifeos-update.service
api -b "$token" http://127.0.0.1:8787/api/data | grep -q 'survives everything' || fail "data or session lost by updates"

step "lifeos-reset-password keeps the data"
lifeos-reset-password --yes
curl -fsS http://127.0.0.1:8787/api/auth/state | grep -q '"configured":false' || fail "password not cleared"
token=$(api -D - -o /dev/null -X POST -d '{"password":"a brand new password"}' http://127.0.0.1:8787/api/auth/setup | sed -n 's/^Set-Cookie: \(lifeos_session=[^;]*\).*/\1/p' | tr -d '\r')
api -b "$token" http://127.0.0.1:8787/api/data | grep -q 'survives everything' || fail "data lost by the reset"
echo "ok"

step "uninstall.sh keeps the data unless asked"
/opt/lifeos/deploy/uninstall.sh
[ ! -e /opt/lifeos ] && [ ! -e /etc/systemd/system/lifeos.service ] && [ ! -e /usr/local/sbin/lifeos-update ] || fail "leftovers after uninstall"
if curl -fsS -m 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then fail "still running after uninstall"; fi
[ -f /var/lib/lifeos/lifeos.db ] || fail "uninstall deleted the data"

step "install again on top of existing data, then uninstall with --delete-data"
/home/someone/life-os/deploy/install.sh --repo /srv/origin.git >/dev/null
token=$(api -D - -o /dev/null -X POST -d '{"password":"a brand new password"}' http://127.0.0.1:8787/api/auth/login | sed -n 's/^Set-Cookie: \(lifeos_session=[^;]*\).*/\1/p' | tr -d '\r')
api -b "$token" http://127.0.0.1:8787/api/data | grep -q 'survives everything' || fail "data not found after re-install"
echo "no" | /opt/lifeos/deploy/uninstall.sh --delete-data | tail -n 1
[ -f /var/lib/lifeos/lifeos.db ] || fail "data deleted without the confirmation phrase"
echo "delete my journal" | /opt/lifeos/deploy/uninstall.sh --delete-data | tail -n 2
[ ! -e /var/lib/lifeos ] || fail "data not deleted"
if id lifeos >/dev/null 2>&1; then fail "user not removed"; fi

printf '\nAll install, update, reset and uninstall checks passed.\n'
