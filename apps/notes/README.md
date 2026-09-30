# Notes foundation

A runnable cached notes surface and recovery journal, with isolated real-service auth/sync proofs. This is not the complete v1: existing cached notes are read-only, and new drafts are local until the server editor path is integrated.

The supported surfaces follow Deltos's layout, typography, and theme tokens with Palladian branding. Settings → Appearance offers four palettes, four type families, and light/dark/system mode. Appearance is restored before first paint without an authentication request; opening Settings preserves the current draft editor. See the [visual implementation evidence](../../docs/reviews/notes-design-implementation.md) and [independent visual review](../../docs/reviews/notes-design-astra-review.md).

From the repository root, install with the pinned host Node/pnpm baseline, then:

```sh
pnpm install --frozen-lockfile
pnpm --filter @palladian/notes dev
```

Open `http://localhost:5178/?fixture=seed&session=stall` to seed disposable notes and hold authentication pending. Reload with `?fixture=1&session=stall` to use the existing cache without reseeding. Other development fixture states are `transient`, `expired`, `ready`, and `revoked`. The fixture harness is absent from production builds.

For actual local authentication, configure the disposable backend using [its README](../../spikes/notes-services/README.md), then run the frontend with the public endpoint:

```sh
VITE_NOTES_AUTH_SITE_URL=http://127.0.0.1:3219 pnpm --filter @palladian/notes dev
```

A build without that endpoint retains cached viewing and local drafts but cannot connect an account. Do not point a proof at production or real data.

Checks:

```sh
pnpm --filter @palladian/notes typecheck
pnpm --filter @palladian/notes test
pnpm --filter @palladian/notes test:browser --project notes-chromium --project notes-mobile-chromium
pnpm --filter @palladian/notes test:offline
```

The offline test builds production assets and uses a real service worker, browser IndexedDB and fully disabled networking. Its synthetic cache sizes are one and 2,000 small notes. Chromium mobile emulation is not Safari or a physical iPhone.

See [implementation evidence](../../docs/reviews/notes-foundation-implementation.md) and [independent Astra review](../../docs/reviews/notes-foundation-astra-review.md) for tested boundaries and remaining gates.
