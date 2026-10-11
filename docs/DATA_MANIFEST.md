# Known Sky: Data Manifest

Every external dataset and asset the game uses: where it came from, its license or terms, the credit it asks for, what we derived from it, and where the derived files live. Raw downloads are fetched once by `tools/pipeline/download.sh` into `tools/.cache/raw/` (not committed) and processed offline by `tools/pipeline/*.py` into `public/data/`. The game never calls these services at runtime.

**How terms were checked.** On 2026-10-11 a research pass read each provider's own pages (license files, product pages, usage policies) and quoted them. "Verified" means the terms were read on the provider's page that day. "Partial" means the general policy was read but a product-specific page was unreachable. Licenses of derived files are listed in `ASSETS_LICENSE.md`.

**NASA, ESA, USGS, NOAA and JPL marks.** The game uses no agency logos or insignia and implies no endorsement by any agency (NASA Images and Media Usage Guidelines; ESA terms; USGS Visual Identity rules).

## Datasets

| # | Dataset | Source (raw input) | License / terms (status) | Credit and citation | Derived files |
|---|---|---|---|---|---|
| 1 | **JPL Horizons** state vectors: Sun, planets, Pluto, 20 moons, system barycentres | `https://ssd.jpl.nasa.gov/api/horizons.api`, queried offline by `tools/pipeline/ephemeris.py`, one request at a time, cached | No license statement for numeric output; SSD API Fair Use Policy applies ("You may not embed these APIs in your website"). We fetch offline and commit fitted coefficients only. (partial: no explicit redistribution grant or prohibition) | Giorgini, J.D. and JPL Solar System Dynamics Group, NASA/JPL Horizons On-Line Ephemeris System, https://ssd.jpl.nasa.gov/horizons/, data retrieved 2026-10-10 | `public/data/ephemeris.bin`, `ephemeris.json` (Chebyshev fits, Known Sky format) |
| 2 | **NAIF generic PCK** `pck00011.tpc` (IAU WGCCRE 2015 radii and rotation) and `gm_de440.tpc` (GM values) | `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/` | NAIF "Rules Regarding Use of SPICE": kernels may be used by anyone; only unmodified kernels may be redistributed under NAIF's name. We do not ship the kernels; we extract numeric values into our own file, labelled as derived by Known Sky. (verified) | Archinal, B.A. et al. (2018), "Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements: 2015", Celest. Mech. Dyn. Astron. 130:22, doi:10.1007/s10569-017-9805-5. Acton, C.H. (1996), Planet. Space Sci. 44(1), 65-70. | `public/data/bodies.json` |
| 3 | **HYG Database v4.1** | `github.com/astronexus/HYG-Database`, `hyg/CURRENT/hygdata_v41.csv` (repository archived 2025-02-14; maintained at codeberg.org/astronexus/hyg, now v4.4) | **CC BY-SA 4.0** (verified). Share-alike: derived star files are CC BY-SA 4.0. | "HYG Database v4.1 by David Nash (astronexus), https://codeberg.org/astronexus/hyg, CC BY-SA 4.0; filtered and converted." | `public/data/stars.bin`, `stars.json` |
| 4 | **ESA Gaia EDR3 all-sky colour map**, equirectangular, 16000×8000 ("The colour of the sky from Gaia's Early Data Release 3") | `https://sci.esa.int/documents/33580/35361/Gaia_EDR3_flux_cartesian_16k.png` | **CC BY-SA 3.0 IGO** (verified). ESA also offers its non-commercial Standard Licence; we use only the CC option. Share-alike: the derived texture is CC BY-SA 3.0 IGO. | "ESA/Gaia/DPAC; CC BY-SA 3.0 IGO. Acknowledgement: A. Moitinho." Modified: downsampled to 8192×4096, WebP. | `public/data/tex/milky_way_gaia.webp` |
| 5 | **NASA SVS CGI Moon Kit** (SVS 4720): LROC WAC colour map (2019) and LOLA elevation `ldem_16` | `https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/` | Public domain (SVS: "All of our content is in the public domain (unless otherwise noted)"). (verified) SVS notes the colour map "is optimized for aesthetics, not science". | "NASA's Scientific Visualization Studio" (Ernie Wright, USRA; Noah Petro, NASA/GSFC). Data: LRO LOLA team; LROC WAC (Arizona State University). | `public/data/tiles/moon/*`, `tex/moon_lo.webp`, `heights/moon.i16z` |
| 6 | **NASA Blue Marble Next Generation**, July 2004, 21600×10800 | `https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74092/world.200407.3x21600x10800.jpg` | NASA media, not subject to copyright in the US; used under the NASA Images and Media Usage Guidelines. (verified for credit; the legacy Earth Observatory image-use page was unreachable) | "NASA Earth Observatory." Stöckli, R., Vermote, E., Saleous, N., Simmon, R. and Herring, D. (2005), "The Blue Marble Next Generation: a true color earth dataset including seasonal dynamics from MODIS", NASA Earth Observatory. | `public/data/tiles/earth/*`, `tex/earth_lo.webp` |
| 7 | **NASA Black Marble 2016** night lights, 3 km | `https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg` | NASA media under the Usage Guidelines. (partial: the record page is retired; credit taken from the companion Earth Observatory article and SVS 30876) | "NASA Earth Observatory images by Joshua Stevens, using Suomi NPP VIIRS data from Miguel Román, NASA GSFC." | `public/data/tex/earth_night_clouds.webp` (RGB channels) |
| 8 | **NASA Blue Marble clouds** (2002), 8192×4096 | `https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif` | NASA media under the Usage Guidelines. (verified for credit on the collection page) | "NASA Goddard Space Flight Center Image by Reto Stöckli (land surface, shallow water, clouds). Enhancements by Robert Simmon." | `public/data/tex/earth_night_clouds.webp` (alpha channel) |
| 9 | **NOAA ETOPO 2022** global relief, 60 arc-second surface elevation, subsampled to 4 arc-minutes | NCEI THREDDS NCSS subset of `ETOPO_2022_v1_60s_N90W180_surface.nc` (`var=z&horizStride=4`) | **CC0 1.0** (verified, NCEI ISO metadata record). | NOAA National Centers for Environmental Information (2022), "ETOPO 2022 15 Arc-Second Global Relief Model", doi:10.25921/fd45-gt74, accessed 2026-10-10. | `public/data/heights/earth.i16z`, `earth.json` |
| 10 | **Solar System Scope** planet textures: Mercury, Venus atmosphere, Mars, Jupiter, Saturn, Saturn rings, Uranus, Neptune | `https://www.solarsystemscope.com/textures/download/` (`8k_mercury.jpg`, `4k_venus_atmosphere.jpg`, `8k_mars.jpg`, `8k_jupiter.jpg`, `8k_saturn.jpg`, `8k_saturn_ring_alpha.png`, `2k_uranus.jpg`, `2k_neptune.jpg`) | **CC BY 4.0** (verified). | "Planet textures by Solar System Scope (INOVE s.r.o.), https://www.solarsystemscope.com/textures/, CC BY 4.0; resampled and converted to WebP." (Credit line written by us; the provider names none.) **Accuracy:** artist composites "based on NASA elevation and imagery data", colours "slightly more saturated", and unmapped gaps "filled with fictional terrain". The Codex labels them as artist-processed. | `public/data/tex/{mercury,venus_clouds,mars,jupiter,saturn,uranus,neptune}.webp`, `tex/saturn_rings.png` |
| 11 | **USGS Astrogeology: Pluto and Charon** New Horizons LORRI/MVIC global mosaics, 300 m (Jul 2017) | `https://planetarymaps.usgs.gov/mosaic/{Pluto,Charon}_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif` | Public domain ("Sources/Usage: Public Domain"; use constraint "Please cite authors"). (verified) | "NASA/JHU APL/SwRI/LPI (New Horizons Team), published by USGS Astrogeology Science Center." Schenk, P. et al. (2018), Icarus 314, 400-433 (Pluto) and Icarus 315, 124-145 (Charon). Pluto south of ~30°S was in darkness during the flyby. | `public/data/tex/pluto.webp`, `charon.webp` |
| 12 | **USGS Astrogeology: Titan** Cassini ISS global mosaic, 4 km (P19658), near-infrared (938 nm) | `https://planetarymaps.usgs.gov/mosaic/Titan_ISS_P19658_Mosaic_Global_4km.tif` | USGS policy: "USGS-authored or produced data and information are considered to be in the U.S. Public Domain". (partial: this product page was not read) | "NASA/JPL-Caltech/Space Science Institute (Cassini ISS), published by USGS Astrogeology Science Center." The map shows Titan's surface in near-infrared; in visible light Titan's haze hides the surface. | `public/data/tex/titan.webp` (drawn faintly under the haze deck, D-032) |
| 13 | **USGS Astrogeology: Enceladus** Cassini ISS global mosaic, 100 m | `https://planetarymaps.usgs.gov/mosaic/Enceladus_Cassini_ISS_Global_Mosaic_100m_HPF.tif` | USGS public domain under the same policy. (partial: product page not read) | "NASA/JPL-Caltech/Space Science Institute (Cassini ISS), published by USGS Astrogeology Science Center." | `public/data/tex/enceladus.webp` |
| 14 | **USGS Astrogeology: Io, Europa, Ganymede, Callisto** Galileo SSI / Voyager global mosaics; **Triton** Voyager 2 colour mosaic; **Phobos** Viking mosaic | `https://planetarymaps.usgs.gov/mosaic/` (`Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif`, `Europa_Voyager_GalileoSSI_global_mosaic_500m.tif`, `Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif`, `Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif`, `Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif`, `Phobos_Viking_Mosaic_40ppd_DLRcontrol.tif`) | USGS public domain under the same policy. (partial: product pages not read) | "NASA/JPL (Galileo SSI, Voyager, Viking), published by USGS Astrogeology Science Center." Triton: Voyager 2 imaged under half the globe; the rest is fill. | `public/data/tex/{io,europa,ganymede,callisto,triton,phobos}.webp` |
| 15 | **NASA 3D Resources: Deimos** map | `github.com/nasa/NASA-3D-Resources`, `Images and Textures/Mars - Deimos/` | Repository README: free and without copyright, per the NASA Images and Media Usage Guidelines (the `meta.json` NOSA tag is catalogue metadata for software). (partial: credit names JPL, whose image use policy was unreachable) | "NASA/JPL/Solar System Simulator." Longitude orientation of this map is not georeferenced and is unverified. | `public/data/tex/deimos.webp` |

### Formerly used, now replaced

| Asset | Why replaced | Replaced by |
|---|---|---|
| NASA 3D Resources "Saturn - Titan" | NASA describes it as a **fictional** concept texture. Showing it as Titan's surface would break the honesty rule. | #12 Cassini ISS mosaic |
| NASA 3D Resources Enceladus, Io, Europa, Ganymede, Callisto, Triton, Phobos | Not georeferenced (orientation unverified); credits name JPL/Caltech under a policy we could not read. | #13, #14 USGS mosaics |
| JPL DE421 via the `skyfield-data` wheel; Horizons-free analytic moon theories | Network access opened mid-project (D-021). | #1 Horizons |

## Numbers and models taken from publications

| Value or model | Source | Used in |
|---|---|---|
| Astronomical unit, speed of light, parsec, light-year | IAU 2012 Resolution B2; IAU 2015 Resolution B2 | `src/core/constants.ts` |
| Nominal solar radius, luminosity, effective temperature, absolute bolometric magnitude 4.74 | IAU 2015 Resolution B3 and B2 | `src/core/constants.ts`, `src/world/starCatalog.ts` |
| Leap seconds (TAI−UTC) | IERS Bulletin C | `src/core/time.ts` |
| Earth rotation angle | IERS Conventions (2010), Eq. 5.15 | `src/core/time.ts` |
| ICRS→Galactic rotation | ESA (1997), The Hipparcos and Tycho Catalogues, Vol. 1, Sec. 1.5.3 | `src/render/starfield.ts`, `src/game/map/mapView.ts` |
| B−V → effective temperature | Ballesteros, F.J. (2012), EPL 97, 34008 | `src/world/starCatalog.ts` |
| Bolometric correction BC_V(T_eff) | Flower, P.J. (1996), ApJ 469, 355, with corrected coefficients from Torres, G. (2010), AJ 140, 1158 | `src/world/starCatalog.ts` |
| Titan visible geometric albedo spectrum | Karkoschka, E. (1994), Icarus 111, 174-192 | `bodies.json` Titan haze deck |
| Titan haze vertical optical depth (~4-5, visible) | Tomasko, M.G. et al. (2008), Planet. Space Sci. 56, 669-707 | D-032 rationale |
| Geometric albedos | NASA planetary fact sheets (Williams, NSSDCA) and satellite fact sheets | `tools/pipeline/bodies.py` |
| Mean obliquity of the ecliptic at J2000 (23.4392911°) | IAU 2006 precession (Capitaine et al. 2003) | `src/game/map/mapView.ts` (fallback only) |
| α Centauri A radius and luminosity (test reference only) | Kervella, P. et al. (2017), A&A 597, A137 | `tests/unit/stars.test.ts` |

## Generated and approximated content

These are not data. The game labels them **Generated** (or **Inferred** where derived from measurements) and never presents them as fact.

| Content | Method | Label |
|---|---|---|
| Terrain detail finer than the source elevation grid (Earth below ~7 km, Moon below ~3.8 km), and all relief on bodies without elevation data | Deterministic fractal noise and crater fields seeded by body id (`src/world/planet/heights.ts`) | Generated |
| Atmosphere scattering parameters | Earth: Bruneton's (2017) parameter set built from measured air properties (Bruneton and Neyret 2008). Venus, Mars, Titan and the giant planets: tuned by eye to resemble spacecraft imagery (`bodies.json` atmosphere `source`) | Earth: Inferred; others: Generated |
| Radius, temperature and luminosity of visited stars | Inferred from catalogue M_V and B−V (D-027) | Inferred |
| Unimaged areas of Pluto (31.9%), Charon (34.0%), Triton (38.6%), Europa (4.3%), Ganymede (3.5%), Callisto (3.8%) | Filled with the map's mean albedo (`imagery.json` records each fraction) | Generated |
| Cockpit model, HUD, audio | Procedural, written for this project | Original work (see `ASSETS_LICENSE.md`) |

## Open items

- Read the JPL Image Use Policy and the legacy Earth Observatory image-use page from an unrestricted network (both returned 403/redirects on 2026-10-11) and record their wording for #1, #7 and #15.
- Confirm the USGS product pages for #12–#14 state "Public Domain" as #11's do (USGS policy covers USGS-produced data; the underlying images are NASA mission data).
- Upgrade candidates: SVS 2025 16-bit Moon colour map; HYG v4.4 (merges duplicate GJ stars, fixes β Phe distance).
