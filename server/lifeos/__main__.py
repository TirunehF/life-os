"""Run the server:  python -m lifeos

Environment: LIFEOS_DATA (data directory), LIFEOS_PORT (default 8787),
LIFEOS_ALLOWED_HOSTS (extra Host names, comma separated).
"""
import os

from .config import Config
from .httpd import run


def main():
    os.umask(0o077)   # the database is readable by the service user only
    run(Config.from_env())


if __name__ == "__main__":
    main()
