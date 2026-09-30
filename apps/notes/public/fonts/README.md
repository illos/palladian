# Palladian font asset provenance

Copied byte-for-byte from the read-only Deltos `packages/client/public/fonts/` assets on 2026-09-30. Font files are source assets, not generated application bundles. Adjacent `*-LICENSE.txt` files carry the original OFL-1.1 licenses from Deltos’s fontsource packages.

Palladian declares all four typefaces in `src/theme.css`; browsers fetch faces only when used. The shell service worker must include these public font files for offline viewing. The original Deltos notes below explain source/subset provenance; Deltos-specific build/runtime claims do not establish Palladian acceptance.

# Self-hosted fonts (UI visual refresh, Lane 0)

These `.woff2` files are **self-hosted, latin-subset** copies of the everyday voices, served at
`/fonts/*` and `@font-face`-declared in `src/theme/tokens.css`. They are precached by the service
worker (the `woff2` glob in `vite.config.ts` → workbox `injectManifest`), so the everyday repeat
load fetches zero font bytes and works offline.

Shipped now (Deploy 1 — default Sans voice + mandatory Mono metadata):

- `ibm-plex-sans-{400,500,600,700}.woff2`
- `ibm-plex-mono-{400,500,600}.woff2`

## Provenance

Copied verbatim from the **`@fontsource/ibm-plex-sans`** and **`@fontsource/ibm-plex-mono`**
packages' pre-subset `latin` `*-normal.woff2` files. Those packages are listed in the client
`devDependencies` **only as the source of these files** — they are NOT imported by any code, so do
not flag them as unused/dead deps; they document the exact upstream + version + subset and let the
files be regenerated. (IBM Plex is OFL-1.1 licensed.)

## Shipped — Lane 5 (Appearance picker, Deploy 2)

The two lazy voices + the Newsreader **δ-wordmark** subset:

- `newsreader-{400,500,600}.woff2` + `newsreader-{400,500,600}-italic.woff2` — full Serif faces.
- `space-grotesk-{400,500,600,700}.woff2` — full Grotesk faces.
- `newsreader-delta.woff2` — the brand δ glyph (always-loaded, declared in `tokens.css`).

The two full-face sets are **lazy**: declared in `src/styles/fonts/{newsreader,space-grotesk}.css`,
which `FONT_CHUNK` in `src/lib/themeStore.ts` `import()`s on first Serif/Grotesk selection — so default
(Ember × Sans) users never fetch them. Once fetched they're SW-cached forever (`/fonts/` CacheFirst,
no expiry). Mono selection fetches nothing (reuses the precached Plex Mono metadata faces).

### Provenance — Newsreader & Space Grotesk

- **Newsreader/Grotesk full faces:** copied verbatim from **`@fontsource/newsreader`** /
  **`@fontsource/space-grotesk`** pre-subset `latin` `*-normal.woff2` (+ `-italic` for Newsreader),
  same as the everyday faces. Both packages are client `devDependencies` **only as the file source**
  (not imported — do not flag as dead deps). OFL-1.1.
- **δ subset (`newsreader-delta.woff2`, 5.5KB):** the fontsource `latin` files carry **no Greek**, so
  δ (U+03B4) is sourced from Google Fonts' **greek subset** of Newsreader 600 (a directly-downloadable
  `/s/newsreader/…woff2`), shipped as-is and scoped via `unicode-range: U+03B4` in tokens.css so only
  δ ever renders from it. (The spec's `pyftsubset` δ-only path needs fonttools, which can't be
  installed on this unprivileged box — no pip/ensurepip — and Google's `/l/font` literal text-subset
  endpoint returns HTTP 400 on server-side fetch. The 5.5KB greek subset is within the spec's ~2-6KB
  δ-budget, so it's the pragmatic equivalent. To trim to a true δ-only ~2KB later, regenerate with
  `pyftsubset Newsreader-SemiBold.ttf --unicodes=U+03B4 --flavor=woff2` once fonttools is available.)

### Revisioning caveat (carry-forward)

`/fonts/*` filenames are not content-hashed and the SW rule is cache-first by URL. If a font file's
**contents** ever change under the same name, cached clients keep stale bytes — version the filename
(`space-grotesk-500.v2.woff2`) on any content change.
