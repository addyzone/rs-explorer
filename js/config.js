// MAPS: switchable map layers. Each is self-contained under maps/<id>/, with
// labels.json plus a styles/ folder holding one tile pyramid per style.
// `styles[0]` is the one it opens with; every style is otherwise equal,
// living at `${dir}/styles/${id}/`. All styles share one world pixel space.
// `place: { scale, x, y }` maps a style's own native tile pixels onto world
// coordinates when its source wasn't pre-aligned to the others (scale =
// native px per world px; x,y = world coords of that style's pixel 0,0).
// See tools/README.md for the fetch/stitch/pad/tile pipeline.
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
        // No `place`: padded (not scaled) to the original style's exact
        // dimensions, so the two already share one coordinate space.
      },
    ],
  },
  // { id: "varrock-sewers", label: "Varrock Sewers", dir: "maps/varrock-sewers",
  //   home: { x: 0, y: 0, cssScale: 1 },
  //   styles: [{ id: "original", label: "Original", thumb: "…" }] },
];

export const MAP_FILES = {
  meta: "meta.json",
  labels: "labels.json",
  media: "media.json",
};

// Label tiers, emulating the in-game map's layered text. `minScale`/`maxScale`
// are CSS px per world px (0.25 = 25% zoom); labels fade near the edges of
// that window, using `fadeBand` if set. `sizeSteps` is an optional ascending
// [scale, font] list, interpolated and clamped at the ends. `searchZoom` is
// the CSS scale the search box jumps to for a label of that tier (main.js),
// set past `minScale` so it's already faded fully in on arrival.
export const LABEL_TIERS = {
  region:   { label: "Region",   color: "#e8992e", font: 22,   weight: 800, tracking: 0.6, minScale: 0,    maxScale: 1.1,       searchZoom: 0.25 },
  major:    { label: "Major",    color: "#f6f2e8", font: 17,   weight: 700, tracking: 0.2, minScale: 0,    maxScale: Infinity,  searchZoom: 0.5,  sizeSteps: [[0.25, 12], [0.5, 17], [1, 17], [2, 19], [5, 20], [6, 20.75], [7, 21.5], [8, 22.25]] },
  minor:    { label: "Minor",    color: "#e6ddca", font: 12.5, weight: 600, tracking: 0.1, minScale: 0.28, maxScale: Infinity,  searchZoom: 0.5,  sizeSteps: [[0.28, 12.5], [1, 12.5], [2, 14], [5, 15], [6, 15.75], [7, 16.5], [8, 17.25]] },
  landmark: { label: "Landmark", color: "#c9d3dd", font: 11,   weight: 500, tracking: 0,   minScale: 0.52, maxScale: Infinity,  searchZoom: 1,    sizeSteps: [[0.52, 11], [1, 11], [2, 12.5], [5, 13.5], [6, 14.25], [7, 15], [8, 15.75]] },
  feature:  { label: "Feature",  color: "#9aa2ab", font: 9,    weight: 500, tracking: 0,   minScale: 0.85, maxScale: Infinity,  searchZoom: 1,    sizeSteps: [[0.85, 9], [1, 9], [2, 10.5], [5, 11.5], [6, 12.25], [7, 13], [8, 13.75]] },
  npc:      { label: "NPC",      color: "#7fa8cf", font: 9,    weight: 500, tracking: 0,   minScale: 0.85, maxScale: Infinity,  searchZoom: 1,    sizeSteps: [[0.85, 9], [1, 9], [2, 10.5], [5, 11.5], [6, 12.25], [7, 13], [8, 13.75]] },
  monster:  { label: "Monster",  color: "#cf9868", font: 9,    weight: 500, tracking: 0,   minScale: 0.85, maxScale: Infinity,  searchZoom: 1,    sizeSteps: [[0.85, 9], [1, 9], [2, 10.5], [5, 11.5], [6, 12.25], [7, 13], [8, 13.75]] },
  detail:   { label: "Detail",   color: "#9aa2ab", font: 7.5,  weight: 500, tracking: 0,   minScale: 2,    maxScale: Infinity,  searchZoom: 2.5,  fadeBand: 2, sizeSteps: [[1, 7.5], [2, 8.5], [5, 9.5], [6, 10.25], [7, 11], [8, 11.75]] },
};

// Paint order, bottom to top; labels.js walks it backwards.
export const TIER_ORDER = ["region", "major", "minor", "landmark", "feature", "npc", "monster", "detail"];
export const DEFAULT_TIER = "major";
