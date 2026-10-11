"""
Build public/data/bodies.json: the Solar System body catalog.

Rotation models (IAU WGCCRE 2015, Archinal et al. 2018), triaxial radii and GM values are read from NAIF's generic
kernels (pck00011.tpc, gm_de440.tpc), not typed by hand. Presentation metadata (textures, atmosphere parameters,
terrain kind) is curated below, each with provenance.

Usage: tools/.venv/bin/python tools/pipeline/bodies.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "tools" / ".cache" / "raw"
OUT = ROOT / "public" / "data" / "bodies.json"


def parse_kpl(path: Path) -> dict[str, list[float]]:
    """Parse the \\begindata sections of a NAIF text kernel into {NAME: [values]}."""
    data: dict[str, list[float]] = {}
    in_data = False
    buf = ""
    for line in path.read_text(errors="replace").splitlines():
        s = line.strip()
        if s.startswith("\\begindata"):
            in_data = True
            continue
        if s.startswith("\\begintext"):
            in_data = False
            continue
        if in_data:
            buf += " " + s
    for m in re.finditer(r"([A-Z0-9_]+)\s*\+?=\s*\(([^)]*)\)|([A-Z0-9_]+)\s*\+?=\s*([-+0-9.EeDd]+)", buf):
        name = m.group(1) or m.group(3)
        raw = m.group(2) if m.group(1) else m.group(4)
        vals = []
        for tok in re.split(r"[\s,]+", raw.strip()):
            if not tok or tok.startswith("'"):
                continue
            try:
                vals.append(float(tok.replace("D", "E").replace("d", "e")))
            except ValueError:
                pass
        data[name] = vals
    return data


# Presentation metadata. Textures refer to files produced by tools/pipeline/textures.py.
# atmosphere: Rayleigh/Mie scattering per meter at sea level (RGB 680/550/440 nm), scale heights in meters.
EARTH_ATMOS = {
    "heightM": 100_000,
    "rayleigh": [5.802e-6, 13.558e-6, 33.1e-6],
    "rayleighScaleHeightM": 8000,
    "mie": 3.996e-6,
    "mieExtinction": 4.44e-6,
    "mieScaleHeightM": 1200,
    "mieG": 0.8,
    "ozone": [0.650e-6, 1.881e-6, 0.085e-6],
    "provenance": "inferred",
    "source": "Rendering model using measured air properties (Bruneton 2017 parameter set)",
    "citation": "bruneton2008",
}
MARS_ATMOS = {
    "heightM": 60_000,
    "rayleigh": [19.918e-9, 13.57e-9, 5.75e-9],
    "rayleighScaleHeightM": 11_100,
    "mie": 2.0e-6,
    "mieExtinction": 2.5e-6,
    "mieScaleHeightM": 11_100,
    "mieG": 0.76,
    "mieColor": [1.0, 0.62, 0.38],
    "ozone": [0, 0, 0],
    "provenance": "generated",
    "source": "Artistic approximation of dust scattering (scale height from measured atmospheric profile)",
    "citation": "nasa-factsheet",
}
TITAN_ATMOS = {
    "heightM": 600_000,
    "rayleigh": [1.5e-6, 2.2e-6, 3.0e-6],
    "rayleighScaleHeightM": 40_000,
    "mie": 6.0e-6,
    "mieExtinction": 9.0e-6,
    "mieScaleHeightM": 60_000,
    "mieG": 0.6,
    "mieColor": [1.0, 0.65, 0.25],
    "ozone": [0, 0, 0],
    "provenance": "generated",
    "source": "Artistic approximation of Titan's orange haze",
    "citation": "nasa-factsheet",
}
VENUS_ATMOS = {
    "heightM": 250_000,
    "rayleigh": [4.0e-6, 6.0e-6, 9.0e-6],
    "rayleighScaleHeightM": 15_900,
    "mie": 6.0e-6,
    "mieExtinction": 7.0e-6,
    "mieScaleHeightM": 15_900,
    "mieG": 0.7,
    "mieColor": [1.0, 0.9, 0.7],
    "ozone": [0, 0, 0],
    "provenance": "generated",
    "source": "Artistic approximation of Venus's upper haze",
    "citation": "nasa-factsheet",
}
GIANT_ATMOS = lambda color: {  # noqa: E731
    "heightM": 2_000_000,
    "rayleigh": [1.2e-7, 2.4e-7, 5.0e-7],
    "rayleighScaleHeightM": 60_000,
    "mie": 2.0e-7,
    "mieExtinction": 2.2e-7,
    "mieScaleHeightM": 60_000,
    "mieG": 0.7,
    "mieColor": color,
    "ozone": [0, 0, 0],
    "provenance": "generated",
    "source": "Artistic limb haze",
    "citation": "nasa-factsheet",
}

BODIES = [
    # id, key, name, kind, parent (for UI), ephemeris id, surface
    {"id": "10", "key": "sun", "name": "Sun", "kind": "star", "parent": None,
     "surface": {"type": "star", "teffK": 5772}},
    {"id": "199", "key": "mercury", "name": "Mercury", "kind": "planet", "parent": "10",
     "surface": {"type": "terrain", "texture": "mercury", "terrain": "cratered", "amplitude": 3000}},
    {"id": "299", "key": "venus", "name": "Venus", "kind": "planet", "parent": "10",
     "surface": {"type": "gas", "texture": "venus_clouds"}, "atmosphere": VENUS_ATMOS},
    {"id": "399", "key": "earth", "name": "Earth", "kind": "planet", "parent": "10",
     "surface": {"type": "terrain", "tiles": "earth", "texture": "earth_lo", "heights": "earth", "terrain": "earthlike",
                 "amplitude": 350, "seaLevel": 0, "night": "earth_night_clouds", "clouds": "earth_night_clouds", "cloudChannel": "a"},
     "atmosphere": EARTH_ATMOS},
    {"id": "301", "key": "moon", "name": "Moon", "kind": "moon", "parent": "399",
     "surface": {"type": "terrain", "tiles": "moon", "texture": "moon_lo", "heights": "moon", "terrain": "cratered",
                 "amplitude": 300, "brdf": "lunar"}},
    {"id": "499", "key": "mars", "name": "Mars", "kind": "planet", "parent": "10",
     "surface": {"type": "terrain", "texture": "mars", "terrain": "volcanic", "amplitude": 6000}, "atmosphere": MARS_ATMOS},
    {"id": "401", "key": "phobos", "name": "Phobos", "kind": "moon", "parent": "499",
     "surface": {"type": "terrain", "texture": "phobos", "terrain": "cratered", "amplitude": 800, "brdf": "lunar"}},
    {"id": "402", "key": "deimos", "name": "Deimos", "kind": "moon", "parent": "499",
     "surface": {"type": "terrain", "texture": "deimos", "terrain": "cratered", "amplitude": 400, "brdf": "lunar"}},
    {"id": "599", "key": "jupiter", "name": "Jupiter", "kind": "planet", "parent": "10",
     "surface": {"type": "gas", "texture": "jupiter"}, "atmosphere": GIANT_ATMOS([0.95, 0.85, 0.7])},
    {"id": "501", "key": "io", "name": "Io", "kind": "moon", "parent": "599",
     "surface": {"type": "terrain", "texture": "io", "terrain": "volcanic", "amplitude": 2500}},
    {"id": "502", "key": "europa", "name": "Europa", "kind": "moon", "parent": "599",
     "surface": {"type": "terrain", "texture": "europa", "terrain": "icy", "amplitude": 400}},
    {"id": "503", "key": "ganymede", "name": "Ganymede", "kind": "moon", "parent": "599",
     "surface": {"type": "terrain", "texture": "ganymede", "terrain": "cratered", "amplitude": 1500}},
    {"id": "504", "key": "callisto", "name": "Callisto", "kind": "moon", "parent": "599",
     "surface": {"type": "terrain", "texture": "callisto", "terrain": "cratered", "amplitude": 1500}},
    {"id": "699", "key": "saturn", "name": "Saturn", "kind": "planet", "parent": "10",
     "surface": {"type": "gas", "texture": "saturn"}, "atmosphere": GIANT_ATMOS([0.95, 0.88, 0.7]),
     "rings": {"texture": "saturn_rings", "innerM": 74_658_000, "outerM": 136_775_000,
               "provenance": "measured", "source": "Ring radii (C ring inner edge to A ring outer edge)", "citation": "nasa-saturn-factsheet"}},
    {"id": "602", "key": "enceladus", "name": "Enceladus", "kind": "moon", "parent": "699",
     "surface": {"type": "terrain", "texture": "enceladus", "terrain": "icy", "amplitude": 600}},
    {"id": "606", "key": "titan", "name": "Titan", "kind": "moon", "parent": "699",
     "surface": {"type": "terrain", "texture": "titan", "terrain": "icy", "amplitude": 300}, "atmosphere": TITAN_ATMOS},
    {"id": "799", "key": "uranus", "name": "Uranus", "kind": "planet", "parent": "10",
     "surface": {"type": "gas", "texture": "uranus"}, "atmosphere": GIANT_ATMOS([0.7, 0.9, 1.0])},
    {"id": "899", "key": "neptune", "name": "Neptune", "kind": "planet", "parent": "10",
     "surface": {"type": "gas", "texture": "neptune"}, "atmosphere": GIANT_ATMOS([0.6, 0.75, 1.0])},
    {"id": "801", "key": "triton", "name": "Triton", "kind": "moon", "parent": "899",
     "surface": {"type": "terrain", "texture": "triton", "terrain": "icy", "amplitude": 500}},
    {"id": "999", "key": "pluto", "name": "Pluto", "kind": "dwarf", "parent": "10",
     "surface": {"type": "terrain", "texture": "pluto", "terrain": "icy", "amplitude": 1500}},
    {"id": "901", "key": "charon", "name": "Charon", "kind": "moon", "parent": "999",
     "surface": {"type": "terrain", "texture": "charon", "terrain": "cratered", "amplitude": 1200}},
]

# Where each body's center lives in ephemeris.json (Sun and planet centers; barycenters are internal).
EPHEM_ID = {b["id"]: b["id"] for b in BODIES}

# Geometric albedo (NASA Planetary/Satellite Fact Sheets). Used for exposure and point-source brightness.
GEOMETRIC_ALBEDO = {
    "10": 1.0, "199": 0.142, "299": 0.689, "399": 0.434, "301": 0.12, "499": 0.170, "401": 0.071, "402": 0.068,
    "599": 0.538, "501": 0.63, "502": 0.67, "503": 0.43, "504": 0.22, "699": 0.499, "602": 1.38, "606": 0.22,
    "799": 0.488, "899": 0.442, "801": 0.76, "999": 0.52, "901": 0.41,
}
# Display-stretched maps are scaled toward the body's real reflectance (linear multiplier).
ALBEDO_SCALE = {"301": 0.4, "199": 0.6, "401": 0.35, "402": 0.35, "504": 0.8}


def rotation(pck: dict[str, list[float]], bid: str) -> dict:
    sysid = bid[0] if len(bid) == 3 else bid  # planet system for nut-prec angles (10 -> none)
    rot = {
        "poleRa": pck.get(f"BODY{bid}_POLE_RA", [0, 0, 0]),
        "poleDec": pck.get(f"BODY{bid}_POLE_DEC", [90, 0, 0]),
        "pm": pck.get(f"BODY{bid}_PM", [0, 0, 0]),
    }
    for k, name in (("nutRa", "NUT_PREC_RA"), ("nutDec", "NUT_PREC_DEC"), ("nutPm", "NUT_PREC_PM")):
        v = pck.get(f"BODY{bid}_{name}")
        if v:
            rot[k] = v
    if bid != "10":
        ang = pck.get(f"BODY{sysid}_NUT_PREC_ANGLES")
        if ang and any(k in rot for k in ("nutRa", "nutDec", "nutPm")):
            rot["nutAngles"] = ang  # pairs (deg, deg per Julian century)
    return rot


def main() -> None:
    pck = parse_kpl(RAW / "pck00011.tpc")
    gm = parse_kpl(RAW / "gm_de440.tpc")
    out = []
    for b in BODIES:
        bid = b["id"]
        radii_km = pck[f"BODY{bid}_RADII"]
        mean_km = (radii_km[0] * radii_km[1] * radii_km[2]) ** (1 / 3)
        gm_km3 = gm[f"BODY{bid}_GM"][0]
        entry = {
            **b,
            "ephemerisId": EPHEM_ID[bid],
            "radiiM": [r * 1000 for r in radii_km],
            "radiusM": mean_km * 1000,
            "gmM3S2": gm_km3 * 1e9,
            "rotation": rotation(pck, bid),
            "geometricAlbedo": GEOMETRIC_ALBEDO[bid],
            "albedoScale": ALBEDO_SCALE.get(bid, 1.0),
            "provenance": "measured",
            "source": "NAIF PCK pck00011 (IAU WGCCRE 2015) radii and rotation; JPL DE440 GM",
            "citation": "archinal2018",
        }
        out.append(entry)
        print(f"{b['name']:9s} R={mean_km:10.1f} km  GM={gm_km3:.6e} km^3/s^2  nut={'nutAngles' in entry['rotation']}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"version": 1, "bodies": out}, indent=1))


if __name__ == "__main__":
    main()
