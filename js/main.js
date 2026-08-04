import { MAPS, MAP_FILES, LABEL_TIERS, TIER_ORDER, DEFAULT_TIER } from "./config.js";
import { Viewer } from "./viewer.js";
import { LabelLayer } from "./labels.js";
import { titleFromWiki, wikiUrl, fetchSummary, fetchRelated, fetchSections, fetchExamine, searchTitles } from "./wiki.js";
import { ICON_ADD, ICON_REMOVE, ICON_RESET_VIEW, ICON_INFO, ICON_EXTERNAL, ICON_SEARCH, ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT } from "./icons.js";
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
  searchBtn: $("#searchBtn"),
  searchPanel: $("#searchPanel"),
  searchInput: $("#searchInput"),
  searchCount: $("#searchCount"),
  searchNavRow: $("#searchNavRow"),
  searchPrevBtn: $("#searchPrevBtn"),
  searchNextBtn: $("#searchNextBtn"),
  searchNavLabel: $("#searchNavLabel"),
  searchResults: $("#searchResults"),
};

let viewer = null;
let labels = null;
let currentMap = null;
let wikiToken = 0; // guards against stale async wiki renders

// ---- URL state ------------------------------------------------------------
// The fragment mirrors map, style, view and selected label. Written with
// replaceState so it never adds history entries.
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
// One-off changes call flushUrlUpdate() instead.
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

let currentChromeClass = null;
function applyChrome(styleDef) {
  if (currentChromeClass) document.body.classList.remove(currentChromeClass);
  currentChromeClass = (styleDef && styleDef.chrome) || null;
  if (currentChromeClass) document.body.classList.add(currentChromeClass);
}

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

// Shared by switchStyle() and loadMap() so the opening style takes the same
// path as one you pick.
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
    labels.checkWiki(label);
  } else {
    el.panel.classList.remove("author-mode-panel");
    el.panelBody.innerHTML = `<button class="wiki-close" title="Close">×</button><div id="wikiBox" class="wiki-box"></div>`;
    $(".wiki-close").addEventListener("click", () => labels.select(null));
    renderWiki($("#wikiBox"), label);
  }
}

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

// ---- label search -----------------------------------------------------------
let searchMatches = [];
let searchIndex = -1;
const SEARCH_RESULTS_CAP = 300; // rendered list only; paging still reaches every match

function normalizeLabelText(name) {
  return String(name || "").replace(/\n/g, " ");
}

// Lower is better: 0 exact, 1 the query starts the name, 2 the query starts a
// later word, 3 it just occurs somewhere. Keeps "Rats"/"Giant Rats" ahead of
// "Wilderness Crater" for a search of "rat".
function searchMatchRank(nameLower, q) {
  if (nameLower === q) return 0;
  if (nameLower.startsWith(q)) return 1;
  if (nameLower.includes(" " + q)) return 2;
  return 3;
}

function runSearch(query) {
  const q = query.trim().toLowerCase();
  searchMatches = !q || !labels
    ? []
    : labels.labels
        .map((l) => ({ l, nameLower: normalizeLabelText(l.name).toLowerCase() }))
        .filter(({ nameLower }) => nameLower.includes(q))
        .map(({ l, nameLower }) => ({ l, rank: searchMatchRank(nameLower, q), nameLower }))
        .sort((a, b) => {
          if (a.rank !== b.rank) return a.rank - b.rank;
          const ta = TIER_ORDER.indexOf(a.l.tier), tb = TIER_ORDER.indexOf(b.l.tier);
          return ta !== tb ? ta - tb : a.nameLower.localeCompare(b.nameLower);
        })
        .map(({ l }) => l);
  searchIndex = searchMatches.length ? 0 : -1;
  if (searchIndex >= 0) goToSearchResult(searchIndex, false);
  else renderSearchResults();
}

function goToSearchResult(i, animate = true) {
  if (!searchMatches.length) return;
  searchIndex = (i + searchMatches.length) % searchMatches.length;
  const label = searchMatches[searchIndex];
  const tier = LABEL_TIERS[label.tier] || LABEL_TIERS[DEFAULT_TIER];
  viewer.flyTo(label.x, label.y, tier.searchZoom || 1, animate);
  labels.select(label); // fires onSelect -> renderPanel + flushUrlUpdate
  renderSearchResults();
}

function renderSearchResults() {
  const q = el.searchInput.value.trim();
  const n = searchMatches.length;
  el.searchCount.textContent = q ? `${n ? searchIndex + 1 : 0}/${n}` : "";
  el.searchNavRow.hidden = n < 2;
  el.searchPrevBtn.disabled = el.searchNextBtn.disabled = n < 2;
  el.searchNavLabel.textContent = n ? `${searchIndex + 1} of ${n}` : "";

  if (!q) { el.searchResults.innerHTML = ""; return; }
  if (!n) { el.searchResults.innerHTML = `<div class="search-empty">No labels match “${escapeHtml(q)}”.</div>`; return; }

  const shown = searchMatches.slice(0, SEARCH_RESULTS_CAP);
  el.searchResults.innerHTML =
    shown
      .map(
        (l, i) => `
      <button type="button" class="search-result${i === searchIndex ? " active" : ""}" data-i="${i}">
        <span class="search-result-name">${escapeHtml(normalizeLabelText(l.name))}</span>
        <span class="search-result-tier">${escapeHtml((LABEL_TIERS[l.tier] || LABEL_TIERS[DEFAULT_TIER]).label)}</span>
      </button>`
      )
      .join("") +
    (n > SEARCH_RESULTS_CAP ? `<div class="search-hint">+${n - SEARCH_RESULTS_CAP} more — refine your search.</div>` : "");
  el.searchResults.querySelectorAll(".search-result").forEach((btn) => {
    btn.addEventListener("click", () => goToSearchResult(+btn.dataset.i));
  });
  const active = el.searchResults.querySelector(".search-result.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function openSearchPanel() {
  el.searchPanel.hidden = false;
  el.searchInput.focus();
  el.searchInput.select();
}

function closeSearchPanel() {
  el.searchPanel.hidden = true;
}

function resetSearch() {
  searchMatches = [];
  searchIndex = -1;
  if (el.searchInput) el.searchInput.value = "";
  renderSearchResults();
}

// ---- wiki sidebar content --------------------------------------------------
// Shows the wiki article's own title once resolved, not the label's map text.
// Author mode skips it since the label text is an editable field right above.
function wikiHeading(title) {
  if (labels.authorMode) return "";
  return `<div class="wiki-title-wrap"><h2 class="wiki-title">${escapeHtml(title)}</h2></div>`;
}

// True when all four corners are near-transparent: an NPC/item cutout render
// rather than an opaque scene. Needs crossorigin="anonymous" so the canvas
// isn't tainted; returns false on any failure since this is purely cosmetic.
function isCutoutRender(img) {
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return false;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const s = 6; // fixed size; a tight infobox crop can put content close to a corner
    const corners = [
      [0, 0], [w - s, 0], [0, h - s], [w - s, h - s],
    ];
    return corners.every(([cx, cy]) => {
      const data = ctx.getImageData(cx, cy, s, s).data;
      let alphaSum = 0;
      for (let i = 3; i < data.length; i += 4) alphaSum += data[i];
      return alphaSum / (data.length / 4) < 40;
    });
  } catch (e) {
    return false;
  }
}

async function renderWiki(box, label) {
  if (!box) return;
  const fallback = String(label.name).replace(/\n/g, " ");
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

    const thumbWrap = box.querySelector("#wikiThumbWrap");
    const thumbImg = thumbWrap && thumbWrap.querySelector("img");
    if (thumbImg) {
      const applyCutoutPadding = () => {
        if (token !== wikiToken) return;
        if (isCutoutRender(thumbImg)) thumbWrap.classList.add("cutout");
      };
      if (thumbImg.complete) applyCutoutPadding();
      else thumbImg.addEventListener("load", applyCutoutPadding, { once: true });
    }

    // Examine, sections and related pages are each their own API call and
    // garnish on a panel that already shows its article, so a failed request
    // just leaves its slot empty rather than surfacing an error.
    fetchExamine(s.title).then((examine) => {
      if (token !== wikiToken || !examine) return;
      const el2 = box.querySelector("#wikiExamine");
      if (!el2) return;
      el2.outerHTML = `<p class="wiki-examine">“${escapeHtml(examine)}”</p>`;
    }, () => {});

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
// `restore` re-applies state read from the URL fragment on first load; an
// ordinary map switch omits it.
async function loadMap(mapCfg, restore = {}) {
  closeTierQuickMenu();
  closeSearchPanel();
  resetSearch();
  el.status.textContent = "Loading " + mapCfg.label + "…";
  currentMap = mapCfg;

  // Resolve the opening style before fetching any tiles, so a shared
  // "#style=wiki3d" link loads that pyramid directly.
  const style = (restore.style && styleById(mapCfg, restore.style)) || mapCfg.styles[0];
  currentStyleId = style.id;
  const styleDir = styleDirFor(mapCfg, style.id);
  const meta = await loadJson(`${styleDir}/${MAP_FILES.meta}`);
  styleMetaCache = { [style.id]: meta };

  if (viewer) viewer.destroy();
  labels = null;
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
    if (!labels.authorMode) return;
    ev.preventDefault();
    const css = overlayApi().toScreen(world.x, world.y);
    const hit = labels.hitTest(css.x, css.y);
    if (hit) { labels.select(hit); return; }
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
    labels.select(restoredLabel);
  } else {
    renderPanel(null);
  }

  dirty = false;
  updateSaveButton();
  el.status.textContent = `${mapCfg.label}, ${labels.labels.length} labels`;
  viewer.start();
  flushUrlUpdate();
}

// ---- editor mode + export ---------------------------------------------------
function setAuthorMode(on) {
  labels.authorMode = on;
  document.body.classList.toggle("editor-mode", on);
  el.exportBtn.hidden = !on;
  el.canvas.style.cursor = on ? "crosshair" : "grab";
  updateSaveButton();
  // No bulk wiki check on entry: with a few hundred labels that fired a few
  // hundred concurrent requests. Each is checked when its own panel opens.
  if (!on) closeTierQuickMenu();
  renderPanel(labels.selected);
  viewer.invalidate();
}

// ---- editor mode: right-click "quick add" menu ------------------------------
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
      labels.add(pendingAddWorld, btn.dataset.tier);
      closeTierQuickMenu();
      const nameField = document.getElementById("f-name");
      if (nameField) { nameField.focus(); nameField.select(); }
    });
  });
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

// ---- panel resize --------------------------------------------------------
const PANEL_W_KEY = "rsmap-panel-width";
const PANEL_MIN_W = 280;
function panelMaxW() {
  return Math.max(PANEL_MIN_W, Math.min(640, window.innerWidth - 160));
}
function setPanelWidth(w) {
  const clamped = Math.min(panelMaxW(), Math.max(PANEL_MIN_W, w));
  document.documentElement.style.setProperty("--panel-w", clamped + "px");
  return clamped;
}
function initPanelResize() {
  const handle = el.panelResizeHandle;
  if (!handle) return;

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
    // Panel is right-anchored, so dragging left grows it.
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

  window.addEventListener("resize", () => setPanelWidth(preferredW));
}

function initUi(initialMapId) {
  el.zoomIn.innerHTML = ICON_ADD;
  el.zoomOut.innerHTML = ICON_REMOVE;
  el.reset.innerHTML = ICON_RESET_VIEW;
  el.infoBtn.innerHTML = ICON_INFO;
  el.searchBtn.innerHTML = ICON_SEARCH;
  el.searchPrevBtn.innerHTML = ICON_CHEVRON_LEFT;
  el.searchNextBtn.innerHTML = ICON_CHEVRON_RIGHT;
  const disclaimerCta = $(".disclaimer-cta");
  if (disclaimerCta) disclaimerCta.insertAdjacentHTML("beforeend", " " + ICON_EXTERNAL);

  el.mapSelect.innerHTML = MAPS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
  if (initialMapId) el.mapSelect.value = initialMapId;
  el.mapSelect.addEventListener("change", () => {
    const m = MAPS.find((x) => x.id === el.mapSelect.value);
    openMap(m);
  });
  el.exportBtn.addEventListener("click", saveLabels);
  updateSaveButton();
  window.addEventListener("beforeunload", (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
  el.zoomIn.addEventListener("click", () => viewer.stepZoom(+1));
  el.zoomOut.addEventListener("click", () => viewer.stepZoom(-1));
  el.reset.addEventListener("click", () => viewer.resetView());

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeTierQuickMenu(); closeSearchPanel(); return; }

    // Skips the "not while typing" guard below on purpose: finishing a
    // label's name and saving without leaving the field first is common.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      if (!labels || !labels.authorMode) return;
      e.preventDefault();
      saveLabels();
      return;
    }

    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      setAuthorMode(!labels.authorMode);
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === "/") {
      e.preventDefault();
      openSearchPanel();
    }
  });

  // On narrow screens the panel is a sheet whose backdrop is a pseudo element
  // on the frame; a tap outside the sheet arrives here with the frame as
  // target, while taps on the content hit #panelBody and are ignored.
  el.panel.addEventListener("click", (e) => {
    if (e.target === el.panel && labels) labels.select(null);
  });

  el.infoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    el.infoPanel.hidden = !el.infoPanel.hidden;
  });
  el.searchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (el.searchPanel.hidden) openSearchPanel();
    else closeSearchPanel();
  });
  el.searchInput.addEventListener("click", (e) => e.stopPropagation());
  el.searchInput.addEventListener("input", (e) => runSearch(e.target.value));
  el.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToSearchResult(searchIndex + (e.shiftKey ? -1 : 1));
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel();
      el.searchInput.blur();
    }
  });
  el.searchPrevBtn.addEventListener("click", () => goToSearchResult(searchIndex - 1));
  el.searchNextBtn.addEventListener("click", () => goToSearchResult(searchIndex + 1));
  document.addEventListener("click", (e) => {
    if (!el.infoPanel.hidden && !el.infoPanel.contains(e.target) && e.target !== el.infoBtn) {
      el.infoPanel.hidden = true;
    }
    if (!el.searchPanel.hidden && !el.searchPanel.contains(e.target) && e.target !== el.searchBtn) {
      closeSearchPanel();
    }
    if (!el.tierQuickMenu.hidden && !el.tierQuickMenu.contains(e.target)) {
      closeTierQuickMenu();
    }
  });

  initPanelResize();
}

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
