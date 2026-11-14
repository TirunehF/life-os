#!/usr/bin/env python3
"""Developer tool: download the fonts that Life OS serves from app/fonts/.

The running app never contacts a font host. This script is the only place
that does, and you only run it by hand when the font list or the icon list
changes:

    python3 tools/fetch-fonts.py

What it does
  * reads the FONTS list from app/index.html (the fonts offered in
    Settings -> Appearance) and downloads every woff2 file the matching
    Google Fonts stylesheet points to;
  * downloads the Material Symbols Outlined subset that contains exactly
    the icons in ICON_NAMES below;
  * writes one stylesheet per family to app/fonts/<slug>.css with relative
    URLs, the licence texts, and prints the @font-face rules that are
    inlined at the top of app/index.html.

To add an icon: add its name to ICON_NAMES (keep the list sorted), run this
script, and paste the printed "inline rules" over the existing ones in
app/index.html if they changed. tests/test_static.py checks that every icon
the app uses is in this list.
"""
import hashlib
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "app" / "fonts"

# A current desktop browser User-Agent, so the stylesheets list woff2 files.
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/155.0.0.0 Safari/537.36")

CSS_API = "https://fonts.googleapis.com/css2?family="

# The icon subset. The icon picker and every icon in the interface depend on it.
ICON_NAMES = (
    "add,alarm,archive,auto_awesome,bedtime,block,bolt,brush,build,calendar_month,"
    "camera_alt,celebration,chat,check_circle,checklist,chevron_left,chevron_right,"
    "cleaning_services,code,cottage,description,directions_bike,directions_car,"
    "directions_run,directions_walk,downhill_skiing,drag_indicator,eco,edit,"
    "emoji_events,expand_more,favorite,fitness_center,flag,flight,forest,groups,"
    "headphones,hiking,home,hotel,hourglass_empty,ice_skating,kayaking,kitesurfing,"
    "landscape,language,laptop,local_cafe,local_florist,lunch_dining,mail,menu_book,"
    "mic,movie,music_note,nightlight,nordic_walking,notes,nutrition,palette,park,"
    "pause_circle,person,pets,phone,piano,pool,progress_activity,psychology,push_pin,"
    "radio_button_unchecked,restaurant,rowing,sailing,savings,school,science,"
    "self_improvement,settings,shopping_cart,skateboarding,snowboarding,spa,"
    "sports_bar,sports_basketball,sports_esports,sports_gymnastics,sports_handball,"
    "sports_martial_arts,sports_soccer,sports_tennis,sports_volleyball,star,"
    "subdirectory_arrow_right,sunny,surfing,terrain,theater_comedy,timer,"
    "travel_explore,videocam,view_kanban,view_list,view_week,volunteer_activism,"
    "water_drop,work,yard"
).split(",")

SYMBOLS_QUERY = ("Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..24,400,0..1,0"
                 "&icon_names=" + ",".join(ICON_NAMES) + "&display=block")

# Licence texts, fetched from the upstream font repositories.
OFL = "https://raw.githubusercontent.com/google/fonts/main/ofl/%s/OFL.txt"
LICENCES = {
    "Instrument Sans": OFL % "instrumentsans",
    "Inter": OFL % "inter",
    "Manrope": OFL % "manrope",
    "DM Sans": OFL % "dmsans",
    "IBM Plex Sans": OFL % "ibmplexsans",
    "Space Grotesk": OFL % "spacegrotesk",
    "Lora": OFL % "lora",
    "Fraunces": OFL % "fraunces",
    "Material Symbols": "https://raw.githubusercontent.com/google/material-design-icons/master/LICENSE",
}


def slug(name):
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", name.lower())) or "x"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def app_fonts():
    """[(name, css2 query)] parsed from the FONTS list in app/index.html."""
    html = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
    block = re.search(r"const FONTS=\[(.*?)\];", html, re.S)
    if not block:
        sys.exit("FONTS list not found in app/index.html")
    return re.findall(r"\{name:'([^']+)',css:'([^']+)'\}", block.group(1))


RULE = re.compile(r"(?:/\*\s*([\w-]+)\s*\*/\s*)?@font-face\s*\{(.*?)\}", re.S)


def localise(css, family_slug, single_name=None):
    """Download every font file in `css`; return the rules with local file names."""
    seen = {}
    out = []
    for subset, body in RULE.findall(css):
        url = re.search(r"url\((https://[^)]+)\)", body).group(1)
        if url not in seen:
            data = fetch(url)
            if data[:4] != b"wOF2":
                sys.exit("not a woff2 file: " + url)
            # The content hash in the name lets the server cache fonts forever.
            digest = hashlib.sha256(data).hexdigest()[:8]
            if single_name:
                name = "%s.%s.woff2" % (single_name, digest)
            else:
                style = re.search(r"font-style:\s*(\w+)", body).group(1)
                weight = re.search(r"font-weight:\s*([\d ]+)", body).group(1).strip().replace(" ", "-")
                name = "%s-%s-%s-%s.%s.woff2" % (family_slug, style, weight, subset or "all", digest)
            (FONT_DIR / name).write_bytes(data)
            seen[url] = name
            print("  %-58s %7d bytes" % (name, len(data)))
        body = body.replace(url, seen[url])
        body = re.sub(r"\s+", " ", body).strip()
        body = re.sub(r"\s*([:;,])\s*", r"\1", body).rstrip(";")
        out.append("@font-face{%s}" % body)
    return out


def main():
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    for old in list(FONT_DIR.glob("*.woff2")) + list(FONT_DIR.glob("*.css")):
        old.unlink()

    inline = []
    for i, (name, query) in enumerate(app_fonts()):
        print(name)
        css = fetch(CSS_API + query + "&display=swap").decode("utf-8")
        rules = localise(css, slug(name))
        (FONT_DIR / (slug(name) + ".css")).write_text("\n".join(rules) + "\n", encoding="utf-8")
        if i == 0:  # the default font is also inlined in index.html
            inline += [r.replace("url(", "url(fonts/") for r in rules]

    print("Material Symbols Outlined (%d icons)" % len(ICON_NAMES))
    css = fetch(CSS_API + SYMBOLS_QUERY).decode("utf-8")
    rules = localise(css, "material-symbols-outlined", "material-symbols-outlined")
    inline += [r.replace("url(", "url(fonts/") for r in rules[:1]]

    print("Licences")
    for family, url in LICENCES.items():
        target = FONT_DIR / ("LICENSE-" + family.replace(" ", "") + ".txt")
        target.write_bytes(fetch(url))
        print("  " + target.name)

    print("\nInline rules for the top of the <style> block in app/index.html:\n")
    print("\n".join(inline))


if __name__ == "__main__":
    main()
