# TRAPPIST-1 and Codex citation verification (retrieved 2026-10-10)

Companion to `trappist1_verified.json`. Direct fetches of NASA, ESA, arXiv, A&A and IOP hosts failed from the
container. All checks were made with WebSearch result snippets. `verified: true` means the value or citation
appeared in a search result attributable to the named source. Fields marked "(secondary)" in the JSON were seen
only on Wikipedia or an aggregator and should be spot-checked before they are labelled "Measured" in-game.

## Part A: TRAPPIST-1

**Primary paper confirmed:** Agol et al. 2021, "Refining the Transit-timing and Photometric Analysis of
TRAPPIST-1: Masses, Radii, Densities, Dynamics, and Ephemerides", *Planetary Science Journal* 2(1), article 1,
doi:10.3847/PSJ/abd022 (open access, CC BY 4.0; arXiv:2010.01074).
Sources: https://iopscience.iop.org/article/10.3847/PSJ/abd022 ,
https://ntrs.nasa.gov/citations/20210000129 , https://doaj.org/article/1851cb4eb5c443c383b21039f9ea104a

### Star: confirmed
- M = 0.0898 +/- 0.0023 Msun (Mann et al. 2019), R = 0.1192 +/- 0.0013 Rsun, Teff = 2566 +/- 26 K,
  L = 0.000553 +/- 0.000019 Lsun (Ducrot et al. 2020). All four are as adopted in Agol 2021 (NTRS PDF snippet).
  This luminosity error is 0.000019, not 0.000018.
- Age 7.6 +/- 2.2 Gyr: Burgasser & Mamajek 2017, ApJ 845, 110, doi:10.3847/1538-4357/aa7fea.
- Spectral type M8V; RA 23h06m29.368s, Dec -05d02m29.04s; V = 18.798 +/- 0.082; J = 11.354 +/- 0.022;
  proper motion (+930.788, -479.038) mas/yr. All from https://en.wikipedia.org/wiki/TRAPPIST-1 (secondary).
  The star moves about 1 arcsec/yr, so the in-game position must state an epoch.

### Star: UNVERIFIED
- Parallax 80.2123 +/- 0.0716 mas, distance 12.47 pc (1000/plx = 12.467). The value is on Wikipedia, but no
  search result tied it to Gaia DR3. My best-known value is that this is the Gaia (E)DR3 parallax. The Gaia DR2
  value was 80.4512 +/- 0.1211 mas, and the ground-based value was 82.4 +/- 0.8 mas (Van Grootel et al. 2018).
- Gaia DR3 source_id 2635476908753563008 is from a third-party GitHub project only.
- **Action:** query Gaia DR3 (VizieR I/355/gaiadr3) for that source_id from an unblocked machine.

### Planets: confirmed (JSON `planets.*`)
| | P (d) | a (AU) | R (Re) | M (Me) | rho (rho_e) | i (deg) | S (Se) |
|---|---|---|---|---|---|---|---|
| b | 1.510826 | 0.01154 | 1.116 | 1.374+/-0.069 | 0.987 | 89.728 | 4.153 |
| c | 2.421937 | 0.01580 | 1.097 | 1.308+/-0.056 | 0.991 | 89.778 | 2.214* |
| d | 4.049219 | 0.02227 | 0.788 | 0.388+/-0.012 | 0.792 | 89.896 | 1.115 |
| e | 6.101013 | 0.02925 | 0.920 | 0.692+/-0.022 | 0.889 | 89.793 | 0.646 |
| f | 9.207540 | 0.03849 | 1.045 | 1.039+/-0.031 | 0.911 | 89.740 | 0.373* |
| g | 12.352446 | 0.04683 | 1.129 | 1.321+/-0.038 | 0.917 | 89.742 | 0.252* |
| h | 18.772866 | 0.06189 | 0.755 | 0.326+/-0.020 | 0.755 | 89.805 | 0.144* |

Uncertainties and the asymmetric radius and density errors are in the JSON. Where the errors are asymmetric,
the JSON stores the larger one and gives the full +/- pair in `source`. * = unverified (see below).

Where each column was confirmed:
- **Masses:** arXiv:2201.08840 Table 1 (reproduces Agol), plus
  https://www.aanda.org/articles/aa/full_html/2022/02/aa42354-21/T1.html
- **Radii:** Wikipedia planet pages citing Agol, doi:10.3847/1538-4357/add34b (TRAPPIST-1 f interior paper),
  and the NASA Exoplanet Archive overview for g and h.
- **Densities:** Agol NTRS PDF snippet, which gives symmetric errors (b +/-0.050, c +/-0.043, f/g +/-0.029,
  h +/-0.055), and the add34b table, which gives asymmetric errors.
- **Semi-major axes:** aa42354-21 Table 1, in units of 1e-2 au. The error for b was not seen.
- **Inclinations:** the Agol photodynamical table (b-e) and the NASA Exoplanet Archive (d, g, h). For f, only
  Wikipedia (89.740 +/- 0.019) was seen.
- **Insolation:** b (4.153) from an A&A 2025 TRAPPIST-1 b table. d (1.115) and e (0.646) are cited to Agol by
  Way et al. 2025 (ApJL 980, L7).
- **Periods and T0 (BJD_TDB):** the TEPCat pages for b-h, which cite 2021PSJ.....2....1A:
  https://www.astro.keele.ac.uk/jkt/tepcat/planets/TRAPPIST-1b.html (and c..h). The g period is also on the NASA
  Exoplanet Archive. The c T0 came back as 2457258.587287, and I kept the digits as reported.
- **Unit conversion:** density in g/cm^3 = rho_e x 5.514. This gives d = 4.37 and g = 5.06, both matching the
  NASA Exoplanet Archive.

### Planets: UNVERIFIED
- Insolation for c, f, g and h. The JSON holds my best-known Agol values (2.214, 0.373, 0.252, 0.144). They are
  consistent with L/a^2 computed from the verified L and a (2.215, 0.373, 0.252, 0.144).
- **Equilibrium temperature is not in the JSON.** No Agol-attributed Teq was found. The zero-albedo,
  full-redistribution value Teq = 278.6 K x S^0.25 gives b 398, c 340, d 286, e 250, f 218, g 197, h 172 K.
  These match Wikipedia's d/e/f values. Label them "Inferred" if used.
- **Ephemeris caveat (important for any transit clock):** one search snippet, from a third-party GitHub PR,
  says Agol's P/t0 are osculating N-body elements and mispredict 2024 JWST transits by hours. This is
  unconfirmed. Agol et al. 2024 (arXiv:2409.11620) reports that h's transit times drifted by up to tens of minutes
  from the earlier analysis, and it gives updated forecasts. Use the 2021 P/T0 for display only, not for
  predicting transit times.

### JWST (one conservative sentence each in JSON `jwst`)
- Greene et al. 2023, Nature 618, 39-42, doi:10.1038/s41586-023-05951-7 (b, 15 um: consistent with a bare rock,
  no thick atmosphere). The commonly quoted 861 ppm and ~503 K figures were not confirmed and are omitted.
- Zieba et al. 2023, Nature 620, 746-749, doi:10.1038/s41586-023-06232-z (c: 421 +/- 94 ppm, Tb 380 +/- 31 K,
  no thick CO2 atmosphere).
- Ducrot et al. 2025, Nat Astron 9, 358, doi:10.1038/s41550-024-02428-z (b, 12.8 + 15 um: airless fresh
  ultramafic surface OR hazy CO2 atmosphere).
- Gillon et al. 2026, Nat Astron 10, 674, doi:10.1038/s41550-026-02806-9 (b and c phase curves: no thick
  atmosphere). This was published 3 Apr 2026; venue and DOI come from the IPAC and ULiege listings, not the
  journal page.
- Piaulet-Ghorayeb et al. 2025, ApJ 989, 181, doi:10.3847/1538-4357/adf207 (d: flat NIRSpec spectrum).
- Espinoza et al. 2025, ApJL 990, L52, doi:10.3847/2041-8213/adf42e (e: rules out H2-rich atmospheres; the data
  cannot yet tell whether e has an atmosphere). The companion paper is Glidden et al. 2025, ApJL 990, L53; its
  DOI was not seen.

## Part B: exoplanet count
**6,445 confirmed planets as of 2026-10-08**, from the NASA Exoplanet Archive homepage and its 2026 news page
(https://exoplanetarchive.ipac.caltech.edu/docs/exonews_archive.html). Two separate searches returned this
figure, together with the milestone of 1,000 TESS-discovered planets.
- The archive's 2026-09-11 news gave 6,366.
- Wikipedia quoted 6,375 for 2026-10-01. The jump of about 70 in one week is plausible for the TESS batch but
  is worth rechecking.
- The count changes weekly, so the game should show it with its as-of date.

## Part C: citations (all `verified: true` unless noted)
1. **IAU 2012 Resolution B2:** au = 149 597 870 700 m exactly; adopted 30 Aug 2012 in Beijing.
   https://iauarchive.eso.org/static/resolutions/IAU2012_English.pdf ; syrte.obspm.fr summary.
2. **IAU 2015 Resolution B3:** Prsa, A. et al. 2016, AJ 152(2), 41, doi:10.3847/0004-6256/152/2/41.
   R_sun^N = 695 700 km exactly. This is a conversion constant, not a measurement.
3. **Gaia mission:** Gaia Collab., Prusti et al. 2016, A&A 595, A1, doi:10.1051/0004-6361/201629272.
   **Gaia DR3:** Gaia Collab., Vallenari et al. 2023, A&A 674, A1, doi:10.1051/0004-6361/202243940.
4. **Hipparcos:** Perryman et al. 1997, A&A 323, L49-L52, bibcode 1997A&A...323L..49P (no DOI).
   van Leeuwen 2007, "Validation of the new Hipparcos reduction", A&A 474, 653-664,
   doi:10.1051/0004-6361:20078357.
5. **NASA Planetary Fact Sheet:** the index exists, maintained by D. R. Williams, NSSDCA. Volumetric mean radii
   in km, each from its own fact-sheet page: Mercury 2439.7, Venus 6051.8, Earth 6371.0, Moon 1737.4,
   Mars 3389.5, Jupiter 69911, Saturn 58232, Uranus 25362, Neptune 24622, Pluto 1188. Sun 695 700 (IAU nominal).
   These are stored in the extra JSON key `solar_system_mean_radii_km`, which uses the same field format.
   GM values were not checked.
6. **LRO:**
   - LOLA: Smith et al. 2010, GRL 37, L18204, doi:10.1029/2010GL043751.
   - LROC: Robinson et al. 2010, Space Sci Rev 150, 81-124, doi:10.1007/s11214-010-9634-2.
   - The Robinson paper describes the instrument. A dedicated WAC global-mosaic data citation was not searched.
7. **Blue Marble NG:** Stockli, Vermote, Saleous, Simmon & Herring, "The Blue Marble Next Generation - A true
   color earth dataset including seasonal dynamics from MODIS", NASA Earth Observatory, 2005. Some documents
   date it 2006.
8. **ETOPO1:** Amante & Eakins 2009, NOAA Tech. Memo. NESDIS NGDC-24, doi:10.7289/V5C8276M. NCEI now lists
   ETOPO 2022 as current and ETOPO1 under older versions.
9. **Proxima b:** Anglada-Escude et al. 2016, Nature 536, 437-440, doi:10.1038/nature19106.
10. **HYG** (`verified: false` because the year and author are unknown):
    - v4.1 and CC BY-SA 4.0 are confirmed.
    - v4.1 is superseded by v4.2 (June 2025, Codeberg).
    - The v4.1 file is `hyg_v41.csv`.
    - The author name (David Nash) and the release year were not confirmed, so `year` is null.
11. **Parallax and Kepler pages:**
    - ESA: https://www.esa.int/Science_Exploration/Space_Science/Gaia/Parallax and
      https://sci.esa.int/web/gaia/-/53278-measuring-stellar-distances-by-parallax (archived, not updated).
    - Kepler's laws: NASA SVS https://svs.gsfc.nasa.gov/4642 ("Kepler's Laws of Planetary Motion Described
      Using Earth Satellites").
    - The web pages have no publication year, so `year` is null.
12. **Bruneton & Neyret 2008:** "Precomputed Atmospheric Scattering", Computer Graphics Forum 27(4), 1079-1086,
    doi:10.1111/j.1467-8659.2008.01245.x. **UNVERIFIED:** the Rayleigh coefficients
    beta_R = (5.8, 13.5, 33.1)e-6 m^-1 with H_R = 8 km and H_M = 1.2 km. These are best-known values from
    Bruneton's reference code. Searches confirmed only Rg = 6360 km, Rt = 6420 km and beta_M = 2e-5 (as quoted in a
    Chalmers thesis). Cesium uses different defaults.

## Schema notes
- Added one top-level key, `solar_system_mean_radii_km`, for Part C item 5.
- `year` is null for undated web pages, which keeps unknown dates out of the data.
- The name, spectral type, coordinates and ID are stored as strings in `star`.
