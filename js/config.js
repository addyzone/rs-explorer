// config.js: app-level configuration.
//
// MAPS: each entry is a switchable map layer (surface, dungeons, and so on).
// A map is self-contained under maps/<id>/, holding the hand-authored
// labels.json plus a styles/ folder with one subfolder of tiles per style.
//   id     : unique key
//   label  : shown in the map switcher
//   dir    : the map's folder
//   home   : default view, centre in world px plus zoom (1 = 100%)
//   styles : every tile rendering of this map, including the one it opens
//            with, which is just styles[0]. There is no separate "default"
//            concept: each style is an equal folder at `${dir}/styles/${id}/`
//            holding its own tiles and meta.json, so nothing about the first
//            entry is special-cased in the viewer. Styles share one world
//            pixel space, which keeps labels and `home` valid across all of
//            them. Per entry:
//              id          : unique within the map, used as the folder name
//              label       : shown on the picker card
//              thumb       : preview image for the picker card
//              chrome      : optional CSS class added to <body> while active,
//                            for a UI reskin. Omit for no change.
//              labelStyle  : optional { sizeMul, haloMul } applied to every
//                            label while active. Omit for 1 and 1.
//              attribution : optional HTML shown in the footer while active
//              place       : optional { scale, x, y } mapping this style's own
//                            native tile pixels onto world coordinates, so its
//                            source never has to be resized to match another
//                            style (which would resample the art). `scale` is
//                            native px per world px; (x, y) is the world
//                            coordinate of this style's own pixel (0,0). Omit
//                            when the style was tiled from an already-aligned
//                            image sharing the world's pixel space.
//            See tools/README.md for the fetch, stitch, pad and tile pipeline.
//            A map with one style shows no picker.
export const MAPS = [
  {
    id: "surface",
    label: "RuneScape Surface",
    dir: "maps/surface",
    home: { x: 10560, y: 7960, cssScale: 1 },
    styles: [
      {
        id: "original",
        label: "Original",
        thumb: "maps/surface/styles/original/thumb.jpg",
      },
      {
        id: "wiki3d",
        label: "RS Wiki 3D",
        thumb: "maps/surface/styles/wiki3d/thumb.jpg",
        chrome: "style-wiki3d",
        labelStyle: { sizeMul: 1.15, haloMul: 2.2 },
        attribution:
          'Map tiles courtesy of the <a href="https://runescape.wiki" target="_blank" rel="noopener">RuneScape Wiki</a>.',
        // No `place`: the wiki source is padded, never scaled, to the original
        // style's exact dimensions, so the two share one coordinate space.
        // tools/README.md has the measured pads.
      },
    ],
  },
  // Add dungeon or region maps here once tiled, e.g.:
  // { id: "varrock-sewers", label: "Varrock Sewers", dir: "maps/varrock-sewers",
  //   home: { x: 0, y: 0, cssScale: 1 },
  //   styles: [{ id: "original", label: "Original", thumb: "…" }] },
];

// Standard file names inside a map folder.
export const MAP_FILES = {
  meta: "meta.json",
  labels: "labels.json",
};

// Label tiers, emulating the in-game map's layered text. Each has a colour, a
// base font size in screen px, a weight, optional letter `tracking`, and a
// visibility window in CSS px per world px (the same scale the zoom ladder
// uses, where 0.25 is 25%). Labels fade near the edges of their window.
//
// `sizeSteps` is an optional list of [scale, font] pairs, ascending, which are
// interpolated between and clamped at the ends. It lets a tier shrink at low
// zoom without touching its separate opacity window.
//
//   region   : large and orange, seen zoomed out, gone when zoomed right in
//   major    : white, always visible (towns), shrinks below 50%
//   minor    : smaller, fully in by 50% (large buildings)
//   landmark : smaller still, fully in by 100% (altars, mines, stores)
//   feature  : smaller again, fully in by ~145% (points of interest)
//   npc      : feature-sized, tinted blue (friendly NPCs)
//   monster  : feature-sized, tinted orange (attackable monsters)
//   detail   : smallest, hidden below 200%, fully in by 400% (minor scenery).
//              Uses its own narrower `fadeBand` so each step of the fade lands
//              on a real zoom rung rather than an in-between value like 350%
//              that you'd never rest on.
//
// Every tier steps up between 100% and 200% so labels don't feel undersized
// once zoomed in (except region, which has faded out by then), and keeps
// nudging up from 500% to 800% in small sub-linear increments, using the extra
// room a deep zoom gives without ballooning.
export const LABEL_TIERS = {
  region:   { label: "Region",   color: "#e8992e", font: 22,   weight: 800, tracking: 0.6, minScale: 0,    maxScale: 1.1 },
  major:    { label: "Major",    color: "#f6f2e8", font: 17,   weight: 700, tracking: 0.2, minScale: 0,    maxScale: Infinity, sizeSteps: [[0.25, 12], [0.5, 17], [1, 17], [2, 19], [5, 20], [6, 20.5], [7, 21], [8, 21.5]] },
  minor:    { label: "Minor",    color: "#e6ddca", font: 12.5, weight: 600, tracking: 0.1, minScale: 0.28, maxScale: Infinity, sizeSteps: [[0.28, 12.5], [1, 12.5], [2, 14], [5, 15], [6, 15.5], [7, 16], [8, 16.5]] },
  landmark: { label: "Landmark", color: "#c9d3dd", font: 11,   weight: 500, tracking: 0,   minScale: 0.52, maxScale: Infinity, sizeSteps: [[0.52, 11], [1, 11], [2, 12.5], [5, 13.5], [6, 14], [7, 14.5], [8, 15]] },
  feature:  { label: "Feature",  color: "#9aa2ab", font: 9,    weight: 500, tracking: 0,   minScale: 0.85, maxScale: Infinity, sizeSteps: [[0.85, 9], [1, 9], [2, 10.5], [5, 11.5], [6, 12], [7, 12.5], [8, 13]] },
  npc:      { label: "NPC",      color: "#7fa8cf", font: 9,    weight: 500, tracking: 0,   minScale: 0.85, maxScale: Infinity, sizeSteps: [[0.85, 9], [1, 9], [2, 10.5], [5, 11.5], [6, 12], [7, 12.5], [8, 13]] },
  monster:  { label: "Monster",  color: "#cf9868", font: 9,    weight: 500, tracking: 0,   minScale: 0.85, maxScale: Infinity, sizeSteps: [[0.85, 9], [1, 9], [2, 10.5], [5, 11.5], [6, 12], [7, 12.5], [8, 13]] },
  detail:   { label: "Detail",   color: "#9aa2ab", font: 7.5,  weight: 500, tracking: 0,   minScale: 2,    maxScale: Infinity, fadeBand: 2, sizeSteps: [[1, 7.5], [2, 8.5], [5, 9.5], [6, 10], [7, 10.5], [8, 11]] },
};

// Paint order, bottom to top. The result reads as region on top of major, on
// top of minor, then landmark, then feature/npc/monster, then detail.
// labels.js draws by walking this list backwards, which is also the order it
// queries the per-tier spatial grids in.
export const TIER_ORDER = ["region", "major", "minor", "landmark", "feature", "npc", "monster", "detail"];
export const DEFAULT_TIER = "major";
