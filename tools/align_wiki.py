#!/usr/bin/env python3
"""
align_wiki.py: work out where a native wiki stitch sits relative to the
default source map, without resampling either image.

Both images are renders of the same world at different px-per-game-tile
ratios (default map 3px/tile, wiki zoom-2 tiles 4px/tile). Because both are
integer multiples of the game-tile grid, we can compare them in *game tile*
units by plain subsampling (arr[::3], arr[::4]): no interpolation and no
resampling, so nothing is invented or blurred.

    solve   auto-find the offset by correlating land/sea masks, then report
            it in every unit you might need (game tiles, native px paste
            offset, world-px `place` values).
    crops   render side-by-side / blended verification crops at a candidate
            offset so you can eyeball whether it's actually right.

Requires: Pillow, numpy.
"""

from __future__ import annotations

import argparse
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # these maps are legitimately huge

# --- What we know about the two renders -------------------------------------
# A wiki zoom-2 tile is 256px and covers exactly one 64x64-game-tile map
# square (tile index == map square index; zoom 3 indices are exactly 2x),
# so the wiki side is pinned at 4 px per game tile.
WIKI_PX_PER_TILE = 4
# The default map's ratio is not self-evident. Measure it with `scales`
# rather than trusting it.
DEFAULT_ORIG_PX_PER_TILE = 4

# Colours to treat as "no map data" when building the land mask.
ORIG_SEA = (136, 144, 157)   # maps/surface/meta.json -> background (flat)
WIKI_GAP = (128, 141, 161)   # stitch_wiki_tiles.py DEFAULT_BG (unfetched squares)
WIKI_SEA = (119, 137, 165)   # the wiki's own sea tint, dithered, needs tolerance
WIKI_SEA_TOL = 6
BLACK_MAX = 20               # wiki's solid-black "no data" fill


def parse_color(s: str) -> tuple[int, int, int]:
    parts = tuple(int(p) for p in s.split(","))
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("color must be 'R,G,B'")
    return parts  # type: ignore[return-value]


def load_rgb(path: str) -> np.ndarray:
    print(f"loading {path} ...", flush=True)
    img = Image.open(path)
    if img.mode != "RGB":
        img = img.convert("RGB")
    arr = np.asarray(img)
    print(f"  {arr.shape[1]}x{arr.shape[0]}")
    return arr


def _near(r, g, b, c, tol):
    return (np.abs(r - c[0]) <= tol) & (np.abs(g - c[1]) <= tol) & (np.abs(b - c[2]) <= tol)


def orig_land_mask(arr: np.ndarray, sea=ORIG_SEA, tol: int = 4) -> np.ndarray:
    """True where the default map has real content. Its sea is one flat colour."""
    r, g, b = (arr[:, :, i].astype(np.int16) for i in range(3))
    return ~_near(r, g, b, sea, tol)


def wiki_land_mask(arr: np.ndarray) -> np.ndarray:
    """
    True where the wiki stitch has real content. Three things are NOT content:
    the stitcher's flat gap fill (map squares that were never fetched), the
    wiki's own sea tint (dithered, so it needs a tolerance, not an exact
    match), and its solid-black 'no data' fill.
    """
    r, g, b = (arr[:, :, i].astype(np.int16) for i in range(3))
    gap = _near(r, g, b, WIKI_GAP, 2)
    sea = _near(r, g, b, WIKI_SEA, WIKI_SEA_TOL)
    blk = (r < BLACK_MAX) & (g < BLACK_MAX) & (b < BLACK_MAX)
    return ~(gap | sea | blk)


def block_mean(m: np.ndarray, f: int) -> np.ndarray:
    """Average a boolean mask down by an integer factor (analysis only)."""
    if f == 1:
        return m.astype(np.float32)
    h, w = (m.shape[0] // f) * f, (m.shape[1] // f) * f
    return m[:h, :w].astype(np.float32).reshape(h // f, f, w // f, f).mean(axis=(1, 3))


def fft_correlate_peak(a: np.ndarray, b: np.ndarray) -> tuple[int, int, float]:
    """
    Cross-correlate mean-subtracted `a` (big) with `b` (small) and return the
    (dy, dx) placing b's origin inside a's grid, plus a z-score for the peak
    (how many std devs it stands above the rest of the correlation surface).
    A genuine lock scores in the tens; noise scores single digits.
    """
    a = a - a.mean()
    b = b - b.mean()
    sh = (a.shape[0] + b.shape[0] - 1, a.shape[1] + b.shape[1] - 1)
    fsh = tuple(int(1 << (int(np.ceil(np.log2(n))))) for n in sh)
    corr = np.fft.irfft2(np.fft.rfft2(a, fsh) * np.conj(np.fft.rfft2(b, fsh)), fsh)
    # Valid placements only: b fully inside a.
    vy, vx = a.shape[0] - b.shape[0] + 1, a.shape[1] - b.shape[1] + 1
    if vy <= 0 or vx <= 0:
        return 0, 0, 0.0
    valid = corr[:vy, :vx]
    idx = int(np.argmax(valid))
    dy, dx = divmod(idx, vx)
    z = (float(valid[dy, dx]) - float(valid.mean())) / (float(valid.std()) or 1.0)
    return dy, dx, z


def refine(big: np.ndarray, small: np.ndarray, dy0: int, dx0: int, r: int) -> tuple[int, int]:
    """Brute-force best integer offset within +/- r of (dy0, dx0)."""
    bh, bw = small.shape
    best, bestyx = -1e30, (dy0, dx0)
    for dy in range(dy0 - r, dy0 + r + 1):
        if dy < 0 or dy + bh > big.shape[0]:
            continue
        for dx in range(dx0 - r, dx0 + r + 1):
            if dx < 0 or dx + bw > big.shape[1]:
                continue
            win = big[dy:dy + bh, dx:dx + bw]
            # Agreement score: reward matching land/sea, punish disagreement.
            s = float(np.sum(win * small) - 0.5 * np.sum(win * (1 - small)) - 0.5 * np.sum((1 - win) * small))
            if s > best:
                best, bestyx = s, (dy, dx)
    return bestyx


def _report(P: int, dx: int, dy: int, ow: int, oh: int, wik_w: int, wik_h: int) -> None:
    """Everything you need to pad the wiki stitch into place, in pixels."""
    ratio = WIKI_PX_PER_TILE / P
    out_w, out_h = round(ow * ratio), round(oh * ratio)
    px, py = dx * WIKI_PX_PER_TILE, dy * WIKI_PX_PER_TILE
    pad_l, pad_t = px, py
    pad_r, pad_b = out_w - wik_w - px, out_h - wik_h - py
    print()
    print("=" * 70)
    print(f"orig {ow}x{oh}  ->  target canvas {out_w}x{out_h}   (x{ratio:.6f})")
    print(f"wiki native {wik_w}x{wik_h} pasted at ({px}, {py}), unscaled")
    print()
    print("  PAD (ocean colour) :")
    print(f"     left   {pad_l}")
    print(f"     top    {pad_t}")
    print(f"     right  {pad_r}")
    print(f"     bottom {pad_b}")
    if pad_l < 0 or pad_t < 0 or pad_r < 0 or pad_b < 0:
        print("     !! negative = the wiki image overhangs and needs CROPPING that side")
    print()
    print("  place_wiki_source.py:  --scale 1.0 "
          f"--out-size {out_w}x{out_h} --x {px} --y {py}")
    print(f"  js/config.js place  :  {{ scale: {ratio}, x: 0, y: 0 }}")
    print("=" * 70)


def _solve_at(mo_full: np.ndarray, mw: np.ndarray, P: int, coarse: int, refine_r: int,
              verbose: bool = True) -> tuple[int, int, float]:
    """Decimate the orig mask to 1px/game-tile assuming P px/tile, then lock on."""
    mo = mo_full[::P, ::P]
    if verbose:
        print(f"  game-tile masks: orig {mo.shape[1]}x{mo.shape[0]} ({mo.mean()*100:.1f}% land), "
              f"wiki {mw.shape[1]}x{mw.shape[0]} ({mw.mean()*100:.1f}% land)")
    ca, cb = block_mean(mo, coarse), block_mean(mw, coarse)
    cdy, cdx, z = fft_correlate_peak(ca, cb)
    if verbose:
        print(f"  coarse @{coarse} tiles/px -> (dx={cdx*coarse}, dy={cdy*coarse})  z={z:.1f}", flush=True)
    dy, dx = refine(mo.astype(np.float32), mw.astype(np.float32),
                    cdy * coarse, cdx * coarse, refine_r)
    return dx, dy, z


def _load_masks(args):
    orig = load_rgb(args.orig)
    oh, ow = orig.shape[:2]
    mo_full = orig_land_mask(orig, args.orig_sea, args.tol)
    del orig
    wiki = load_rgb(args.wiki)
    mw = wiki_land_mask(wiki[::WIKI_PX_PER_TILE, ::WIKI_PX_PER_TILE])
    del wiki
    return mo_full, mw, ow, oh


def cmd_scales(args) -> int:
    """Try several candidate px-per-game-tile ratios; the real one locks hard."""
    mo_full, mw, ow, oh = _load_masks(args)
    results = []
    for P in args.candidates:
        print(f"\n--- trying orig at {P} px per game tile ---")
        dx, dy, z = _solve_at(mo_full, mw, P, args.coarse, args.refine)
        print(f"  -> dx={dx}, dy={dy} game tiles   confidence z={z:.1f}")
        results.append((z, P, dx, dy))
    results.sort(reverse=True)
    z, P, dx, dy = results[0]
    print("\nranking (higher z = sharper, more certain lock):")
    for zz, PP, _, _ in results:
        print(f"   {PP} px/tile : z={zz:.1f}")
    _report(P, dx, dy, ow, oh, mw.shape[1] * WIKI_PX_PER_TILE, mw.shape[0] * WIKI_PX_PER_TILE)
    print()
    print("Eyeball it before committing:")
    print(f"  python tools/align_wiki.py crops --x {dx*WIKI_PX_PER_TILE} --y {dy*WIKI_PX_PER_TILE} "
          f"--orig-px-per-tile {P} --at 2450,1950")
    return 0


def cmd_solve(args) -> int:
    mo_full, mw, ow, oh = _load_masks(args)
    P = args.orig_px_per_tile
    dx, dy, z = _solve_at(mo_full, mw, P, args.coarse, args.refine)
    print(f"  -> dx={dx}, dy={dy} game tiles   confidence z={z:.1f}")
    _report(P, dx, dy, ow, oh, mw.shape[1] * WIKI_PX_PER_TILE, mw.shape[0] * WIKI_PX_PER_TILE)
    return 0


def cmd_previews(args) -> int:
    """
    Write downscaled copies of both sources for tools/pad_align.html to load
    (browsers cap how many pixels they'll decode; the full-size pair is way
    over). These are throwaway viewing copies; the images that actually get
    tiled are never resampled.
    """
    for src, dst in ((args.orig, args.orig_out), (args.wiki, args.wiki_out)):
        img = Image.open(src).convert("RGB")
        small = img.reduce(args.down)
        small.save(dst)
        print(f"{src}  {img.width}x{img.height}  ->  {dst}  {small.width}x{small.height}  (/{args.down})")
    return 0


def cmd_preview(args) -> int:
    """
    Whole-map overlay of the two land masks at a candidate offset, downscaled
    to something you can actually look at. RED = orig content only,
    GREEN = wiki content only, YELLOW/WHITE = both (i.e. aligned).
    Masks are resampled for this picture; the real output image never is.
    """
    mo_full, mw, ow, oh = _load_masks(args)
    P = args.orig_px_per_tile
    mo = mo_full[::P, ::P]
    del mo_full
    dx, dy = args.x // WIKI_PX_PER_TILE, args.y // WIKI_PX_PER_TILE

    f = args.down
    a = block_mean(mo, f)
    b = block_mean(mw, f)
    oy, ox = dy // f, dx // f
    h, w = a.shape
    rgb = np.zeros((h, w, 3), np.uint8)
    rgb[:, :, 0] = (np.clip(a, 0, 1) * 255).astype(np.uint8)          # orig -> red
    y1, x1 = min(h, oy + b.shape[0]), min(w, ox + b.shape[1])
    if oy < h and ox < w:
        bb = b[: y1 - oy, : x1 - ox]
        rgb[oy:y1, ox:x1, 1] = (np.clip(bb, 0, 1) * 255).astype(np.uint8)  # wiki -> green
    Image.fromarray(rgb, "RGB").save(args.out)
    print(f"saved {args.out}  ({w}x{h})   red=orig only, green=wiki only, yellow=aligned")
    return 0


def cmd_crops(args) -> int:
    """Render native-resolution verification crops at a candidate offset."""
    orig_img = Image.open(args.orig)
    wiki_img = Image.open(args.wiki)

    spots = []
    for s in args.at:
        gx, gy = (int(v) for v in s.lower().split(","))
        spots.append((gx, gy))

    n = args.size  # crop size in game tiles
    P = args.orig_px_per_tile
    for i, (gx, gy) in enumerate(spots):
        # Crop each render around the same game tile, at its own native res.
        ox, oy = gx * P, gy * P
        os_ = n * P
        o = orig_img.crop((ox, oy, ox + os_, oy + os_)).convert("RGB")

        # Same game tile in wiki space: canvas native px -> minus paste offset.
        wx, wy = gx * WIKI_PX_PER_TILE - args.x, gy * WIKI_PX_PER_TILE - args.y
        ws = n * WIKI_PX_PER_TILE
        w = wiki_img.crop((wx, wy, wx + ws, wy + ws)).convert("RGB")

        # Show each at its OWN pixel scale, padded to a common height, so
        # neither is resampled: you are comparing shapes, not pixels.
        H = max(o.height, w.height)
        sheet = Image.new("RGB", (o.width + w.width + 8, H), (255, 0, 255))
        sheet.paste(o, (0, 0))
        sheet.paste(w, (o.width + 8, 0))
        path = f"{args.out}-{i}-{gx}_{gy}.png"
        sheet.save(path)
        print(f"saved {path}   (left=orig {o.width}px, right=wiki {w.width}px, game tile {gx},{gy} +{n})")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("orig", nargs="?", default="sources/runescape-surface.png")
        sp.add_argument("wiki", nargs="?", default="sources/runescape-surface-wiki-native.png")
        sp.add_argument("--orig-sea", type=parse_color, default=ORIG_SEA)
        sp.add_argument("--tol", type=int, default=4, help="per-channel tolerance for orig sea matching")
        sp.add_argument("--coarse", type=int, default=4, help="game tiles per px in the FFT pass")
        sp.add_argument("--refine", type=int, default=8, help="+/- game tiles searched in the refine pass")
        sp.add_argument("--wiki-tile-x", type=int, default=29, help="min map-square x in the stitch (sanity check)")
        sp.add_argument("--wiki-tile-ymax", type=int, default=70, help="max map-square y in the stitch (sanity check)")

    s = sub.add_parser("scales", help="measure the orig's px-per-game-tile AND the offset")
    common(s)
    s.add_argument("--candidates", type=int, nargs="+", default=[2, 3, 4, 6, 8],
                   help="candidate px-per-game-tile ratios to test (default 2 3 4 6 8)")
    s.set_defaults(func=cmd_scales)

    s = sub.add_parser("solve", help="auto-find the offset at a known scale")
    common(s)
    s.add_argument("--orig-px-per-tile", type=int, default=DEFAULT_ORIG_PX_PER_TILE)
    s.set_defaults(func=cmd_solve)

    q = sub.add_parser("previews", help="write downscaled viewing copies for pad_align.html")
    q.add_argument("orig", nargs="?", default="sources/runescape-surface.png")
    q.add_argument("wiki", nargs="?", default="sources/runescape-surface-wiki-native.png")
    q.add_argument("--down", type=int, default=4)
    q.add_argument("--orig-out", default="tools/preview-orig.png")
    q.add_argument("--wiki-out", default="tools/preview-wiki.png")
    q.set_defaults(func=cmd_previews)

    v = sub.add_parser("preview", help="whole-map mask overlay at a candidate offset")
    common(v)
    v.add_argument("--orig-px-per-tile", type=int, default=DEFAULT_ORIG_PX_PER_TILE)
    v.add_argument("--x", type=int, required=True, help="native paste offset x")
    v.add_argument("--y", type=int, required=True, help="native paste offset y")
    v.add_argument("--down", type=int, default=8, help="extra downscale for viewing (default 8)")
    v.add_argument("--out", default="tools/alignpreview.png")
    v.set_defaults(func=cmd_preview)

    c = sub.add_parser("crops", help="render verification crops at a candidate offset")
    c.add_argument("orig", nargs="?", default="sources/runescape-surface.png")
    c.add_argument("wiki", nargs="?", default="sources/runescape-surface-wiki-native.png")
    c.add_argument("--orig-px-per-tile", type=int, default=DEFAULT_ORIG_PX_PER_TILE)
    c.add_argument("--x", type=int, required=True, help="native paste offset x")
    c.add_argument("--y", type=int, required=True, help="native paste offset y")
    c.add_argument("--at", nargs="+", required=True, metavar="GX,GY",
                   help="game-tile coords (in ORIG map space) to crop around")
    c.add_argument("--size", type=int, default=96, help="crop size in game tiles (default 96)")
    c.add_argument("--out", default="tools/aligncheck", help="output path prefix")
    c.set_defaults(func=cmd_crops)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
