// media.js: unlabelled screenshot points. Simple circle markers rather than
// text (no spatial index, since a map is expected to carry far fewer of
// these than named labels), but the base (not-revealing) look and fade-in
// borrow the "feature" label tier's rules directly (config.js): same
// minScale, same fade band, size scaling with zoom instead of a fixed
// radius, small and grey rather than standing out. Hover/selection brightens
// a marker on its own. The "reveal" flag (held while dragging the Orb of
// Oculus, see main.js) overrides all of that at once — every marker snaps to
// its full fixed size with a warm glow, regardless of zoom or fade.

const MIN_SCALE = 0.85; // matches LABEL_TIERS.feature in config.js
const FADE_BAND = 1.7;  // matches LabelLayer's default fadeBand
// [scale, radius] CSS px, ascending — interpolated and clamped at the ends,
// same shape as config.js's sizeSteps but for a dot instead of a font size.
const SIZE_STEPS = [[0.85, 4.5], [1, 4.5], [2, 5.5], [5, 6.5], [6, 7], [7, 7.5], [8, 8.25]];
const REVEAL_RADIUS = 5; // fixed CSS px while revealing, ignores zoom entirely

const FILL_DIM = "rgba(154, 162, 171, 0.14)";     // feature tier grey, faint middle
const BORDER_DIM = "rgba(201, 211, 221, 0.32)";   // slightly lighter than the fill
const FILL_HOVER = "rgba(186, 194, 203, 0.55)";
const BORDER_HOVER = "rgba(226, 232, 238, 0.9)";
const FILL_GLOW = "rgba(255, 214, 110, 0.9)";
const BORDER_GLOW = "rgba(255, 240, 200, 1)";
const HALO_GLOW = "rgba(255, 200, 90, 0.32)";

function radiusForScale(scale) {
  if (scale <= SIZE_STEPS[0][0]) return SIZE_STEPS[0][1];
  for (let i = 1; i < SIZE_STEPS.length; i++) {
    const [s0, r0] = SIZE_STEPS[i - 1];
    const [s1, r1] = SIZE_STEPS[i];
    if (scale <= s1) return r0 + (r1 - r0) * ((scale - s0) / (s1 - s0));
  }
  return SIZE_STEPS[SIZE_STEPS.length - 1][1];
}

// Same soft-edge fade as LabelLayer.tierAlpha, but one-sided: media never
// fades back out at high zoom the way a "region" label would.
function alphaForScale(scale) {
  if (scale >= MIN_SCALE * FADE_BAND) return 1;
  return Math.max(0, Math.min(1, (scale / MIN_SCALE - 1) / (FADE_BAND - 1)));
}

export class MediaLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.items = [];
    this.selected = null;
    this.hovered = null;
    this.revealing = false;
    this.authorMode = false; // kept in sync with LabelLayer.authorMode by main.js
    this.nextId = 1;
    this._ids = new Set();
    this.onChange = null; // () => void
    this._drawn = []; // [{item, x0,y0,x1,y1}] in CSS px
    this._dragItem = null;
    this._dragOffset = { x: 0, y: 0 };
  }

  load(list) {
    this.items = (list || []).map((m, i) => ({
      file: "",
      ...m,
      id: m.id || "media-" + (i + 1),
    }));
    this._ids = new Set(this.items.map((m) => m.id));
    this.nextId = 1;
    this.viewer.invalidate();
  }

  _freshId() {
    while (this._ids.has("media-" + this.nextId)) this.nextId++;
    return "media-" + this.nextId;
  }

  add(world) {
    const item = { id: this._freshId(), file: "", x: Math.round(world.x), y: Math.round(world.y) };
    this.items.push(item);
    this._ids.add(item.id);
    if (this.onChange) this.onChange();
    this.viewer.invalidate();
    return item;
  }

  update(item, patch) {
    Object.assign(item, patch);
    if (this.onChange) this.onChange();
    this.viewer.invalidate();
  }

  remove(item) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    this._ids.delete(item.id);
    if (this.hovered === item) this.hovered = null;
    if (this.selected === item) this.selected = null;
    if (this.onChange) this.onChange();
    this.viewer.invalidate();
  }

  select(item) {
    this.selected = item;
    this.viewer.invalidate();
  }

  setRevealing(on) {
    if (this.revealing === on) return;
    this.revealing = on;
    this.viewer.invalidate();
  }

  draw(ctx, api) {
    this._drawn.length = 0;
    if (!this.items.length) return;
    const vw = api.viewport.w, vh = api.viewport.h;
    const revealing = this.revealing;
    // Computed once per frame, not per marker: same fade-in point for all of
    // them, so they blink into view together as you cross the threshold.
    const baseAlpha = revealing ? 1 : alphaForScale(api.scale);

    for (const m of this.items) {
      const isSel = m === this.selected;
      const isHov = m === this.hovered;
      const emphasized = isSel || isHov;
      // A selected/hovered marker stays interactable even below the fade-in
      // threshold, same as LabelLayer keeps a selected label visible past
      // its tier's own fade — otherwise zooming out would strand an open
      // popup with no way to re-target its marker.
      const alpha = revealing ? 1 : Math.max(baseAlpha, emphasized ? 0.9 : 0);
      if (alpha <= 0.02) continue;

      const p = api.toScreen(m.x, m.y);
      if (p.x < -20 || p.y < -20 || p.x > vw + 20 || p.y > vh + 20) continue;

      const base = revealing ? REVEAL_RADIUS : radiusForScale(api.scale);
      const r = emphasized ? base * 1.25 : base;

      if (revealing) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = HALO_GLOW;
        ctx.fill();
      }

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = revealing ? FILL_GLOW : emphasized ? FILL_HOVER : FILL_DIM;
      ctx.fill();
      ctx.lineWidth = revealing || emphasized ? 1.5 : 1;
      ctx.strokeStyle = revealing ? BORDER_GLOW : emphasized ? BORDER_HOVER : BORDER_DIM;
      ctx.stroke();
      ctx.globalAlpha = 1;

      this._drawn.push({ item: m, x0: p.x - r - 3, y0: p.y - r - 3, x1: p.x + r + 3, y1: p.y + r + 3 });
    }
  }

  hitTest(sx, sy) {
    for (let i = this._drawn.length - 1; i >= 0; i--) {
      const d = this._drawn[i];
      if (sx >= d.x0 && sx <= d.x1 && sy >= d.y0 && sy <= d.y1) return d.item;
    }
    return null;
  }

  // Like hitTest, but forgiving: falls back to whichever marker's centre is
  // nearest within maxDist CSS px. Landing a drop exactly on a small dot is
  // fiddly (mouse precision, fat fingers on touch), so the orb-drop gesture
  // in main.js uses this instead of the exact-bounds hitTest a plain click
  // uses.
  hitTestNear(sx, sy, maxDist = 28) {
    const exact = this.hitTest(sx, sy);
    if (exact) return exact;
    let best = null, bestDist = maxDist;
    for (const d of this._drawn) {
      const cx = (d.x0 + d.x1) / 2, cy = (d.y0 + d.y1) / 2;
      const dist = Math.hypot(sx - cx, sy - cy);
      if (dist <= bestDist) { bestDist = dist; best = d.item; }
    }
    return best;
  }

  handleHover(sx, sy) {
    const hit = this.hitTest(sx, sy);
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.viewer.invalidate();
    }
    return hit;
  }

  // Same "already selected only" gesture as LabelLayer.beginDrag: opening a
  // marker's edit popup selects it, and only then does a drag on the canvas
  // grab it, so panning near a marker can't move it by accident.
  beginDrag(world, css) {
    if (!this.authorMode) return false;
    const hit = this.hitTest(css.x, css.y);
    if (!hit || hit !== this.selected) return false;
    this._dragItem = hit;
    this._dragOffset = { x: hit.x - world.x, y: hit.y - world.y };
    return true;
  }

  dragTo(world) {
    if (!this._dragItem) return;
    this.update(this._dragItem, {
      x: Math.round(world.x + this._dragOffset.x),
      y: Math.round(world.y + this._dragOffset.y),
    });
  }

  endDrag() {
    this._dragItem = null;
  }

  // `pinnedAt` (set by main.js when a filename resolves in the editor) is
  // omitted when absent, so an unfinished/never-edited point stays plain.
  exportJson(mapId) {
    const lines = this.items.map((m) => {
      const out = { id: m.id, file: m.file || "", x: m.x, y: m.y };
      if (m.pinnedAt) out.pinnedAt = m.pinnedAt;
      return "    " + JSON.stringify(out);
    });
    return `{\n  "map": ${JSON.stringify(mapId)},\n  "media": [\n${lines.join(",\n")}\n  ]\n}\n`;
  }
}
