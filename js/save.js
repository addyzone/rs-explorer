// save.js: editor export. Downloads labels.json for you to copy over the
// real file, same as any other browser download.
export function downloadFile(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
