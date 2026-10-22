# Settings and account — independent review, round 3

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22 (the first attempt failed with "Selected model is at capacity" and was resubmitted unchanged). Reviewed the response commit `65e39d6..122fc59` and the whole range `86bb0b6..122fc59` on `feat/notes-settings-account`. Report recorded verbatim below; responses are in `notes-settings-account-implementation.md`.

---

CHANGES NEEDED

1. **R3-1 — blocking: Update can reload with unjournaled typing in a blocked channel.** [App.tsx:807](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/App.tsx:807) assumes closing the channel hands its pending edits to storage. However, [channel.ts:349](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/channel.ts:349) skips journaling when blocked. A server `invalid` or `too_large` response can block it before its journal timer fires.

   **Evidence:** an additional in-memory test using real `NoteChannel`, `NotesStore`, and `updateApp` performed typing → `too_large` → update. The outcome was `updating`, reload was called once, and no recovery draft existed.

   **Fix:** refuse the update and retain the mounted editor when channel durability cannot be established, including blocked channels. Closing alone must not count as proof that typing reached storage.

2. **R3-2 — blocking: Closing an uncreated collaborative note strands its work.** The unconditional close at [App.tsx:808](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/App.tsx:808) stores a journal with `created: false` and `baseRevision: 0`. That journal is excluded from background creation by [cache.ts:1524](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/cache.ts:1524). Its summary lacks an owner role, so [App.tsx:544](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/App.tsx:544) reopens it as a cached, read-only note. A late creation response is ignored after closure at [channel.ts:183](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/channel.ts:183).

   **Evidence:** a browser probe held the creation response, typed into the real editor, and invoked App’s actual readiness callback. Readiness returned true; background creation excluded the journal; reopening displayed the text with `contenteditable="false"` and “Cached copy — read only.” This happens before activation, so an update that subsequently fails also strands the note.

   **Fix:** defer updating while a collaborative note lacks its server ID, preserving its editor and creation attempt. Supporting reload during creation requires a separately reviewed recovery contract.

3. **R3-3 — should fix: Reactive device pagination duplicates and omits sessions.** [panels.tsx:1148](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/panels.tsx:1148) uses the standard hook, while [devices.ts:105](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes-backend/convex/devices.ts:105) forwards only cursor and count, dropping page bounds; its return also drops split metadata. The component-backed pages therefore lack stable boundaries.

   **Evidence:** additional `convex-test` probes loaded two pages and re-executed their original arguments after mutations. Deleting a first-page session produced one duplicate across pages. Inserting a session omitted one previously visible, still-live session from both pages. These affect device visibility, React keys, and displayed counts.

   **Fix:** implement component-aware reactive pagination with preserved `endCursor` bounds and split metadata, using the corresponding client hook. Convex documents this requirement in its [component pagination guidance](https://docs.convex.dev/components/authoring#pagination). Add deletion and insertion regressions across loaded pages.

4. **R3-4 — should fix: Superseded waiting builds accumulate without a bound.** [offline-plugin.ts:76](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/offline-plugin.ts:76) skips all cleanup whenever any build waits. Replacing that waiting worker does not remove its obsolete cache.

   **Evidence:** executing the generated workers against simulated CacheStorage with one continuously open window and twelve successive waiting builds retained thirteen complete shell caches, despite navigation between installs.

   **Fix:** distinguish caches needed by active windows and the current installing/waiting workers from superseded builds, and prune the latter without requiring activation.

5. **R3-5 — should fix: An inflight remote deep link still ejects the person from Settings.** The guard at [App.tsx:396](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/App.tsx:396) prevents new retries. It does not fence an existing `openRemote`: after fetching, [App.tsx:501](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/App.tsx:501) calls `selectNote`, which switches to Notes.

   **Evidence:** a browser probe held a remote deep-link fetch, navigated to About, then released the fetch. Settings disappeared and the remote note appeared while the address remained `/settings/about`.

   **Fix:** fence remote-open completion against subsequent navigation and defer presentation until Notes is active again.

Validation: both typechecks passed; 103 backend tests, 20 session tests, 111 app unit tests, and 50 Chromium browser tests passed, with four browser skips. Additional probes used local fixtures, mocked transport/workers/storage, and in-memory test extensions. Cached startup deep links worked; a quota-failed ordinary local draft correctly blocked updating and reopened editable with its latest text. No production services or real iPhone checks. Worktree remains clean at `122fc59`.

- **R2-1 — Not resolved:** ordinary journal flushing improved, but R3-1 still permits reload with unstored typing; R3-2 introduces stranded work.
- **R2-2 — Resolved:** installing/waiting caches survive navigation; separate cache-growth regression is R3-4.
- **R2-3 — Not resolved:** account indexing and static continuation work, but reactive pagination still omits devices: R3-3.
- **R2-4 — Not resolved:** the retry regression passes, but inflight remote completion still violates navigation: R3-5.
- **R2-5 — Resolved:** executing the actual loop with mocks confirmed success only on `done`; 200 unfinished batches produce an explicit incomplete notice.
