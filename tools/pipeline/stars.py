"""
Build public/data/stars.{bin,json} from the HYG database v4.1 (CC BY-SA 4.0, astronexus).

stars.bin: per star, little-endian: float32 x, y, z (parsecs, ICRS equatorial, origin at the Sun), float32 absolute
visual magnitude, uint8 r, g, b, a (linear-ish display colour from B-V via a blackbody approximation; a = 255).
stars.json: field layout plus names/designations for notable stars, keyed by index into stars.bin.

Usage: tools/.venv/bin/python tools/pipeline/stars.py
"""
from __future__ import annotations

import csv
import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "tools" / ".cache" / "raw" / "hygdata_v41.csv"
OUT = ROOT / "public" / "data"

GREEK = {
    "Alp": "α", "Bet": "β", "Gam": "γ", "Del": "δ", "Eps": "ε", "Zet": "ζ", "Eta": "η", "The": "θ", "Iot": "ι",
    "Kap": "κ", "Lam": "λ", "Mu": "μ", "Nu": "ν", "Xi": "ξ", "Omi": "ο", "Pi": "π", "Rho": "ρ", "Sig": "σ",
    "Tau": "τ", "Ups": "υ", "Phi": "φ", "Chi": "χ", "Psi": "ψ", "Ome": "ω",
}


def bv_to_teff(bv: float) -> float:
    """Ballesteros (2012, EPL 97, 34009) B-V to effective temperature."""
    bv = max(-0.4, min(2.0, bv))
    return 4600.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62))


def teff_to_rgb(t: float) -> tuple[int, int, int]:
    """Tanner Helland blackbody fit, normalised so the brightest channel is 255."""
    t /= 100.0
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0.0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * (t - 60) ** -0.1332047592
        g = 288.1221695283 * (t - 60) ** -0.0755148492
        b = 255.0
    rgb = [max(0.0, min(255.0, c)) for c in (r, g, b)]
    m = max(rgb) or 1.0
    return tuple(int(round(c * 255.0 / m)) for c in rgb)  # type: ignore[return-value]


def designation(row: dict) -> str:
    con = row["con"]
    bayer = row["bayer"]
    if bayer and con:
        base = bayer.rstrip("0123456789-")
        suffix = bayer[len(base):].lstrip("-")
        sym = GREEK.get(base, base)
        if suffix:
            sym += suffix
        if row["comp"] and row["comp"] not in ("1", "0") and row["base"]:
            pass
        return f"{sym} {con}"
    if row["flam"] and con:
        return f"{row['flam']} {con}"
    if row["gl"]:
        return row["gl"]
    if row["hip"]:
        return f"HIP {row['hip']}"
    if row["hd"]:
        return f"HD {row['hd']}"
    return ""


def main() -> None:
    rows = []
    with RAW.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["id"] == "0":
                continue  # the Sun is a real body in the game
            dist = float(row["dist"] or 0)
            if dist <= 0 or dist >= 100000:
                continue  # unknown parallax
            rows.append(row)
    # Brightest first (apparent magnitude from Earth) so the renderer can cap counts cheaply.
    rows.sort(key=lambda r: float(r["mag"] or 99))
    buf = bytearray()
    names: dict[int, dict] = {}
    nearby: list[int] = []
    for i, r in enumerate(rows):
        x, y, z = float(r["x"]), float(r["y"]), float(r["z"])
        absmag = float(r["absmag"] or 10)
        bv = float(r["ci"]) if r["ci"] else 0.65
        cr, cg, cb = teff_to_rgb(bv_to_teff(bv))
        buf += struct.pack("<4f4B", x, y, z, absmag, cr, cg, cb, 255)
        dist = float(r["dist"])
        proper = r["proper"]
        des = designation(r)
        mag = float(r["mag"] or 99)
        if proper or (des and mag < 4.5) or dist < 6.2:  # named, bright, or within ~20 ly
            names[i] = {
                "name": proper or des,
                "designation": des,
                "hip": int(r["hip"]) if r["hip"] else None,
                "spect": r["spect"],
                "distPc": dist,
                "mag": mag,
                "absmag": absmag,
                "bv": bv,
                "con": r["con"],
            }
        if dist < 6.2:
            nearby.append(i)
    (OUT / "stars.bin").write_bytes(bytes(buf))
    meta = {
        "version": 1,
        "source": "HYG database v4.1 (astronexus), CC BY-SA 4.0; positions from Hipparcos/Yale/Gliese",
        "count": len(rows),
        "stride": 20,
        "layout": "f32 x,y,z (pc, ICRS) | f32 absmag (V) | u8 r,g,b,a",
        "named": names,
        "nearby": nearby,
    }
    (OUT / "stars.json").write_text(json.dumps(meta, ensure_ascii=False))
    print(f"{len(rows)} stars, {len(names)} named, {len(nearby)} within 6.2 pc -> {len(buf) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
