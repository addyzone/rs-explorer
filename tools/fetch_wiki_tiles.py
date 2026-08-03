#!/usr/bin/env python3
"""
fetch_wiki_tiles.py: download map_squares tiles from the RuneScape Wiki's
tile server (maps.runescape.wiki) to a local cache, ready for
stitch_wiki_tiles.py.

Why this exists
----------------
stitch_wiki_tiles.py (and the stitchmap2.py it's adapted from) only reads
tiles that already exist on disk and has no idea how to reach the wiki's
mapserver. This script is the other half: it works out which tiles actually
cover a given map (via basemaps.json) and pulls just those, at just the
zoom/layer you ask for, instead of the whole pyramid.

Tile scheme
-----------
    {base}/map_squares/{mapid}/{zoom}/{layer}_{x}_{y}.png

`bounds` / `originalBounds` in basemaps.json are in game-tile units; dividing
by 64 gives the tile x/y at zoom 2 (one wiki tile == one 64x64 game-tile map
square, rendered at 4px/tile or 256px, so zoom 2 is native resolution,
matching the game's own map rendering). Lower zooms are coarser downscales;
this script defaults to zoom 2 / layer 0 (ground floor) since that's the only
combination the Surface style needs. Pass --zoom or --layers to widen it for
a future multi-floor map.

Usage
-----
    python tools/fetch_wiki_tiles.py 28 tools/wiki_cache

    # narrower/wider fetch:
    python tools/fetch_wiki_tiles.py 28 tools/wiki_cache --zoom 2 --layers 0

Requires only the standard library.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://maps.runescape.wiki/rs/versions/{version}"
UA = "rs-adventurers-map/1.0 (+fetch_wiki_tiles.py; fan project, hotlinking per maps.runescape.wiki usage notes)"


def parse_int_list(s: str) -> list[int]:
    return [int(x) for x in s.split(",") if x.strip() != ""]


def fetch_url(url: str, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_basemaps(version: str) -> list[dict]:
    url = f"{BASE.format(version=version)}/basemaps.json"
    print(f"Fetching {url}")
    data = fetch_url(url)
    return json.loads(data)


def map_bounds(entry: dict, source: str) -> list[tuple[int, int]]:
    """Return the (min_x,min_y),(max_x,max_y) pairs to use, per --bounds-source."""
    pairs = []
    if source in ("bounds", "both") and "bounds" in entry:
        pairs.append(entry["bounds"])
    if source in ("originalBounds", "both") and "originalBounds" in entry:
        pairs.append(entry["originalBounds"])
    if not pairs:
        # fall back to whichever exists
        pairs = [entry.get("bounds") or entry["originalBounds"]]
    min_x = min(p[0][0] for p in pairs)
    min_y = min(p[0][1] for p in pairs)
    max_x = max(p[1][0] for p in pairs)
    max_y = max(p[1][1] for p in pairs)
    return (min_x, min_y), (max_x, max_y)


def download_one(url: str, dest: str) -> str:
    """Returns 'cached' | 'ok' | 'empty' | 'error:<msg>'."""
    if os.path.exists(dest):
        return "cached"
    try:
        data = fetch_url(url)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return "empty"  # void or ocean tile, expected rather than an error
        return f"error:HTTP {e.code}"
    except Exception as e:  # noqa: BLE001, best-effort fetch script
        return f"error:{e}"
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(data)
    return "ok"


def go(
    mapid: int,
    outdir: str,
    version: str,
    zooms: list[int],
    layers: list[int],
    workers: int,
    padding: int,
    bounds_source: str,
) -> None:
    entries = fetch_basemaps(version)
    entry = next((e for e in entries if e.get("mapId") == mapid), None)
    if entry is None:
        print(f"mapid {mapid} not found in basemaps.json", file=sys.stderr)
        sys.exit(1)
    (min_x, min_y), (max_x, max_y) = map_bounds(entry, bounds_source)
    print(f"map: {entry.get('name')!r}  bounds(game tiles): ({min_x},{min_y})-({max_x},{max_y})")

    tx0 = max(0, math.floor(min_x / 64) - padding)
    ty0 = max(0, math.floor(min_y / 64) - padding)
    tx1 = math.ceil(max_x / 64) + padding
    ty1 = math.ceil(max_y / 64) + padding
    print(f"tile range (zoom 2 units): x {tx0}..{tx1}  y {ty0}..{ty1}"
          f"  ({(tx1 - tx0 + 1)} x {(ty1 - ty0 + 1)} = {(tx1 - tx0 + 1) * (ty1 - ty0 + 1)} tiles per layer/zoom)")

    root = os.path.join(outdir, "map_squares", str(mapid))
    jobs = []
    for z in zooms:
        # tile range scales with zoom relative to the native zoom-2 grid.
        zpow = 2 ** (z - 2)
        zx0, zy0 = math.floor(tx0 * zpow), math.floor(ty0 * zpow)
        zx1, zy1 = math.ceil(tx1 * zpow), math.ceil(ty1 * zpow)
        for layer in layers:
            for x in range(zx0, zx1 + 1):
                for y in range(zy0, zy1 + 1):
                    url = f"{BASE.format(version=version)}/map_squares/{mapid}/{z}/{layer}_{x}_{y}.png"
                    dest = os.path.join(root, str(z), f"{layer}_{x}_{y}.png")
                    jobs.append((url, dest))

    print(f"downloading {len(jobs)} tile(s) with {workers} workers ...")
    counts = {"ok": 0, "cached": 0, "empty": 0, "error": 0}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(download_one, url, dest): (url, dest) for url, dest in jobs}
        done = 0
        for fut in as_completed(futs):
            result = fut.result()
            done += 1
            if result.startswith("error"):
                counts["error"] += 1
                url, _dest = futs[fut]
                print(f"  {result}  {url}")
            else:
                counts[result] += 1
            if done % 200 == 0 or done == len(jobs):
                print(f"  {done}/{len(jobs)}  ok={counts['ok']} cached={counts['cached']} "
                      f"empty={counts['empty']} error={counts['error']}", end="\r", flush=True)
    print()
    print("-" * 60)
    print(f"done in {time.time() - t0:.1f}s")
    print(f"  ok={counts['ok']}  cached={counts['cached']}  empty(void)={counts['empty']}  errors={counts['error']}")
    print(f"  tiles saved under: {root}")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Download RuneScape Wiki map_squares tiles to a local cache.")
    p.add_argument("mapid", type=int, help="wiki map id, e.g. 28 for RuneScape Surface")
    p.add_argument("outdir", help="cache directory to write map_squares/... into (this is the "
                                  "'indir' you'll later pass to stitch_wiki_tiles.py)")
    p.add_argument("--version", default="2026-06-15",
                   help="tile version path segment (default: 2026-06-15). If tiles start 404ing, "
                        "open the interactive map on runescape.wiki and check the network tab / "
                        "page source for the current .../versions/<date>/ path.")
    p.add_argument("--zoom", default="2", help="comma-separated zoom level(s) to fetch (default: 2, "
                                                "the native/100%% level)")
    p.add_argument("--layers", default="0", help="comma-separated floor layer(s) to fetch "
                                                  "(default: 0, ground floor)")
    p.add_argument("--workers", type=int, default=24, help="concurrent download workers (default 24)")
    p.add_argument("--padding", type=int, default=2, help="extra tiles of padding around the computed "
                                                           "bounds, in zoom-2 tile units (default 2)")
    p.add_argument("--bounds-source", choices=["bounds", "originalBounds", "both"], default="both",
                   help="which basemaps.json bounds field(s) to use (default: both, unioned, "
                        "safest, extra tiles just 404 and get skipped)")
    args = p.parse_args(argv)

    go(
        mapid=args.mapid,
        outdir=args.outdir,
        version=args.version,
        zooms=parse_int_list(args.zoom),
        layers=parse_int_list(args.layers),
        workers=args.workers,
        padding=args.padding,
        bounds_source=args.bounds_source,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
