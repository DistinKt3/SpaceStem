#!/usr/bin/env bash
# Fetch raw source data once into tools/.cache/raw (gitignored). Sources and licenses: docs/DATA_MANIFEST.md.
set -euo pipefail
RAW="$(dirname "$0")/../.cache/raw"
mkdir -p "$RAW"
get() { # url [name]
  local url="$1" name="${2:-${1##*/}}"
  if [ -s "$RAW/$name" ]; then echo "have $name"; return; fi
  echo "get  $name"
  curl -sS -L --fail --retry 3 --max-time 1800 -o "$RAW/$name.part" "$url" && mv "$RAW/$name.part" "$RAW/$name"
}
SVS=https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720
get $SVS/lroc_color_poles_8k.tif
get $SVS/ldem_16.tif
EO=https://eoimages.gsfc.nasa.gov/images/imagerecords
get $EO/74000/74092/world.200407.3x21600x10800.jpg
get $EO/144000/144898/BlackMarble_2016_3km.jpg
get $EO/57000/57747/cloud_combined_8192.tif
get "https://www.ngdc.noaa.gov/thredds/ncss/grid/global/ETOPO2022/60s/60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc?var=z&horizStride=4&accept=netcdf3" etopo2022_60s_stride4.nc
SSS=https://www.solarsystemscope.com/textures/download
for f in 8k_mars.jpg 8k_jupiter.jpg 8k_saturn.jpg 8k_saturn_ring_alpha.png 8k_mercury.jpg 8k_venus_surface.jpg 4k_venus_atmosphere.jpg 2k_uranus.jpg 2k_neptune.jpg 8k_sun.jpg 8k_stars_milky_way.jpg; do get $SSS/$f; done
NAIF=https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck
get $NAIF/pck00011.tpc
get $NAIF/gm_de440.tpc
get https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv
echo "done"
ls -la "$RAW"
USGS=https://planetarymaps.usgs.gov/mosaic
get $USGS/Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif
get $USGS/Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif
echo "done (usgs)"
