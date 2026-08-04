import { LABEL_TIERS, TIER_ORDER, DEFAULT_TIER } from "./config.js";
import { titleFromWiki, fetchSummary } from "./wiki.js";

const FONT_STACK = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';

// Screen-px cull margin in draw(); larger than any real label box, so it only
// ever produces false "maybe visible" positives.
const CULL_PAD = 320;

// World-px side of one spatial-index cell. Puts the 21982x18101 surface in a
// 43x36 grid: coarse enough to stay a few hundred entries, small enough that
// a deep zoom only touches one or two cells.
const GRID_CELL = 512;

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
    this._ids = new Set();
    this.onSelect = null; // (label|null)
    this.onChange = null; // () => void
    this._drawn = [];      // [{label, x0,y0,x1,y1}] in CSS px, painter order
    this._dragLabel = null;
    this._dragOffset = { x: 0, y: 0 };
    this.wikiValid = new Map(); // label.id -> true|false, only set once resolved
    this.styleProfile = { sizeMul: 1, haloMul: 1 };
    this._grids = null;   // tier -> Map("cx,cy" -> [label])
    this._visPool = [];   // reusable per-frame scratch objects, see draw()
    this._rebuildIndex();
  }

  // ---- spatial index ------------------------------------------------------
  // One grid per tier rather than one shared grid, since zoomed out only a
  // couple of tiers are visible at all and this lets a frame skip the rest
  // without visiting their labels.
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

  _indexUpdate(l) {
    this._indexRemove(l);
    this._indexInsert(l);
  }

  // Per-style tweaks from config.js styles[].labelStyle, applied on top of
  // each tier's own size and halo.
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

  // Doesn't itself trigger a wiki check: while typing, this fires on every
  // keystroke, and checking on each one was the actual source of "too many
  // requests". The caller decides when a check is warranted (checkWiki()).
  update(label, patch) {
    const moved = ("x" in patch && patch.x !== label.x) || ("y" in patch && patch.y !== label.y);
    const retiered = "tier" in patch && patch.tier !== label.tier;
    Object.assign(label, patch);
    if (moved || retiered) this._indexUpdate(label);
    if (this.onChange) this.onChange();
    this.viewer.invalidate();
  }

  // Checks a label's wiki field (falling back to its name) against the live
  // wiki. Called when a label is opened for editing and again on blur, never
  // on every keystroke or for the whole set at once. wiki.js caches by title.
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
      this.wikiValid.delete(label.id); // network hiccup, unknown, don't flag
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
  // each edge of its window (multiplicative, so it behaves the same at 0.5x
  // or 5x). `fadeBand` overrides the default width.
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

  // Appends one tier's in-view labels into the visible pool. Cell-by-cell
  // walk is the fast path; zoomed right out the query rect can cover more
  // cells than the tier has labels, so it falls back to scanning the grid's
  // own entries when that's cheaper.
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
      e.alpha = isSel || isHov ? Math.max(alpha, 0.9) : alpha;
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
  // fewer or none. Stroked text dominates label cost: removing the halo took
  // a 243-label frame from ~40ms p95 to ~2.4ms.
  static HALO_FULL_MAX = 120;
  static HALO_THIN_MAX = 300;

  draw(ctx, api) {
    this._drawn.length = 0;
    const s = api.scale;
    const vw = api.viewport.w, vh = api.viewport.h;

    // Pass 1 (cheap): gather in-view labels tier by tier, lowest priority
    // first, without touching font/measureText. Descending rank doubles as
    // paint order (detail first, region last), so hitTest walking painter
    // order backwards resolves overlaps to whatever looks topmost, for free.
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
        continue;
      }
      n = this._gather(tierKey, alpha, q, api, vw, vh, n);
    }

    // A selected or hovered label stays legible even once its own tier has
    // faded out, so pick those up here; they land at the end of the pool and
    // paint on top.
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

    // Pass 2 (the expensive part): font/measure/draw, only for what pass 1 kept.
    let lastFont = null;
    for (let vi = 0; vi < n; vi++) {
      const { l, t, isSel, isHov, alpha, px, py } = pool[vi];
      const size = sizeForScale(t, s) * this.styleProfile.sizeMul;

      const font = `${t.weight} ${size}px ${FONT_STACK}`;
      if (font !== lastFont) { ctx.font = font; lastFont = font; }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const hasTracking = "letterSpacing" in ctx;
      if (hasTracking) ctx.letterSpacing = (t.tracking || 0) + "px";

      // Layout is cached on the label and only recomputed when the font or
      // text changes, since measureText per visible label per frame was
      // enough to trigger a GC pause every ~20 frames under stress testing.
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

      if (px < -maxW || py < -totalH || px > vw + maxW || py > vh + totalH) {
        if (hasTracking) ctx.letterSpacing = "0px";
        continue;
      }

      ctx.globalAlpha = alpha;
      const yTop = py - totalH / 2 + lineH / 2;

      // Halo: several concentric strokes standing in for a blur (too slow per
      // label per frame), then a crisp 1px offset shadow for the flat
      // old-school look.
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

  hitTest(sx, sy) {
    for (let i = this._drawn.length - 1; i >= 0; i--) {
      const d = this._drawn[i];
      if (sx >= d.x0 && sx <= d.x1 && sy >= d.y0 && sy <= d.y1) return d.label;
    }
    return null;
  }

  // Left click only selects/deselects; adding is a right-click gesture (see
  // main.js's tier quick menu), so a click on empty map never drops a label.
  handleClick(world, css) {
    const hit = this.hitTest(css.x, css.y);
    if (hit) { this.select(hit); return true; }
    this.select(null);
    return false;
  }

  // Only an already-selected label is grabbed, so panning near labels can't
  // move one by accident. Click to select, then drag.
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

  // One label per line rather than pretty-printed, so a finished map's
  // labels.json stays greppable and a moved label is a single changed line.
  // `wiki` is omitted when blank or when it just repeats `name`.
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
