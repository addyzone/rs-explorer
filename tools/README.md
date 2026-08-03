# Map build tools

Tooling for turning source map images into the tile pyramids the viewer serves.
Re-run these whenever a source map changes.

## Setup (one-time)

```bash
pip install -r tools/requirements.txt
```

## Tiling a map

From the repo root. Every style of a map, including the one it opens with, is
tiled into its own folder under `maps/<id>/styles/<style-id>/`:

```bash
# Surface map, "Original" style
python tools/tile_map.py sources/runescape-surface.png maps/surface/styles/original --name surface
```

This writes `maps/surface/styles/original/<z>/<x>/<y>.png` plus that folder's
own `meta.json`.

### Options

| Flag | Meaning |
|------|---------|
| `--name NAME` | Map id stored in meta (default: source filename). |
| `--tile-size N` | Tile size in px (default 256). |
| `--bg R,G,B` | Background colour to treat as empty (default: auto from top-left pixel). |
| `--no-skip-empty` | Write every tile, including blank ocean. |
| `--keep-alpha` | Keep RGBA, for transparent overlay layers such as dungeons. |
| `--min-scale S` | Most zoomed-out scale the viewer allows, CSS px per world px (default `0.25`). Sets the coarsest detail level. |
| `--overview-levels A,B` | Low-res levels kept resident as the anti-flash backdrop (default `0,3`). |
| `--min-zoom N` | Force a contiguous pyramid from level N up, overriding the banded behaviour. |
| `--quantize` | Also palettise tiles needing more than 256 colours. Lossy, see below. |
| `--no-clean` | Don't wipe generated tiles first. |

### Palette PNGs

Map rasters are flat colour art, not photographs. A native tile of the Original
style holds around 130 distinct colours, so writing it as 24-bit RGB spends
about half its bytes on depth it never uses. Any tile that fits in 256 colours
is written as a palette PNG instead, which is exactly lossless: the tiler
verifies the result pixel for pixel and falls back to RGB rather than risk a
difference. Measured on the surface map, native tiles went 10.5KB to 5.6KB and
the whole style 17.0MB to 11.4MB.

Downscaled levels, and the wiki 3D style at every level, exceed 256 colours and
stay RGB by default. `--quantize` requantises those to an adaptive 256-colour
palette for roughly another 50%, worth about 30MB on the wiki 3D style, but it
is lossy, hence opt-in.

Downscaling uses a box filter, an exact 2x2 average, not Lanczos. Lanczos rings
around the hard 1px edges this art is made of, haloing every road and wall, and
the ringing invents colours: it turned a 130-colour source tile into about
3,000 and made the PNG 45% larger than the box version.

## How the pyramid works

- `maxZoom` is native resolution, 1 source px per tile px. Each lower zoom
  halves it.
- Origin (0,0) is the top left; x goes right, y goes down.
- Edge tiles are saved unpadded, at their true smaller size, to stay
  pixel-perfect.
- Fully-background tiles are skipped and the viewer paints `background` under
  them.

### Zoom bands (why some levels aren't generated)

The viewer only displays levels on its zoom ladder, whose most zoomed-out rung
is `--min-scale`, so the pyramid comes in two parts:

- **Detail band**: the levels shown as targets, from the level for
  `--min-scale` up to native. For the surface map that is z5 to z7, and those
  are the only levels ever drawn at full detail. The ladder's rungs are 25%,
  50%, then 100% to 800%, which map to z5, z6, and z7 upscaled.
- **Overview levels**: `--overview-levels`, kept resident only to back the
  anti-flash backdrop while detail tiles stream in.

The overview set is a list rather than a band because each level already covers
the whole map, so a finer one makes every coarser one redundant except as
something to show sooner on a cold load. The default `0,3` keeps that pair: z0
is a single 12KB tile that paints the whole world almost immediately, z3 is the
good backdrop at 9 tiles. z1 and z2 sat between them adding bytes and draw calls
for coverage z3 already gave.

So for the surface map z1, z2 and z4 aren't written at all, though the tiler
still halves through them to build the coarser images. `meta.json` records
`backdrop` and `levels`, and the viewer reads both, so a skipped level is
handled automatically.

Re-tiling only replaces the generated files inside the style folder: the
numbered zoom-level directories and `meta.json`. Hand-authored data lives one
level up in the map folder, so `labels.json` survives any re-tile.

## Adding another map (e.g. a dungeon)

```bash
python tools/tile_map.py sources/some-dungeon.png \
    maps/some-dungeon/styles/original --name some-dungeon
```

Then register it in `MAPS` in `js/config.js`, pointing `dir` at
`maps/some-dungeon` and giving it a `styles` array whose first entry is
`original`.

## Alternate map styles (e.g. RuneScape Wiki tiles)

A map can have several tile renderings sharing one world pixel space, so
`labels.json` and the `home` view stay valid across all of them. The preview
cards top left switch between them whenever a map declares more than one style
in `js/config.js`.

The RuneScape Wiki's interactive map (`maps.runescape.wiki`) serves its own tile
set, one PNG per 64x64 game-tile map square per zoom and floor. Turning that
into a viewer-ready style is a four step pipeline.

**1. Fetch the raw tiles.** `fetch_wiki_tiles.py` reads `basemaps.json` for a
map's bounds and downloads only the tiles covering it, at whichever zoom and
layer you ask for. Floor layer 0 is ground level, the default, and all the
Surface map needs:

```bash
python tools/fetch_wiki_tiles.py 28 tools/wiki_cache --zoom 3   # 28 = RuneScape Surface
```

Tiles cache under `tools/wiki_cache/`, gitignored as scratch input. Out of
bounds tiles 404 and are skipped, and re-running resumes rather than
re-downloading. If tiles start 404ing outright the version path (`--version`,
default `2026-06-15`) has probably rolled forward. Check the interactive map's
network requests for the current `.../versions/<date>/` segment.

**2. Stitch them into one PNG.** The wiki's pyramid steps in powers of two:
zoom *n* is `2^(n-2)` px per game tile, so zoom 2 is 4px/tile and zoom 3 is
8px/tile. Whether that matches your source render is something to measure with
`python tools/align_wiki.py scales`, not to assume.

For `runescape-surface.png` the answer is that wiki zoom 2 is already 1:1 with
it, so stitch at native scale with no `--scale` and skip resampling entirely:

```bash
python tools/stitch_wiki_tiles.py tools/wiki_cache \
    sources/runescape-surface-wiki-native.png --mapid 28 --zoom 2
```

For a different map whose ratio genuinely isn't a power of two, prefer
expressing it as `place: { scale, x, y }` in `js/config.js` over resampling the
art. Only if you must resample: fetch the next zoom up from what you'd naively
need and downscale into place with `--scale`, rather than fetching the lower
zoom directly. Supersampling from more real source detail is markedly sharper
than stretching a smaller image.

`stitch_wiki_tiles.py` is adapted from the original `stitchmap2.py` stitcher:
same tile paste and orientation logic, but sized to the tiles that exist rather
than the whole 100x200 world grid, driven by CLI flags instead of hardcoded
lists, with an optional resize step.

The stitch won't be pixel-aligned with the source map yet, since it's a
different renderer with a different crop and origin. That's step 3.

Note that any downscale softens building and wall outlines. The wiki's renderer
bakes them into the terrain raster as roughly 1px lines, with no separate walls
layer to turn off ([confirmed
on-wiki](https://runescape.wiki/w/RuneScape:Map#Map_tiles): "these map regions
include ground color, roads, buildings, doors, walls, trees and other
objects"), so scaling down leaves them sub-pixel wide. `--sharpen N` (unsharp
mask, 0 is off) can claw some back, but on this map it made things worse:
haloing and noise on terrain textures outweighed the crisper lines. Another
reason to stay at 1:1 wherever the measurement allows.

**3. Find the offset, and don't take the ratio on faith.**

> **Measured, 2026-08-03:** for the RuneScape Surface map the native wiki stitch
> (11520x12800) and `runescape-surface.png` (21982x18101) are at the same px per
> game tile. The ratio is 1.0. Earlier revisions of this file claimed 3px/tile,
> a `--scale 0.375` stitch and a 4/3 `place`, all wrong and expensive to
> disprove. Measure before trusting any of it.

`align_wiki.py` compares the two images in game-tile units by plain subsampling,
so no interpolation and nothing invented, and reports the offset in every unit
you might need:

```bash
python tools/align_wiki.py scales    # measures px-per-game-tile AND the offset
python tools/align_wiki.py solve     # just the offset, at a known scale
```

Then look at the answer rather than believing the number. `preview` renders a
whole-map red, green and yellow land mask overlay at a candidate offset, which
settles any alignment argument in one glance:

```bash
python tools/align_wiki.py preview --x 5104 --y 2659
```

`tools/pad_align.html` is the interactive version of the same check. Run
`python tools/align_wiki.py previews` first to write the downscaled viewing
copies it loads, then drag the offset around and watch it snap into place.

`tools/align.html` is a different tool for a different case: a style whose
native resolution genuinely isn't 1:1 with the world, where you want `place`
in `js/config.js` instead of padding. It doesn't apply to the wiki style.

**3b. Bake the alignment into a padded source with `place_wiki_source.py`.**
This recolours the wiki's solid black "no data" areas and the stitcher's flat
gap fill to one blend colour, normally sampled from the wiki's own sea tint so
gaps disappear into the ocean rather than showing as mismatched blocks, then
pastes the stitch unscaled into a canvas the exact size of the original map.

Padding, never resizing, is the point. These are pixel art renders and the
viewer draws them nearest-neighbour at integer zoom steps, so resampling to
force an alignment throws away the crispness the whole viewer is built around.
If a style really is at a different native resolution, express that with `place`
in `js/config.js` and leave its pixels alone.

For the surface wiki style the pads are left 5104, top 2659, right 5358, bottom
2642, into a 21982x18101 canvas:

```bash
python tools/place_wiki_source.py sources/runescape-surface-wiki-native.png \
    sources/runescape-surface-wiki-final.png \
    --scale 1.0 --out-size 21982x18101 --x 5104 --y 2659 \
    --blend-color 119,137,165
```

**4. Tile it into the map's `styles/` folder.**

```bash
python tools/tile_map.py sources/runescape-surface-wiki-final.png \
    maps/surface/styles/wiki3d --name surface-wiki3d --bg 119,137,165
```

Because the source was padded to the original's exact dimensions, the style
needs no `place` entry in `js/config.js`. The two share one pixel space
natively, so `labels.json` needs no conversion either. Just add it to the map's
`styles` array; see that file's doc comment.
