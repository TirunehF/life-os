#!/usr/bin/env bash
# Remove Life OS from this machine.
#
#   sudo ./deploy/uninstall.sh                 remove the service and the code;
#                                              the data and the snapshots stay
#   sudo ./deploy/uninstall.sh --delete-data   also delete the journal data, the
#                                              snapshots and the "lifeos" user
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
delete_data=no
case "${1:-}" in
  --delete-data) delete_data=yes ;;
  "") ;;
  *) echo "Usage: sudo ./deploy/uninstall.sh [--delete-data]" >&2; exit 1 ;;
esac

env_file=/etc/lifeos/lifeos.env
data=$(sed -n 's/^LIFEOS_DATA=//p' "$env_file" 2>/dev/null | tail -n 1); data=${data:-/var/lib/lifeos}
backups=$(sed -n 's/^LIFEOS_BACKUP_DIR=//p' "$env_file" 2>/dev/null | tail -n 1); backups=${backups:-$data/backups}

if [ "$delete_data" = yes ]; then
  echo "This deletes your journal for good:"
  echo "  $data"
  echo "  $backups"
  printf 'Type "delete my journal" to continue: '
  read -r answer
  [ "$answer" = "delete my journal" ] || { echo "Nothing changed."; exit 0; }
fi

units="lifeos.service lifeos-backup.timer lifeos-backup.service lifeos-update.timer lifeos-update.service"
for unit in $units; do
  systemctl disable --now --quiet "$unit" 2>/dev/null || true
  rm -f "/etc/systemd/system/$unit"
  rm -rf "/etc/systemd/system/$unit.d"
done
systemctl daemon-reload
rm -f /usr/local/sbin/lifeos-update /usr/local/sbin/lifeos-reset-password
rm -rf /etc/lifeos
case "$(pwd -P)/" in /opt/lifeos/*) cd / ;; esac
rm -rf /opt/lifeos
echo "Removed the service, the commands and the code in /opt/lifeos."

if [ "$delete_data" = yes ]; then
  case "$backups" in /|/var|/var/lib|/home|/mnt|/media|"") echo "Refusing to delete $backups." >&2; exit 1 ;; esac
  case "$data" in /var/lib/lifeos) ;; *) echo "Refusing to delete the unexpected data folder $data." >&2; exit 1 ;; esac
  rm -rf "$backups" "$data"
  userdel lifeos 2>/dev/null || true
  echo "Deleted the data, the snapshots and the lifeos user."
else
  echo "Your data is still in $data and the snapshots in $backups (readable with sudo only)."
  echo "To delete them too: sudo ./deploy/uninstall.sh --delete-data"
fi
echo "If you exposed it with Tailscale, turn that off with: sudo tailscale serve reset"
