# RS Wiki Explorer Map

A pannable, zoomable map of Gielinor with hand-placed labels. Click one to
read its RuneScape Wiki article. Pure static front end, no map library,
hostable straight from GitHub Pages.

The base map is a hand-stitched screenshot of the in-game map with all icons
turned off. The "RS Wiki 3D" style is built from tiles pulled off the
RuneScape Wiki's own mapping tool. Every label on top is placed by hand.

## Running it locally

Needs any static file server, since ES modules and `fetch` don't work over
`file://`:

```bash
python -m http.server 8765
```

Then open <http://localhost:8765>.

## Layout

- `sources/` – the stitched source PNGs
- `tools/tile_map.py` – slices a source PNG into a tile pyramid (see [tools/README.md](tools/README.md))
- `maps/<id>/` – one map: `labels.json` plus a `styles/` folder of tiles
- `js/`, `css/`, `index.html` – the viewer

## Editing labels

**Shift+E** toggles editor mode. Right-click the map to add a label, click one
to edit or drag it, **Ctrl+S** downloads the updated `labels.json` — save it
over `maps/<id>/labels.json` and commit.

## Search

Click the search icon (top right) to find a label by name and jump to it,
paging through matches with the arrows.

## Legal

Created using intellectual property belonging to Jagex Limited under the
terms of Jagex's Fan Content Policy. This content is not endorsed by or
affiliated with Jagex.

Map tiles for the RS Wiki 3D style, and all article content shown in the side
panel, come from the [RuneScape Wiki](https://runescape.wiki) and are
available under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).
