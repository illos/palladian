# 08 — Deltos feature port

Status: **proposed 2026-10-22**; its three open questions were settled the same day by owner decisions D102–D104. On 2026-10-22 the owner asked for a plan to bring over the Deltos UI features Palladian never received: file notes, swipe actions, interactions, a Settings pane that works, and account management inside Settings rather than a small menu. The working core is not to be re-engineered. This document orders that work. The owner's answers to its open questions are under [Owner decisions](#owner-decisions).

Survey basis:

- the Deltos client at `/srv/presidium/projects/deltos/code/packages/client/src` (read-only), its `docs/feature-map.md`, its specs and its brain entries;
- Palladian `main` at `651893c`;
- the fixture build viewed at a 430 × 932 phone viewport.

Deltos paths below are relative to that client `src/`.

## Ground rules

- **Fundamentals stay as they are.** Do not change:
  - the fences, epochs, clear lifecycle and draft journal in `cache.ts`;
  - library sync, access checks and recovery in `live.ts`;
  - `channel.ts`, `binding.ts`, `session.ts` and `logout.ts`;
  - the session wiring in `main.tsx`;
  - `selectNote`, `makeChannel`, `accessLost` and `openRemote` in `App.tsx`.

  New UI calls existing Convex functions from lazy panels, or through thin `LiveController` wrappers in the style of `live.trash`.

- **Track A changes almost no cached data.** The cache does not keep `createdAt`, `trashedAt` or `creatorId`. Screens that need them read them live (`notes.get`, a Trash-view query). The two exceptions are both in A6 and both reviewed: cached summaries keep `createdAt` for the Date created sort, and one account-scoped store holds pins and orders.
- **Port behaviour, not code.** Deltos code sits on its own sync engine, spine model, Dexie store and Deck. Reuse its algorithms, gesture constants and copy; rewrite the bindings. Port Deltos's fixes, not its known defects, which are listed per item.
- **Protected areas need review.** Authentication and session lifecycle, authorization, collaborative persistence, agent scopes and file access get independent review before acceptance, as in [07](07-delivery-plan.md).
- **iPhone evidence.** Gesture, keyboard and file-picker items are accepted only after a check on the owner's iPhone. Chromium mobile emulation is not evidence of touch feel or iOS keyboard behaviour.

## Where Palladian stands

| Area                  | Today                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Note list             | Plain buttons: title, smart date, preview, draft/Trash/shared badges. No swipe, context menu or long press                                                                                                     |
| Note actions          | Open-note toolbar only: Share, Move (owner), Trash/Restore, and Delete forever (in Trash)                                                                                                                      |
| Settings              | Appearance, Connected agents and Account tabs. On phones only Appearance is reachable (bug 1)                                                                                                                  |
| Account               | Account tab: name, Trash retention, passkeys, reset email, pending invitations and Sign out. A second Sign out and Retry live in the collapsible "Connection" menu under the note list                         |
| Editor                | Headings 1–3, bold/italic/strike/code, lists, checklists, quote, code block, toolbar, Markdown shortcuts, undo                                                                                                 |
| Server without app UI | Note history (`history.list/read/restore`), default notebook (`notebooks.setDefault`), Better Auth session list/revoke, agent rename/disable (`connections.updateAgent`), public page read (`publishing.read`) |
| Not in the backend    | Files, collections, location, notebook deletion, bulk empty Trash, account deletion, activity log                                                                                                              |

## Bugs found during the survey

Fix these first. They ride with A1 and A3.

| #   | Bug                                                                                                                                                                                                            | Where                                     | Fix                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------- |
| 1   | Settings tabs are unreachable on phones. The rail sits inside `.library`, which is hidden below 760 px in the settings view. Phones see only Appearance, though the passkey offer points to Settings → Account | `App.tsx` settings rail; `styles.css:631` | A1 shell                         |
| 2   | The italic shortcut deletes the preceding character: typing `a *b*` gives `ab`. The rule's match includes that character, and `markRule` replaces the whole match                                              | `editor.tsx` italic rule and `markRule`   | Replace only the delimited range |
| 3   | Enter on a checked checklist item creates another checked item, because `splitListItem(task_item)` copies `checked`                                                                                            | `editor.tsx` Enter chain                  | Split with `{ checked: false }`  |
| 4   | The phone formatting bar is fixed to the layout-viewport bottom with no keyboard handling, so the iOS keyboard is expected to cover it (confirm on the iPhone)                                                 | `styles.css` `.mobile-editor-tools`       | A3 keyboard placement            |
| 5   | Agent Disconnect revokes immediately, with no confirmation                                                                                                                                                     | `panels.tsx` `AgentsPanel`                | Inline confirm, as Deltos did    |
| 6   | Sign out in the Account tab has no error handling (the footer copy does)                                                                                                                                       | `panels.tsx` `AccountPanel`               | Share one sign-out action        |

## Track A — UI over existing services

Track A needs no backend schema change except notebook deletion (A5).

### A1. Settings and account (S–M)

Implemented 2026-10-22 with bugs 1–6 and accepted after independent review (`docs/reviews/notes-settings-account-implementation.md`); Update now is deferred (below).

Deltos reference: `routes/settings/*`, `SettingsRail.tsx`, `SettingsRoute.tsx`, `SettingsPane.tsx`, `SessionsSection.tsx`, `AboutTab.tsx`, `lib/forceUpdate.ts`; ROAD-0009 and DEC-0002.

**Shell**

- `/settings` and `/settings/<tab>` are real history entries, so Back and deep links work. The Worker's single-page fallback already serves these paths.
- Desktop keeps the rail in the middle pane.
- Phones get Deltos's grouped list with chevrons. It pushes a tab screen with "‹ Settings".
- Tabs that need the server show their rows with "Connect to change" instead of a disabled tab.

**Tabs**

- **Account**
  - Name and email.
  - **Default notebook** (UI over `notebooks.setDefault`).
  - Trash retention and pending invitations (existing).
  - Connection status with Retry, moved from the list footer.
  - Sign out behind a confirmation. The existing unsaved-draft dialog in `logout.ts` still decides what happens to pending work.
- **Security & devices**
  - Passkeys (existing), plus rename through Better Auth's passkey update route.
  - Password-reset email (existing).
  - **Devices:** list sessions with device label and sign-in date; sign out one device; sign out all other devices. These use Better Auth's existing session routes.
  - Revocation is session lifecycle, so it needs review. D85 says a revoked device clears its cached notes once it learns of the revocation. That wipe exists only on the unshipped `feat/notes-device-wipe` branch (review findings G1–G3). Until that lands, revoking a device signs it out and leaves its cache, the same as D98's first release.
  - Change password while signed in is not included. Better Auth's `/change-password` bypasses `resetEpoch` and the agent-disconnect choice in `passwords.reset`, so the email link stays unless the owner wants a reviewed backend wrapper.
- **Connected agents**
  - Existing panel.
  - Add a confirmation on Disconnect, and agent rename and disable (`connections.updateAgent` already accepts both).
- **Appearance**: unchanged.
- **About**
  - Version and build time, injected at build time.
  - **Update now** is deferred to its own task (2026-10-22). A reload is safe only once the editor channel and recovery journal can prove that all typing is stored, including blocked channels and notes not yet created on the server; review found that closing the note does not prove it. Meanwhile About explains that a new version starts once every window is closed. See `docs/reviews/notes-settings-account-implementation.md`, round 3.

**Footer.** Remove the collapsible "Connection" menu. The footer keeps its one-line status; tapping it opens Settings → Account.

**Not ported**

- Recovery phrase, two-factor auth, Turnstile and username sign-in: replaced by email and passkeys (D96).
- Manual agent tokens: OAuth only (D93). Per-agent notebook access already exceeds Deltos's scope picker.
- Account-wide routing guide: notebook descriptions replace it.
- Activity feed: no backend.
- Diagnostics snapshot: needs a privacy review before it exports cached note data.

**Acceptance**

- Every tab is reachable at 390 px and on the iPhone.
- Back goes from a tab to the Settings list, then to the notes.
- A revoked device is signed out on its next request.
- The account e2e (`apps/notes/scripts/auth-e2e.mjs`) still passes.

### A2. Note list interactions and note actions (M)

Implemented 2026-10-22 without backend changes and accepted after five independent review rounds (`docs/reviews/notes-note-actions-implementation.md`); per-row Trash countdowns wait for A6's summary change, History for A4 and Pin for A6.

Deltos reference: `components/SwipeRow.tsx`, `lib/useDragAxis.ts`, `components/NavSheet.tsx`, `NotebookPickerSheet.tsx`, `ToastHost.tsx` and `lib/toastEvents.ts`, `routes/TrashRoute.tsx`, `components/InfoPanel.tsx`, `lib/exportNote.ts`, `components/NoteMetaBar.tsx`; specs `swipe-actions-note-list.md` and `swipe-actions-acceptance-matrix.md`; ROAD-0013.

**One action registry.** Four surfaces use it: swipe, the desktop row menu (right-click and a hover "…"), a touch long-press sheet, and the open note's "…" menu.

- Actions: Pin/Unpin (A6), Duplicate, Move…, Share…, History, Info, Export, Move to Trash. In Trash: Restore and Delete forever.
- Each action declares the role it needs (owner or delegated, edit, or any) and whether it needs the server. Unavailable actions are hidden.
- Deltos had no desktop path to pin or duplicate, and no long-press menu. This closes both gaps.

**Swipe rows (touch only)**

Constants from Deltos:

- 8 px slop with dominant-axis lock;
- rests open at ±55 px and commits a full swipe at ±200 px;
- travel clamped to ±240 px, with a 320 ms snap;
- one row open at a time, with a tap-to-close overlay;
- `touch-action: pan-y` on the row.

Layout:

| View            | Right swipe                                        | Left swipe                                                        |
| --------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| Ordinary rows   | Rests on Duplicate. Full swipe pins or unpins (A6) | Rests on Move and Share. Full swipe moves to Trash, with Undo     |
| Trash           | Rests on Restore                                   | Rests on Delete forever, which confirms (owner or delegated only) |
| Read-only notes | Rests on Duplicate. Full swipe pins or unpins      | No actions                                                        |

Deltos defects not to repeat:

- The full-swipe action is invisible until release. Show it under the row as it passes the threshold.
- Release is decided by distance only. Also accept a fling over 0.4 px/ms, as Deltos's nav sheet does.
- A note listed twice shares one open state.

There are no haptics: iOS web has none.

**Navigation sheet.** Palladian's phone navigation `<dialog>` gets Deltos's drag behaviour:

- drag up from the bottom bar to open, down to close;
- 50 % snap or the same fling rule;
- close on backdrop `click`, not `pointerdown` (GOTCHA-0018).

**Toasts.** A small host: 4.5 s, one action button, and ×.

- Moving to Trash offers Undo, which restores.
- Duplicate offers Open.

**Duplicate.** A new `live.duplicate(noteId)`:

- reads the cached body, or fetches it;
- calls `notes.create` with a fresh client key, into the same notebook if the user can edit there, otherwise the default notebook;
- copies text only; history, sharing overrides and public links stay with the original;
- keeps the title unchanged, as Deltos did;
- needs a connection.

**Move.** The existing panel stays, including the move-preview warning about lost access. On phones it becomes a sheet listing notebooks, with the current one marked and disabled.

**Trash view**

- Per-row Restore and Delete forever.
- **Empty Trash** for the owner's trashed notes, looping over `lifecycle.deleteForever` with progress. If that is too slow, a bulk mutation is a reviewed backend item.
- "Deletes in N days" comes from `trashedAt` and the owner's retention, through a live query in that view.

**Info sheet**

- Created, edited, notebook, owner and creator (D15), words and characters, revision, and a sharing summary (private, shared or public).
- Reads `notes.get` live; word counts come from the local body.

**Export**

- Markdown download from the local document (`docToMarkdown`).
- Print / Save as PDF through the print sheet, with Deltos's warning that iOS standalone apps cannot print.
- Attachment references export as named placeholders, not Deltos's dead `blob:` links (spec 02 requires explicit fallbacks).

**Open-note toolbar.** Desktop keeps visible Share, History, Info and Trash buttons, plus "…" for the rest. Phones get "…", which opens the same action sheet.

**Rows**

- A notebook-name pill in All Notes, as in Deltos.
- A shared or public glyph.
- On desktop, a row can be dragged onto a sidebar notebook to move it, with the same preview and warning.

**New-note check.** Deltos discarded a new note left blank. Check what Palladian leaves behind. If it keeps an empty draft or note, the fix belongs in the draft journal (fundamentals): raise it rather than working around it.

**Acceptance**

- Every action works from swipe, the row menu, long press and the open note, and respects the user's role.
- Undo restores the note.
- Playwright touch emulation covers the gestures, then an iPhone feel check.

### A3. Editor interactions (M)

Deltos reference: `editor/keymap.ts`, `commands.ts`, `inputRules.ts`, `autolink.ts`, `markdownPaste.ts`, `clipboard.ts`, `DesktopLinkForm.tsx`, `LinkEntryBar.tsx`, `slashPalette/*`, `MobileEditorBar.tsx`, `ProseMirrorEditor.tsx`; spec `ui-lanes34-editor-toolbars-markdown.md`.

None of this changes the shared schema in `packages/notes-core`.

**Keys and shortcuts**

- Fix bugs 2–4.
- Shift-Enter inserts a line break.
- Backspace right after a Markdown shortcut restores the typed text (`undoInputRule`).
- `---` and a toolbar Divider insert the existing `horizontal_rule` node.
- Add Mod-Alt-1…3 (headings), Mod-Alt-C (code block) and Mod-Shift-. (quote).
- Keep Mod-E for inline code and add Mod-\` as Deltos's alias.

**Block styles and lists**

- Tapping an active style button again returns the block to body text.
- Bullet, numbered and checklist convert exclusively across multi-block selections. This ports `applyListType`, adapted to Palladian's nestable `task_list`.
- Enter on an empty list item leaves the list. Confirm this already works.

**Links**

- Mod-K and a toolbar Link button open one form, with text and URL fields. Enter applies; Escape cancels.
- `isSafeHref` validates the URL, and bare domains get `https://`.
- In an editable note, tapping a link shows Open, Edit and Remove. In a read-only note it opens directly.
- Autolink on Space and Enter, using Deltos's TLD allowlist. Backspace at a link's end removes the link. Never inside code.

**Clipboard**

- Plain-text Markdown pastes as structure, using `parseMarkdownFragment` from notes-core.
- HTML paste is sanitized before parsing: drop script and style elements, `on*` attributes and inline styles.
- Copy puts Markdown on the plain-text clipboard, using `blockToMarkdown`.

**Focus**

- An empty note shows a "Title" placeholder on the first line without inserting text (D80).
- Opening a non-empty editable note puts the caret at the end.
- Tapping the blank area below the text focuses the end.

**Keyboard placement**

- Keep the phone formatting bar above the iOS keyboard. Either position it with `visualViewport`, or follow Deltos and move the bar to the top while the keyboard is open (ROAD-0008: Safari's bottom URL bar fights a bottom bar). Choose on the iPhone.
- Prevent focus zoom with inputs of at least 16 px (GOTCHA-0003), not `maximum-scale=1`, which also blocks pinch zoom.

**Slash palette (desktop)**

- Commands for blocks the schema already has: Title, Heading, Subhead, Body, lists, checklist, quote, code, divider and link.
- File entries join once Track B lands.

**Acceptance**

- An editor test for each shortcut and rule.
- The two-client collaboration test still passes; every change here is a local command.
- An iPhone check of the keyboard bar, selection and link popover.

### A4. History (M)

Deltos reference: `components/HistoryPanel.tsx`, for the UI only. Deltos kept per-device snapshots; Palladian has server revisions, so `lib/historyCapture.ts` does not port.

- **Access.** A History sheet in the note actions, shown only with edit access (D13). Read-only members and public visitors never see it.
- **List.** `history.list` groups: actor and kind, time range, and an agent badge. Paged with `nextBefore`.
- **Version view.**
  - Selecting a version renders `history.read` read-only.
  - A diff toggle compares it with the previous version or the current one. This ports Deltos's character diff over plain text.
- **Restore.** "Restore this version" confirms, then calls `history.restore` with `expectedRevision`. Restore appends a revision; open editors receive it through collaboration.
- **Acceptance**
  - Restore works while another client is editing.
  - A read-only member never reaches history.

### A5. Notebooks (S, one backend item)

Deltos reference: `views/NavContent.tsx`, `components/NotebookMenuBody.tsx`, `ContextMenuSheet.tsx`, `NotebookMenuPopover.tsx`.

- **Notebook menu.** Opened from a hover "…" on desktop, or from long press and the notebook header's "…" on phones. Items:
  - rename and description;
  - sharing and members (the existing `NotebookPanel`);
  - set as default;
  - new note here;
  - delete.
- **Counts.** Note counts per notebook in the sidebar, from cached rows.
- **Notebook deletion needs a new owner-only mutation.**
  - The dialog offers to move the N notes to another notebook or to Trash. It warns when members would lose access (move preview).
  - It then removes memberships and invitations.
  - The default notebook cannot be deleted until another is chosen.
  - This is an authorization change, so it is reviewed.
- **Not ported:** Deltos sorted notebooks by name with no reordering; Palladian already matches.

### A6. Pinning and sort orders (M, small backend)

Owner decision D102 brings both back. Deltos reference: `lib/noteSort.ts`, `db/mutate.ts` (pin), `components/NotebookMenuBody.tsx` (Sort), `lib/dnd/customReorderImpl.tsx`, `lib/customOrderReorder.ts`; ROAD-0019; GOTCHA-0035 to GOTCHA-0038.

**Pins**

- Pin and Unpin are in the action registry (A2). A full right swipe toggles the pin and shows "Pinned" or "Unpinned".
- Pinned notes list first, newest pin on top, followed by the list's chosen order. Pinned rows show a pin glyph.
- Trash ignores pins. A restored note keeps its pin.
- Proposed: pins are personal. Pinning a shared note does not pin it for other members, and read-only members can pin.

**Sort orders**

- Each list has its own order: All Notes and every notebook. The choices are:
  - Last edited, the default (D45);
  - Alphabetical, by display title, case-insensitive, with ties broken by last edited;
  - Date created, newest first;
  - Custom, by dragging.
- The order is chosen from a "…" in the list header (and the notebook menu, A5), with a ✓ on the current one. Deltos could not save a sort for All Notes; Palladian can.
- Trash keeps its current order.
- Proposed: orders are personal too, so a member can arrange a shared notebook without changing anyone else's view.

**Custom order**

- On touch, a long press that moves starts a drag (250 ms hold, 5 px tolerance). A long press released in place opens the action sheet (A2). Mouse dragging uses Deltos's delay and distance constants.
- Horizontal swipes still work, because a swipe locks to the horizontal axis first.
- A cancelled drag never writes. A drop in a gap uses the projected index (GOTCHA-0038).
- Each drop writes one fractional position.
- Notes without a position, whether new or moved in from another notebook, appear at the top. Deltos put them last and never cleared a moved note's old position.

**Storage**

- New per-user Convex tables:
  - pins: user, note, pinned time;
  - list orders: user, list, order;
  - custom positions: user, notebook, note, position.
- Writes require read access to the note or notebook. A query that returns these rows returns only notes the user can still read.
- The app caches the user's rows in one new account-scoped store. Adding it to the account clear in `cache.ts` (`deleteAccountData`) is the only change there; it is reviewed.
- Date created needs `createdAt` in cached summaries. The library feed already sends it, and `toRemote` in `live.ts` drops it. Summaries cached before the change sort by last edited until the feed resends them.
- Agents: MCP `list_notes` keeps last-edited order. Pins and personal orders are not exposed to agents in this pass.

**Deltos data.** Imported notes lost their Deltos pins and custom positions. With the owner's go-ahead, the B5 operator job can re-apply them from the Deltos database.

**Acceptance**

- Pins and orders survive reload and reach the owner's other devices.
- A collaborator's list is unaffected by the owner's pins and orders.
- On the iPhone, custom drag does not fight scrolling, swiping or long press.
- Sorting 2,000 cached notes does not slow the list's first display.

## Track B — Files

Files need backend work first, and the backend part is a protected area.

Deltos reference:

- specs `file-notes.md`, `pdf-reader.md` and `direct-r2-upload.md`;
- Worker `routes/blob.ts` and `blobStore.ts`;
- client `plugins/attachment/*`, `views/FileNoteView.tsx`, `views/pdf/*`, `lib/uploadStore.ts`, `components/UploadProgressHost.tsx`, `components/Lightbox.tsx`;
- brain entries CONV-0007, DEC-0001, DEC-0008, GOTCHA-0006 and GOTCHA-0007.

The owner's 27 imported file notes and 32 attachment placeholders are waiting on this track (D101).

### B1. Storage and access (L, protected)

**Objects**

- A private R2 bucket bound to the `palladian` Worker.
- A Convex `objects` table: owner, uploader, name, MIME type, size, SHA-256, state (pending, ready or failed), `trashedAt` and `createdAt`.
- Keyed by object ID, not Deltos's `{account}/{hash}`, so objects in shared notebooks cannot collide (Q11).

**Upload**

- The app asks Convex for an upload ticket. Granting one requires edit access to the target note or notebook.
- The Worker accepts the bytes (25 MB at first), checks size and hash, writes R2 and finalizes the object in Convex.
- Retrying with the same ticket never duplicates an object (spec 02).

**Read**

- The Worker serves bytes after Convex confirms the caller can read a note referencing the object.
- Only PNG, JPEG, GIF and WebP are served inline. Everything else is a download with `nosniff` and a locked-down CSP, as in Deltos.
- Public links serve only objects referenced by the published content.

**Lifecycle (D36–D42)**

- Each accepted revision records which objects the current document references.
- An object enters Trash when its last active reference goes. Moving a note to Trash also trashes the objects only it uses.
- Restoring a note or revision revives still-trashed objects.
- Objects are purged under Trash retention. A purged object shows an "attachment permanently deleted" placeholder.

**Device and agents**

- Sign-out clears the attachment cache (D28). There are no offline downloads (D84).
- MCP gains an attach-file tool (spec 05).

### B2. Schema (S, reviewed with notes-core)

- **Images** use the existing `image` node with `attachment:<objectId>`, plus an optional `width` attribute for resizing.
- **Other files** use a new `file` block node: object ID, name, MIME type and size. In Markdown it is a link with an `attachment:` URL and its filename as the label, so MCP reads stay meaningful.
- **Upload placeholders** are editor decorations, not document nodes, so collaborators never see half-uploaded blocks. The node is inserted at the mapped position once the object is ready.

### B3. Inline attachments (M)

**Inserting**

- A toolbar "+ File" button opens a file picker without `capture` or `accept`, which keeps iOS's Scan Documents option (Deltos DEC-0008).
- Paste and drop also insert files.

**Upload states**

- A progress widget with Cancel.
- A failed upload keeps Retry and Remove, not Deltos's dead chip.

**Display**

- Images show at natural size up to the column width.
- A corner drag resizes an image and saves `width`; double-click resets it.
- Tapping an image opens a lightbox that closes with Escape, the backdrop or ×.
- Other files show as a chip with icon, name and size. Tapping downloads the file; a PDF opens the reader.

**Cache.** Bytes are cached per account in IndexedDB with oldest-first eviction (Deltos CONV-0007). They are cleared with the account at sign-out.

### B4. File notes and the PDF reader (M)

Owner decision D103 adopts this model.

**Model**

- No new note kind. Uploading from the note list creates an ordinary note: the first line is the filename and the next block is the file. Upload entry points are a phone "Upload" in the bottom bar and a desktop drop on the list.
- When a note is just that title line, one file block and optional text, the note view shows the file large:
  - an image fitted to the width;
  - a PDF in the reader;
  - any other type as a large icon with Download.
- Renaming means editing the first line.
- The note stays editable below the file, so notes about the file stay with it.

**PDF reader.** Port `views/pdf/*`:

- pdf.js loaded lazily, with scripting and eval off;
- virtualized pages and a thumbnail rail;
- page jump, in-document search and text selection;
- a "Download to view" fallback.

It opens inline in a file note, and full screen from an inline PDF chip.

**List rows.** File notes show a thumbnail or type icon plus a type and size label, for example "PDF · 2.4 MB".

### B5. Deltos file bytes (S, operator job)

D101 already approves bringing the bytes over once files exist.

- For each imported placeholder, read the Deltos database to map its block ID to a hash, copy the object from Deltos's R2 bucket, and finalize it in Palladian.
- Replace each "📎 name (file to be added)" paragraph with an image or file node that keeps the block ID.
- File notes keep their extracted text.
- Do a dry run first, and write a verification report like the note import's.

### B6. Later

Not in this plan's first pass:

- uploads over 25 MB through presigned direct upload, with progress cards;
- HEIC and thumbnail previews;
- PDF and image text extraction into search, with "p. N" links (Deltos ROAD-0014);
- a PWA share target (Deltos never had one);
- link cards.

## Track C — Collections (L, backend)

Palladian's confirmed collections are personal saved queries (D17–D19, D59, D60), not Deltos's hand-picked member lists. Deltos's "Collect" swipe therefore has no equivalent.

- **Data.** A per-user `collections` table holding name, icon and query: text, title, notebook, created and edited ranges, and location once it exists.
- **UI.** A sidebar section and a query-builder sheet.
- **Results.** Evaluated immediately against cached metadata, then completed by the server, with the scope labelled (spec 02).
- **Agents.** Visible to MCP in the user's context.
- **Import.** The five imported Deltos notes with Collection values get an equivalent query (Q15).
- **Prerequisite.** Q05 must settle operators and date boundaries first.

Start after Track A.

## Not ported

| Deltos feature                                                                                                     | Reason                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Separate title node                                                                                                | First-line title is confirmed (D46, D80)                   |
| Conflict view (mine / theirs / both)                                                                               | Palladian keeps conflict copies (spec 04)                  |
| Per-device history snapshots                                                                                       | Server revisions replace them (A4)                         |
| Recovery phrase, TOTP, username sign-in                                                                            | Email and passkeys (D96)                                   |
| Manual agent tokens and the token generator                                                                        | OAuth only (D93)                                           |
| Agent approval sheet and alert banner                                                                              | Built on a Deltos alert feed with no Palladian counterpart |
| Activity / audit feed                                                                                              | No backend. A separate decision if wanted                  |
| Legacy bottom nav, drawer nav, probe routes                                                                        | Dead or experimental in Deltos                             |
| Board view, Deck keypad, voice dictation, own spellcheck, formulas, link cards, underline, highlight, headings 4–6 | Skipped for now (D104)                                     |

## Owner decisions

Recorded 2026-10-22 in [document 06](06-decisions-and-acceptance.md):

- **D102:** pinning and alternate sort orders return as in Deltos, superseding D47 and D45's deferral. See A6.
- **D103:** a file note is an ordinary note: its first line is the filename and its next block is the file, shown large. See B4.
- **D104:** the Deck keypad, voice dictation, Deltos's own spellcheck, formulas, link cards, the Board view and the underline and highlight marks are skipped for now.

## Order and parallelism

1. **A1 with bugs 1, 5 and 6.** This addresses the owner's Settings complaint and the unreachable phone tabs.
2. **A2 with A6, then A3 and A4.** A6's full right swipe and long press share A2's gesture code. A3 (`editor.tsx`) and A4 (a history panel) can run in separate worktrees.
3. **B1–B2 alongside A2,** in their own worktree; they touch the backend, Worker and notes-core. B3–B5 follow B1's review.
4. **A5, then C.**

Each item gets:

- its own branch and worktree;
- an implementation report under `docs/reviews/`;
- independent review where protected (A1 devices, A5 deletion, A6 storage and cache changes, B1, B2);
- deployment under D94;
- the owner's iPhone check for gesture and keyboard items.

## Verification approach

- **Fixture mode** (`?fixture=seed`) for list, sheet and gesture layout.
- **Playwright `notes-mobile-chromium`** with touch emulation for swipe thresholds and the action registry.
- **Real-service e2e** against the dev Convex deployment for duplicate, Trash, history restore, devices and uploads.
- **The owner's iPhone** for swipe and long-press feel, the keyboard bar, the file picker and Scan Documents, and the PDF reader.
