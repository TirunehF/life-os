"""Maintenance commands:  python -m lifeos.admin <command>

  reset-auth   Forget the password, the pattern and every device session, so
               the setup screen appears again. The journal data is not touched.
"""
import os
import sys

from . import auth, db
from .config import Config


def reset_auth(data_dir):
    if not os.path.exists(db.db_path(data_dir)):
        raise SystemExit("No database in %s." % data_dir)
    con = db.connect(data_dir)
    try:
        before = con.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
        auth.reset(con)
        after = con.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
    finally:
        con.close()
    if before != after:
        raise SystemExit("Unexpected: the document count changed during the reset.")
    print("Password, pattern and all sessions cleared. Open the app to choose a new password.")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["reset-auth"]:
        os.umask(0o077)
        reset_auth(Config.from_env().data_dir)
        return 0
    print(__doc__.strip())
    return 2


if __name__ == "__main__":
    sys.exit(main())
