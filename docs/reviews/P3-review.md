# P3 independent review

Status: design review in progress; implementation and actual-service acceptance pending. P2 was accepted separately at `57c4fe0`, pinning implementation `a15c488`. This report does not approve a P3 runtime or private-file adoption.

Reviewer: `p1_redteam`, independent of the backend and host implementations. The parent owns uploader/search/export UI and real R2 integration including the 100 MiB boundary. This reviewer owns independent authorization, source freshness and reference/lifecycle tests. Development fixtures and the explicitly authorized test bucket are the only intended data targets. Production, real content, DNS and old infrastructure remain outside scope.

## Storage design review

The reviewed design separates the browser's staging upload key from a unique server-only ready candidate. Each finalize attempt persists its generation and new candidate key before external copy. It uses a conditional source copy, verifies the candidate's actual bytes, and transactionally adopts only the still-current generation under live authorization. Retries of already-ready records return the existing result without another copy. Keys are never reused. Ambiguous or timed-out copy attempts are abandoned, never optimistically adopted; the proposed SDK copy configuration uses `maxAttempts: 1`.

This design prevents an old browser upload grant from changing the adopted ready object. Stale finalize attempts can create only their own abandoned candidate, which must remain tracked for cleanup. Grant expiry alone cannot prove that a PUT initiated before expiry has completed. Therefore persistent staging/abandoned-candidate tombstones and bounded recurring reconciliation are required to catch late external completion. Logical deletion denies access immediately; the system must describe physical orphan cleanup as eventual and observable, not as a permanent absence guarantee after one delete.

Ready adoption requires positive completion of the awaited copy and actual candidate verification, followed by a live scope/generation/lifecycle check in the final transaction. There must be no detached copy promises, generic caller-selected object keys, public generic storage endpoints, reattachment to deleting files, or cleanup of referenced/currently finalizing objects. Reference changes and deletion claims require actual parent checks and transactional state changes. Cleanup must be indexed, bounded, retryable and safe after repeated invocation.

The reviewer independently checked the official current R2 matrix on 2026-09-10: conditional PUT, conditional GET and source-conditional CopyObject are documented. CopyObject's checksum-algorithm header and full-object SHA-256 support are not documented as available; streaming the candidate's actual bytes through SHA-256 avoids trusting caller metadata or those unsupported features. Actual endpoint enforcement, SDK behavior and maximum-size execution remain required evidence. [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)

The documented Node action execution limit is ten minutes. A real 100 MiB upload/copy/streamed verification test must demonstrate that this implementation fits its actual runtime and memory constraints; documentation alone is insufficient. [Convex execution limits](https://docs.convex.dev/production/state/limits)

## Search and fixture boundary under review

P3 uses actual typed development fixture resources and projection builders before editor integration, as the execution plan requests. Fixture provisioning should be internal/operator-only where possible. Public search, resolution and export must use the same live resource authorization as normal app operations and read actual stored source records. A browser-provided brand, workspace, instance, resource ID or claimed source version is not authority.

The exact fixture schema, API and transition to P4 content tables are still pending review. Any development-only flag must fail closed on the server before fixture disclosure through search, resolution or export. No fabricated Notes/Recipes content success, arbitrary table/function dispatcher or unauthenticated fixture endpoint is acceptable.

Search must scope its index by owner/workspace, revalidate actual live source and parent before emitting a title/snippet, reject stale source versions and older delayed projections, and bound overfetch/pagination. Archive/trash/ownership changes must deny stale projections immediately. Search/export must not require loading an editor bundle. All output is plain text, and links preserve fixed registered resource identity.

## Independent adversarial evidence required

- Enumerate every new public endpoint; use valid generated IDs to prove anonymous, foreign-owner and swapped same-definition parent denials with exact domain errors, rather than accepting transport failures as denial.
- Verify grants, metadata, finalize, download, references and deletion all use live scope and lifecycle; pending/unverified/deleting files never become attachable or downloadable.
- Exercise create/retry/receipt scope, duplicate finalize, old generation completion, failed copy/read/delete, reconciliation, and multiple references. Removing one reference must retain bytes; removing the last may permit lifecycle-controlled deletion.
- Prove hostile filenames and active content are delivered safely, signed URLs remain temporary response capabilities and never stored as app content, and maximum download lifetime stays within policy.
- Exercise stale/missing/trashed/archived/wrong-owner source projections, out-of-order versions, bounded cursor traversal and plain-text escaping against actual typed fixture resources.
- Record actual R2, actual Convex, browsers, mocks and unperformed physical-device tests separately. F01–F06 and S01–S04 remain pending until their evidence is complete.

No P3 backend or host implementation was written by this reviewer. Design approval to implement a bounded candidate does not waive final independent protected-core acceptance.
