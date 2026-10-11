"""
Validate the Codex (public/data/codex/en.json) against the citation registry (public/data/citations.json).

Checks:
- citations.json: every entry has the required fields with the right types; keys the repo already uses exist.
- codex: unique entry ids, required fields, valid enums, 1-2 sentence summaries, 3-6 body paragraphs, related ids
  resolve, no unknown fields, finite numbers, and every entry the module spec requires is present.
- every fact and "how we know" item has a provenance and a citation that exists in citations.json.
- no Measured fact or claim rests on a citation marked "verified": false, or on one that is not peer reviewed
  (an arXiv-only preprint or a Research Note of the AAS; IAU resolution texts are standards, not preprints).
- self-references: Generated items must cite a Known Sky self-reference; known-sky-source (the game's own design) may
  only back Generated items; known-sky-exo-rules may not back Measured items; a fact whose label is about the game
  ("in the game", "game's", "in-game") must cite a self-reference, never an outside source that cannot contain it.
- every bodyId exists in public/data/bodies.json, every body there has an entry, and every starName is a HYG
  proper name in public/data/stars.json.

tests/unit/codex.test.ts repeats these checks in TypeScript and adds numeric and wording cross-checks against the
game's data files.

Usage:
  python3 tools/pipeline/codex_check.py               validate (exit code 1 on any error)
  python3 tools/pipeline/codex_check.py --write-docs  also regenerate the citation registry in docs/CODEX_SOURCES.md
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CODEX = ROOT / "public" / "data" / "codex" / "en.json"
CITATIONS = ROOT / "public" / "data" / "citations.json"
BODIES = ROOT / "public" / "data" / "bodies.json"
STARS = ROOT / "public" / "data" / "stars.json"
SYSTEMS = ROOT / "public" / "data" / "systems"
SOURCES_DOC = ROOT / "docs" / "CODEX_SOURCES.md"

PROVENANCE = {"measured", "inferred", "generated"}
KINDS = {"body", "star", "exoplanet", "concept"}
UNLOCKS = {"start", "visit", "scan"}
SYSTEM_IDS = {"trappist-1"}
# Keys used outside the Codex (bodies.json, star catalogue code) or required as data-source credits.
REQUIRED_CITATIONS = [
    "bruneton2008", "archinal2018", "nasa-factsheet", "nasa-saturn-factsheet",
    "hyg-v41", "jpl-horizons", "de440", "naif-pck00011", "gaia-edr3-skymap", "blue-marble-ng", "black-marble-2016",
    "etopo2022", "lroc-wac", "lola", "usgs-pluto-mosaic", "usgs-charon-mosaic", "solar-system-scope",
    "nasa-3d-resources", "nasa-exoplanet-archive",
    "agol2021", "gillon2016", "gillon2017", "burgasser2017", "greene2023", "zieba2023", "anglada2016",
]
# Entries the module spec requires (Solar System bodies are checked against bodies.json separately).
REQUIRED_IDS = [
    "trappist-1", "trappist-1b", "trappist-1c", "trappist-1d", "trappist-1e", "trappist-1f", "trappist-1g",
    "trappist-1h", "sirius", "alpha-centauri-a", "alpha-centauri-b", "proxima-centauri", "proxima-centauri-b",
    "barnards-star", "betelgeuse", "polaris", "vega",
    "concept-provenance", "concept-parallax", "concept-transit", "concept-ttv", "concept-radial-velocity",
    "concept-light-travel", "concept-sky-blue", "concept-tidal-locking", "concept-habitable-zone",
    "concept-ephemerides", "concept-star-catalogues", "concept-drive-fiction", "concept-game-surfaces",
    "concept-exoplanet-count", "concept-star-brightness",
]
# Self-references and the provenance tiers each may back.
SELF_TIERS = {
    "known-sky-source": {"generated"},
    "known-sky-exo-rules": {"generated", "inferred"},
    "known-sky-pipeline": {"measured", "inferred", "generated"},
}
GAME_LABEL = re.compile(r"\bgame\b|\bgame's\b|\bin-game\b", re.IGNORECASE)
PREPRINT_VENUE = re.compile(r"\barXiv\b|Research Notes of the AAS", re.IGNORECASE)
CITATION_FIELDS = {"authors": str, "title": str, "venue": str, "url": str, "accessed": str, "verified": bool}
CITATION_OPTIONAL = {"year", "doi", "license", "note"}
ENTRY_FIELDS = {"id", "title", "kind", "bodyId", "starName", "systemId", "unlock", "summary", "body", "facts",
                "howWeKnow", "related"}
FACT_FIELDS = {"label", "value", "unit", "uncertainty", "provenance", "method", "citation"}
CLAIM_FIELDS = {"claim", "method", "provenance", "citation"}
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SENTENCE_END = re.compile(r"[.!?](?:\s|$)")


def is_num(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def is_text(v: object) -> bool:
    return isinstance(v, str) and bool(v.strip())


def not_peer_reviewed(cite: dict) -> bool:
    """A preprint (arXiv-only) or an AAS research note; IAU resolution texts posted on arXiv are standards."""
    venue = cite.get("venue", "")
    return isinstance(venue, str) and bool(PREPRINT_VENUE.search(venue)) and "IAU" not in venue


def check_citations(cites: dict, errors: list[str]) -> None:
    if not isinstance(cites, dict) or not cites:
        errors.append("citations.json must be a non-empty object")
        return
    for key, c in cites.items():
        where = f"citation '{key}'"
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", key):
            errors.append(f"{where}: key must be lowercase letters, digits and dashes")
        if not isinstance(c, dict):
            errors.append(f"{where}: must be an object")
            continue
        for field, typ in CITATION_FIELDS.items():
            if not isinstance(c.get(field), typ) or (typ is str and not c[field].strip()):
                errors.append(f"{where}: field '{field}' missing or not a non-empty {typ.__name__}")
        if "year" not in c or not (c["year"] is None or (isinstance(c["year"], int) and not isinstance(c["year"], bool))):
            errors.append(f"{where}: 'year' must be an integer or null")
        if "doi" not in c or not (c["doi"] is None or (isinstance(c["doi"], str) and c["doi"].startswith("10."))):
            errors.append(f"{where}: 'doi' must be null or a string starting with '10.'")
        if isinstance(c.get("url"), str) and not c["url"].startswith("https://"):
            errors.append(f"{where}: url must be https")
        if isinstance(c.get("accessed"), str) and not DATE.match(c["accessed"]):
            errors.append(f"{where}: 'accessed' must be YYYY-MM-DD")
        for opt in ("license", "note"):
            if opt in c and not is_text(c[opt]):
                errors.append(f"{where}: optional '{opt}' must be a non-empty string")
        extra = set(c) - set(CITATION_FIELDS) - CITATION_OPTIONAL
        if extra:
            errors.append(f"{where}: unknown fields {sorted(extra)}")
    for key in REQUIRED_CITATIONS:
        if key not in cites:
            errors.append(f"required citation '{key}' is missing")
    for key in SELF_TIERS:
        if key not in cites:
            errors.append(f"self-reference citation '{key}' is missing")


def data_citation_users() -> dict[str, set[str]]:
    """Citation keys referenced by other data files and source code, mapped to the files that use them."""
    users: dict[str, set[str]] = {}

    def add(key: str, name: str) -> None:
        users.setdefault(key, set()).add(name)

    for key in re.findall(r'"citation":\s*"([^"]+)"', BODIES.read_text()):
        add(key, "bodies.json")
    for path in sorted(SYSTEMS.glob("*.json")):
        for key in re.findall(r'"citation":\s*"([^"]+)"', path.read_text()):
            add(key, f"systems/{path.name}")
    for path in (ROOT / "src").rglob("*.ts"):
        for key in re.findall(r"citation:\s*'([^']+)'", path.read_text()):
            add(key, "src")
    return users


def check_item(where: str, item: dict, fields: dict[str, type], cites: dict, errors: list[str]) -> None:
    for field, typ in fields.items():
        if not isinstance(item.get(field), typ) or (typ is str and not item[field].strip()):
            errors.append(f"{where}: '{field}' missing or not a non-empty {typ.__name__}")
    prov = item.get("provenance")
    if prov not in PROVENANCE:
        errors.append(f"{where}: provenance must be one of {sorted(PROVENANCE)}, got {prov!r}")
    key = item.get("citation")
    if not isinstance(key, str):
        return
    cite = cites.get(key)
    if cite is None:
        errors.append(f"{where}: unknown citation '{key}'")
        return
    if prov == "measured" and cite.get("verified") is not True:
        errors.append(f"{where}: Measured value cites unverified citation '{key}'")
    if prov == "measured" and not_peer_reviewed(cite):
        errors.append(f"{where}: Measured value cites '{key}', which is not peer reviewed ({cite.get('venue')})")
    if prov == "generated" and key not in SELF_TIERS:
        errors.append(f"{where}: Generated content must cite a Known Sky self-reference, not '{key}'")
    if key in SELF_TIERS and prov in PROVENANCE and prov not in SELF_TIERS[key]:
        errors.append(f"{where}: '{key}' may only back {sorted(SELF_TIERS[key])} items, not {prov}")


def check_codex(codex: dict, cites: dict, body_ids: set[str], star_names: set[str], errors: list[str]) -> None:
    if codex.get("version") != 1 or not isinstance(codex.get("entries"), list) or not codex["entries"]:
        errors.append("codex must be {version: 1, entries: [...]} with at least one entry")
        return
    extra_top = set(codex) - {"version", "entries"}
    if extra_top:
        errors.append(f"codex: unknown top-level fields {sorted(extra_top)}")
    entries = codex["entries"]
    ids = [e.get("id") for e in entries if isinstance(e, dict)]
    seen: set[str] = set()
    for i in ids:
        if i in seen:
            errors.append(f"duplicate entry id '{i}'")
        seen.add(i)
    for rid in REQUIRED_IDS:
        if rid not in seen:
            errors.append(f"required entry '{rid}' is missing")
    covered: set[str] = set()
    for n, e in enumerate(entries):
        if not isinstance(e, dict):
            errors.append(f"entry #{n} is not an object")
            continue
        eid = e.get("id")
        where = f"entry '{eid}'"
        if not isinstance(eid, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", eid):
            errors.append(f"entry #{n}: id must be lowercase letters, digits and dashes")
        extra = set(e) - ENTRY_FIELDS
        if extra:
            errors.append(f"{where}: unknown fields {sorted(extra)}")
        for field in ("title", "summary"):
            if not is_text(e.get(field)):
                errors.append(f"{where}: '{field}' must be a non-empty string")
        if e.get("kind") not in KINDS:
            errors.append(f"{where}: kind must be one of {sorted(KINDS)}")
        if e.get("unlock") not in UNLOCKS:
            errors.append(f"{where}: unlock must be one of {sorted(UNLOCKS)}")
        if isinstance(e.get("summary"), str) and len(SENTENCE_END.findall(e["summary"])) > 2:
            errors.append(f"{where}: summary should be one or two sentences")
        body = e.get("body")
        if not isinstance(body, list) or not 3 <= len(body) <= 6 or not all(is_text(p) for p in body):
            errors.append(f"{where}: body must be 3-6 non-empty paragraphs")
        if "bodyId" in e:
            if e["bodyId"] not in body_ids:
                errors.append(f"{where}: bodyId '{e['bodyId']}' not in bodies.json")
            covered.add(e["bodyId"])
            if e.get("kind") != "body":
                errors.append(f"{where}: bodyId is only valid on kind 'body'")
        elif e.get("kind") == "body":
            errors.append(f"{where}: kind 'body' requires a bodyId")
        if "starName" in e and e["starName"] not in star_names:
            errors.append(f"{where}: starName '{e['starName']}' is not a HYG proper name in stars.json")
        if "systemId" in e and e["systemId"] not in SYSTEM_IDS:
            errors.append(f"{where}: unknown systemId '{e['systemId']}'")
        if e.get("kind") == "exoplanet" and "systemId" not in e and "starName" not in e:
            errors.append(f"{where}: exoplanet entries need a systemId or starName")
        facts = e.get("facts")
        if not isinstance(facts, list):
            errors.append(f"{where}: facts must be a list")
            facts = []
        for k, f in enumerate(facts):
            fw = f"{where} fact #{k} ({f.get('label') if isinstance(f, dict) else '?'})"
            if not isinstance(f, dict):
                errors.append(f"{fw}: not an object")
                continue
            check_item(fw, f, {"label": str, "method": str, "citation": str}, cites, errors)
            if not (is_num(f.get("value")) or is_text(f.get("value"))):
                errors.append(f"{fw}: value must be a finite number or a non-empty string")
            if "unit" in f and not is_text(f["unit"]):
                errors.append(f"{fw}: unit must be a non-empty string")
            if "uncertainty" in f and not (is_num(f["uncertainty"]) or is_text(f["uncertainty"])):
                errors.append(f"{fw}: uncertainty must be a finite number or a non-empty string")
            if isinstance(f.get("label"), str) and GAME_LABEL.search(f["label"]) and f.get("citation") not in SELF_TIERS:
                errors.append(f"{fw}: a fact about the game must cite a Known Sky self-reference, not '{f.get('citation')}'")
            extra = set(f) - FACT_FIELDS
            if extra:
                errors.append(f"{fw}: unknown fields {sorted(extra)}")
        how = e.get("howWeKnow")
        if not isinstance(how, list) or not how:
            errors.append(f"{where}: howWeKnow must be a non-empty list")
            how = []
        for k, h in enumerate(how):
            hw = f"{where} howWeKnow #{k}"
            if not isinstance(h, dict):
                errors.append(f"{hw}: not an object")
                continue
            check_item(hw, h, {"claim": str, "method": str, "citation": str}, cites, errors)
            extra = set(h) - CLAIM_FIELDS
            if extra:
                errors.append(f"{hw}: unknown fields {sorted(extra)}")
        related = e.get("related")
        if not isinstance(related, list) or not all(isinstance(r, str) for r in related):
            errors.append(f"{where}: related must be a list of entry ids")
        else:
            for r in related:
                if r not in ids:
                    errors.append(f"{where}: related id '{r}' does not exist")
                if r == eid:
                    errors.append(f"{where}: related lists itself")
    for bid in sorted(body_ids - covered):
        errors.append(f"bodies.json body '{bid}' has no Codex entry")


# --- Citation registry in docs/CODEX_SOURCES.md ----------------------------------------------------------------------
REGISTRY_START = "<!-- citation-registry:start (generated by tools/pipeline/codex_check.py --write-docs) -->"
REGISTRY_END = "<!-- citation-registry:end -->"
GROUPS: list[tuple[str, list[str]]] = [
    ("Game data sources", [
        "archinal2018", "archinal2019", "naif-pck00011", "naif-gm-de440", "acton1996", "de440", "jpl-horizons",
        "jpl-ephemerides", "jpl-sat-phys", "jpl-sat-discovery", "jpl-astro-constants", "hyg-v41", "vanleeuwen2007",
        "gaia-dr3-archive", "gaia-edr3-skymap", "blue-marble-ng", "blue-marble-2002-clouds", "black-marble-2016",
        "black-marble-2016-maps", "etopo2022", "svs-cgi-moon-kit", "lroc-wac", "lola", "usgs-pluto-mosaic",
        "usgs-charon-mosaic", "usgs-titan-mosaic", "nasa-pia19658", "usgs-enceladus-mosaic", "usgs-io-mosaic",
        "usgs-europa-mosaic", "usgs-ganymede-mosaic", "usgs-callisto-mosaic", "usgs-triton-mosaic",
        "usgs-phobos-mosaic", "solar-system-scope", "nasa-3d-resources", "karkoschka1994", "nasa-exoplanet-archive",
        "nea-pscomppars", "bruneton2008", "ballesteros2012",
    ]),
    ("Known Sky self-references", ["known-sky-source", "known-sky-pipeline", "known-sky-exo-rules"]),
    ("NASA fact sheets and mission pages", [
        "esa-juice", "nasa-callisto", "nasa-charon", "nasa-deimos", "nasa-dragonfly", "nasa-earth-facts",
        "nasa-earth-factsheet", "nasa-europa-clipper", "nasa-factsheet", "nasa-ganymede", "nasa-io",
        "nasa-jovian-satellites-factsheet", "nasa-jupiter-facts", "nasa-jupiter-factsheet", "nasa-lunar-samples",
        "nasa-mars-factsheet", "nasa-mercury-factsheet", "nasa-moon-factsheet", "nasa-neptune-facts",
        "nasa-neptune-factsheet", "nasa-neptunian-satellites-factsheet", "nasa-phobos", "nasa-pluto-factsheet",
        "nasa-saturn-factsheet", "nasa-saturn-rings-factsheet", "nasa-saturnian-satellites-factsheet",
        "nasa-sun-facts", "nasa-sun-factsheet", "nasa-titan", "nasa-triton", "nasa-uranus-facts",
        "nasa-uranus-factsheet", "nasa-venus-facts", "nasa-venus-factsheet",
    ]),
    ("Standards and definitions", ["iau2012-b2", "prsa2016", "mamajek2015", "iau2006-b5b6", "iau-csn"]),
    ("TRAPPIST-1", [
        "agol2021", "agol2024", "gillon2016", "gillon2017", "luger2017", "burgasser2017", "mann2019", "ducrot2020",
        "greene2023", "zieba2023", "lim2023", "ducrot2025", "gillon2026", "piaulet2025", "espinoza2025",
        "glidden2025", "lim2026",
    ]),
    ("Nearby and notable stars", [
        "anglada2016", "suarezmascareno2020", "faria2022", "suarezmascareno2025", "kervella2017", "howard2018",
        "pourbaix2016", "kervella2016", "kervella2017radii", "beichman2025", "sanghi2025", "rajpaul2016",
        "barnard1916", "gonzalezhernandez2024", "basant2025", "lubin2021", "montarges2021", "dupree2020",
        "joyce2020", "howell2025", "goldberg2025", "evans2024", "peterson2006", "aufdenberg2006", "aumann1984",
        "su2024", "bond2017",
    ]),
    ("Star catalogues and astrometry", [
        "esa-hipparcos", "perryman1997", "prusti2016", "brown2021", "vallenari2023", "esa-gaia-dr3",
        "esa-gaia-news-2026", "esa-gaia-parallax", "esa-measuring-parallax",
    ]),
    ("Concepts (methods, physics)", [
        "mayor1995", "charbonneau2000", "henry2000", "borucki2010", "agol2005", "holman2005", "holman2010",
        "kasting1993", "kopparapu2013", "alcubierre1994", "morris1988", "pfenning1997", "vandenbroeck1999",
        "einstein1905", "rayleigh1871", "nasa-blue-sky", "nasa-mars-sunset", "nasa-tidal-locking",
        "nasa-habitable-zone", "nasa-voyager1", "nasa-voyager-factsheet",
    ]),
    ("Solar System science", [
        "agnor2006", "bolton2017", "bouvier2010", "canup2001", "connelly2012", "elliot1977", "fulchignoni2005",
        "grotzinger2014", "grundy2016", "hyodo2025", "iess2019", "kempf2023", "khurana1998", "kivelson1996",
        "kivelson2000", "lawrence2013", "morabito1979", "nimmo2017", "peale1979", "porco2006", "postberg2023",
        "saur2015", "smith1989", "smith2001mola", "soderblom1990", "stern2015", "stofan2007", "thomas2016",
        "tomasko2005", "waite2017",
    ]),
]
OTHER_GROUP = "Other sources in the registry (added by other modules)"


def registry_markdown(cites: dict, codex: dict) -> str:
    users = data_citation_users()
    for e in codex["entries"]:
        for item in e["facts"] + e["howWeKnow"]:
            users.setdefault(item["citation"], set()).add(e["id"])
    placed = {k for _, keys in GROUPS for k in keys}
    groups = [(name, [k for k in keys if k in cites]) for name, keys in GROUPS]
    others = sorted(k for k in cites if k not in placed)
    if others:
        groups.append((OTHER_GROUP, others))
    out = [REGISTRY_START, ""]
    for name, keys in groups:
        if not keys:
            continue
        out += [f"### {name}", "", "| Key | Reference | Used by | Verified |", "|---|---|---|---|"]
        for k in keys:
            c = cites[k]
            link = f"doi:{c['doi']}" if c.get("doi") else c["url"]
            year = c["year"] if c.get("year") is not None else "n.d."
            ref = f"{c['authors']} ({year}). *{c['title']}*. {c['venue']}. {link}".replace("|", "\\|")
            names = users.get(k, set())
            files = sorted(n for n in names if "." in n or n == "src")
            entries = sorted(n for n in names if n not in files)
            listed = files + entries
            used = ", ".join(listed[:6]) + (f" +{len(listed) - 6} more" if len(listed) > 6 else "") or "(registry only)"
            out.append(f"| `{k}` | {ref} | {used} | {'yes' if c['verified'] else 'no'} |")
        out.append("")
    out.append(REGISTRY_END)
    return "\n".join(out)


def sync_registry(cites: dict, codex: dict, write: bool) -> bool:
    """Returns True when docs/CODEX_SOURCES.md holds the current registry (after writing it, if asked)."""
    text = SOURCES_DOC.read_text()
    start, end = text.find(REGISTRY_START), text.find(REGISTRY_END)
    if start < 0 or end < 0:
        return False
    fresh = text[:start] + registry_markdown(cites, codex) + text[end + len(REGISTRY_END):]
    if fresh == text:
        return True
    if write:
        SOURCES_DOC.write_text(fresh)
        return True
    return False


def main(argv: list[str]) -> int:
    errors: list[str] = []
    cites = json.loads(CITATIONS.read_text())
    codex = json.loads(CODEX.read_text())
    bodies = json.loads(BODIES.read_text())["bodies"]
    body_ids = {b["id"] for b in bodies}
    star_names = {s["name"] for s in json.loads(STARS.read_text())["named"].values()}
    check_citations(cites, errors)
    for key in sorted(data_citation_users()):
        if key not in cites:
            errors.append(f"citation '{key}' is used in the repository but missing from citations.json")
    check_codex(codex, cites, body_ids, star_names, errors)
    if errors:
        for err in errors:
            print("ERROR:", err)
        print(f"codex_check: {len(errors)} error(s)")
        return 1
    n_facts = sum(len(e["facts"]) for e in codex["entries"])
    n_claims = sum(len(e["howWeKnow"]) for e in codex["entries"])
    used = {i["citation"] for e in codex["entries"] for i in e["facts"] + e["howWeKnow"]}
    unverified = sorted(k for k, c in cites.items() if not c["verified"])
    print(f"codex_check: OK - {len(codex['entries'])} entries, {n_facts} facts, {n_claims} claims, {len(cites)} citations "
          f"({len(used)} cited by the Codex; unverified: {', '.join(unverified) or 'none'})")
    if not sync_registry(cites, codex, "--write-docs" in argv):
        print("NOTE: the citation registry in docs/CODEX_SOURCES.md is out of date; run with --write-docs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
