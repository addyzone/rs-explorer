#!/usr/bin/env python3
"""
tile_map.py: slice a large map PNG into a zoomable tile pyramid.

This is the reproducible build tool for the RuneScape Adventurers' Map. Run it
whenever a source map image changes (e.g. the game map updates) to regenerate
the tiles the web viewer consumes.

What it produces
----------------
For an input image it writes, under <out_dir>:

    <out_dir>/<z>/<x>/<y>.png     tile images (only non-empty tiles are written)
    <out_dir>/meta.json           metadata the viewer reads

Tile scheme (XYZ-style, custom-friendly)
----------------------------------------
- Tiles are `tile_size` px (default 256).
- `maxZoom` is native resolution (1 source px = 1 tile px).
  Each lower zoom halves the resolution, down to `minZoom` where the whole
  map fits inside a single tile.
- Edge tiles are not padded. They are saved at their true smaller size so the
  map stays pixel-perfect, and the viewer reads per-level dimensions from
  meta.json rather than assuming a power-of-two world.
- Origin (0,0) is the TOP-LEFT of the image. Tile (x, y): x increases right,
  y increases down.

Empty-tile skipping
-------------------
The blank ocean is a single flat colour. Any tile whose every pixel equals the
background colour is skipped (not written). The viewer paints `background`
underneath every tile, so skipped tiles simply show through as ocean. This is
what keeps a mostly-ocean map down to a manageable number of files.

Palette PNGs
------------
Map rasters are flat-colour art, not photographs: a native in-game tile holds
around 130 distinct colours, so storing it as 24-bit RGB wastes roughly half
the bytes. Every tile that fits in 256 colours is therefore written as a
palette PNG, which is exactly lossless: the result is verified pixel for pixel
against the source and falls back to RGB if it somehow isn't. Measured on the
surface map, native tiles went 10.5KB to 5.6KB, a 45% saving.

Downscaled levels blow past 256 colours (averaging pixels invents new ones),
so they stay RGB unless you opt in with --quantize, which re-quantises them to
an adaptive 256-colour palette for about the same 50% saving. That one IS
lossy, hence opt-in.

Usage
-----
    python tools/tile_map.py sources/runescape-surface.png maps/surface/styles/original --name surface

    # Force a specific background instead of auto-detecting from the corner:
    python tools/tile_map.py in.png out --bg 136,144,157

    # Keep alpha (for overlay layers like dungeons):
    python tools/tile_map.py in.png out --keep-alpha

Requires: Pillow (see tools/requirements.txt).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import time
from typing import Optional, Tuple

from PIL import Image, ImageChops

# The source map is far larger than Pillow's default "decompression bomb"
# guard. We trust our own input, so lift the cap.
Image.MAX_IMAGE_PIXELS = None

# Exact 2x2 box averaging is the right filter for building mip levels of flat
# colour art. LANCZOS was the obvious-looking choice but is actively wrong
# here: its negative lobes ring around the hard 1px edges this art is made of,
# haloing every road and wall, and the ringing invents colours. On the surface
# map it turned a 130-colour source tile into about 3,000 and made the PNG 45%
# larger than the BOX version. BOX only averages the four pixels it covers, so
# nothing is invented.
DOWNSCALE_FILTER = Image.BOX


def parse_color(s: str) -> Tuple[int, ...]:
    parts = [int(p) for p in s.split(",")]
    if len(parts) not in (3, 4):
        raise argparse.ArgumentTypeError("color must be 'R,G,B' or 'R,G,B,A'")
    return tuple(parts)


def is_uniform(tile: Image.Image, color: Tuple[int, ...]) -> bool:
    """True if every pixel in `tile` equals `color`.

    Uses getcolors() which is exact and fast for tiles that are a single
    colour (the common ocean case returns a 1-element list immediately).
    """
    colors = tile.getcolors(maxcolors=2)  # returns None if > 2 distinct colours
    if colors is None:
        return False
    if len(colors) != 1:
        return False
    _count, only = colors[0]
    if isinstance(only, int):  # 'L' / 'P' mode single channel
        only = (only,)
    return tuple(only) == tuple(color)


def to_palette(tile: Image.Image, quantize: bool) -> Optional[Image.Image]:
    """Return a palette version of `tile`, or None to keep it as-is.

    A tile holding <= 256 distinct colours converts exactly, so that case is
    always taken, but the result is verified against the source rather than
    trusted and any mismatch falls back to RGB. Losing map pixels to save bytes
    is never an acceptable trade here.

    Tiles with more colours than that only get palettised under `quantize`,
    which picks an adaptive 256-colour palette and IS lossy.
    """
    if tile.mode not in ("RGB", "L"):
        return None  # RGBA overlays keep their alpha; palette+alpha isn't worth it
    if tile.getcolors(maxcolors=256) is not None:
        pal = tile.convert("P", palette=Image.ADAPTIVE, colors=256)
        if ImageChops.difference(pal.convert(tile.mode), tile).getbbox() is None:
            return pal
        return None  # exactness not confirmed, so keep the original bytes
    if quantize:
        return tile.quantize(colors=256, method=Image.MEDIANCUT)
    return None


def parse_levels(s: str) -> list:
    """Parse a comma-separated zoom-level list, e.g. '0,3'."""
    if not s.strip():
        return []
    try:
        return sorted({int(p) for p in s.split(",") if p.strip() != ""})
    except ValueError:
        raise argparse.ArgumentTypeError("levels must be comma-separated integers, e.g. '0,3'")


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def tile_level(
    img: Image.Image,
    z: int,
    out_dir: str,
    tile_size: int,
    bg: Tuple[int, ...],
    skip_empty: bool,
    fmt: str,
    quantize: bool,
) -> Tuple[int, int, int, dict]:
    """Tile a single already-scaled level image.

    Returns (cols, rows, written, present) where `present` maps
    column index -> sorted list of row indices that were written.
    """
    w, h = img.size
    cols = math.ceil(w / tile_size)
    rows = math.ceil(h / tile_size)
    written = 0
    paletted = 0
    present: dict = {}
    for x in range(cols):
        col_dir = os.path.join(out_dir, str(z), str(x))
        made_col = False
        col_rows = []
        for y in range(rows):
            left = x * tile_size
            upper = y * tile_size
            right = min(left + tile_size, w)
            lower = min(upper + tile_size, h)
            tile = img.crop((left, upper, right, lower))
            if skip_empty and is_uniform(tile, bg):
                continue
            if not made_col:
                os.makedirs(col_dir, exist_ok=True)
                made_col = True
            pal = to_palette(tile, quantize)
            if pal is not None:
                paletted += 1
            (pal or tile).save(os.path.join(col_dir, f"{y}.{fmt}"), optimize=True)
            col_rows.append(y)
            written += 1
        if col_rows:
            present[x] = col_rows
        print(f"  z{z} col {x + 1}/{cols} (written so far: {written})", end="\r", flush=True)
    print(f"  z{z}: grid {cols}x{rows} = {cols * rows} tiles, wrote {written}"
          f", skipped {cols * rows - written}, palette {paletted}/{written}      ")
    return cols, rows, written, present


def build(
    src: str,
    out_dir: str,
    name: str,
    tile_size: int,
    bg: Optional[Tuple[int, ...]],
    skip_empty: bool,
    keep_alpha: bool,
    min_zoom: Optional[int],
    min_scale: float,
    overview_levels: list,
    quantize: bool,
    clean: bool,
) -> None:
    t0 = time.time()
    print(f"Loading {src} ...")
    img = Image.open(src)
    img.load()
    src_w, src_h = img.size
    print(f"  source: {src_w}x{src_h} {img.mode}  ({human(os.path.getsize(src))})")

    # Choose colour depth. RGB is smaller; keep RGBA only if requested (overlays).
    target_mode = "RGBA" if keep_alpha else "RGB"
    if img.mode != target_mode:
        img = img.convert(target_mode)

    # Background colour: auto-detect from the top-left pixel unless overridden.
    if bg is None:
        bg = img.getpixel((0, 0))
        if isinstance(bg, int):
            bg = (bg,)
    # Match tuple length to image bands.
    bands = len(img.getbands())
    if len(bg) != bands:
        if len(bg) == 3 and bands == 4:
            bg = bg + (255,)
        elif len(bg) == 4 and bands == 3:
            bg = bg[:3]
    print(f"  background: {bg}  (skip_empty={skip_empty})")

    # Zoom bands.
    #
    # maxZoom = native resolution. The viewer only ever displays levels at (or
    # upscaled from) its zoom ladder, whose most zoomed-out rung is `min_scale`
    # CSS px per world px. The coarsest level it needs as a *target* is
    # therefore `detail_min`. For the surface map that is z5, so z5 to z7 are
    # the only levels ever drawn at full detail.
    #
    # Below that the viewer needs a cheap resident "overview" set purely to
    # back the anti-flash fallback, and it does NOT need a contiguous run of
    # them: each level covers the whole map, so a finer one makes every coarser
    # one redundant except as something to show sooner on a cold load. Hence an
    # explicit list, default z0 and z3, rather than a 0..N band. z0 is one 12KB
    # tile that paints the whole world almost immediately, z3 is the good
    # backdrop at 9 tiles, and z1 and z2 in between only added bytes and draw
    # calls for coverage z3 already provides.
    #
    # Everything else is never used, so it isn't written (we still halve
    # through those levels to build the coarser images). Passing --min-zoom
    # forces a plain contiguous pyramid from that level up instead.
    max_zoom = math.ceil(math.log2(max(src_w, src_h) / tile_size))
    if min_zoom is not None:
        detail_min = max(0, min_zoom)
        backdrop = []  # no separate overview set
        keep = set(range(detail_min, max_zoom + 1))
    else:
        detail_min = max(0, max_zoom + math.ceil(math.log2(min_scale)))
        backdrop = [z for z in overview_levels if 0 <= z < detail_min]
        keep = set(backdrop) | set(range(detail_min, max_zoom + 1))

    loop_bottom = min(keep)
    skipped = [z for z in range(loop_bottom, max_zoom + 1) if z not in keep]
    print(f"  native z{max_zoom}; detail band z{detail_min}..{max_zoom}"
          f"; overview {', '.join('z'+str(z) for z in backdrop) if backdrop else '(none)'}")
    if skipped:
        print(f"  skipping unused levels: {', '.join('z'+str(z) for z in skipped)}")

    if clean and os.path.isdir(out_dir):
        # Remove only generated files, the numbered zoom-level directories and
        # meta.json, so hand-authored data in the map folder survives.
        print(f"  cleaning generated tiles in {out_dir} ...")
        for entry in os.listdir(out_dir):
            path = os.path.join(out_dir, entry)
            if os.path.isdir(path) and entry.isdigit():
                shutil.rmtree(path)
            elif entry == "meta.json":
                os.remove(path)
    os.makedirs(out_dir, exist_ok=True)

    fmt = "png"
    levels = {}
    index = {}
    total_written = 0

    # Progressive halving from native down: preserves quality, keeps memory
    # bounded to one level image at a time. We halve through every level but
    # only write the ones we keep.
    current = img
    for z in range(max_zoom, loop_bottom - 1, -1):
        if z in keep:
            cols, rows, written, present = tile_level(
                current, z, out_dir, tile_size, bg, skip_empty, fmt, quantize
            )
            lw, lh = current.size
            levels[str(z)] = {"width": lw, "height": lh, "cols": cols, "rows": rows}
            index[str(z)] = {str(k): v for k, v in present.items()}
            total_written += written
        if z > loop_bottom:
            nw = max(1, math.ceil(current.size[0] / 2))
            nh = max(1, math.ceil(current.size[1] / 2))
            current = current.resize((nw, nh), DOWNSCALE_FILTER)

    meta = {
        "name": name,
        "tileSize": tile_size,
        "width": src_w,
        "height": src_h,
        "minZoom": loop_bottom,
        "maxZoom": max_zoom,
        "background": list(bg[:3]),
        "tileFormat": fmt,
        "skipEmpty": skip_empty,
        # Low-res overview levels the viewer should keep resident as the
        # anti-flash backdrop.
        "backdrop": backdrop,
        "levels": levels,
        # index[z][x] = [y, ...] : which tiles actually exist (rest are empty
        # ocean). The viewer uses this so it never requests a skipped tile.
        "index": index,
    }
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    # Report output size.
    out_bytes = 0
    for root, _dirs, files in os.walk(out_dir):
        for fn in files:
            out_bytes += os.path.getsize(os.path.join(root, fn))
    dt = time.time() - t0
    print("-" * 60)
    print(f"Done in {dt:.1f}s")
    print(f"  tiles written: {total_written}")
    print(f"  output size:   {human(out_bytes)}  in {out_dir}")
    print(f"  meta:          {os.path.join(out_dir, 'meta.json')}")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Slice a map PNG into a tile pyramid.")
    p.add_argument("src", help="source image (PNG)")
    p.add_argument("out_dir", help="output directory for tiles + meta.json")
    p.add_argument("--name", default=None, help="map name (default: source filename stem)")
    p.add_argument("--tile-size", type=int, default=256)
    p.add_argument("--bg", type=parse_color, default=None,
                   help="background colour R,G,B[,A] (default: auto from top-left pixel)")
    p.add_argument("--no-skip-empty", dest="skip_empty", action="store_false",
                   help="write every tile, even blank background ones")
    p.add_argument("--keep-alpha", action="store_true",
                   help="keep RGBA (for transparent overlay layers)")
    p.add_argument("--min-scale", type=float, default=0.25,
                   help="most zoomed-out display scale the viewer allows, in CSS "
                        "px per world px (default 0.25 = 25%%). Sets the coarsest "
                        "detail level; levels below it aren't generated as targets.")
    p.add_argument("--overview-levels", type=parse_levels, default=[0, 3],
                   help="comma-separated low-res levels kept resident as the "
                        "anti-flash backdrop (default '0,3'). Every other level "
                        "below the detail band is skipped.")
    p.add_argument("--min-zoom", type=int, default=None,
                   help="force a plain contiguous pyramid from this level up "
                        "(overrides the banded overview/detail behaviour)")
    p.add_argument("--quantize", action="store_true",
                   help="also palettise tiles that need MORE than 256 colours "
                        "(the downscaled levels), to an adaptive 256-colour "
                        "palette. ~50%% smaller but lossy, so it's opt-in; "
                        "tiles that already fit 256 colours are palettised "
                        "losslessly either way.")
    p.add_argument("--no-clean", dest="clean", action="store_false",
                   help="do not wipe generated tiles first")
    p.set_defaults(skip_empty=True, clean=True, quantize=False)
    args = p.parse_args(argv)

    name = args.name or os.path.splitext(os.path.basename(args.src))[0]
    build(
        src=args.src,
        out_dir=args.out_dir,
        name=name,
        tile_size=args.tile_size,
        bg=args.bg,
        skip_empty=args.skip_empty,
        keep_alpha=args.keep_alpha,
        min_zoom=args.min_zoom,
        min_scale=args.min_scale,
        overview_levels=args.overview_levels,
        quantize=args.quantize,
        clean=args.clean,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
