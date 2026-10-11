"""
Build imagery and elevation assets for the Solar System into public/data/.

- Cube-face tile pyramids (512 px WebP) for Earth and Moon color, sampled with the SAME spherified-cube mapping as
  src/world/planet/cubeSphere.ts so tiles line up with terrain chunks.
- Equirectangular WebP maps for other bodies and for Earth's night lights and clouds.
- Elevation grids (int16 meters, row-delta + gzip, ".i16z") for Earth (ETOPO 2022) and Moon (LOLA).

Usage: tools/.venv/bin/python tools/pipeline/textures.py [--only name,...]
"""
from __future__ import annotations

import gzip
import json
import sys
import time
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "tools" / ".cache" / "raw"
NASA3D = Path("/home/user/nasa/nasa-3d-resources/Images and Textures")
OUT = ROOT / "public" / "data"
TILE = 512

FACES = [
    ((1, 0, 0), (0, 0, -1), (0, 1, 0)),
    ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
    ((0, 1, 0), (1, 0, 0), (0, 0, -1)),
    ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
    ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
    ((0, 0, -1), (-1, 0, 0), (0, 1, 0)),
]


def face_to_sphere(face: int, u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n, t, b = (np.array(a, dtype=np.float64) for a in FACES[face])
    x = n[0] + u * t[0] + v * b[0]
    y = n[1] + u * t[1] + v * b[1]
    z = n[2] + u * t[2] + v * b[2]
    x2, y2, z2 = x * x, y * y, z * z
    return (
        x * np.sqrt(1 - y2 / 2 - z2 / 2 + y2 * z2 / 3),
        y * np.sqrt(1 - z2 / 2 - x2 / 2 + z2 * x2 / 3),
        z * np.sqrt(1 - x2 / 2 - y2 / 2 + x2 * y2 / 3),
    )


def sample_equirect(img: np.ndarray, x: np.ndarray, y: np.ndarray, z: np.ndarray) -> np.ndarray:
    """Bilinear sample of an equirect image (row 0 = north, col 0 = lon -180) at unit directions."""
    H, W = img.shape[:2]
    lat = np.arcsin(np.clip(z, -1, 1))
    lon = np.arctan2(y, x)
    fx = (lon + np.pi) / (2 * np.pi) * W - 0.5
    fy = (np.pi / 2 - lat) / np.pi * H - 0.5
    x0 = np.floor(fx).astype(np.int64)
    y0 = np.floor(fy).astype(np.int64)
    tx = (fx - x0)[..., None]
    ty = (fy - y0)[..., None]
    xa = x0 % W
    xb = (x0 + 1) % W
    ya = np.clip(y0, 0, H - 1)
    yb = np.clip(y0 + 1, 0, H - 1)
    im = img if img.ndim == 3 else img[..., None]
    a = im[ya, xa].astype(np.float32)
    b = im[ya, xb].astype(np.float32)
    c = im[yb, xa].astype(np.float32)
    d = im[yb, xb].astype(np.float32)
    out = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
    return out if img.ndim == 3 else out[..., 0]


def build_pyramid(name: str, img: np.ndarray, lmax: int, quality: int = 82) -> dict:
    """Cube-face tile pyramid: tiles/{name}/{L}/{face}/{x}_{y}.webp, row 0 = +v (top)."""
    base = OUT / "tiles" / name
    total = 0
    count = 0
    n = 1 << lmax
    size = TILE * n
    # Pixel centers in face coordinates, supersampled 2x2 to avoid aliasing.
    for face in range(6):
        t0 = time.time()
        level: dict[tuple[int, int], np.ndarray] = {}
        for ty in range(n):
            for tx in range(n):
                acc = np.zeros((TILE, TILE, 3), np.float32)
                for sy in (0.25, 0.75):
                    for sx in (0.25, 0.75):
                        i = np.arange(TILE)[None, :] + sx
                        j = np.arange(TILE)[:, None] + sy
                        u = -1 + 2 * (tx * TILE + i) / size
                        v = -1 + 2 * (ty * TILE + (TILE - j)) / size
                        x, y, z = face_to_sphere(face, np.broadcast_to(u, (TILE, TILE)), np.broadcast_to(v, (TILE, TILE)))
                        acc += sample_equirect(img, x, y, z)
                level[(tx, ty)] = acc / 4
        L = lmax
        while True:
            d = base / str(L) / str(face)
            d.mkdir(parents=True, exist_ok=True)
            for (tx, ty), tile in level.items():
                p = d / f"{tx}_{ty}.webp"
                Image.fromarray(np.clip(tile + 0.5, 0, 255).astype(np.uint8)).save(p, "WEBP", quality=quality, method=6)
                total += p.stat().st_size
                count += 1
            if L == 0:
                break
            parent: dict[tuple[int, int], np.ndarray] = {}
            m = 1 << (L - 1)
            for ty in range(m):
                for tx in range(m):
                    top = np.concatenate([level[(2 * tx, 2 * ty + 1)], level[(2 * tx + 1, 2 * ty + 1)]], axis=1)
                    bot = np.concatenate([level[(2 * tx, 2 * ty)], level[(2 * tx + 1, 2 * ty)]], axis=1)
                    big = np.concatenate([top, bot], axis=0)
                    parent[(tx, ty)] = big.reshape(TILE, 2, TILE, 2, 3).mean(axis=(1, 3))
            level = parent
            L -= 1
        print(f"  {name} face {face} done in {time.time() - t0:.1f}s")
    print(f"{name}: {count} tiles, {total / 1e6:.1f} MB")
    return {"tileSize": TILE, "maxLevel": lmax, "format": "webp"}


def save_equirect(name: str, img: Image.Image, width: int, quality: int = 85) -> None:
    d = OUT / "tex"
    d.mkdir(parents=True, exist_ok=True)
    im = img.convert("RGB") if img.mode not in ("RGB", "L") else img
    if im.width != width:
        im = im.resize((width, width // 2), Image.LANCZOS)
    p = d / f"{name}.webp"
    im.save(p, "WEBP", quality=quality, method=6)
    print(f"tex {name}: {im.width}x{im.height} {p.stat().st_size / 1e6:.2f} MB")


def save_heights(name: str, meters: np.ndarray, source: str, quantum_m: int = 2) -> None:
    """
    North-up equirect elevation, quantized to quantum_m meters, gradient-predicted (a - left - up + upleft; first row
    uses left, first column uses up), int16 little-endian, gzip. Decoder: src/data/heights.ts.
    """
    d = OUT / "heights"
    d.mkdir(parents=True, exist_ok=True)
    a = np.round(meters / quantum_m).astype(np.int32)
    p_ = a.copy()
    p_[0, 1:] = a[0, 1:] - a[0, :-1]
    p_[1:, 0] = a[1:, 0] - a[:-1, 0]
    p_[1:, 1:] = a[1:, 1:] - a[1:, :-1] - a[:-1, 1:] + a[:-1, :-1]
    if p_.min() < -32768 or p_.max() > 32767:
        raise ValueError("residual out of int16 range")
    out = d / f"{name}.i16z"
    out.write_bytes(gzip.compress(p_.astype("<i2").tobytes(), 9))
    meta = {"width": int(a.shape[1]), "height": int(a.shape[0]), "quantumM": quantum_m,
            "encoding": "int16-gradient-gzip", "units": "m", "source": source,
            "minM": float(a.min() * quantum_m), "maxM": float(a.max() * quantum_m)}
    (d / f"{name}.json").write_text(json.dumps(meta))
    old = d / f"{name}.bin"
    if old.exists():
        old.unlink()
    print(f"heights {name}: {a.shape[1]}x{a.shape[0]} [{meta['minM']}, {meta['maxM']}] m -> {out.stat().st_size / 1e6:.2f} MB")


def srgb_to_linear(a: np.ndarray) -> np.ndarray:
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(a: np.ndarray) -> np.ndarray:
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(np.clip(a, 0, None), 1 / 2.4) - 0.055)


def downsample_masked(a: np.ndarray, width: int) -> np.ndarray:
    """Box-downsample an 8-bit map whose no-data value is 0, averaging only valid samples (normalised convolution),
    so no-data regions do not darken the edges of valid data. Output keeps 0 where nothing valid was averaged."""
    if a.shape[1] <= width:
        return a
    size = (width, width // 2)
    gray = a if a.ndim == 2 else a.max(axis=-1)
    mask = Image.fromarray(((gray > 0) * 255).astype(np.uint8)).resize(size, Image.BOX)
    m = np.asarray(mask).astype(np.float32) / 255.0
    chans = [a] if a.ndim == 2 else [a[..., c] for c in range(a.shape[-1])]
    out = []
    for ch in chans:
        v = np.asarray(Image.fromarray(ch).resize(size, Image.BOX)).astype(np.float32)
        out.append(np.where(m > 0.05, v / np.maximum(m, 1e-3), 0))
    r = np.clip(np.stack(out, -1) if len(out) > 1 else out[0], 0, 255).astype(np.uint8)
    if r.ndim == 2:
        r[m <= 0.05] = 0
    else:
        r[m <= 0.05] = 0
    return r


def fill_and_calibrate(a: np.ndarray, target: float) -> tuple[np.ndarray, float, float]:
    """Fill no-data (0) with the area-weighted mean of valid pixels (labelled Generated in the Codex). Reflectance is
    not remapped here: bodies.py applies a linear albedo scale so the map's mean matches the measured geometric albedo
    while keeping the data's contrast. `target` is recorded for reference. Returns (image, fraction filled, 1.0)."""
    img = a.astype(np.float32) / 255.0
    gray = img if img.ndim == 2 else img.max(axis=-1)
    valid = gray > 0
    filled = 1.0 - float(valid.mean())
    lin = srgb_to_linear(img)
    lum = lin if lin.ndim == 2 else 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
    h = lum.shape[0]
    wlat = np.cos((np.arange(h) + 0.5) / h * np.pi - np.pi / 2)[:, None] * np.ones_like(lum)
    wv = wlat * valid

    def mean(x: np.ndarray) -> float:
        return float((x * wv).sum() / wv.sum())

    out = lin
    g = 1.0
    if out.ndim == 2:
        out = np.where(valid, out, mean(lum))
    else:
        fillc = np.array([float((out[..., c] * wv).sum() / wv.sum()) for c in range(3)])
        out = np.where(valid[..., None], out, fillc)
    return (np.clip(linear_to_srgb(out), 0, 1) * 255 + 0.5).astype(np.uint8), filled, g


def load_rgb(path: Path) -> np.ndarray:
    if path.suffix.lower() in (".tif", ".tiff"):
        a = tifffile.imread(path)
        if a.dtype != np.uint8:
            a = (a / (a.max() / 255.0)).astype(np.uint8)
        if a.ndim == 3 and a.shape[2] > 3:
            a = a[..., :3]
        return a
    return np.asarray(Image.open(path).convert("RGB"))


def main() -> None:
    only = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
    want = lambda k: only is None or k in only  # noqa: E731
    manifest_path = OUT / "imagery.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"tiles": {}, "tex": {}}

    if want("earth_tiles"):
        img = load_rgb(RAW / "world.200407.3x21600x10800.jpg")
        manifest["tiles"]["earth"] = build_pyramid("earth", img, 3)
        save_equirect("earth_lo", Image.fromarray(img), 2048)
        del img
    if want("moon_tiles"):
        img = load_rgb(RAW / "lroc_color_poles_8k.tif")
        manifest["tiles"]["moon"] = build_pyramid("moon", img, 2)
        save_equirect("moon_lo", Image.fromarray(img), 2048)
        del img
    if want("earth_aux"):
        # One 8k RGBA texture: Black Marble 2016 city lights in RGB, cloud cover in alpha (halves GPU memory).
        night = Image.open(RAW / "BlackMarble_2016_3km.jpg").convert("RGB").resize((8192, 4096), Image.LANCZOS)
        clouds = tifffile.imread(RAW / "cloud_combined_8192.tif")
        if clouds.ndim == 3:
            clouds = clouds[..., 0]
        cl = Image.fromarray(clouds).convert("L").resize((8192, 4096), Image.LANCZOS)
        rgba = night.copy()
        rgba.putalpha(cl)
        (OUT / "tex").mkdir(parents=True, exist_ok=True)
        p = OUT / "tex" / "earth_night_clouds.webp"
        rgba.save(p, "WEBP", quality=80, alpha_quality=40, method=6)
        print(f"tex earth_night_clouds: 8192x4096 RGBA {p.stat().st_size / 1e6:.2f} MB")
        for old in ("earth_night.webp", "earth_clouds.webp"):
            if (OUT / "tex" / old).exists():
                (OUT / "tex" / old).unlink()
    if want("planets"):
        sss = {"mercury": ("8k_mercury.jpg", 4096), "venus_clouds": ("4k_venus_atmosphere.jpg", 2048),
               "mars": ("8k_mars.jpg", 4096), "jupiter": ("8k_jupiter.jpg", 4096), "saturn": ("8k_saturn.jpg", 2048),
               "uranus": ("2k_uranus.jpg", 2048), "neptune": ("2k_neptune.jpg", 2048)}
        for k, (f, w) in sss.items():
            save_equirect(k, Image.open(RAW / f), w)
        # Titan and Enceladus come from USGS Cassini mosaics (see "dwarfs"); NASA 3D Resources' Titan map is a concept.
        # Only Deimos still comes from NASA 3D Resources (no USGS global mosaic); the others use USGS mosaics below.
        nasa = {"deimos": "Mars - Deimos"}
        for k, folder in nasa.items():
            im = Image.open(NASA3D / folder / f"{folder}.jpg")
            save_equirect(k, im, min(2048, im.width))
        ring = Image.open(RAW / "8k_saturn_ring_alpha.png")
        (OUT / "tex").mkdir(parents=True, exist_ok=True)
        ring.save(OUT / "tex" / "saturn_rings.png", optimize=True)
        print("tex saturn_rings", ring.size, ring.mode)
    if want("dwarfs"):
        # USGS Astrogeology mosaics: equirectangular with the centre longitude in the GeoTIFF keys (usually 180, i.e.
        # left edge 0 E, east to the right). The game expects centre longitude 0, so the image is rolled accordingly.
        # Checked on known features: Pluto's Sputnik Planitia (~175 E) and Titan's Xanadu (~100 W) are brightest at
        # 150-210 and 210-300 degrees from the left edge of the original files.
        calib: dict[str, dict] = {}
        # Geometric albedos come from bodies.json (built by bodies.py), keyed here by texture name.
        albedo = {b["key"]: b["geometricAlbedo"] for b in json.loads((OUT / "bodies.json").read_text())["bodies"]}
        usgs = (("pluto", "Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif"),
                ("charon", "Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif"),
                ("titan", "Titan_ISS_P19658_Mosaic_Global_4km.tif"),
                ("enceladus", "Enceladus_Cassini_ISS_Global_Mosaic_100m_HPF.tif"),
                ("io", "Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif"),
                ("europa", "Europa_Voyager_GalileoSSI_global_mosaic_500m.tif"),
                ("ganymede", "Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif"),
                ("callisto", "Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif"),
                ("triton", "Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif"),
                ("phobos", "Phobos_Viking_Mosaic_40ppd_DLRcontrol.tif"))
        for k, f in usgs:
            p = RAW / f
            if not p.exists():
                print(f"skip {k}: {f} missing")
                continue
            with tifffile.TiffFile(p) as tf:
                geo = tf.geotiff_metadata or {}
                a = tf.asarray()
            center = float(geo.get("ProjCenterLongGeoKey", geo.get("ProjNatOriginLongGeoKey", 180.0)))
            if a.ndim == 3 and a.shape[0] in (3, 4) and a.shape[-1] not in (3, 4):
                a = np.moveaxis(a, 0, -1)  # planar -> interleaved
            if a.ndim == 3:
                a = a[..., :3] if a.shape[-1] >= 3 else a[..., 0]
            if a.dtype != np.uint8:
                # Stretch to 8 bits on the 0.5-99.5 percentile range of valid (finite, non-nodata) samples.
                af = a.astype(np.float32)
                valid = np.isfinite(af) & (af > -1e30)
                lo, hi = np.percentile(af[valid], [0.5, 99.5])
                a = (np.clip((np.where(valid, af, lo) - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)
            # Pixel x is at longitude center - 180 + 360 x / w (east to the right); the game wants center 0.
            a = np.roll(a, int(round(center / 360 * a.shape[1])) % a.shape[1], axis=1)
            a = downsample_masked(a, 4096)
            target = min(albedo[k], 0.9)
            a, filled, g = fill_and_calibrate(a, target)
            calib[k] = {"centreLonDeg": center, "filledFraction": round(filled, 4), "albedoTarget": target,
                        "albedoRemap": "none (linear albedoScale in bodies.json)"}
            print(f"{k}: centre longitude {center}, shape {a.shape}, filled {filled:.1%}, target {target}")
            im = Image.fromarray(a)
            save_equirect(k, im.convert("RGB" if a.ndim == 3 else "L"), 2048)
        manifest["tex"].update(calib)
    if want("heights"):
        from scipy.io import netcdf_file

        with netcdf_file(RAW / "etopo2022_60s_stride4.nc", "r", mmap=False) as nc:
            z = np.array(nc.variables["z"][:], dtype=np.float32)
            lat = np.array(nc.variables["lat"][:])
        if lat[0] < lat[-1]:
            z = z[::-1]
        # Only the sea surface is flown over: clamp the ocean floor to -2 m (one quantum; also the ocean flag at runtime).
        save_heights("earth", np.maximum(z, -2.0), "NOAA ETOPO 2022 60 arc-second surface elevation, every 4th sample (4 arc-minute); ocean floor clamped to -2 m (ocean flag)")
        ldem = tifffile.imread(RAW / "ldem_16.tif").astype(np.float32)  # km relative to 1737.4 km
        # 16 px/deg is downsampled 2x2 to 8 px/deg (~3.8 km) to keep the download small; finer relief is Generated.
        ldem8 = ldem.reshape(ldem.shape[0] // 2, 2, ldem.shape[1] // 2, 2).mean(axis=(1, 3))
        save_heights("moon", ldem8 * 1000.0, "NASA SVS CGI Moon Kit ldem_16 (LRO LOLA) averaged to 8 px/deg; meters above 1737.4 km")

    if want("sky"):
        # ESA Gaia EDR3 flux map, equirectangular galactic coordinates (l increases to the left, b up).
        g = Image.open(RAW / "Gaia_EDR3_flux_cartesian_16k.png").convert("RGB").resize((8192, 4096), Image.LANCZOS)
        (OUT / "tex").mkdir(parents=True, exist_ok=True)
        p = OUT / "tex" / "milky_way_gaia.webp"
        g.save(p, "WEBP", quality=78, method=6)
        print(f"tex milky_way_gaia: 8192x4096 {p.stat().st_size / 1e6:.2f} MB")

    manifest_path.write_text(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
