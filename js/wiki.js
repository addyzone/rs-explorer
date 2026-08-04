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
