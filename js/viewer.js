// viewer.js: a small, dependency-free canvas tile viewer.
//
// Coordinate systems
// ------------------
// * WORLD  : native source-image pixels, (0,0) top left, x right, y down.
//            The stable space labels are authored in, so a label keeps its
//            spot across zoom schemes and screen sizes.
// * DEVICE : physical canvas pixels (CSS px * devicePixelRatio). Render math
//            runs here and rounds to integers, for crisp seam-free tiles.
// * CSS    : layout pixels. Pointer events arrive in these.
//
// The viewer draws tiles, then hands an overlay pass to a callback so the
// label layer can paint on top in CSS pixel space.

export class Viewer {
  constructor(canvas, meta, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts;

    // World space, fixed at construction and never touched again, including
    // by switchTiles(). Labels, `home` and pan clamping all live here. Another
    // style's pyramid can be any native resolution: _tileRange()'s fx and fy
    // map world coordinates onto whatever the current style's tiles are, so no
    // style ever needs its source resized to match this one.
    this.worldWidth = meta.width;
    this.worldHeight = meta.height;

    // Pixel-perfect zoom ladder, in CSS px per world px:
    //   * power-of-two downscales (…, 1/4, 1/2) line up 1:1 with pyramid
    //     levels, so shrunk tiles stay crisp;
    //   * integer upscales (1, 2, … maxUpscale) blow each world pixel up into
    //     an exact NxN block.
    // Zoom eases between these rungs but always lands on one, so a resting
    // view is never on a fractional scale.
    this.minCssScale = opts.minCssScale || 0.25; // furthest zoom-out rung
    this.maxUpscale = opts.maxUpscale || 8;       // closest zoom-in rung (x)
    this._wheelAccum = 0;
    this._anim = null; // active zoom tween, or null
    this._reduceMotion =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Default / "home" view: centre (WORLD px) + CSS zoom.
    this._home = opts.home || { x: meta.width / 2, y: meta.height / 2, cssScale: 1 };

    this._applyMeta(meta, opts.baseUrl, opts.place);

    this.dpr = Math.max(1, window.devicePixelRatio || 1);

    // View state (WORLD center + DEVICE-px-per-WORLD-px scale).
    this.centerX = meta.width / 2;
    this.centerY = meta.height / 2;
    this.scale = 1; // set properly in fit()

    this.mouse = { x: 0, y: 0, world: { x: 0, y: 0 }, over: false };
    this._dragging = false;
    this._draggingLabel = false;
    this._moved = false;
    this._pointers = new Map(); // active pointerId -> {x, y} in CSS px, for pinch
    this._pinch = null;         // in-progress two-finger zoom, or null
    this._needsRender = true;
    this._alive = false;
    this._ac = new AbortController(); // to cleanly detach listeners on destroy

    // Callbacks (wired by main, before start()).
    this.onOverlay = opts.onOverlay || null; // (ctx, api) => void
    this.onClick = opts.onClick || null;      // (world, screen, ev) => void
    // (world, screen, ev) => void. The caller calls ev.preventDefault() itself
    // if it wants to suppress the native menu.
    this.onContextMenu = opts.onContextMenu || null;
    this.onHover = opts.onHover || null;      // (world) => void
    this.onView = opts.onView || null;        // (viewer) => void, after render
    // Lets a layer (e.g. author-mode labels) claim a pointer-down and drag an
    // item in world space instead of the viewer panning the map.
    this.onDragStart = opts.onDragStart || null; // (world) => boolean (true = claimed)
    this.onDragMove = opts.onDragMove || null;   // (world) => void
    this.onDragEnd = opts.onDragEnd || null;     // (world) => void

    this._bindEvents();
    this.resize();
    this.resetView();
    // The render loop is not started here. Call start() once the callbacks and
    // dependent layers exist, so the first frame can't reference something
    // that isn't wired up.
  }

  // Load a tile pyramid's metadata: tile size/zoom range, background colour,
  // zoom ladder, backdrop levels, and the per-level tile-existence index.
  // Shared by the constructor and switchTiles() so a style swap re-derives
  // everything a fresh Viewer would, without touching camera state.
  //
  // `place` maps this style's own native tile pixels onto shared world space.
  // `scale` is native px per world px (1 when the source is already at the
  // world's own resolution, 8/3 for one rendered at 8px per game tile onto a
  // 3px world) and (x, y) is the world coordinate of this style's pixel (0,0).
  // That lets a style's source be a smaller unpadded crop at its own native
  // resolution, positioned by a translation and uniform scale, rather than
  // resized to match another style, which would resample the art.
  _applyMeta(meta, baseUrl, place) {
    this.meta = meta;
    if (baseUrl !== undefined) this.opts.baseUrl = baseUrl;
    this.place = place || { scale: 1, x: 0, y: 0 };

    this.tileSize = meta.tileSize;
    this.minZoom = meta.minZoom;
    this.maxZoom = meta.maxZoom;
    this.bg = `rgb(${meta.background.join(",")})`;
    this.cssStops = this._buildStops();

    // Low-res levels kept resident as the always-available fallback backdrop
    // (prevents flashing when the target level is still streaming in).
    // tile_map.py picks these and records them in meta.backdrop.
    this.backdrop = new Set(meta.backdrop || []);

    // Existing levels, for snapping the chosen zoom past any skipped gap.
    this.levelSet = new Set(Object.keys(meta.levels).map(Number));

    // Build fast existence lookups from meta.index: present[z] = Set("x,y").
    this.present = {};
    for (const z of Object.keys(meta.index || {})) {
      const set = new Set();
      const cols = meta.index[z];
      for (const x of Object.keys(cols)) {
        for (const y of cols[x]) set.add(x + "," + y);
      }
      this.present[z] = set;
    }

    this.tiles = new Map(); // key "z/x/y" -> {img, status}
  }

  // Begin the render loop. Safe to call once; ignored if already running.
  start() {
    if (this._alive) return;
    this._alive = true;
    this._preloadBase();
    this._loop();
  }

  // Swap the tile pyramid (a different rendering "style" of the same map) in
  // place, keeping the current pan and zoom: unlike loading a new map,
  // switching style shouldn't jump the view. Assumes the new pyramid shares
  // the same world space, which is the point of pixel-aligning a style's
  // source against the original before tiling it.
  switchTiles(meta, baseUrl, place) {
    this._anim = null;
    this._applyMeta(meta, baseUrl, place);
    this.scale = this.snapScale(this.scale);
    this._clampCenter();
    this._needsRender = true;
    if (this._alive) this._preloadBase();
  }

  // Stop the loop and detach all listeners (used when switching maps).
  destroy() {
    this._alive = false;
    this._ac.abort();
  }

  // ---- zoom ladder & scale limits ------------------------------------------
  _buildStops() {
    const stops = [];
    // Power-of-two downscales below native (each == a pyramid level at 1:1),
    // but not further out than the configured floor.
    for (let z = this.minZoom; z < this.maxZoom; z++) {
      const s = Math.pow(2, z - this.maxZoom);
      if (s >= this.minCssScale - 1e-9) stops.push(s);
    }
    // Native and integer upscales.
    for (let n = 1; n <= this.maxUpscale; n++) stops.push(n);
    return stops; // ascending
  }

  minCssStop() { return this.cssStops[0]; }
  maxCssStop() { return this.cssStops[this.cssStops.length - 1]; }

  // Ladder rungs currently reachable (device px per world px), ascending.
  _allowedDeviceStops() {
    const min = this.minCssStop() - 1e-9;
    const max = this.maxCssStop() + 1e-9;
    return this.cssStops.filter((v) => v >= min && v <= max).map((v) => v * this.dpr);
  }
  clampScale(s) {
    const stops = this._allowedDeviceStops();
    return Math.min(stops[stops.length - 1], Math.max(stops[0], s));
  }
  // Snap a device scale to the nearest ladder rung (perceptual / log nearest).
  snapScale(s) {
    const stops = this._allowedDeviceStops();
    let best = stops[0], bd = Infinity;
    for (const v of stops) {
      const d = Math.abs(Math.log(v / s));
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  // ---- coordinate transforms (WORLD <-> DEVICE) -----------------------------
  worldToDevX(wx) { return (wx - this.centerX) * this.scale + this.canvas.width / 2; }
  worldToDevY(wy) { return (wy - this.centerY) * this.scale + this.canvas.height / 2; }
  devToWorldX(sx) { return (sx - this.canvas.width / 2) / this.scale + this.centerX; }
  devToWorldY(sy) { return (sy - this.canvas.height / 2) / this.scale + this.centerY; }

  // ---- lifecycle ------------------------------------------------------------
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.scale = this.snapScale(this.scale);
    this._clampCenter();
    this._needsRender = true;
  }

  // Jump (no tween) to the configured home view.
  resetView() {
    this._anim = null;
    this.scale = this._home.cssScale * this.dpr;
    this.centerX = this._home.x;
    this.centerY = this._home.y;
    this._clampCenter();
    this._needsRender = true;
  }

  // Jump to an arbitrary view, for example one restored from a shared URL.
  // Unlike the configured home that isn't guaranteed to be a valid zoom rung,
  // so snap and clamp rather than trusting it.
  jumpTo(x, y, cssScale) {
    this._anim = null;
    this.scale = this.clampScale(this.snapScale(cssScale * this.dpr));
    this.centerX = x;
    this.centerY = y;
    this._clampCenter();
    this._needsRender = true;
  }

  _clampCenter() {
    // Keep the map from being dragged completely off-screen. Allow the view
    // center to roam a bit past edges but not into the void entirely.
    // Bounds are in world units, not the current style's own pixel
    // dimensions. See worldWidth above.
    const halfW = this.canvas.width / 2 / this.scale;
    const halfH = this.canvas.height / 2 / this.scale;
    const margin = 0.25; // fraction of viewport allowed past the edge
    const minCX = -halfW * 2 * margin;
    const maxCX = this.worldWidth + halfW * 2 * margin;
    const minCY = -halfH * 2 * margin;
    const maxCY = this.worldHeight + halfH * 2 * margin;
    this.centerX = Math.min(maxCX, Math.max(minCX, this.centerX));
    this.centerY = Math.min(maxCY, Math.max(minCY, this.centerY));
  }

  // ---- zoom level selection -------------------------------------------------
  chooseZoom() {
    // Pick the pyramid level whose native resolution is >= current scale, so
    // we downscale (sharp) rather than upscale (blurry) when possible.
    const worldScale = this.scale / this.dpr; // CSS-ish px per world px
    let z = Math.ceil(this.maxZoom + Math.log2(worldScale));
    z = Math.min(this.maxZoom, Math.max(this.minZoom, z));
    if (this.levelSet.has(z)) return z;
    // Skipped gap: snap to the nearest existing level (prefer higher-res).
    for (let up = z + 1; up <= this.maxZoom; up++) if (this.levelSet.has(up)) return up;
    for (let dn = z - 1; dn >= this.minZoom; dn--) if (this.levelSet.has(dn)) return dn;
    return z;
  }

  // ---- tiles ----------------------------------------------------------------
  tileExists(z, x, y) {
    const set = this.present[z];
    if (!set) return true; // no index -> assume present
    return set.has(x + "," + y);
  }

  getTile(z, x, y) {
    const key = z + "/" + x + "/" + y;
    let t = this.tiles.get(key);
    if (t) return t;
    if (!this.tileExists(z, x, y)) {
      t = { img: null, status: "empty" };
      this.tiles.set(key, t);
      return t;
    }
    t = { img: new Image(), status: "loading" };
    t.img.onload = () => { t.status = "loaded"; this._needsRender = true; };
    t.img.onerror = () => { t.status = "empty"; };
    t.img.src = `${this.opts.baseUrl}/${z}/${x}/${y}.${this.meta.tileFormat}`;
    this.tiles.set(key, t);
    return t;
  }

  // Look up a cached tile without creating/requesting it.
  _peekTile(z, x, y) {
    return this.tiles.get(z + "/" + x + "/" + y) || null;
  }

  // Preload the low-zoom overview levels once and keep them resident (they're
  // small) so the fallback pass always has a full-map backdrop to draw.
  _preloadBase() {
    for (const z of this.backdrop) {
      const lvl = this.meta.levels[z];
      if (!lvl) continue;
      const set = this.present[z];
      if (set) {
        for (const key of set) {
          const [x, y] = key.split(",").map(Number);
          this.getTile(z, x, y);
        }
      } else {
        for (let x = 0; x < lvl.cols; x++)
          for (let y = 0; y < lvl.rows; y++) this.getTile(z, x, y);
      }
    }
  }

  // Visible tile index range for a level, optionally padded by `pad` tiles
  // (used to prefetch just off-screen).
  _tileRange(z, pad = 0) {
    const lvl = this.meta.levels[z];
    if (!lvl) return null;
    // lvl.{width,height} are this style's own native pixel dims at this
    // zoom. fx/fy convert a WORLD offset (from this style's placement
    // origin, this.place.{x,y}) into this level's pixel space: native px
    // per WORLD px is this.place.scale, and this level is a
    // lvl.width/meta.width fraction of that native resolution. For the
    // default style (place = {scale:1,x:0,y:0}, meta.width===worldWidth)
    // this reduces to exactly lvl.width/worldWidth, as before.
    const fx = this.place.scale * (lvl.width / this.meta.width);
    const fy = this.place.scale * (lvl.height / this.meta.height);
    const ts = this.tileSize;
    const W = this.canvas.width, H = this.canvas.height;
    const wl = this.devToWorldX(0) - this.place.x, wr = this.devToWorldX(W) - this.place.x;
    const wt = this.devToWorldY(0) - this.place.y, wb = this.devToWorldY(H) - this.place.y;
    const txMin = Math.max(0, Math.floor((wl * fx) / ts) - pad);
    const txMax = Math.min(lvl.cols - 1, Math.floor((wr * fx) / ts) + pad);
    const tyMin = Math.max(0, Math.floor((wt * fy) / ts) - pad);
    const tyMax = Math.min(lvl.rows - 1, Math.floor((wb * fy) / ts) + pad);
    return { lvl, fx, fy, ts, txMin, txMax, tyMin, tyMax };
  }

  // Request the target level's tiles (plus a 1-tile prefetch margin) and report
  // whether any in-view tile that should exist isn't loaded yet, meaning the
  // fallback layers are needed this frame. Skipped ocean tiles aren't gaps.
  _prepareTarget(z) {
    const pad = this._tileRange(z, 1);
    if (!pad) return false;
    const vxMin = pad.txMin + 1, vxMax = pad.txMax - 1;
    const vyMin = pad.tyMin + 1, vyMax = pad.tyMax - 1;
    let gaps = false;
    for (let tx = pad.txMin; tx <= pad.txMax; tx++) {
      for (let ty = pad.tyMin; ty <= pad.tyMax; ty++) {
        if (!this.tileExists(z, tx, ty)) continue;
        const t = this.getTile(z, tx, ty);
        if (t.status !== "loaded" &&
            tx >= vxMin && tx <= vxMax && ty >= vyMin && ty <= vyMax) {
          gaps = true;
        }
      }
    }
    return gaps;
  }

  // Draw a level's already-loaded visible tiles. Never requests: call
  // _prepareTarget or _preloadBase first for anything that must be present.
  _drawLevel(z, smoothing) {
    const r = this._tileRange(z, 0);
    if (!r || r.txMax < r.txMin || r.tyMax < r.tyMin) return;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = !!smoothing;
    const { lvl, fx, fy, ts } = r;
    for (let tx = r.txMin; tx <= r.txMax; tx++) {
      // World x of this tile's left & right edges (right edge = next tile
      // left), shifted back by this style's placement origin.
      const wLeft = this.place.x + (tx * ts) / fx;
      const wRight = this.place.x + Math.min((tx + 1) * ts, lvl.width) / fx;
      const sx0 = Math.round(this.worldToDevX(wLeft));
      const sx1 = Math.round(this.worldToDevX(wRight));
      for (let ty = r.tyMin; ty <= r.tyMax; ty++) {
        const t = this._peekTile(z, tx, ty);
        if (!t || t.status !== "loaded") continue;
        const wTop = this.place.y + (ty * ts) / fy;
        const wBot = this.place.y + Math.min((ty + 1) * ts, lvl.height) / fy;
        const sy0 = Math.round(this.worldToDevY(wTop));
        const sy1 = Math.round(this.worldToDevY(wBot));
        ctx.drawImage(t.img, sx0, sy0, sx1 - sx0, sy1 - sy0);
      }
    }
  }

  // ---- render loop ----------------------------------------------------------
  _loop() {
    if (!this._alive) return;
    if (this._anim) this._stepAnim();
    if (this._needsRender) {
      this._needsRender = false;
      this._render();
    }
    requestAnimationFrame(() => this._loop());
  }

  _stepAnim() {
    const a = this._anim;
    const t = Math.min(1, (performance.now() - a.start) / a.dur);
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic, quick then gentle
    // Interpolate scale geometrically (feels linear to the eye when zooming).
    this.scale = t >= 1 ? a.toScale : a.fromScale * Math.pow(a.toScale / a.fromScale, e);
    // Keep the anchored world point pinned under the cursor throughout.
    this.centerX = a.worldX - (a.devX - this.canvas.width / 2) / this.scale;
    this.centerY = a.worldY - (a.devY - this.canvas.height / 2) / this.scale;
    this._clampCenter();
    this._needsRender = true;
    if (t >= 1) this._anim = null;
  }

  invalidate() { this._needsRender = true; }

  _render() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // Background (ocean) fills everything; skipped tiles show through.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, W, H);

    const z = this.chooseZoom();
    // Request target tiles (+prefetch margin) and check whether any in-view
    // tile is still loading.
    const gaps = this._prepareTarget(z);
    // Anti-flash: only when there are gaps, paint already-loaded coarser levels
    // underneath (bottom-up, smoothed) so there's coverage while tiles stream
    // in. Skipped entirely once the target level is fully loaded, which is the
    // usual case while panning.
    if (gaps) {
      for (let zz = this.minZoom; zz < z; zz++) this._drawLevel(zz, true);
    }
    // Target level, drawn crisp (nearest-neighbour) on top.
    this._drawLevel(z, false);

    // Overlay pass in CSS-pixel space for easy marker/text drawing.
    if (this.onOverlay) {
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const self = this;
      const api = {
        scale: this.scale / this.dpr, // CSS px per world px
        dpr: this.dpr,
        zoom: z,
        toScreen(wx, wy) {
          return {
            x: self.worldToDevX(wx) / self.dpr,
            y: self.worldToDevY(wy) / self.dpr,
          };
        },
        toWorld(sx, sy) {
          return {
            x: self.devToWorldX(sx * self.dpr),
            y: self.devToWorldY(sy * self.dpr),
          };
        },
        viewport: { w: this.cssW, h: this.cssH },
      };
      this.onOverlay(ctx, api);
      ctx.restore();
    }

    // Prune far-away cached tiles to bound memory.
    if (this.tiles.size > 600) this._prune(z);

    if (this.onView) this.onView(this);
  }

  _prune(currentZ) {
    // Drop loaded tiles from levels we aren't near, but always keep the
    // resident base levels that back the anti-flash fallback.
    for (const key of this.tiles.keys()) {
      const z = parseInt(key.split("/")[0], 10);
      if (this.backdrop.has(z)) continue;
      if (Math.abs(z - currentZ) > 1) this.tiles.delete(key);
    }
  }

  // ---- interaction ----------------------------------------------------------
  _cssToDev(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * this.dpr,
      y: (clientY - rect.top) * this.dpr,
    };
  }

  // Ease to an exact device scale, keeping the world point under (devX,devY)
  // fixed on screen. Clamped to the ladder range. Set animate=false to jump.
  zoomToScale(newScale, devX, devY, animate = true) {
    newScale = this.clampScale(newScale);
    const wx = this.devToWorldX(devX);
    const wy = this.devToWorldY(devY);
    if (!animate || this._reduceMotion) {
      if (newScale === this.scale) return;
      this.scale = newScale;
      this.centerX = wx - (devX - this.canvas.width / 2) / this.scale;
      this.centerY = wy - (devY - this.canvas.height / 2) / this.scale;
      this._clampCenter();
      this._anim = null;
      this._needsRender = true;
      return;
    }
    if (!this._anim && newScale === this.scale) return;
    if (this._anim && this._anim.toScale === newScale) return; // already heading there
    this._anim = {
      fromScale: this.scale,
      toScale: newScale,
      worldX: wx, worldY: wy, devX, devY,
      start: performance.now(),
      dur: 160,
    };
    this._needsRender = true;
  }

  // Step `dir` rungs (+1 in, -1 out) along the pixel-perfect ladder, anchored
  // at (devX,devY), defaulting to the viewport centre for the +/- buttons.
  stepZoom(dir, devX, devY) {
    const stops = this._allowedDeviceStops();
    // Measure from the tween's destination if mid-zoom, else the current scale,
    // so consecutive notches each advance exactly one rung.
    const ref = this._anim ? this._anim.toScale : this.scale;
    let idx = 0, bd = Infinity;
    for (let i = 0; i < stops.length; i++) {
      const d = Math.abs(Math.log(stops[i] / ref));
      if (d < bd) { bd = d; idx = i; }
    }
    idx = Math.min(stops.length - 1, Math.max(0, idx + dir));
    if (devX == null) { devX = this.canvas.width / 2; devY = this.canvas.height / 2; }
    this.zoomToScale(stops[idx], devX, devY);
  }

  // ---- pinch zoom -----------------------------------------------------------
  // Two-finger zoom, the only way to zoom on a touch screen. There's no wheel,
  // and the page can't be pinched over the canvas because #map sets
  // touch-action: none, which hands us the gesture instead. Pointer events
  // already deliver touches, so this only has to track how many are down.
  //
  // Unlike every other zoom path a pinch runs at a free scale rather than
  // snapping each step, since a gesture that jumped between rungs under your
  // fingers would feel broken. _endPinch restores the invariant by tweening to
  // the nearest rung on release, so a resting view is still pixel-perfect.
  _pinchPoints() {
    const it = this._pointers.values();
    return [it.next().value, it.next().value];
  }

  _pinchMetrics() {
    const [a, b] = this._pinchPoints();
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), dev: this._cssToDev(cx, cy) };
  }

  _beginPinch() {
    const m = this._pinchMetrics();
    if (!m.dist) return;
    // A pinch supersedes whatever one finger was doing, panning or dragging a
    // label. Leaving either live would move the map or the label by the
    // midpoint's drift on top of the zoom.
    this._dragging = false;
    this._draggingLabel = false;
    this._moved = true; // so lifting off never registers as a click
    this._anim = null;
    this._pinch = {
      dist: m.dist,
      scale: this.scale,
      dev: m.dev,
      world: { x: this.devToWorldX(m.dev.x), y: this.devToWorldY(m.dev.y) },
    };
  }

  _movePinch() {
    const p = this._pinch;
    const m = this._pinchMetrics();
    if (!m.dist) return;
    this.scale = this.clampScale(p.scale * (m.dist / p.dist));
    // Keep the world point that started under the midpoint pinned there, so
    // the map zooms about the fingers and pans with them in one motion.
    this.centerX = p.world.x - (m.dev.x - this.canvas.width / 2) / this.scale;
    this.centerY = p.world.y - (m.dev.y - this.canvas.height / 2) / this.scale;
    p.dev = m.dev;
    this._clampCenter();
    this._needsRender = true;
  }

  _endPinch() {
    const p = this._pinch;
    this._pinch = null;
    this.zoomToScale(this.snapScale(this.scale), p.dev.x, p.dev.y);
  }

  _bindEvents() {
    const c = this.canvas;
    const sig = { signal: this._ac.signal };

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const { x, y } = this._cssToDev(e.clientX, e.clientY);
      // Accumulate scroll delta and step one ladder rung per notch. This makes
      // a mouse wheel move exactly one rung and keeps trackpads from flying.
      if ((this._wheelAccum > 0) !== (e.deltaY > 0)) this._wheelAccum = 0;
      this._wheelAccum += e.deltaY;
      const NOTCH = 100;
      while (Math.abs(this._wheelAccum) >= NOTCH) {
        const dir = this._wheelAccum < 0 ? +1 : -1; // scroll up = zoom in
        this._wheelAccum -= Math.sign(this._wheelAccum) * NOTCH;
        this.stepZoom(dir, x, y);
      }
    }, { passive: false, signal: this._ac.signal });

    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // only the primary button pans, right-click is handled below
      c.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 2) { this._beginPinch(); return; }
      if (this._pointers.size > 2) return; // extra fingers don't add a gesture
      const dev = this._cssToDev(e.clientX, e.clientY);
      const world = { x: this.devToWorldX(dev.x), y: this.devToWorldY(dev.y) };
      this._draggingLabel = !!(this.onDragStart && this.onDragStart(world));
      this._dragging = true;
      this._moved = false;
      this._last = { x: e.clientX, y: e.clientY };
    }, sig);

    c.addEventListener("pointermove", (e) => {
      if (this._pointers.has(e.pointerId)) {
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (this._pinch) {
        if (this._pointers.size >= 2) this._movePinch();
        return;
      }
      const dev = this._cssToDev(e.clientX, e.clientY);
      this.mouse.x = dev.x; this.mouse.y = dev.y; this.mouse.over = true;
      this.mouse.world = { x: this.devToWorldX(dev.x), y: this.devToWorldY(dev.y) };
      if (this.onHover) this.onHover(this.mouse.world);

      if (this._dragging && this._draggingLabel) {
        this._moved = true;
        if (this.onDragMove) this.onDragMove(this.mouse.world);
        this._last = { x: e.clientX, y: e.clientY };
        this._needsRender = true;
      } else if (this._dragging) {
        const dx = (e.clientX - this._last.x) * this.dpr;
        const dy = (e.clientY - this._last.y) * this.dpr;
        if (Math.abs(dx) + Math.abs(dy) > 3) this._moved = true;
        this.centerX -= dx / this.scale;
        this.centerY -= dy / this.scale;
        this._last = { x: e.clientX, y: e.clientY };
        this._clampCenter();
        this._needsRender = true;
      } else {
        this._needsRender = true; // refresh hover overlay
      }
    }, sig);

    const endDrag = (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pinch) {
        // Lifting one finger ends the gesture rather than silently handing the
        // remaining finger a pan. Its _last is a gesture old, so resuming
        // would jerk the map. A fresh touch starts panning normally.
        if (this._pointers.size < 2) this._endPinch();
        return;
      }
      if (!this._dragging) return;
      this._dragging = false;
      if (this._draggingLabel) {
        this._draggingLabel = false;
        if (this.onDragEnd) this.onDragEnd(this.mouse.world);
        return;
      }
      if (!this._moved && this.onClick) {
        const dev = this._cssToDev(e.clientX, e.clientY);
        const world = { x: this.devToWorldX(dev.x), y: this.devToWorldY(dev.y) };
        this.onClick(world, { x: e.clientX, y: e.clientY }, e);
      }
    };
    c.addEventListener("pointerup", endDrag, sig);
    c.addEventListener("pointercancel", (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pinch && this._pointers.size < 2) this._endPinch();
      this._dragging = false;
      this._draggingLabel = false;
    }, sig);
    c.addEventListener("pointerleave", () => { this.mouse.over = false; this._needsRender = true; }, sig);

    // Right-click. Doesn't preventDefault itself: the caller decides. main.js
    // only suppresses the native menu in author mode, so browsing keeps the
    // OS menu on the map.
    c.addEventListener("contextmenu", (e) => {
      if (!this.onContextMenu) return;
      const dev = this._cssToDev(e.clientX, e.clientY);
      const world = { x: this.devToWorldX(dev.x), y: this.devToWorldY(dev.y) };
      this.onContextMenu(world, { x: e.clientX, y: e.clientY }, e);
    }, sig);

    window.addEventListener("resize", () => this.resize(), sig);
  }
}
