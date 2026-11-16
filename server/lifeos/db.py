"""SQLite storage.

One table holds every document as JSON. Login state lives in two separate
tables so that a password reset never touches the data. Read-only views
expose the main fields of each collection for plain-SQL analysis.
"""
import json
import os
import re
import sqlite3

COLLECTIONS = (
    "days", "habits", "habit_log", "sports", "activities",
    "people_log", "tasks", "periods", "plan", "plan_log", "settings",
)
ID_RE = re.compile(r"^[A-Za-z0-9_\-.~:@+]+$")
MAX_ID_LEN = 200
MAX_DOC_BYTES = 256 * 1024          # one document, as stored
MAX_IMPORT_BYTES = 64 * 1024 * 1024  # one import request

DB_NAME = "lifeos.db"

_TABLES = """
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE TABLE IF NOT EXISTS auth (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  locked       INTEGER NOT NULL DEFAULT 0,
  quick        TEXT,
  relock       INTEGER NOT NULL DEFAULT 300,
  unlock_fails INTEGER NOT NULL DEFAULT 0
);
"""

# view name -> (collection, [(column, json path or SQL expression)])
_VIEWS = {
    "v_days": ("days", [
        ("date", "id"), ("rating", "$.rating"), ("core", "$.core"), ("focus", "$.focus"),
        ("recap", "$.recap"), ("highlight", "$.highlight"), ("lowlight", "$.lowlight"),
        ("learnings", "$.learnings"), ("memory", "$.memory"), ("updated_at", "$.updatedAt"),
    ]),
    "v_habits": ("habits", [
        ("id", "id"), ("name", "$.name"), ("icon", "$.icon"), ("color", "$.color"),
        ("sort_order", "$.order"), ("archived", "$.archived"), ("archived_at", "$.archivedAt"),
        ("ranges", "$.ranges"), ("created_at", "$.createdAt"),
    ]),
    "v_habit_log": ("habit_log", [
        ("date", "$.date"), ("habit_id", "$.habitId"), ("done", "$.done"), ("at", "$.at"),
    ]),
    "v_sports": ("sports", [
        ("id", "id"), ("name", "$.name"), ("type", "$.type"), ("icon", "$.icon"),
        ("created_at", "$.createdAt"),
    ]),
    "v_activities": ("activities", [
        ("id", "id"), ("date", "$.date"), ("sport", "$.sport"), ("note", "$.note"),
        ("created_at", "$.createdAt"),
    ]),
    "v_people_log": ("people_log", [
        ("id", "id"), ("date", "$.date"), ("people", "$.people"), ("activity", "$.activity"),
        ("created_at", "$.createdAt"),
    ]),
    "v_tasks": ("tasks", [
        ("id", "id"), ("title", "$.title"), ("description", "$.description"),
        ("status", "$.status"), ("priority", "$.priority"), ("area", "$.area"),
        ("planned_for", "$.plannedFor"), ("done_on", "$.doneOn"), ("subtasks", "$.subtasks"),
        ("subtask_count", "json_array_length(json, '$.subtasks')"),
        ("created_at", "$.createdAt"),
    ]),
    "v_periods": ("periods", [
        ("id", "id"), ("kind", "$.kind"), ("start_date", "$.start"), ("end_date", "$.end"),
        ("intentions", "$.intentions"), ("worked", "$.worked"), ("didnt", "$.didnt"),
        ("why", "$.why"), ("change", "$.change"), ("plan", "$.plan"), ("review", "$.review"),
        ("plan_base", "$.planBase"), ("plan_at", "$.planAt"),
        ("closed_at", "$.closedAt"), ("updated_at", "$.updatedAt"),
    ]),
    "v_plan": ("plan", [
        ("id", "id"), ("kind", "$.kind"), ("title", "$.title"), ("ref", "$.ref"), ("week", "$.week"),
        ("date", "$.date"), ("part", "$.part"), ("sort_order", "$.order"), ("time", "$.time"),
        ("status", "$.status"), ("link", "$.link"), ("created_at", "$.createdAt"), ("updated_at", "$.updatedAt"),
    ]),
    "v_plan_log": ("plan_log", [
        ("id", "id"), ("plan_id", "$.planId"), ("title", "$.title"), ("week", "$.week"), ("kind", "$.kind"),
        ("from_date", "$.from.date"), ("from_part", "$.from.part"), ("to_date", "$.to.date"), ("to_part", "$.to.part"),
        ("timing", "$.timing"), ("reason", "$.reason"), ("at", "$.at"),
    ]),
    "v_settings": ("settings", [
        ("id", "id"), ("sport_types", "$.sportTypes"), ("areas", "$.areas"), ("theme", "$.theme"),
    ]),
}


class Invalid(ValueError):
    """A document, id or collection that the server refuses to store."""


def db_path(data_dir):
    return os.path.join(data_dir, DB_NAME)


def connect(data_dir):
    """Open a connection. Each request uses its own, so no locking is needed here."""
    con = sqlite3.connect(db_path(data_dir), timeout=10, isolation_level=None)
    con.execute("PRAGMA busy_timeout=10000")
    return con


def init(data_dir):
    """Create the database, tables and views. Safe to call at every start."""
    os.makedirs(data_dir, mode=0o700, exist_ok=True)
    con = connect(data_dir)
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript(_TABLES)
        try:
            con.execute("SELECT json_extract('{\"a\":1}', '$.a')").fetchone()
        except sqlite3.OperationalError:
            return False  # SQLite without JSON support: run without the views
        for name, (collection, columns) in _VIEWS.items():
            parts = []
            for column, source in columns:
                if source == "id":
                    expr = "id"
                elif source.startswith("$"):
                    expr = "json_extract(json, '%s')" % source
                else:
                    expr = source
                parts.append('%s AS "%s"' % (expr, column))
            con.execute("DROP VIEW IF EXISTS %s" % name)
            con.execute("CREATE VIEW %s AS SELECT %s FROM docs WHERE collection = '%s'"
                        % (name, ", ".join(parts), collection))
        return True
    finally:
        con.close()


# ---------- validation ----------

def _js_str(value):
    """String form of a JSON value as JavaScript would concatenate it."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (str, int)):
        return str(value)
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    return None


def doc_id(collection, doc):
    """The id a document must be stored under (mirrors docId() in the app)."""
    if collection == "days":
        return _js_str(doc.get("date"))
    if collection == "habit_log":
        date, habit = _js_str(doc.get("date")), _js_str(doc.get("habitId"))
        return None if date is None or habit is None else date + "_" + habit
    if collection == "settings":
        return "main"
    return _js_str(doc.get("id"))


def _no_constants(name):
    raise ValueError("%s is not valid JSON" % name)


def parse_json(raw):
    """Strict JSON: UTF-8, no NaN or Infinity."""
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode("utf-8")
    return json.loads(raw, parse_constant=_no_constants)


def encode_doc(collection, key, doc):
    """Validate one document and return the JSON text to store."""
    if collection not in COLLECTIONS:
        raise Invalid("Unknown collection: %r" % (collection,))
    if not isinstance(key, str) or len(key) > MAX_ID_LEN or not ID_RE.match(key):
        raise Invalid("Invalid id in %s: %r" % (collection, key if isinstance(key, str) else type(key).__name__))
    if not isinstance(doc, dict):
        raise Invalid("%s/%s must be a JSON object" % (collection, key))
    expected = doc_id(collection, doc)
    if expected != key:
        raise Invalid("%s/%s: the id does not match the document (expected %r)" % (collection, key, expected))
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(text.encode("utf-8")) > MAX_DOC_BYTES:
        raise Invalid("%s/%s is larger than %d bytes" % (collection, key, MAX_DOC_BYTES))
    return text


def check_ref(collection, key):
    """Validate a collection name and id taken from a URL."""
    if collection not in COLLECTIONS:
        raise Invalid("Unknown collection: %r" % (collection,))
    if len(key) > MAX_ID_LEN or not ID_RE.match(key):
        raise Invalid("Invalid id")


# ---------- documents ----------

_UPSERT = ("INSERT INTO docs (collection, id, json, updated_at) VALUES (?, ?, ?, ?) "
           "ON CONFLICT (collection, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at")


def put_doc(con, collection, key, doc, now_ms):
    con.execute(_UPSERT, (collection, key, encode_doc(collection, key, doc), now_ms))


def delete_doc(con, collection, key):
    check_ref(collection, key)
    con.execute("DELETE FROM docs WHERE collection = ? AND id = ?", (collection, key))


def export_json(con):
    """Everything, in the export format {collection: {id: doc}}, as JSON text."""
    groups = {c: [] for c in COLLECTIONS}
    for collection, key, text in con.execute("SELECT collection, id, json FROM docs ORDER BY collection, id"):
        if collection in groups:
            groups[collection].append(json.dumps(key) + ":" + text)
    return "{" + ",".join('"%s":{%s}' % (c, ",".join(groups[c])) for c in COLLECTIONS) + "}"


def import_all(con, payload, now_ms):
    """Upsert a whole export in one transaction. Nothing is written if any part is invalid."""
    if not isinstance(payload, dict):
        raise Invalid("The import must be a JSON object of collections")
    rows = []
    for collection, docs in payload.items():
        if collection not in COLLECTIONS:
            raise Invalid("Unknown collection: %r" % (collection,))
        if not isinstance(docs, dict):
            raise Invalid("%s must be an object of {id: document}" % collection)
        for key, doc in docs.items():
            rows.append((collection, key, encode_doc(collection, key, doc), now_ms))
    con.execute("BEGIN IMMEDIATE")
    try:
        con.executemany(_UPSERT, rows)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return len(rows)
