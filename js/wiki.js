// wiki.js: small RuneScape Wiki API client for the label sidebar.
//
// Uses the MediaWiki API with origin=* so it works cross-origin from a static
// site. Fetches a page's intro extract and thumbnail, cached for the session.
// The extras (categories, related pages, section list, title search for the
// author-mode autocomplete) are each cached and fetched independently, so a
// slow one never blocks the others.

const API = "https://runescape.wiki/api.php";
const ARTICLE = "https://runescape.wiki/w/";

// Width to request infobox thumbnails at. The panel resizes up to 640 CSS px,
// so a fixed 320 was upscaled 2x on a widened panel and 4x at 2x DPR, which is
// what made renders look soft. MediaWiki never upscales past the original, so
// asking for more costs nothing on small source images.
//
// Resolved once at module load, not per call: it feeds the request URL, and
// `cache` is keyed by title alone, so a value that drifted mid-session would
// return a summary thumbed at some earlier width.
const MAX_PANEL_W = 640; // keep in step with panelMaxW() in main.js
const THUMB_SIZE = Math.min(
  1280, // the wiki's largest common bucket, beyond which it is wasted bytes
  Math.round((MAX_PANEL_W * Math.min(2, window.devicePixelRatio || 1)) / 160) * 160
);

const cache = new Map(); // title -> summary | null
const relatedCache = new Map(); // title -> [{title,url}] | null
const sectionsCache = new Map(); // title -> [{title,anchor}] | null
const examineCache = new Map(); // title -> examine string | null

// Accepts a plain page title, a "/w/Page_Name" path, or a full wiki URL and
// returns the clean page title.
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

// Returns { title, extract, thumb, url, categories } or null if the page
// doesn't exist. `categories` is [{ title, url }].
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

// "More like this" suggestions, so the panel is not a dead end once you have
// read the article. Up to `limit` { title, url } entries, or [] if none.
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

// Top-level section headings with anchors, for the "jump to" list. Cheap: just
// titles, not content. The article itself stays a click away on the wiki.
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

// Prefix search over page titles for the author-mode autocomplete, which cuts
// down on typo'd links that silently fail to resolve.
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

// Strips the markup found in a one-line infobox field (links, bold, italic,
// simple non-nested templates) down to plain text. Not a wikitext parser, just
// enough for the short single-line values these fields hold.
function stripWikitext(s) {
  return s
    .replace(/\{\{[^{}]*\}\}/g, (m) => {
      // {{WP|Satire|satirise}} becomes "satirise": the last segment is the
      // display text for most inline templates. Bare {{Foo}} is dropped.
      const parts = m.slice(2, -2).split("|");
      return parts.length > 1 ? parts[parts.length - 1] : "";
    })
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1") // [[target|label]] / [[target]]
    .replace(/'''''|'''|''/g, "") // bold/italic quote-markup
    .replace(/<[^>]+>/g, "") // stray HTML tags
    .trim();
}

// The infobox examine text: the in-game right-click flavour line, often the
// best thing on the page. The extract is article prose, not infobox data, so
// this reads the lead section's raw wikitext and picks `examine` (or
// `examine1` where an infobox has variants) out of the template call. Null if
// the page has no such field, which is most non-NPC articles.
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
