"""Login, device sessions and the quick-unlock lock.

One install belongs to one person, so there are no user names: a password
creates a device session, and a pattern (or, later, another quick-unlock
method) re-opens a session that has locked itself after a period without
activity. The lock is enforced here, on the server.
"""
import base64
import hashlib
import hmac
import math
import os
import re
import secrets
import threading

COOKIE = "lifeos_session"
SESSION_TTL = 90 * 24 * 3600      # a session lasts 90 days ...
RENEW_AFTER = 24 * 3600           # ... and is extended once it is a day old
MIN_PASSWORD = 10
MAX_SECRET_BYTES = 1024

RELOCK_CHOICES = (0, 300, 900, 3600)   # 0 = "when I leave the app"
DEFAULT_RELOCK = 300
IDLE_GRACE = 45                   # slack for the client's throttled activity pings
LEAVE_IDLE = 75                   # "leave" mode: lock if the page stops pinging

MAX_PASSWORD_FAILS = 5            # then a growing delay between attempts
MAX_DELAY = 15 * 60
MAX_UNLOCK_FAILS = 5              # then the session ends

SCRYPT_LOG_N = 15                 # tests lower this to stay fast
_SCRYPT_R, _SCRYPT_P, _SCRYPT_LEN = 8, 1, 32

PATTERN_RE = re.compile(r"^[0-8]{4,9}$")

# Password and pattern checks are serialised so that the failure counters cannot be raced.
_password_lock = threading.Lock()
_unlock_lock = threading.Lock()


class AuthError(Exception):
    """Carries an HTTP status, a machine-readable code and extra fields."""

    def __init__(self, status, code, message, **extra):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


# ---------- secrets ----------

def _b64(raw):
    return base64.b64encode(raw).decode("ascii")


def _scrypt(secret, salt, log_n, r, p):
    n = 1 << log_n
    return hashlib.scrypt(secret.encode("utf-8"), salt=salt, n=n, r=r, p=p,
                          dklen=_SCRYPT_LEN, maxmem=256 * n * r + (1 << 20))


def hash_secret(secret):
    """scrypt with a fresh random salt; the parameters travel with the hash."""
    salt = os.urandom(16)
    digest = _scrypt(secret, salt, SCRYPT_LOG_N, _SCRYPT_R, _SCRYPT_P)
    return "scrypt$%d$%d$%d$%s$%s" % (SCRYPT_LOG_N, _SCRYPT_R, _SCRYPT_P, _b64(salt), _b64(digest))


def verify_secret(secret, stored):
    try:
        scheme, log_n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = _scrypt(secret, base64.b64decode(salt), int(log_n), int(r), int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def _valid_secret(value):
    return isinstance(value, str) and 0 < len(value.encode("utf-8")) <= MAX_SECRET_BYTES


def check_new_password(password):
    if not _valid_secret(password) or len(password) < MIN_PASSWORD:
        raise AuthError(400, "weak", "The password needs at least %d characters." % MIN_PASSWORD)


def check_new_pattern(pattern):
    if not isinstance(pattern, str) or not PATTERN_RE.match(pattern) or len(set(pattern)) != len(pattern):
        raise AuthError(400, "bad_pattern", "A pattern connects at least 4 dots, each used once.")


# ---------- key/value state ----------

def _get(con, key, default=None):
    row = con.execute("SELECT value FROM auth WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def _set(con, key, value):
    con.execute("INSERT INTO auth (key, value) VALUES (?, ?) "
                "ON CONFLICT (key) DO UPDATE SET value = excluded.value", (key, str(value)))


def _unset(con, key):
    con.execute("DELETE FROM auth WHERE key = ?", (key,))


def configured(con):
    return _get(con, "password") is not None


def has_pattern(con):
    return _get(con, "pattern") is not None


# Quick-unlock methods. A later method (for example passkeys) registers here
# with a check function, and becomes one more value of a session's `quick`.
def _check_pattern(con, secret):
    stored = _get(con, "pattern")
    return bool(stored) and _valid_secret(secret) and verify_secret(secret, stored)


UNLOCK_METHODS = {"pattern": (has_pattern, _check_pattern)}


def available_methods(con):
    return [name for name, (enabled, _check) in UNLOCK_METHODS.items() if enabled(con)]


# ---------- sessions ----------

class Session:
    def __init__(self, row):
        (self.token_hash, self.created_at, self.expires_at, self.last_seen,
         locked, self.quick_pref, self.relock, self.unlock_fails) = row
        self.locked = bool(locked)
        self.renewed = False
        self.quick = "none"       # effective method, filled in by load_session


_COLUMNS = "token_hash, created_at, expires_at, last_seen, locked, quick, relock, unlock_fails"


def _hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _effective_quick(con, pref):
    methods = available_methods(con)
    if pref == "none" or not methods:
        return "none"
    return pref if pref in methods else methods[0]


def idle_limit(relock):
    return LEAVE_IDLE if relock == 0 else relock + IDLE_GRACE


def _clean_device(device):
    """Per-device preferences sent by the client; unknown values fall back to defaults."""
    device = device if isinstance(device, dict) else {}
    quick = device.get("quick")
    relock = device.get("relock")
    return (quick if quick in ("none",) + tuple(UNLOCK_METHODS) else None,
            relock if relock in RELOCK_CHOICES and not isinstance(relock, bool) else DEFAULT_RELOCK)


def _create_session(con, now, quick=None, relock=DEFAULT_RELOCK):
    token = secrets.token_urlsafe(32)
    con.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(now),))
    con.execute("INSERT INTO sessions (token_hash, created_at, expires_at, last_seen, locked, quick, relock, unlock_fails) "
                "VALUES (?, ?, ?, ?, 0, ?, ?, 0)",
                (_hash_token(token), int(now), int(now) + SESSION_TTL, int(now), quick, relock))
    return token


def load_session(con, token, now):
    """The session for a cookie value, or None. Applies expiry, renewal and the idle lock."""
    if not token or not isinstance(token, str) or len(token) > 200:
        return None
    row = con.execute("SELECT %s FROM sessions WHERE token_hash = ?" % _COLUMNS,
                      (_hash_token(token),)).fetchone()
    if not row:
        return None
    session = Session(row)
    if session.expires_at <= now:
        con.execute("DELETE FROM sessions WHERE token_hash = ?", (session.token_hash,))
        return None
    session.quick = _effective_quick(con, session.quick_pref)
    if (session.quick != "none" and not session.locked
            and now - session.last_seen > idle_limit(session.relock)):
        session.locked = True
        con.execute("UPDATE sessions SET locked = 1 WHERE token_hash = ?", (session.token_hash,))
    if session.expires_at - now < SESSION_TTL - RENEW_AFTER:
        session.expires_at = int(now) + SESSION_TTL
        session.renewed = True
        con.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
                    (session.expires_at, session.token_hash))
    return session


def touch(con, session, now):
    """Record activity on an unlocked session."""
    session.last_seen = int(now)
    con.execute("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", (int(now), session.token_hash))


def describe(con, session):
    """What the front-end needs to know to choose a screen."""
    info = {"configured": configured(con), "signedIn": session is not None, "locked": False,
            "methods": available_methods(con), "quick": "none", "relock": DEFAULT_RELOCK}
    if session is not None:
        info.update(locked=session.locked, quick=session.quick, relock=session.relock)
    return info


# ---------- password ----------

def _delay_after(fails):
    if fails < MAX_PASSWORD_FAILS:
        return 0
    return min(5 * 2 ** (fails - MAX_PASSWORD_FAILS), MAX_DELAY)


def _check_password(con, password, now):
    """Verify the password, counting failures in the database (survives restarts)."""
    with _password_lock:
        stored = _get(con, "password")
        if stored is None:
            raise AuthError(401, "setup", "No password has been set yet.")
        wait = float(_get(con, "pw_next", "0")) - now
        if wait > 0:
            raise AuthError(429, "throttled", "Too many wrong passwords. Wait a moment.",
                            retry_after=int(math.ceil(wait)))
        if _valid_secret(password) and verify_secret(password, stored):
            _set(con, "pw_fails", 0)
            _set(con, "pw_next", 0)
            return
        fails = int(_get(con, "pw_fails", "0")) + 1
        delay = _delay_after(fails)
        _set(con, "pw_fails", fails)
        _set(con, "pw_next", repr(now + delay) if delay else 0)
        raise AuthError(403, "wrong", "Wrong password.", retry_after=delay)


def setup(con, password, pattern, now):
    """First start only: choose the password and, optionally, a pattern."""
    check_new_password(password)
    if pattern is not None:
        check_new_pattern(pattern)
    password_hash = hash_secret(password)
    pattern_hash = hash_secret(pattern) if pattern is not None else None
    con.execute("BEGIN IMMEDIATE")
    try:
        if configured(con):
            raise AuthError(409, "configured", "A password is already set.")
        _set(con, "password", password_hash)
        if pattern_hash:
            _set(con, "pattern", pattern_hash)
        token = _create_session(con, now)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return token


def login(con, password, device, old_token, now):
    """Password login: a fresh, unlocked session replaces the one this device presented."""
    _check_password(con, password, now)
    quick, relock = _clean_device(device)
    old = load_session(con, old_token, now) if old_token else None
    if old is not None:
        if not isinstance(device, dict):
            quick, relock = old.quick_pref, old.relock
        con.execute("DELETE FROM sessions WHERE token_hash = ?", (old.token_hash,))
    return _create_session(con, now, quick, relock)


def verify_password(con, password, now):
    """Is this the current password? For the page, before it locks a backup with
    it. Wrong answers count towards the same delay as wrong sign-ins."""
    _check_password(con, password, now)


def change_password(con, session, current, new, now):
    check_new_password(new)
    _check_password(con, current, now)
    _set(con, "password", hash_secret(new))
    con.execute("DELETE FROM sessions WHERE token_hash <> ?", (session.token_hash,))


def set_pattern(con, session, current, pattern, now):
    """Set, change (a string) or remove (None) the pattern."""
    if pattern is not None:
        check_new_pattern(pattern)
    _check_password(con, current, now)
    if pattern is None:
        _unset(con, "pattern")
        # A session that is locked right now could never be opened again by pattern.
        con.execute("DELETE FROM sessions WHERE locked = 1")
    else:
        _set(con, "pattern", hash_secret(pattern))
    con.execute("UPDATE sessions SET unlock_fails = 0")


# ---------- lock ----------

def unlock(con, session, method, secret, now):
    """Open a locked session with a quick-unlock method. Too many misses end the session."""
    entry = UNLOCK_METHODS.get(method)
    if entry is None or not entry[0](con):
        raise AuthError(400, "no_method", "That unlock method is not available.")
    with _unlock_lock:
        row = con.execute("SELECT unlock_fails FROM sessions WHERE token_hash = ?",
                          (session.token_hash,)).fetchone()
        if row is None:
            raise AuthError(401, "auth", "Sign in with your password.")
        if entry[1](con, secret):
            session.locked, session.unlock_fails = False, 0
            con.execute("UPDATE sessions SET locked = 0, unlock_fails = 0, last_seen = ? WHERE token_hash = ?",
                        (int(now), session.token_hash))
            return
        fails = row[0] + 1
        if fails >= MAX_UNLOCK_FAILS:
            con.execute("DELETE FROM sessions WHERE token_hash = ?", (session.token_hash,))
            raise AuthError(401, "auth", "Too many wrong attempts. Sign in with your password.")
        con.execute("UPDATE sessions SET unlock_fails = ? WHERE token_hash = ?", (fails, session.token_hash))
        raise AuthError(403, "wrong", "Wrong pattern.", left=MAX_UNLOCK_FAILS - fails)


def lock(con, session):
    """Lock now. Only meaningful when the device has a quick-unlock method."""
    if session.quick != "none" and not session.locked:
        session.locked = True
        con.execute("UPDATE sessions SET locked = 1 WHERE token_hash = ?", (session.token_hash,))


def set_device(con, session, device):
    """Per-device choices: the quick-unlock method and the re-lock period."""
    if not isinstance(device, dict):
        raise AuthError(400, "bad_request", "Expected an object.")
    if "quick" in device:
        quick = device["quick"]
        if quick != "none" and quick not in available_methods(con):
            raise AuthError(400, "no_method", "That unlock method is not available.")
        session.quick_pref = quick
    if "relock" in device:
        relock = device["relock"]
        if relock not in RELOCK_CHOICES or isinstance(relock, bool):
            raise AuthError(400, "bad_request", "Unknown re-lock period.")
        session.relock = relock
    con.execute("UPDATE sessions SET quick = ?, relock = ? WHERE token_hash = ?",
                (session.quick_pref, session.relock, session.token_hash))
    session.quick = _effective_quick(con, session.quick_pref)


def logout(con, session):
    con.execute("DELETE FROM sessions WHERE token_hash = ?", (session.token_hash,))


def logout_all(con):
    con.execute("DELETE FROM sessions")


def reset(con):
    """Recovery: forget the password, the pattern and every session. Data is untouched."""
    con.execute("BEGIN IMMEDIATE")
    con.execute("DELETE FROM auth")
    con.execute("DELETE FROM sessions")
    con.execute("COMMIT")
