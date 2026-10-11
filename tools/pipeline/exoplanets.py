"""
Build public/data/systems/trappist-1.json: the TRAPPIST-1 system from the NASA Exoplanet Archive.

Sources (queried offline, cached under tools/.cache/exoarchive/, never at runtime):
  * NASA Exoplanet Archive TAP, Planetary Systems Composite Parameters (pscomppars): one row per confirmed planet with
    the archive's chosen value for each parameter and a per-parameter reference link (the *_reflink columns).
  * The same service, Planetary Systems table (ps) with default_flag=1: each planet's default parameter set and its
    reference (Agol et al. 2021 for all seven planets when this was written).
  * select count(*) from pscomppars: the live confirmed-planet count, recorded with the query date.
  * Cross-checks: the Gaia DR3 archive (source id, parallax), SIMBAD (V magnitude) and the hand-verified
    tools/exo/trappist1_verified.json (Agol et al. 2021). Differences are written into docs/EXO_TRAPPIST1.md.

Measured values are the archive's, except the CORRECTIONS listed below (each with its reason). Inferred values are
computed here with the formulas in docs/EXO_TRAPPIST1.md. Generated surface parameters follow generate_surface().

Every check (cross-check, default parameter set, stellar columns identical on every planet row, optionally the
citation authors against Crossref) runs on the in-memory result first. The output file and the generated part of
docs/EXO_TRAPPIST1.md are written only when all of them pass; otherwise the script exits 1 and changes nothing.

Usage:
  tools/.venv/bin/python tools/pipeline/exoplanets.py             # use cached responses, fetch what is missing
  tools/.venv/bin/python tools/pipeline/exoplanets.py --refresh   # query every service again
  tools/.venv/bin/python tools/pipeline/exoplanets.py --offline   # cache only; fail if a response is missing
  ... --verify-citations     # also compare citation author order with Crossref (network; responses cached)
  ... --write-fixtures       # refresh tools/pipeline/fixtures/ (archive response, forecast subset) for the tests
  ... --accept-default-set-differences   # write even if pscomppars no longer matches the default parameter set
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import re
import sys
import tarfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "tools" / ".cache" / "exoarchive"
OUT = ROOT / "public" / "data" / "systems" / "trappist-1.json"
VERIFIED = ROOT / "tools" / "exo" / "trappist1_verified.json"
DOC = ROOT / "docs" / "EXO_TRAPPIST1.md"

SYSTEM_ID = "trappist-1"
LETTERS = "bcdefgh"
HOST = "TRAPPIST-1"
GAIA_DR3_SOURCE_ID = "2635476908753563008"

NASA_TAP = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
SIMBAD_TAP = "https://simbad.cds.unistra.fr/simbad/sim-tap/sync"
AGOL2024_EPRINT = "https://arxiv.org/e-print/2409.11620"  # source of RNAAS 8, 274, with the data behind its figure
AGOL2024_CSV = "T1_forecast_JWST_chi_19Aug2024.csv"
USER_AGENT = "KnownSky-data-pipeline/1.0 (open-source game; offline data build)"

# --- Physical constants -------------------------------------------------------------------------------------------
R_SUN_KM = 695_700.0  # IAU 2015 Resolution B3 nominal solar radius (exact by definition)
AU_KM = 149_597_870.7  # IAU 2012 Resolution B2 (exact)
R_SUN_AU = R_SUN_KM / AU_KM
GM_SUN = 1.327_124_4e20  # m^3 s^-2, IAU 2015 Resolution B3 nominal
GM_EARTH = 3.986_004e14  # m^3 s^-2, IAU 2015 Resolution B3 nominal
R_EARTH_M = 6.371e6  # volumetric mean radius, NASA Earth Fact Sheet
AU_M = AU_KM * 1000.0
V_ESC_EARTH_KMS = 11.186  # NASA Earth Fact Sheet
LN10 = math.log(10.0)

# --- Citations ----------------------------------------------------------------------------------------------------
# Every key used in the output, with the full reference. Each was checked on 2026-10-11 against Crossref, DataCite or
# arXiv (see docs/EXO_TRAPPIST1.md). The output embeds the ones it uses so the integrator can merge them into
# public/data/citations.json.
CITATIONS: dict[str, dict[str, Any]] = {
    "nasa-exoplanet-archive": {
        "authors": "NASA Exoplanet Science Institute",
        "year": 2020,
        "title": "Planetary Systems Composite Table",
        "venue": "NASA Exoplanet Archive, IPAC/Caltech (queried through the TAP service)",
        "doi": "10.26133/NEA13",
        "url": "https://exoplanetarchive.ipac.caltech.edu/",
    },
    "agol2021": {
        "authors": "Agol, E., Dorn, C., Grimm, S. L. et al.",
        "year": 2021,
        "title": "Refining the Transit-timing and Photometric Analysis of TRAPPIST-1: Masses, Radii, Densities, Dynamics, and Ephemerides",
        "venue": "The Planetary Science Journal 2, 1",
        "doi": "10.3847/PSJ/abd022",
        "url": "https://arxiv.org/abs/2010.01074",
    },
    "agol2024": {
        "authors": "Agol, E. et al.",
        "year": 2024,
        "title": "Updated Forecast for TRAPPIST-1 Times of Transit for All Seven Exoplanets Incorporating JWST Data",
        "venue": "Research Notes of the AAS 8, 274",
        "doi": "10.3847/2515-5172/ad8b46",
        "url": "https://arxiv.org/abs/2409.11620",
    },
    "grimm2018": {
        "authors": "Grimm, S. L., Demory, B.-O., Gillon, M. et al.",
        "year": 2018,
        "title": "The nature of the TRAPPIST-1 exoplanets",
        "venue": "Astronomy & Astrophysics 613, A68",
        "doi": "10.1051/0004-6361/201732233",
        "url": "https://arxiv.org/abs/1802.01377",
    },
    "ducrot2020": {
        "authors": "Ducrot, E., Gillon, M., Delrez, L. et al.",
        "year": 2020,
        "title": "TRAPPIST-1: Global results of the Spitzer Exploration Science Program Red Worlds",
        "venue": "Astronomy & Astrophysics 640, A112",
        "doi": "10.1051/0004-6361/201937392",
        "url": "https://arxiv.org/abs/2006.13826",
    },
    "stassun2019": {
        "authors": "Stassun, K. G., Oelkers, R. J., Paegert, M. et al.",
        "year": 2019,
        "title": "The Revised TESS Input Catalog and Candidate Target List (TICv8)",
        "venue": "The Astronomical Journal 158, 138",
        "doi": "10.3847/1538-3881/ab3467",
        "url": "https://arxiv.org/abs/1905.10694",
    },
    "gaia-dr2": {
        "authors": "Gaia Collaboration, Brown, A. G. A. et al.",
        "year": 2018,
        "title": "Gaia Data Release 2. Summary of the contents and survey properties",
        "venue": "Astronomy & Astrophysics 616, A1",
        "doi": "10.1051/0004-6361/201833051",
        "url": "https://arxiv.org/abs/1804.09365",
    },
    "gaia-dr3": {
        "authors": "Gaia Collaboration, Vallenari, A. et al.",
        "year": 2023,
        "title": "Gaia Data Release 3. Summary of the content and survey properties",
        "venue": "Astronomy & Astrophysics 674, A1",
        "doi": "10.1051/0004-6361/202243940",
        "url": "https://arxiv.org/abs/2208.00211",
    },
    "piaulet-ghorayeb2025": {
        "authors": "Piaulet-Ghorayeb, C., Benneke, B., Turbet, M. et al.",
        "year": 2025,
        "title": "Strict Limits on Potential Secondary Atmospheres on the Temperate Rocky Exo-Earth TRAPPIST-1 d",
        "venue": "The Astrophysical Journal 989, 181",
        "doi": "10.3847/1538-4357/adf207",
        "url": "https://arxiv.org/abs/2508.08416",
    },
    "costa2006": {
        "authors": "Costa, E., Mendez, R. A., Jao, W.-C., Henry, T. J., Subasavage, J. P. & Ianna, P. A.",
        "year": 2006,
        "title": "The Solar Neighborhood. XVI. Parallaxes from CTIOPI: Final Results from the 1.5 m Telescope Program",
        "venue": "The Astronomical Journal 132, 1234-1247",
        "doi": "10.1086/505706",
        "url": "https://ui.adsabs.harvard.edu/abs/2006AJ....132.1234C",
    },
    "turbet2018": {
        "authors": "Turbet, M., Bolmont, E., Leconte, J. et al.",
        "year": 2018,
        "title": "Modeling climate diversity, tidal dynamics and the fate of volatiles on TRAPPIST-1 planets",
        "venue": "Astronomy & Astrophysics 612, A86",
        "doi": "10.1051/0004-6361/201731620",
        "url": "https://arxiv.org/abs/1707.06927",
    },
    "gladman1996": {
        "authors": "Gladman, B., Quinn, D. D., Nicholson, P. & Rand, R.",
        "year": 1996,
        "title": "Synchronous Locking of Tidally Evolving Satellites",
        "venue": "Icarus 122, 166-192",
        "doi": "10.1006/icar.1996.0117",
    },
    "greene2023": {
        "authors": "Greene, T. P., Bell, T. J., Ducrot, E. et al.",
        "year": 2023,
        "title": "Thermal emission from the Earth-sized exoplanet TRAPPIST-1 b using JWST",
        "venue": "Nature 618, 39-42",
        "doi": "10.1038/s41586-023-05951-7",
        "url": "https://arxiv.org/abs/2303.14849",
    },
    "zieba2023": {
        "authors": "Zieba, S., Kreidberg, L., Ducrot, E. et al.",
        "year": 2023,
        "title": "No thick carbon dioxide atmosphere on the rocky exoplanet TRAPPIST-1 c",
        "venue": "Nature 620, 746-749",
        "doi": "10.1038/s41586-023-06232-z",
        "url": "https://arxiv.org/abs/2306.10150",
    },
    "ducrot2025": {
        "authors": "Ducrot, E., Lagage, P.-O., Min, M. et al.",
        "year": 2025,
        "title": "Combined analysis of the 12.8 and 15 um JWST/MIRI eclipse observations of TRAPPIST-1 b",
        "venue": "Nature Astronomy 9, 358-369 (published online December 2024)",
        "doi": "10.1038/s41550-024-02428-z",
        "url": "https://arxiv.org/abs/2412.11627",
    },
    "gillon2026": {
        "authors": "Gillon, M., Ducrot, E., Bell, T. J. et al.",
        "year": 2026,
        "title": "No thick atmosphere around TRAPPIST-1 b and c from JWST thermal phase curves",
        "venue": "Nature Astronomy 10, 674-694",
        "doi": "10.1038/s41550-026-02806-9",
        "url": "https://arxiv.org/abs/2509.02128",
    },
    "espinoza2025": {
        "authors": "Espinoza, N., Allen, N. H., Glidden, A. et al.",
        "year": 2025,
        "title": "JWST-TST DREAMS: NIRSpec/PRISM Transmission Spectroscopy of the Habitable Zone Planet TRAPPIST-1 e",
        "venue": "The Astrophysical Journal Letters 990, L52",
        "doi": "10.3847/2041-8213/adf42e",
        "url": "https://arxiv.org/abs/2509.05414",
    },
    "glidden2025": {
        "authors": "Glidden, A., Ranjan, S., Seager, S. et al.",
        "year": 2025,
        "title": "JWST-TST DREAMS: Secondary Atmosphere Constraints for the Habitable Zone Planet TRAPPIST-1 e",
        "venue": "The Astrophysical Journal Letters 990, L53",
        "doi": "10.3847/2041-8213/adf62e",
        "url": "https://arxiv.org/abs/2509.05407",
    },
    "vinson2019": {
        "authors": "Vinson, A. M., Tamayo, D. & Hansen, B. M. S.",
        "year": 2019,
        "title": "The chaotic nature of TRAPPIST-1 planetary spin states",
        "venue": "Monthly Notices of the Royal Astronomical Society 488, 5739-5747",
        "doi": "10.1093/mnras/stz2113",
        "url": "https://arxiv.org/abs/1905.11419",
    },
    "dewit2018": {
        "authors": "de Wit, J., Wakeford, H. R., Lewis, N. K. et al.",
        "year": 2018,
        "title": "Atmospheric reconnaissance of the habitable-zone Earth-sized planets orbiting TRAPPIST-1",
        "venue": "Nature Astronomy 2, 214-219",
        "doi": "10.1038/s41550-017-0374-z",
        "url": "https://arxiv.org/abs/1802.02250",
    },
    "garcia2022": {
        "authors": "Garcia, L. J., Moran, S. E., Rackham, B. V. et al.",
        "year": 2022,
        "title": "HST/WFC3 transmission spectroscopy of the cold rocky planet TRAPPIST-1h",
        "venue": "Astronomy & Astrophysics 665, A19",
        "doi": "10.1051/0004-6361/202142603",
        "url": "https://arxiv.org/abs/2203.13698",
    },
    "known-sky-exo-rules": {
        "authors": "Known Sky contributors",
        "year": 2026,
        "title": "TRAPPIST-1 data pipeline: inference formulas and surface-generation rules",
        "venue": "Known Sky source repository, docs/EXO_TRAPPIST1.md and tools/pipeline/exoplanets.py (MIT licence)",
        "url": "https://github.com/DistinKt3/SpaceStem/blob/main/docs/EXO_TRAPPIST1.md",
    },
}

# Archive reference strings (the refstr attribute of *_reflink) -> citation key. An unknown reference stops the build
# so every new source is curated and verified before it reaches the game.
REFSTR_TO_KEY = {
    "AGOL_ET_AL__2021": "agol2021",
    "GRIMM_ET_AL__2018": "grimm2018",
    "DUCROT_ET_AL__2020": "ducrot2020",
    "STASSUN_ET_AL__2019": "stassun2019",
    "GAIA_COLLABORATION_ET_AL__2018": "gaia-dr2",
    "PIAULET_GHORAYEB_ET_AL__2025": "piaulet-ghorayeb2025",
}

# Agol et al. 2021 interior table (arXiv:2010.01074 source, table "tab:cmf"): core-mass fraction (wt%) for a
# water-free, fully differentiated planet, and the water mass fraction (wt%) needed if the rock is Earth-like
# (CMF = 32.5 wt%). Quoted in the composition notes.
AGOL_CMF = {"b": "25 +5/-6", "c": "27 +5/-5", "d": "20 +5/-5", "e": "25 +4/-5", "f": "20 +4/-4", "g": "16 +4/-4", "h": "17 +9/-10"}
AGOL_WATER_EARTHLIKE = {"e": "2.9 +1.7/-1.5", "f": "4.5 +1.8/-1.2", "g": "6.4 +2.0/-1.6", "h": "5.5 +4.5/-3.1"}


# --- Small utilities ----------------------------------------------------------------------------------------------

def round_sig(x: float, sig: int) -> float:
    """Round to `sig` significant figures (0 stays 0)."""
    if x == 0 or not math.isfinite(x):
        return x
    return round(x, sig - 1 - int(math.floor(math.log10(abs(x)))))


def fmt_years(t: float) -> str:
    """Order-of-magnitude duration in years, one significant figure, thousands separators."""
    return f"{round_sig(t, 1):,.0f}" if t >= 1 else f"{round_sig(t, 1):g}"


def hms_to_deg(s: str) -> float:
    m = re.fullmatch(r"(\d+)h(\d+)m([\d.]+)s", s.strip())
    if not m:
        raise ValueError(s)
    return 15.0 * (int(m.group(1)) + int(m.group(2)) / 60 + float(m.group(3)) / 3600)


def dms_to_deg(s: str) -> float:
    m = re.fullmatch(r"([+-]?)(\d+)d(\d+)m([\d.]+)s", s.strip())
    if not m:
        raise ValueError(s)
    v = int(m.group(2)) + int(m.group(3)) / 60 + float(m.group(4)) / 3600
    return -v if m.group(1) == "-" else v


# --- Deterministic hashing (bit-identical port of src/core/rng.ts) ------------------------------------------------

def _imul(a: int, b: int) -> int:
    return (a * b) & 0xFFFF_FFFF


def fmix32(h: int) -> int:
    h &= 0xFFFF_FFFF
    h ^= h >> 16
    h = _imul(h, 0x85EB_CA6B)
    h ^= h >> 13
    h = _imul(h, 0xC2B2_AE35)
    h ^= h >> 16
    return h & 0xFFFF_FFFF


def hash_string(s: str, seed: int = 0) -> int:
    """FNV-1a over UTF-16 code units, then fmix32: same as hashString() in src/core/rng.ts."""
    h = (0x811C_9DC5 ^ seed) & 0xFFFF_FFFF
    units = s.encode("utf-16-le")
    for i in range(0, len(units), 2):
        h ^= units[i] | (units[i + 1] << 8)
        h = _imul(h, 0x0100_0193)
    return fmix32(h)


class Mulberry32:
    """Same generator as Rng in src/core/rng.ts."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFF_FFFF

    def next_u32(self) -> int:
        self.state = (self.state + 0x6D2B_79F5) & 0xFFFF_FFFF
        t = self.state
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & 0xFFFF_FFFF
        return (t ^ (t >> 14)) & 0xFFFF_FFFF

    def next(self) -> float:
        return self.next_u32() / 4_294_967_296


# --- Physics (pure; tested in test_exoplanets.py) -----------------------------------------------------------------

def equilibrium_temp(teff_k: float, r_star_sun: float, a_au: float, bond_albedo: float = 0.0) -> float:
    """Planet equilibrium temperature (K): Teq = Teff * sqrt(R*/(2a)) * (1 - A)^(1/4).
    Assumes full day-night heat redistribution, emissivity 1 and no greenhouse effect."""
    return teff_k * math.sqrt(r_star_sun * R_SUN_AU / (2.0 * a_au)) * (1.0 - bond_albedo) ** 0.25


def insolation(lum_sun: float, a_au: float) -> float:
    """Stellar flux at the planet in Earth units (S_earth = 1 L_sun at 1 au): S = L / a^2."""
    return lum_sun / a_au**2


def density_rel(m_earth: float, r_earth: float) -> float:
    """Bulk density relative to Earth: M / R^3 (Earth units)."""
    return m_earth / r_earth**3


def gravity_rel(m_earth: float, r_earth: float) -> float:
    """Surface gravity relative to Earth: M / R^2 (Earth units)."""
    return m_earth / r_earth**2


def escape_velocity_kms(m_earth: float, r_earth: float) -> float:
    """Escape velocity: 11.186 km/s * sqrt(M / R) (Earth units)."""
    return V_ESC_EARTH_KMS * math.sqrt(m_earth / r_earth)


def tidal_lock_time_years(
    a_au: float,
    m_planet_earth: float,
    r_planet_earth: float,
    m_star_sun: float,
    q: float = 100.0,
    k2: float = 0.3,
    alpha: float = 0.4,
    initial_spin_period_h: float = 12.0,
) -> float:
    """Gladman et al. (1996) despinning time t = w a^6 I Q / (3 G M*^2 k2 R^5) with I = alpha M R^2.
    Order of magnitude only: Q, k2 and the initial spin are assumptions."""
    w = 2.0 * math.pi / (initial_spin_period_h * 3600.0)
    a = a_au * AU_M
    r = r_planet_earth * R_EARTH_M
    gm_p = m_planet_earth * GM_EARTH
    gm_s = m_star_sun * GM_SUN
    seconds = w * a**6 * alpha * gm_p * q / (3.0 * gm_s**2 * k2 * r**3)
    return seconds / (365.25 * 86400.0)


def rel_err(*terms: tuple[float, float, float]) -> float:
    """First-order relative error of a product of powers: terms are (value, sigma, exponent); errors independent."""
    return math.sqrt(sum((p * s / v) ** 2 for v, s, p in terms))


# --- Network + cache ----------------------------------------------------------------------------------------------

@dataclass
class Response:
    body: bytes
    meta: dict[str, str]


def cached_get(name: str, url: str, params: dict[str, str], *, refresh: bool, offline: bool) -> Response:
    """GET url?params, caching the raw body as tools/.cache/exoarchive/<name> plus <name>.meta.json."""
    CACHE.mkdir(parents=True, exist_ok=True)
    body_path = CACHE / name
    meta_path = CACHE / f"{name}.meta.json"
    full_url = f"{url}?{urllib.parse.urlencode(params)}" if params else url
    if body_path.exists() and meta_path.exists() and not refresh:
        meta = json.loads(meta_path.read_text())
        if meta.get("url") == full_url:
            return Response(body_path.read_bytes(), meta)
    if offline:
        raise SystemExit(f"--offline: no cached response for {name} ({full_url})")
    req = urllib.request.Request(full_url, headers={"User-Agent": USER_AGENT})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
            break
        except urllib.error.HTTPError as e:
            # Rate limits (Crossref answers bursts with 429): wait as asked, or back off, then retry.
            if e.code not in (429, 503) or attempt == 4:
                raise
            retry_after = e.headers.get("Retry-After", "")
            time.sleep(float(retry_after) if retry_after.isdigit() else 2.0 * 2**attempt)
    else:  # pragma: no cover - the loop either breaks or raises
        raise SystemExit(f"could not fetch {full_url}")
    meta = {"url": full_url, "retrievedUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    body_path.write_bytes(body)
    meta_path.write_text(json.dumps(meta, indent=1) + "\n")
    print(f"  fetched {name} ({len(body):,} bytes)")
    return Response(body, meta)


def nasa_tap(name: str, adql: str, **kw: bool) -> tuple[list[dict[str, Any]], dict[str, str]]:
    r = cached_get(name, NASA_TAP, {"query": adql, "format": "json"}, **kw)
    rows = json.loads(r.body)
    if not isinstance(rows, list):
        raise SystemExit(f"{name}: unexpected TAP response {r.body[:200]!r}")
    return rows, r.meta


def csv_tap(name: str, url: str, adql: str, **kw: bool) -> tuple[list[dict[str, str]], dict[str, str]]:
    r = cached_get(name, url, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql}, **kw)
    return list(csv.DictReader(io.StringIO(r.body.decode("utf-8")))), r.meta


PLANET_COLS = ["pl_orbper", "pl_orbsmax", "pl_rade", "pl_masse", "pl_dens", "pl_orbincl", "pl_orbeccen", "pl_tranmid",
               "pl_eqt", "pl_insol", "pl_ratdor"]
STAR_COLS = ["st_teff", "st_rad", "st_mass", "st_lum", "st_age", "st_met", "sy_dist", "sy_plx", "sy_vmag", "sy_jmag",
             "sy_kmag", "sy_pmra", "sy_pmdec", "ra", "dec"]


def with_errs(cols: list[str]) -> list[str]:
    return [c2 for c in cols for c2 in (c, f"{c}err1", f"{c}err2", f"{c}_reflink")]


def query_all(refresh: bool, offline: bool) -> dict[str, Any]:
    kw = {"refresh": refresh, "offline": offline}
    cols = ["pl_name", "pl_letter", "hostname", "tic_id", "gaia_dr3_id", "pl_tranmid_systemref", "st_metratio",
            "st_spectype", "st_spectype_reflink", "rastr", "decstr", "disc_year"]
    cols += with_errs(PLANET_COLS) + with_errs(STAR_COLS)
    comp, comp_meta = nasa_tap(
        "pscomppars_trappist-1.json",
        f"select {','.join(cols)} from pscomppars where hostname='{HOST}' order by pl_orbper", **kw)
    ps_cols = ["pl_name", "pl_letter", "default_flag", "pl_refname", "st_refname", "sy_refname", "pl_pubdate",
               "releasedate", "rowupdate", "pl_orbper", "pl_orbsmax", "pl_rade", "pl_masse", "pl_orbincl", "pl_tranmid",
               "pl_orbeccen", "st_teff", "st_rad", "st_mass"]
    ps, ps_meta = nasa_tap(
        "ps_default_trappist-1.json",
        f"select {','.join(ps_cols)} from ps where hostname='{HOST}' and default_flag=1 order by pl_orbper", **kw)
    count, count_meta = nasa_tap("pscomppars_count.json", "select count(*) as n from pscomppars", **kw)
    gaia, gaia_meta = csv_tap(
        "gaia_dr3_trappist-1.csv", GAIA_TAP,
        "select source_id, ref_epoch, ra, dec, parallax, parallax_error, pmra, pmra_error, pmdec, pmdec_error, "
        f"phot_g_mean_mag, ruwe from gaiadr3.gaia_source where source_id={GAIA_DR3_SOURCE_ID}", **kw)
    simbad, simbad_meta = csv_tap(
        "simbad_trappist-1_flux.csv", SIMBAD_TAP,
        "select f.filter, f.flux, f.flux_err, f.bibcode from flux as f join ident as i on f.oidref = i.oidref "
        f"where i.id = '{HOST}'", **kw)
    eprint = cached_get("agol2024_arxiv_eprint.tar.gz", AGOL2024_EPRINT, {}, **kw)
    return {
        "forecast": read_forecast(eprint.body), "forecast_meta": eprint.meta,
        "comp": comp, "comp_meta": comp_meta, "ps": ps, "ps_meta": ps_meta, "count": count, "count_meta": count_meta,
        "gaia": gaia, "gaia_meta": gaia_meta, "simbad": simbad, "simbad_meta": simbad_meta,
    }


# --- Mean transit ephemeris from the Agol et al. 2024 forecast ---------------------------------------------------

@dataclass
class ForecastTransit:
    planet: int  # 1..7 = b..h
    epoch: int
    bjd: float  # BJD_TDB of the forecast mid-transit (Agol et al. 2024 solution)


def read_forecast(eprint_targz: bytes) -> list[ForecastTransit]:
    """Read the forecast CSV from the arXiv source tarball in memory (nothing is extracted to disk).
    We use the first three columns: planet index (1-7 = b-h), transit number, and forecast mid-transit time in
    BJD_TDB - 2,450,000. The file does not label its columns; check_forecast() confirms the third column reproduces
    JWST-measured transit times. The remaining columns are not used."""
    with tarfile.open(fileobj=io.BytesIO(eprint_targz), mode="r:gz") as tf:
        member = tf.getmember(AGOL2024_CSV)
        f = tf.extractfile(member)
        if f is None:
            raise SystemExit(f"{AGOL2024_CSV} is not a regular file in the e-print")
        text = f.read().decode("utf-8")
    out = []
    for r in csv.reader(io.StringIO(text)):
        if len(r) < 6:
            continue
        out.append(ForecastTransit(int(float(r[0])), int(float(r[1])), float(r[2]) + 2_450_000))
    return out


# Three transit times measured by JWST and listed in Agol et al. 2024 (BJD_TDB - 2,450,000): two of planet h and one
# of planet c. The new solution must reproduce them, which confirms which CSV column is which.
JWST_CHECK = [(7, 10139.74928085), (7, 10289.88762392), (2, 10247.0939505)]

# Reference instant for the fitted epochs: the forecast transit nearest 2026-01-01 (the game's era).
EPHEMERIS_REF_BJD = 2_461_041.5


def check_forecast(fc: list[ForecastTransit]) -> None:
    for planet, t in JWST_CHECK:
        nearest = min((x for x in fc if x.planet == planet), key=lambda x: abs(x.bjd - 2_450_000 - t))
        if abs(nearest.bjd - 2_450_000 - t) * 1440 > 3:
            raise SystemExit(f"Agol et al. 2024 forecast does not reproduce JWST transit {t} of planet {planet}")


@dataclass
class Ephemeris:
    period: float
    period_sigma: float
    t0: float
    rms_min: float
    max_min: float
    first: float
    last: float


def fit_ephemeris(fc: list[ForecastTransit], planet: int) -> Ephemeris:
    """Least-squares line t = T0 + P (n - n_ref) through every forecast transit of one planet. The residuals are the
    transit-timing variations the straight line cannot follow."""
    pts = [x for x in fc if x.planet == planet]
    n_ref = min(pts, key=lambda x: abs(x.bjd - EPHEMERIS_REF_BJD)).epoch
    xs = [x.epoch - n_ref for x in pts]
    ys = [x.bjd for x in pts]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    period = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    t0 = my - period * mx
    res = [(y - (t0 + period * x)) * 1440 for x, y in zip(xs, ys)]
    rms = math.sqrt(sum(r * r for r in res) / (len(res) - 2))
    return Ephemeris(period, rms / 1440 / math.sqrt(sxx), t0, rms, max(abs(r) for r in res), pts[0].bjd, pts[-1].bjd)


def bjd_to_iso_date(bjd: float) -> str:
    return datetime.fromtimestamp((bjd - 2_440_587.5) * 86400, tz=timezone.utc).strftime("%Y-%m-%d")


def phase_error(fc: list[ForecastTransit], planet: int, period: float, t0: float, at_bjd: float) -> tuple[float, float]:
    """Minutes and degrees of orbital phase by which the line (period, t0) misses the forecast transit nearest at_bjd."""
    tr = min((x for x in fc if x.planet == planet), key=lambda x: abs(x.bjd - at_bjd))
    n = round((tr.bjd - t0) / period)
    dt = t0 + n * period - tr.bjd
    return dt * 1440, dt / period * 360


# --- Sourced values -----------------------------------------------------------------------------------------------

REFLINK_RE = re.compile(r"refstr=(\S+)\s+href=(\S+)\s+target=\w+>([^<]+)</a>")


@dataclass
class Ref:
    refstr: str
    url: str
    label: str

    @property
    def key(self) -> str:
        if self.refstr not in REFSTR_TO_KEY:
            raise SystemExit(f"Unknown archive reference {self.refstr} ({self.label}): add it to REFSTR_TO_KEY and "
                             "CITATIONS after verifying it.")
        return REFSTR_TO_KEY[self.refstr]


def parse_reflink(s: str | None) -> Ref:
    m = REFLINK_RE.search(s or "")
    if not m:
        raise SystemExit(f"cannot parse reference link {s!r}")
    return Ref(m.group(1), m.group(2), m.group(3).strip())


def uncertainty(err1: float | None, err2: float | None, digits: int | None = None) -> float | list[float] | None:
    """Archive err1 (+) / err2 (-) -> symmetric number or [lower, upper] magnitudes."""
    if err1 is None and err2 is None:
        return None
    up = abs(err1) if err1 is not None else abs(err2 or 0.0)
    lo = abs(err2) if err2 is not None else up
    if digits is not None:
        up, lo = round(up, digits), round(lo, digits)
    return up if math.isclose(up, lo, rel_tol=1e-9, abs_tol=1e-15) else [lo, up]


def sourced(value: Any, unit: str, provenance: str, source: str, citation: str,
            unc: float | list[float] | None = None, note: str | None = None) -> dict[str, Any]:
    if citation not in CITATIONS:
        raise SystemExit(f"citation {citation} is not in CITATIONS")
    d: dict[str, Any] = {"value": value}
    if unc is not None:
        d["uncertainty"] = unc
    d.update({"unit": unit, "provenance": provenance, "source": source, "citation": citation})
    if note:
        d["note"] = note
    return d


def archive_measured(row: dict[str, Any], col: str, unit: str, note: str | None = None) -> dict[str, Any]:
    value = row[col]
    if value is None:
        raise SystemExit(f"{row.get('pl_name', HOST)}: archive has no {col}")
    ref = parse_reflink(row.get(f"{col}_reflink"))
    return sourced(value, unit, "measured", f"NASA Exoplanet Archive pscomppars ({col}); {ref.label}", ref.key,
                   uncertainty(row.get(f"{col}err1"), row.get(f"{col}err2")), note)


def sym_err(row: dict[str, Any], col: str) -> float:
    return max(abs(row.get(f"{col}err1") or 0.0), abs(row.get(f"{col}err2") or 0.0))


# --- Corrections to archive values (each listed in docs/EXO_TRAPPIST1.md) ----------------------------------------

@dataclass
class Correction:
    path: str  # e.g. "planets.e.measured.semiMajorAxisAu.uncertainty"
    archive: Any
    used: Any
    reason: str


CORRECTIONS: list[Correction] = []


# --- Builders -----------------------------------------------------------------------------------------------------

def build_star(row: dict[str, Any], simbad: list[dict[str, str]]) -> dict[str, Any]:
    log_l = row["st_lum"]
    l_val = 10.0**log_l
    l_lo = l_val - 10.0 ** (log_l - abs(row["st_lumerr2"]))
    l_hi = 10.0 ** (log_l + abs(row["st_lumerr1"])) - l_val
    lum_ref = parse_reflink(row["st_lum_reflink"])
    spt_ref = parse_reflink(row["st_spectype_reflink"])
    gaia_id = str(row["gaia_dr3_id"]).replace("Gaia DR3", "").strip()
    if gaia_id != GAIA_DR3_SOURCE_ID:
        raise SystemExit(f"archive Gaia DR3 id {gaia_id} != {GAIA_DR3_SOURCE_ID}")

    v_rows = [r for r in simbad if r["filter"] == "V"]
    if len(v_rows) != 1 or v_rows[0]["bibcode"] != "2006AJ....132.1234C":
        raise SystemExit(f"SIMBAD V photometry changed: {v_rows}; re-check the V magnitude correction")
    v_simbad, v_simbad_err = float(v_rows[0]["flux"]), float(v_rows[0]["flux_err"])
    CORRECTIONS.append(Correction(
        "star.vMag", f"{row['sy_vmag']} +/- {sym_err(row, 'sy_vmag')} (TICv8)", f"{v_simbad} +/- {v_simbad_err}",
        "The archive's TICv8 V magnitude (TIC source flag 'cdwrf', the TIC cool-dwarf list) is 1.8 mag brighter than "
        "direct CCD photometry (Costa et al. 2006, via SIMBAD). We use the direct measurement."))

    return {
        "teffK": archive_measured(row, "st_teff", "K"),
        "radiusSun": archive_measured(row, "st_rad", "R_sun"),
        "massSun": archive_measured(
            row, "st_mass", "M_sun",
            "Agol et al. 2021 adopt this mass from the Mann et al. (2019) M_Ks-mass relation."),
        "luminosityLogSun": archive_measured(row, "st_lum", "log10(L/L_sun)"),
        "luminositySun": sourced(
            round_sig(l_val, 4), "L_sun", "measured",
            f"NASA Exoplanet Archive pscomppars (10^st_lum); {lum_ref.label}", lum_ref.key,
            uncertainty(round_sig(l_hi, 2), -round_sig(l_lo, 2)),
            "Linear form of luminosityLogSun. Agol et al. 2021 list (5.53 +/- 0.19)e-4 L_sun from Ducrot et al. 2020."),
        "ageGyr": archive_measured(
            row, "st_age", "Gyr", "Same value as Burgasser & Mamajek (2017), who combined many empirical age "
            "indicators (colour-magnitude position, density, lithium, gravity features, metallicity, kinematics, "
            "rotation, activity). The uncertainty is large."),
        "metallicityFeH": archive_measured(row, "st_met", "dex", f"Ratio {row['st_metratio']}, relative to the Sun."),
        "spectralType": sourced(row["st_spectype"], "", "measured",
                                f"NASA Exoplanet Archive pscomppars (st_spectype); {spt_ref.label}", spt_ref.key),
        "vMag": sourced(
            v_simbad, "mag", "measured", "Costa et al. 2006 CCD photometry, via SIMBAD", "costa2006", v_simbad_err,
            f"Johnson V. The NASA Exoplanet Archive lists V = {row['sy_vmag']} +/- {sym_err(row, 'sy_vmag')} from TICv8, "
            "1.8 mag brighter than this direct measurement; see docs/EXO_TRAPPIST1.md."),
        "jMag": archive_measured(row, "sy_jmag", "mag", "2MASS J (identical to the 2MASS catalogue value in SIMBAD)."),
        "kMag": archive_measured(row, "sy_kmag", "mag", "2MASS Ks (identical to the 2MASS catalogue value in SIMBAD)."),
        "gaiaDr3Id": sourced(
            gaia_id, "", "measured",
            "NASA Exoplanet Archive pscomppars (gaia_dr3_id); confirmed in the Gaia DR3 archive (gaiadr3.gaia_source)",
            "gaia-dr3"),
    }


def build_position(row: dict[str, Any], gaia: dict[str, str]) -> dict[str, Any]:
    g_ra, g_dec = float(gaia["ra"]), float(gaia["dec"])
    g_plx, g_plx_e = float(gaia["parallax"]), float(gaia["parallax_error"])
    epoch_note = (
        "ICRS. Epoch J2015.5 (the Gaia DR2 epoch carried into TICv8), not J2000: the star moves about 1.03 arcsec "
        f"per year, so its J2000 position is about 15 arcsec away. Gaia DR3 at epoch J2016.0: RA {g_ra:.6f} deg, "
        f"Dec {g_dec:.6f} deg.")
    return {
        "raDeg": archive_measured(row, "ra", "deg", epoch_note),
        "decDeg": archive_measured(row, "dec", "deg", epoch_note),
        "distancePc": archive_measured(
            row, "sy_dist", "pc",
            f"1/parallax from Gaia DR2 ({row['sy_plx']:.3f} +/- {sym_err(row, 'sy_plx'):.3f} mas). Gaia DR3 measures "
            f"{g_plx:.3f} +/- {g_plx_e:.3f} mas ({1000.0 / g_plx:.3f} pc); the archive had not adopted it for this "
            "star when queried. Light from TRAPPIST-1 takes about 40.5 years to reach us."),
    }


def build_orbital_plane(planets_rows: list[dict[str, Any]]) -> dict[str, Any]:
    incs = [r["pl_orbincl"] for r in planets_rows]
    mean = sum(incs) / len(incs)
    sd = math.sqrt(sum((x - mean) ** 2 for x in incs) / (len(incs) - 1))
    return {
        "inclinationDeg": sourced(
            round(mean, 3), "deg", "inferred",
            "Mean of the seven planets' transit inclinations (NASA Exoplanet Archive pscomppars; Agol et al. 2021)",
            "agol2021", round(sd, 3),
            "Inclination of the common orbital plane to the plane of the sky (90 deg = edge-on). The seven measured "
            f"inclinations span {min(incs):.3f}-{max(incs):.3f} deg, so Known Sky draws one shared plane. Transits "
            "cannot distinguish i from 180 - i (whether the orbits pass north or south of the stellar centre); we "
            "take i < 90 deg."),
        "nodeDeg": sourced(
            0.0, "deg", "generated", "Fixed choice by Known Sky (no measurement exists)", "known-sky-exo-rules",
            None,
            "Position angle of the ascending node on the sky, east of north. Transits constrain only the inclination; "
            "how the orbits are turned about our line of sight is unknown. We fix it at 0 deg (node due north). "
            "Changing it rotates the whole system about the line of sight and changes nothing seen from Earth."),
    }


def build_measured(row: dict[str, Any], drift: tuple[float, float], at: str) -> dict[str, Any]:
    letter = row["pl_letter"]
    if row["pl_tranmid_systemref"] != "BJD-TDB":
        raise SystemExit(f"{row['pl_name']}: transit midpoint time system {row['pl_tranmid_systemref']}")
    a = archive_measured(row, "pl_orbsmax", "au")
    if letter == "e" and math.isclose(row["pl_orbsmaxerr1"], 0.0025):
        # Agol et al. 2021 table "tab:uber_table": a = (2.925 +/- 0.025) x 1e-2 au.
        a["uncertainty"] = 0.00025
        a["note"] = ("The archive lists +/-0.0025 au, ten times the published +/-0.00025 au (Agol et al. 2021, "
                     "planetary parameters table); we use the published value.")
        CORRECTIONS.append(Correction(
            "planets.e.measured.semiMajorAxisAu.uncertainty", 0.0025, 0.00025,
            "Archive transcription: Agol et al. 2021 give a = (2.925 +/- 0.025) x 10^-2 au; every other planet's "
            "archive error matches the paper."))
    return {
        "periodDays": archive_measured(
            row, "pl_orbper", "d",
            "The osculating period at the start of Agol et al.'s N-body fit (BJD 2457257.93), not a long-term mean; "
            "see inferred.ephemerisPeriodDays for the mean period used to place the planet."),
        "semiMajorAxisAu": a,
        "radiusEarth": archive_measured(row, "pl_rade", "R_earth"),
        "massEarth": archive_measured(row, "pl_masse", "M_earth", "From transit-timing variations (planet-planet "
                                      "tugs), scaled by the stellar mass."),
        "inclinationDeg": archive_measured(row, "pl_orbincl", "deg"),
        "eccentricity": archive_measured(
            row, "pl_orbeccen", "",
            "The default (Agol et al. 2021) parameter set gives no eccentricity, so the archive shows this older "
            "transit-timing fit. All seven orbits are nearly circular; Known Sky draws circles."),
        "transitMidBJD": archive_measured(
            row, "pl_tranmid", "BJD_TDB",
            "A reference transit from an older fit than the period. Paired with the archive period it misses the "
            f"transit forecast by Agol et al. 2024 nearest {at} by {drift[0] / 60:+.1f} h ({drift[1]:+.0f} deg of "
            "orbit), because that period is an osculating value; Known Sky phases the orbit with the mean ephemeris "
            "in inferred.ephemerisTransitMidBJD instead."),
    }


def build_inferred(row: dict[str, Any], star_row: dict[str, Any], eph: Ephemeris) -> dict[str, Any]:
    letter = row["pl_letter"]
    teff, rs, a = star_row["st_teff"], star_row["st_rad"], row["pl_orbsmax"]
    s_teff, s_rs, s_a = sym_err(star_row, "st_teff"), sym_err(star_row, "st_rad"), sym_err(row, "pl_orbsmax")
    if letter == "e":
        s_a = 0.00025  # see Correction above
    log_l, s_log_l = star_row["st_lum"], sym_err(star_row, "st_lum")
    lum = 10.0**log_l
    m, r = row["pl_masse"], row["pl_rade"]
    s_m, s_r = sym_err(row, "pl_masse"), sym_err(row, "pl_rade")

    teq_rel = rel_err((teff, s_teff, 1.0), (rs, s_rs, 0.5), (a, s_a, 0.5))
    teq0 = equilibrium_temp(teff, rs, a, 0.0)
    teq30 = equilibrium_temp(teff, rs, a, 0.3)
    s_val = insolation(lum, a)
    s_rel = math.sqrt((LN10 * s_log_l) ** 2 + (2.0 * s_a / a) ** 2)
    rho = density_rel(m, r)
    g = gravity_rel(m, r)
    vesc = escape_velocity_kms(m, r)
    t_lock = tidal_lock_time_years(a, m, r, star_row["st_mass"])
    inputs = "Computed from the archive's Teff, R* and a"
    teq_note = ("Teq = Teff * sqrt(R*/(2a)) * (1 - A)^(1/4): the temperature of a uniformly warm planet that re-radiates "
                "all absorbed starlight (full heat redistribution, emissivity 1, no greenhouse effect). Real surfaces "
                "can be much warmer or colder; uncertainty from first-order propagation of independent errors.")
    teq_extra = {
        "b": " JWST measured a 15 um dayside brightness temperature of 490 +/- 17 K (Gillon et al. 2026), as expected "
             "for a dark airless rock that does not move heat to its night side.",
        "c": " JWST measured a 15 um dayside brightness temperature of 380 +/- 31 K (Zieba et al. 2023).",
    }.get(letter, "")
    arch_s = f"{row['pl_insol']} (+{row['pl_insolerr1']}/{row['pl_insolerr2']})"
    return {
        "equilibriumTempK_A0": sourced(
            round(teq0, 1), "K", "inferred", f"{inputs}, Bond albedo A = 0", "agol2021", round(teq0 * teq_rel, 1),
            teq_note + teq_extra + f" The archive's Ducrot et al. 2020 value is {row['pl_eqt']} K."),
        "equilibriumTempK_A030": sourced(
            round(teq30, 1), "K", "inferred", f"{inputs}, Bond albedo A = 0.3 (Earth-like)", "agol2021",
            round(teq30 * teq_rel, 1), teq_note),
        "insolationEarth": sourced(
            round_sig(s_val, 4), "S_earth", "inferred", "S = L / a^2 from the archive's luminosity and a",
            "agol2021", round_sig(s_val * s_rel, 2),
            f"Starlight reaching the planet relative to what Earth receives from the Sun. Agol et al. 2021 list {arch_s}."),
        "densityRelEarth": sourced(
            round(rho, 3), "rho_earth", "inferred", "rho = M / R^3 from the archive's mass and radius", "agol2021",
            round(rho * rel_err((m, s_m, 1.0), (r, s_r, 3.0)), 3),
            f"Earth = 1 (5.513 g/cm^3). The archive lists {row['pl_dens']:.3f} g/cm^3. Independent-error propagation "
            "overestimates the spread: mass and radius share the stellar-mass uncertainty."),
        "surfaceGravityG": sourced(
            round(g, 3), "g_earth", "inferred", "g = M / R^2 from the archive's mass and radius", "agol2021",
            round(g * rel_err((m, s_m, 1.0), (r, s_r, 2.0)), 3), "Earth = 1 (9.82 m/s^2 mean)."),
        "escapeVelocityKms": sourced(
            round(vesc, 2), "km/s", "inferred", "v_esc = 11.186 km/s * sqrt(M / R) from the archive's mass and radius",
            "agol2021", round(vesc * rel_err((m, s_m, 0.5), (r, s_r, 0.5)), 2),
            "Scaled from Earth's 11.186 km/s (NASA Earth Fact Sheet)."),
        "tidallyLocked": sourced(
            True, "", "inferred", "Tidal spin-down timescale compared with the system's age", "turbet2018", None,
            "Not observed. Turbet et al. 2018 find from N-body and tidal modelling that each TRAPPIST-1 planet is "
            f"likely in synchronous rotation (one face always toward the star). Order-of-magnitude check (Gladman et "
            f"al. 1996; Q = 100, k2 = 0.3, initial 12 h spin): spin-down in about {fmt_years(t_lock)} years, far "
            f"shorter than the system's {star_row['st_age']} Gyr age. Caveat: Vinson et al. 2019 show that mutual "
            "tugs in the resonant chain can push d, e and f into effectively non-synchronous spin states (the "
            "point under the star librates or even drifts around the planet)" + (
                ", so this planet may not keep exactly one face toward the star." if letter in "def" else
                "; they did not model this planet.")),
        "ephemerisPeriodDays": sourced(
            round(eph.period, 7), "d", "inferred",
            "Mean period: least-squares line through every transit time forecast by Agol et al. 2024 "
            f"({bjd_to_iso_date(eph.first)} to {bjd_to_iso_date(eph.last)})", "agol2024",
            round_sig(eph.period_sigma, 2),
            "The forecast is an N-body fit to transit times measured from the ground, Spitzer, K2, HST and JWST. A "
            "straight line cannot follow the planets' mutual tugs (transit-timing variations): the forecast "
            f"transits stray from it by up to {eph.max_min:.0f} min ({eph.rms_min:.0f} min rms) over that span. The "
            "uncertainty is the formal fit error."),
        "ephemerisTransitMidBJD": sourced(
            round(eph.t0, 5), "BJD_TDB", "inferred",
            "Mean-ephemeris transit nearest 2026-01-01, from the same least-squares line through the Agol et al. "
            "2024 forecast", "agol2024", round(eph.rms_min / 1440, 5),
            "Used with ephemerisPeriodDays to place the planet on its orbit (phase 0 = mid-transit as seen from the "
            "Solar System). The uncertainty is the rms of the transit-timing variations about the line. Beyond "
            f"{bjd_to_iso_date(eph.last)} the forecast ends and the error grows slowly."),
        "composition": composition(letter, rho, s_val),
        "atmosphere": atmosphere(letter),
    }


def composition(letter: str, rho: float, s: float) -> dict[str, Any]:
    base = (f"Density {rho:.2f} x Earth's. Agol et al. 2021 find all seven planets consistent with one rocky "
            "composition, slightly less iron-rich than Earth (core-mass fraction 21 +/- 4 wt% if water-free; "
            f"{AGOL_CMF[letter]} wt% for this planet), or Earth-like rock with added water, or iron-free oxidised rock. "
            "The data cannot decide between these.")
    if letter in AGOL_WATER_EARTHLIKE:
        return sourced(
            "rocky-or-water-rich", "", "inferred", "Bulk density versus interior models", "agol2021", None,
            base + f" With Earth-like rock (32.5 wt% core) this density allows {AGOL_WATER_EARTHLIKE[letter]} wt% "
            "water; with iron-poorer rock it needs none.")
    return sourced(
        "rocky", "", "inferred", "Bulk density versus interior models", "agol2021", None,
        base + f" At {s:.2f} x Earth's insolation it lies beyond the runaway-greenhouse limit, where water could not "
        "stay condensed on the surface (Agol et al. 2021).")


def atmosphere(letter: str) -> dict[str, Any]:
    src = "Published observations"
    if letter == "b":
        return sourced(
            "thick-co2-disfavoured", "", "inferred", "JWST/MIRI 15 um secondary eclipses", "greene2023", None,
            "JWST detected the dayside's thermal emission; it is most consistent with little or no atmosphere and no "
            "CO2 absorption (Greene et al. 2023). Adding 12.8 um eclipses, an airless fresh-rock surface fits, but so "
            "does a hazy CO2 atmosphere (Ducrot et al. 2025). Phase curves then strongly disfavoured atmospheres with "
            "surface pressures of 1 bar or more and efficient greenhouse effects (Gillon et al. 2026).")
    if letter == "c":
        return sourced(
            "thick-co2-disfavoured", "", "inferred", "JWST/MIRI 15 um secondary eclipses", "zieba2023", None,
            "The dayside brightness temperature (380 +/- 31 K) disfavours a thick CO2-rich atmosphere; thinner "
            "atmospheres or bare rock remain possible (Zieba et al. 2023). Phase curves strongly disfavour atmospheres "
            "with surface pressures of 1 bar or more and efficient greenhouse effects; a tenuous, greenhouse-poor "
            "O2-dominated one is still allowed (Gillon et al. 2026).")
    notes = {
        "d": ("piaulet-ghorayeb2025", "JWST/NIRSpec transmission spectrum",
              "Unknown. A JWST transmission spectrum is flat: it rules out clear hydrogen-rich atmospheres and many "
              "thicker Venus-, Titan- or Earth-like ones. A very thin or hazy atmosphere, or none, remains possible "
              "(Piaulet-Ghorayeb et al. 2025)."),
        "e": ("espinoza2025", "JWST/NIRSpec transmission spectra",
              "Unknown. JWST rules out cloudy hydrogen-dominated atmospheres (Espinoza et al. 2025) but finds no strong "
              "evidence for or against a secondary atmosphere; both bare rock and a nitrogen-rich atmosphere fit "
              "(Glidden et al. 2025)."),
        "f": ("dewit2018", "HST/WFC3 transmission spectra",
              "Unknown. Hubble ruled out a cloud-free hydrogen-dominated atmosphere (de Wit et al. 2018); denser "
              "atmospheres are not yet constrained."),
        "g": ("dewit2018", "HST/WFC3 transmission spectra",
              "Unknown. Hubble could not exclude even a cloud-free hydrogen-dominated atmosphere for g (de Wit et al. "
              "2018); nothing is known about denser ones."),
        "h": ("garcia2022", "HST/WFC3 transmission spectra",
              "Unknown. Hubble makes an aerosol-free hydrogen/helium atmosphere unlikely; the flat spectrum fits a "
              "heavy atmosphere, an opaque haze, or none (Garcia et al. 2022)."),
    }
    key, method, note = notes[letter]
    return sourced("unknown", "", "inferred", f"{src}: {method}", key, None, note)


# --- Generated surfaces -------------------------------------------------------------------------------------------

S_RUNAWAY = 1.0  # S_earth. Agol et al. 2021: b, c and d (S >= 1.1) lie beyond the runaway-greenhouse limit.
T_FREEZE_K = 273.15
T_ICE_FULL_K = 150.0
ICE_ALBEDO = 0.45  # dirty ice; ice reflects M-dwarf (near-infrared-rich) light less well than sunlight
FRESH_SURFACE = {"b": "One of the two scenarios that fit JWST's eclipses is a dark, airless surface of fresh, unweathered "
                      "ultramafic rock, a hint of recent resurfacing (Ducrot et al. 2025), and JWST phase curves favour "
                      "an airless, low-albedo rocky surface (Gillon et al. 2026)"}
REFLECTIVE_HINT = {"c": "JWST phase curves allow an airless planet with a more reflective surface (Gillon et al. 2026)"}
ROCK_ALBEDO = {"volcanic": 0.05, "cratered": 0.12, "reflective": 0.18}
THOLIN_BELOW_S = 0.3

# Reflectance colours under white light (the renderer applies TRAPPIST-1's deep orange light). Five sRGB colours:
# 'volcanic' and 'cratered' are five rock tones, dark to light; 'mixed' and 'icy' are two rock tones (dark, light)
# followed by three ice tones (dark to light).
PALETTES = {
    "volcanic": ["#191817", "#25221f", "#332e29", "#463d34", "#5a4b3d"],
    "cratered": ["#3d3833", "#544c45", "#6d645b", "#887d72", "#a2978b"],
    "mixed": ["#4a4540", "#6c655e", "#97a0a8", "#c3cbd2", "#e4e9ed"],
    "icy": ["#4f4943", "#746b63", "#aeb8c1", "#d0d8de", "#eef2f5"],
}
THOLIN = ["#6b4e3d", "#957157"]  # tholin-stained regolith replaces the two rock tones


def jitter_palette(colours: list[str], rng: Mulberry32) -> list[str]:
    out = []
    for c in colours:
        rgb = [int(c[i:i + 2], 16) for i in (1, 3, 5)]
        k = 1.0 + (rng.next() - 0.5) * 0.10
        rgb = [max(0, min(255, round(v * k + (rng.next() - 0.5) * 8))) for v in rgb]
        out.append("#" + "".join(f"{v:02x}" for v in rgb))
    return out


def generate_surface(planet_id: str, letter: str, s_earth: float, teq30: float) -> dict[str, Any]:
    """Rule-based surface parameters. Same inputs -> same outputs; the seed only adds colour jitter."""
    seed = hash_string(planet_id)
    rng = Mulberry32(seed)
    why: list[str] = []
    if s_earth > S_RUNAWAY:
        ice = 0.0
        why.append(f"Insolation {s_earth:.3g} x Earth's is above the runaway-greenhouse limit, so no surface ice.")
    else:
        ice = round(min(1.0, max(0.0, (T_FREEZE_K - teq30) / (T_FREEZE_K - T_ICE_FULL_K))), 2)
        why.append(
            f"Insolation {s_earth:.3g} x Earth's; the equilibrium temperature at albedo 0.3 is {teq30:.0f} K, below "
            f"freezing, so any water would be ice. Ice cover {round(ice * 100)}% (rule: 0% at 273 K rising linearly "
            "to 100% at 150 K). How much water the planet has is not known.")
    if ice >= 0.5:
        terrain, rock = "icy", "cratered"
    elif ice > 0.05:
        terrain, rock = "mixed", "cratered"
    elif letter in FRESH_SURFACE:
        terrain, rock = "volcanic", "volcanic"
        why.append(FRESH_SURFACE[letter] + ", so we draw dark volcanic plains.")
    else:
        terrain, rock = "cratered", "cratered"
        why.append("With no sign of resurfacing, the terrain defaults to old, cratered rock.")
    rock_albedo = ROCK_ALBEDO[rock]
    if letter in REFLECTIVE_HINT:
        rock_albedo = ROCK_ALBEDO["reflective"]
        why.append(REFLECTIVE_HINT[letter] + f", so the rock albedo is raised to {rock_albedo}.")
    albedo = round(rock_albedo * (1.0 - ice) + ICE_ALBEDO * ice, 2)
    why.append(f"Bond albedo {albedo} (rock {rock_albedo}, ice {ICE_ALBEDO}, weighted by ice cover).")

    base = PALETTES[terrain][:]
    if ice > 0 and s_earth < THOLIN_BELOW_S:
        base[0], base[1] = THOLIN
        why.append("Turbet et al. 2018 suggest photochemical hazes could settle on TRAPPIST-1 planets and build up a "
                   "surface layer of tholins. As a design choice we tint the bare ground reddish-brown on the coldest "
                   f"icy planets only (insolation below {THOLIN_BELOW_S} x Earth's).")
    if ice > 0:
        why.append("Previews draw the ice away from the point under the star, assuming one face always points at it "
                   "(likely but not certain; see the tidal-locking note).")
    glow = 0.0
    if terrain == "volcanic":
        glow = 0.06
        why.append("A faint night-side glow stands for possible tidally driven volcanism. It is kept faint because JWST "
                   "detected no night-side emission (Gillon et al. 2026).")
    return {
        "seed": seed,
        "terrain": terrain,
        "albedo": albedo,
        "palette": jitter_palette(base, rng),
        "iceCoverage": ice,
        "nightSideGlow": glow,
        "rationale": " ".join(why),
        "provenance": "generated",
        "source": "Known Sky rule-based surface generator v1 (inputs: inferred insolation and equilibrium temperature, "
                  "published JWST constraints)",
        "citation": "known-sky-exo-rules",
    }


# --- Assembly -----------------------------------------------------------------------------------------------------

def collect_citations(obj: Any, out: set[str]) -> None:
    if isinstance(obj, dict):
        c = obj.get("citation")
        if isinstance(c, str):
            out.add(c)
        for v in obj.values():
            collect_citations(v, out)
    elif isinstance(obj, list):
        for v in obj:
            collect_citations(v, out)


NOTE_CITATIONS = ["agol2024", "ducrot2025", "gillon2026", "glidden2025", "gladman1996", "vinson2019"]  # notes only


def build(data: dict[str, Any]) -> dict[str, Any]:
    CORRECTIONS.clear()
    comp, ps = data["comp"], data["ps"]
    if len(comp) != 7 or len(ps) != 7:
        raise SystemExit(f"expected 7 TRAPPIST-1 planets, got {len(comp)} composite / {len(ps)} default rows")
    star_row = comp[0]
    forecast = data["forecast"]
    check_forecast(forecast)
    at_date = data["comp_meta"]["retrievedUtc"][:10]
    at_bjd = datetime.strptime(at_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() / 86400 + 2_440_587.5
    defaults = {r["pl_name"]: r for r in ps}
    gaia = data["gaia"][0]
    if gaia["source_id"] != GAIA_DR3_SOURCE_ID:
        raise SystemExit("Gaia DR3 cross-check returned the wrong source")

    planets = []
    for row in comp:
        letter = row["pl_letter"]
        pid = f"{SYSTEM_ID}{letter}"
        d = defaults[row["pl_name"]]
        dref = parse_reflink(d["pl_refname"])
        idx = LETTERS.index(letter) + 1
        eph = fit_ephemeris(forecast, idx)
        drift = phase_error(forecast, idx, row["pl_orbper"], row["pl_tranmid"], at_bjd)
        measured = build_measured(row, drift, at_date)
        inferred = build_inferred(row, star_row, eph)
        generated = generate_surface(
            pid, letter, inferred["insolationEarth"]["value"], inferred["equilibriumTempK_A030"]["value"])
        planets.append({
            "id": pid,
            "name": row["pl_name"],
            "letter": letter,
            "defaultParameterSet": {"label": dref.label, "citation": dref.key, "published": d["pl_pubdate"]},
            "measured": measured,
            "inferred": inferred,
            "generated": generated,
        })

    n = data["count"][0]["n"]
    count_date = data["count_meta"]["retrievedUtc"][:10]
    out: dict[str, Any] = {
        "id": SYSTEM_ID,
        "name": HOST,
        "retrieved": data["comp_meta"]["retrievedUtc"][:10],
        "source": "NASA Exoplanet Archive TAP: Planetary Systems Composite Parameters (pscomppars) for measured values "
                  "and their per-parameter references, Planetary Systems table (ps, default_flag=1) for each planet's "
                  "default parameter set; cross-checked against Gaia DR3, SIMBAD and Agol et al. 2021. Built by "
                  "tools/pipeline/exoplanets.py.",
        "exoplanetCount": {
            "value": n,
            "asOf": count_date,
            "source": "NASA Exoplanet Archive TAP: select count(*) from pscomppars (one row per confirmed planet)",
            "citation": "nasa-exoplanet-archive",
        },
        "star": build_star(star_row, data["simbad"]),
        "position": build_position(star_row, gaia),
        "orbitalPlane": build_orbital_plane(comp),
        "planets": planets,
    }
    keys: set[str] = set(NOTE_CITATIONS)
    collect_citations(out, keys)
    out["citations"] = {k: CITATIONS[k] for k in sorted(keys)}
    return out


# --- Cross-checks -------------------------------------------------------------------------------------------------

def decimals(x: float) -> int:
    s = repr(float(x))
    if "e" in s:
        mant, exp = s.split("e")
        return max(0, len(mant.split(".")[1]) - int(exp)) if "." in mant else max(0, -int(exp))
    return len(s.split(".")[1].rstrip("0")) if "." in s else 0


def agree(a: float, b: float) -> bool:
    """Equal to the precision the less precise value is quoted with."""
    return abs(a - b) <= 0.5 * 10.0 ** (-min(decimals(a), decimals(b))) + 1e-12


EXPLAIN = {
    "star.parallax": "Archive uses Gaia DR2 for this star; the verified file has Gaia (E)DR3, now confirmed in the Gaia "
                     "DR3 archive. We keep the archive distance and quote DR3 in the note (0.3% difference).",
    "star.distance": "Follows from the parallax difference above.",
    "star.ra": "Different epochs: the archive position is at J2015.5 (TICv8), the verified file at J2000. Proper motion "
               "explains the offset.",
    "star.dec": "Different epochs, as for RA.",
    "star.pm_ra": "Archive uses TICv8 proper motion (SuperBlink, +/-8 mas/yr); the verified value is Gaia DR3 (confirmed "
                  "in the Gaia archive). Not used in the output.",
    "star.pm_dec": "As for pm_ra.",
    "star.v_mag": "Archive V comes from TICv8; the verified value is direct photometry (Costa et al. 2006). We use the "
                  "direct photometry (see Corrections).",
    "star.spectral_type": "Same class written differently (M8.0 V vs M8V).",
    "star.luminosity": "Archive stores log10 L with asymmetric errors; 10^-3.25727 = 5.527e-4 agrees with 5.53e-4 to "
                       "rounding.",
    "planets.e.semi_major_axis_au": "Archive uncertainty is ten times the published one (transcription). We use the "
                                    "published value (see Corrections).",
    "planets.b.semi_major_axis_au": "Verified file had no uncertainty for b; the archive's +/-0.0001 au matches the paper.",
    "exoplanet_count": "Live count at query time.",
}


def cross_check(out: dict[str, Any], data: dict[str, Any]) -> tuple[list[list[str]], int]:
    """Compare the archive (as used) with tools/exo/trappist1_verified.json. Returns (difference rows, matches)."""
    v = json.loads(VERIFIED.read_text())
    star_row = data["comp"][0]
    rows: list[list[str]] = []
    matches = 0

    def cmp(field: str, arch_val: float, arch_unc: float | None, ver: dict[str, Any], show: str | None = None) -> None:
        nonlocal matches
        vv, vu = ver["value"], ver.get("uncertainty")
        ok_v = agree(float(arch_val), float(vv))
        ok_u = vu is None or arch_unc is None or agree(float(arch_unc), float(vu))
        if ok_v and ok_u and not (vu is None and arch_unc is not None):
            matches += 1
            return
        a_s = show or (f"{arch_val} +/- {arch_unc}" if arch_unc is not None else f"{arch_val}")
        v_s = f"{vv} +/- {vu}" if vu is not None else f"{vv}"
        rows.append([field, a_s, v_s, EXPLAIN.get(field, "UNEXPLAINED: investigate before release")])

    vs = v["star"]
    cmp("star.mass", star_row["st_mass"], sym_err(star_row, "st_mass"), vs["mass"])
    cmp("star.radius", star_row["st_rad"], sym_err(star_row, "st_rad"), vs["radius"])
    cmp("star.teff", star_row["st_teff"], sym_err(star_row, "st_teff"), vs["teff"])
    lum = 10.0 ** star_row["st_lum"]
    lum_unc = lum * LN10 * sym_err(star_row, "st_lum")
    lum_ok = abs(lum - vs["luminosity"]["value"]) < vs["luminosity"]["uncertainty"] / 5
    if not lum_ok:
        rows.append(["star.luminosity", f"{lum:.4e}", str(vs["luminosity"]["value"]), EXPLAIN["star.luminosity"]])
    else:
        matches += 1
    cmp("star.age", star_row["st_age"], sym_err(star_row, "st_age"), vs["age"])
    cmp("star.parallax", star_row["sy_plx"], sym_err(star_row, "sy_plx"), vs["parallax"],
        f"{star_row['sy_plx']:.4f} +/- {sym_err(star_row, 'sy_plx'):.4f} (Gaia DR2)")
    cmp("star.distance", star_row["sy_dist"], sym_err(star_row, "sy_dist"), vs["distance"],
        f"{star_row['sy_dist']:.4f} +/- {sym_err(star_row, 'sy_dist'):.4f}")
    cmp("star.pm_ra", star_row["sy_pmra"], sym_err(star_row, "sy_pmra"), vs["pm_ra"])
    cmp("star.pm_dec", star_row["sy_pmdec"], sym_err(star_row, "sy_pmdec"), vs["pm_dec"])
    cmp("star.v_mag", star_row["sy_vmag"], sym_err(star_row, "sy_vmag"), vs["v_mag"])
    cmp("star.j_mag", star_row["sy_jmag"], sym_err(star_row, "sy_jmag"), vs["j_mag"])
    ra_v, dec_v = hms_to_deg(vs["ra_j2000"]["value"]), dms_to_deg(vs["dec_j2000"]["value"])
    d_ra = (star_row["ra"] - ra_v) * math.cos(math.radians(dec_v)) * 3600
    d_dec = (star_row["dec"] - dec_v) * 3600
    rows.append(["star.ra", f"{star_row['ra']:.7f} deg (J2015.5)", f"{vs['ra_j2000']['value']} = {ra_v:.7f} deg",
                 EXPLAIN["star.ra"] + f" Offset {d_ra:+.1f} arcsec."])
    rows.append(["star.dec", f"{star_row['dec']:.7f} deg (J2015.5)", f"{vs['dec_j2000']['value']} = {dec_v:.7f} deg",
                 EXPLAIN["star.dec"] + f" Offset {d_dec:+.1f} arcsec."])
    spt = str(star_row["st_spectype"]).replace(".0", "").replace(" ", "")
    if spt != vs["spectral_type"]["value"]:
        rows.append(["star.spectral_type", star_row["st_spectype"], vs["spectral_type"]["value"],
                     "UNEXPLAINED: investigate before release"])
    else:
        rows.append(["star.spectral_type", star_row["st_spectype"], vs["spectral_type"]["value"],
                     EXPLAIN["star.spectral_type"]])
    if out["star"]["gaiaDr3Id"]["value"] == vs["gaia_dr3_source_id"]["value"]:
        matches += 1
    else:
        rows.append(["star.gaia_dr3_source_id", out["star"]["gaiaDr3Id"]["value"], vs["gaia_dr3_source_id"]["value"],
                     "UNEXPLAINED: investigate before release"])

    for row in data["comp"]:
        L = row["pl_letter"]
        vp = v["planets"][L]
        f = f"planets.{L}"
        cmp(f"{f}.period_days", row["pl_orbper"], sym_err(row, "pl_orbper"), vp["period_days"])
        cmp(f"{f}.semi_major_axis_au", row["pl_orbsmax"], sym_err(row, "pl_orbsmax"), vp["semi_major_axis_au"])
        cmp(f"{f}.radius_earth", row["pl_rade"], sym_err(row, "pl_rade"), vp["radius_earth"])
        cmp(f"{f}.mass_earth", row["pl_masse"], sym_err(row, "pl_masse"), vp["mass_earth"])
        rho = row["pl_dens"] / 5.514
        if agree(round(rho, 3), vp["density_earth"]["value"]):
            matches += 1
        else:
            rows.append([f"{f}.density_earth", f"{rho:.3f} ({row['pl_dens']:.3f} g/cm^3 / 5.514)",
                         str(vp["density_earth"]["value"]), "UNEXPLAINED: investigate before release"])
        cmp(f"{f}.inclination_deg", row["pl_orbincl"], sym_err(row, "pl_orbincl"), vp["inclination_deg"])
        cmp(f"{f}.insolation_earth", row["pl_insol"], None, vp["insolation_earth"])
        # Transit epoch: the archive's midpoint (Ducrot et al. 2020) vs Agol et al. 2021 t0, compared as a phase.
        t0v, per = vp["t0_bjd_tdb"]["value"], row["pl_orbper"]
        n_orb = round((row["pl_tranmid"] - t0v) / per)
        dt_min = (row["pl_tranmid"] - t0v - n_orb * per) * 1440.0
        rows.append([f"{f}.t0_bjd_tdb", f"{row['pl_tranmid']} (Ducrot et al. 2020)", f"{t0v} (Agol et al. 2021)",
                     f"Different reference transits ({n_orb} orbits apart). Agol's t0 and P are osculating N-body "
                     f"elements, not a linear ephemeris; carried forward with the archive period they differ by "
                     f"{dt_min:+.1f} min. See the phase check below."])
    vc = v["exoplanet_count"]
    rows.append(["exoplanet_count", f"{out['exoplanetCount']['value']} (as of {out['exoplanetCount']['asOf']})",
                 f"{vc['value']} (as of {vc['as_of']})",
                 "Same count." if vc["value"] == out["exoplanetCount"]["value"] else EXPLAIN["exoplanet_count"]])
    return rows, matches


def phase_check(out: dict[str, Any], data: dict[str, Any]) -> list[list[str]]:
    """How far each linear ephemeris is from the Agol et al. 2024 forecast transit nearest the query date."""
    fc = data["forecast"]
    at_date = out["retrieved"]
    at_bjd = datetime.strptime(at_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() / 86400 + 2_440_587.5
    rows = []
    for i, p in enumerate(out["planets"], start=1):
        m, inf = p["measured"], p["inferred"]
        tr = min((x for x in fc if x.planet == i), key=lambda x: abs(x.bjd - at_bjd))
        a_min, a_deg = phase_error(fc, i, m["periodDays"]["value"], m["transitMidBJD"]["value"], at_bjd)
        e_min, e_deg = phase_error(fc, i, inf["ephemerisPeriodDays"]["value"], inf["ephemerisTransitMidBJD"]["value"],
                                   at_bjd)
        eph = fit_ephemeris(fc, i)
        rows.append([p["letter"], f"{tr.bjd:.5f}", f"{a_min / 60:+.1f} h ({a_deg:+.0f} deg)",
                     f"{e_min:+.0f} min ({e_deg:+.1f} deg)", f"{eph.max_min:.0f} min ({eph.rms_min:.0f} min rms)"])
    return rows


def default_set_check(data: dict[str, Any]) -> list[str]:
    """pscomppars should carry the default parameter set's values for these fields."""
    issues = []
    defaults = {r["pl_name"]: r for r in data["ps"]}
    for row in data["comp"]:
        d = defaults[row["pl_name"]]
        for col in ("pl_orbper", "pl_orbsmax", "pl_rade", "pl_masse", "pl_orbincl"):
            if d[col] is None or not math.isclose(row[col], d[col], rel_tol=1e-9):
                issues.append(f"{row['pl_name']} {col}: composite {row[col]} vs default set {d[col]}")
    return issues


def markdown_table(header: list[str], rows: list[list[str]]) -> str:
    esc = [[c.replace("|", "\\|") for c in r] for r in rows]
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    lines += ["| " + " | ".join(r) + " |" for r in esc]
    return "\n".join(lines)


def update_doc(out: dict[str, Any], rows: list[list[str]], matches: int, default_issues: list[str],
               phase_rows: list[list[str]]) -> None:
    if not DOC.exists():
        return
    text = DOC.read_text()
    begin, end = "<!-- crosscheck:begin -->", "<!-- crosscheck:end -->"
    if begin not in text or end not in text:
        return
    corr = markdown_table(["Field", "Archive", "Used", "Reason"],
                          [[c.path, str(c.archive), str(c.used), c.reason] for c in CORRECTIONS])
    parts = [
        begin,
        f"_Generated by `tools/pipeline/exoplanets.py` from the archive query of {out['retrieved']}. Do not edit by "
        "hand._",
        "",
        f"**{matches} values agree** with `tools/exo/trappist1_verified.json` to the precision quoted. "
        f"**{len(rows)} rows** below differ or need a comment.",
        "",
        markdown_table(["Field", "NASA Exoplanet Archive", "trappist1_verified.json", "Explanation"], rows),
        "",
        f"**Orbital phase check** against the transit forecast of Agol et al. 2024 nearest {out['retrieved']} "
        "(BJD_TDB). \"Archive P, T0\": the archive's period and transit midpoint used as a linear ephemeris. "
        "\"Mean ephemeris\": `inferred.ephemerisPeriodDays` and `ephemerisTransitMidBJD`, which `orbitalPosition` "
        "uses. \"TTV\": the largest and rms gap between the mean ephemeris and the forecast over 2015-2027 "
        "(transit-timing variations a straight line cannot follow).",
        "",
        markdown_table(["Planet", "Forecast transit", "Archive P, T0", "Mean ephemeris", "TTV"], phase_rows),
        "",
        "**Corrections applied to archive values in the output:**",
        "",
        corr,
        "",
        "**Composite vs default parameter set:** " + (
            "pscomppars carries the default set's period, semi-major axis, radius, mass and inclination for all seven "
            "planets." if not default_issues else "; ".join(default_issues)),
        end,
    ]
    new = text[: text.index(begin)] + "\n".join(parts) + text[text.index(end) + len(end):]
    write_atomic(DOC, new)


def write_atomic(path: Path, text: str) -> None:
    """Write via a temporary file in the same directory and rename, so a failed run never leaves a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


# --- Test fixtures (committed, so the archive comparisons run on a fresh checkout) --------------------------------

FIXTURES = ROOT / "tools" / "pipeline" / "fixtures"
FIXTURE_ARCHIVE = FIXTURES / "pscomppars_trappist-1.json"
FIXTURE_FORECAST = FIXTURES / "agol2024_forecast_subset.csv"
FORECAST_FIXTURE_STRIDE = 10


def forecast_subset(fc: list[ForecastTransit]) -> list[ForecastTransit]:
    """Every FORECAST_FIXTURE_STRIDE-th transit of each planet, its first and last, and the JWST check transits."""
    keep: list[ForecastTransit] = []
    for planet in range(1, 8):
        pts = [x for x in fc if x.planet == planet]
        jwst = {min(pts, key=lambda x: abs(x.bjd - 2_450_000 - t)).epoch for p, t in JWST_CHECK if p == planet}
        last = len(pts) - 1
        keep += [x for i, x in enumerate(pts) if i % FORECAST_FIXTURE_STRIDE == 0 or i == last or x.epoch in jwst]
    return keep


def write_fixtures(data: dict[str, Any]) -> None:
    """Copy the raw pscomppars response and a subset of the Agol et al. 2024 forecast (planet, transit number and
    BJD_TDB - 2,450,000 at full precision) to tools/pipeline/fixtures/ for test_exoplanets.py."""
    FIXTURES.mkdir(parents=True, exist_ok=True)
    write_atomic(FIXTURE_ARCHIVE, (CACHE / "pscomppars_trappist-1.json").read_text())
    lines = [f"{x.planet},{x.epoch},{x.bjd - 2_450_000!r}" for x in forecast_subset(data["forecast"])]
    write_atomic(FIXTURE_FORECAST, "\n".join(lines) + "\n")
    print(f"wrote {FIXTURE_ARCHIVE.relative_to(ROOT)} and {FIXTURE_FORECAST.relative_to(ROOT)} ({len(lines)} transits)")


def read_forecast_fixture(path: Path = FIXTURE_FORECAST) -> list[ForecastTransit]:
    out = []
    for r in csv.reader(io.StringIO(path.read_text())):
        if r:
            out.append(ForecastTransit(int(r[0]), int(r[1]), float(r[2]) + 2_450_000))
    return out


# --- Citation check against Crossref (online, optional) -----------------------------------------------------------

INITIALS_RE = re.compile(r"^(?:[A-Z][a-z]?\.(?:-[A-Z]\.)?\s?)+$")


def fold(s: str) -> str:
    """Lower-case, accents removed: 'Méndez' -> 'mendez'."""
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).lower().strip()


def listed_surnames(authors: str) -> list[str]:
    """Surnames in our 'Surname, I., Surname, I. et al.' strings (group names such as 'Gaia Collaboration' included)."""
    s = authors.replace(" et al.", "").replace(" & ", ", ")
    return [tok for tok in (t.strip() for t in s.split(",")) if tok and not INITIALS_RE.match(tok)]


def verify_citations(refresh: bool, offline: bool) -> tuple[list[str], int]:
    """Compare each Crossref-registered citation's first listed surnames (up to three) with Crossref's author order.
    The archive table DOI (DataCite) and entries without a DOI are skipped. Returns (problems, DOIs checked)."""
    problems = []
    checked = 0
    for key, c in CITATIONS.items():
        doi = c.get("doi")
        if not doi or doi.startswith("10.26133/"):
            continue
        r = cached_get(f"crossref_{doi.replace('/', '_')}.json", f"https://api.crossref.org/works/{doi}", {},
                       refresh=refresh, offline=offline)
        msg = json.loads(r.body)["message"]
        checked += 1
        theirs = [fold(a.get("family") or a.get("name") or "") for a in msg.get("author", [])]
        ours = [fold(n) for n in listed_surnames(c["authors"]) if fold(n) != "gaia collaboration"]
        if theirs and fold(theirs[0]) == "gaia collaboration":
            theirs = theirs[1:]
        if theirs[: len(ours[:3])] != ours[:3]:
            problems.append(f"{key}: we list {ours[:3]}, Crossref has {theirs[:3]}")
    return problems, checked


def check_rows_agree(comp: list[dict[str, Any]]) -> list[str]:
    """Stellar and system columns must be identical on every planet row, since the build reads them from the first."""
    issues = []
    cols = [c for c in comp[0] if c.startswith(("st_", "sy_")) or c in ("ra", "dec", "rastr", "decstr", "gaia_dr3_id")]
    for row in comp[1:]:
        for c in cols:
            if row.get(c) != comp[0].get(c):
                issues.append(f"{row['pl_name']} {c}: {row.get(c)!r} differs from {comp[0]['pl_name']} {comp[0].get(c)!r}")
    return issues


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--refresh", action="store_true", help="query every service again")
    mode.add_argument("--offline", action="store_true", help="use cached responses only")
    ap.add_argument("--accept-default-set-differences", action="store_true",
                    help="write the output even if pscomppars no longer carries the default parameter set's values")
    ap.add_argument("--verify-citations", action="store_true",
                    help="also compare citation author order with Crossref (network, cached)")
    ap.add_argument("--write-fixtures", action="store_true",
                    help="refresh tools/pipeline/fixtures/ from the cache after a successful build")
    args = ap.parse_args(argv)
    print("TRAPPIST-1: querying (or reading cache) ...")
    data = query_all(args.refresh, args.offline)
    row_issues = check_rows_agree(data["comp"])
    if row_issues:
        print("Stellar columns differ between planet rows; nothing written:", *row_issues, sep="\n    ")
        return 1
    out = build(data)
    # Every check runs on the in-memory result; the output and the doc are written only if all of them pass.
    rows, matches = cross_check(out, data)
    default_issues = default_set_check(data)
    phase_rows = phase_check(out, data)
    unexplained = [r for r in rows if r[3].startswith("UNEXPLAINED")]
    cite_issues, cite_checked = verify_citations(args.refresh, args.offline) if args.verify_citations else ([], 0)
    print(f"confirmed exoplanets: {out['exoplanetCount']['value']} as of {out['exoplanetCount']['asOf']}")
    print(f"cross-check: {matches} agree, {len(rows)} rows to review; corrections: {len(CORRECTIONS)}")
    for r in unexplained:
        print("  UNEXPLAINED:", " | ".join(r))
    if default_issues:
        print("  default-set differences:", *default_issues, sep="\n    ")
    for p in cite_issues:
        print("  CITATION:", p)
    blocked = bool(unexplained or cite_issues or (default_issues and not args.accept_default_set_differences))
    if blocked:
        print(f"Checks failed: {OUT.relative_to(ROOT)} and {DOC.relative_to(ROOT)} were not changed.")
        return 1
    write_atomic(OUT, json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    update_doc(out, rows, matches, default_issues, phase_rows)
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size:,} bytes)")
    if args.verify_citations:
        print(f"citations: author order of {cite_checked} DOIs matches Crossref")
    if args.write_fixtures:
        write_fixtures(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
