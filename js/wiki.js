const API = "https://runescape.wiki/api.php";
const ARTICLE = "https://runescape.wiki/w/";

// Matches panelMaxW() in main.js; MediaWiki won't upscale past the source anyway.
const MAX_PANEL_W = 640;
const THUMB_SIZE = Math.min(
  1280,
  Math.round((MAX_PANEL_W * Math.min(2, window.devicePixelRatio || 1)) / 160) * 160
);

const cache = new Map();
const relatedCache = new Map();
const sectionsCache = new Map();
const examineCache = new Map();

export function titleFromWiki(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (v.includes("://")) {
    try {
      const u = new URL(v);
      const m = u.pathname.match(/\/(?:w|wiki)\/(.+)$/);
      if (m) return decodeURIComponent(m[1]).replace(/_/g, " ");
      const t = u.searchParams.get("title");
      if (t) return t.replace(/_/g, " ");
    } catch (_) { /* fall through */ }
  }
  return v.replace(/_/g, " ");
}

export function wikiUrl(title) {
  return ARTICLE + encodeURIComponent(String(title).replace(/ /g, "_"));
}

export async function fetchSummary(title) {
  if (cache.has(title)) return cache.get(title);
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "extracts|pageimages|categories",
    exintro: "1",
    explaintext: "1",
    redirects: "1",
    piprop: "thumbnail",
    pithumbsize: String(THUMB_SIZE),
    cllimit: "20",
    clshow: "!hidden",
    titles: title,
    origin: "*",
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) throw new Error(`wiki ${res.status}`);
  const data = await res.json();
  const page = data && data.query && data.query.pages && data.query.pages[0];
  const out =
    page && !page.missing
      ? {
          title: page.title,
          extract: page.extract || "",
          thumb: page.thumbnail ? page.thumbnail.source : null,
          url: wikiUrl(page.title),
          categories: (page.categories || []).map((c) => ({
            title: c.title.replace(/^Category:/, ""),
            url: wikiUrl(c.title),
          })),
        }
      : null;
  cache.set(title, out);
  return out;
}

export async function fetchRelated(title, limit = 5) {
  if (relatedCache.has(title)) return relatedCache.get(title);
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    list: "search",
    srsearch: `morelike:${title}`,
    srlimit: String(limit),
    srprop: "",
    origin: "*",
  });
  const res = await fetch(`${API}?${params}`);
  let out = [];
  if (res.ok) {
    const data = await res.json();
    const results = (data && data.query && data.query.search) || [];
    out = results
      .filter((r) => r.title !== title)
      .map((r) => ({ title: r.title, url: wikiUrl(r.title) }));
  }
  relatedCache.set(title, out);
  return out;
}

export async function fetchSections(title) {
  if (sectionsCache.has(title)) return sectionsCache.get(title);
  const params = new URLSearchParams({
    action: "parse",
    format: "json",
    formatversion: "2",
    prop: "sections",
    page: title,
    origin: "*",
  });
  const res = await fetch(`${API}?${params}`);
  let out = [];
  if (res.ok) {
    const data = await res.json();
    const sections = (data && data.parse && data.parse.sections) || [];
    out = sections
      .filter((s) => s.toclevel === 1)
      .slice(0, 8)
      .map((s) => ({ title: s.line.replace(/<[^>]+>/g, ""), anchor: s.anchor }));
  }
  sectionsCache.set(title, out);
  return out;
}

export async function searchTitles(prefix, limit = 8) {
  const q = String(prefix || "").trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({
    action: "opensearch",
    format: "json",
    search: q,
    limit: String(limit),
    namespace: "0",
    redirects: "resolve",
    origin: "*",
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data && data[1]) || [];
}

// Same as searchTitles but restricted to the File: namespace, for the media
// editor's filename autocomplete. Returned titles have "File:" stripped since
// the editor field stores bare filenames.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export async function searchFileTitles(prefix, limit = 8) {
  const q = String(prefix || "").trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({
    action: "opensearch",
    format: "json",
    search: q,
    // Over-fetch since the File namespace also holds audio (.ogg) that gets
    // filtered out below; asking for just `limit` up front would often
    // leave fewer than `limit` images once those are dropped.
    limit: String(limit * 3),
    namespace: "6",
    redirects: "resolve",
    origin: "*",
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  const titles = (data && data[1]) || [];
  return titles
    .map((t) => t.replace(/^File:/i, ""))
    .filter((t) => IMAGE_EXT.test(t))
    .slice(0, limit);
}

const fileInfoCache = new Map();

// Resolves a wiki media filename to its hotlinkable image URLs via the
// imageinfo API, so media.js never has to guess at MediaWiki's thumb path
// scheme. `file` is the bare filename (no "File:" prefix).
//
// `pinnedAt` locks resolution to the file revision current as of that ISO
// timestamp (via imageinfo's iistart, which walks history newest-first from
// a given point) instead of whatever's live now — otherwise a re-upload
// over the same filename on the wiki would silently change a media point's
// image out from under a saved map. Omit it to resolve the current version,
// which is also how a caller discovers the timestamp to pin to in the first
// place (see the returned `timestamp`).
export async function fetchFileInfo(file, pinnedAt) {
  const name = String(file || "").trim();
  if (!name) return null;
  const title = "File:" + name.replace(/^File:/i, "");
  const cacheKey = title + "|" + (pinnedAt || "");
  if (fileInfoCache.has(cacheKey)) return fileInfoCache.get(cacheKey);
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    titles: title,
    prop: "imageinfo",
    iiprop: "url|timestamp",
    iiurlwidth: String(THUMB_SIZE),
    origin: "*",
  });
  if (pinnedAt) {
    params.set("iistart", pinnedAt);
    params.set("iilimit", "1");
  }
  let out = null;
  try {
    const res = await fetch(`${API}?${params}`);
    if (res.ok) {
      const data = await res.json();
      const page = data && data.query && data.query.pages && data.query.pages[0];
      const info = page && !page.missing && page.imageinfo && page.imageinfo[0];
      if (info) out = { thumb: info.thumburl || info.url, full: info.url, pageUrl: wikiUrl(title), timestamp: info.timestamp };
    }
  } catch (e) { /* network hiccup, treat as unresolved */ }
  fileInfoCache.set(cacheKey, out);
  return out;
}

// Not a full wikitext parser, just enough for a short single-line infobox field.
function stripWikitext(s) {
  return s
    .replace(/\{\{[^{}]*\}\}/g, (m) => {
      const parts = m.slice(2, -2).split("|");
      return parts.length > 1 ? parts[parts.length - 1] : "";
    })
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(/'''''|'''|''/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export async function fetchExamine(title) {
  if (examineCache.has(title)) return examineCache.get(title);
  const params = new URLSearchParams({
    action: "parse",
    format: "json",
    formatversion: "2",
    page: title,
    prop: "wikitext",
    section: "0",
    origin: "*",
  });
  let out = null;
  try {
    const res = await fetch(`${API}?${params}`);
    if (res.ok) {
      const data = await res.json();
      const wikitext = data && data.parse && data.parse.wikitext;
      const m = wikitext && wikitext.match(/^\|\s*examine1?\s*=\s*(.+)$/m);
      if (m) {
        const cleaned = stripWikitext(m[1]);
        if (cleaned) out = cleaned;
      }
    }
  } catch (e) { /* network hiccup, treat as no examine text */ }
  examineCache.set(title, out);
  return out;
}

const infoboxCache = new Map();

// Finds the page's first top-level {{...}} template whose name starts with
// "Infobox", walking brace depth by hand rather than a regex — a plain
// regex can't balance nesting, and infobox fields routinely nest another
// template (e.g. a release date wrapped in {{Date|...}}).
function extractInfoboxBlock(wikitext) {
  const m = /\{\{\s*infobox/i.exec(wikitext);
  if (!m) return null;
  let depth = 0, i = m.index;
  for (; i < wikitext.length; i++) {
    if (wikitext.startsWith("{{", i)) { depth++; i++; }
    else if (wikitext.startsWith("}}", i)) { depth--; i++; if (depth === 0) break; }
  }
  return wikitext.slice(m.index, i);
}

// A monster/NPC with several forms (different combat levels, etc.) isn't
// multiple infobox templates on this wiki — it's one infobox with the field
// numbered per version (level1/level2/..., or plain `level` when every
// version shares it, as most do). This pulls every numbered-or-not
// occurrence of `field`, deduplicated.
function infoboxFieldValues(block, field) {
  const re = new RegExp(`^\\s*\\|\\s*${field}\\d*\\s*=\\s*(.+)$`, "gim");
  const values = [];
  let m;
  while ((m = re.exec(block))) {
    const v = stripWikitext(m[1].trim());
    if (v) values.push(v);
  }
  return [...new Set(values)];
}

// Numeric variants collapse to a "lo–hi" range once there's more than one
// (a monster with several combat-level forms); anything non-numeric just
// lists as-is.
function summarizeCombat(values) {
  if (!values.length) return null;
  if (values.length === 1) return values[0];
  const nums = values.map(Number);
  if (nums.every((n) => !Number.isNaN(n))) {
    const lo = Math.min(...nums), hi = Math.max(...nums);
    return lo === hi ? String(lo) : `${lo}–${hi}`;
  }
  return values.join(", ");
}

// Combat level and release date, read straight from the article's own
// infobox (fields `level`/`release` per Infobox Monster/NPC). A monster
// with several combat-level forms folds them into one "lo–hi" range rather
// than picking a form arbitrarily; release just takes the first (original)
// version's date. One fetch covers both, so main.js's separate combat-badge
// and release-line spots share this instead of hitting the API twice.
export async function fetchInfobox(title) {
  if (infoboxCache.has(title)) return infoboxCache.get(title);
  const params = new URLSearchParams({
    action: "parse",
    format: "json",
    formatversion: "2",
    page: title,
    prop: "wikitext",
    section: "0",
    origin: "*",
  });
  let out = null;
  try {
    const res = await fetch(`${API}?${params}`);
    if (res.ok) {
      const data = await res.json();
      const wikitext = data && data.parse && data.parse.wikitext;
      const block = wikitext && extractInfoboxBlock(wikitext);
      if (block) {
        const combat = summarizeCombat(infoboxFieldValues(block, "level"));
        const releaseValues = infoboxFieldValues(block, "release");
        const release = releaseValues.length ? releaseValues[0] : null;
        if (combat || release) out = { combat, release };
      }
    }
  } catch (e) { /* network hiccup, treat as no infobox data */ }
  infoboxCache.set(title, out);
  return out;
}
