"""Settings, read from the environment once at start."""
import os

# The server only ever listens on the loopback interface. Other devices reach
# it through `tailscale serve`. This is deliberately not configurable.
HOST = "127.0.0.1"
DEFAULT_PORT = 8787

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def read_commit(root):
    """Short hash of the checked-out commit, read straight from .git (no git binary needed)."""
    git = os.path.join(root, ".git")
    try:
        with open(os.path.join(git, "HEAD"), encoding="ascii") as fh:
            head = fh.read().strip()
        if not head.startswith("ref: "):
            return head[:12]
        ref = head[5:]
        ref_file = os.path.join(git, *ref.split("/"))
        if os.path.exists(ref_file):
            with open(ref_file, encoding="ascii") as fh:
                return fh.read().strip()[:12]
        with open(os.path.join(git, "packed-refs"), encoding="ascii") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) == 2 and parts[1] == ref:
                    return parts[0][:12]
    except (OSError, ValueError):
        pass
    return "unknown"


class Config:
    def __init__(self, data_dir, app_dir=None, port=DEFAULT_PORT, allowed_hosts=(), commit=None):
        self.data_dir = os.path.abspath(data_dir)
        self.app_dir = os.path.realpath(app_dir or os.path.join(ROOT, "app"))
        self.port = int(port)
        self.allowed_hosts = {h.strip().lower() for h in allowed_hosts if h.strip()}
        self.commit = commit or read_commit(ROOT)

    @classmethod
    def from_env(cls, env=os.environ):
        return cls(
            data_dir=env.get("LIFEOS_DATA") or os.path.join(ROOT, "data"),
            app_dir=env.get("LIFEOS_APP") or None,
            port=env.get("LIFEOS_PORT") or DEFAULT_PORT,
            allowed_hosts=(env.get("LIFEOS_ALLOWED_HOSTS") or "").split(","),
            commit=env.get("LIFEOS_COMMIT") or None,
        )
