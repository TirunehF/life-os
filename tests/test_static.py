"""Checks on the files themselves: no outside hosts, icon coverage, no private data.

    python3 -m unittest discover -s tests -v
"""
import json
import os
import re
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
sys.path.insert(0, os.path.join(ROOT, "server"))

from lifeos.app import CSP  # noqa: E402

TEXT = (".html", ".js", ".css", ".svg", ".webmanifest", ".json", ".md", ".py", ".sh", ".mjs", ".txt", ".yml",
        ".service", ".timer", "")


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


def app_files():
    for folder, _dirs, names in os.walk(APP):
        for name in names:
            yield os.path.relpath(os.path.join(folder, name), APP)


class FrontEnd(unittest.TestCase):
    def setUp(self):
        self.html = read("app", "index.html")

    def test_no_outside_hosts_in_app(self):
        """Rule: the running app loads nothing from, and sends nothing to, another host."""
        allowed = (
            "http://www.w3.org/2000/svg",          # an XML namespace, never fetched
        )
        for rel in app_files():
            if not rel.endswith((".html", ".js", ".css", ".svg", ".webmanifest")):
                continue                            # fonts, images and the licence texts
            text = read("app", rel)
            for url in re.findall(r"https?://[^\s\"'<>)]+", text):
                if url in allowed:
                    continue
                line = next(l for l in text.split("\n") if url in l)
                # the one documentation link: where to get the code, shown in the demo banner
                self.assertTrue(rel == "config.js" and "LIFEOS_REPO" in line and url.startswith("https://github.com/"),
                                "%s refers to an outside host: %s" % (rel, url))
        self.assertNotIn("//fonts.", self.html)
        self.assertIsNone(re.search(r"\bclaude\.\w+\(", self.html), "no artifact runtime calls are left")
        self.assertNotIn("lifeos:v1", self.html, "the browser-only data mode is gone")

    def test_urls_are_relative(self):
        """The same files must work at a domain root (the server) and under a sub-path (GitHub Pages)."""
        for attr in re.findall(r"(?:href|src)=\"([^\"]+)\"", self.html):
            if attr.startswith("#") or attr.startswith("'+"):
                continue
            self.assertFalse(attr.startswith("/") or "://" in attr, "absolute URL in index.html: " + attr)
        for call in re.findall(r"api\('(?:GET|POST|PUT|DELETE)','([^']+)'", self.html):
            self.assertTrue(call.startswith("api/"), call)
        self.assertNotIn("fetch('/", self.html)
        manifest = json.loads(read("app", "manifest.webmanifest"))
        self.assertEqual((manifest["name"], manifest["short_name"], manifest["display"]), ("Life OS", "Life OS", "standalone"))
        self.assertEqual((manifest["start_url"], manifest["scope"]), ("./", "./"))
        sizes = set()
        for icon in manifest["icons"]:
            self.assertTrue(os.path.isfile(os.path.join(APP, icon["src"])), icon["src"])
            sizes.add(icon["sizes"])
        self.assertTrue({"192x192", "512x512"} <= sizes)

    def test_repo_config_is_demo_and_mode_is_never_probed(self):
        config = read("app", "config.js")
        self.assertIn("window.LIFEOS_MODE='demo'", config)
        self.assertNotIn("'server'", re.sub(r"/\*.*?\*/", "", config, flags=re.S))
        self.assertIn("<script src=\"config.js\"></script>", self.html)
        mode = re.search(r"const MODE=([^;]+);", self.html).group(1)
        self.assertEqual(mode, "window.LIFEOS_MODE==='server'||window.LIFEOS_MODE==='demo'?window.LIFEOS_MODE:'none'")
        self.assertIn("'api/auth/state'", self.html)
        self.assertIn("else if(this.mode==='server')Auth.boot();else{S.status='error'", self.html)

    def test_page_csp_matches_the_server(self):
        meta = re.search(r"<meta http-equiv=\"Content-Security-Policy\" content=\"([^\"]+)\">", self.html).group(1)
        self.assertEqual(meta + "; frame-ancestors 'none'", CSP)   # frame-ancestors only works as a header
        self.assertNotIn("http", meta)

    def test_every_icon_is_in_the_font_subset(self):
        tool = read("tools", "fetch-fonts.py")
        names = re.search(r"ICON_NAMES = \((.*?)\)\.split", tool, re.S).group(1)
        subset = set("".join(re.findall(r"\"([^\"]*)\"", names)).split(","))
        self.assertEqual(sorted(subset), "".join(re.findall(r"\"([^\"]*)\"", names)).split(","), "keep ICON_NAMES sorted")
        html = self.html
        used = set(re.search(r"const ICONS='([^']+)'", html).group(1).split(","))
        used |= set(re.findall(r"\bms\('([a-z_0-9]+)'", html))
        used |= set(re.findall(r"icon:'([a-z_0-9]+)'", html))
        used |= set(re.findall(r"<span class=\"ms[^\"]*\"[^>]*>([a-z_0-9]+)</span>", html))
        keywords = re.search(r"const KEYWORDS=\[(.*?)\];\n", html, re.S).group(1)
        used |= set(re.findall(r"','([a-z_0-9]+)'\]", keywords))
        emoji = re.search(r"const EMOJI_MAP=\{(.*?)\};", html).group(1)
        used |= set(re.findall(r":'([a-z_0-9]+)'", emoji))
        self.assertGreater(len(used), 100)
        self.assertEqual(sorted(used - subset), [], "icons used by the app but missing from tools/fetch-fonts.py")
        demo = os.path.join(APP, "demo.js")
        if os.path.exists(demo):
            icons = set(re.findall(r"icon: ?'([a-z_0-9]*)'", read("app", "demo.js"))) - {""}
            self.assertEqual(sorted(icons - subset), [], "demo data uses icons outside the subset")

    def test_font_files_match_the_stylesheets(self):
        on_disk = {f for f in os.listdir(os.path.join(APP, "fonts")) if f.endswith(".woff2")}
        referenced = set(os.path.basename(u) for u in re.findall(r"url\((fonts/[^)]+\.woff2)\)", self.html))
        self.assertEqual(len(referenced), 5, "four text font files and the icon font are inlined")
        for sheet in os.listdir(os.path.join(APP, "fonts")):
            if sheet.endswith(".css"):
                referenced |= set(re.findall(r"url\(([^)]+\.woff2)\)", read("app", "fonts", sheet)))
        self.assertEqual(on_disk, referenced)
        fonts = re.findall(r"\{name:'([^']+)',css:", re.search(r"const FONTS=\[(.*?)\];", self.html).group(1))
        for name in fonts:
            slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
            self.assertTrue(os.path.isfile(os.path.join(APP, "fonts", slug + ".css")), name)
            self.assertTrue(os.path.isfile(os.path.join(APP, "fonts", "LICENSE-" + name.replace(" ", "") + ".txt")), name)
        self.assertTrue(os.path.isfile(os.path.join(APP, "fonts", "LICENSE-MaterialSymbols.txt")))


class Repository(unittest.TestCase):
    def tracked(self):
        try:
            out = subprocess.run(["git", "ls-files"], cwd=ROOT, check=True, capture_output=True, text=True).stdout
        except (OSError, subprocess.CalledProcessError):
            self.skipTest("not a git checkout")
        return [f for f in out.split("\n") if f]

    def test_private_notes_are_ignored(self):
        ignore = read(".gitignore").split("\n")
        for name in ("BRIEF.md", "HANDOFF.md", "DECISIONS.md"):
            self.assertIn(name, ignore)
            self.assertNotIn(name, self.tracked())

    def test_nothing_private_is_tracked(self):
        """The repo is public: no local addresses, home folders, tailnet names or mail addresses."""
        patterns = {
            "private IPv4 address": r"\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b",
            "tailnet address": r"\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b",
            "home folder": r"/home/(?!you\b|pi\b|USER\b|someone\b)[a-z][a-z0-9_-]*",
            "tailnet host name": r"\b[a-z0-9-]+\.(?!example\.)[a-z0-9-]+\.ts\.net\b",
            "mail address": r"\b[A-Za-z0-9._%+-]+@(?!example\.|users\.noreply\.github\.com|anthropic\.com)[A-Za-z0-9-]+\.[a-z]{2,}\b",
        }
        for rel in self.tracked():
            if not rel.endswith(TEXT) or rel.startswith("app/fonts/LICENSE"):
                continue
            path = os.path.join(ROOT, rel)
            if os.path.getsize(path) > 2_000_000:
                continue
            try:
                text = read(rel)
            except UnicodeDecodeError:
                continue
            for label, pattern in patterns.items():
                if rel == "tests/test_static.py" and label in ("home folder",):
                    continue
                found = [m for m in re.findall(pattern, text)
                         if not (rel.startswith("tests/") and m in ("pi.tail1234.ts.net", "lifeos.example.ts.net"))]
                self.assertEqual(found, [], "%s in %s" % (label, rel))


if __name__ == "__main__":
    unittest.main()
