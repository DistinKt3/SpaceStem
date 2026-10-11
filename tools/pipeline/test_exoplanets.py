"""Tests for tools/pipeline/exoplanets.py: physics helpers, deterministic hashing, and the committed output.

Run: tools/.venv/bin/python -m pytest tools/pipeline/test_exoplanets.py -q
Tests that compare against the raw archive responses are skipped when tools/.cache/exoarchive/ is absent.
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import exoplanets as ex  # noqa: E402

OUT = ex.OUT
HEX = re.compile(r"^#[0-9a-f]{6}$")
SOURCED_KEYS = {"value", "unit", "provenance", "source", "citation"}


@pytest.fixture(scope="module")
def system() -> dict:
    return json.loads(OUT.read_text())


@pytest.fixture(scope="module")
def archive() -> dict:
    path = ex.CACHE / "pscomppars_trappist-1.json"
    if not path.exists():
        pytest.skip("archive cache not present (run tools/pipeline/exoplanets.py)")
    return {r["pl_letter"]: r for r in json.loads(path.read_text())}


def all_sourced(obj, path=""):
    if isinstance(obj, dict):
        if "value" in obj and "provenance" in obj:
            yield path, obj
            return
        for k, v in obj.items():
            yield from all_sourced(v, f"{path}.{k}" if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from all_sourced(v, f"{path}[{i}]")


# --- Physics helpers ------------------------------------------------------------------------------------------------

def test_equilibrium_temperature_earth():
    # Sun at 1 au: (1361 W/m^2 / (4 sigma))^(1/4) = 278.3 K; with Earth-like albedo 0.3: 254.6 K.
    assert ex.equilibrium_temp(5772, 1.0, 1.0, 0.0) == pytest.approx(278.3, abs=0.1)
    assert ex.equilibrium_temp(5772, 1.0, 1.0, 0.3) == pytest.approx(254.6, abs=0.1)


def test_equilibrium_temperature_scaling():
    t1 = ex.equilibrium_temp(3000, 0.2, 0.05)
    assert ex.equilibrium_temp(3000, 0.2, 0.2) == pytest.approx(t1 / 2)  # a^-1/2
    assert ex.equilibrium_temp(6000, 0.2, 0.05) == pytest.approx(2 * t1)  # linear in Teff
    assert ex.equilibrium_temp(3000, 0.2, 0.05, 1 - 1 / 16) == pytest.approx(t1 / 2)  # (1-A)^1/4


def test_insolation():
    assert ex.insolation(1.0, 1.0) == 1.0
    assert ex.insolation(1.0, 2.0) == pytest.approx(0.25)
    assert ex.insolation(5.53e-4, 0.01154) == pytest.approx(4.153, rel=2e-3)  # Agol et al. 2021, planet b


def test_bulk_properties_earth_and_b():
    assert ex.density_rel(1, 1) == 1
    assert ex.gravity_rel(1, 1) == 1
    assert ex.escape_velocity_kms(1, 1) == pytest.approx(11.186)
    # Agol et al. 2021 planetary-parameters table for b: g = 1.102, v_esc = 12.400 km/s, rho = 0.987.
    assert ex.gravity_rel(1.374, 1.116) == pytest.approx(1.102, abs=0.002)
    assert ex.escape_velocity_kms(1.374, 1.116) == pytest.approx(12.40, abs=0.02)
    assert ex.density_rel(1.374, 1.116) == pytest.approx(0.987, abs=0.003)


def test_relative_error_propagation():
    assert ex.rel_err((2.0, 0.2, 1.0)) == pytest.approx(0.1)
    assert ex.rel_err((2.0, 0.2, 3.0)) == pytest.approx(0.3)
    assert ex.rel_err((1.0, 0.03, 1.0), (1.0, 0.04, 1.0)) == pytest.approx(0.05)


def test_tidal_locking_timescale():
    # Order-of-magnitude formula: check its scaling and that every planet despins far faster than the 7.6 Gyr age.
    t_b = ex.tidal_lock_time_years(0.01154, 1.374, 1.116, 0.0898)
    t_2a = ex.tidal_lock_time_years(0.02308, 1.374, 1.116, 0.0898)
    assert t_2a / t_b == pytest.approx(64.0)  # a^6
    assert 1 < t_b < 1e3
    assert ex.tidal_lock_time_years(0.06189, 0.326, 0.755, 0.0898) < 7.6e9 / 1000


def test_uncertainty_shapes():
    assert ex.uncertainty(None, None) is None
    assert ex.uncertainty(0.069, -0.069) == 0.069
    assert ex.uncertainty(0.014, -0.012) == [0.012, 0.014]
    assert ex.uncertainty(0.1, None) == 0.1


def test_round_sig_and_years():
    assert ex.round_sig(0.00055301, 3) == pytest.approx(0.000553)
    assert ex.round_sig(12345, 1) == 10000
    assert ex.fmt_years(1_110_000) == "1,000,000"
    assert ex.fmt_years(58.4) == "60"


def test_reflink_parsing():
    s = ('<a refstr=AGOL_ET_AL__2021 href=https://ui.adsabs.harvard.edu/abs/2021PSJ.....2....1A/abstract '
         'target=ref>Agol et al. 2021</a>')
    r = ex.parse_reflink(s)
    assert (r.refstr, r.label, r.key) == ("AGOL_ET_AL__2021", "Agol et al. 2021", "agol2021")
    with pytest.raises(SystemExit):
        ex.parse_reflink("<a refstr=UNKNOWN_2099 href=x target=ref>Nobody 2099</a>").key  # noqa: B018


def test_coordinates():
    assert ex.hms_to_deg("23h06m29.368s") == pytest.approx(346.62236667, abs=1e-7)
    assert ex.dms_to_deg("-05d02m29.04s") == pytest.approx(-5.04140, abs=1e-5)


# --- Deterministic hashing: must match src/core/rng.ts exactly ------------------------------------------------------

def test_hash_string_matches_typescript():
    # Values printed by src/core/rng.ts hashString().
    assert ex.hash_string("trappist-1b") == 2178240980
    assert ex.hash_string("trappist-1h") == 3970655979
    assert ex.hash_string("trappist-1") == 108291010
    assert ex.hash_string("") == 2872998923


def test_mulberry32_matches_typescript():
    r = ex.Mulberry32(12345)
    assert [r.next_u32(), r.next_u32(), r.next_u32()] == [4207900869, 1317490944, 2079646450]
    r2 = ex.Mulberry32(ex.hash_string("trappist-1b"))
    assert r2.next() == pytest.approx(0.1764294148888439, abs=1e-15)


def test_generate_surface_rules():
    hot = ex.generate_surface("x-1b", "b", 4.15, 363.7)
    assert hot["terrain"] == "volcanic" and hot["iceCoverage"] == 0 and hot["nightSideGlow"] > 0
    warm = ex.generate_surface("x-1d", "d", 1.12, 261.8)
    assert warm["terrain"] == "cratered" and warm["iceCoverage"] == 0 and warm["nightSideGlow"] == 0
    cool = ex.generate_surface("x-1e", "e", 0.65, 228.5)
    assert cool["terrain"] == "mixed" and 0.3 < cool["iceCoverage"] < 0.4
    cold = ex.generate_surface("x-1h", "h", 0.14, 157.1)
    assert cold["terrain"] == "icy" and cold["iceCoverage"] > 0.9 and cold["albedo"] > cool["albedo"]
    assert cold == ex.generate_surface("x-1h", "h", 0.14, 157.1)  # deterministic
    for g in (hot, warm, cool, cold):
        assert g["provenance"] == "generated"
        assert len(g["palette"]) == 5 and all(HEX.match(c) for c in g["palette"])


# --- Output file ----------------------------------------------------------------------------------------------------

def test_top_level(system):
    assert system["id"] == "trappist-1" and system["name"] == "TRAPPIST-1"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", system["retrieved"])
    c = system["exoplanetCount"]
    assert c["value"] > 5000 and re.fullmatch(r"\d{4}-\d{2}-\d{2}", c["asOf"]) and "count(*)" in c["source"]
    for k in ("star", "position", "orbitalPlane", "planets", "citations"):
        assert k in system


def test_every_sourced_value_is_complete(system):
    found = list(all_sourced(system))
    assert len(found) == 12 + 3 + 2 + 7 * (7 + 11)
    for path, s in found:
        assert SOURCED_KEYS <= set(s), path
        assert s["provenance"] in ("measured", "inferred", "generated"), path
        assert s["source"] and s["citation"] in system["citations"], path
        u = s.get("uncertainty")
        if u is not None:
            assert (isinstance(u, (int, float)) and u >= 0) or (isinstance(u, list) and len(u) == 2 and min(u) >= 0), path


def test_blocks_hold_only_their_tier(system):
    for p in system["planets"]:
        assert set(p["measured"]) == {"periodDays", "semiMajorAxisAu", "radiusEarth", "massEarth", "inclinationDeg",
                                      "eccentricity", "transitMidBJD"}
        assert all(v["provenance"] == "measured" for v in p["measured"].values())
        assert set(p["inferred"]) == {"equilibriumTempK_A0", "equilibriumTempK_A030", "insolationEarth",
                                      "densityRelEarth", "surfaceGravityG", "escapeVelocityKms",
                                      "ephemerisPeriodDays", "ephemerisTransitMidBJD", "tidallyLocked",
                                      "composition", "atmosphere"}
        assert all(v["provenance"] == "inferred" and v.get("note") for v in p["inferred"].values())
        g = p["generated"]
        assert {"seed", "terrain", "albedo", "palette", "iceCoverage", "nightSideGlow", "rationale"} <= set(g)
        assert g["provenance"] == "generated" and g["terrain"] in ("cratered", "volcanic", "icy", "mixed")
        assert g["seed"] == ex.hash_string(p["id"])
    assert all(v["provenance"] == "measured" for v in system["star"].values())
    assert all(v["provenance"] == "measured" for v in system["position"].values())
    assert system["orbitalPlane"]["nodeDeg"]["provenance"] == "generated"


def test_planets_sorted_and_named(system):
    planets = system["planets"]
    assert [p["letter"] for p in planets] == list("bcdefgh")
    periods = [p["measured"]["periodDays"]["value"] for p in planets]
    assert periods == sorted(periods)
    assert all(p["id"] == f"trappist-1{p['letter']}" for p in planets)


def test_inferred_values_recompute(system):
    st = system["star"]
    for p in system["planets"]:
        a = p["measured"]["semiMajorAxisAu"]["value"]
        inf = p["inferred"]
        t0 = ex.equilibrium_temp(st["teffK"]["value"], st["radiusSun"]["value"], a, 0)
        assert inf["equilibriumTempK_A0"]["value"] == pytest.approx(t0, abs=0.06)
        s = ex.insolation(10 ** st["luminosityLogSun"]["value"], a)
        assert inf["insolationEarth"]["value"] == pytest.approx(s, rel=1e-3)


def test_citations_are_complete(system):
    for k, c in system["citations"].items():
        assert c["authors"] and c["title"] and c["venue"] and isinstance(c["year"], int), k
        assert c.get("doi") or c.get("url"), k
    for k in ex.NOTE_CITATIONS:
        assert k in system["citations"]


def test_measured_values_match_archive(system, archive):
    """Every measured planet value equals the archive's, except the documented corrections."""
    cols = {"periodDays": "pl_orbper", "semiMajorAxisAu": "pl_orbsmax", "radiusEarth": "pl_rade", "massEarth": "pl_masse",
            "inclinationDeg": "pl_orbincl", "eccentricity": "pl_orbeccen", "transitMidBJD": "pl_tranmid"}
    for p in system["planets"]:
        row = archive[p["letter"]]
        for field, col in cols.items():
            s = p["measured"][field]
            assert s["value"] == row[col], (p["id"], field)
            expected = ex.uncertainty(row[f"{col}err1"], row[f"{col}err2"])
            if p["letter"] == "e" and field == "semiMajorAxisAu":
                assert s["uncertainty"] == 0.00025 and "published" in s["note"]  # documented correction
            else:
                assert s["uncertainty"] == expected, (p["id"], field)
    star = system["star"]
    row = archive["b"]
    assert star["teffK"]["value"] == row["st_teff"]
    assert star["radiusSun"]["value"] == row["st_rad"]
    assert star["massSun"]["value"] == row["st_mass"]
    assert star["luminosityLogSun"]["value"] == row["st_lum"]
    assert system["position"]["distancePc"]["value"] == row["sy_dist"]
    assert star["vMag"]["value"] != row["sy_vmag"]  # documented correction: direct photometry instead of TICv8


# --- Mean ephemeris from the Agol et al. 2024 forecast --------------------------------------------------------------

def _synthetic_forecast(period: float, t0: float, ttv_min: float, n: int) -> list[ex.ForecastTransit]:
    return [ex.ForecastTransit(1, k, t0 + k * period + ttv_min / 1440 * math.sin(k / 7.0)) for k in range(n)]


def test_fit_ephemeris_recovers_a_line():
    fc = _synthetic_forecast(1.5, 2_461_000.0, 0.0, 200)
    e = ex.fit_ephemeris(fc, 1)
    assert e.period == pytest.approx(1.5, abs=1e-12)
    assert e.max_min < 1e-6
    # The epoch is the transit nearest 2026-01-01 (BJD 2461041.5).
    assert abs(e.t0 - ex.EPHEMERIS_REF_BJD) <= 0.75 + 1e-9


def test_fit_ephemeris_reports_ttvs_and_phase_error():
    fc = _synthetic_forecast(6.1, 2_460_000.0, 30.0, 300)
    e = ex.fit_ephemeris(fc, 1)
    assert e.period == pytest.approx(6.1, rel=1e-5)  # the sinusoidal TTV biases the slope slightly
    assert 20 < e.max_min < 40
    m, deg = ex.phase_error(fc, 1, 6.1, 2_460_000.0, 2_460_500.0)
    assert abs(m) <= 30.0 + 1e-6 and deg == pytest.approx(m / (6.1 * 1440) * 360)


def test_read_forecast_from_tarball():
    import io
    import tarfile
    body = b"1.0,1.0,7259.061227615039,7259.065897740425,-0.0046,0.0002\n7.0,2.0,11603.658709078809,11603.6,0.03,0.003\n"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        info = tarfile.TarInfo(ex.AGOL2024_CSV)
        info.size = len(body)
        tf.addfile(info, io.BytesIO(body))
    fc = ex.read_forecast(buf.getvalue())
    assert [(x.planet, x.epoch) for x in fc] == [(1, 1), (7, 2)]
    assert fc[0].bjd == pytest.approx(2_457_259.061227615)


def test_mean_ephemeris_follows_cached_forecast(system):
    path = ex.CACHE / "agol2024_arxiv_eprint.tar.gz"
    if not path.exists():
        pytest.skip("forecast cache not present")
    fc = ex.read_forecast(path.read_bytes())
    ex.check_forecast(fc)
    for i, p in enumerate(system["planets"], start=1):
        inf = p["inferred"]
        e = ex.fit_ephemeris(fc, i)
        for at in (2_460_311.5, 2_461_041.5, 2_461_600.0):  # 2024-01-01, 2026-01-01, 2027-07
            m, _ = ex.phase_error(fc, i, inf["ephemerisPeriodDays"]["value"], inf["ephemerisTransitMidBJD"]["value"], at)
            assert abs(m) <= e.max_min + 0.5, (p["id"], at, m)
