#!/usr/bin/env python3
"""
place_wiki_source.py: automates the "manually align" step of the alt-style
pipeline (tools/README.md, "Alternate map styles" section, step 3) for
sources built from native (unscaled) wiki tiles.

Takes a native wiki stitch (e.g. sources/runescape-surface-wiki-native.png,
at the wiki's own px/game-tile ratio), and:

  1. Recolors solid-black pixels (the wiki's own "no data" fill for
     unmapped/instance areas) and the stitcher's flat gap-fill placeholder
     colour to a single blend colour, normally the wiki's own real sea
     colour, sampled from the tiles themselves, so padding/gaps disappear
     into the ocean instead of showing as mismatched grey/black blocks.
  2. Scales the recoloured image by `--scale` (native px/game-tile ->
     target px/game-tile, e.g. 0.75 for 4px/tile -> 3px/tile).
  3. Pastes it into a new canvas of exactly `--out-size` WxH (matching the
     default style's own pixel dimensions), at `--x`/`--y`, filled
     everywhere else with the same blend colour.

The result is pre-scaled and pre-padded into the default style's own pixel
space, so it needs no `place` override in js/config.js, the same approach the
existing surface `wiki` style comment describes. Use tools/align.html first
to find the right --x/--y/--scale by eye if you don't already know them.

Usage
-----
    python tools/place_wiki_source.py sources/runescape-surface-wiki-native.png \\
        sources/runescape-surface-wiki-final.png \\
        --scale 0.75 --out-size 21981x18101 --x 5220 --y 2786 \\
        --blend-color 119,137,165

Requires: Pillow, numpy.
"""

from __future__ import annotations

import argparse
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # these maps are legitimately huge


def parse_color(s: str) -> tuple[int, int, int]:
    parts = tuple(int(p) for p in s.split(","))
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("color must be 'R,G,B'")
    return parts  # type: ignore[return-value]


def parse_size(s: str) -> tuple[int, int]:
    w, h = s.lower().split("x")
    return int(w), int(h)


def go(
    infile: str,
    outfile: str,
    scale: float,
    out_size: tuple[int, int],
    x: int,
    y: int,
    blend_color: tuple[int, int, int],
    black_threshold: int,
    gap_color: tuple[int, int, int],
    gap_tolerance: int,
) -> None:
    print(f"Loading {infile} ...")
    img = Image.open(infile).convert("RGBA")
    arr = np.array(img)
    print(f"  source: {arr.shape[1]}x{arr.shape[0]}")

    r, g, b = arr[:, :, 0].astype(int), arr[:, :, 1].astype(int), arr[:, :, 2].astype(int)

    black_mask = (r < black_threshold) & (g < black_threshold) & (b < black_threshold)
    gap_mask = (
        (np.abs(r - gap_color[0]) <= gap_tolerance)
        & (np.abs(g - gap_color[1]) <= gap_tolerance)
        & (np.abs(b - gap_color[2]) <= gap_tolerance)
    )
    recolor_mask = black_mask | gap_mask
    n = int(recolor_mask.sum())
    print(f"  recoloring {n} px (black<{black_threshold}: {int(black_mask.sum())}, "
          f"gap~{gap_color}±{gap_tolerance}: {int(gap_mask.sum())}) -> {blend_color}")
    arr[recolor_mask, 0] = blend_color[0]
    arr[recolor_mask, 1] = blend_color[1]
    arr[recolor_mask, 2] = blend_color[2]
    arr[:, :, 3] = 255

    img = Image.fromarray(arr, "RGBA")

    if scale != 1.0:
        new_size = (round(img.width * scale), round(img.height * scale))
        print(f"  scaling {img.width}x{img.height} -> {new_size[0]}x{new_size[1]} (factor {scale})")
        img = img.resize(new_size, Image.LANCZOS)

    canvas = Image.new("RGBA", out_size, blend_color + (255,))
    canvas.paste(img, (x, y))
    print(f"  pasted at ({x}, {y}) onto {out_size[0]}x{out_size[1]} canvas filled with {blend_color}")

    canvas = canvas.convert("RGB")
    canvas.save(outfile)
    print(f"saved {outfile}  ({canvas.width}x{canvas.height}px)")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("infile", help="native (unscaled) wiki stitch, e.g. sources/runescape-surface-wiki-native.png")
    p.add_argument("outfile", help="output PNG path, e.g. sources/runescape-surface-wiki-final.png")
    p.add_argument("--scale", type=float, required=True,
                   help="uniform resize factor, native px/game-tile -> target px/game-tile "
                        "(e.g. 0.75 for 4px/tile -> 3px/tile)")
    p.add_argument("--out-size", type=parse_size, required=True, help="final canvas size, 'WxH' (e.g. 21981x18101)")
    p.add_argument("--x", type=int, required=True, help="x offset (post-scale px) to paste the image at")
    p.add_argument("--y", type=int, required=True, help="y offset (post-scale px) to paste the image at")
    p.add_argument("--blend-color", type=parse_color, default=(119, 137, 165),
                   help="colour ('R,G,B') used for canvas padding and to replace black/gap pixels "
                        "(default 119,137,165 = #7789a5)")
    p.add_argument("--black-threshold", type=int, default=20,
                   help="pixels with every channel below this are treated as solid-black 'no data' "
                        "areas and recoloured (default 20)")
    p.add_argument("--gap-color", type=parse_color, default=(128, 141, 161),
                   help="the stitcher's flat gap-fill placeholder colour to also recolour "
                        "(default 128,141,161 = stitch_wiki_tiles.py's DEFAULT_BG)")
    p.add_argument("--gap-tolerance", type=int, default=2,
                   help="per-channel tolerance when matching --gap-color (default 2)")
    args = p.parse_args(argv)
    go(
        args.infile, args.outfile, args.scale, args.out_size, args.x, args.y,
        args.blend_color, args.black_threshold, args.gap_color, args.gap_tolerance,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
