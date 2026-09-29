# Notes services foundation evidence

Date: 2026-09-29. Disposable local-anonymous Convex proof, loopback cloud port 3218 and HTTP port 3219. Uses Convex 1.45.0, @convex-dev/better-auth 0.12.5, Better Auth 1.6.30 and @convex-dev/prosemirror-sync 0.2.6. Generated APIs/types come from the actual CLI. All subjects and passwords are randomly generated disposable fixtures; no real user data or cloud deployment was used.

## Actual-service evidence

The password/session probe exercises actual HTTP sign-in, session cookies, Convex JWT issuance and protected server queries. Public signup is rejected and anonymous identity queries fail. Five-second fixture JWTs are accepted at approximately 6.5 seconds, then rejected at approximately 71.5 seconds; this bounds observed expiration grace and does not establish its exact configured value. The persisted session then issues a fresh token and the protected query succeeds. Token renewal and session lifetime are distinct.

The sync probe runs two authenticated HTTP clients against the real component. One accepts a ProseMirror step, the other receives `needs-rebase`, maps its step over the accepted operation and submits at the returned revision. Both read the same `ABHello` result. Replaying the first accepted request after the second edit returns its original version and creates no third history entry. Changed payload under that same request ID fails. Anonymous reads fail. Removing editor access prevents replaying an otherwise valid old receipt.

Claim tests exercise server-side affected-paragraph rejection, editor cancellation, durable cancelled status and late-generation rejection. Astra's independent review identified an order-only claim bypass and absent trusted agent classification; both are addressed with regression tests and a server-owned local fixture principal table. A further canonical-root review finding is addressed by requiring the ProseMirror document root and rejecting text-node roots before creation. Exact structural editing scope and actual MCP authentication remain unaccepted.

## Verification and limits

Convex pushes successfully to this disposable backend and strict backend/session-transport TypeScript checks pass. `prove.mjs` is repeatable with the configured backend running and prints assertion outcomes only. No real browser, iPhone, email delivery, production Worker, real MCP client or elapsed long-lived session test is claimed. See the experiment README for remaining scope and conservative structural claim limitations.

This evidence does not authorize replacing the launch cache with an auth-gated screen. Session/token checks must run after cached notes have rendered; transport failures never delete credentials or cached content.
