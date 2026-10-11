# TRAPPIST-1: data pipeline, inference rules and generated surfaces

This document covers milestone M4's data layer: how `public/data/systems/trappist-1.json` is built from the NASA
Exoplanet Archive, which values are measured, inferred or generated, the formulas and rules behind the last two, the
orbital-frame convention used by `src/world/exo/systemData.ts`, the cross-check against the hand-verified
`tools/exo/trappist1_verified.json`, and every citation the file uses.

**Live confirmed-exoplanet count recorded with this build: 6,445 (NASA Exoplanet Archive, `select count(*) from
pscomppars`, queried 2026-10-11 04:27 UTC).** The research pass of 2026-10-08 found the same figure on the archive's
home page.

## 1. Running the pipeline

```
cd tools && uv venv .venv --python 3.13 && VIRTUAL_ENV=.venv uv pip install numpy pytest   # once
tools/.venv/bin/python tools/pipeline/exoplanets.py             # cached responses, fetch what is missing
tools/.venv/bin/python tools/pipeline/exoplanets.py --refresh   # query every service again
tools/.venv/bin/python tools/pipeline/exoplanets.py --offline   # never touch the network
tools/.venv/bin/python tools/pipeline/exoplanets.py --verify-citations   # also check author order with Crossref
tools/.venv/bin/python tools/pipeline/exoplanets.py --write-fixtures     # refresh the committed test fixtures
tools/.venv/bin/python -m pytest tools/pipeline/test_exoplanets.py -q
```

The script uses only the Python standard library (pytest for its tests). Raw responses are cached under
`tools/.cache/exoarchive/` (git-ignored), each with a `.meta.json` holding the exact URL and UTC retrieval time.
`--refresh` and `--offline` cannot be combined.

**Nothing reaches the game unchecked.** Every check runs on the in-memory result before anything is written: the
cross-check against `trappist1_verified.json` (any difference without an explanation fails), the default-parameter-set
check (fails unless `--accept-default-set-differences` is given), a check that the stellar and system columns are
identical on all seven planet rows (the build reads them from the first), and with `--verify-citations` a comparison
of each citation's first three author surnames with Crossref. If any check fails, the script exits 1 and leaves
`public/data/systems/trappist-1.json` and this document unchanged; otherwise it writes both atomically (temporary file,
then rename). It also stops if the archive cites a reference that is not in its curated citation list. Either way a
person must look before new values reach the game. The game never calls these services at runtime.

**Test fixtures.** `tools/pipeline/fixtures/` holds the raw `pscomppars` response (45 KB) and every tenth transit of
the Agol et al. 2024 forecast plus each planet's first and last transit and the three JWST check transits (767 rows:
planet, transit number, BJD_TDB − 2,450,000 at full precision). `test_exoplanets.py` compares the measured values
with the archive response and the mean ephemeris with the forecast from the cache when present and from these fixtures
otherwise, so neither check skips on a fresh checkout. `--write-fixtures` regenerates them after a successful build.

| Cache file | Service and query |
|---|---|
| `pscomppars_trappist-1.json` | NASA Exoplanet Archive TAP, `pscomppars` (Planetary Systems Composite Parameters) where `hostname='TRAPPIST-1'`: values, `err1`/`err2` and `*_reflink` for each field used |
| `ps_default_trappist-1.json` | Same service, `ps` (Planetary Systems) where `default_flag=1`: each planet's default parameter set and its reference |
| `pscomppars_count.json` | `select count(*) as n from pscomppars` (one row per confirmed planet) |
| `gaia_dr3_trappist-1.csv` | ESA Gaia archive TAP, `gaiadr3.gaia_source` for source 2635476908753563008 (cross-check of the id, parallax and position) |
| `simbad_trappist-1_flux.csv` | CDS SIMBAD TAP, catalogued photometry of TRAPPIST-1 (cross-check of V, J, K) |
| `agol2024_arxiv_eprint.tar.gz` | arXiv source of Agol et al. 2024 (RNAAS 8, 274), read in memory for its forecast of every transit 2015-2027 (the "data behind the figure"); used for the mean ephemeris |

**Default parameter set.** For all seven planets the archive's default set (`ps`, `default_flag=1`) is Agol et al.
2021 (published 2021-02). `pscomppars` carries that set's period, semi-major axis, radius, mass and inclination
unchanged (checked by the script). Agol et al. 2021 give no transit midpoint or eccentricity in the archive's terms, so
`pscomppars` fills those from Ducrot et al. 2020 and Grimm et al. 2018 respectively.

## 2. Output schema

`public/data/systems/trappist-1.json` (about 80 KB):

```
{ id, name, retrieved: 'YYYY-MM-DD', source,
  exoplanetCount: { value, asOf, source, citation },
  star: { teffK, radiusSun, massSun, luminosityLogSun, luminositySun, ageGyr, metallicityFeH, spectralType,
          vMag, jMag, kMag, gaiaDr3Id },                                     // all Sourced, measured
  position: { raDeg, decDeg, distancePc },                                  // Sourced, measured
  orbitalPlane: { inclinationDeg /*inferred*/, nodeDeg /*generated*/ },
  planets: [{ id, name, letter, defaultParameterSet: { label, citation, published },
              measured:  { periodDays, semiMajorAxisAu, radiusEarth, massEarth, inclinationDeg, eccentricity,
                           transitMidBJD },
              inferred:  { equilibriumTempK_A0, equilibriumTempK_A030, insolationEarth, densityRelEarth,
                           surfaceGravityG, escapeVelocityKms, ephemerisPeriodDays, ephemerisTransitMidBJD,
                           tidallyLocked, composition, atmosphere },
              generated: { seed, terrain, albedo, palette, iceCoverage, nightSideGlow, rationale,
                           provenance: 'generated', source, citation } }],
  citations: { <key>: { authors, year, title, venue, doi?, url? } } }
```

Every `Sourced` is `{ value, uncertainty?, unit, provenance, source, citation, note? }`. `uncertainty` is one sigma in
the value's unit: a number when symmetric, or `[lower, upper]` magnitudes when the archive gives asymmetric errors
(value − lower … value + upper). `citation` is a key into `citations`, which lists exactly the keys the file uses, in
the same shape as `Citation` in `src/core/provenance.ts` (minus `key`). Planets are sorted by period.

Class codes: `composition` is `rocky` or `rocky-or-water-rich`; `atmosphere` is `thick-co2-disfavoured` or `unknown`;
`terrain` is `cratered`, `volcanic`, `icy` or `mixed`. Display labels live in `src/game/locales/en.exo.json`
(`exo.composition.*`, `exo.atmosphere.*`, `exo.terrain.*`); `systemData.ts` exports the key helpers.

`palette` holds five sRGB colours (reflectance under white light; the renderer applies the star's colour).
`volcanic` and `cratered` palettes are five rock tones, dark to light. `mixed` and `icy` palettes are two rock tones
(dark, light) then three ice tones (dark to light).

## 3. Where each value comes from

| JSON field | Archive column | Reference (citation key) |
|---|---|---|
| `star.teffK`, `radiusSun`, `massSun`, `luminosityLogSun` | `st_teff`, `st_rad`, `st_mass`, `st_lum` | Agol et al. 2021 (`agol2021`); the mass is Agol's adoption of the Mann et al. 2019 relation |
| `star.luminositySun` | `10^st_lum` | `agol2021` (unit conversion, still measured) |
| `star.ageGyr`, `metallicityFeH`, `spectralType` | `st_age`, `st_met`, `st_spectype` | Piaulet-Ghorayeb et al. 2025 (`piaulet-ghorayeb2025`); the age equals Burgasser & Mamajek 2017 |
| `star.vMag` | not used (`sy_vmag`) | Costa et al. 2006 via SIMBAD (`costa2006`); see correction 1 |
| `star.jMag`, `kMag` | `sy_jmag`, `sy_kmag` | TICv8 (`stassun2019`); identical to 2MASS in SIMBAD |
| `star.gaiaDr3Id` | `gaia_dr3_id` | `gaia-dr3`; confirmed in the Gaia DR3 archive |
| `position.raDeg`, `decDeg` | `ra`, `dec` | TICv8 (`stassun2019`); epoch J2015.5, see section 4 |
| `position.distancePc` | `sy_dist` | Gaia DR2 (`gaia-dr2`); see section 4 |
| `planets[].measured.periodDays`, `semiMajorAxisAu`, `radiusEarth`, `massEarth`, `inclinationDeg` | `pl_orbper`, `pl_orbsmax`, `pl_rade`, `pl_masse`, `pl_orbincl` | `agol2021` |
| `planets[].measured.eccentricity` | `pl_orbeccen` | Grimm et al. 2018 (`grimm2018`) |
| `planets[].measured.transitMidBJD` | `pl_tranmid` (BJD_TDB) | Ducrot et al. 2020 (`ducrot2020`) |

## 4. Decisions and corrections

1. **V magnitude: direct photometry, not the archive.** The archive's `sy_vmag` (17.02 ± 0.20) comes from TICv8,
   whose source flag for it is `cdwrf` (the TIC cool-dwarf list). Direct CCD photometry gives V = 18.798 ± 0.082
   (Costa et al. 2006, as catalogued by SIMBAD), 1.8 mag fainter. We use the direct measurement and quote the archive
   value in the note. The script stops if SIMBAD's V source changes.
2. **TRAPPIST-1 e semi-major-axis uncertainty.** The archive lists ±0.0025 au, ten times Agol et al. 2021's published
   (2.925 ± 0.025) × 10⁻² au; every other planet matches the paper. We use ±0.00025 au and say so in the note.
3. **Distance: archive (Gaia DR2) kept.** The archive still uses the Gaia DR2 parallax (80.451 ± 0.121 mas,
   12.430 ± 0.019 pc). Gaia DR3 (queried directly) gives 80.212 ± 0.072 mas (12.467 pc), a 0.3% difference at
   1.7 sigma combined. The note quotes DR3. Switching to DR3 is a one-line change if the integrator prefers it.
4. **Position epoch.** The archive's RA/Dec (346.6263919, −5.0434618) are TICv8's original-epoch coordinates, which
   are Gaia DR2 positions at **J2015.5**, not J2000. They match Gaia DR3's J2016.0 position after 0.5 yr of proper
   motion (about 1.03 arcsec/yr). The J2000 position is about 15 arcsec away. The note says this; at 12 pc the offset
   is 190 au, invisible in the star field but worth knowing if TRAPPIST-1 is ever matched against an epoch-2000
   catalogue.
5. **Orbital phase: a mean ephemeris, not the archive's period and epoch.** `pscomppars` pairs Agol et al. 2021's
   period with Ducrot et al. 2020's transit midpoint. Agol's periods are *osculating* Jacobi elements at the start of
   their N-body integration (their table caption says so), not long-term mean periods. Used as a straight-line
   ephemeris, that pair misses the transits Agol et al. 2024 forecast for October 2026 by 3 to 27 hours, up to 52° of
   orbital phase (phase check in section 8). We keep both archive values as measured, with notes, and add an inferred
   mean ephemeris per planet: a least-squares line through every transit time in the Agol et al. 2024 forecast
   (2015-08-24 to 2027-07-31 overall; each planet's own span, for example 2015-08-31 to 2027-07-25 for f, is in its
   `ephemerisPeriodDays` source), referenced to the transit nearest 2026-01-01. It follows the forecast to within
   17-107 minutes (the transit-timing variations a line cannot follow), at most 1.4-4.6° of orbital phase.
   `orbitalPosition` uses it. This departs from the original spec (phase from the archive's period and transit
   midpoint) on purpose; the reviewer of this module agreed it is the scientifically correct choice, and it should be
   recorded as an accepted decision. The forecast CSV has no column labels; the pipeline uses only the planet, transit
   number and time columns, and checks that the time column reproduces three JWST-measured transits listed in the
   paper (two of h, one of c).
6. **Eccentricity** is Grimm et al. 2018's (the default set gives none). All are below 0.011; orbits are drawn as
   circles.

## 5. Inferred values

All inferred values use archive inputs; uncertainties are first-order propagation of independent one-sigma errors
(the larger side of an asymmetric error). That overestimates the spread where inputs are correlated (mass and radius
share the stellar-mass uncertainty).

| Field | Formula and assumptions | Source |
|---|---|---|
| `equilibriumTempK_A0`, `_A030` | Teq = Teff √(R*/(2a)) (1 − A)^¼ with Bond albedo A = 0 and 0.3; full day-night heat redistribution, emissivity 1, no greenhouse effect. R☉ = 695,700 km (IAU 2015 B3), au = 149,597,870.7 km (IAU 2012 B2). A = 0 reproduces the archive's Ducrot et al. 2020 values within 0.3 K. For b and c the notes add JWST's measured dayside brightness temperatures (490 ± 17 K, Gillon et al. 2026; 380 ± 31 K, Zieba et al. 2023). | `agol2021` |
| `insolationEarth` | S = L / a² in Earth units (1 L☉ at 1 au). Matches Agol et al. 2021's table to its rounding (within 0.3%). | `agol2021` |
| `densityRelEarth` | M / R³ (Earth = 5.513 g/cm³) | `agol2021` |
| `surfaceGravityG` | M / R² | `agol2021` |
| `escapeVelocityKms` | 11.186 km/s × √(M/R) (Earth's value from the NASA Earth Fact Sheet) | `agol2021` |
| `ephemerisPeriodDays`, `ephemerisTransitMidBJD` | Least-squares line t = T₀ + P (n − n₀) through all forecast transits of Agol et al. 2024 (an N-body fit to ground, Spitzer, K2, HST and JWST transit times), n₀ = the transit nearest 2026-01-01. Period uncertainty: formal fit error; epoch uncertainty: rms of the residuals (7-45 min). | `agol2024` |
| `tidallyLocked` | `true`, shown as "Likely, not observed". Turbet et al. 2018 find from N-body and tidal modelling that each planet is likely in synchronous rotation. The note adds an order-of-magnitude despinning time (Gladman et al. 1996, t = ω a⁶ I Q / (3 G M*² k₂ R⁵) with I = 0.4 M R², Q = 100, k₂ = 0.3, initial 12 h spin): about 60 years for b up to about 1 million years for h, all far shorter than the 7.6 Gyr age. Caveat in every note: Vinson, Tamayo & Hansen 2019 show that mutual tugs in the resonant chain can push d, e and f into effectively non-synchronous spin states (libration, or circulation of the substellar point); they did not model the other planets. Not observed directly. | `turbet2018` (caveat `vinson2019`) |
| `composition` | From density: Agol et al. 2021 find all seven consistent with one rocky composition slightly poorer in iron than Earth (core-mass fraction 21 ± 4 wt% if water-free), or Earth-like rock plus water, or iron-free oxidised rock. b, c, d (`rocky`) lie beyond the runaway-greenhouse limit, where water cannot stay condensed; e–h (`rocky-or-water-rich`) would hold 2.9–6.4 wt% water if their rock were Earth-like. Per-planet core-mass fractions and water fractions in the notes are quoted from Agol's interior table. | `agol2021` |
| `atmosphere` | See below | per planet |

Atmosphere (conservative, one claim per published result; every result below was checked against its abstract):

| Planet | Value | Citation | Note (summary) |
|---|---|---|---|
| b | `thick-co2-disfavoured` | `greene2023` | 15 µm eclipses: little or no atmosphere, no CO₂ absorption. Ducrot et al. 2025: airless fresh rock fits, but so does a hazy CO₂ atmosphere. Gillon et al. 2026 phase curves: atmospheres with surface pressures ≥ 1 bar and efficient greenhouse effects strongly disfavoured. |
| c | `thick-co2-disfavoured` | `zieba2023` | Dayside 380 ± 31 K disfavours a thick CO₂-rich atmosphere; thin or none possible. Gillon et al. 2026: ≥ 1 bar with efficient greenhouse effects strongly disfavoured; a tenuous, greenhouse-poor O₂-dominated atmosphere is still allowed. |

The display label for `thick-co2-disfavoured` is "Thick CO₂ atmosphere disfavoured", hedged like the code: none of
these results rules a thick atmosphere out outright.
| d | `unknown` | `piaulet-ghorayeb2025` | Flat JWST spectrum rules out clear H₂-rich and many thicker atmospheres; very thin, hazy, or none possible. |
| e | `unknown` | `espinoza2025` | Cloudy H₂-dominated atmospheres ruled out; no strong evidence for or against a secondary atmosphere (Glidden et al. 2025). |
| f | `unknown` | `dewit2018` | HST ruled out a cloud-free H₂-dominated atmosphere; denser ones unconstrained. |
| g | `unknown` | `dewit2018` | HST could not exclude even a cloud-free H₂-dominated atmosphere. |
| h | `unknown` | `garcia2022` | HST: an aerosol-free H/He atmosphere is unlikely; flat spectrum fits a heavy atmosphere, a haze, or none. |

**Orbital plane.** `inclinationDeg` = mean of the seven transit inclinations (89.783 ± 0.058°, the sample standard
deviation), provenance `inferred`, because Known Sky draws one shared plane. Transits cannot tell i from 180° − i; we
take i < 90°.

## 6. Generated surfaces (rules)

`generate_surface()` in the pipeline. Same inputs give the same outputs; the seed (`hashString(planet.id)` from
`src/core/rng.ts`, ported bit-for-bit to Python and tested) only jitters the palette and seeds terrain noise.

1. **Ice.** If insolation S > 1.0 S⊕ (Agol et al. 2021 place b, c and d beyond the runaway-greenhouse limit), no
   surface ice. Otherwise ice cover = (273.15 K − Teq(A = 0.3)) / (273.15 K − 150 K), clamped to 0–1: any water would
   be frozen, more so farther out. How much water each planet has is unknown, which the rationale says.
2. **Terrain.** Ice ≥ 0.5 → `icy`; 0.05 < ice < 0.5 → `mixed`; otherwise `volcanic` if there is evidence of
   resurfacing (b: one of the two scenarios fitting JWST's eclipses is fresh, unweathered ultramafic rock, Ducrot et
   al. 2025, and phase curves favour an airless low-albedo surface, Gillon et al. 2026), else old `cratered` rock.
3. **Albedo.** Rock 0.05 (volcanic), 0.12 (cratered), 0.18 for c (Gillon et al. 2026 allow an airless c with a more
   reflective surface); ice 0.45 (dirty ice). Bond albedo = rock × (1 − ice) + 0.45 × ice.
4. **Tholins (design choice).** Turbet et al. 2018 suggest photochemical hazes could settle on TRAPPIST-1 planets and
   build up a surface layer of tholins; they do not limit this to the coldest planets or give it a colour. As a design
   choice we tint the bare ground reddish-brown only on icy planets with S < 0.3 S⊕ (g, h).
5. **Night-side glow.** `volcanic` terrain only, 0.06: a faint stand-in for possible tidally driven volcanism, kept
   faint because JWST detected no night-side emission from b (Gillon et al. 2026).
6. **No atmosphere is generated** for any planet: none is supported by the evidence.

| Planet | S (S⊕) | Teq A=0.3 (K) | Terrain | Ice | Albedo | Glow |
|---|---|---|---|---|---|---|
| b | 4.153 | 363.7 | volcanic | 0 | 0.05 | 0.06 |
| c | 2.215 | 310.9 | cratered | 0 | 0.18 | 0 |
| d | 1.115 | 261.8 | cratered | 0 | 0.12 | 0 |
| e | 0.646 | 228.5 | mixed | 0.36 | 0.24 | 0 |
| f | 0.373 | 199.2 | icy | 0.60 | 0.32 | 0 |
| g | 0.252 | 180.6 | icy (tholins) | 0.75 | 0.37 | 0 |
| h | 0.144 | 157.1 | icy (tholins) | 0.94 | 0.43 | 0 |

The demo page `exo.html` renders an artist's-impression preview from these parameters, labelled Generated. It places
ice away from the substellar point, assuming synchronous rotation; the rationale of every icy planet says this is
likely but not certain (see `tidallyLocked`). The preview renders in short slices (about 8 ms each) and is cached
per planet, so selecting a planet never blocks the page.

**Provenance on the demo page.** Marks differ in shape as well as colour: a filled disc (measured), a half-filled
dashed ring (inferred), a dotted ring (generated). Table columns sit under a Measured / Inferred / Generated group
header (badge with mark and text; solid, dashed or dotted rule) and each cell's `headers` attribute points at it.
Every value row carries its tier as visually hidden text, so its accessible name is "label value tier", and the
"How do we know this?" panel is a polite live region. `tests/e2e/exo.spec.ts` checks all of this.

## 7. Orbital frame and `orbitalPosition`

`src/world/exo/systemData.ts`:

- `loadSystem(id)` fetches `systems/<id>.json` through `fetchJson` and runs `validateSystem`, which checks every value
  for provenance, source and a citation that resolves (including the planet count's and each default parameter set's),
  and that each block holds only its own tier. It also checks what the helpers rely on: planet ids are unique and
  equal `<system id><letter>`; planets are sorted by strictly increasing catalogued and mean period; periods,
  semi-major axes, radii, masses, the distance and the stellar temperature, radius, mass and luminosity are positive;
  the planet count is a positive integer with a date. It throws on any problem.
- `equilibriumTemp(teffK, starRadiusSun, aAu, albedo)` and `insolation(lumSun, aAu)` are the formulas above.
- `orbitalPosition(planet, tdbSecondsSinceJ2000, out?)` returns metres in the **system orbital frame**: origin at the
  star; **+x** points toward the Solar System (the line of sight projected onto the orbital plane), so a planet is on
  +x at transit; **+z** is the orbital angular momentum; **+y** = z × x is the direction of motion at transit. The
  orbit is a circle of radius a; the phase is 2π (t − T₀)/P from the mean ephemeris (`inferred.ephemerisPeriodDays`,
  `ephemerisTransitMidBJD`), so a quarter period after transit the planet is on +y.
- **Time convention.** `t` is the TDB instant at which an observer at the Solar System barycentre sees the
  configuration, the convention of BJD_TDB epochs. Light from TRAPPIST-1 takes about 40.5 years to reach us
  (`lightTimeSeconds(system)`); to place planets at the instant their light leaves, add that to `t`. Which convention
  the game uses is a design choice for the integrator.
- **Phase accuracy.** Through mid-2027 the mean ephemeris stays within 17-107 minutes of the published forecast
  (at most 1.4-4.6° of orbital phase, depending on the planet). After the forecast ends the error grows slowly with the transit-timing variations;
  rerun the pipeline when a newer forecast is published.
- `orbitalFrameToIcrs(system)` gives the frame's unit vectors in ICRS (the game's world axes). With ô the unit vector
  from the star to the Sun, Ω = `nodeDeg` and i = `inclinationDeg`: ŷ = cos Ω N̂ + sin Ω Ê (the ascending node,
  where the planet recedes from us), ŵ = ô × ŷ, ẑ = cos i ô + sin i ŵ, x̂ = sin i ô − cos i ŵ.
- **`nodeDeg` is generated.** Transits constrain the inclination only; how the system is turned about our line of
  sight is unknown. We fix Ω = 0° (node due north). Any other value rotates the system about the line of sight and
  changes nothing seen from Earth.

## 8. Cross-check against `tools/exo/trappist1_verified.json`

The verified file (Agol et al. 2021 and other sources, checked by web search on 2026-10-10 when the archive was
unreachable) is compared field by field with the archive values. Items it marked UNVERIFIED that this build settles:

- **Gaia DR3 source id 2635476908753563008** and **parallax 80.2123 ± 0.0716 mas**: confirmed in the Gaia DR3 archive
  (`gaiadr3.gaia_source`), together with the proper motion (930.788, −479.038) mas/yr.
- **Insolation of c, f, g, h** (2.214, 0.373, 0.252, 0.144): the archive lists exactly these with Agol et al. 2021 as
  reference, with errors.
- **Inclination of f** (89.740 ± 0.019°) is Agol et al. 2021's (archive reference link).
- **Radius error of e** (+0.013/−0.012): confirmed by the archive.
- **c's t0 digits:** Agol et al. 2021's table (arXiv source) gives 7258.58728; the verified file's extra digit
  (2457258.587287) came from a search snippet.
- **Exoplanet count** 6,445: unchanged on 2026-10-11.

<!-- crosscheck:begin -->
_Generated by `tools/pipeline/exoplanets.py` from the archive query of 2026-10-11. Do not edit by hand._

**54 values agree** with `tools/exo/trappist1_verified.json` to the precision quoted. **18 rows** below differ or need a comment.

| Field | NASA Exoplanet Archive | trappist1_verified.json | Explanation |
|---|---|---|---|
| star.parallax | 80.4512 +/- 0.1211 (Gaia DR2) | 80.2123 +/- 0.0716 | Archive uses Gaia DR2 for this star; the verified file has Gaia (E)DR3, now confirmed in the Gaia DR3 archive. We keep the archive distance and quote DR3 in the note (0.3% difference). |
| star.distance | 12.4299 +/- 0.0187 | 12.47 +/- 0.01 | Follows from the parallax difference above. |
| star.pm_ra | 901.0 +/- 8.0 | 930.788 | Archive uses TICv8 proper motion (SuperBlink, +/-8 mas/yr); the verified value is Gaia DR3 (confirmed in the Gaia archive). Not used in the output. |
| star.pm_dec | -492.0 +/- 8.0 | -479.038 | As for pm_ra. |
| star.v_mag | 17.02 +/- 0.2 | 18.798 +/- 0.082 | Archive V comes from TICv8; the verified value is direct photometry (Costa et al. 2006). We use the direct photometry (see Corrections). |
| star.ra | 346.6263919 deg (J2015.5) | 23h06m29.368s = 346.6223667 deg | Different epochs: the archive position is at J2015.5 (TICv8), the verified file at J2000. Proper motion explains the offset. Offset +14.4 arcsec. |
| star.dec | -5.0434618 deg (J2015.5) | -05d02m29.04s = -5.0414000 deg | Different epochs, as for RA. Offset -7.4 arcsec. |
| star.spectral_type | M8.0 V | M8V | Same class written differently (M8.0 V vs M8V). |
| planets.b.semi_major_axis_au | 0.01154 +/- 0.0001 | 0.01154 | Verified file had no uncertainty for b; the archive's +/-0.0001 au matches the paper. |
| planets.b.t0_bjd_tdb | 2457322.514193 (Ducrot et al. 2020) | 2457257.55044 (Agol et al. 2021) | Different reference transits (43 orbits apart). Agol's t0 and P are osculating N-body elements, not a linear ephemeris; carried forward with the archive period they differ by -2.5 min. See the phase check below. |
| planets.c.t0_bjd_tdb | 2457282.8113871 (Ducrot et al. 2020) | 2457258.587287 (Agol et al. 2021) | Different reference transits (10 orbits apart). Agol's t0 and P are osculating N-body elements, not a linear ephemeris; carried forward with the archive period they differ by +6.8 min. See the phase check below. |
| planets.d.t0_bjd_tdb | 2457670.1463014 (Ducrot et al. 2020) | 2457257.06768 (Agol et al. 2021) | Different reference transits (102 orbits apart). Agol's t0 and P are osculating N-body elements, not a linear ephemeris; carried forward with the archive period they differ by +83.9 min. See the phase check below. |
| planets.e.semi_major_axis_au | 0.02925 +/- 0.0025 | 0.02925 +/- 0.00025 | Archive uncertainty is ten times the published one (transcription). We use the published value (see Corrections). |
| planets.e.t0_bjd_tdb | 2457660.3676621 (Ducrot et al. 2020) | 2457257.82771 (Agol et al. 2021) | Different reference transits (66 orbits apart). Agol's t0 and P are osculating N-body elements, not a linear ephemeris; carried forward with the archive period they differ by -182.7 min. See the phase check below. |
| planets.f.t0_bjd_tdb | 2457671.3737299 (Ducrot et al. 2020) | 2457257.07426 (Agol et al. 2021) | Different reference transits (45 orbits apart). Agol's t0 and P are osculating N-body elements, not a linear ephemeris; carried forward with the archive period they differ by -57.4 min. See the phase check below. |
| planets.g.t0_bjd_tdb | 2457665.3628439 (Ducrot et al. 2020) | 2457257.71462 (Agol et al. 2021) | Different reference transits (33 orbits apart). Agol's t0 and P are osculating N-body elements, not a linear ephemeris; carried forward with the archive period they differ by +25.2 min. See the phase check below. |
| planets.h.t0_bjd_tdb | 2457662.5741486 (Ducrot et al. 2020) | 2457249.60676 (Agol et al. 2021) | Different reference transits (22 orbits apart). Agol's t0 and P are osculating N-body elements, not a linear ephemeris; carried forward with the archive period they differ by -51.4 min. See the phase check below. |
| exoplanet_count | 6445 (as of 2026-10-11) | 6445 (as of 2026-10-08) | Same count. |

**Orbital phase check** against the transit forecast of Agol et al. 2024 nearest 2026-10-11 (BJD_TDB). "Archive P, T0": the archive's period and transit midpoint used as a linear ephemeris. "Mean ephemeris": `inferred.ephemerisPeriodDays` and `ephemerisTransitMidBJD`, which `orbitalPosition` uses. "TTV": the largest and rms gap between the mean ephemeris and the forecast over 2015-2027 (transit-timing variations a straight line cannot follow).

| Planet | Forecast transit | Archive P, T0 | Mean ephemeris | TTV |
|---|---|---|---|---|
| b | 2461324.81751 | -3.0 h (-30 deg) | +14 min (+2.3 deg) | 23 min (8 min rms) |
| c | 2461324.81324 | +5.1 h (+31 deg) | -11 min (-1.1 deg) | 17 min (7 min rms) |
| d | 2461322.81803 | -6.6 h (-25 deg) | -32 min (-1.9 deg) | 74 min (32 min rms) |
| e | 2461326.19532 | +21.1 h (+52 deg) | -4 min (-0.2 deg) | 63 min (28 min rms) |
| f | 2461326.52201 | +5.9 h (+10 deg) | -31 min (-0.8 deg) | 80 min (32 min rms) |
| g | 2461321.94528 | -6.2 h (-8 deg) | +43 min (+0.9 deg) | 75 min (31 min rms) |
| h | 2461322.15507 | +27.1 h (+22 deg) | -50 min (-0.7 deg) | 107 min (45 min rms) |

**Corrections applied to archive values in the output:**

| Field | Archive | Used | Reason |
|---|---|---|---|
| planets.e.measured.semiMajorAxisAu.uncertainty | 0.0025 | 0.00025 | Archive transcription: Agol et al. 2021 give a = (2.925 +/- 0.025) x 10^-2 au; every other planet's archive error matches the paper. |
| star.vMag | 17.02 +/- 0.2 (TICv8) | 18.798 +/- 0.082 | The archive's TICv8 V magnitude (TIC source flag 'cdwrf', the TIC cool-dwarf list) is 1.8 mag brighter than direct CCD photometry (Costa et al. 2006, via SIMBAD). We use the direct measurement. |

**Composite vs default parameter set:** pscomppars carries the default set's period, semi-major axis, radius, mass and inclination for all seven planets.
<!-- crosscheck:end -->

## 9. Citations

Every key used in `trappist-1.json` (the file's `citations` object has the same entries, ready to merge into
`public/data/citations.json`). Each was checked on 2026-10-11 against Crossref (DOIs), DataCite (archive table DOI)
or the arXiv API (titles, authors and abstracts); `exoplanets.py --verify-citations` re-checks the first three author
surnames of all 20 Crossref-registered DOIs (it caught and now guards the corrected author order of `espinoza2025`
and `glidden2025`). `known-sky-exo-rules` points to this document for generated values.

| Key | Reference | DOI / URL | Used for |
|---|---|---|---|
| `nasa-exoplanet-archive` | NASA Exoplanet Science Institute (2020). Planetary Systems Composite Table. NASA Exoplanet Archive, IPAC/Caltech. | doi:10.26133/NEA13, https://exoplanetarchive.ipac.caltech.edu/ | live planet count |
| `agol2021` | Agol, E., Dorn, C., Grimm, S. L. et al. (2021). Refining the Transit-timing and Photometric Analysis of TRAPPIST-1: Masses, Radii, Densities, Dynamics, and Ephemerides. The Planetary Science Journal 2, 1. | doi:10.3847/PSJ/abd022 (arXiv:2010.01074) | default parameter set; star; inferred values |
| `agol2024` | Agol, E. et al. (2024). Updated Forecast for TRAPPIST-1 Times of Transit for All Seven Exoplanets Incorporating JWST Data. Research Notes of the AAS 8, 274. | doi:10.3847/2515-5172/ad8b46 (arXiv:2409.11620) | mean ephemeris |
| `grimm2018` | Grimm, S. L., Demory, B.-O., Gillon, M. et al. (2018). The nature of the TRAPPIST-1 exoplanets. Astronomy & Astrophysics 613, A68. | doi:10.1051/0004-6361/201732233 | eccentricities |
| `ducrot2020` | Ducrot, E., Gillon, M., Delrez, L. et al. (2020). TRAPPIST-1: Global results of the Spitzer Exploration Science Program Red Worlds. Astronomy & Astrophysics 640, A112. | doi:10.1051/0004-6361/201937392 | transit midpoints |
| `stassun2019` | Stassun, K. G., Oelkers, R. J., Paegert, M. et al. (2019). The Revised TESS Input Catalog and Candidate Target List. The Astronomical Journal 158, 138. | doi:10.3847/1538-3881/ab3467 | RA/Dec, J and K |
| `gaia-dr2` | Gaia Collaboration, Brown, A. G. A. et al. (2018). Gaia Data Release 2. Summary of the contents and survey properties. Astronomy & Astrophysics 616, A1. | doi:10.1051/0004-6361/201833051 | distance |
| `gaia-dr3` | Gaia Collaboration, Vallenari, A. et al. (2023). Gaia Data Release 3. Summary of the content and survey properties. Astronomy & Astrophysics 674, A1. | doi:10.1051/0004-6361/202243940 | Gaia DR3 id; parallax cross-check |
| `piaulet-ghorayeb2025` | Piaulet-Ghorayeb, C., Benneke, B., Turbet, M. et al. (2025). Strict Limits on Potential Secondary Atmospheres on the Temperate Rocky Exo-Earth TRAPPIST-1 d. The Astrophysical Journal 989, 181. | doi:10.3847/1538-4357/adf207 (arXiv:2508.08416) | age, [Fe/H], spectral type; d's atmosphere |
| `costa2006` | Costa, E., Méndez, R. A., Jao, W.-C., Henry, T. J., Subasavage, J. P. & Ianna, P. A. (2006). The Solar Neighborhood. XVI. Parallaxes from CTIOPI: Final Results from the 1.5 m Telescope Program. The Astronomical Journal 132, 1234-1247. | doi:10.1086/505706 | V magnitude |
| `turbet2018` | Turbet, M., Bolmont, E., Leconte, J. et al. (2018). Modeling climate diversity, tidal dynamics and the fate of volatiles on TRAPPIST-1 planets. Astronomy & Astrophysics 612, A86. | doi:10.1051/0004-6361/201731620 | tidal locking; tholins rule (inspiration) |
| `gladman1996` | Gladman, B., Quinn, D. D., Nicholson, P. & Rand, R. (1996). Synchronous Locking of Tidally Evolving Satellites. Icarus 122, 166-192. | doi:10.1006/icar.1996.0117 | despinning time (note) |
| `vinson2019` | Vinson, A. M., Tamayo, D. & Hansen, B. M. S. (2019). The chaotic nature of TRAPPIST-1 planetary spin states. Monthly Notices of the Royal Astronomical Society 488, 5739-5747. | doi:10.1093/mnras/stz2113 (arXiv:1905.11419) | tidal-locking caveat (note) |
| `greene2023` | Greene, T. P., Bell, T. J., Ducrot, E. et al. (2023). Thermal emission from the Earth-sized exoplanet TRAPPIST-1 b using JWST. Nature 618, 39-42. | doi:10.1038/s41586-023-05951-7 | b's atmosphere |
| `zieba2023` | Zieba, S., Kreidberg, L., Ducrot, E. et al. (2023). No thick carbon dioxide atmosphere on the rocky exoplanet TRAPPIST-1 c. Nature 620, 746-749. | doi:10.1038/s41586-023-06232-z | c's atmosphere |
| `ducrot2025` | Ducrot, E., Lagage, P.-O., Min, M. et al. (2025). Combined analysis of the 12.8 and 15 µm JWST/MIRI eclipse observations of TRAPPIST-1 b. Nature Astronomy 9, 358-369 (online December 2024). | doi:10.1038/s41550-024-02428-z | b's notes; volcanic rule |
| `gillon2026` | Gillon, M., Ducrot, E., Bell, T. J. et al. (2026). No thick atmosphere around TRAPPIST-1 b and c from JWST thermal phase curves. Nature Astronomy 10, 674-694. | doi:10.1038/s41550-026-02806-9 (arXiv:2509.02128) | b and c notes; albedo and glow rules |
| `espinoza2025` | Espinoza, N., Allen, N. H., Glidden, A. et al. (2025). JWST-TST DREAMS: NIRSpec/PRISM Transmission Spectroscopy of the Habitable Zone Planet TRAPPIST-1 e. The Astrophysical Journal Letters 990, L52. | doi:10.3847/2041-8213/adf42e | e's atmosphere |
| `glidden2025` | Glidden, A., Ranjan, S., Seager, S. et al. (2025). JWST-TST DREAMS: Secondary Atmosphere Constraints for the Habitable Zone Planet TRAPPIST-1 e. The Astrophysical Journal Letters 990, L53. | doi:10.3847/2041-8213/adf62e | e's note |
| `dewit2018` | de Wit, J., Wakeford, H. R., Lewis, N. K. et al. (2018). Atmospheric reconnaissance of the habitable-zone Earth-sized planets orbiting TRAPPIST-1. Nature Astronomy 2, 214-219. | doi:10.1038/s41550-017-0374-z | f and g atmospheres |
| `garcia2022` | Garcia, L. J., Moran, S. E., Rackham, B. V. et al. (2022). HST/WFC3 transmission spectroscopy of the cold rocky planet TRAPPIST-1h. Astronomy & Astrophysics 665, A19. | doi:10.1051/0004-6361/202142603 | h's atmosphere |
| `known-sky-exo-rules` | Known Sky contributors (2026). TRAPPIST-1 data pipeline: inference formulas and surface-generation rules. | docs/EXO_TRAPPIST1.md | `nodeDeg`; generated surfaces |

Also referred to in text (not used as citation keys in the data): Mann et al. 2019, ApJ 871, 63,
doi:10.3847/1538-4357/aaf3bc (stellar mass relation); Burgasser & Mamajek 2017, ApJ 845, 110,
doi:10.3847/1538-4357/aa7fea (age); NASA Earth Fact Sheet, https://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html
(escape velocity 11.186 km/s, mean density 5,513 kg/m³); NASA Exoplanet Archive Planetary Systems table,
doi:10.26133/NEA12.

## 10. Notes for the integrator

- Add `exo: resolve(import.meta.dirname, 'exo.html')` to `build.rollupOptions.input` in `vite.config.ts` so the
  data lab ships in production builds (the dev server already serves it).
- Merge `citations` from `public/data/systems/trappist-1.json` into `public/data/citations.json` when that file is
  created. `known-sky-exo-rules` has a repository-relative `url`; give it an absolute link once the repository URL is
  fixed.
- Add a `DATA_MANIFEST.md` row: NASA Exoplanet Archive (`pscomppars`, `ps`), queried 2026-10-11 by
  `tools/pipeline/exoplanets.py`, derived file `public/data/systems/trappist-1.json`. The archive asks users to cite
  its table DOIs (10.26133/NEA13, 10.26133/NEA12) and to acknowledge the NASA Exoplanet Archive.
- Record in `docs/DECISIONS.md` that orbit phases use the inferred mean ephemeris fitted to Agol et al. 2024, not the
  archive's period and transit midpoint (section 4, item 5), and decide the time convention (section 7).
- **Localisation.** The English prose stored in the data file (`source`, `note`, `rationale`, citation titles) is
  shown as is. Before the game is translated, these need translation keys (for example per field and planet, with the
  numbers as parameters) or a per-locale copy of the system file; the UI labels and number formats already go through
  `t()` and `Intl`.
