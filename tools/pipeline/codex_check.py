"""
Validate the Codex (public/data/codex/en.json) against the citation registry (public/data/citations.json).

Checks:
- citations.json: every entry has the required fields with the right types; keys the repo already uses exist.
- codex: unique entry ids, required fields, valid enums, 3-6 body paragraphs, related ids resolve.
- every fact and "how we know" item has a provenance and a citation that exists in citations.json.
- no Measured fact or claim rests on a citation marked "verified": false.
- every bodyId exists in public/data/bodies.json, every body there has an entry, and every starName is a HYG
  proper name in public/data/stars.json.

Usage: python3 tools/pipeline/codex_check.py   (exit code 1 on any error)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CODEX = ROOT / "public" / "data" / "codex" / "en.json"
CITATIONS = ROOT / "public" / "data" / "citations.json"
BODIES = ROOT / "public" / "data" / "bodies.json"
STARS = ROOT / "public" / "data" / "stars.json"

PROVENANCE = {"measured", "inferred", "generated"}
KINDS = {"body", "star", "exoplanet", "concept"}
UNLOCKS = {"start", "visit", "scan"}
SYSTEMS = {"trappist-1"}
# Keys used outside the Codex (bodies.json, star catalogue code) or required as data-source credits.
REQUIRED_CITATIONS = [
    "bruneton2008", "archinal2018", "nasa-factsheet", "nasa-saturn-factsheet",
    "hyg-v41", "jpl-horizons", "de440", "naif-pck00011", "gaia-edr3-skymap", "blue-marble-ng", "black-marble-2016",
    "etopo2022", "lroc-wac", "lola", "usgs-pluto-mosaic", "usgs-charon-mosaic", "solar-system-scope",
    "nasa-3d-resources", "nasa-exoplanet-archive",
    "agol2021", "gillon2016", "gillon2017", "burgasser2017", "greene2023", "zieba2023", "anglada2016",
]
CITATION_FIELDS = {"authors": str, "title": str, "venue": str, "url": str, "accessed": str, "verified": bool}
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def is_num(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


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
            if not isinstance(c.get(field), typ) or (typ is str and not c.get(field).strip()):
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
            if opt in c and not (isinstance(c[opt], str) and c[opt].strip()):
                errors.append(f"{where}: optional '{opt}' must be a non-empty string")
        extra = set(c) - set(CITATION_FIELDS) - {"year", "doi", "license", "note"}
        if extra:
            errors.append(f"{where}: unknown fields {sorted(extra)}")
    for key in REQUIRED_CITATIONS:
        if key not in cites:
            errors.append(f"required citation '{key}' is missing")


def repo_citation_keys() -> set[str]:
    """Citation keys referenced by other data files and source code."""
    keys: set[str] = set()
    text = BODIES.read_text()
    keys.update(re.findall(r'"citation":\s*"([^"]+)"', text))
    for path in (ROOT / "src").rglob("*.ts"):
        keys.update(re.findall(r"citation:\s*'([^']+)'", path.read_text()))
    return keys


def check_item(where: str, item: dict, fields: dict[str, type], cites: dict, errors: list[str]) -> None:
    for field, typ in fields.items():
        if not isinstance(item.get(field), typ) or (typ is str and not item[field].strip()):
            errors.append(f"{where}: '{field}' missing or not a non-empty {typ.__name__}")
    prov = item.get("provenance")
    if prov not in PROVENANCE:
        errors.append(f"{where}: provenance must be one of {sorted(PROVENANCE)}, got {prov!r}")
    key = item.get("citation")
    if isinstance(key, str):
        cite = cites.get(key)
        if cite is None:
            errors.append(f"{where}: unknown citation '{key}'")
        elif prov == "measured" and cite.get("verified") is not True:
            errors.append(f"{where}: Measured value cites unverified citation '{key}'")


def check_codex(codex: dict, cites: dict, body_ids: set[str], star_names: set[str], errors: list[str]) -> None:
    if codex.get("version") != 1 or not isinstance(codex.get("entries"), list) or not codex["entries"]:
        errors.append("codex must be {version: 1, entries: [...]} with at least one entry")
        return
    entries = codex["entries"]
    ids = [e.get("id") for e in entries if isinstance(e, dict)]
    seen: set[str] = set()
    for i in ids:
        if i in seen:
            errors.append(f"duplicate entry id '{i}'")
        seen.add(i)
    covered: set[str] = set()
    allowed = {"id", "title", "kind", "bodyId", "starName", "systemId", "unlock", "summary", "body", "facts", "howWeKnow", "related"}
    for n, e in enumerate(entries):
        if not isinstance(e, dict):
            errors.append(f"entry #{n} is not an object")
            continue
        eid = e.get("id")
        where = f"entry '{eid}'"
        if not isinstance(eid, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", eid):
            errors.append(f"entry #{n}: id must be lowercase letters, digits and dashes")
        extra = set(e) - allowed
        if extra:
            errors.append(f"{where}: unknown fields {sorted(extra)}")
        for field in ("title", "summary"):
            if not isinstance(e.get(field), str) or not e[field].strip():
                errors.append(f"{where}: '{field}' must be a non-empty string")
        if e.get("kind") not in KINDS:
            errors.append(f"{where}: kind must be one of {sorted(KINDS)}")
        if e.get("unlock") not in UNLOCKS:
            errors.append(f"{where}: unlock must be one of {sorted(UNLOCKS)}")
        if isinstance(e.get("summary"), str) and len(re.findall(r"[.!?](?:\s|$)", e["summary"])) > 2:
            errors.append(f"{where}: summary should be one or two sentences")
        body = e.get("body")
        if not isinstance(body, list) or not 3 <= len(body) <= 6 or not all(isinstance(p, str) and p.strip() for p in body):
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
        if "systemId" in e and e["systemId"] not in SYSTEMS:
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
            if not (is_num(f.get("value")) or (isinstance(f.get("value"), str) and f["value"].strip())):
                errors.append(f"{fw}: value must be a number or non-empty string")
            if "unit" in f and not (isinstance(f["unit"], str) and f["unit"].strip()):
                errors.append(f"{fw}: unit must be a non-empty string")
            if "uncertainty" in f and not (is_num(f["uncertainty"]) or (isinstance(f["uncertainty"], str) and f["uncertainty"].strip())):
                errors.append(f"{fw}: uncertainty must be a number or non-empty string")
            extra = set(f) - {"label", "value", "unit", "uncertainty", "provenance", "method", "citation"}
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
            extra = set(h) - {"claim", "method", "provenance", "citation"}
            if extra:
                errors.append(f"{hw}: unknown fields {sorted(extra)}")
        related = e.get("related")
        if not isinstance(related, list) or not all(isinstance(r, str) for r in related):
            errors.append(f"{where}: related must be a list of entry ids")
        else:
            for r in related:
                if r not in seen and r not in ids:
                    errors.append(f"{where}: related id '{r}' does not exist")
                if r == eid:
                    errors.append(f"{where}: related lists itself")
    for bid in sorted(body_ids - covered):
        errors.append(f"bodies.json body '{bid}' has no Codex entry")


def main() -> int:
    errors: list[str] = []
    cites = json.loads(CITATIONS.read_text())
    codex = json.loads(CODEX.read_text())
    bodies = json.loads(BODIES.read_text())["bodies"]
    body_ids = {b["id"] for b in bodies}
    star_names = {s["name"] for s in json.loads(STARS.read_text())["named"].values()}
    check_citations(cites, errors)
    for key in sorted(repo_citation_keys()):
        if key not in cites:
            errors.append(f"citation '{key}' is used in the repository but missing from citations.json")
    check_codex(codex, cites, body_ids, star_names, errors)
    n_facts = sum(len(e.get("facts", [])) for e in codex.get("entries", []) if isinstance(e, dict))
    if errors:
        for err in errors:
            print("ERROR:", err)
        print(f"codex_check: {len(errors)} error(s)")
        return 1
    used = {f["citation"] for e in codex["entries"] for f in e["facts"]} | {h["citation"] for e in codex["entries"] for h in e["howWeKnow"]}
    unverified = sorted(k for k, c in cites.items() if not c["verified"])
    print(f"codex_check: OK - {len(codex['entries'])} entries, {n_facts} facts, {len(cites)} citations "
          f"({len(used)} cited by the Codex; unverified: {', '.join(unverified) or 'none'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
