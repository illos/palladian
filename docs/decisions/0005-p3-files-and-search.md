# P3 private files and scoped search

Status: implementation design reviewed with the independent reviewer; acceptance awaits actual service evidence. P2 accepted at `57c4fe0`.

Convex remains authoritative for resource ownership, file state, references, receipts, and search. One private development R2 bucket holds disposable bytes. No public bucket, application-origin upload serving, production mutation, or R2 secret in browser code is introduced.

## Storage adapter and immutable objects

Use pinned official AWS SDK S3 commands and presigner in an action-only adapter. The current [Convex R2 component source](https://raw.githubusercontent.com/get-convex/r2/main/src/client/index.ts) offers useful generic plumbing, but its upload method has no policy/expiry/conditional-header options, metadata reads use its replicated table, and deletion schedules separate work. Installing it would duplicate the lifecycle below; its generic endpoints are not exposed.

Each file has a server-assigned staging key. Each finalization attempt has a different, permanently unique candidate key persisted before external work. Only a positively completed attempt may adopt its candidate as the ready object. Browser grants never target candidates or ready objects.

Upload grants require a signed `If-None-Match: *`, declared content type and length. Actual browser/R2 evidence must prove omission, alteration, and replay fail, including after finalization. R2's [current compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/) lists these PUT conditions, conditional GET, and CopyObject source ETag conditions as supported. This documentation is a compatibility hypothesis until exercised against the test bucket.

Finalization claims a bounded generation lease, directly checks staging HEAD, performs one awaited CopyObject conditional on that ETag, then checks and streams the candidate with conditional GET. It computes SHA-256 over actual bytes, checks declared length and checksum, and validates supported file signatures. Candidate adoption rechecks generation, lease, live identity, and actual instance/workspace. SDK copy uses one attempt: any timeout or ambiguous result abandons that key; a retry allocates a new candidate. No later operation recopies an adopted key. A stale completion can therefore only create its own unreferenced orphan.

This adds one copy and one full verification read per successful file. Streaming avoids buffering the full file in the action. [Convex currently documents](https://docs.convex.dev/production/state/limits) 512 MiB memory and ten minutes for Node actions. The acceptance suite must exercise the full 100 MiB limit and record timing; documentation alone is not capacity evidence.

## State, references, and reconciliation

Public states are `pending`, `verifying`, `ready`, `deleting`, and `deleted`; bounded failure codes and retry time describe recoverable external failures. Each attempt and object key has persistent cleanup ownership. Scoped request receipts prevent duplicate files and reject changed payloads. Workspace usage reserves declared bytes transactionally before a grant. Pilot defaults are 1 GiB per workspace, ten simultaneous pending files, a 100 MiB file maximum, 900-second upload grants, 300-second download grants, 120-second verification leases, and 24-hour abandoned-upload retention. Constants are adjustable implementation defaults.

Attachment checks a real live registered resource, its actual workspace/instance, and a ready file in exactly that scope. Duplicate references are prevented transactionally. Removing one of several references preserves the bytes; removing the last claims deletion transactionally. Attaching after deletion is claimed fails. Pending cancellation and repeated deletion are idempotent. Active verification leases are not orphan-cleanup candidates.

Ready-byte deletion targets only the adopted immutable key, which no upload or copy may subsequently write. Staging and abandoned candidates have permanent Convex tombstones and bounded indexed recurring reconciliation. Waiting for upload URL expiry does not prove a request begun earlier has ended. A late staging PUT or unresolved copy can create an orphan after an earlier cleanup; tombstones allow another cleanup without ever restoring logical access. External failures retain retry state. No claim is made that the first cleanup permanently removed every possible in-flight orphan. Tombstone retention and recurring checks have ongoing storage/request cost.

Download grants require live resource/file authorization and last at most five minutes. Already-issued URLs remain bearer capabilities until expiry. URLs exist only in action responses and memory, never content, metadata, export, or logs. Download headers force attachment with a sanitized filename; only verified raster images may request preview on the isolated R2 S3 origin. HTML/SVG are rejected, unknown bytes are attachment-only, and content sniffing is not a malware guarantee.

## Resource registry, fixtures, and search

P3 uses separate typed `noteFixtures` and `recipeFixtures`, populated and changed only through operator/internal functions. They are explicit fixtures, not the P4 collaborative Notes or Recipes content model. A default-off server setting gates every fixture resolver, search result, export, and attachment path. Public operations still require actual live identity and parent relationships. Results identify `source: "fixture"`. Future P4 tables have distinct generated IDs and separate fixed source registrations, avoiding identity collisions or a generic caller-selected table dispatcher.

The same registered resource resolver authorizes direct routes, search, export, and file references. Search entries contain compound resource identity, bounded plain title/text, source revision and time. Scoped search-index equality predicates select a workspace and optional instance before live source/lifecycle checks. No stale title or snippet is emitted for an inaccessible, missing, archived, or trashed source. Projection commits reject older source revisions; simple fixture writes update projections transactionally. Delayed-projection tests use internal operations and remain explicitly separate from the P4 five-second collaborative projection target.

Search pages default to twenty and cap at fifty. Each server query reads a bounded candidate page and returns a continuation even when live filtering makes that page short. The host may request at most three extra pages to fill a visible page; it must preserve every valid result and stop rather than scan indefinitely. Empty pages with a continuation are valid. Cursor input, query text, titles, snippets, and projection text are bounded.

The export skeleton emits authorized versioned pages of stable resource targets, current source fields/revisions, and file IDs with verified type, length, and SHA-256. It contains no signed URLs. Joint bytes-plus-data restore remains a later acceptance item.

## Evidence gate

Independent review must verify F01–F06 and S01–S04 using two owners, same-definition instances, real typed fixture sources, actual private R2 upload/HEAD/copy/GET/delete, the full size boundary, signed-header tampering/replay, revoked live sessions, stale projections, multiple references, and bounded pagination. External fault injection exercises real lifecycle code but is reported separately from successful R2 integration. Real Notes/Recipes editor navigation and collaborative search freshness remain P4 work; real iPhone evidence stays pending until performed.
