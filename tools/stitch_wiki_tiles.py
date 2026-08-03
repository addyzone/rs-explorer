#!/usr/bin/env python3
"""
stitch_wiki_tiles.py: stitch a single zoom and layer of downloaded RuneScape
Wiki map_squares tiles into one flat PNG, for manual pixel-alignment against
an existing source map.

This is adapted from stitchmap2.py (the original mapserver-render stitcher),
trimmed down to one zoom + one layer per run and right-sized to the tiles
that actually exist, instead of allocating a canvas for the whole 100x200
tile world grid regardless of what's present. That original approach is fine
when you *want* every zoom/layer in one pass, but for a single 100%-zoom
"dev" source image it means allocating tens of gigabytes for zoom levels
you never asked for.

Paste orientation is unchanged from stitchmap2.py: tile x increases right;
tile y increases going *up* the image (matches the game's own map, which is
north-up while the tile scheme's y grows northward), so y is flipped when
placing each tile relative to the top of the cropped canvas.

Usage
-----
    python tools/fetch_wiki_tiles.py 28 tools/wiki_cache          # download tiles first
    python tools/stitch_wiki_tiles.py tools/wiki_cache sources/runescape-surface-wiki_dev.png --mapid 28

Requires: Pillow (see tools/requirements.txt).
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys

from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None  # these maps are legitimately huge

TILESIZE = 256
# Default fill for areas with no fetched tile: the wiki's own sea colour
# (#808da1), so gaps blend into the ocean instead of showing as hard black
# blocks, and tile_map.py's own bg auto-detection (from the image's
# top-left pixel) has a good chance of picking this up automatically for
# skip-empty.
DEFAULT_BG = (0x80, 0x8D, 0xA1, 255)

TILE_RE = re.compile(r"^(\d+)_(-?\d+)_(-?\d+)\.png$")


def parse_color(s: str) -> tuple[int, ...]:
    parts = tuple(int(p) for p in s.split(","))
    if len(parts) == 3:
        parts = parts + (255,)
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("color must be 'R,G,B' or 'R,G,B,A'")
    return parts


def find_tiles(zoom_dir: pathlib.Path, layer: int) -> list[tuple[int, int]]:
    out = []
    if not zoom_dir.is_dir():
        return out
    for f in zoom_dir.iterdir():
        m = TILE_RE.match(f.name)
        if not m:
            continue
        l, x, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if l == layer:
            out.append((x, y))
    return out


def go(indir: str, outfile: str, mapid: int, zoom: int, layer: int, scale: float = 1.0,
       sharpen: int = 0, bg: tuple[int, int, int, int] = DEFAULT_BG) -> None:
    zoom_dir = pathlib.Path(indir).joinpath("map_squares", str(mapid), str(zoom))
    tiles = find_tiles(zoom_dir, layer)
    if not tiles:
        print(f"no tiles found in {zoom_dir} for layer {layer}", file=sys.stderr)
        print("did you run fetch_wiki_tiles.py first?", file=sys.stderr)
        sys.exit(1)

    min_x = min(x for x, _ in tiles)
    max_x = max(x for x, _ in tiles)
    min_y = min(y for _, y in tiles)
    max_y = max(y for _, y in tiles)
    cols = max_x - min_x + 1
    rows = max_y - min_y + 1
    print(f"{len(tiles)} tile(s)  x {min_x}..{max_x}  y {min_y}..{max_y}  -> canvas {cols}x{rows} tiles"
          f" ({cols * TILESIZE}x{rows * TILESIZE}px)")

    bigimg = Image.new("RGBA", (cols * TILESIZE, rows * TILESIZE), bg)
    pasted = 0
    for x, y in tiles:
        fil = zoom_dir.joinpath(f"{layer}_{x}_{y}.png")
        img = Image.open(fil)
        xpos = (x - min_x) * TILESIZE
        ypos = (max_y - y) * TILESIZE  # flip: higher tile-y = further north = higher on canvas
        bigimg.paste(img, (xpos, ypos))
        pasted += 1
        if pasted % 200 == 0:
            print(f"  pasted {pasted}/{len(tiles)}", end="\r", flush=True)
    print(f"  pasted {pasted}/{len(tiles)}")

    if scale != 1.0:
        new_size = (round(bigimg.width * scale), round(bigimg.height * scale))
        print(f"  scaling {bigimg.width}x{bigimg.height} -> {new_size[0]}x{new_size[1]} (factor {scale})")
        bigimg = bigimg.resize(new_size, Image.LANCZOS)

    if sharpen:
        # Downscaling below the native zoom's 1px wall/border lines leaves them
        # sub-pixel wide, which any resize blends into a soft faded line, an
        # unsharp mask recovers perceived edge contrast (radius/threshold tuned
        # for thin linework, not photos; percent is the strength knob).
        print(f"  sharpening (unsharp mask, {sharpen}%)")
        bigimg = bigimg.filter(ImageFilter.UnsharpMask(radius=1.5, percent=sharpen, threshold=2))

    out_path = pathlib.Path(outfile)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    bigimg.save(out_path)
    print("-" * 60)
    print(f"saved {out_path}  ({bigimg.width}x{bigimg.height}px)")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Stitch one zoom/layer of fetched wiki tiles into a single PNG.")
    p.add_argument("indir", help="tile cache dir (the outdir you passed to fetch_wiki_tiles.py)")
    p.add_argument("outfile", help="output PNG path, e.g. sources/runescape-surface-wiki_dev.png")
    p.add_argument("--mapid", type=int, required=True, help="wiki map id, e.g. 28 for RuneScape Surface")
    p.add_argument("--zoom", type=int, default=2, help="zoom level to stitch (default 2 = native, 4px/game-tile)")
    p.add_argument("--layer", type=int, default=0, help="floor layer to stitch (default 0 = ground floor)")
    p.add_argument("--scale", type=float, default=1.0,
                   help="uniform resize factor applied after stitching (default 1.0 = no resize, "
                        "recommended). Leave this at 1.0 and use the viewer's per-style `place: "
                        "{scale, x, y}` (js/config.js) to reconcile a different px/game-tile ratio "
                        "against the world coordinate space instead, avoiding the quality loss a "
                        "resize causes, and needs no re-tiling if you tweak it. Kept for other uses "
                        "but not part of the recommended alt-style pipeline any more.")
    p.add_argument("--sharpen", type=int, default=0,
                   help="unsharp-mask strength, 0-300ish (default 0 = off). Only relevant if you do "
                        "resize with --scale.")
    p.add_argument("--bg", type=parse_color, default=DEFAULT_BG,
                   help="fill colour for areas with no fetched tile, 'R,G,B[,A]' (default: this "
                        "project's own ocean colour, 136,144,157). Keep it matching your other "
                        "style's background so the two blend seamlessly, and so tile_map.py's "
                        "background auto-detection can skip-empty these areas.")
    args = p.parse_args(argv)
    go(args.indir, args.outfile, args.mapid, args.zoom, args.layer, args.scale, args.sharpen, args.bg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
