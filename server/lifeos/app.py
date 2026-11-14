"""Request handling: the API, the static front-end and the security headers.

`App.handle()` turns a Request into a Response without touching a socket, so
the whole behaviour is tested in-process (tests/test_server.py). The clock is
injectable for the same reason.
"""
import gzip
import json
import os
import sys
import time
import traceback
from urllib.parse import unquote, urlsplit

from . import auth, db

# Rule: the running app loads nothing from, and sends nothing to, another host.
# Inline script and style are allowed because the front-end is a single file.
CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; "
       "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")

SECURITY_HEADERS = (
    ("Content-Security-Policy", CSP),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
)

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".ico": "image/x-icon",
}
COMPRESSIBLE = {".html", ".js", ".css", ".json", ".webmanifest", ".svg", ".txt"}
LONG_CACHE = {".woff2"}            # font files carry a content hash in their name

CONFIG_JS = b"window.LIFEOS_MODE='server';\n"
MAX_SMALL_BODY = 16 * 1024         # login and settings requests

LOOPBACK = {"127.0.0.1", "localhost", "[::1]"}


class Request:
    def __init__(self, method, target, headers=None, body=b""):
        self.method = method.upper()
        self.raw_path = urlsplit(target).path or "/"
        self.headers = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
        self.body = body

    def header(self, name, default=""):
        return self.headers.get(name, default)

    def cookie(self, name):
        for part in self.header("cookie").split(";"):
            key, _, value = part.strip().partition("=")
            if key == name:
                return value
        return None

    def json(self):
        try:
            return db.parse_json(self.body)
        except (ValueError, UnicodeDecodeError):
            raise HttpError(400, "bad_request", "The request body is not valid JSON.")


class Response:
    def __init__(self, status=200, body=b"", content_type=None, headers=()):
        self.status = status
        self.body = body
        self.headers = list(headers)
        if content_type:
            self.headers.append(("Content-Type", content_type))

    def header(self, name):
        for key, value in self.headers:
            if key.lower() == name.lower():
                return value
        return None


class HttpError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def json_response(status, payload, headers=()):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return Response(status, body, "application/json", headers)


def _host_name(host):
    host = host.strip().lower()
    if host.startswith("["):
        return host[:host.find("]") + 1]
    return host.split(":", 1)[0]


class App:
    def __init__(self, config, clock=time.time):
        self.config = config
        self.clock = clock
        self._files = {}   # rel path -> (mtime_ns, size, raw bytes, gzip bytes or None)

    # ---------- entry point ----------

    def max_body(self, method, raw_path):
        """Largest request body accepted for a route (checked before reading it)."""
        if method == "POST" and raw_path == "/api/import":
            return db.MAX_IMPORT_BYTES
        if method == "PUT" and raw_path.startswith("/api/data/"):
            return db.MAX_DOC_BYTES * 2
        return MAX_SMALL_BODY

    def handle(self, req):
        try:
            if not self._host_allowed(req.header("host")):
                resp = Response(403, b"Host not allowed. Add it to LIFEOS_ALLOWED_HOSTS.\n",
                                "text/plain; charset=utf-8")
            elif req.raw_path == "/api" or req.raw_path.startswith("/api/"):
                resp = self._api(req)
            else:
                resp = self._static(req)
        except Exception:  # never let a bug leak a stack trace to the client
            traceback.print_exc(file=sys.stderr)
            resp = json_response(500, {"error": "Internal error.", "code": "internal"})
        resp.headers.extend(SECURITY_HEADERS)
        return resp

    def _host_allowed(self, host):
        """Refuse unknown Host names, which defeats DNS-rebinding against the loopback port."""
        name = _host_name(host)
        return bool(name) and (name in LOOPBACK or name.endswith(".ts.net")
                               or name in self.config.allowed_hosts)

    # ---------- API ----------

    def _api(self, req):
        con = db.connect(self.config.data_dir)
        try:
            ctx = _Context(req, con, self.clock())
            try:
                resp = self._dispatch(req, ctx)
            except auth.AuthError as err:
                payload = {"error": err.message, "code": err.code}
                payload.update(err.extra)
                resp = json_response(err.status, payload)
                if err.status == 401:
                    ctx.clear_cookie = ctx.token is not None
            except HttpError as err:
                resp = json_response(err.status, {"error": err.message, "code": err.code})
            except db.Invalid as err:
                resp = json_response(400, {"error": str(err), "code": "invalid"})
        finally:
            con.close()
        resp.headers.append(("Cache-Control", "no-store"))
        if ctx.new_token:
            resp.headers.append(("Set-Cookie", _cookie(ctx.new_token, auth.SESSION_TTL)))
        elif ctx.clear_cookie:
            resp.headers.append(("Set-Cookie", _cookie("", 0)))
        elif ctx.session is not None and ctx.session.renewed:
            resp.headers.append(("Set-Cookie", _cookie(ctx.token, auth.SESSION_TTL)))
        return resp

    def _dispatch(self, req, ctx):
        method, path, con, now = req.method, req.raw_path, ctx.con, ctx.now
        if method not in ("GET", "POST", "PUT", "DELETE"):
            raise HttpError(405, "method", "Method not allowed.")
        if method != "GET":
            self._check_same_origin(req)

        if path == "/api/health":
            con.execute("SELECT 1 FROM docs LIMIT 1").fetchone()
            return json_response(200, {"ok": True, "commit": self.config.commit})

        ctx.session = auth.load_session(con, ctx.token, now)

        if path == "/api/auth/state" and method == "GET":
            return json_response(200, auth.describe(con, ctx.session))

        if path.startswith("/api/auth/") and method == "POST":
            return self._auth(path[len("/api/auth/"):], req, ctx)

        if path == "/api/data" and method == "GET":
            ctx.require_unlocked()
            text = db.export_json(con).encode("utf-8")
            return _maybe_gzip(req, Response(200, text, "application/json"))

        if path == "/api/import" and method == "POST":
            ctx.require_unlocked()
            count = db.import_all(con, req.json(), int(now * 1000))
            return json_response(200, {"ok": True, "imported": count})

        parts = path.split("/")
        if len(parts) == 5 and parts[:3] == ["", "api", "data"] and method in ("PUT", "DELETE"):
            ctx.require_unlocked()
            collection, key = unquote(parts[3]), unquote(parts[4])
            if method == "PUT":
                db.put_doc(con, collection, key, req.json(), int(now * 1000))
            else:
                db.delete_doc(con, collection, key)
            return json_response(200, {"ok": True})

        raise HttpError(404, "not_found", "Not found.")

    def _auth(self, action, req, ctx):
        con, now = ctx.con, ctx.now
        body = req.json() if req.body else {}
        if not isinstance(body, dict):
            raise HttpError(400, "bad_request", "Expected a JSON object.")

        if action == "setup":
            ctx.new_token = auth.setup(con, body.get("password"), body.get("pattern"), now)
            ctx.session = auth.load_session(con, ctx.new_token, now)
        elif action == "login":
            ctx.new_token = auth.login(con, body.get("password"), body.get("device"), ctx.token, now)
            ctx.session = auth.load_session(con, ctx.new_token, now)
        elif action == "unlock":
            ctx.require_session()
            auth.unlock(con, ctx.session, body.get("method"), body.get("secret"), now)
        elif action == "lock":
            ctx.require_session()
            auth.lock(con, ctx.session)
        elif action == "logout":
            if ctx.session is not None:
                auth.logout(con, ctx.session)
            ctx.session, ctx.clear_cookie = None, True
        elif action == "ping":
            ctx.require_unlocked()
        elif action == "logout-all":
            ctx.require_unlocked()
            auth.logout_all(con)
            ctx.session, ctx.clear_cookie = None, True
        elif action == "password":
            ctx.require_unlocked()
            auth.change_password(con, ctx.session, body.get("current"), body.get("new"), now)
        elif action == "pattern":
            ctx.require_unlocked()
            auth.set_pattern(con, ctx.session, body.get("current"), body.get("pattern"), now)
            ctx.session = auth.load_session(con, ctx.token, now)
        elif action == "device":
            ctx.require_unlocked()
            auth.set_device(con, ctx.session, body)
        else:
            raise HttpError(404, "not_found", "Not found.")
        return json_response(200, auth.describe(con, ctx.session))

    def _check_same_origin(self, req):
        """State-changing requests must come from the app's own pages."""
        if req.header("x-lifeos") != "1":
            raise HttpError(403, "csrf", "Missing X-LifeOS header.")
        origin = req.header("origin")
        if origin and urlsplit(origin).netloc.lower() != req.header("host").strip().lower():
            raise HttpError(403, "csrf", "Cross-origin request refused.")
        if req.header("sec-fetch-site", "same-origin") not in ("same-origin", "none"):
            raise HttpError(403, "csrf", "Cross-site request refused.")

    # ---------- static front-end ----------

    def _static(self, req):
        if req.method not in ("GET", "HEAD"):
            return Response(405, b"Method not allowed.\n", "text/plain; charset=utf-8")
        rel = "index.html" if req.raw_path == "/" else req.raw_path[1:]
        if rel == "config.js":
            # The server decides the mode. The repo's config.js (demo) is never served here.
            return Response(200, CONFIG_JS, TYPES[".js"], [("Cache-Control", "no-cache")])
        ext = os.path.splitext(rel)[1].lower()
        parts = rel.split("/")
        safe = (rel != "demo.js" and ext in TYPES and "%" not in rel and "\\" not in rel
                and all(p and not p.startswith(".") for p in parts))
        full = os.path.join(self.config.app_dir, *parts) if safe else None
        if (not full or not os.path.isfile(full)
                or not os.path.realpath(full).startswith(self.config.app_dir + os.sep)):
            return Response(404, b"Not found.\n", "text/plain; charset=utf-8")

        stat = os.stat(full)
        etag = '"%x-%x"' % (stat.st_mtime_ns, stat.st_size)
        headers = [("ETag", etag),
                   ("Cache-Control", "public, max-age=31536000, immutable" if ext in LONG_CACHE else "no-cache")]
        if ext in COMPRESSIBLE:
            headers.append(("Vary", "Accept-Encoding"))
        if etag in [tag.strip() for tag in req.header("if-none-match").split(",")]:
            return Response(304, b"", None, headers)
        raw, packed = self._read(rel, full, stat, ext in COMPRESSIBLE)
        if packed is not None and "gzip" in req.header("accept-encoding").lower():
            return Response(200, packed, TYPES[ext], headers + [("Content-Encoding", "gzip")])
        return Response(200, raw, TYPES[ext], headers)

    def _read(self, rel, full, stat, compress):
        cached = self._files.get(rel)
        if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
            return cached[2], cached[3]
        with open(full, "rb") as fh:
            raw = fh.read()
        if not compress:
            return raw, None   # fonts and images: already compressed, not kept in memory
        packed = gzip.compress(raw, 6)
        self._files[rel] = (stat.st_mtime_ns, stat.st_size, raw, packed)
        return raw, packed


class _Context:
    """Per-request state: the database connection, the session and cookie changes."""

    def __init__(self, req, con, now):
        self.con, self.now = con, now
        self.token = req.cookie(auth.COOKIE)
        self.session = None
        self.new_token = None
        self.clear_cookie = False

    def require_session(self):
        if not auth.configured(self.con):
            raise auth.AuthError(401, "setup", "No password has been set yet.")
        if self.session is None:
            raise auth.AuthError(401, "auth", "Sign in first.")

    def require_unlocked(self):
        """Every data endpoint goes through here: a locked session gets nothing."""
        self.require_session()
        if self.session.locked:
            raise auth.AuthError(423, "locked", "This device is locked.")
        auth.touch(self.con, self.session, self.now)


def _cookie(value, max_age):
    return "%s=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Strict" % (auth.COOKIE, value, max_age)


def _maybe_gzip(req, resp):
    resp.headers.append(("Vary", "Accept-Encoding"))
    if "gzip" in req.header("accept-encoding").lower():
        resp.body = gzip.compress(resp.body, 5)
        resp.headers.append(("Content-Encoding", "gzip"))
    return resp
