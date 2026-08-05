// icons.js: inline SVG icons (Google Material Symbols), kept in one place so
// nothing duplicates path data. Each has its baked-in fill replaced with
// currentColor, so it follows the surrounding text across the dark, wiki-light
// and wiki-dark themes with no per-theme variants.

function icon(path) {
  return `<svg class="icon" viewBox="0 -960 960 960" aria-hidden="true"><path d="${path}"/></svg>`;
}

// zoom in (add_24dp)
export const ICON_ADD = icon("M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z");
// zoom out (remove_24dp)
export const ICON_REMOVE = icon("M200-440v-80h560v80H200Z");
// reset view (view_real_size_24dp)
export const ICON_RESET_VIEW = icon(
  "M280-280v-320h-80v-80h160v400h-80Zm160 0v-80h80v80h-80Zm200 0v-320h-80v-80h160v400h-80ZM440-440v-80h80v80h-80Z"
);
// info / shortcuts (info_24dp)
export const ICON_INFO = icon(
  "M440-280h80v-240h-80v240Zm68.5-331.5Q520-623 520-640t-11.5-28.5Q497-680 480-680t-28.5 11.5Q440-657 440-640t11.5 28.5Q463-600 480-600t28.5-11.5ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"
);
// external link (call_made_24dp), used after outbound wiki and game links
export const ICON_EXTERNAL = icon("m216-160-56-56 464-464H360v-80h400v400h-80v-264L216-160Z");
// search (search_24dp)
export const ICON_SEARCH = icon(
  "M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z"
);
// chevron left/right (search result paging)
export const ICON_CHEVRON_LEFT = icon("M560-240 320-480l240-240 56 56-184 184 184 184-56 56Z");
export const ICON_CHEVRON_RIGHT = icon("M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z");
// close (close_24dp)
export const ICON_CLOSE = icon("m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z");
