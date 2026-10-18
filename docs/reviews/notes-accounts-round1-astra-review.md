# Notes accounts — independent review, round 1

Reviewer: GPT-6-Astra (high reasoning), delegated T3 task, 2026-10-18. Scope: commits 3e0c7e1 and 255da75 on `feat/notes-accounts`. Recorded verbatim below; the response is in `notes-accounts-implementation.md`.

Accounts: CHANGES REQUIRED

1. **A1 — blocker — Reset can commit without completing required revocations.** `passwords.ts:43`, `passwords.ts:56`. A valid reset consumes the token and changes the password through separate committed operations. If session deletion subsequently fails, existing sessions survive; if `disconnectAll` fails, agents remain connected despite the explicit disconnect choice. Both failures were reproduced with in-memory fault injection. The consumed link cannot retry completion, and session-deletion failure is misleadingly reported as an expired link. **Fix:** make reset finalization transactional, or implement durable, idempotent completion that fences access until required revocations finish. Add failure-injection tests at both boundaries.

2. **A2 — blocker — A delayed passkey ceremony can replace a newer login.** `SignIn.tsx:108`, `SignIn.tsx:174`. Begin a passkey ceremony for A, complete a newer password login for B, then finish A's browser prompt. The plugin starts verification with a fresh transport guard and stores A's session before `finish()` checks the controller generation. Effect cleanup only sets `active = false`; it does not prevent credential replacement. Reproduced using the installed client plugins with mocked transport and authenticator. **Fix:** preserve one authentication intent across the entire ceremony, cancel superseded ceremonies, and reject stale verification before session storage. Test password-login and cross-tab supersession.

3. **A3 — blocker — Late reset completion can undo a newer logout or login.** `pages.tsx:601`. Submit A's reset, then sign out or sign into B in another tab while the reset response is delayed. Its continuation unconditionally starts a fresh password sign-in for A and calls `retry({ afterSignIn: true })`. There is no intent/generation check before either operation; transport guards therefore treat this stale continuation as a new login. **Fix:** capture and revalidate the authentication intent, including cross-tab changes, before automatic sign-in and session activation. Report completed password recovery without signing in when superseded.

Verification:

- Backend: `npx vitest run` — **51 passed**.
- Worker: `npx vitest run` — **74 passed**.
- App: `pnpm typecheck && pnpm test` — typecheck passed; **20 session + 85 Vitest tests passed**.
- Additional read-only Node probes reproduced A1 and A2; concurrent reset reuse produced one success and one rejection. `settled()` passed concurrent-logout and three early-return cases.
- Compared exported schemas: all **10 existing component tables**, fields and indexes match. Component name is preserved. Removed uniqueness metadata concerns inactive plugin fields; active email/session checks remain.
- Existing tests meaningfully cover ordinary reset and relay behavior, but miss these failure/race cases and negative passkey verification cases.
- No deployment, live-service, inbox, browser or real-iPhone verification performed. Production migration remains unverified independently. Worktree unchanged.
