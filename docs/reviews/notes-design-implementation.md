# Notes visual fidelity implementation

Date: 2026-09-30. Source reviewed: `df80091907fea56442e30f91d5d342b632d69654`.

The owner authorized matching Deltos's design for overlapping notes features, including typography and themes, while retaining Palladian branding. Deltos remained read-only reference. This slice is implemented and independently reviewed; it does not complete notes v1 or authorize production deployment.

## Result

The desktop shell follows the reference's 222 px navigation, 300 px note list, full-width rows, selected accent edge, metadata typography, and 680 px reading column. Mobile navigation and the supported formatting controls follow the same visual language. The edited date appears above the note title, below the formatting toolbar. Navigation exposes only supported surfaces rather than adding inactive reference features.

Appearance provides Bone, Graphite, Manila, and Ember palettes; Serif, Sans, Mono, and Grotesk type families; and Light, Dark, and System modes. Graphite/Sans/Light matches Deltos's live default. All 18 font files match the reference byte-for-byte, totaling 343,144 bytes, with licenses and provenance bundled. Fonts use swap rendering and require no external provider.

Device appearance is validated and restored through inline HTML bootstrap before the app module, without an additional blocking request or authentication. Build-owned fonts and bootstrap assets participate in offline-shell versioning. Appearance navigation keeps the current editor mounted so changing settings cannot restore an outdated draft snapshot. Existing schema-supported formatting commands use the reference's toolbar glyphs; no editor schema or persistence contract changed.

No custom keyboard, formulas, document-only notes, placeholder notebooks, or unsupported sharing/trash controls were added. Existing cached notes remain read-only and new drafts remain local pending the live server editor integration. Connection and save feedback remain explicit.

## Verification

| Check                       | Result and boundary                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop and mobile Chromium | 40 passed: 32 foundation regressions and 8 visual/theme/editor regressions. Includes stalled authentication, transient failure continuity, account fences, cross-tab invalidation, recovery, all 48 appearance combinations, same-editor Settings round trips, and nested paragraph sizing. Authentication is simulated in these browser checks. |
| Production offline browser  | 2 passed with a real service worker, browser IndexedDB, production build, and fully disabled networking; synthetic libraries of 1 and 2,000 notes. Cached text, fonts, and shell remain available, including search beyond the first rendered rows.                                                                                              |
| Session controller          | 14 passed with controlled transports; no actual authentication-service rerun for this visual slice.                                                                                                                                                                                                                                              |
| Static/build checks         | Strict application/tool/browser-source TypeScript, production build, repository Prettier check, and whitespace validation passed.                                                                                                                                                                                                                |
| Independent Astra review    | Desktop 1434×752 and mobile 393×852 / 430×852 screenshots inspected; independently exercised draft persistence through Appearance and reload; independently verified font hashes and unchanged protected source. See the [separate report](notes-design-astra-review.md).                                                                        |

Final concurrent production-offline desktop observations were 75.8 ms to the library / 187.8 ms to text for one note, and 153.7 ms / 284.6 ms for 2,000 notes. Earlier isolated runs were faster. These are individual synthetic browser observations, not p95 launch measurements or device performance acceptance.

The change leaves `session.ts`, `cache.ts`, `main.tsx`, and the backend service proof unchanged. Authentication, accepted-cache generation fences, and the lazy editor path retain the foundation contract. The service worker still excludes API responses, authorization-bearing requests, and query-bearing requests.

## Remaining gates

Physical iPhone/Safari, installed-PWA behavior, native keyboard/selection, and device p95 launch performance remain pending. Chromium mobile emulation does not establish those results. The visual review accepts supported-surface fidelity, not pixel identity across omitted features and different content. The foundation's open service-integration and device gates remain open; see [foundation evidence](notes-foundation-implementation.md).
