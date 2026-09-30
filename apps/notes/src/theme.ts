export const PALETTES = ["bone", "graphite", "manila", "ember"] as const;
export const VOICES = ["serif", "sans", "mono", "grotesk"] as const;
export const MODES = ["light", "dark", "system"] as const;
export type Palette = (typeof PALETTES)[number];
export type Voice = (typeof VOICES)[number];
export type Mode = (typeof MODES)[number];
export interface ThemePreference {
  palette: Palette;
  voice: Voice;
  mode: Mode;
}
export const DEFAULT_THEME: ThemePreference = {
  palette: "graphite",
  voice: "sans",
  mode: "light",
};
export const THEME_STORAGE_KEY = "palladian.notes.appearance.v1";

export function parseTheme(value: unknown): ThemePreference {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    palette:
      PALETTES.find((item) => item === record.palette) ?? DEFAULT_THEME.palette,
    voice: VOICES.find((item) => item === record.voice) ?? DEFAULT_THEME.voice,
    mode: MODES.find((item) => item === record.mode) ?? DEFAULT_THEME.mode,
  };
}
function initialTheme(): ThemePreference {
  if (typeof document === "undefined") return DEFAULT_THEME;
  return parseTheme(document.documentElement.dataset);
}
let current = initialTheme();
const listeners = new Set<() => void>();
export function getThemeSnapshot() {
  return current;
}
export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function updateThemeColor() {
  const paper = getComputedStyle(document.documentElement)
    .getPropertyValue("--paper")
    .trim();
  if (paper)
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", paper);
}
export function applyTheme(theme: ThemePreference) {
  current = parseTheme(theme);
  if (typeof document !== "undefined") {
    Object.assign(document.documentElement.dataset, current);
    updateThemeColor();
  }
  for (const listener of listeners) listener();
}
/** Applies immediately even if device preference storage cannot be written. */
export function setTheme(patch: Partial<ThemePreference>): boolean {
  applyTheme({ ...current, ...patch });
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(current));
    return true;
  } catch {
    return false;
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    try {
      applyTheme(
        parseTheme(event.newValue ? JSON.parse(event.newValue) : null),
      );
    } catch {
      applyTheme(DEFAULT_THEME);
    }
  });
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", updateThemeColor);
  applyTheme(current);
}
