"""
Build public/data/ephemeris.{json,bin} from JPL Horizons state vectors (DE441 + JPL satellite ephemerides).

Each body is stored relative to its parent (planets and Sun relative to the Solar System Barycenter, moons relative
to their planet's center) in ICRF axes, meters, as Chebyshev segments over TDB seconds since J2000. Degree is chosen
per body so that held-out Horizons samples (not used in the fit) agree within a tolerance.

Usage: tools/.venv/bin/python tools/pipeline/ephemeris.py
"""
from __future__ import annotations

import json
import math
import struct
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.polynomial import chebyshev as C

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "tools" / ".cache" / "horizons"
OUT = ROOT / "public" / "data"
FIXTURE = ROOT / "tests" / "fixtures" / "ephemeris_check.json"

START = "2026-01-01"
STOP = "2032-01-01"
J2000_JD = 2451545.0
DAY = 86400.0


@dataclass
class Body:
    id: str  # Horizons command
    name: str
    parent: str  # Horizons center body id ("0" = SSB)
    step_h: float  # sample step, hours
    seg_days: float  # Chebyshev segment length, days
    tol_m: float  # max held-out error, meters
    f32: bool = False  # store coefficients as float32 (moons relative to their planet)


BODIES = [
    Body("10", "Sun", "0", 24, 32, 100),
    Body("199", "Mercury", "0", 6, 8, 500),
    Body("299", "Venus", "0", 12, 16, 500),
    Body("399", "Earth", "0", 6, 8, 100),
    Body("301", "Moon", "399", 2, 4, 20),
    Body("499", "Mars", "0", 12, 16, 500),
    # Moons: segments of half an orbital period, ~40 samples per segment (well-conditioned Chebyshev fits).
    Body("401", "Phobos", "499", 0.1, 0.16, 500, True),
    Body("402", "Deimos", "499", 0.38, 0.63, 300, True),
    # Systems with massive moons: the barycenter moves smoothly; the planet center and moons are stored relative to
    # it (relative to the planet center, every moon would inherit the planet's wobble from all other moons).
    Body("5", "Jupiter barycenter", "0", 24, 32, 1000),
    Body("599", "Jupiter", "5", 0.5, 1.0, 50, True),
    Body("501", "Io", "5", 0.53, 0.88, 300, True),
    Body("502", "Europa", "5", 1.07, 1.78, 300, True),
    Body("503", "Ganymede", "5", 2.1, 3.6, 300, True),
    Body("504", "Callisto", "5", 5, 8.3, 300, True),
    Body("6", "Saturn barycenter", "0", 24, 32, 1000),
    Body("699", "Saturn", "6", 1.2, 2.0, 50, True),
    Body("602", "Enceladus", "6", 0.41, 0.685, 300, True),
    Body("606", "Titan", "6", 4.8, 8.0, 300, True),
    Body("799", "Uranus", "0", 6, 8, 2000),
    Body("8", "Neptune barycenter", "0", 48, 64, 2000),
    Body("899", "Neptune", "8", 1.76, 2.94, 50, True),
    Body("801", "Triton", "8", 1.76, 2.94, 300, True),
    Body("9", "Pluto barycenter", "0", 48, 64, 2000),
    Body("999", "Pluto", "9", 1.9, 3.2, 50, True),
    Body("901", "Charon", "9", 1.9, 3.2, 300, True),
]

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
MAX_ROWS = 80_000


def fetch_chunk(body: Body, start_jd: float, stop_jd: float) -> np.ndarray:
    key = f"{body.id}_{body.parent}_{start_jd:.4f}_{stop_jd:.4f}_{body.step_h}"
    path = CACHE / f"{key}.json"
    if not path.exists():
        minutes = max(1, round(body.step_h * 60))
        params = {
            "format": "json",
            "COMMAND": f"'{body.id}'",
            "OBJ_DATA": "'NO'",
            "MAKE_EPHEM": "'YES'",
            "EPHEM_TYPE": "'VECTORS'",
            "CENTER": f"'500@{body.parent}'",
            "START_TIME": f"'JD{start_jd:.6f}'",
            "STOP_TIME": f"'JD{stop_jd:.6f}'",
            "STEP_SIZE": f"'{minutes} m'",
            "REF_PLANE": "'FRAME'",
            "REF_SYSTEM": "'ICRF'",
            "VEC_TABLE": "'1'",
            "VEC_CORR": "'NONE'",
            "OUT_UNITS": "'KM-S'",
            "CSV_FORMAT": "'YES'",
            "VEC_LABELS": "'NO'",
            "TIME_TYPE": "'TDB'",
        }
        url = API + "?" + urllib.parse.urlencode(params)
        for attempt in range(5):
            try:
                with urllib.request.urlopen(url, timeout=300) as r:
                    data = json.load(r)
                break
            except Exception as e:  # noqa: BLE001
                print(f"  retry {attempt}: {e}", file=sys.stderr)
                time.sleep(2 ** attempt)
        else:
            raise RuntimeError(f"Horizons failed for {body.name}")
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))
    data = json.loads(path.read_text())
    text = data["result"]
    if "$$SOE" not in text:
        raise RuntimeError(f"No data for {body.name}: {text[:2000]}")
    rows = []
    for line in text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        rows.append((float(parts[0]), float(parts[2]), float(parts[3]), float(parts[4])))
    return np.array(rows)


def fetch(body: Body, check: bool = False) -> np.ndarray:
    """
    Samples [jd_tdb, x_km, y_km, z_km] over the window (+1 segment margin), split into API-sized chunks.
    check=True fetches an independent validation set offset by half a step at 4x the step (points between fit samples).
    """
    step_h = body.step_h * (4 if check else 1)
    b2 = Body(body.id, body.name, body.parent, step_h, body.seg_days, body.tol_m, body.f32)
    jd0 = julian(START) + (body.step_h / 48 if check else 0)
    jd1 = julian(STOP) + body.seg_days
    step_d = step_h / 24
    span = MAX_ROWS * step_d
    out = []
    a = jd0
    while a < jd1:
        b = min(jd1, a + span)
        out.append(fetch_chunk(b2, a, b))
        a = b
    arr = np.concatenate(out)
    _, idx = np.unique(arr[:, 0], return_index=True)
    return arr[idx]


def julian(date: str) -> float:
    y, m, d = (int(x) for x in date.split("-"))
    if m <= 2:
        y -= 1
        m += 12
    A = y // 100
    B = 2 - A + A // 4
    return math.floor(365.25 * (y + 4716)) + math.floor(30.6001 * (m + 1)) + d + B - 1524.5


def fit(body: Body, samples: np.ndarray, check: np.ndarray) -> tuple[int, np.ndarray, float, float, list]:
    """
    Fit all samples; validate on the independent half-step-offset check set.
    Returns (degree, coeffs[nseg,3,deg+1] in meters, t0 seconds, max validation error m, check points for TS tests).
    """
    t = (samples[:, 0] - J2000_JD) * DAY
    xyz = samples[:, 1:4] * 1000.0
    tc = (check[:, 0] - J2000_JD) * DAY
    xyzc = check[:, 1:4] * 1000.0
    t0 = (julian(START) - J2000_JD) * DAY
    t1 = (julian(STOP) - J2000_JD) * DAY
    L = body.seg_days * DAY
    nseg = int(math.ceil((t1 - t0) / L))
    # float32 storage limits relative precision to ~6e-8 per coefficient; scale the tolerance with orbit size.
    tol = max(body.tol_m, 3e-7 * float(np.linalg.norm(xyz, axis=1).max())) if body.f32 else body.tol_m
    for deg in range(6, 24):
        coeffs = np.zeros((nseg, 3, deg + 1))
        worst = 0.0
        for s in range(nseg):
            a = t0 + s * L
            b = a + L
            sel = np.where((t >= a - L * 0.02) & (t <= b + L * 0.02))[0]
            if len(sel) < 2 * (deg + 1):
                raise RuntimeError(f"{body.name}: {len(sel)} samples per segment is too few for degree {deg}")
            x = 2 * (t[sel] - a) / L - 1
            for k in range(3):
                coeffs[s, k] = C.chebfit(x, xyz[sel, k], deg)
            hc = np.where((tc >= a) & (tc < b))[0]
            if len(hc):
                co = coeffs[s].astype(np.float32).astype(np.float64) if body.f32 else coeffs[s]
                xh = 2 * (tc[hc] - a) / L - 1
                pred = np.stack([C.chebval(xh, co[k]) for k in range(3)], axis=1)
                worst = max(worst, float(np.linalg.norm(pred - xyzc[hc], axis=1).max()))
        if worst <= tol:
            break
    rng = np.random.default_rng(int(body.id))
    inside = np.where((tc >= t0) & (tc < t1))[0]
    checks = [{"t": float(tc[i]), "p": [float(v) for v in xyzc[i]]} for i in rng.choice(inside, size=min(5, len(inside)), replace=False)]
    return deg, coeffs, t0, worst, checks


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    header = {
        "version": 1,
        "source": "JPL Horizons API (DE441 planetary ephemeris and JPL satellite ephemerides), ICRF, vectors",
        "retrieved": time.strftime("%Y-%m-%d"),
        "window": [START, STOP],
        "units": "meters; time = TDB seconds since J2000.0",
        "bodies": [],
    }
    blobs = []
    offset = 0
    fixture = {}
    for body in BODIES:
        samples = fetch(body)
        check = fetch(body, check=True)
        deg, coeffs, t0, worst, checks = fit(body, samples, check)
        arr = coeffs.astype(np.float32 if body.f32 else np.float64)
        blob = arr.tobytes(order="C")
        pad = (-offset) % 8
        if pad:
            blobs.append(b"\0" * pad)
            offset += pad
        header["bodies"].append(
            {
                "id": body.id,
                "name": body.name,
                "parent": body.parent,
                "t0": t0,
                "segmentSeconds": body.seg_days * DAY,
                "segments": int(coeffs.shape[0]),
                "degree": deg,
                "dtype": "f32" if body.f32 else "f64",
                "byteOffset": offset,
                "maxHeldOutErrorMeters": round(worst, 3),
            }
        )
        blobs.append(blob)
        offset += len(blob)
        fixture[body.id] = checks
        print(f"{body.name:10s} deg {deg:2d} segs {coeffs.shape[0]:5d} held-out max err {worst:9.3f} m  {len(blob)/1024:8.1f} KiB")
    (OUT / "ephemeris.bin").write_bytes(b"".join(blobs))
    (OUT / "ephemeris.json").write_text(json.dumps(header, indent=1))
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(fixture))
    print(f"total {offset/1024/1024:.2f} MiB")


if __name__ == "__main__":
    main()
