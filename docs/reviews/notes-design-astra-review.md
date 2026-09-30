# Notes visual fidelity — independent Astra review

Date: 2026-09-30. Reviewer: Astra, independent of the shell, theme, and editor implementers.

Status: **accepted for the supported visual slice**. No unresolved blocking source or visual finding remains. This does not accept complete Deltos feature parity, complete notes v1, production deployment, or the foundation's open authentication/sync/device gates.

## Reviewed scope

Reviewed implementation snapshot: **`df80091907fea56442e30f91d5d342b632d69654`**, committed and pushed on `feat/notes-design`. Review includes inline appearance bootstrap, preserved editor mounting through Settings, edited-date placement, and direct-child title styling. This records the source commit, independently of the subsequent review-document commit.

Reviewed `apps/notes/src/App.tsx`, `EditorSurface.tsx`, `editor.tsx`, `Icons.tsx`, `styles.css`, `Appearance.tsx`, `appearance.css`, `theme.ts`, `theme.css`, the HTML/bootstrap/offline-shell integration, font provenance, and the new visual/browser regressions. Deltos was read-only reference: its live theme pointer, tokens/fonts, three-region shell, Appearance UI, editor styles, and the owner's two supplied screenshots.

The actual Deltos default is Graphite / Sans / Light; an older token/spec comment naming Ember is stale. The implementation follows the live default. Scope includes the three-pane desktop shell, existing notes list/editor, mobile navigation, Appearance, and formatting commands already supported by the installed ProseMirror schema. It does not add placeholder notebooks, Trash, extra Settings pages, formulas, attachments, or a custom keyboard merely to fill the reference screenshot.

## Independent evidence

- Rendered and inspected synthetic-content screenshots in Chromium at desktop 1434×752 and mobile 393×852 and 430×852. Compared supported surfaces to the supplied Deltos screenshots and live source geometry. Also inspected mobile Ember / Serif / Dark Appearance. These are real browser renders with fixture data and a stalled synthetic authentication service, not actual-service or physical-iPhone tests.
- Independently exercised draft → Appearance → palette/type/mode change → Notes on desktop and mobile. The same ProseMirror DOM node remained mounted, draft content survived, subsequent edits persisted, and reload restored both the latest draft and chosen theme while authentication remained stalled. This checks the highest-risk UI lifecycle regression introduced by Settings.
- Independently compared all 18 bundled WOFF2 files to the Deltos originals: all hashes match, totaling 343,144 bytes. Font licenses/provenance accompany them. There are no external font-provider requests.
- Inspected the implementation diff against foundation `4e7f7de`: `session.ts`, `cache.ts`, `main.tsx`, and the service spike are unchanged. Existing local-first reads, generation fences, same-account display continuity, and bounded initial rendering remain in place.
- Reviewed the initial-render path: validated device-only appearance is inlined into HTML before the app module; it does not require another synchronous network request or authentication. Fonts use swap rendering. The rich editor remains dynamically imported after opening a note, with the existing readable/typing fallback.
- Reviewed the service-worker change: only build-owned public bootstrap/font assets are added to the existing allowlist; their contents participate in versioning. API responses, query-bearing requests, and authorization-bearing requests remain excluded. Theme preference contains only palette, voice, and mode in a separate localStorage key.

Screenshots were kept outside the repository under `/tmp/notes-design-astra-*.png`; they contain synthetic content. They are review-session evidence, not durable published visual baselines.

## Visual assessment

The overlapping desktop surfaces match the reference's core geometry and tokens: 222 px navigation, 300 px list, paper surface, full-width note rows with selected accent edge, Plex Mono metadata, and the reference type families/weights. The reading column has a 680 px maximum text width, and the edited date sits below the formatting strip immediately above the title. Palette previews, type pills, mode cards, spacing, borders, and selected treatments follow the Deltos implementation.

Mobile list/note layouts at both inspected widths remain readable without observed horizontal overflow. Appearance wraps its cards cleanly and uses a bottom navigation sheet. Existing read-only cached notes remain visibly read-only; draft/server-save status stays explicit. Palladian branding, honest connection/draft status, and omitted unavailable controls are intentional differences. This is a supported-surface fidelity judgment, not a pixel-diff identity claim across different content, browser scales, and absent features.

## Findings resolved during review

| Severity  | Finding                                                                                                                                                     | Resolution and evidence                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High      | Navigating to Settings could unmount a draft editor whose input prop intentionally remains the initial snapshot, losing the current editor state on return. | The note region stays mounted and is hidden; `[hidden]` overrides layout display rules. Independent desktop/mobile round trips retain the same editor node and latest persisted content. |
| Important | Broad first-child paragraph styling also enlarged paragraphs inside lists/quotes as titles.                                                                 | Title selectors now require a direct child of the editor or cached-text surface. Synthetic rich-document render and the added nested-list regression cover the distinction.              |
| Important | An external synchronous theme-bootstrap script introduced another network dependency before first paint.                                                    | The build plugin now inlines the validated bootstrap into HTML. Public assets remain available offline without coupling note display to auth.                                            |
| Moderate  | Theme radio controls lacked the expected keyboard movement and initial browser chrome color could disagree with the saved theme.                            | Roving tab stops and Arrow/Home/End movement are implemented; the prepaint bootstrap also sets the theme-color value.                                                                    |
| Moderate  | A decorative resize handle implied unsupported resizing, and date/tool glyph placement diverged from Deltos.                                                | The inert resize affordance was removed; the date moved into the reading column; supported toolbar controls use reference SVG paths and typography.                                      |

## Integrated checks and remaining limits

Parent-reported final integrated checks at the reviewed source commit:

- **40/40 passed** across desktop and mobile Chromium: 32 foundation regressions and 8 design cases.
- **2/2 passed** production service-worker probes with network completely disabled, including one-note and 2,000-note caches, appearance/font assets, and search beyond the initial rendered rows.
- **14/14 passed** controller tests with controlled services.
- Strict application/tool/browser TypeScript and repository Prettier checks passed.

The final concurrent synthetic offline probes observed library/text at 75.8/187.8 ms for one note and 153.7/284.6 ms for 2,000 notes. Earlier isolated observations were faster. These are individual desktop Chromium observations with automation and workload variation, not p95 or physical-device performance budgets.

Theme and editor implementers separately reported all 48 palette/voice/mode bootstrap combinations plus malformed/storage-failure cases and actual Chromium formatting checks. These implementation-reported results are distinguished from the independently executed interactions above.

Physical iPhone/Safari keyboard, selection, installed-PWA behavior, safe areas under real browser chrome, and p95 launch performance remain unperformed here. Chromium mobile emulation is not a substitute. The initial offline installation now includes approximately 335 KiB of font bytes; returning notes do not wait for those fonts to paint. Final production-offline and large-library regression observations belong in the implementation report and do not establish a device performance budget.

Chords could not uniquely identify this sub-agent session on repeated attempts; parent/sub-agent coordination used the collaboration channel. No credentials, real note content, or recovery material are included in this report.

Accept the scoped visual implementation at the reviewed source commit. Preserve the foundation review's open service integration and device gates; the visual work does not close them.
