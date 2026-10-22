# Settings and account — independent review, round 2

Reviewer: GPT-6-Astra (Codex, high reasoning), delegated read-only on 2026-10-22. Reviewed the response commit `9e8830a..65e39d6` and the whole range `86bb0b6..65e39d6` on `feat/notes-settings-account`. Report recorded verbatim below; responses are in `notes-settings-account-implementation.md`.

---

CHANGES NEEDED

1. **R2-1 — blocking: Update readiness still races with typing.** [App.tsx:800](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/App.tsx:800) waits 400 ms, but [cache.ts:831](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/cache.ts:831) cannot see edits awaiting the channel’s journal timer. A local fake-timer test using the actual readiness body and `NoteChannel` inserted text at 350 ms: readiness returned **true at 400 ms with no durable draft**. Separately, a Chromium probe completed readiness, returned to Notes, then caused a quota failure while typing. [update.ts:68](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/update.ts:68) still invoked reload on activation; IndexedDB contained only the earlier text.

   **Fix:** prevent further editing throughout the readiness-to-reload interval, or invalidate readiness on subsequent edits and recheck immediately before reload. Ensure pending editor journals have completed; elapsed time alone is insufficient. Add both timing regressions.

2. **R2-2 — should fix: Navigation deletes a waiting build’s cache.** [offline-plugin.ts:75](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/offline-plugin.ts:75) deletes every shell cache except the active worker’s cache during single-window navigation. This includes an installed, waiting build. Executing the generated workers locally confirmed: A active + B waiting → navigate under A → B’s cache deleted → activate B → B’s assets require network fallback. Successful network fetches do not refill that cache, leaving offline startup broken.

   **Fix:** distinguish retired caches from installing/waiting builds and preserve the latter. Test A-active/B-waiting navigation, subsequent activation, and offline loading. The current-build lookup correctly prefers its own cache; the problem is premature deletion.

3. **R2-3 — should fix: The bounded devices list can hide live devices entirely.** [devices.ts:89](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes-backend/convex/devices.ts:89) combines `userId` and `expiresAt` predicates. The installed adapter requires a matching `[userId, expiresAt]` index; its schema has no such index. It therefore scans the session table, with a 200-row read limit. The response discards the continuation cursor.

   An additional in-memory `convex-test` case created 220 newer sessions for another user. The caller’s list fell from **two devices to only the current device**, with `more: true`. Consequently, the other device cannot be selected, and the UI hides “Sign out all other devices.”

   **Fix:** use indexed, account-scoped pagination and expose continuation through the UI; filter expiry within bounded pages as necessary. Keep bulk revocation available when more sessions exist. Test unrelated-user traffic and large expired-session histories.

4. **R2-4 — should fix: A pending history open can still eject the user from Settings.** [App.tsx:213](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/App.tsx:213) sets `pendingRoute`; the [deep-link effect at line 393](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/App.tsx:393) retries it on library updates, calling `selectNote`, which switches the view to Notes.

   Chromium reproduction: open note → Settings → reload → Notes with its cache read held → reopen Settings → emit a normal cache notification. Settings disappeared while the URL remained `/settings/account`; releasing the reads displayed the note under that Settings URL.

   **Fix:** suspend route-opening retries while Settings is active and fence pending route work against subsequent navigation. Resume reconciliation when returning to Notes without discarding the mounted draft. Add this cache-refresh regression.

5. **R2-5 — should fix: Bulk revocation silently treats its batch limit as completion.** [panels.tsx:1218](/srv/presidium/projects/palladian/code/.worktrees/settings-account/apps/notes/src/panels.tsx:1218) exits successfully after 50 calls even if every response says `done: false`. Executing that loop with a mocked operation requiring 51 batches confirmed normal completion after 50. Large expired-session histories can consume those batches before all live sessions are reached.

   **Fix:** report an explicit incomplete result at the limit and offer continuation. Only finish the confirmation as successful after `done: true`. The backend batching itself makes progress and preserves the initiating session.

Validation: both typechecks passed; 101 backend tests, 20 session tests, 102 app unit tests, and 49 Chromium browser tests passed, with three browser skips. Additional probes used local fixtures, mocked timing/transport/storage, generated-worker simulation, and `convex-test`. No live services, production, deployment, or real iPhone testing. No source edits; worktree remains clean at `65e39d6`.

- **F1 — Resolved.** Boundary containment and conditional mounting address blanking. Local boundary tests preserved surrounding content, requested one authentication retry, and showed generic failures without triggering authentication retries.
- **F2 — Not resolved.** Existing quota failures are detected, but readiness and activation races remain: R2-1.
- **F3 — Not resolved.** Two-window retention works; navigation introduces waiting-cache deletion: R2-2.
- **F4 — Not resolved.** Both original browser cases pass; pending-route retries still violate Settings navigation: R2-4.
- **F5 — Not resolved.** Server operations are bounded, but listing loses devices and client completion can be false: R2-3/R2-5.
- **F6 — Resolved.** Tests authenticate an agent and exercise all three endpoints for anonymous, claimless, expired, and revoked callers, checking session preservation.
