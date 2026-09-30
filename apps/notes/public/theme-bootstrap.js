/* Synchronous, device-only appearance before CSS/React/auth; no credentials or network. */
(() => {
  const root = document.documentElement;
  let value;
  try {
    value = JSON.parse(
      localStorage.getItem("palladian.notes.appearance.v1") || "null",
    );
  } catch {
    /* Default attrs remain valid when storage is unavailable. */
  }
  if (!value || typeof value !== "object") return;
  if (["bone", "graphite", "manila", "ember"].includes(value.palette))
    root.dataset.palette = value.palette;
  if (["serif", "sans", "mono", "grotesk"].includes(value.voice))
    root.dataset.voice = value.voice;
  if (["light", "dark", "system"].includes(value.mode))
    root.dataset.mode = value.mode;
  const paper = {
    bone: ["#FAF7F0", "#26211A"],
    graphite: ["#FFFFFF", "#202225"],
    manila: ["#F8F7F0", "#25221B"],
    ember: ["#FFFFFF", "#1A1A1D"],
  };
  const dark =
    root.dataset.mode === "dark" ||
    (root.dataset.mode === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", paper[root.dataset.palette][dark ? 1 : 0]);
})();
