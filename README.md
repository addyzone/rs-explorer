# 🗺 RS Wiki Explorer Map

A hand-labelled map of Gielinor, from the landmarks every player knows to the
quiet corners you only find by wandering. Every label links to its RuneScape
Wiki article. Pure front end, no mapping library, hostable on GitHub Pages.

## How it works

The source map is one large PNG, about 22,000 x 18,100 px. A Python tool slices
it into a tile pyramid (`{z}/{x}/{y}.png`), writing only the levels the viewer's
fixed zoom ladder can reach plus a small resident backdrop. Blank ocean tiles
are skipped, and any tile that fits in 256 colours (most of them, since this is
flat colour art) is stored as a palette PNG losslessly. A custom canvas viewer
draws the visible tiles, paints ocean under the gaps, and renders labels on
top, all with nearest-neighbour scaling so the pixel art stays crisp.

```
sources/*.png  ->  tools/tile_map.py  ->  maps/<id>/styles/<style>/{z}/{x}/{y}.png
                                          |                        + meta.json
                                          +->  index.html + js/  (the viewer)
```

## Project layout

Each map is self-contained under `maps/<id>/`. Hand-authored data sits at the
top; every tile rendering, including the one it opens with, is an equal folder
under `styles/`:

```
maps/surface/
  labels.json                  authored, tiered text labels
  styles/
    original/                  the in-game render (styles[0], opens by default)
      meta.json                generated, pyramid metadata + index
      {z}/{x}/{y}.png          generated, tiles
      thumb.jpg                picker card preview
    wiki3d/                    the RuneScape Wiki's 3D render
      meta.json, {z}/…, thumb.jpg
```

Nothing treats `original` as special; it is simply first in the map's `styles`
array in `js/config.js`. All styles share one world pixel space, so
`labels.json` and the home view stay valid whichever is active.

| Path | What |
|------|------|
| `sources/` | Stitched map PNGs (build inputs), all maps together. |
| `tools/tile_map.py` | The tiler. Re-run when a source map changes. See [tools/README.md](tools/README.md). |
| `maps/<id>/` | One map: `labels.json` plus a `styles/` folder per rendering. |
| `js/viewer.js` | Canvas tile viewer: pan, zoom, pinch, render. |
| `js/labels.js` | Label layer: spatial index, draw, hit-test, edit, serialise. |
| `js/wiki.js` | RuneScape Wiki API client for the sidebar. |
| `js/save.js` | Editor persistence, writes to disk where the browser allows. |
| `js/config.js` | Map list (folder, home view, styles) and label tiers. |
| `js/main.js` | Wires it together, plus the UI. |
| `index.html`, `css/` | The page and styling. |

## Run locally

Needs any static file server, since ES modules and `fetch` don't work over
`file://`:

```bash
python -m http.server 8765
```

Then open <http://localhost:8765>.

## Re-tiling a map

```bash
pip install -r tools/requirements.txt
python tools/tile_map.py sources/runescape-surface.png maps/surface/styles/original --name surface
```

This regenerates only that style's tiles and `meta.json`. `labels.json` lives a
level up in the map folder and is never touched. Full options are in
[tools/README.md](tools/README.md).

## Labels

Eight tiers, configured in `js/config.js` under `LABEL_TIERS`, each with its own
colour, size and zoom visibility window, emulating how the in-game map layers
its text:

| Tier | Look | Appears |
|------|------|---------|
| **Region** | large, orange | zoomed out, fades as you zoom in |
| **Major** | white | always (towns) |
| **Minor** | smaller | from ~28% zoom (large buildings) |
| **Landmark** | smaller still | from ~50% (altars, mines, stores) |
| **Feature** | small grey | from ~85% (points of interest) |
| **NPC** | small blue | from ~85% (friendly NPCs) |
| **Monster** | small orange | from ~85% (attackable monsters) |
| **Detail** | smallest | from 200% (minor scenery) |

Clicking a label opens its wiki summary in the side panel: intro, examine line,
thumbnail, section list and related pages.

On disk each label is one line of `labels.json`:

```json
{"id":"lumbridge","name":"Lumbridge","tier":"major","x":10604,"y":7909}
```

`wiki` is stored only when it differs from `name`, since the renderer falls back
to the name. This matters at scale: a finished surface map runs to five figures
of labels, and one line each keeps the file greppable, the diffs readable, and a
moved label a single changed line.

At load the layer builds a per-tier spatial grid over world coordinates, so a
frame costs roughly the number of labels near the viewport rather than every
label on the map. Measured at 10,000 labels: 4.5% touched per frame at 100%
zoom, 0.4% at 400%, worst case 17% fully zoomed out.

### Authoring labels

1. Press **Shift+E** for editor mode.
2. **Right-click** empty map to drop a label. Pick a tier and it is created,
   selected, with its name field focused. Click an existing label to edit it,
   or click then drag to move it.
3. **Ctrl+S** to save. Downloads `labels.json`, which you save over
   `maps/<id>/labels.json` yourself.
4. Commit.

The Save button carries a dot while there are unsaved edits, and closing the tab
with edits pending asks for confirmation.

Labels are stored in the map's native pixel coordinates, so they stay put
whatever the zoom, screen size or active style.

## Adding another map (e.g. a dungeon)

1. Drop the stitched PNG in `sources/`.
2. Tile it into a style folder:
   `python tools/tile_map.py sources/my-dungeon.png maps/my-dungeon/styles/original --name my-dungeon`.
3. Register it in `js/config.js` under `MAPS` with its `dir`, `home` view and a
   `styles` array whose first entry is that style.

It appears in the map switcher, and its `labels.json` lives at
`maps/my-dungeon/labels.json`.

## Alternate map styles

A map can offer more than one rendering of the same world. Here that is
**Original**, the in-game render, and **RS Wiki 3D**, built from the RuneScape
Wiki's own tiles. The preview cards top left switch between them whenever a map
declares more than one. Switching keeps your pan and zoom; only the tiles
underneath change.

Adding one is a fetch, stitch, align, pad and tile pipeline. See
[tools/README.md](tools/README.md#alternate-map-styles-eg-runescape-wiki-tiles).
When a style requires attribution it shows in the footer while active.

## Deploy to GitHub Pages

Commit everything and enable Pages (Settings, Pages, deploy from branch, root).
It is all static. The generated `maps/` tiles must be committed since Pages
serves them directly, about 75 MB for both surface styles.

The two wiki-style build intermediates in `sources/` are gitignored: roughly
109 MB and rebuildable from the documented pipeline. `runescape-surface.png` is
committed, since everything else is aligned against it and it can't be
regenerated.

## Controls

- **Drag** to pan, **scroll** or **pinch** to zoom toward the cursor or
  fingers. Zoom snaps to pixel-perfect steps (25%, 50%, then 100% to 800% in
  integer multiples), so a resting view never sits on a fractional scale. A
  pinch runs freely under your fingers and settles on the nearest step when you
  let go.
- **+ / - / reset** buttons: zoom in, out, back to the home view.
- The URL tracks map, style, view and selected label, so any view is shareable
  and survives a refresh.
- Editor mode (**Shift+E**) adds cursor coordinates, the current tile level and
  the authoring tools above.

## Legal

Created using intellectual property belonging to Jagex Limited under the terms
of Jagex's Fan Content Policy. This content is not endorsed by or affiliated
with Jagex.

Map tiles for the RS Wiki 3D style, and all article content shown in the side
panel, come from the [RuneScape Wiki](https://runescape.wiki) and are available
under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).
