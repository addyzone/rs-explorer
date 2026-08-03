// labels.js: the tiered text-label layer, emulating the in-game map.
//
// Labels are stored in world coordinates so they stay put. Each has a `tier`
// driving colour, size and zoom visibility, plus an optional `wiki` page shown
// in the sidebar when clicked.
//
// Drawing happens in the viewer's overlay pass, in CSS pixel space. Each
// visible label's screen rect is recorded as it's drawn, so clicks and hovers
// hit-test cheaply.

import { LABEL_TIERS, TIER_ORDER, DEFAULT_TIER } from "./config.js";
import { titleFromWiki, fetchSummary } from "./wiki.js";

const FONT_STACK = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';

// Screen-px margin for the cull in draw(). Larger than any real label's box,
// so it only ever produces false "maybe visible" positives and never drops one
// that is actually in view.
const CULL_PAD = 320;

// Side of one spatial-index cell, in world px. The index makes a frame cost
// O(labels near the viewport) instead of O(every label). At 10k labels a full
// per-frame sweep eats most of the frame budget, nearly all of it spent
// rejecting labels thousands of pixels off screen.
//
// 512 puts the whole 21982x18101 surface in a 43x36 grid: small enough that a
// deep zoom touches one or two cells, coarse enough that the grid stays a few
// hundred entries rather than one per label.
const GRID_CELL = 512;

// Interpolated font size for a tier at the given CSS scale. Falls back to the
// tier's flat `font` when it has no `sizeSteps`.
function sizeForScale(t, scale) {
  const steps = t.sizeSteps;
  if (!steps || !steps.length) return t.font;
  if (scale <= steps[0][0]) return steps[0][1];
  for (let i = 1; i < steps.length; i++) {
    const [s0, f0] = steps[i - 1];
    const [s1, f1] = steps[i];
    if (scale <= s1) return f0 + (f1 - f0) * ((scale - s0) / (s1 - s0));
  }
  return steps[steps.length - 1][1];
}

export class LabelLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.labels = [];
    this.selected = null;
    this.hovered = null;
    this.authorMode = false;
    this.nextId = 1;
    this._ids = new Set(); // every id in use, so _freshId() never collides
    this.onSelect = null; // (label|null)
    this.onChange = null; // () => void
    this._drawn = [];      // [{label, x0,y0,x1,y1}] in CSS px, painter order
    this._dragLabel = null; // label being repositioned via drag, or null
    this._dragOffset = { x: 0, y: 0 };
    this.wikiValid = new Map(); // label.id -> true|false, only set once resolved
    this.styleProfile = { sizeMul: 1, haloMul: 1 }; // set via setStyleProfile()
    this._grids = null;   // tier -> Map("cx,cy" -> [label]); see _rebuildIndex()
    this._visPool = [];   // reusable per-frame scratch objects, see draw()
    this._rebuildIndex();
  }

  // ---- spatial index ------------------------------------------------------
  // One uniform grid per tier, not one shared grid. Tiers are the map's level
  // of detail mechanism: zoomed out, only region and major are above their
  // visibility threshold at all. Separate grids let a frame skip whole tiers
  // without looking at any of their labels, which is the case that matters,
  // since zoomed out is both where the most labels fall inside the viewport
  // and where all but a couple of tiers are invisible. A shared grid would
  // still visit every label in view just to find its tier is faded out.
  _rebuildIndex() {
    this._grids = {};
    for (const k of TIER_ORDER) this._grids[k] = new Map();
    for (const l of this.labels) this._indexInsert(l);
  }

  _tierOf(l) {
    return LABEL_TIERS[l.tier] ? l.tier : DEFAULT_TIER;
  }

  _indexInsert(l) {
    const tier = this._tierOf(l);
    const key = Math.floor(l.x / GRID_CELL) + "," + Math.floor(l.y / GRID_CELL);
    const grid = this._grids[tier];
    let cell = grid.get(key);
    if (!cell) grid.set(key, (cell = []));
    cell.push(l);
    // Remembered rather than recomputed, so a later move or tier change
    // removes the label from the cell it is actually in. Its coordinates have
    // usually already changed by the time removal is asked for.
    l._cell = key;
    l._cellTier = tier;
  }

  _indexRemove(l) {
    const grid = this._grids[l._cellTier];
    if (!grid) return;
    const cell = grid.get(l._cell);
    if (!cell) return;
    const i = cell.indexOf(l);
    if (i >= 0) cell.splice(i, 1);
    if (!cell.length) grid.delete(l._cell);
  }

  // Re-file a label after its position or tier changed. Two array operations,
  // cheap enough for every pointermove of a drag, so moving a label never
  // rebuilds the whole index.
  _indexUpdate(l) {
    this._indexRemove(l);
    this._indexInsert(l);
  }

  // Per-style tweaks from config.js styles[].labelStyle. The wiki style's
  // busier art needs bigger, more heavily shadowed text to stay legible.
  // Applied on top of each tier's own size and halo.
  setStyleProfile(profile) {
    this.styleProfile = { sizeMul: 1, haloMul: 1, ...profile };
    this.viewer.invalidate();
  }

  load(list) {
    this.labels = (list || []).map((l, i) => ({
      tier: DEFAULT_TIER,
      wiki: "",
      ...l,
      id: l.id || "label-" + (i + 1),
    }));
    this._ids = new Set(this.labels.map((l) => l.id));
    this.nextId = 1;
    this._rebuildIndex();
    this.viewer.invalidate();
  }

  // Smallest unused "label-N". Scanning for a free slot keeps ids unique
  // whatever is already in the file. The old approach parsed a trailing number
  // off every id, so one hand-named slug ending in a digit ("varrock-2") set
  // the counter to 3 and the next generated ids collided.
  _freshId() {
    while (this._ids.has("label-" + this.nextId)) this.nextId++;
    return "label-" + this.nextId;
  }

  add(world, tier = DEFAULT_TIER) {
    const label = {
      id: this._freshId(),
      name: "New label",
      tier,
      x: Math.round(world.x),
      y: Math.round(world.y),
      wiki: "",
    };
    this.labels.push(label);
    this._ids.add(label.id);
    this._indexInsert(label);
    this.select(label);
    if (this.onChange) this.onChange();
    this.viewer.invalidate();
    return label;
  }

  // Patches never trigger a wiki check themselves: while typing a name or
  // wiki field, `update()` fires on every keystroke, and checking the wiki on
  // every one of those was the actual source of "too many requests" (a
  // half-typed title still round-trips to the API before failing). The caller
  // decides when a check is actually warranted, see checkWiki() below.
  update(label, patch) {
    const moved = ("x" in patch && patch.x !== label.x) || ("y" in patch && patch.y !== label.y);
    const retiered = "tier" in patch && patch.tier !== label.tier;
    Object.assign(label, patch);
    if (moved || retiered) this._indexUpdate(label);
    if (this.onChange) this.onChange();
    this.viewer.invalidate();
  }

  // Checks a label's wiki field against the live wiki and records whether it
  // points at a real page. A blank field falls back to the label's own name,
  // since the two match often enough to be worth trying. Only an unset field
  // whose name also fails to resolve counts as invalid.
  //
  // Called once when a label is opened for editing, and again when the name
  // or wiki field is left (blur), not on every keystroke, and never for the
  // whole label set at once. wiki.js caches by title, so re-checking a label
  // whose title hasn't changed since the last check costs nothing further.
  async checkWiki(label) {
    const raw = (label.wiki && label.wiki.trim()) || String(label.name || "").replace(/\n/g, " ").trim();
    if (!raw) {
      this.wikiValid.set(label.id, false);
      this.viewer.invalidate();
      return;
    }
    const title = titleFromWiki(raw);
    try {
      const s = await fetchSummary(title);
      this.wikiValid.set(label.id, !!s);
    } catch (e) {
      this.wikiValid.delete(label.id); // network hiccup, so unknown, don't flag
    }
    this.viewer.invalidate();
  }

  remove(label) {
    const i = this.labels.indexOf(label);
    if (i >= 0) this.labels.splice(i, 1);
    this._ids.delete(label.id);
    this._indexRemove(label);
    if (this.hovered === label) this.hovered = null;
    if (this.selected === label) this.select(null);
    if (this.onChange) this.onChange();
    this.viewer.invalidate();
  }

  select(label) {
    this.selected = label;
    if (this.onSelect) this.onSelect(label);
    this.viewer.invalidate();
  }

  // Visibility 0..1 for a tier at the given CSS scale, with a soft fade near
  // each edge of its window. The fade width is multiplicative rather than
  // additive, so it behaves the same whether a window sits at 0.5x or 5x. A
  // tier can override it with `fadeBand`.
  tierAlpha(tierKey, scale) {
    const t = LABEL_TIERS[tierKey] || LABEL_TIERS[DEFAULT_TIER];
    const BAND = t.fadeBand || 1.7;
    let a = 1;
    if (t.minScale > 0 && scale < t.minScale * BAND) {
      a = Math.min(a, (scale / t.minScale - 1) / (BAND - 1));
    }
    if (isFinite(t.maxScale) && scale > t.maxScale / BAND) {
      a = Math.min(a, (t.maxScale / scale - 1) / (BAND - 1));
    }
    return Math.max(0, Math.min(1, a));
  }

  // Append every label of one tier whose cell overlaps the query rect into the
  // visible pool, gated by alpha and a screen-space cull. Returns the new pool
  // length.
  //
  // Walking cell by cell is the fast path, but zoomed right out the query rect
  // covers more cells than the tier has labels, and iterating the Map's own
  // entries beats probing thousands of absent keys. The size comparison picks
  // whichever is smaller, so neither end of the zoom range has a bad case.
  _gather(tierKey, alpha, q, api, vw, vh, n) {
    const grid = this._grids[tierKey];
    if (!grid.size) return n;
    const pool = this._visPool;
    const t = LABEL_TIERS[tierKey];
    const cx0 = Math.floor(q.x0 / GRID_CELL), cx1 = Math.floor(q.x1 / GRID_CELL);
    const cy0 = Math.floor(q.y0 / GRID_CELL), cy1 = Math.floor(q.y1 / GRID_CELL);

    const push = (l) => {
      const isSel = l === this.selected;
      const isHov = l === this.hovered;
      const p = api.toScreen(l.x, l.y);
      if (p.x < -CULL_PAD || p.y < -CULL_PAD || p.x > vw + CULL_PAD || p.y > vh + CULL_PAD) return;
      let e = pool[n];
      if (!e) pool[n] = e = {};
      e.l = l; e.t = t; e.isSel = isSel; e.isHov = isHov;
      e.alpha = isSel || isHov ? Math.max(alpha, 0.9) : alpha; // keep interactive ones legible
      e.px = p.x; e.py = p.y;
      n++;
    };

    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) <= grid.size) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const cell = grid.get(cx + "," + cy);
          if (cell) for (const l of cell) push(l);
        }
      }
    } else {
      for (const cell of grid.values()) {
        for (const l of cell) {
          if (l.x >= q.x0 && l.x <= q.x1 && l.y >= q.y0 && l.y <= q.y1) push(l);
        }
      }
    }
    return n;
  }

  // Below this many visible labels, draw the full three-layer halo; above it,
  // fewer or none. Profiled: stroked text dominates label cost. Removing the
  // halo took a 243-label frame from ~40ms p95 to ~2.4ms, while measureText,
  // fillText and font stay cheap into the hundreds. Normal navigation sits
  // well under the threshold, so this only trades halo softness for frame time
  // when a lot are on screen at once.
  static HALO_FULL_MAX = 120;
  static HALO_THIN_MAX = 300;

  draw(ctx, api) {
    this._drawn.length = 0;
    const s = api.scale;
    const vw = api.viewport.w, vh = api.viewport.h;

    // Pass 1 (cheap): walk the tiers from lowest priority to highest, pulling
    // each one's in-view labels out of its spatial grid. No font/measureText
    // is touched yet, so this both skips off-screen labels cheaply AND tells
    // us how many are really in view, letting pass 2 pick a halo detail level
    // before it starts drawing.
    //
    // Descending rank is the paint order: detail first, region last. So region
    // ends up over major, major over minor, and hitTest, which walks painter
    // order backwards, resolves an overlapping click to whichever label looks
    // topmost. Gathering tier by tier gets that for free, with no sort.
    //
    // Results go into this._visPool, a fixed set of reusable objects grown
    // lazily and never shrunk, rather than fresh literals. This runs every
    // frame while panning, and allocating hundreds of short-lived objects per
    // frame was measurable: a 35 to 110ms GC pause every 20 frames or so under
    // a 250-label stress test, on an otherwise 2ms frame.
    const pool = this._visPool;
    let n = 0;
    const padWorld = CULL_PAD / s;
    const tl = api.toWorld(0, 0);
    const br = api.toWorld(vw, vh);
    const q = {
      x0: tl.x - padWorld, y0: tl.y - padWorld,
      x1: br.x + padWorld, y1: br.y + padWorld,
    };
    let faded = null; // tiers skipped wholesale this frame, if any
    for (let rank = TIER_ORDER.length - 1; rank >= 0; rank--) {
      const tierKey = TIER_ORDER[rank];
      const alpha = this.tierAlpha(tierKey, s);
      if (alpha <= 0.02) {
        (faded || (faded = [])).push(tierKey);
        continue; // whole tier invisible, so its labels are never touched
      }
      n = this._gather(tierKey, alpha, q, api, vw, vh, n);
    }

    // A selected or hovered label stays legible even once its tier has faded
    // out, but the loop above skipped that tier without looking, so pick those
    // two up here. They land at the end of the pool and so paint on top, which
    // is where the one you are interacting with belongs.
    if (faded) {
      const interactive = this.hovered === this.selected ? [this.selected] : [this.hovered, this.selected];
      for (const l of interactive) {
        if (!l || !faded.includes(this._tierOf(l))) continue;
        const p = api.toScreen(l.x, l.y);
        if (p.x < -CULL_PAD || p.y < -CULL_PAD || p.x > vw + CULL_PAD || p.y > vh + CULL_PAD) continue;
        let e = pool[n];
        if (!e) pool[n] = e = {};
        e.l = l; e.t = LABEL_TIERS[this._tierOf(l)];
        e.isSel = l === this.selected; e.isHov = l === this.hovered;
        e.alpha = 0.9; e.px = p.x; e.py = p.y;
        n++;
      }
    }

    const haloLayerCount = n <= LabelLayer.HALO_FULL_MAX ? 3
      : n <= LabelLayer.HALO_THIN_MAX ? 1
      : 0;

    // Pass 2 (the expensive part): font/measure/draw, only for what pass 1
    // kept.
    let lastFont = null; // paint order groups by tier, so this rarely changes
    for (let vi = 0; vi < n; vi++) {
      const { l, t, isSel, isHov, alpha, px, py } = pool[vi];
      const size = sizeForScale(t, s) * this.styleProfile.sizeMul;

      const font = `${t.weight} ${size}px ${FONT_STACK}`;
      if (font !== lastFont) { ctx.font = font; lastFont = font; }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const hasTracking = "letterSpacing" in ctx;
      if (hasTracking) ctx.letterSpacing = (t.tracking || 0) + "px";

      // Layout only changes when the font string or the text changes, not
      // every frame, and during a pan neither changes for any label. Even so,
      // re-running split() and measureText() per visible label per frame
      // allocated a fresh array and TextMetrics each time, enough to trigger a
      // GC pause every 20 frames or so under a 250-label stress test. The
      // cache lives on the label; exportJson only reads named fields, so it
      // never leaks into the file.
      let lay = l._layout;
      if (!lay || lay.font !== font || lay.name !== l.name) {
        const lines = String(l.name || "").split("\n");
        let maxW = 0;
        for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
        lay = l._layout = { font, name: l.name, lines, maxW };
      }
      const { lines, maxW } = lay;
      const lineH = size * 1.18;
      const totalH = lineH * lines.length;

      // Precise cull now that we know the label's actual box (the fixed-pad
      // check in pass 1 only rules out the obviously-offscreen majority).
      if (px < -maxW || py < -totalH || px > vw + maxW || py > vh + totalH) {
        if (hasTracking) ctx.letterSpacing = "0px";
        continue;
      }

      ctx.globalAlpha = alpha;
      const yTop = py - totalH / 2 + lineH / 2;

      // Two shadows, furthest back first. A centred halo that fades: several
      // concentric strokes, each wider and fainter, standing in for a real
      // blur, which is too slow to run per label per frame. Then a crisp solid
      // 1px offset shadow for the flat old-school game look. The halo drops
      // layers once a lot of labels are visible, since it dominates frame cost
      // there, and the 1px shadow keeps text readable without it.
      if (haloLayerCount > 0) {
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        const haloMul = this.styleProfile.haloMul;
        const allHaloLayers = [
          [size * 0.4 * haloMul, Math.min(1, 0.02 * haloMul)],
          [size * 0.26 * haloMul, Math.min(1, 0.035 * haloMul)],
          [size * 0.13 * haloMul, Math.min(1, 0.05 * haloMul)],
        ];
        const haloLayers = haloLayerCount === 3 ? allHaloLayers : allHaloLayers.slice(-haloLayerCount);
        for (const [w, a] of haloLayers) {
          ctx.strokeStyle = `rgba(0,0,0,${a})`;
          ctx.lineWidth = w;
          for (let i = 0; i < lines.length; i++) {
            const yy = yTop + i * lineH;
            ctx.strokeText(lines[i], px, yy);
          }
        }
      }

      ctx.fillStyle = "#000000";
      for (let i = 0; i < lines.length; i++) {
        const yy = yTop + i * lineH;
        ctx.fillText(lines[i], px + 1, yy + 1);
      }

      ctx.fillStyle = isSel || isHov ? this._brighten(t.color) : t.color;
      for (let i = 0; i < lines.length; i++) {
        const yy = yTop + i * lineH;
        ctx.fillText(lines[i], px, yy);
      }

      if (isSel) {
        // Gap below the text scales with font size instead of a flat 2.5px.
        // At a fixed gap the smallest tiers (detail, feature, npc, monster,
        // around 9px) read as sitting well clear of their own text, since the
        // same 2.5px is proportionally much bigger next to short letters than
        // next to a 22px region label.
        const gap = Math.max(1.5, Math.min(3, size * 0.16));
        ctx.beginPath();
        ctx.moveTo(px - maxW / 2, py + totalH / 2 + gap);
        ctx.lineTo(px + maxW / 2, py + totalH / 2 + gap);
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      if (hasTracking) ctx.letterSpacing = "0px";

      if (this.authorMode && this.wikiValid.get(l.id) === false) {
        const bx = px + maxW / 2 + 11;
        const by = py - totalH / 2 - 1;
        ctx.beginPath();
        ctx.arc(bx, by, 8, 0, Math.PI * 2);
        ctx.fillStyle = "#e0201f";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#000000";
        ctx.stroke();
        ctx.font = `900 12px ${FONT_STACK}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff";
        ctx.fillText("!", bx, by + 1);
      }

      this._drawn.push({
        label: l,
        x0: px - maxW / 2 - 4, y0: py - totalH / 2 - 3,
        x1: px + maxW / 2 + 4, y1: py + totalH / 2 + 3,
      });
    }
  }

  _brighten(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return "#ffffff";
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const mix = (c) => Math.round(c + (255 - c) * 0.35);
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
  }

  // Topmost label whose box contains the CSS-px point, or null.
  hitTest(sx, sy) {
    for (let i = this._drawn.length - 1; i >= 0; i--) {
      const d = this._drawn[i];
      if (sx >= d.x0 && sx <= d.x1 && sy >= d.y0 && sy <= d.y1) return d.label;
    }
    return null;
  }

  // Left click only selects and deselects. Adding is a right-click gesture,
  // see main.js's tier quick menu, so a click on empty map never surprises you
  // with a new label underfoot.
  handleClick(world, css) {
    const hit = this.hitTest(css.x, css.y);
    if (hit) { this.select(hit); return true; }
    this.select(null);
    return false;
  }

  // Author-mode drag to reposition. `css` is the pointer position in the same
  // canvas-local CSS px space as hitTest and _drawn. True means a label was
  // grabbed, claiming the drag away from map panning.
  // Only an already-selected label is grabbed. A click and drag in one motion
  // pans instead, even starting on top of a label, so panning near labels
  // can't move one by accident. Click to select, then drag.
  beginDrag(world, css) {
    if (!this.authorMode) return false;
    const hit = this.hitTest(css.x, css.y);
    if (!hit || hit !== this.selected) return false;
    this._dragLabel = hit;
    this._dragOffset = { x: hit.x - world.x, y: hit.y - world.y };
    return true;
  }

  dragTo(world) {
    if (!this._dragLabel) return;
    this.update(this._dragLabel, {
      x: Math.round(world.x + this._dragOffset.x),
      y: Math.round(world.y + this._dragOffset.y),
    });
  }

  endDrag() {
    this._dragLabel = null;
  }

  handleHover(sx, sy) {
    const hit = this.hitTest(sx, sy);
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.viewer.invalidate();
    }
    return hit;
  }

  // Serialise to the on-disk format: valid JSON, one label per line rather
  // than pretty-printed across eight.
  //
  // This is what keeps the file workable. Fully expanded, a finished surface
  // map runs to six figures of lines and every edit produces an unreadable
  // diff. One line per label stays greppable, and a moved label is one
  // changed line.
  //
  // `wiki` is omitted when blank or when it just repeats `name`. The renderer
  // already falls back to the name, so storing it again duplicated roughly
  // half the labels.
  exportJson(mapId) {
    const lines = this.labels.map((l) => {
      const out = { id: l.id, name: l.name, tier: l.tier, x: l.x, y: l.y };
      const wiki = (l.wiki || "").trim();
      if (wiki && wiki !== String(l.name || "").replace(/\n/g, " ").trim()) out.wiki = wiki;
      return "    " + JSON.stringify(out);
    });
    return `{\n  "map": ${JSON.stringify(mapId)},\n  "labels": [\n${lines.join(",\n")}\n  ]\n}\n`;
  }
}
