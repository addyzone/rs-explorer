// main.js: wires the viewer, label layer and UI together.

import { MAPS, MAP_FILES, LABEL_TIERS, TIER_ORDER } from "./config.js";
import { Viewer } from "./viewer.js";
import { LabelLayer } from "./labels.js";
import { titleFromWiki, wikiUrl, fetchSummary, fetchRelated, fetchSections, fetchExamine, searchTitles } from "./wiki.js";
import { ICON_ADD, ICON_REMOVE, ICON_RESET_VIEW, ICON_INFO, ICON_EXTERNAL } from "./icons.js";
import { downloadFile } from "./save.js";

const $ = (sel) => document.querySelector(sel);

const el = {
  canvas: $("#map"),
  mapSelect: $("#mapSelect"),
  stylePicker: $("#stylePicker"),
  tileAttribution: $("#tileAttribution"),
  exportBtn: $("#exportBtn"),
  infoBtn: $("#infoBtn"),
  infoPanel: $("#infoPanel"),
  zoomIn: $("#zoomIn"),
  zoomOut: $("#zoomOut"),
  reset: $("#resetView"),
  coords: $("#coords"),
  zoomReadout: $("#zoomReadout"),
  panel: $("#panel"),
  panelBody: $("#panelBody"),
  panelResizeHandle: $("#panelResizeHandle"),
  tierQuickMenu: $("#tierQuickMenu"),
  status: $("#status"),
};

let viewer = null;
let labels = null;
let currentMap = null;
let wikiToken = 0; // guards against stale async wiki renders

// ---- URL state ------------------------------------------------------------
// The fragment mirrors map, style, view and selected label, so refreshing or
// sharing a URL lands back in the same place. Written with replaceState so it
// never adds history entries.
function parseUrlState() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const out = {};
  if (params.has("map")) out.map = params.get("map");
  if (params.has("style")) out.style = params.get("style");
  const x = parseFloat(params.get("x"));
  const y = parseFloat(params.get("y"));
  const z = parseFloat(params.get("z"));
  if (isFinite(x) && isFinite(y) && isFinite(z) && z > 0) out.view = { x, y, cssScale: z };
  if (params.has("label")) out.label = params.get("label");
  return out;
}

// Debounced because viewer.onView fires every rendered frame while panning.
// One-off changes (selecting a label, switching style) call flushUrlUpdate()
// instead so the address bar doesn't lag behind a click.
let urlUpdateTimer = null;
function scheduleUrlUpdate() {
  clearTimeout(urlUpdateTimer);
  urlUpdateTimer = setTimeout(writeUrlStateNow, 80);
}
function flushUrlUpdate() {
  clearTimeout(urlUpdateTimer);
  writeUrlStateNow();
}
function writeUrlStateNow() {
  if (!currentMap || !viewer) return;
  const params = new URLSearchParams();
  params.set("map", currentMap.id);
  params.set("style", currentStyleId);
  params.set("x", Math.round(viewer.centerX));
  params.set("y", Math.round(viewer.centerY));
  params.set("z", +(viewer.scale / viewer.dpr).toFixed(4));
  if (labels && labels.selected) params.set("label", labels.selected.id);
  const hash = "#" + params.toString();
  if (hash !== location.hash) history.replaceState(null, "", hash);
}

// ---- map styles -----------------------------------------------------------
// Every style lives at `${mapCfg.dir}/styles/${id}`, including the one a map
// opens with (just styles[0]), so none is special-cased here. See config.js.
let currentStyleId = null;
let styleMetaCache = {}; // styleId -> meta.json, reset each loadMap()

function styleDirFor(mapCfg, styleId) {
  return `${mapCfg.dir}/styles/${styleId}`;
}

function styleById(mapCfg, styleId) {
  return mapCfg.styles.find((s) => s.id === styleId) || null;
}

function setAttribution(html) {
  if (!el.tileAttribution) return;
  el.tileAttribution.innerHTML = html || "";
  el.tileAttribution.hidden = !html;
}

// The reskin a style's `chrome` class applies. Tracked so switching away
// removes only what the outgoing style added.
let currentChromeClass = null;
function applyChrome(styleDef) {
  if (currentChromeClass) document.body.classList.remove(currentChromeClass);
  currentChromeClass = (styleDef && styleDef.chrome) || null;
  if (currentChromeClass) document.body.classList.add(currentChromeClass);
}

// Shows a card for every style except the active one, i.e. what you'd switch
// to, each with its own thumbnail.
function renderStylePicker() {
  if (!el.stylePicker) return;
  const opts = currentMap.styles;
  if (opts.length < 2) {
    el.stylePicker.hidden = true;
    el.stylePicker.innerHTML = "";
    return;
  }
  el.stylePicker.hidden = false;
  el.stylePicker.innerHTML = opts
    .filter((s) => s.id !== currentStyleId)
    .map(
      (s) => `
      <button class="style-card" type="button" data-style="${s.id}" title="Switch to ${escapeAttr(s.label)}">
        ${s.thumb ? `<img src="${escapeAttr(s.thumb)}" alt="">` : ""}
        <div class="style-card-label">${escapeHtml(s.label)}</div>
      </button>`
    )
    .join("");
  el.stylePicker.querySelectorAll(".style-card").forEach((card) => {
    card.addEventListener("click", () => switchStyle(card.dataset.style));
  });
}

async function switchStyle(styleId) {
  const mapCfg = currentMap;
  const styleDef = styleById(mapCfg, styleId);
  if (!styleDef) return;

  if (!styleMetaCache[styleId]) {
    try {
      styleMetaCache[styleId] = await loadJson(`${styleDirFor(mapCfg, styleId)}/${MAP_FILES.meta}`);
    } catch (e) {
      el.status.textContent = `"${styleDef.label}" style isn't tiled yet. See tools/README.md.`;
      return;
    }
  }
  currentStyleId = styleId;
  applyStyle(styleDef);
  viewer.switchTiles(styleMetaCache[styleId], styleDirFor(mapCfg, styleId), styleDef.place);
  renderStylePicker();
  el.status.textContent = `${mapCfg.label}, ${styleDef.label} style`;
  flushUrlUpdate();
}

// Everything a style changes besides its tiles: credit, chrome class, label
// size and halo. Shared by switchStyle() and loadMap() so the style a map
// opens with takes the same path as one you pick.
function applyStyle(styleDef) {
  setAttribution(styleDef.attribution);
  applyChrome(styleDef);
  if (labels) labels.setStyleProfile(styleDef.labelStyle);
}

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// ---- small html helpers ----------------------------------------------------
function escapeHtml(s) {
  return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
function tierOptions(selected) {
  return TIER_ORDER.map(
    (k) => `<option value="${k}" ${k === selected ? "selected" : ""}>${LABEL_TIERS[k].label}</option>`
  ).join("");
}

// ---- side panel ------------------------------------------------------------
function renderPanel(label) {
  wikiToken++; // any pending wiki fetch is now stale
  if (!label) {
    el.panel.classList.add("empty");
    el.panelBody.innerHTML = labels && labels.authorMode
      ? `<div class="panel-hint">Editor mode. Right-click the map to drop a label, or click one to edit it. <span class="fld-hint">(Shift+E to exit)</span></div>`
      : `<div class="panel-hint">Click a label to read about it. Zoom in to reveal more.</div>`;
    return;
  }
  el.panel.classList.remove("empty");

  if (labels.authorMode) {
    el.panel.classList.add("author-mode-panel");
    el.panelBody.innerHTML = `
      <button class="wiki-close" title="Close">×</button>
      <label class="fld">Label text <span class="fld-hint">(Enter for a new line)</span>
        <textarea id="f-name" rows="2">${escapeHtml(label.name)}</textarea>
      </label>
      <label class="fld">Tier
        <select id="f-tier">${tierOptions(label.tier)}</select>
      </label>
      <label class="fld">Wiki page or URL
        <input id="f-wiki" type="text" placeholder="e.g. Lumbridge" value="${escapeAttr(label.wiki || "")}" list="wikiSuggest" autocomplete="off">
        <datalist id="wikiSuggest"></datalist>
      </label>
      <div class="fld coord-line" id="coordLine">📍 ${label.x}, ${label.y}</div>
      <div class="row">
        <button id="f-preview" class="btn">Preview wiki</button>
        <button id="f-delete" class="btn danger">Delete</button>
      </div>
      <div id="wikiBox" class="wiki-box"></div>`;
    $("#f-name").addEventListener("input", (e) => labels.update(label, { name: e.target.value }));
    $("#f-name").addEventListener("blur", () => labels.checkWiki(label));
    $("#f-tier").addEventListener("change", (e) => labels.update(label, { tier: e.target.value }));
    $("#f-wiki").addEventListener("input", (e) => {
      labels.update(label, { wiki: e.target.value });
      scheduleWikiSuggest(e.target.value);
    });
    $("#f-wiki").addEventListener("blur", () => labels.checkWiki(label));
    $("#f-delete").addEventListener("click", () => labels.remove(label));
    $("#f-preview").addEventListener("click", () => renderWiki($("#wikiBox"), label));
    $(".wiki-close").addEventListener("click", () => labels.select(null));
    // One check when the panel opens, not one per keystroke. wiki.js caches
    // by title, so re-opening the same unedited label costs nothing further.
    labels.checkWiki(label);
  } else {
    el.panel.classList.remove("author-mode-panel");
    el.panelBody.innerHTML = `<button class="wiki-close" title="Close">×</button><div id="wikiBox" class="wiki-box"></div>`;
    $(".wiki-close").addEventListener("click", () => labels.select(null));
    renderWiki($("#wikiBox"), label);
  }
}

// Fills the <datalist> with live title matches, so a typo'd link is caught
// while typing rather than failing silently until "Preview wiki".
let wikiSuggestTimer = null;
function scheduleWikiSuggest(value) {
  clearTimeout(wikiSuggestTimer);
  wikiSuggestTimer = setTimeout(async () => {
    const title = titleFromWiki(value);
    const matches = await searchTitles(title);
    const list = $("#wikiSuggest");
    if (!list) return; // panel moved on before this resolved
    list.innerHTML = matches.map((m) => `<option value="${escapeAttr(m)}">`).join("");
  }, 250);
}

// ---- wiki sidebar content --------------------------------------------------
// Shows the wiki article's own title once resolved, not the label's map text,
// so a label nicknamed "the King's back garden" still heads its panel with the
// real page name. Author mode skips it: the label text is an editable field
// directly above, so repeating it would be noise.
function wikiHeading(title) {
  if (labels.authorMode) return "";
  return `<div class="wiki-title-wrap"><h2 class="wiki-title">${escapeHtml(title)}</h2></div>`;
}

// True when all four corners of the image are near-transparent, which marks
// an NPC or item cutout render rather than an opaque scene screenshot. Only
// cutouts get the extra padding; scenes sit flush.
// Needs the image loaded with crossorigin="anonymous" so the canvas isn't
// tainted. Returns false on any failure rather than throwing: this is
// cosmetic, and the panel shouldn't break over it.
function isCutoutRender(img) {
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return false;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    // Fixed size, not a fraction of the image. A tight infobox crop can put
    // real content a few px in from a corner, so scaling the sample up for
    // bigger images started sampling that content. 6px stayed inside the
    // transparent margin on every image tested.
    const s = 6;
    const corners = [
      [0, 0], [w - s, 0], [0, h - s], [w - s, h - s],
    ];
    return corners.every(([cx, cy]) => {
      const data = ctx.getImageData(cx, cy, s, s).data;
      let alphaSum = 0;
      for (let i = 3; i < data.length; i += 4) alphaSum += data[i];
      return alphaSum / (data.length / 4) < 40; // out of 255, so near-zero
    });
  } catch (e) {
    return false; // tainted canvas or other failure
  }
}

async function renderWiki(box, label) {
  if (!box) return;
  const fallback = String(label.name).replace(/\n/g, " ");
  // A blank wiki field falls back to the label's own name. Location and NPC
  // labels are usually named exactly after their page, so it's worth trying
  // before telling the reader nothing is linked.
  const raw = (label.wiki && label.wiki.trim()) || fallback;
  if (!raw) {
    box.innerHTML =
      wikiHeading(fallback) +
      `<div class="wiki-empty">No wiki page linked${labels.authorMode ? ". Add one above." : "."}</div>`;
    return;
  }
  const title = titleFromWiki(raw);
  const token = ++wikiToken;
  box.innerHTML = wikiHeading(fallback) + `<div class="wiki-loading">Loading…</div>`;
  try {
    const s = await fetchSummary(title);
    if (token !== wikiToken) return; // selection changed
    if (!s) {
      box.innerHTML =
        wikiHeading(fallback) +
        `<div class="wiki-empty">No article found for “${escapeHtml(title)}”. ` +
        `<a href="${wikiUrl(title)}" target="_blank" rel="noopener">Search the wiki ${ICON_EXTERNAL}</a></div>`;
      return;
    }
    const extract = s.extract.length > 700 ? s.extract.slice(0, 700) + "…" : s.extract;
    box.innerHTML =
      wikiHeading(s.title) +
      `<div id="wikiExamine"></div>` +
      (s.thumb
        ? `<div class="wiki-thumb-wrap" id="wikiThumbWrap"><img class="wiki-thumb" src="${escapeAttr(s.thumb)}" alt="" loading="lazy" crossorigin="anonymous"></div>`
        : "") +
      `<p class="wiki-extract">${escapeHtml(extract)}</p>` +
      `<a class="wiki-link" href="${escapeAttr(s.url)}" target="_blank" rel="noopener">Open on RuneScape Wiki ${ICON_EXTERNAL}</a>` +
      `<div id="wikiSections"></div>` +
      (s.categories && s.categories.length
        ? `<div class="wiki-cats">
             <div class="wiki-subhead">Categories</div>
             <div class="wiki-chips">${s.categories
               .map((c) => `<a class="wiki-chip" href="${escapeAttr(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a>`)
               .join("")}</div>
           </div>`
        : "") +
      `<div id="wikiRelated"></div>` +
      `<p class="wiki-license">Content from the <a href="https://runescape.wiki" target="_blank" rel="noopener">RuneScape Wiki</a>, ` +
      `available under <a href="https://creativecommons.org/licenses/by-nc-sa/3.0/" target="_blank" rel="noopener">CC BY-NC-SA 3.0</a>.</p>`;

    // A render is either a full scene, which should sit flush, or a cutout on
    // a transparent background, which looks cramped bleeding into the rounded
    // corners. The page doesn't say which, so it's read from the pixels once
    // the image loads.
    const thumbWrap = box.querySelector("#wikiThumbWrap");
    const thumbImg = thumbWrap && thumbWrap.querySelector("img");
    if (thumbImg) {
      const applyCutoutPadding = () => {
        if (token !== wikiToken) return; // selection moved on
        if (isCutoutRender(thumbImg)) thumbWrap.classList.add("cutout");
      };
      if (thumbImg.complete) applyCutoutPadding();
      else thumbImg.addEventListener("load", applyCutoutPadding, { once: true });
    }

    // The infobox examine line: in-game right-click flavour text, often the
    // best sentence on the page. It isn't in the extract (that's article
    // prose, not infobox data) so fetchExamine() reads the raw wikitext.
    // These three extras are garnish on a panel that already shows its
    // article, so a failed request just leaves its slot empty. Hence the
    // no-op rejection handlers: without them a dropped connection logs an
    // unhandled rejection for something nobody would have missed.
    fetchExamine(s.title).then((examine) => {
      if (token !== wikiToken || !examine) return;
      const el2 = box.querySelector("#wikiExamine");
      if (!el2) return;
      el2.outerHTML = `<p class="wiki-examine">“${escapeHtml(examine)}”</p>`;
    }, () => {});

    // Sections and related pages each need their own API call, so they fire in
    // parallel and fill their own slot as they resolve. Neither blocks the
    // extract already on screen.
    fetchSections(s.title).then((sections) => {
      if (token !== wikiToken || !sections.length) return;
      const el2 = box.querySelector("#wikiSections");
      if (!el2) return;
      el2.outerHTML = `
        <div class="wiki-sections">
          <div class="wiki-subhead">Jump to</div>
          <ul class="wiki-section-list">
            ${sections
              .map((sec) => `<li><a href="${escapeAttr(s.url)}#${escapeAttr(sec.anchor)}" target="_blank" rel="noopener">${escapeHtml(sec.title)}</a></li>`)
              .join("")}
          </ul>
        </div>`;
    }, () => {});
    fetchRelated(s.title).then((related) => {
      if (token !== wikiToken || !related.length) return;
      const el2 = box.querySelector("#wikiRelated");
      if (!el2) return;
      el2.outerHTML = `
        <div class="wiki-related">
          <div class="wiki-subhead">Related pages</div>
          <ul class="wiki-related-list">
            ${related.map((r) => `<li><a href="${escapeAttr(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></li>`).join("")}
          </ul>
        </div>`;
    }, () => {});
  } catch (e) {
    if (token !== wikiToken) return;
    box.innerHTML =
      wikiHeading(fallback) +
      `<div class="wiki-empty">Couldn't reach the wiki. ` +
      `<a href="${wikiUrl(title)}" target="_blank" rel="noopener">Open on wiki ${ICON_EXTERNAL}</a></div>`;
  }
}

// ---- overlay api mirror (for hit-testing outside the render pass) ----------
function overlayApi() {
  const v = viewer;
  return {
    scale: v.scale / v.dpr,
    dpr: v.dpr,
    zoom: v.chooseZoom(),
    viewport: { w: v.cssW, h: v.cssH },
    toScreen: (wx, wy) => ({ x: v.worldToDevX(wx) / v.dpr, y: v.worldToDevY(wy) / v.dpr }),
    toWorld: (sx, sy) => ({ x: v.devToWorldX(sx * v.dpr), y: v.devToWorldY(sy * v.dpr) }),
  };
}

function drawCrosshair(ctx, api) {
  const s = api.toScreen(viewer.mouse.world.x, viewer.mouse.world.y);
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(s.x - 9, s.y); ctx.lineTo(s.x + 9, s.y);
  ctx.moveTo(s.x, s.y - 9); ctx.lineTo(s.x, s.y + 9);
  ctx.stroke();
}

// ---- map loading -----------------------------------------------------------
// `restore` re-applies state read from the URL fragment on first load:
// { view, style, label }, see parseUrlState(). Ordinary map switches omit it.
async function loadMap(mapCfg, restore = {}) {
  closeTierQuickMenu(); // a pending add would otherwise reference the outgoing map's world coords
  el.status.textContent = "Loading " + mapCfg.label + "…";
  currentMap = mapCfg;

  // Resolve the style to open with BEFORE fetching any tiles, so a shared
  // "#style=wiki3d" link loads that pyramid directly instead of loading
  // styles[0]'s first and immediately throwing it away.
  const style = (restore.style && styleById(mapCfg, restore.style)) || mapCfg.styles[0];
  currentStyleId = style.id;
  const styleDir = styleDirFor(mapCfg, style.id);
  const meta = await loadJson(`${styleDir}/${MAP_FILES.meta}`);
  styleMetaCache = { [style.id]: meta };

  if (viewer) viewer.destroy();
  labels = null; // the outgoing map's layer must not outlive its viewer
  viewer = new Viewer(el.canvas, meta, {
    baseUrl: styleDir,
    home: mapCfg.home,
    place: style.place,
  });
  if (restore.view) viewer.jumpTo(restore.view.x, restore.view.y, restore.view.cssScale);
  renderStylePicker();

  labels = new LabelLayer(viewer);
  applyStyle(style);
  labels.onSelect = (label) => { renderPanel(label); flushUrlUpdate(); };
  labels.onChange = () => {
    markDirty();
    const coordEl = document.getElementById("coordLine");
    if (coordEl && labels.selected) {
      coordEl.textContent = `📍 ${labels.selected.x}, ${labels.selected.y}`;
    }
  };

  viewer.onOverlay = (ctx, api) => {
    if (!labels) return;
    labels.draw(ctx, api);
    if (labels.authorMode && viewer.mouse.over) drawCrosshair(ctx, api);
  };
  viewer.onClick = (world) => {
    const css = overlayApi().toScreen(world.x, world.y);
    labels.handleClick(world, css);
    el.canvas.style.cursor = labels.authorMode ? "crosshair" : "grab";
  };
  viewer.onContextMenu = (world, screen, ev) => {
    if (!labels.authorMode) return; // let the browser's own menu show as normal outside editor mode
    ev.preventDefault();
    const css = overlayApi().toScreen(world.x, world.y);
    const hit = labels.hitTest(css.x, css.y);
    if (hit) { labels.select(hit); return; } // right-clicking an existing label just selects it
    openTierQuickMenu(world, screen);
  };
  viewer.onHover = (world) => {
    el.coords.textContent = `${Math.round(world.x)}, ${Math.round(world.y)}`;
    const css = overlayApi().toScreen(world.x, world.y);
    const hit = labels.handleHover(css.x, css.y);
    el.canvas.style.cursor = hit
      ? (labels.authorMode ? "move" : "pointer")
      : labels.authorMode ? "crosshair" : "grab";
  };
  viewer.onDragStart = (world) => {
    const css = overlayApi().toScreen(world.x, world.y);
    return labels.beginDrag(world, css);
  };
  viewer.onDragMove = (world) => labels.dragTo(world);
  viewer.onDragEnd = () => labels.endDrag();
  viewer.onView = (v) => {
    const nativePct = Math.round((v.scale / v.dpr) * 100);
    const tileLevel = labels.authorMode ? `  (z${v.chooseZoom()})` : "";
    el.zoomReadout.textContent = `${nativePct}%${tileLevel}`;
    scheduleUrlUpdate();
  };

  try {
    const data = await loadJson(`${mapCfg.dir}/${MAP_FILES.labels}`);
    labels.load(data.labels || []);
  } catch (e) {
    labels.load([]);
  }

  const restoredLabel = restore.label && labels.labels.find((l) => l.id === restore.label);
  if (restoredLabel) {
    labels.select(restoredLabel); // fires onSelect -> renderPanel + flushUrlUpdate
  } else {
    renderPanel(null);
  }

  dirty = false; // a freshly loaded map has nothing unsaved yet
  updateSaveButton();
  el.status.textContent = `${mapCfg.label}, ${labels.labels.length} labels`;
  viewer.start();
  flushUrlUpdate(); // normalizes the fragment even if nothing above changed it
}

// ---- editor mode + export ---------------------------------------------------
function setAuthorMode(on) {
  labels.authorMode = on;
  document.body.classList.toggle("editor-mode", on);
  el.exportBtn.hidden = !on;
  el.canvas.style.cursor = on ? "crosshair" : "grab";
  updateSaveButton();
  // No bulk wiki check on entry: with a few hundred labels that fired a few
  // hundred concurrent API requests at once. Each label is checked instead
  // when its own panel opens, see renderPanel().
  if (!on) closeTierQuickMenu();
  renderPanel(labels.selected);
  viewer.invalidate(); // refreshes the zoom readout + crosshair immediately
}

// ---- editor mode: right-click "quick add" menu ------------------------------
// Right-clicking empty map in author mode drops a floating tier picker right
// at the cursor rather than routing through the side panel. Pick a tier and
// the label exists immediately, selected, with its name field focused.
let pendingAddWorld = null;

function tierQuickMenuHtml() {
  return TIER_ORDER.map(
    (k) => `
    <button type="button" class="tier-quick-item" data-tier="${k}">
      <span class="tier-quick-swatch" style="background:${LABEL_TIERS[k].color}"></span>${LABEL_TIERS[k].label}
    </button>`
  ).join("");
}

function openTierQuickMenu(world, screen) {
  pendingAddWorld = world;
  const menu = el.tierQuickMenu;
  menu.innerHTML = tierQuickMenuHtml();
  menu.hidden = false;
  menu.querySelectorAll(".tier-quick-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const label = labels.add(pendingAddWorld, btn.dataset.tier); // selects it -> renderPanel
      closeTierQuickMenu();
      const nameField = document.getElementById("f-name");
      if (nameField) { nameField.focus(); nameField.select(); }
    });
  });
  // Positioned after the content/hidden state is set, so offsetWidth/Height
  // reflect the menu's real size, then clamped so a right-click near an edge
  // doesn't spawn a menu that spills off screen.
  const pad = 8;
  const x = Math.min(screen.x, window.innerWidth - menu.offsetWidth - pad);
  const y = Math.min(screen.y, window.innerHeight - menu.offsetHeight - pad);
  menu.style.left = Math.max(pad, x) + "px";
  menu.style.top = Math.max(pad, y) + "px";
}

function closeTierQuickMenu() {
  if (el.tierQuickMenu.hidden) return;
  el.tierQuickMenu.hidden = true;
  el.tierQuickMenu.innerHTML = "";
  pendingAddWorld = null;
}

// ---- saving ------------------------------------------------------------------
// Unsaved-edit tracking. Only meaningful in editor mode, since browsing can't
// change anything. Drives the Save button's look and the beforeunload guard.
let dirty = false;

function markDirty() {
  if (dirty) return;
  dirty = true;
  updateSaveButton();
}

function updateSaveButton() {
  if (!el.exportBtn) return;
  el.exportBtn.textContent = dirty ? "Save •" : "Save";
  el.exportBtn.classList.toggle("dirty", dirty);
  el.exportBtn.title = `Download labels.json  (Ctrl+S)`;
}

function saveLabels() {
  const json = labels.exportJson(currentMap.id);
  const count = labels.labels.length;
  downloadFile(MAP_FILES.labels, json);
  dirty = false;
  updateSaveButton();
  el.status.textContent = `Downloaded ${count} labels, save over ${currentMap.dir}/${MAP_FILES.labels}`;
}

// ---- init ------------------------------------------------------------------
// ---- panel resize --------------------------------------------------------
// Drag the handle to widen the panel. Useful on larger screens where 320px
// leaves the extract wrapping awkwardly. Persisted in localStorage. --panel-w
// is the single source of truth, so dragging only updates one variable.
const PANEL_W_KEY = "rsmap-panel-width";
const PANEL_MIN_W = 280;
function panelMaxW() {
  // Leaves at least 160px of map/controls visible regardless of how wide
  // wide the panel gets, but never reports a maximum below the minimum.
  // Without that floor the clamp in setPanelWidth() inverts on a narrow
  // viewport and returns a width under PANEL_MIN_W, or a negative one below
  // 160px wide, which then feeds every position derived from --panel-w.
  // Under ~440px the panel is a full-width sheet anyway, so this costs
  // nothing real.
  return Math.max(PANEL_MIN_W, Math.min(640, window.innerWidth - 160));
}
function setPanelWidth(w) {
  const clamped = Math.min(panelMaxW(), Math.max(PANEL_MIN_W, w));
  document.documentElement.style.setProperty("--panel-w", clamped + "px");
  return clamped;
}
// Only the panel's width needs JS. Its height, and the handle's, is pure CSS.
// See the .panel and .panel-body split in style.css.
function initPanelResize() {
  const handle = el.panelResizeHandle;
  if (!handle) return;

  // The width you last chose, independent of what currently fits. Clamping is
  // applied on the way out to the CSS variable, never folded back into this.
  // Otherwise narrowing the window would permanently shrink the preference,
  // and widening it again would leave the panel stuck at whatever the
  // narrowest moment allowed.
  let preferredW = parseInt(localStorage.getItem(PANEL_W_KEY), 10);
  if (!isFinite(preferredW)) preferredW = el.panel.getBoundingClientRect().width;
  setPanelWidth(preferredW);

  let dragging = false;
  let startX = 0;
  let startW = 0;

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = el.panel.getBoundingClientRect().width;
    handle.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    // The panel is right-anchored, so dragging the handle left (negative
    // clientX movement) should grow it, not shrink it.
    preferredW = setPanelWidth(startW + (startX - e.clientX));
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    localStorage.setItem(PANEL_W_KEY, Math.round(preferredW));
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  // Re-clamp the *preference* against the new viewport: a width that was fine
  // on a wide window could otherwise leave no map visible on a narrow one, and
  // widening the window again restores the panel to the size you actually
  // asked for.
  window.addEventListener("resize", () => setPanelWidth(preferredW));
}

function initUi(initialMapId) {
  // Icons injected here rather than baked into index.html so the markup
  // stays free of duplicated path data. The buttons start empty in the HTML,
  // with only their aria-label and title, so there's no flash of a stale
  // glyph before this runs.
  el.zoomIn.innerHTML = ICON_ADD;
  el.zoomOut.innerHTML = ICON_REMOVE;
  el.reset.innerHTML = ICON_RESET_VIEW;
  el.infoBtn.innerHTML = ICON_INFO;
  const disclaimerCta = $(".disclaimer-cta");
  if (disclaimerCta) disclaimerCta.insertAdjacentHTML("beforeend", " " + ICON_EXTERNAL);

  el.mapSelect.innerHTML = MAPS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
  if (initialMapId) el.mapSelect.value = initialMapId;
  el.mapSelect.addEventListener("change", () => {
    const m = MAPS.find((x) => x.id === el.mapSelect.value);
    openMap(m); // a manual map switch always starts that map at its own home view
  });
  el.exportBtn.addEventListener("click", saveLabels);
  updateSaveButton();
  // Editor work only lives in memory until saved, so leaving with unsaved
  // label edits should cost a confirmation rather than the edits.
  window.addEventListener("beforeunload", (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
  el.zoomIn.addEventListener("click", () => viewer.stepZoom(+1));
  el.zoomOut.addEventListener("click", () => viewer.stepZoom(-1));
  el.reset.addEventListener("click", () => viewer.resetView());

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeTierQuickMenu(); return; }

    // Ctrl/Cmd+S skips the "not while typing" guard below on purpose:
    // finishing a label's name and saving without leaving the field first is
    // the most common way to save. Outside editor mode it isn't claimed, so
    // the browser's own Save Page still works.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      if (!labels || !labels.authorMode) return;
      e.preventDefault();
      saveLabels();
      return;
    }

    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    // Editor mode has no visible button, only this shortcut and a line in the
    // info popover. Shift+E with no other modifiers: Ctrl and Alt combos
    // collide with OS and GPU vendor hotkeys (AMD's overlay took
    // Ctrl+Shift+E), while a bare letter would fire on a stray keypress.
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      setAuthorMode(!labels.authorMode);
    }
  });

  // On narrow screens the panel is a sheet over a dimmed backdrop, and the
  // backdrop is a pseudo element on the frame itself. Pseudo elements forward
  // hits to their host, so a tap outside the sheet arrives here with the frame
  // as target, while taps on the content hit #panelBody and are ignored.
  el.panel.addEventListener("click", (e) => {
    if (e.target === el.panel && labels) labels.select(null);
  });

  el.infoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    el.infoPanel.hidden = !el.infoPanel.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!el.infoPanel.hidden && !el.infoPanel.contains(e.target) && e.target !== el.infoBtn) {
      el.infoPanel.hidden = true;
    }
    if (!el.tierQuickMenu.hidden && !el.tierQuickMenu.contains(e.target)) {
      closeTierQuickMenu();
    }
  });

  initPanelResize();
}

// loadMap() awaits several fetches; if any of them fails (a missing meta.json,
// an offline first load) the failure has to land somewhere visible, or the app
// just shows an empty canvas and says nothing.
function openMap(mapCfg, restore) {
  return loadMap(mapCfg, restore).catch((err) => {
    console.error(err);
    el.status.textContent = `Couldn't load ${mapCfg.label}: ${err.message}`;
    el.panel.classList.remove("empty");
    el.panelBody.innerHTML =
      `<div class="panel-hint">Couldn't load <strong>${escapeHtml(mapCfg.label)}</strong>.<br>` +
      `<span class="fld-hint">${escapeHtml(err.message)}</span></div>`;
  });
}

const initialUrlState = parseUrlState();
const initialMap = (initialUrlState.map && MAPS.find((m) => m.id === initialUrlState.map)) || MAPS[0];
initUi(initialMap.id);
openMap(initialMap, initialUrlState);
