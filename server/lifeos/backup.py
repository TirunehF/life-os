"""Nightly snapshot:  python -m lifeos.backup

Takes a consistent copy of the database with SQLite's backup API into the
"backups" folder next to it, as lifeos-YYYY-MM-DD.db, checks it, then prunes
old copies:
the newest 30 daily snapshots are kept, plus the first snapshot of each of
the newest 12 months.
"""
import datetime
import os
import re
import sqlite3
import sys

from . import db
from .config import Config

KEEP_DAILY = 30
KEEP_MONTHLY = 12
NAME_RE = re.compile(r"^lifeos-(\d{4})-(\d{2})-(\d{2})\.db$")


def to_delete(names, keep_daily=KEEP_DAILY, keep_monthly=KEEP_MONTHLY):
    """Which snapshot file names to remove. Names that do not look like snapshots are ignored."""
    snapshots = sorted(n for n in names if NAME_RE.match(n))
    keep = set(snapshots[-keep_daily:]) if keep_daily else set()
    first_of_month = {}
    for name in snapshots:
        first_of_month.setdefault(name[7:14], name)   # "YYYY-MM" -> earliest snapshot
    for month in sorted(first_of_month)[-keep_monthly:] if keep_monthly else []:
        keep.add(first_of_month[month])
    return [n for n in snapshots if n not in keep]


def snapshot(data_dir, backup_dir, today=None):
    """Write today's snapshot and prune. Returns (file name, size, removed names)."""
    source_path = db.db_path(data_dir)
    if not os.path.exists(source_path):
        raise SystemExit("No database at %s yet; nothing to back up." % source_path)
    os.makedirs(backup_dir, mode=0o700, exist_ok=True)
    name = "lifeos-%s.db" % (today or datetime.date.today()).isoformat()
    final = os.path.join(backup_dir, name)
    partial = final + ".partial"
    if os.path.exists(partial):
        os.remove(partial)

    source = sqlite3.connect(source_path, timeout=30)
    target = sqlite3.connect(partial)
    try:
        source.backup(target)
        result = target.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        target.close()
        source.close()
    if result != "ok":
        os.remove(partial)
        raise SystemExit("Snapshot failed the integrity check; the previous snapshots are untouched.")
    os.replace(partial, final)

    removed = to_delete(os.listdir(backup_dir))
    for old in removed:
        os.remove(os.path.join(backup_dir, old))
    return name, os.path.getsize(final), removed


def main():
    os.umask(0o077)
    config = Config.from_env()
    backup_dir = os.path.join(config.data_dir, "backups")
    name, size, removed = snapshot(config.data_dir, backup_dir)
    kept = len([n for n in os.listdir(backup_dir) if NAME_RE.match(n)])
    print("Snapshot %s written to %s (%d bytes, integrity ok). Keeping %d, removed %d."
          % (name, backup_dir, size, kept, len(removed)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
