"""Server tests. Standard library only:

    python3 -m unittest discover -s tests -v

Requests go straight into App.handle() with a fake clock, so nothing here
needs a network port (one test starts the real HTTP server on a free
loopback port to cover the adapter).
"""
import datetime
import gzip
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

from lifeos import admin, auth, backup, db  # noqa: E402
from lifeos.app import App, Request  # noqa: E402
from lifeos.config import Config  # noqa: E402
from lifeos.httpd import make_server  # noqa: E402

auth.SCRYPT_LOG_N = 10   # fast hashing for tests; production uses 2**15

HOST = "lifeos.example.ts.net"
PASSWORD = "correct horse battery"
PATTERN = "0124678"
DAY = 24 * 3600


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class Client:
    """One browser: keeps its own cookies, sends the headers the front-end sends."""

    def __init__(self, app, host=HOST):
        self.app, self.host, self.cookies, self.last_set_cookie = app, host, {}, None

    def request(self, method, path, body=None, headers=None, raw=None):
        send = {"Host": self.host, "Accept-Encoding": "gzip"}
        if method != "GET":
            send.update({"X-LifeOS": "1", "Origin": "https://" + self.host})
        if self.cookies:
            send["Cookie"] = "; ".join("%s=%s" % kv for kv in self.cookies.items())
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
        send.update(headers or {})
        send = {k: v for k, v in send.items() if v is not None}
        resp = self.app.handle(Request(method, path, send, raw or b""))
        self.last_set_cookie = None
        for name, value in resp.headers:
            if name == "Set-Cookie":
                self.last_set_cookie = value
                pair = value.split(";", 1)[0]
                key, _, val = pair.partition("=")
                if "Max-Age=0" in value or not val:
                    self.cookies.pop(key, None)
                else:
                    self.cookies[key] = val
        return resp

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.request("POST", path, body=body if body is not None else {}, **kw)

    def put(self, path, body, **kw):
        return self.request("PUT", path, body=body, **kw)

    def delete(self, path, **kw):
        return self.request("DELETE", path, **kw)


def data(resp):
    body = resp.body
    if resp.header("Content-Encoding") == "gzip":
        body = gzip.decompress(body)
    return json.loads(body.decode("utf-8"))


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="lifeos-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.clock = Clock()
        self.config = Config(data_dir=os.path.join(self.tmp, "data"), commit="testcommit")
        db.init(self.config.data_dir)
        self.app = App(self.config, clock=self.clock)
        self.c = Client(self.app)

    def setup_account(self, pattern=PATTERN, client=None):
        client = client or self.c
        body = {"password": PASSWORD}
        if pattern:
            body["pattern"] = pattern
        resp = client.post("/api/auth/setup", body)
        self.assertEqual(resp.status, 200, resp.body)
        return resp

    def login(self, client, **extra):
        body = {"password": PASSWORD}
        body.update(extra)
        return client.post("/api/auth/login", body)

    def assertRefused(self, resp, status, code):
        self.assertEqual(resp.status, status, resp.body)
        self.assertEqual(data(resp).get("code"), code)


class SetupAndLogin(ServerCase):
    def test_setup_only_once_and_password_rules(self):
        state = data(self.c.get("/api/auth/state"))
        self.assertEqual((state["configured"], state["signedIn"]), (False, False))
        self.assertRefused(self.c.get("/api/data"), 401, "setup")
        self.assertRefused(self.c.post("/api/auth/setup", {"password": "short"}), 400, "weak")
        self.assertRefused(self.c.post("/api/auth/setup", {"password": PASSWORD, "pattern": "012"}), 400, "bad_pattern")
        self.assertRefused(self.c.post("/api/auth/setup", {"password": PASSWORD, "pattern": "0110"}), 400, "bad_pattern")
        self.assertFalse(data(self.c.get("/api/auth/state"))["configured"])

        state = data(self.setup_account())
        self.assertEqual((state["configured"], state["signedIn"], state["locked"]), (True, True, False))
        self.assertEqual(state["methods"], ["pattern"])
        self.assertEqual(state["quick"], "pattern")
        self.assertEqual(self.c.get("/api/data").status, 200)

        other = Client(self.app)
        self.assertRefused(other.post("/api/auth/setup", {"password": "another password"}), 409, "configured")
        self.assertRefused(other.get("/api/data"), 401, "auth")

    def test_cookie_flags_and_token_is_stored_hashed(self):
        self.setup_account()
        cookie = self.c.last_set_cookie
        for flag in ("HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=%d" % auth.SESSION_TTL):
            self.assertIn(flag, cookie)
        token = self.c.cookies[auth.COOKIE]
        con = db.connect(self.config.data_dir)
        stored = [row[0] for row in con.execute("SELECT token_hash FROM sessions")]
        secrets_ = dict(con.execute("SELECT key, value FROM auth"))
        con.close()
        self.assertNotIn(token, stored)
        self.assertEqual(len(stored), 1)
        self.assertTrue(secrets_["password"].startswith("scrypt$"))
        self.assertTrue(secrets_["pattern"].startswith("scrypt$"))
        self.assertNotIn(PASSWORD, json.dumps(secrets_))
        self.assertNotEqual(secrets_["password"].split("$")[4], secrets_["pattern"].split("$")[4])  # own salts

    def test_login_logout_and_logout_all(self):
        self.setup_account()
        phone, laptop = Client(self.app), Client(self.app)
        self.assertRefused(self.login(phone, password="wrong password!"), 403, "wrong")
        self.assertEqual(self.login(phone).status, 200)
        self.assertEqual(self.login(laptop).status, 200)
        self.assertEqual(phone.get("/api/data").status, 200)

        self.assertEqual(phone.post("/api/auth/logout").status, 200)
        self.assertNotIn(auth.COOKIE, phone.cookies)
        self.assertRefused(phone.get("/api/data"), 401, "auth")
        self.assertEqual(laptop.get("/api/data").status, 200)

        self.assertEqual(laptop.post("/api/auth/logout-all").status, 200)
        self.assertRefused(laptop.get("/api/data"), 401, "auth")
        self.assertRefused(self.c.get("/api/data"), 401, "auth")

    def test_session_expires_after_90_days_without_use_and_renews_with_use(self):
        self.setup_account(pattern=None)
        self.clock.advance(60)
        self.c.get("/api/data")
        self.assertIsNone(self.c.last_set_cookie, "no renewal within the first day")

        self.clock.advance(80 * DAY)
        self.assertEqual(self.c.get("/api/data").status, 200)
        self.assertIn("Max-Age=%d" % auth.SESSION_TTL, self.c.last_set_cookie or "", "used after 80 days: renewed")

        self.clock.advance(80 * DAY)   # 160 days after login, but used 80 days ago
        self.assertEqual(self.c.get("/api/data").status, 200)

        self.clock.advance(91 * DAY)   # unused for longer than the session lasts
        self.assertRefused(self.c.get("/api/data"), 401, "auth")
        self.assertNotIn(auth.COOKIE, self.c.cookies)

    def test_growing_delay_after_five_wrong_passwords_survives_restart(self):
        self.setup_account()
        other = Client(self.app)
        for _ in range(4):
            self.assertRefused(self.login(other, password="wrong password!"), 403, "wrong")
        resp = self.login(other, password="wrong password!")       # 5th in a row
        self.assertRefused(resp, 403, "wrong")
        first_delay = data(resp)["retry_after"]
        self.assertGreater(first_delay, 0)

        blocked = self.login(other)                                  # correct, but too early
        self.assertRefused(blocked, 429, "throttled")
        self.assertLessEqual(data(blocked)["retry_after"], first_delay)

        restarted = Client(App(self.config, clock=self.clock))       # a new process sees the same counter
        self.assertRefused(self.login(restarted), 429, "throttled")

        self.clock.advance(first_delay + 1)
        resp = self.login(other, password="wrong password!")       # 6th: the delay grows
        self.assertGreater(data(resp)["retry_after"], first_delay)
        self.clock.advance(data(resp)["retry_after"] + 1)
        self.assertEqual(self.login(other).status, 200)

        for _ in range(4):                                           # success reset the counter
            self.assertRefused(self.login(Client(self.app), password="wrong password!"), 403, "wrong")
        self.assertEqual(self.login(Client(self.app)).status, 200)

    def test_change_password_needs_current_and_signs_out_other_devices(self):
        self.setup_account()
        other = Client(self.app)
        self.login(other)
        new = "a brand new password"
        self.assertRefused(self.c.post("/api/auth/password", {"current": "nope nope nope", "new": new}), 403, "wrong")
        self.assertRefused(self.c.post("/api/auth/password", {"current": PASSWORD, "new": "short"}), 400, "weak")
        self.assertEqual(self.c.post("/api/auth/password", {"current": PASSWORD, "new": new}).status, 200)
        self.assertEqual(self.c.get("/api/data").status, 200)
        self.assertRefused(other.get("/api/data"), 401, "auth")
        self.assertRefused(self.login(other), 403, "wrong")
        self.assertEqual(other.post("/api/auth/login", {"password": new}).status, 200)

    def test_verify_checks_the_password_and_counts_wrong_ones(self):
        self.setup_account()
        self.assertRefused(Client(self.app).post("/api/auth/verify", {"password": PASSWORD}), 401, "auth")
        self.assertEqual(self.c.post("/api/auth/verify", {"password": PASSWORD}).status, 200)
        self.assertEqual(self.c.get("/api/data").status, 200)          # nothing about the session changed
        for wrong in ({"password": "not the password"}, {}, {"password": 12345}, {"password": "nope nope nope"}):
            self.assertRefused(self.c.post("/api/auth/verify", wrong), 403, "wrong")
        resp = self.c.post("/api/auth/verify", {"password": "not the password"})   # 5th in a row
        self.assertRefused(resp, 403, "wrong")
        self.assertGreater(data(resp)["retry_after"], 0)
        self.assertRefused(self.c.post("/api/auth/verify", {"password": PASSWORD}), 429, "throttled")
        self.assertRefused(self.login(Client(self.app)), 429, "throttled")         # the same counter as sign-in
        self.clock.advance(data(resp)["retry_after"] + 1)
        self.assertEqual(self.c.post("/api/auth/verify", {"password": PASSWORD}).status, 200)


class Lock(ServerCase):
    def lock_now(self, client=None):
        client = client or self.c
        self.assertTrue(data(client.post("/api/auth/lock"))["locked"])

    def test_locked_endpoints_return_no_data(self):
        self.setup_account()
        self.c.put("/api/data/days/2026-01-05", {"date": "2026-01-05", "recap": "SECRET-RECAP"})
        self.lock_now()
        attempts = [
            self.c.get("/api/data"),
            self.c.put("/api/data/days/2026-01-06", {"date": "2026-01-06", "recap": "x"}),
            self.c.delete("/api/data/days/2026-01-05"),
            self.c.post("/api/import", {"days": {}}),
            self.c.post("/api/auth/ping"),
            self.c.post("/api/auth/verify", {"password": PASSWORD}),
            self.c.post("/api/auth/password", {"current": PASSWORD, "new": "another password"}),
            self.c.post("/api/auth/pattern", {"current": PASSWORD, "pattern": None}),
            self.c.post("/api/auth/device", {"quick": "none"}),
            self.c.post("/api/auth/logout-all"),
        ]
        for resp in attempts:
            self.assertRefused(resp, 423, "locked")
            self.assertNotIn(b"SECRET-RECAP", resp.body)
        state = data(self.c.get("/api/auth/state"))
        self.assertTrue(state["signedIn"] and state["locked"])

        self.assertEqual(self.c.post("/api/auth/unlock", {"method": "pattern", "secret": PATTERN}).status, 200)
        docs = data(self.c.get("/api/data"))
        self.assertEqual(docs["days"]["2026-01-05"]["recap"], "SECRET-RECAP")   # the delete was refused
        self.assertNotIn("2026-01-06", docs["days"])                             # and so was the write

    def test_relocks_after_inactivity_and_activity_postpones_it(self):
        self.setup_account()
        self.assertEqual(data(self.c.get("/api/auth/state"))["relock"], 300)
        for _ in range(5):                       # active every 4 minutes: stays open
            self.clock.advance(240)
            self.assertEqual(self.c.post("/api/auth/ping").status, 200)
        self.clock.advance(300 + auth.IDLE_GRACE + 1)
        self.assertRefused(self.c.get("/api/data"), 423, "locked")
        self.assertTrue(data(self.c.get("/api/auth/state"))["locked"])

    def test_relock_period_is_a_per_device_setting(self):
        self.setup_account()
        laptop = Client(self.app)
        self.login(laptop)
        self.assertRefused(laptop.post("/api/auth/device", {"relock": 123}), 400, "bad_request")
        self.assertEqual(data(laptop.post("/api/auth/device", {"relock": 3600}))["relock"], 3600)
        self.clock.advance(1800)
        self.assertEqual(laptop.get("/api/data").status, 200)
        self.assertRefused(self.c.get("/api/data"), 423, "locked")    # the first device kept 5 minutes

        self.assertEqual(self.c.post("/api/auth/unlock", {"method": "pattern", "secret": PATTERN}).status, 200)
        self.assertEqual(data(self.c.post("/api/auth/device", {"relock": 0}))["relock"], 0)
        self.clock.advance(auth.LEAVE_IDLE + 1)   # "when I leave": the page stopped pinging
        self.assertRefused(self.c.get("/api/data"), 423, "locked")

    def test_quick_unlock_none_never_locks(self):
        self.setup_account()
        self.assertEqual(data(self.c.post("/api/auth/device", {"quick": "none"}))["quick"], "none")
        self.clock.advance(5 * DAY)
        self.assertEqual(self.c.get("/api/data").status, 200)
        self.assertFalse(data(self.c.post("/api/auth/lock"))["locked"])
        self.assertRefused(self.c.post("/api/auth/device", {"quick": "fingerprint"}), 400, "no_method")

    def test_without_a_pattern_there_is_no_lock(self):
        self.setup_account(pattern=None)
        state = data(self.c.get("/api/auth/state"))
        self.assertEqual((state["methods"], state["quick"]), ([], "none"))
        self.clock.advance(DAY)
        self.assertEqual(self.c.get("/api/data").status, 200)
        self.assertRefused(self.c.post("/api/auth/unlock", {"method": "pattern", "secret": PATTERN}), 400, "no_method")

    def test_five_wrong_patterns_end_the_session(self):
        self.setup_account()
        self.lock_now()
        for left in (4, 3, 2, 1):
            resp = self.c.post("/api/auth/unlock", {"method": "pattern", "secret": "8765"})
            self.assertRefused(resp, 403, "wrong")
            self.assertEqual(data(resp)["left"], left)
        self.assertRefused(self.c.post("/api/auth/unlock", {"method": "pattern", "secret": "8765"}), 401, "auth")
        self.assertNotIn(auth.COOKIE, self.c.cookies)
        self.assertFalse(data(self.c.get("/api/auth/state"))["signedIn"])
        self.assertRefused(self.c.post("/api/auth/unlock", {"method": "pattern", "secret": PATTERN}), 401, "auth")
        self.assertEqual(self.login(self.c).status, 200)             # the password still works
        self.assertEqual(self.c.get("/api/data").status, 200)

    def test_wrong_pattern_counter_resets_on_success(self):
        self.setup_account()
        for _ in range(3):
            self.lock_now()
            for _ in range(3):
                self.assertRefused(self.c.post("/api/auth/unlock", {"method": "pattern", "secret": "8765"}), 403, "wrong")
            self.assertEqual(self.c.post("/api/auth/unlock", {"method": "pattern", "secret": PATTERN}).status, 200)
        self.assertEqual(self.c.get("/api/data").status, 200)

    def test_password_login_replaces_a_locked_session_and_keeps_device_choices(self):
        self.setup_account()
        self.c.post("/api/auth/device", {"relock": 900})
        self.lock_now()
        self.assertEqual(self.login(self.c).status, 200)
        state = data(self.c.get("/api/auth/state"))
        self.assertEqual((state["locked"], state["relock"]), (False, 900))
        con = db.connect(self.config.data_dir)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 1)
        con.close()
        fresh = Client(self.app)
        state = data(self.login(fresh, device={"quick": "none", "relock": 3600}))
        self.assertEqual((state["quick"], state["relock"]), ("none", 3600))

    def test_set_change_and_remove_pattern_need_the_password(self):
        self.setup_account(pattern=None)
        self.assertRefused(self.c.post("/api/auth/pattern", {"current": "wrong password!", "pattern": "0123"}), 403, "wrong")
        state = data(self.c.post("/api/auth/pattern", {"current": PASSWORD, "pattern": "0123"}))
        self.assertEqual((state["methods"], state["quick"]), (["pattern"], "pattern"))   # default once one exists
        self.lock_now()
        self.assertEqual(self.c.post("/api/auth/unlock", {"method": "pattern", "secret": "0123"}).status, 200)

        self.c.post("/api/auth/pattern", {"current": PASSWORD, "pattern": "3210"})
        self.lock_now()
        self.assertRefused(self.c.post("/api/auth/unlock", {"method": "pattern", "secret": "0123"}), 403, "wrong")
        self.assertEqual(self.c.post("/api/auth/unlock", {"method": "pattern", "secret": "3210"}).status, 200)

        other = Client(self.app)
        self.login(other)
        self.lock_now(other)
        state = data(self.c.post("/api/auth/pattern", {"current": PASSWORD, "pattern": None}))
        self.assertEqual((state["methods"], state["quick"], state["locked"]), ([], "none", False))
        self.assertRefused(other.get("/api/data"), 401, "auth")      # was locked: needs the password now


class Data(ServerCase):
    def setUp(self):
        super().setUp()
        self.setup_account(pattern=None)

    def test_put_get_delete(self):
        doc = {"id": "t_1", "title": "Ünïcode ✓ “quotes”", "subtasks": [{"id": "s1", "title": "a", "done": False}], "createdAt": 1700000000000}
        self.assertEqual(self.c.put("/api/data/tasks/t_1", doc).status, 200)
        self.assertEqual(self.c.put("/api/data/settings/main", {"areas": []}).status, 200)
        self.assertEqual(self.c.put("/api/data/habit_log/2026-01-05_h_1", {"date": "2026-01-05", "habitId": "h_1", "done": True}).status, 200)
        resp = self.c.get("/api/data")
        self.assertEqual(resp.header("Content-Encoding"), "gzip")
        self.assertEqual(resp.header("Cache-Control"), "no-store")
        got = data(resp)
        self.assertEqual(sorted(got), sorted(db.COLLECTIONS))
        self.assertEqual(got["tasks"]["t_1"], doc)
        doc["title"] = "changed"
        self.c.put("/api/data/tasks/t_1", doc)                       # last write wins
        self.assertEqual(data(self.c.get("/api/data"))["tasks"]["t_1"]["title"], "changed")
        self.assertEqual(self.c.delete("/api/data/tasks/t_1").status, 200)
        self.assertEqual(data(self.c.get("/api/data"))["tasks"], {})

    def test_ids_with_every_allowed_character(self):
        key = "A-z_0.9~:@+"
        self.assertEqual(self.c.put("/api/data/tasks/A-z_0.9~%3A%40%2B", {"id": key}).status, 200)
        self.assertIn(key, data(self.c.get("/api/data"))["tasks"])
        self.assertEqual(self.c.delete("/api/data/tasks/A-z_0.9~%3A%40%2B").status, 200)
        self.assertEqual(data(self.c.get("/api/data"))["tasks"], {})

    def test_collection_and_id_validation(self):
        bad = [
            ("/api/data/users/x", {"id": "x"}),                      # not one of the nine collections
            ("/api/data/docs/x", {"id": "x"}),
            ("/api/data/tasks/a%20b", {"id": "a b"}),                # space
            ("/api/data/tasks/a%2Fb", {"id": "a/b"}),                # slash
            ("/api/data/tasks/%C3%A9", {"id": "é"}),                 # outside the pattern
            ("/api/data/tasks/" + "x" * 201, {"id": "x" * 201}),     # too long
            ("/api/data/tasks/t_1", {"id": "t_2"}),                  # id does not match the document
            ("/api/data/tasks/t_1", {"title": "no id"}),
            ("/api/data/days/2026-01-05", {"date": "2026-01-06"}),
            ("/api/data/habit_log/2026-01-05_h1", {"date": "2026-01-05", "habitId": "h2"}),
            ("/api/data/settings/other", {"areas": []}),
            ("/api/data/tasks/t_1", ["not", "an", "object"]),
        ]
        for path, body in bad:
            self.assertRefused(self.c.put(path, body), 400, "invalid")
        self.assertRefused(self.c.put("/api/data/tasks/t_1", None, raw=b"{not json"), 400, "bad_request")
        self.assertRefused(self.c.put("/api/data/tasks/t_1", None, raw=b'{"id":"t_1","n":NaN}'), 400, "bad_request")
        self.assertRefused(self.c.put("/api/data/tasks/t_1", {"id": "t_1", "x": "y" * db.MAX_DOC_BYTES}), 400, "invalid")
        self.assertRefused(self.c.delete("/api/data/users/x"), 400, "invalid")
        self.assertEqual(self.c.put("/api/data/tasks", {"id": "x"}).status, 404)
        self.assertEqual(self.c.put("/api/data/tasks/a/b", {"id": "a"}).status, 404)
        self.assertEqual(data(self.c.get("/api/data")), {c: {} for c in db.COLLECTIONS})

    def test_import_is_all_or_nothing(self):
        good = {"days": {"2026-01-05": {"date": "2026-01-05", "rating": 4}},
                "tasks": {"t_1": {"id": "t_1", "title": "one"}, "t_2": {"id": "t_2", "title": "two"}}}
        resp = self.c.post("/api/import", good)
        self.assertEqual((resp.status, data(resp)["imported"]), (200, 3))
        for broken in (
            {"tasks": {"t_3": {"id": "t_3"}, "bad id": {"id": "bad id"}}},
            {"tasks": {"t_3": {"id": "t_3"}}, "nonsense": {"x": {"id": "x"}}},
            {"tasks": {"t_3": {"id": "t_3"}, "t_4": {"id": "mismatch"}}},
            {"tasks": [{"id": "t_3"}]},
            [1, 2, 3],
        ):
            self.assertRefused(self.c.post("/api/import", broken), 400, "invalid")
        got = data(self.c.get("/api/data"))
        self.assertEqual(sorted(got["tasks"]), ["t_1", "t_2"])       # nothing from the broken imports
        self.c.post("/api/import", {"tasks": {"t_1": {"id": "t_1", "title": "updated"}}})   # upsert
        got = data(self.c.get("/api/data"))
        self.assertEqual((got["tasks"]["t_1"]["title"], got["tasks"]["t_2"]["title"]), ("updated", "two"))

    def test_export_import_round_trip(self):
        original = {c: {} for c in db.COLLECTIONS}
        original["days"]["2026-01-05"] = {"date": "2026-01-05", "rating": 5, "core": True, "recap": "Line one\nLine “two” – ü", "updatedAt": 1767600000000}
        original["habits"]["h_1"] = {"id": "h_1", "name": "Read", "ranges": [{"from": "2025-12-01", "to": None}], "order": 0, "archived": False}
        original["habit_log"]["2026-01-05_h_1"] = {"date": "2026-01-05", "habitId": "h_1", "done": True, "at": 1767600000001}
        original["periods"]["week_2026-W02"] = {"id": "week_2026-W02", "kind": "week", "start": "2026-01-05", "end": "2026-01-11", "intentions": [{"id": "i1", "text": "x", "status": "open", "why": ""}], "closedAt": None}
        original["settings"]["main"] = {"areas": [{"name": "Health", "color": "#45A882", "icon": "favorite"}], "ratio": 0.25}
        self.assertEqual(self.c.post("/api/import", original).status, 200)
        exported = data(self.c.get("/api/data"))
        self.assertEqual(exported, original)

        second = App(Config(data_dir=os.path.join(self.tmp, "second"), commit="x"), clock=self.clock)
        db.init(second.config.data_dir)
        other = Client(second)
        other.post("/api/auth/setup", {"password": PASSWORD})
        other.post("/api/import", exported)
        self.assertEqual(data(other.get("/api/data")), original)

    def test_demo_export_round_trips_through_a_fresh_server(self):
        node = shutil.which("node")
        demo = os.path.join(ROOT, "app", "demo.js")
        if not node or not os.path.exists(demo):
            self.skipTest("needs node and app/demo.js")
        out = subprocess.run([node, os.path.join(ROOT, "tests", "demo-export.mjs"), "2026-03-10"],
                             check=True, capture_output=True).stdout
        original = json.loads(out.decode("utf-8"))
        self.assertGreater(len(original["days"]), 50)
        resp = self.c.request("POST", "/api/import", raw=out)
        self.assertEqual(resp.status, 200, resp.body[:300])
        self.assertEqual(data(resp)["imported"], sum(len(v) for v in original.values()))
        self.assertEqual(data(self.c.get("/api/data")), original)

    def test_sql_views(self):
        self.c.post("/api/import", {
            "days": {"2026-01-05": {"date": "2026-01-05", "rating": 4, "core": True, "focus": "Deep work"}},
            "tasks": {"t_1": {"id": "t_1", "title": "One", "status": "done", "doneOn": "2026-01-05", "subtasks": [{"id": "a"}, {"id": "b"}]}},
            "periods": {"week_2026-W02": {"id": "week_2026-W02", "kind": "week", "start": "2026-01-05", "end": "2026-01-11"}},
        })
        con = sqlite3.connect(db.db_path(self.config.data_dir))
        self.addCleanup(con.close)
        views = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'view'")}
        self.assertEqual(views, {"v_" + c for c in db.COLLECTIONS})
        self.assertEqual(con.execute("SELECT date, rating, core, focus FROM v_days").fetchall(), [("2026-01-05", 4, 1, "Deep work")])
        self.assertEqual(con.execute("SELECT id, status, done_on, subtask_count FROM v_tasks").fetchall(), [("t_1", "done", "2026-01-05", 2)])
        self.assertEqual(con.execute("SELECT kind, start_date, end_date FROM v_periods").fetchall(), [("week", "2026-01-05", "2026-01-11")])
        self.assertEqual(con.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        for view in views:
            con.execute("SELECT * FROM %s" % view).fetchall()


class Guards(ServerCase):
    def test_state_changes_need_the_custom_header_and_the_same_origin(self):
        self.setup_account(pattern=None)
        doc = {"id": "t_1"}
        self.assertRefused(self.c.put("/api/data/tasks/t_1", doc, headers={"X-LifeOS": None}), 403, "csrf")
        self.assertRefused(self.c.put("/api/data/tasks/t_1", doc, headers={"Origin": "https://evil.example"}), 403, "csrf")
        self.assertRefused(self.c.put("/api/data/tasks/t_1", doc, headers={"Origin": "null"}), 403, "csrf")
        self.assertRefused(self.c.put("/api/data/tasks/t_1", doc, headers={"Sec-Fetch-Site": "cross-site"}), 403, "csrf")
        self.assertRefused(self.c.post("/api/auth/logout", headers={"X-LifeOS": None}), 403, "csrf")
        self.assertRefused(Client(self.app).post("/api/auth/login", {"password": PASSWORD}, headers={"Origin": "https://evil.example"}), 403, "csrf")
        self.assertEqual(data(self.c.get("/api/data"))["tasks"], {})
        # A script without a browser Origin (for example an importer) is fine with the header.
        self.assertEqual(self.c.put("/api/data/tasks/t_1", doc, headers={"Origin": None}).status, 200)

    def test_unknown_host_names_are_refused(self):
        for host in ("evil.example", "evil.example:8787", "ts.net.evil.example", ""):
            self.assertEqual(Client(self.app, host).get("/api/health").status, 403, host)
            self.assertEqual(Client(self.app, host).get("/").status, 403, host)
        for host in ("127.0.0.1:8787", "localhost:8787", "[::1]:8787", "pi.tail1234.ts.net", "PI.Tail1234.TS.net:8443"):
            self.assertEqual(Client(self.app, host).get("/api/health").status, 200, host)
        extra = App(Config(data_dir=self.config.data_dir, allowed_hosts=["journal.lan"], commit="x"))
        self.assertEqual(Client(extra, "journal.lan").get("/api/health").status, 200)

    def test_health_needs_no_login_and_reports_the_commit(self):
        resp = Client(self.app).get("/api/health")
        self.assertEqual(data(resp), {"ok": True, "commit": "testcommit"})

    def test_front_end_and_headers(self):
        resp = self.c.get("/")
        self.assertEqual(resp.status, 200)
        self.assertIn(b"<title>Life OS</title>", gzip.decompress(resp.body))
        self.assertEqual(resp.header("Cache-Control"), "no-cache")
        csp = resp.header("Content-Security-Policy")
        self.assertIn("default-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertNotIn("http", csp)                                # no outside host is allowed
        self.assertEqual(resp.header("X-Content-Type-Options"), "nosniff")
        self.assertEqual(self.c.get("/", headers={"If-None-Match": resp.header("ETag")}).status, 304)
        self.assertEqual(self.c.get("/index.html", headers={"Accept-Encoding": None}).body[:15], b"<!DOCTYPE html>")

        config = self.c.get("/config.js")
        self.assertEqual(config.body.strip(), b"window.LIFEOS_MODE='server';")
        self.assertEqual(config.header("Cache-Control"), "no-cache")
        self.assertEqual(self.c.get("/demo.js").status, 404)         # demo data is never served by a real install

        fonts = [f for f in os.listdir(os.path.join(ROOT, "app", "fonts")) if f.endswith(".woff2")]
        font = self.c.get("/fonts/" + fonts[0])
        self.assertEqual((font.status, font.header("Content-Type")), (200, "font/woff2"))
        self.assertIn("immutable", font.header("Cache-Control"))
        self.assertIn("Content-Security-Policy", dict(self.c.get("/api/health").headers))

    def test_no_path_escapes_the_app_folder(self):
        for path in ("/../server/lifeos/app.py", "/..%2Fserver/lifeos/app.py", "/%2e%2e/README.md", "/.git/config",
                     "/fonts/../../README.md", "//etc/passwd", "/index.html/", "/fonts", "/fonts/", "/nothing.html",
                     "/..\\server", "/index.html%00.png"):
            self.assertEqual(self.c.get(path).status, 404, path)
        self.assertEqual(self.c.post("/", {}).status, 405)

    def test_internal_errors_do_not_leak_details(self):
        broken = App(Config(data_dir=os.path.join(self.tmp, "missing", "dir"), commit="x"))
        stderr, sys.stderr = sys.stderr, open(os.devnull, "w")
        try:
            resp = Client(broken).get("/api/health")
        finally:
            sys.stderr.close()
            sys.stderr = stderr
        self.assertEqual(resp.status, 500)
        self.assertEqual(data(resp), {"error": "Internal error.", "code": "internal"})


class HttpAdapter(ServerCase):
    def test_real_server_on_loopback(self):
        server = make_server(self.config, port=0)
        self.addCleanup(server.server_close)
        host, port = server.server_address
        self.assertEqual(host, "127.0.0.1")                          # never anything but loopback
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        base = "http://127.0.0.1:%d" % port

        with urllib.request.urlopen(base + "/api/health", timeout=10) as resp:
            self.assertEqual(json.loads(resp.read())["ok"], True)
        with urllib.request.urlopen(base + "/config.js", timeout=10) as resp:
            self.assertIn(b"'server'", resp.read())

        def call(method, path, body, headers=None):
            req = urllib.request.Request(base + path, data=body, method=method,
                                         headers=dict({"X-LifeOS": "1", "Content-Type": "application/json"}, **(headers or {})))
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    return resp.status, resp.read(), resp.headers
            except urllib.error.HTTPError as err:
                return err.code, err.read(), err.headers

        status, body, headers = call("POST", "/api/auth/setup", json.dumps({"password": PASSWORD}).encode())
        self.assertEqual(status, 200)
        cookie = headers["Set-Cookie"].split(";")[0]
        status, _, _ = call("PUT", "/api/data/tasks/t_1", json.dumps({"id": "t_1", "title": "over http"}).encode(), {"Cookie": cookie})
        self.assertEqual(status, 200)
        status, body, _ = call("GET", "/api/data", None, {"Cookie": cookie})
        self.assertEqual(json.loads(body)["tasks"]["t_1"]["title"], "over http")
        status, _, _ = call("POST", "/api/auth/login", b"x" * (64 * 1024))
        self.assertEqual(status, 413)                                # oversized bodies are refused unread


class BackupAndReset(ServerCase):
    def test_retention_keeps_30_daily_and_12_monthly(self):
        start = datetime.date(2024, 1, 1)
        names = ["lifeos-%s.db" % (start + datetime.timedelta(days=i)).isoformat() for i in range(800)]
        removed = set(backup.to_delete(names + ["notes.txt", "lifeos-2025-01-01.db.partial"]))
        kept = [n for n in names if n not in removed]
        self.assertEqual(kept[-30:], names[-30:])                    # the newest 30 days
        monthly = kept[:-30]
        self.assertTrue(all(n.endswith("-01.db") for n in monthly), monthly)
        self.assertEqual(len({n[7:14] for n in kept}), 12)           # 12 distinct months in total
        self.assertNotIn("notes.txt", removed)
        self.assertEqual(backup.to_delete(names[:5]), [])

    def test_snapshot_is_a_consistent_copy_and_prunes(self):
        self.setup_account(pattern=None)
        self.c.put("/api/data/tasks/t_1", {"id": "t_1", "title": "kept"})
        target = os.path.join(self.tmp, "backups")
        name, size, removed = backup.snapshot(self.config.data_dir, target, datetime.date(2026, 1, 4))
        self.assertEqual((name, removed), ("lifeos-2026-01-04.db", []))
        self.assertEqual(os.stat(target).st_mode & 0o777, 0o700)     # created private
        for day in range(1, 32):                                     # an old month of dailies
            open(os.path.join(target, "lifeos-2020-01-%02d.db" % day), "w").close()
        for day in range(1, 11):
            open(os.path.join(target, "lifeos-2020-02-%02d.db" % day), "w").close()
        name, size, removed = backup.snapshot(self.config.data_dir, target, datetime.date(2026, 1, 5))
        self.assertEqual(name, "lifeos-2026-01-05.db")
        self.assertGreater(size, 0)
        self.assertEqual(len(removed), 12)                           # 43 snapshots: 30 newest + one monthly kept
        self.assertIn("lifeos-2020-01-01.db", os.listdir(target))    # the first of a month stays
        con = sqlite3.connect(os.path.join(target, name))
        self.addCleanup(con.close)
        self.assertEqual(json.loads(con.execute("SELECT json FROM docs WHERE id = 't_1'").fetchone()[0])["title"], "kept")
        self.assertFalse([f for f in os.listdir(target) if f.endswith(".partial")])

    def test_reset_clears_login_but_not_data(self):
        self.setup_account()
        self.c.put("/api/data/tasks/t_1", {"id": "t_1", "title": "survives"})
        stdout, sys.stdout = sys.stdout, open(os.devnull, "w")
        try:
            admin.reset_auth(self.config.data_dir)
        finally:
            sys.stdout.close()
            sys.stdout = stdout
        state = data(self.c.get("/api/auth/state"))
        self.assertEqual((state["configured"], state["signedIn"]), (False, False))
        self.assertRefused(self.c.get("/api/data"), 401, "setup")
        fresh = Client(self.app)
        self.assertEqual(fresh.post("/api/auth/setup", {"password": "a different password"}).status, 200)
        self.assertEqual(data(fresh.get("/api/data"))["tasks"]["t_1"]["title"], "survives")


if __name__ == "__main__":
    unittest.main()
