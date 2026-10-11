# Known Sky: Codex Sources and Verification

This document explains where every fact in the Codex comes from, how each citation was checked, and what could not be verified. It covers `public/data/codex/en.json` (53 entries, 414 facts, 236 "how we know" claims) and the citation registry `public/data/citations.json` (198 keys, 182 of them cited by the Codex; the others are used by other data files or kept for reference). All checks were made on **2026-10-11**; every citation records `"accessed": "2026-10-11"`.

There was no human science reviewer. The rules below are what replace one: every Measured claim must trace to a fetched, verified source, numbers are copied from the source rather than from memory, and anything uncertain says so in the text.

## How the citations were verified

- **Sources with a DOI (118 keys).** Each DOI was resolved through the Crossref API (DataCite for the dataset DOIs: ETOPO 2022 and the NASA Exoplanet Archive tables). The title, author list, year, journal, volume and pages in `citations.json` are copied from that record, not typed from memory. This check caught two DOIs drafted from memory that pointed elsewhere (Mann et al. 2019 is ApJ 871, 63; DOI 10.1051/0004-6361/201629201 is the Kervella et al. 2016 conjunctions paper, so the Alpha Centauri radii paper is cited separately as `kervella2017radii`). In a second pass all 118 DOIs were resolved again and compared with the registry; titles, first authors and years all match (apart from typographic apostrophes and hyphens).
- **Claims taken from papers.** Every number or statement attributed to a paper was checked against its abstract, read from Crossref/OpenAlex, the arXiv abstract page or the publisher's landing page. Three statements needed the full text and were checked in the PDF: the Rayleigh coefficients and scale heights in Bruneton & Neyret 2008 (Section 2), the magnitude definitions in the IAU 2015 Resolution B2 text (Mamajek et al. 2015), and the ~80-year orbit of Alpha Centauri AB (Kervella et al. 2016). The second pass re-read the abstracts behind every sentence that states a model-dependent result (Enceladus's ocean and phosphates, Titan's lakes and channels, Mercury's polar ice, Io's tidal heating, the TRAPPIST-1 c eclipse, the TRAPPIST-1 resonant chain, the warp-drive energy limits) and rewrote the prose to match the source's own wording and the claim's tier.
- **Web pages and datasets without a DOI (80 keys: NASA, ESA, JPL, NAIF, NOAA, USGS, IAU, HYG and the Known Sky self-references).** Each page was fetched and the quoted value or sentence was found in the page text. NASA fact-sheet citations record the page's own "Last Updated" date in `note`, and `year` holds that update year. Where a page blocked automated access, the note says how the text was read instead (for example `nasa-pia19658`, read through the NASA Image and Video Library API).
- **Live data queries (all 2026-10-11 UTC):**
  - NASA Exoplanet Archive TAP, `select count(*) from pscomppars`, at 03:02:51 UTC: **6,445** confirmed planets. By discovery method: transit 4,781, radial velocity 1,203, microlensing 292, imaging 97, transit-timing variations 29, eclipse timing 17, orbital brightness modulation 9, pulsar timing 8, astrometry 6, pulsation timing 2, disk kinematics 1. By facility: Kepler 2,787, K2 550, TESS 1,008. The same day the archive was queried for the TRAPPIST-1, Proxima Cen, Barnard's star, 51 Peg and HD 209458 planets.
  - Gaia ESA Archive TAP (`gaiadr3.gaia_source`): parallax, proper motion and radial velocity for Proxima Centauri (source 5853498713190525696), Barnard's Star (4472832130942575872) and TRAPPIST-1 (2635476908753563008). This confirms the TRAPPIST-1 parallax 80.2123 ± 0.0716 mas and its Gaia source ID, which earlier notes had marked as unverified.
  - VizieR TAP, Hipparcos new reduction (`I/311/hip2`): parallaxes of Sirius, Vega, Betelgeuse, Polaris, Alpha Centauri A and B, Proxima and Barnard's Star.
- **Verified means fetched and checked.** `"verified": true` means the record was retrieved from the publisher, registry or site on the access date and the bibliographic details match. It does not mean the paper's conclusions are certain; the Codex text and the fact provenance carry that uncertainty.

## Provenance rules used in the Codex

- **Measured:** a value as published by an observational source (a mission, a catalogue, a fact sheet or a paper), with its stated uncertainty where one exists. Dynamical masses, interferometric radii, parallaxes, transit radii and timing-based masses count as Measured. Minimum masses from radial velocities are Measured, but always labelled as minimum masses.
- **Two fixed edge cases.** Exact defined constants (the speed of light in m/s, the astronomical unit, the IAU nominal solar radius, the magnitude scale) are shown as Measured with a method that begins "Definition", because they are exact by convention rather than uncertain estimates. Planet radii and masses from transits and transit timing are Measured even though their absolute scale comes from the host star's radius and mass; for TRAPPIST-1 the star's mass rests on an empirical relation and is labelled Inferred, and each planet's method text says "scaled by the star's radius/mass". The Codex states both rules in its "Measured, Inferred, Generated" entry.
- **Inferred:** anything that depends on a physical model or assumption (ages, interior temperatures, equilibrium temperatures, model-based radii and masses, habitable-zone limits, the existence of subsurface oceans or surface lakes), anything the source itself marks as derived (densities), every stellar effective temperature (derived from luminosity and radius or from model fits), and any number computed for the Codex (distances in light-years from parallaxes, light-travel times, unit conversions and ratios).
- **Generated:** content the game makes up within physical rules (procedural terrain, exoplanet surfaces, fill in unimaged parts of moon maps, the overall star brightness, the drive).
- **Self-references.** Statements about the game itself cite one of three Known Sky keys, never an outside source that cannot contain the number:
  - `known-sky-source`: the game's own design (generators, rendering choices). It may back only Generated items.
  - `known-sky-pipeline`: how the game processes real data (elevation grid spacing, star counts, ephemeris fit errors, unimaged fractions of moon maps, the inferred sizes of visited stars). Its values are recomputed from the shipped files by `tests/unit/codex.test.ts`. The outside dataset is cited separately for its native resolution (for example ETOPO 2022 at 60 arc-seconds, LOLA at 16 px/deg).
  - `known-sky-exo-rules`: the TRAPPIST-1 pipeline's inference and surface rules (Generated or Inferred only).
  - Every Generated item cites one of these, and any fact whose label is about the game ("in the game", "game's", "in-game") must cite one of them.
- **Peer review.** A Measured item may not cite an arXiv-only preprint or a Research Note of the AAS. IAU resolution texts (Mamajek et al. 2015 on arXiv) are standards documents and are exempt.
- **Prose follows the tiers.** A summary or paragraph may not state as fact what the entry's own claims mark Inferred: "probably fed by a global ocean", "interpreted as lakes", "thought to be heated by tides". `tests/unit/codex.test.ts` enforces this with a keyword heuristic: a sentence that mentions a topic one of the entry's Inferred claims covers (oceans, lakes, rivers, water ice, tidal heating, greenhouse heating, the habitable zone, captures, resonant chains, fusion, the Great Dimming, warp energy) must carry a hedge word (thought, probably, interpreted, suggests, models, Inferred and similar).
- **No Measured fact or claim may cite an unverified citation.**

## What the checks enforce

`tools/pipeline/codex_check.py` (Python standard library only) and `tests/unit/codex.test.ts` both check: citation fields and formats; no unknown fields in citations, entries, facts or claims; unique ids; every entry the module spec requires; 1-2 sentence summaries and 3-6 paragraph bodies; finite numbers; resolvable citation keys (including keys used by `bodies.json`, `systems/*.json` and the source code); `bodyId`, `starName` and `related` links; coverage of every body in `bodies.json`; and the provenance rules above. Both fail on a Measured item that cites an unverified or non-peer-reviewed source, a Generated item that does not cite a self-reference, or a game fact that cites an outside source.

The TypeScript test also recomputes the numbers the Codex quotes about the game from the files they describe:

- mean radii against `bodies.json`, Saturn's ring edges against its `rings` block, and parallax-to-light-year conversions;
- TRAPPIST-1 radii, masses, periods and orbits against `tools/exo/trappist1_verified.json`; light time and the speed of light against `src/core/constants.ts`;
- elevation grid spacing against `public/data/heights/*.json`, the ephemeris window and fit errors against `ephemeris.json`, the number of catalogue stars and the farthest star against `stars.json` and `stars.bin`, unimaged fractions of moon maps against `imagery.json`;
- the sizes the game infers for Proxima Centauri and Betelgeuse, by calling `inferStar` from `src/world/starCatalog.ts` on their HYG magnitudes and colours;
- the jump-duration formula in `src/game/ship/hyperspeed.ts` (the "about 20-40 s" and "about 5 million times light speed" facts) and the faintest drawn magnitude in `src/render/starfield.ts`;
- the wording of each body's "In the game" paragraph against the texture source in `tools/pipeline/textures.py`: USGS mosaics must be named as USGS and cited with their `usgs-<body>-mosaic` key, Solar System Scope maps as Solar System Scope, and the NASA 3D Resources map as undocumented.

## What could not be verified, and known caveats

1. **`perryman1997`** (Hipparcos Catalogue paper, A&A 323, L49, no DOI): ADS blocked automated access, so it is stored with `"verified": false` and no Codex fact cites it. Hipparcos facts cite the ESA mission page (`esa-hipparcos`) and van Leeuwen 2007 instead.
2. **HYG v4.1 release year** is not confirmed (`year: null`). The licence (CC BY-SA 4.0) and contents were read from the repository; the maintainer is David Nash on Codeberg. HYG v4.1 is superseded (v4.4, July 2026).
3. **Gaia sky map file.** The pipeline did not record the download URL of `Gaia_EDR3_flux_cartesian_16k.png`. The cited ESA page (equirectangular EDR3 colour map, credit "ESA/Gaia/DPAC; CC BY-SA 3.0 IGO. Acknowledgement: A. Moitinho") matches the image content, but the exact file correspondence is inferred.
4. **Deimos map (NASA 3D Resources).** The repository does not say which images the map was made from or how its longitudes are oriented. The Codex says so on the Deimos entry and in "What the game's surfaces are", and tags the statement Inferred. Every other moon now uses a USGS mosaic.
5. **Titan map.** The USGS product page is rendered by JavaScript and could not be read. The filter wavelength (938 nm) and the 3-5% data gap come from NASA's description of PIA19658, read through the NASA Image and Video Library API (Photojournal blocked automated access); the ISIS label of the USGS file names PIA19658 as its product. The pipeline counts almost no unimaged pixels on Titan (0.02%) because that gap is uniform grey in the source rather than empty.
6. **`agol2024`** is a Research Note of the AAS (RNAAS 8, 274; doi:10.3847/2515-5172/ad8b46), not a full peer-reviewed paper, and its authors postpone a full dynamical analysis. The AAS journal pages returned HTTP 403 on 2026-10-11, so the journal's review policy could not be quoted; the Codex takes the conservative view, cites the note only for Inferred claims (the TRAPPIST-1 h timing drift) and says in the text that the result comes from a research note.
7. **IAU star names.** The IAU's naming-stars page returned HTTP 404 on 2026-10-11. The names Rigil Kentaurus and Toliman are cited to the Working Group on Star Names catalogue file (`iau-csn`), whose header names that IAU page as the official version.
8. **Black Marble 2016 maps page** has no visible date; the `year` 2017 for the NASA Earth Observatory release is not independently confirmed. The underlying product paper (Román et al. 2018) is verified.
9. **Old papers checked only bibliographically:** Rayleigh 1871 and Einstein 1905 were verified as records, but their text was not machine-read. The 1/wavelength⁴ law is also checked in Bruneton & Neyret 2008; the speed-of-light limit is standard special relativity.
10. **Paywalled journals:** for Nature and Science papers the abstracts were read on the publisher landing pages; full texts were not.
11. **Counts that change:** the exoplanet count (6,445), Saturn's moon count (274, NASA fact sheet of July 2025) and Jupiter's (95, December 2023) are dated. Gaia DR4 is scheduled for 2 December 2026 and had not been released when this was written.

## Discrepancies found in other modules' data

These are outside the Codex module; they are reported for the integrator.

**Resolved on the integration branch since the first pass:** the Saturn A ring edge in `bodies.json` is now 136,780 km and cites the rings fact sheet; Enceladus's geometric albedo is now 1.0; `inferStar` now applies the Flower/Torres bolometric correction and labels visited stars Inferred (the Codex quotes its current results, about 0.075 solar radii for Proxima Centauri and 507 for Betelgeuse, and the unit test recomputes them); the moons other than Deimos now use georeferenced USGS mosaics.

**Still open:**

- **"JPL DE440 GM" in `bodies.json`:** in `gm_de440.tpc` only the Sun, Mercury, Venus, Earth, Moon and the planetary-system barycenters carry DE440 values; satellites and planet bodies come from JPL satellite ephemerides. Pluto's GM there (869.6 km³/s²) differs from JPL's current PLU060 value (869.3 ± 0.4).
- **Phobos mean radius:** the game derives 11.05 km from the triaxial radii; JPL lists 11.08 ± 0.04 km (within 1 sigma).
- **Positions of nearby stars** use HYG's Hipparcos parallaxes: Proxima is placed at 4.23 ly versus Gaia DR3's 4.2465 ly, and Alpha Centauri at 4.32 ly versus about 4.37 ly from newer astrometry. The Codex says so on each star.
- **Key `nasa-exoplanet-archive` means two things.** `public/data/systems/trappist-1.json` uses it (and embeds it) for the Planetary Systems Composite Table, DOI 10.26133/NEA13, while `citations.json`, which the Codex and the game's citation lookup read, defines it as the archive paper (Christiansen et al. 2025). Both are fair sources for archive values, but a reader following the key sees a different reference from the one the pipeline meant. Suggest the exoplanet pipeline cite `nea-pscomppars` (or `nasa-exoplanet-archive-pscomppars`) instead.
- **Duplicate keys** from the exoplanet pipeline merge: `gaia-dr3` and `vallenari2023`, `piaulet-ghorayeb2025` and `piaulet2025`, `nasa-exoplanet-archive-pscomppars` and `nea-pscomppars` name the same works. Harmless, but one key per work would be cleaner.
- **Titan map longitudes:** the ISIS label of the USGS Titan file says `LongitudeDirection = PositiveWest`. `tools/pipeline/textures.py` rolls each map by its centre longitude only; its comment says Xanadu was checked to land in the right place, so this is probably fine, but a second feature check would settle it.
- **`tools/exo/trappist1_verified.json`:** values earlier marked unverified are now confirmed. The insolation of c, f, g and h matches the NASA Exoplanet Archive (reflink Agol et al. 2021); equilibrium temperatures in the archive come from Ducrot et al. 2020 (397.6, 339.7, 286.2, 249.7, 217.7, 197.3, 171.7 K); and the Gaia DR3 parallax and source ID are confirmed by a direct archive query. The Codex TRAPPIST-1 numbers equal the values in that file (checked by the unit test).
- **JPL Astrodynamic Parameters page** labels the au definition "IAU 2012 Resolution B1"; the resolution text itself numbers it B2.

## Updating the Codex

- Run `python3 tools/pipeline/codex_check.py` and `npx vitest run tests/unit/codex.test.ts` after any edit. They fail on the problems listed under "What the checks enforce", including numeric drift from the game's data files and "In the game" paragraphs that no longer match the texture pipeline.
- When a data file or game rule changes (a new texture source, a new star-size formula, a new ephemeris fit), update the matching Codex facts and paragraphs; the unit test names the entry and fact that drifted.
- To refresh the exoplanet count, run `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+count(*)+from+pscomppars&format=csv`, update the facts in `concept-exoplanet-count`, `concept-transit` and `concept-radial-velocity`, and update the date in the `nea-pscomppars` note.
- New citation keys must be fetched and checked before `verified` is set to `true`. Add the key to a group in `GROUPS` in `codex_check.py` (keys not listed there appear under "Other sources") and run `python3 tools/pipeline/codex_check.py --write-docs` to regenerate the registry below; the plain check prints a note when the registry is out of date.
- To proofread entries as players would read them, run `npx vite` and open `/codexdata.html` (optionally `?id=<entry id>` or `?kind=star`). The page shows every fact with its provenance badge, method and numbered source, and flags any citation key it cannot resolve. `tests/e2e/codexdata.spec.ts` opens every entry on that page.

## Citation registry

Each row gives the key, the reference as recorded, which Codex entries (or other data files) cite it, and whether it was verified. The tables are generated from `citations.json` and `codex/en.json` by `tools/pipeline/codex_check.py --write-docs`; do not edit them by hand.

<!-- citation-registry:start (generated by tools/pipeline/codex_check.py --write-docs) -->

### Game data sources

| Key | Reference | Used by | Verified |
|---|---|---|---|
| `archinal2018` | Archinal, B. A. et al. (2018). *Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements: 2015*. Celestial Mechanics and Dynamical Astronomy 130, 22. doi:10.1007/s10569-017-9805-5 | bodies.json, mercury | yes |
| `archinal2019` | Archinal, B. A. et al. (2019). *Correction to: Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements: 2015*. Celestial Mechanics and Dynamical Astronomy 131, 61. doi:10.1007/s10569-019-9925-1 | (registry only) | yes |
| `naif-pck00011` | Bachman, N. (NASA NAIF, JPL) (2022). *P_constants (PCK) SPICE kernel file pck00011.tpc*. NASA Navigation and Ancillary Information Facility, generic kernels. https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc | deimos, earth, enceladus, jupiter, mars, mercury +5 more | yes |
| `naif-gm-de440` | Giorgini, J. D. & Semenov, B. V. (JPL SSD / NAIF) (2022). *gm_de440.tpc: mass parameters (GM) for planets, natural satellites and other bodies*. NASA NAIF generic kernels. https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/gm_de440.tpc | jupiter | yes |
| `acton1996` | Acton, C. H. (1996). *Ancillary data services of NASA's Navigation and Ancillary Information Facility*. Planetary and Space Science 44, 65-70. doi:10.1016/0032-0633(95)00107-7 | (registry only) | yes |
| `de440` | Park, R. S. et al. (2021). *The JPL Planetary and Lunar Ephemerides DE440 and DE441*. The Astronomical Journal 161, 105. doi:10.3847/1538-3881/abd414 | concept-ephemerides, sun | yes |
| `jpl-horizons` | NASA Jet Propulsion Laboratory, Solar System Dynamics Group (n.d.). *Horizons System*. JPL Solar System Dynamics (web service). https://ssd.jpl.nasa.gov/horizons/ | (registry only) | yes |
| `jpl-ephemerides` | NASA Jet Propulsion Laboratory, Solar System Dynamics Group (n.d.). *JPL Planetary and Lunar Ephemerides*. JPL Solar System Dynamics (web page). https://ssd.jpl.nasa.gov/planets/eph_export.html | concept-ephemerides, moon | yes |
| `jpl-sat-phys` | NASA Jet Propulsion Laboratory, Solar System Dynamics Group (n.d.). *Planetary Satellite Physical Parameters*. JPL Solar System Dynamics (web page). https://ssd.jpl.nasa.gov/sats/phys_par/ | callisto, charon, concept-ephemerides, deimos, enceladus, europa +6 more | yes |
| `jpl-sat-discovery` | NASA Jet Propulsion Laboratory, Solar System Dynamics Group (n.d.). *Planetary Satellite Discovery Circumstances*. JPL Solar System Dynamics (web page). https://ssd.jpl.nasa.gov/sats/discovery.html | callisto, charon, deimos, enceladus, europa, ganymede +4 more | yes |
| `jpl-astro-constants` | NASA Jet Propulsion Laboratory, Solar System Dynamics Group (n.d.). *Astrodynamic Parameters*. JPL Solar System Dynamics (web page). https://ssd.jpl.nasa.gov/astro_par.html | concept-drive-fiction, concept-light-travel, moon, sun | yes |
| `hyg-v41` | Nash, D. (astronexus, HYG Database) (n.d.). *HYG Database v4.1 (Hipparcos, Yale Bright Star and Gliese catalogues combined)*. astronexus HYG-Database, hyg/CURRENT/hygdata_v41.csv (GitHub archive; now maintained on Codeberg). https://github.com/astronexus/HYG-Database | src, alpha-centauri-a, alpha-centauri-b, barnards-star, betelgeuse, concept-star-brightness +4 more | yes |
| `vanleeuwen2007` | van Leeuwen, F. (2007). *Validation of the new Hipparcos reduction*. Astronomy & Astrophysics 474, 653-664. doi:10.1051/0004-6361:20078357 | betelgeuse, concept-star-catalogues, polaris, sirius, vega | yes |
| `gaia-dr3-archive` | ESA/Gaia/DPAC (2022). *Gaia DR3 gaia_source table, queried through the Gaia ESA Archive TAP service*. Gaia ESA Archive (gea.esac.esa.int). https://gea.esac.esa.int/archive/ | barnards-star, concept-light-travel, concept-parallax, proxima-centauri, trappist-1 | yes |
| `gaia-edr3-skymap` | ESA/Gaia/DPAC (acknowledgement: A. Moitinho) (2020). *The colour of the sky from Gaia's Early Data Release 3 (equirectangular projection)*. European Space Agency, ESA Multimedia image release (3 December 2020). https://www.esa.int/ESA_Multimedia/Images/2020/12/The_colour_of_the_sky_from_Gaia_s_Early_Data_Release_32 | concept-star-catalogues | yes |
| `blue-marble-ng` | Stöckli, R., Vermote, E., Saleous, N., Simmon, R. & Herring, D. (2005). *The Blue Marble Next Generation - A true color earth dataset including seasonal dynamics from MODIS*. NASA Earth Observatory. https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/ | concept-game-surfaces, earth | yes |
| `blue-marble-2002-clouds` | NASA Earth Observatory (2002). *The Blue Marble (2002): True-color global imagery at 1 km resolution (cloud layer)*. NASA Earth Observatory. https://science.nasa.gov/earth/earth-observatory/the-blue-marble-true-color-global-imagery-at-1km-resolution/ | earth | yes |
| `black-marble-2016` | Román, M. O. et al. (2018). *NASA's Black Marble nighttime lights product suite*. Remote Sensing of Environment 210, 113-143. doi:10.1016/j.rse.2018.03.017 | earth | yes |
| `black-marble-2016-maps` | NASA Earth Observatory (2017). *Earth at Night / Black Marble: Flat Maps (2016 Color)*. NASA Earth Observatory. https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/ | earth | yes |
| `etopo2022` | NOAA National Centers for Environmental Information (2022). *ETOPO 2022 15 Arc-Second Global Relief Model*. NOAA National Centers for Environmental Information (dataset). doi:10.25921/fd45-gt74 | concept-provenance, earth | yes |
| `svs-cgi-moon-kit` | Wright, E. (NASA Scientific Visualization Studio) (2019). *CGI Moon Kit*. NASA Goddard Scientific Visualization Studio, ID 4720. https://svs.gsfc.nasa.gov/4720 | concept-game-surfaces, moon | yes |
| `lroc-wac` | Robinson, M. S. et al. (2010). *Lunar Reconnaissance Orbiter Camera (LROC) Instrument Overview*. Space Science Reviews 150, 81-124. doi:10.1007/s11214-010-9634-2 | moon | yes |
| `lola` | Smith, D. E. et al. (2010). *Initial observations from the Lunar Orbiter Laser Altimeter (LOLA)*. Geophysical Research Letters 37, L18204. doi:10.1029/2010GL043751 | moon | yes |
| `usgs-pluto-mosaic` | New Horizons Team (NASA, JHU APL, SwRI, LPI); USGS Astrogeology Science Center (2017). *Pluto New Horizons LORRI - MVIC Global Mosaic 300m*. USGS Astrogeology Science Center, Astropedia. https://astrogeology.usgs.gov/search/map/pluto_new_horizons_lorri_mvic_global_mosaic_300m | concept-game-surfaces, pluto | yes |
| `usgs-charon-mosaic` | New Horizons Team (NASA, JHU APL, SwRI, LPI); USGS Astrogeology Science Center (2017). *Charon New Horizons LORRI MVIC Global Mosaic 300m*. USGS Astrogeology Science Center, Astropedia. https://astrogeology.usgs.gov/search/map/charon_new_horizons_lorri_mvic_global_mosaic_300m | charon | yes |
| `usgs-titan-mosaic` | Cassini Imaging Science Subsystem team; USGS Astrogeology Science Center (n.d.). *Titan Cassini ISS global mosaic, 4 km (P19658)*. USGS Astrogeology Science Center, planetarymaps.usgs.gov. https://planetarymaps.usgs.gov/mosaic/Titan_ISS_P19658_Mosaic_Global_4km.tif | titan | yes |
| `nasa-pia19658` | NASA/JPL-Caltech/Space Science Institute (2015). *Titan Global Map - June 2015 (PIA19658)*. NASA Image and Video Library (Photojournal PIA19658). https://images.nasa.gov/details/PIA19658 | titan | yes |
| `usgs-enceladus-mosaic` | Cassini Imaging Science Subsystem team; USGS Astrogeology Science Center (n.d.). *Enceladus Cassini ISS global mosaic, 100 m (high-pass filtered)*. USGS Astrogeology Science Center, planetarymaps.usgs.gov. https://planetarymaps.usgs.gov/mosaic/Enceladus_Cassini_ISS_Global_Mosaic_100m_HPF.tif | enceladus | yes |
| `usgs-io-mosaic` | Galileo SSI and Voyager imaging teams; USGS Astrogeology Science Center (n.d.). *Io Galileo SSI / Voyager global colour mosaic, 1 km*. USGS Astrogeology Science Center, planetarymaps.usgs.gov. https://planetarymaps.usgs.gov/mosaic/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif | io | yes |
| `usgs-europa-mosaic` | Voyager and Galileo SSI imaging teams; USGS Astrogeology Science Center (n.d.). *Europa Voyager / Galileo SSI global mosaic, 500 m*. USGS Astrogeology Science Center, planetarymaps.usgs.gov. https://planetarymaps.usgs.gov/mosaic/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif | europa | yes |
| `usgs-ganymede-mosaic` | Voyager and Galileo SSI imaging teams; USGS Astrogeology Science Center (n.d.). *Ganymede Voyager / Galileo SSI global mosaic, 1 km*. USGS Astrogeology Science Center, planetarymaps.usgs.gov. https://planetarymaps.usgs.gov/mosaic/Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif | ganymede | yes |
| `usgs-callisto-mosaic` | Voyager and Galileo SSI imaging teams; USGS Astrogeology Science Center (n.d.). *Callisto Voyager / Galileo SSI global mosaic, 1 km*. USGS Astrogeology Science Center, planetarymaps.usgs.gov. https://planetarymaps.usgs.gov/mosaic/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif | callisto | yes |
| `usgs-triton-mosaic` | Voyager 2 imaging team; USGS Astrogeology Science Center (n.d.). *Triton Voyager 2 colour mosaic, 600 m*. USGS Astrogeology Science Center, planetarymaps.usgs.gov. https://planetarymaps.usgs.gov/mosaic/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif | triton | yes |
| `usgs-phobos-mosaic` | Viking Orbiter imaging team; USGS Astrogeology Science Center (n.d.). *Phobos Viking global mosaic, 40 pixels per degree (DLR control)*. USGS Astrogeology Science Center, planetarymaps.usgs.gov. https://planetarymaps.usgs.gov/mosaic/Phobos_Viking_Mosaic_40ppd_DLRcontrol.tif | phobos | yes |
| `solar-system-scope` | INOVE (Solar System Scope) (n.d.). *Solar Textures*. solarsystemscope.com (texture pack). https://www.solarsystemscope.com/textures/ | concept-game-surfaces | yes |
| `nasa-3d-resources` | NASA (Ames Research Center and contributors) (n.d.). *NASA 3D Resources: Images and Textures*. github.com/nasa/NASA-3D-Resources and science.nasa.gov/3d-resources. https://science.nasa.gov/3d-resources/ | concept-game-surfaces, deimos | yes |
| `karkoschka1994` | Karkoschka, E. (1994). *Spectrophotometry of the Jovian Planets and Titan at 300- to 1000-nm Wavelength: The Methane Spectrum*. Icarus 111, 174-192. doi:10.1006/icar.1994.1139 | bodies.json, concept-game-surfaces, titan | yes |
| `nasa-exoplanet-archive` | Christiansen, J. L. et al. (2025). *The NASA Exoplanet Archive and Exoplanet Follow-up Observing Program: Data, Tools, and Usage*. The Planetary Science Journal 6, 186. doi:10.3847/PSJ/ade3c2 | systems/trappist-1.json, concept-exoplanet-count | yes |
| `nea-pscomppars` | NASA Exoplanet Science Institute (2020). *Planetary Systems Composite Table*. NASA Exoplanet Archive, IPAC/Caltech (dataset). doi:10.26133/NEA13 | concept-exoplanet-count, concept-radial-velocity, concept-transit, concept-ttv, proxima-centauri-b, trappist-1 | yes |
| `bruneton2008` | Bruneton, E. & Neyret, F. (2008). *Precomputed Atmospheric Scattering*. Computer Graphics Forum 27, 1079-1086. doi:10.1111/j.1467-8659.2008.01245.x | bodies.json, concept-sky-blue, earth | yes |
| `ballesteros2012` | Ballesteros, F. J. (2012). *New insights into black bodies*. EPL (Europhysics Letters) 97, 34008. doi:10.1209/0295-5075/97/34008 | concept-star-brightness | yes |

### Known Sky self-references

| Key | Reference | Used by | Verified |
|---|---|---|---|
| `known-sky-source` | Known Sky contributors (2026). *Known Sky source code and design documents (MIT licence)*. Known Sky repository (src/, docs/PRD.md). https://github.com/DistinKt3/SpaceStem | concept-drive-fiction, concept-game-surfaces, concept-provenance, concept-star-brightness, mars, mercury +9 more | yes |
| `known-sky-pipeline` | Known Sky contributors (2026). *Known Sky data pipeline and the data files it produces*. Known Sky repository: tools/pipeline/*.py, public/data/*.json, src/world/starCatalog.ts and docs/DATA_MANIFEST.md (MIT licence). https://github.com/DistinKt3/SpaceStem | betelgeuse, callisto, charon, concept-ephemerides, concept-game-surfaces, concept-light-travel +9 more | yes |
| `known-sky-exo-rules` | Known Sky contributors (2026). *TRAPPIST-1 data pipeline: inference formulas and surface-generation rules*. Known Sky source repository, docs/EXO_TRAPPIST1.md and tools/pipeline/exoplanets.py (MIT licence). https://github.com/DistinKt3/SpaceStem/blob/main/docs/EXO_TRAPPIST1.md | systems/trappist-1.json | yes |

### NASA fact sheets and mission pages

| Key | Reference | Used by | Verified |
|---|---|---|---|
| `esa-juice` | European Space Agency (n.d.). *Juice*. ESA Science & Exploration (web page). https://www.esa.int/Science_Exploration/Space_Science/Juice | ganymede | yes |
| `nasa-callisto` | NASA Science (n.d.). *Callisto*. NASA Science (web page). https://science.nasa.gov/jupiter/jupiter-moons/callisto/ | callisto | yes |
| `nasa-charon` | NASA Science (n.d.). *Charon*. NASA Science (web page). https://science.nasa.gov/dwarf-planets/pluto/moons/charon/ | charon | yes |
| `nasa-deimos` | NASA Science (n.d.). *Deimos*. NASA Science (web page). https://science.nasa.gov/mars/moons/deimos/ | deimos | yes |
| `nasa-dragonfly` | NASA Science (n.d.). *Dragonfly*. NASA Science (web page). https://science.nasa.gov/mission/dragonfly/ | titan | yes |
| `nasa-earth-facts` | NASA Science (n.d.). *Facts About Earth*. NASA Science (web page). https://science.nasa.gov/earth/facts/ | earth | yes |
| `nasa-earth-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2024). *Earth Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html | concept-habitable-zone, earth | yes |
| `nasa-europa-clipper` | NASA Science (n.d.). *Europa Clipper*. NASA Science (web page). https://science.nasa.gov/mission/europa-clipper/ | europa | yes |
| `nasa-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (n.d.). *Planetary Fact Sheet - Metric*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/ | bodies.json, jupiter | yes |
| `nasa-ganymede` | NASA Science (n.d.). *Ganymede*. NASA Science (web page). https://science.nasa.gov/jupiter/jupiter-moons/ganymede/ | ganymede | yes |
| `nasa-io` | NASA Science (n.d.). *Io*. NASA Science (web page). https://science.nasa.gov/jupiter/jupiter-moons/io/ | io | yes |
| `nasa-jovian-satellites-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2023). *Jovian Satellite Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/joviansatfact.html | callisto, europa, ganymede, io, jupiter | yes |
| `nasa-jupiter-facts` | NASA Science (n.d.). *Jupiter Facts*. NASA Science (web page). https://science.nasa.gov/jupiter/jupiter-facts/ | jupiter | yes |
| `nasa-jupiter-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2024). *Jupiter Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/jupiterfact.html | jupiter | yes |
| `nasa-lunar-samples` | NASA Johnson Space Center, Astromaterials Acquisition and Curation Office (2023). *Lunar Rocks and Soils from Apollo Missions*. NASA Astromaterials Curation (web page). https://curator.jsc.nasa.gov/lunar/ | moon | yes |
| `nasa-mars-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2025). *Mars Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html | deimos, mars, phobos | yes |
| `nasa-mercury-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2024). *Mercury Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/mercuryfact.html | mercury | yes |
| `nasa-moon-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2024). *Moon Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html | concept-tidal-locking, moon | yes |
| `nasa-neptune-facts` | NASA Science (n.d.). *Neptune: Facts*. NASA Science (web page). https://science.nasa.gov/neptune/neptune-facts/ | neptune | yes |
| `nasa-neptune-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2024). *Neptune Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/neptunefact.html | neptune | yes |
| `nasa-neptunian-satellites-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2024). *Neptunian Satellite Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/neptuniansatfact.html | triton | yes |
| `nasa-phobos` | NASA Science (n.d.). *Phobos*. NASA Science (web page). https://science.nasa.gov/mars/moons/phobos/ | phobos | yes |
| `nasa-pluto-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2024). *Pluto Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/plutofact.html | charon, concept-tidal-locking, pluto | yes |
| `nasa-saturn-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2025). *Saturn Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/saturnfact.html | saturn | yes |
| `nasa-saturn-rings-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2022). *Saturnian Rings Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/satringfact.html | bodies.json, saturn | yes |
| `nasa-saturnian-satellites-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2025). *Saturnian Satellite Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/saturniansatfact.html | enceladus, saturn, titan | yes |
| `nasa-sun-facts` | NASA Science (n.d.). *Sun: Facts*. NASA Science (web page). https://science.nasa.gov/sun/facts/ | sun | yes |
| `nasa-sun-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2024). *Sun Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/sunfact.html | concept-star-brightness, concept-transit, sun | yes |
| `nasa-titan` | NASA Science (n.d.). *Titan*. NASA Science (web page). https://science.nasa.gov/saturn/moons/titan/ | titan | yes |
| `nasa-triton` | NASA Science (n.d.). *Triton*. NASA Science (web page). https://science.nasa.gov/neptune/moons/triton/ | triton | yes |
| `nasa-uranus-facts` | NASA Science (n.d.). *Uranus: Facts*. NASA Science (web page). https://science.nasa.gov/uranus/facts/ | uranus | yes |
| `nasa-uranus-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2024). *Uranus Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/uranusfact.html | uranus | yes |
| `nasa-venus-facts` | NASA Science (n.d.). *Venus: Facts*. NASA Science (web page). https://science.nasa.gov/venus/venus-facts/ | venus | yes |
| `nasa-venus-factsheet` | Williams, D. R. (NASA Space Science Data Coordinated Archive) (2024). *Venus Fact Sheet*. NASA Goddard Space Flight Center, NSSDCA Planetary Fact Sheets (web page). https://nssdc.gsfc.nasa.gov/planetary/factsheet/venusfact.html | venus | yes |

### Standards and definitions

| Key | Reference | Used by | Verified |
|---|---|---|---|
| `iau2012-b2` | International Astronomical Union, XXVIII General Assembly (2012). *Resolution B2 on the re-definition of the astronomical unit of length*. IAU Resolutions adopted at the XXVIII General Assembly, Beijing. https://iauarchive.eso.org/static/resolutions/IAU2012_English.pdf | concept-light-travel | yes |
| `prsa2016` | Prša, A. et al. (2016). *Nominal Values for Selected Solar and Planetary Quantities: IAU 2015 Resolution B3*. The Astronomical Journal 152, 41. doi:10.3847/0004-6256/152/2/41 | sun | yes |
| `mamajek2015` | Mamajek, E. E. et al. (2015). *IAU 2015 Resolution B2 on Recommended Zero Points for the Absolute and Apparent Bolometric Magnitude Scales*. arXiv:1510.06262 (text and rationale of IAU 2015 Resolution B2). https://arxiv.org/abs/1510.06262 | concept-parallax, concept-star-brightness | yes |
| `iau2006-b5b6` | International Astronomical Union, XXVI General Assembly (2006). *Resolution B5: Definition of a Planet in the Solar System; Resolution B6: Pluto*. IAU Resolutions adopted at the XXVI General Assembly, Prague. https://iauarchive.eso.org/static/resolutions/Resolution_GA26-5-6.pdf | pluto | yes |
| `iau-csn` | IAU Division C Working Group on Star Names (WGSN) (2022). *IAU Catalog of Star Names (IAU-CSN)*. IAU WGSN data file, maintained by the WGSN secretary (last updated 2022-04-04). https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt | alpha-centauri-a, alpha-centauri-b | yes |

### TRAPPIST-1

| Key | Reference | Used by | Verified |
|---|---|---|---|
| `agol2021` | Agol, E. et al. (2021). *Refining the Transit-timing and Photometric Analysis of TRAPPIST-1: Masses, Radii, Densities, Dynamics, and Ephemerides*. The Planetary Science Journal 2, 1. doi:10.3847/PSJ/abd022 | systems/trappist-1.json, concept-habitable-zone, concept-provenance, concept-transit, concept-ttv, trappist-1 +7 more | yes |
| `agol2024` | Agol, E. et al. (2024). *Updated Forecast for TRAPPIST-1 Times of Transit for All Seven Exoplanets Incorporating JWST Data*. Research Notes of the AAS 8, 274. doi:10.3847/2515-5172/ad8b46 | systems/trappist-1.json, concept-provenance, trappist-1h | yes |
| `gillon2016` | Gillon, M. et al. (2016). *Temperate Earth-sized planets transiting a nearby ultracool dwarf star*. Nature 533, 221-224. doi:10.1038/nature17448 | trappist-1b, trappist-1c, trappist-1d | yes |
| `gillon2017` | Gillon, M. et al. (2017). *Seven temperate terrestrial planets around the nearby ultracool dwarf star TRAPPIST-1*. Nature 542, 456-460. doi:10.1038/nature21360 | trappist-1, trappist-1e, trappist-1f, trappist-1g, trappist-1h | yes |
| `luger2017` | Luger, R. et al. (2017). *A seven-planet resonant chain in TRAPPIST-1*. Nature Astronomy 1, 0129. doi:10.1038/s41550-017-0129 | trappist-1 | yes |
| `burgasser2017` | Burgasser, A. J. & Mamajek, E. E. (2017). *On the Age of the TRAPPIST-1 System*. The Astrophysical Journal 845, 110. doi:10.3847/1538-4357/aa7fea | trappist-1 | yes |
| `mann2019` | Mann, A. W. et al. (2019). *How to Constrain Your M Dwarf. II. The Mass–Luminosity–Metallicity Relation from 0.075 to 0.70 Solar Masses*. The Astrophysical Journal 871, 63. doi:10.3847/1538-4357/aaf3bc | trappist-1 | yes |
| `ducrot2020` | Ducrot, E. et al. (2020). *TRAPPIST-1: Global results of the Spitzer Exploration Science Program Red Worlds*. Astronomy & Astrophysics 640, A112. doi:10.1051/0004-6361/201937392 | systems/trappist-1.json, concept-provenance, trappist-1b, trappist-1c, trappist-1d, trappist-1e +3 more | yes |
| `greene2023` | Greene, T. P. et al. (2023). *Thermal emission from the Earth-sized exoplanet TRAPPIST-1 b using JWST*. Nature 618, 39-42. doi:10.1038/s41586-023-05951-7 | systems/trappist-1.json, trappist-1b | yes |
| `zieba2023` | Zieba, S. et al. (2023). *No thick carbon dioxide atmosphere on the rocky exoplanet TRAPPIST-1 c*. Nature 620, 746-749. doi:10.1038/s41586-023-06232-z | systems/trappist-1.json, trappist-1c | yes |
| `lim2023` | Lim, O. et al. (2023). *Atmospheric Reconnaissance of TRAPPIST-1 b with JWST/NIRISS: Evidence for Strong Stellar Contamination in the Transmission Spectra*. The Astrophysical Journal Letters 955, L22. doi:10.3847/2041-8213/acf7c4 | trappist-1, trappist-1g, trappist-1h | yes |
| `ducrot2025` | Ducrot, E. et al. (2025). *Combined analysis of the 12.8 and 15 μm JWST/MIRI eclipse observations of TRAPPIST-1 b*. Nature Astronomy 9, 358-369. doi:10.1038/s41550-024-02428-z | trappist-1b | yes |
| `gillon2026` | Gillon, M. et al. (2026). *No thick atmosphere around TRAPPIST-1 b and c from JWST thermal phase curves*. Nature Astronomy 10, 674-694. doi:10.1038/s41550-026-02806-9 | concept-tidal-locking, trappist-1b, trappist-1c | yes |
| `piaulet2025` | Piaulet-Ghorayeb, C. et al. (2025). *Strict Limits on Potential Secondary Atmospheres on the Temperate Rocky Exo-Earth TRAPPIST-1 d*. The Astrophysical Journal 989, 181. doi:10.3847/1538-4357/adf207 | trappist-1d, trappist-1g | yes |
| `espinoza2025` | Espinoza, N. et al. (2025). *JWST-TST DREAMS: NIRSpec/PRISM Transmission Spectroscopy of the Habitable Zone Planet TRAPPIST-1 e*. The Astrophysical Journal Letters 990, L52. doi:10.3847/2041-8213/adf42e | systems/trappist-1.json, trappist-1e | yes |
| `glidden2025` | Glidden, A. et al. (2025). *JWST-TST DREAMS: Secondary Atmosphere Constraints for the Habitable Zone Planet TRAPPIST-1 e*. The Astrophysical Journal Letters 990, L53. doi:10.3847/2041-8213/adf62e | trappist-1e | yes |
| `lim2026` | Lim, O. et al. (2026). *Atmospheric Reconnaissance of TRAPPIST-1 f with JWST NIRISS SOSS: No Evidence for the Transit Light Source Effect*. The Astronomical Journal 172, 200. doi:10.3847/1538-3881/ae990a | trappist-1f, trappist-1g | yes |

### Nearby and notable stars

| Key | Reference | Used by | Verified |
|---|---|---|---|
| `anglada2016` | Anglada-Escudé, G. et al. (2016). *A terrestrial planet candidate in a temperate orbit around Proxima Centauri*. Nature 536, 437-440. doi:10.1038/nature19106 | concept-star-brightness, proxima-centauri, proxima-centauri-b | yes |
| `suarezmascareno2020` | Suárez Mascareño, A. et al. (2020). *Revisiting Proxima with ESPRESSO*. Astronomy & Astrophysics 639, A77. doi:10.1051/0004-6361/202037745 | proxima-centauri, proxima-centauri-b | yes |
| `faria2022` | Faria, J. P. et al. (2022). *A candidate short-period sub-Earth orbiting Proxima Centauri*. Astronomy & Astrophysics 658, A115. doi:10.1051/0004-6361/202142337 | proxima-centauri-b | yes |
| `suarezmascareno2025` | Suárez Mascareño, A. et al. (2025). *Diving into the planetary system of Proxima with NIRPS*. Astronomy & Astrophysics 700, A11. doi:10.1051/0004-6361/202553728 | concept-radial-velocity, proxima-centauri, proxima-centauri-b | yes |
| `kervella2017` | Kervella, P. et al. (2017). *Proxima's orbit around α Centauri*. Astronomy & Astrophysics 598, L7. doi:10.1051/0004-6361/201629930 | proxima-centauri | yes |
| `howard2018` | Howard, W. S. et al. (2018). *The First Naked-eye Superflare Detected from Proxima Centauri*. The Astrophysical Journal Letters 860, L30. doi:10.3847/2041-8213/aacaf3 | concept-habitable-zone, proxima-centauri | yes |
| `pourbaix2016` | Pourbaix, D. & Boffin, H. M. J. (2016). *Parallax and masses of α Centauri revisited*. Astronomy & Astrophysics 586, A90. doi:10.1051/0004-6361/201527859 | alpha-centauri-a, alpha-centauri-b | yes |
| `kervella2016` | Kervella, P. et al. (2016). *Close stellar conjunctions of α Centauri A and B until 2050*. Astronomy & Astrophysics 594, A107. doi:10.1051/0004-6361/201629201 | alpha-centauri-a | yes |
| `kervella2017radii` | Kervella, P. et al. (2017). *The radii and limb darkenings of α Centauri A and B*. Astronomy & Astrophysics 597, A137. doi:10.1051/0004-6361/201629505 | alpha-centauri-a, alpha-centauri-b | yes |
| `beichman2025` | Beichman, C. et al. (2025). *Worlds Next Door: A Candidate Giant Planet Imaged in the Habitable Zone of α Centauri A. I. Observations, Orbital and Physical Properties, and Exozodi Upper Limits*. The Astrophysical Journal Letters 989, L22. doi:10.3847/2041-8213/adf53f | alpha-centauri-a | yes |
| `sanghi2025` | Sanghi, A. et al. (2025). *Worlds Next Door: A Candidate Giant Planet Imaged in the Habitable Zone of α Centauri A. II. Binary Star Modeling, Planet and Exozodi Search, and Sensitivity Analysis*. The Astrophysical Journal Letters 989, L23. doi:10.3847/2041-8213/adf53e | alpha-centauri-a | yes |
| `rajpaul2016` | Rajpaul, V. et al. (2016). *Ghost in the time series: no planet for Alpha Cen B*. Monthly Notices of the Royal Astronomical Society: Letters 456, L6-L10. doi:10.1093/mnrasl/slv164 | alpha-centauri-b, concept-radial-velocity | yes |
| `barnard1916` | Barnard, E. E. (1916). *A small star with large proper-motion*. The Astronomical Journal 29, 181. doi:10.1086/104156 | barnards-star | yes |
| `gonzalezhernandez2024` | González Hernández, J. I. et al. (2024). *A sub-Earth-mass planet orbiting Barnard’s star*. Astronomy & Astrophysics 690, A79. doi:10.1051/0004-6361/202451311 | barnards-star, concept-radial-velocity | yes |
| `basant2025` | Basant, R. et al. (2025). *Four Sub-Earth Planets Orbiting Barnard’s Star from MAROON-X and ESPRESSO*. The Astrophysical Journal Letters 982, L1. doi:10.3847/2041-8213/adb8d5 | barnards-star | yes |
| `lubin2021` | Lubin, J. et al. (2021). *Stellar Activity Manifesting at a One-year Alias Explains Barnard b as a False Positive*. The Astronomical Journal 162, 61. doi:10.3847/1538-3881/ac0057 | barnards-star, concept-radial-velocity | yes |
| `montarges2021` | Montargès, M. et al. (2021). *A dusty veil shading Betelgeuse during its Great Dimming*. Nature 594, 365-368. doi:10.1038/s41586-021-03546-8 | betelgeuse | yes |
| `dupree2020` | Dupree, A. K. et al. (2020). *Spatially Resolved Ultraviolet Spectroscopy of the Great Dimming of Betelgeuse*. The Astrophysical Journal 899, 68. doi:10.3847/1538-4357/aba516 | betelgeuse | yes |
| `joyce2020` | Joyce, M. et al. (2020). *Standing on the Shoulders of Giants: New Mass and Distance Estimates for Betelgeuse through Combined Evolutionary, Asteroseismic, and Hydrodynamic Simulations with MESA*. The Astrophysical Journal 902, 63. doi:10.3847/1538-4357/abb8db | betelgeuse, concept-light-travel, concept-star-brightness | yes |
| `howell2025` | Howell, S. B. et al. (2025). *The Probable Direct-imaging Detection of the Stellar Companion to Betelgeuse*. The Astrophysical Journal Letters 988, L47. doi:10.3847/2041-8213/adeaaf | betelgeuse | yes |
| `goldberg2025` | Goldberg, J. A. et al. (2025). *Betelgeuse, Betelgeuse, Betelgeuse, Betel-buddy? Constraints on the Dynamical Companion to α Orionis from HST*. The Astrophysical Journal 994, 101. doi:10.3847/1538-4357/ae0c0c | betelgeuse | yes |
| `evans2024` | Evans, N. R. et al. (2024). *The Orbit and Dynamical Mass of Polaris: Observations with the CHARA Array*. The Astrophysical Journal 971, 190. doi:10.3847/1538-4357/ad5e7a | polaris | yes |
| `peterson2006` | Peterson, D. M. et al. (2006). *Vega is a rapidly rotating star*. Nature 440, 896-899. doi:10.1038/nature04661 | vega | yes |
| `aufdenberg2006` | Aufdenberg, J. P. et al. (2006). *First Results from the CHARA Array. VII. Long-Baseline Interferometric Measurements of Vega Consistent with a Pole-On, Rapidly Rotating Star*. The Astrophysical Journal 645, 664-675. doi:10.1086/504149 | vega | yes |
| `aumann1984` | Aumann, H. H. et al. (1984). *Discovery of a shell around Alpha Lyrae*. The Astrophysical Journal 278, L23. doi:10.1086/184214 | vega | yes |
| `su2024` | Su, K. Y. L. et al. (2024). *Imaging of the Vega Debris System Using JWST/MIRI*. The Astrophysical Journal 977, 277. doi:10.3847/1538-4357/ad8cde | vega | yes |
| `bond2017` | Bond, H. E. et al. (2017). *The Sirius System and Its Astrophysical Puzzles: Hubble Space Telescope and Ground-based Astrometry*. The Astrophysical Journal 840, 70. doi:10.3847/1538-4357/aa6af8 | sirius | yes |

### Star catalogues and astrometry

| Key | Reference | Used by | Verified |
|---|---|---|---|
| `esa-hipparcos` | European Space Agency (n.d.). *Hipparcos overview*. ESA Science & Exploration (web page). https://www.esa.int/Science_Exploration/Space_Science/Hipparcos_overview | concept-parallax, concept-star-catalogues | yes |
| `perryman1997` | Perryman, M. A. C. et al. (1997). *The HIPPARCOS Catalogue*. Astronomy & Astrophysics 323, L49-L52. https://ui.adsabs.harvard.edu/abs/1997A&A...323L..49P | (registry only) | no |
| `prusti2016` | Gaia Collaboration, Prusti, T. et al. (2016). *The Gaia mission*. Astronomy & Astrophysics 595, A1. doi:10.1051/0004-6361/201629272 | concept-star-catalogues | yes |
| `brown2021` | Gaia Collaboration, Brown, A. G. A. et al. (2021). *Gaia Early Data Release 3: Summary of the contents and survey properties*. Astronomy & Astrophysics 649, A1. doi:10.1051/0004-6361/202039657 | concept-star-catalogues | yes |
| `vallenari2023` | Gaia Collaboration, Vallenari, A. et al. (2023). *Gaia Data Release 3: Summary of the content and survey properties*. Astronomy & Astrophysics 674, A1. doi:10.1051/0004-6361/202243940 | concept-star-catalogues | yes |
| `esa-gaia-dr3` | European Space Agency / Gaia DPAC (2022). *Gaia Data Release 3 contents summary*. ESA Cosmos Gaia pages. https://www.cosmos.esa.int/web/gaia/dr3 | concept-parallax, concept-star-catalogues | yes |
| `esa-gaia-news-2026` | European Space Agency / Gaia DPAC (2026). *Gaia news 2026*. ESA Cosmos Gaia pages. https://www.cosmos.esa.int/web/gaia/news-2026 | concept-parallax | yes |
| `esa-gaia-parallax` | European Space Agency (n.d.). *Parallax*. ESA Science & Exploration: Gaia (web page). https://www.esa.int/Science_Exploration/Space_Science/Gaia/Parallax | concept-parallax | yes |
| `esa-measuring-parallax` | European Space Agency (n.d.). *Measuring stellar distances by parallax*. ESA Science & Technology (sci.esa.int, archived page). https://sci.esa.int/web/gaia/-/53278-measuring-stellar-distances-by-parallax | concept-parallax | yes |

### Concepts (methods, physics)

| Key | Reference | Used by | Verified |
|---|---|---|---|
| `mayor1995` | Mayor, M. & Queloz, D. (1995). *A Jupiter-mass companion to a solar-type star*. Nature 378, 355-359. doi:10.1038/378355a0 | concept-exoplanet-count, concept-radial-velocity | yes |
| `charbonneau2000` | Charbonneau, D. et al. (2000). *Detection of Planetary Transits Across a Sun-like Star*. The Astrophysical Journal 529, L45-L48. doi:10.1086/312457 | concept-transit | yes |
| `henry2000` | Henry, G. W. et al. (2000). *A Transiting “51 Peg–like” Planet*. The Astrophysical Journal 529, L41-L44. doi:10.1086/312458 | concept-transit | yes |
| `borucki2010` | Borucki, W. J. et al. (2010). *Kepler Planet-Detection Mission: Introduction and First Results*. Science 327, 977-980. doi:10.1126/science.1185402 | concept-transit | yes |
| `agol2005` | Agol, E. et al. (2005). *On detecting terrestrial planets with timing of giant planet transits*. Monthly Notices of the Royal Astronomical Society 359, 567-579. doi:10.1111/j.1365-2966.2005.08922.x | concept-ttv | yes |
| `holman2005` | Holman, M. J. & Murray, N. W. (2005). *The Use of Transit Timing to Detect Terrestrial-Mass Extrasolar Planets*. Science 307, 1288-1291. doi:10.1126/science.1107822 | concept-ttv | yes |
| `holman2010` | Holman, M. J. et al. (2010). *Kepler-9: A System of Multiple Planets Transiting a Sun-Like Star, Confirmed by Timing Variations*. Science 330, 51-54. doi:10.1126/science.1195778 | concept-ttv | yes |
| `kasting1993` | Kasting, J. F. et al. (1993). *Habitable Zones around Main Sequence Stars*. Icarus 101, 108-128. doi:10.1006/icar.1993.1010 | concept-habitable-zone | yes |
| `kopparapu2013` | Kopparapu, R. K. et al. (2013). *Habitable Zones around Main-sequence Stars: New Estimates*. The Astrophysical Journal 765, 131. doi:10.1088/0004-637X/765/2/131 | concept-habitable-zone | yes |
| `alcubierre1994` | Alcubierre, M. (1994). *The warp drive: hyper-fast travel within general relativity*. Classical and Quantum Gravity 11, L73-L77. doi:10.1088/0264-9381/11/5/001 | concept-drive-fiction | yes |
| `morris1988` | Morris, M. S. & Thorne, K. S. (1988). *Wormholes in spacetime and their use for interstellar travel: A tool for teaching general relativity*. American Journal of Physics 56, 395-412. doi:10.1119/1.15620 | concept-drive-fiction | yes |
| `pfenning1997` | Pfenning, M. J. & Ford, L. H. (1997). *The unphysical nature of 'warp drive'*. Classical and Quantum Gravity 14, 1743-1751. doi:10.1088/0264-9381/14/7/011 | concept-drive-fiction | yes |
| `vandenbroeck1999` | Van Den Broeck, C. (1999). *A 'warp drive' with more reasonable total energy requirements*. Classical and Quantum Gravity 16, 3973-3979. doi:10.1088/0264-9381/16/12/314 | concept-drive-fiction | yes |
| `einstein1905` | Einstein, A. (1905). *Zur Elektrodynamik bewegter Körper*. Annalen der Physik 322, 891-921. doi:10.1002/andp.19053221004 | concept-drive-fiction | yes |
| `rayleigh1871` | Strutt, J. W. (Lord Rayleigh) (1871). *On the light from the sky, its polarization and colour*. The London, Edinburgh, and Dublin Philosophical Magazine and Journal of Science 41, 107-120. doi:10.1080/14786447108640452 | concept-sky-blue | yes |
| `nasa-blue-sky` | NASA Space Place (n.d.). *Why Is the Sky Blue?*. NASA Science Space Place (web page). https://spaceplace.nasa.gov/blue-sky/en/ | concept-sky-blue | yes |
| `nasa-mars-sunset` | NASA/JPL-Caltech/MSSS/Texas A&M Univ. (2015). *Sunset in Mars' Gale Crater*. NASA Photojournal (web page). https://science.nasa.gov/photojournal/sunset-in-mars-gale-crater/ | concept-sky-blue, mars | yes |
| `nasa-tidal-locking` | NASA Science (n.d.). *Tidal Locking*. NASA Science: Moon (web page). https://science.nasa.gov/moon/tidal-locking/ | concept-tidal-locking, moon, proxima-centauri-b | yes |
| `nasa-habitable-zone` | NASA Science (n.d.). *The Habitable Zone*. NASA Science: Exoplanets (web page). https://science.nasa.gov/exoplanets/habitable-zone/ | concept-habitable-zone | yes |
| `nasa-voyager1` | NASA Science (n.d.). *Voyager 1: The Farthest Spacecraft*. NASA Science (web page). https://science.nasa.gov/mission/voyager/voyager-1/ | concept-drive-fiction | yes |
| `nasa-voyager-factsheet` | NASA Science (n.d.). *Voyager Fact Sheet*. NASA Science (web page). https://science.nasa.gov/mission/voyager/fact-sheet/ | neptune, uranus | yes |

### Solar System science

| Key | Reference | Used by | Verified |
|---|---|---|---|
| `agnor2006` | Agnor, C. B. & Hamilton, D. P. (2006). *Neptune's capture of its moon Triton in a binary–planet gravitational encounter*. Nature 441, 192-194. doi:10.1038/nature04792 | triton | yes |
| `bolton2017` | Bolton, S. J. et al. (2017). *Jupiter’s interior and deep atmosphere: The initial pole-to-pole passes with the Juno spacecraft*. Science 356, 821-825. doi:10.1126/science.aal2108 | jupiter | yes |
| `bouvier2010` | Bouvier, A. & Wadhwa, M. (2010). *The age of the Solar System redefined by the oldest Pb–Pb age of a meteoritic inclusion*. Nature Geoscience 3, 637-641. doi:10.1038/ngeo941 | sun | yes |
| `canup2001` | Canup, R. M. & Asphaug, E. (2001). *Origin of the Moon in a giant impact near the end of the Earth's formation*. Nature 412, 708-712. doi:10.1038/35089010 | moon | yes |
| `connelly2012` | Connelly, J. N. et al. (2012). *The Absolute Chronology and Thermal Processing of Solids in the Solar Protoplanetary Disk*. Science 338, 651-655. doi:10.1126/science.1226919 | sun | yes |
| `elliot1977` | Elliot, J. L. et al. (1977). *The rings of Uranus*. Nature 267, 328-330. doi:10.1038/267328a0 | uranus | yes |
| `fulchignoni2005` | Fulchignoni, M. et al. (2005). *In situ measurements of the physical characteristics of Titan's environment*. Nature 438, 785-791. doi:10.1038/nature04314 | titan | yes |
| `grotzinger2014` | Grotzinger, J. P. et al. (2014). *A Habitable Fluvio-Lacustrine Environment at Yellowknife Bay, Gale Crater, Mars*. Science 343, 1242777. doi:10.1126/science.1242777 | mars | yes |
| `grundy2016` | Grundy, W. M. et al. (2016). *The formation of Charon’s red poles from seasonally cold-trapped volatiles*. Nature 539, 65-68. doi:10.1038/nature19340 | charon | yes |
| `hyodo2025` | Hyodo, R. et al. (2025). *Pollution resistance of Saturn’s ring particles during micrometeoroid impact*. Nature Geoscience 18, 44-49. doi:10.1038/s41561-024-01598-9 | saturn | yes |
| `iess2019` | Iess, L. et al. (2019). *Measurement and implications of Saturn’s gravity field and ring mass*. Science 364, eaat2965. doi:10.1126/science.aat2965 | saturn | yes |
| `kempf2023` | Kempf, S. et al. (2023). *Micrometeoroid infall onto Saturn’s rings constrains their age to no more than a few hundred million years*. Science Advances 9, eadf8537. doi:10.1126/sciadv.adf8537 | saturn | yes |
| `khurana1998` | Khurana, K. K. et al. (1998). *Induced magnetic fields as evidence for subsurface oceans in Europa and Callisto*. Nature 395, 777-780. doi:10.1038/27394 | callisto, europa | yes |
| `kivelson1996` | Kivelson, M. G. et al. (1996). *Discovery of Ganymede's magnetic field by the Galileo spacecraft*. Nature 384, 537-541. doi:10.1038/384537a0 | ganymede | yes |
| `kivelson2000` | Kivelson, M. G. et al. (2000). *Galileo Magnetometer Measurements: A Stronger Case for a Subsurface Ocean at Europa*. Science 289, 1340-1343. doi:10.1126/science.289.5483.1340 | europa | yes |
| `lawrence2013` | Lawrence, D. J. et al. (2013). *Evidence for Water Ice Near Mercury’s North Pole from MESSENGER Neutron Spectrometer Measurements*. Science 339, 292-296. doi:10.1126/science.1229953 | mercury | yes |
| `morabito1979` | Morabito, L. A. et al. (1979). *Discovery of Currently Active Extraterrestrial Volcanism*. Science 204, 972-972. doi:10.1126/science.204.4396.972 | io | yes |
| `nimmo2017` | Nimmo, F. et al. (2017). *Mean radius and shape of Pluto and Charon from New Horizons images*. Icarus 287, 12-29. doi:10.1016/j.icarus.2016.06.027 | charon, pluto | yes |
| `peale1979` | Peale, S. J. et al. (1979). *Melting of Io by Tidal Dissipation*. Science 203, 892-894. doi:10.1126/science.203.4383.892 | io | yes |
| `porco2006` | Porco, C. C. et al. (2006). *Cassini Observes the Active South Pole of Enceladus*. Science 311, 1393-1401. doi:10.1126/science.1123013 | enceladus | yes |
| `postberg2023` | Postberg, F. et al. (2023). *Detection of phosphates originating from Enceladus’s ocean*. Nature 618, 489-493. doi:10.1038/s41586-023-05987-9 | enceladus | yes |
| `saur2015` | Saur, J. et al. (2015). *The search for a subsurface ocean in Ganymede with Hubble Space Telescope observations of its auroral ovals*. Journal of Geophysical Research: Space Physics 120, 1715-1737. doi:10.1002/2014JA020778 | ganymede | yes |
| `smith1989` | Smith, B. A. et al. (1989). *Voyager 2 at Neptune: Imaging Science Results*. Science 246, 1422-1449. doi:10.1126/science.246.4936.1422 | neptune, triton | yes |
| `smith2001mola` | Smith, D. E. et al. (2001). *Mars Orbiter Laser Altimeter: Experiment summary after the first year of global mapping of Mars*. Journal of Geophysical Research: Planets 106, 23689-23722. doi:10.1029/2000JE001364 | concept-game-surfaces, mars | yes |
| `soderblom1990` | Soderblom, L. A. et al. (1990). *Triton's Geyser-Like Plumes: Discovery and Basic Characterization*. Science 250, 410-415. doi:10.1126/science.250.4979.410 | triton | yes |
| `stern2015` | Stern, S. A. et al. (2015). *The Pluto system: Initial results from its exploration by New Horizons*. Science 350, aad1815. doi:10.1126/science.aad1815 | pluto | yes |
| `stofan2007` | Stofan, E. R. et al. (2007). *The lakes of Titan*. Nature 445, 61-64. doi:10.1038/nature05438 | titan | yes |
| `thomas2016` | Thomas, P. et al. (2016). *Enceladus's measured physical libration requires a global subsurface ocean*. Icarus 264, 37-47. doi:10.1016/j.icarus.2015.08.037 | enceladus | yes |
| `tomasko2005` | Tomasko, M. G. et al. (2005). *Rain, winds and haze during the Huygens probe's descent to Titan's surface*. Nature 438, 765-778. doi:10.1038/nature04126 | titan | yes |
| `waite2017` | Waite, J. H. et al. (2017). *Cassini finds molecular hydrogen in the Enceladus plume: Evidence for hydrothermal processes*. Science 356, 155-159. doi:10.1126/science.aai8703 | enceladus | yes |

### Other sources in the registry (added by other modules)

| Key | Reference | Used by | Verified |
|---|---|---|---|
| `costa2006` | Costa, E., Mendez, R. A., Jao, W.-C., Henry, T. J., Subasavage, J. P. & Ianna, P. A. (2006). *The Solar Neighborhood. XVI. Parallaxes from CTIOPI: Final Results from the 1.5 m Telescope Program*. The Astronomical Journal 132, 1234-1247. doi:10.1086/505706 | systems/trappist-1.json | yes |
| `dewit2018` | de Wit, J., Wakeford, H. R., Lewis, N. K. et al. (2018). *Atmospheric reconnaissance of the habitable-zone Earth-sized planets orbiting TRAPPIST-1*. Nature Astronomy 2, 214-219. doi:10.1038/s41550-017-0374-z | systems/trappist-1.json | yes |
| `gaia-dr2` | Gaia Collaboration, Brown, A. G. A. et al. (2018). *Gaia Data Release 2. Summary of the contents and survey properties*. Astronomy & Astrophysics 616, A1. doi:10.1051/0004-6361/201833051 | (registry only) | yes |
| `gaia-dr3` | Gaia Collaboration, Vallenari, A. et al. (2023). *Gaia Data Release 3. Summary of the content and survey properties*. Astronomy & Astrophysics 674, A1. doi:10.1051/0004-6361/202243940 | systems/trappist-1.json | yes |
| `garcia2022` | Garcia, L. J., Moran, S. E., Rackham, B. V. et al. (2022). *HST/WFC3 transmission spectroscopy of the cold rocky planet TRAPPIST-1h*. Astronomy & Astrophysics 665, A19. doi:10.1051/0004-6361/202142603 | systems/trappist-1.json | yes |
| `gladman1996` | Gladman, B., Quinn, D. D., Nicholson, P. & Rand, R. (1996). *Synchronous Locking of Tidally Evolving Satellites*. Icarus 122, 166-192. doi:10.1006/icar.1996.0117 | (registry only) | yes |
| `grimm2018` | Grimm, S. L., Demory, B.-O., Gillon, M. et al. (2018). *The nature of the TRAPPIST-1 exoplanets*. Astronomy & Astrophysics 613, A68. doi:10.1051/0004-6361/201732233 | systems/trappist-1.json | yes |
| `nasa-exoplanet-archive-pscomppars` | NASA Exoplanet Science Institute (2020). *Planetary Systems Composite Table*. NASA Exoplanet Archive, IPAC/Caltech (queried through the TAP service). doi:10.26133/NEA13 | (registry only) | yes |
| `piaulet-ghorayeb2025` | Piaulet-Ghorayeb, C., Benneke, B., Turbet, M. et al. (2025). *Strict Limits on Potential Secondary Atmospheres on the Temperate Rocky Exo-Earth TRAPPIST-1 d*. The Astrophysical Journal 989, 181. doi:10.3847/1538-4357/adf207 | systems/trappist-1.json | yes |
| `stassun2019` | Stassun, K. G., Oelkers, R. J., Paegert, M. et al. (2019). *The Revised TESS Input Catalog and Candidate Target List (TICv8)*. The Astronomical Journal 158, 138. doi:10.3847/1538-3881/ab3467 | systems/trappist-1.json | yes |
| `turbet2018` | Turbet, M., Bolmont, E., Leconte, J. et al. (2018). *Modeling climate diversity, tidal dynamics and the fate of volatiles on TRAPPIST-1 planets*. Astronomy & Astrophysics 612, A86. doi:10.1051/0004-6361/201731620 | systems/trappist-1.json | yes |
| `vinson2019` | Vinson, A. M., Tamayo, D. & Hansen, B. M. S. (2019). *The chaotic nature of TRAPPIST-1 planetary spin states*. Monthly Notices of the Royal Astronomical Society 488, 5739-5747. doi:10.1093/mnras/stz2113 | (registry only) | yes |

<!-- citation-registry:end -->
