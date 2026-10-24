# File notes and the PDF reader (port plan B4)

Date: 2026-10-24; review round 1 responses the same day. Branch `feat/notes-file-notes`, based on `main` at `eacfafd`, which contains B1+B2 (the files backend) and B3 (inline attachments), all released with the files gate off. Plan: [08](../specs/notes-app/08-deltos-feature-port.md), Track B, B4; owner decision D103 adopts its model. B5 (the Deltos bytes) follows.

B4 is client work on B1's protocol and B3's pipeline. **No backend, Worker or notes-core change**, so nothing was pushed to the dev deployment and no backend test was needed. **The fundamentals are untouched**: `cache.ts`, `live.ts`, `channel.ts`, `binding.ts`, `session.ts`, `logout.ts`, `main.tsx` and `pages.tsx` are as on `main`; in `App.tsx`, `selectNote`, `makeChannel`, `accessLost` and `openRemote` are unchanged (`openRemote` is called, as Duplicate's Open calls it). **While files are off, the app looks and behaves as on `main`**: no Upload, no list drop, no row labels, no file-note view, no reader. **Files must still not be turned on** until F4 (provenance for copied attachments) is approved, built and reviewed, and the owner confirms every device runs a build with B3 and B4. B3's other two conditions, R5-1 and R5-2, are fixed here (the reader uses both paths) and need this review. Nothing was deployed.

Independent review round 1 ([verbatim](notes-file-notes-round1-astra-review.md)) found no blocker for release with files off and asked for changes; the [responses](#review-round-1-responses) are below.

## Result

| Area | Implementation |
| --- | --- |
| Model | No new note kind. A file note is a document whose first block is a text line (the title), whose second is an uploaded file (a `file` block or an `attachment:` image), with no other image or file anywhere; text may follow. The same rule, with one set of title blocks (`TITLE_BLOCKS`: every text block, a Mono title included), is read from cached JSON for the list (`file-notes.ts`) and from the editor's document for the note view (`editor-file-notes.ts`) |
| Making one | Phone: "Upload" in the bottom bar opens a picker with no `accept`, `capture` or `multiple`. Wide screens: one file dropped on the note list. Either way the app makes a note whose only line is the file's name through `notes.create` (`createFileNote`, beside `duplicateNote`: a client key and the `account` precondition, sent and shown in the starting session only through `copyInSession`), opens it with `openRemote`, and the note's editor uploads the file after the title through B3's uploads. Each file is an operation (`FileNoteOperations`) with one creation key until the server answers, shown above the list while on its way (Retry and Remove after no answer), whose file only its own note's editor takes |
| Note view | With files on, the file block of a file note shows large: an image fitted to the column (no resize controls; a saved width is ignored here), a PDF with its name, type and size, Full screen and Download over the reader inline, any other file as a large icon with its name, "ZIP · 2.4 MB" and Download. The rest of the note is ordinary, editable text; renaming is editing the first line |
| PDF reader | Port of Deltos `views/pdf/*` (`pdf-reader.tsx`, `pdf-engine.ts`, `pdf-search.ts`, `pdf.css`): virtualized pages, a thumbnail rail (docked when the reader is 640 px or wider, a drawer otherwise), page number with Previous and Next, search with "2 of 7" and Previous/Next, a selectable text layer, and "This PDF could not be opened here." with "Download to view". pdf.js `pdfjs-dist` **6.4.299** (pinned; released 2026-10-03) |
| Full screen | `registerFileOpener("application/pdf", openPdfDialog)` (B3's seam): a tap on a selected PDF chip, or Full screen in a file note, opens a modal dialog with the reader, Download and ×; Escape and × close it |
| Fences | Every B3 fence applies to the reader. Inline, it gets its bytes as a picture does; full screen, as a download does, with a signal that closes it. Either way it leaves the page synchronously when the object becomes unavailable, the session or generation changes, files turn off, the cache clears or the editor closes |
| List rows | With files on, a file note's row shows a type icon, or the picture itself when this page already holds its bytes in memory, and "PDF · 2.4 MB" (images: "PNG"; their blocks record no size) followed by the rest of the preview. Derived from the documents the device already caches; no backend field |
| Not loaded at start | pdf.js and the reader are a lazy chunk reached by a dynamic import from the editor chunk, with a same-origin module worker; neither is precached by the service worker |
| Tests | Unit (`file-notes.test.ts`, `file-notes-review1.test.ts`, `file-note-operations.test.ts`, one in `service-worker.test.ts`), browser (`tests/browser/notes-file-notes.spec.ts`, 39 tests on desktop and 37 on the phone project), a test-only app harness (`harness/app.html`: the real app connected to a stand-in Convex client), real-service e2e (`scripts/file-notes-e2e.mjs`) |

Files: new `file-notes.ts`, `file-rows.tsx`, `editor-file-notes.ts`, `pdf-host.tsx`, `pdf-reader.tsx`, `pdf-engine.ts`, `pdf-search.ts`, `pdf.css`, the unit and browser tests and the e2e; changed `App.tsx`, `EditorSurface.tsx`, `editor.tsx`, `editor-attachments.ts`, `attachment-views.ts`, `note-tools.ts`, `Icons.tsx`, `styles.css`, `attachments.css`, `build.d.ts`, `vite.config.ts`, `offline-plugin.ts`, `playwright.config.ts`, the attachments harness, `package.json` and the lockfile; and B3's browser spec and e2e, whose download example is now a ZIP (below).

## Design and rules

### Making a file note

1. **Entry points.** Upload (phones) and a drop on the list (wide screens) exist only while `files.capabilities` says writes are on, the live layer is signed in for this account (`fileNotesOn`), and the person is permitted. Without them the bottom bar and the list render as on `main`, and a file dropped on the list is left to the browser, as on `main`. While on, Upload is disabled, and a drop explains why, when the server is not connected, in Trash, or in a read-only notebook.
2. **Refused before any note.** An empty file or one over 25 MB is refused with B3's messages, and several files dropped at once with "Drop one file at a time to make a file note."; no note is made.
3. **One operation per file (review round 1, F3 and F4).** `FileNoteOperations` keeps each file the person adds as an operation in this page's memory, for the account and session generation it began in:
   - **creating:** `createFileNote` calls `notes.create` with the operation's client key and `account`, prepared and sent only while the session ticket holds and files are still on (`copyInSession`, as Duplicate). Above the list the operation shows "Making its note…".
   - **no answer:** a failure that is not the server's refusal (a lost answer, a dropped connection) keeps the operation and its key: "No answer from the server. Retry to finish the note." with Retry and Remove. Retry, or adding the same file again (same name, size and type), sends the same key, so `notes.create` returns the note it already made rather than a second one. A refusal ends the operation with its message; nothing was made.
   - **on its way:** adding the same file again while it is creating, or while its note waits, sends nothing ("“name” is already on its way.").
   - **made:** the note exists. Its document is one paragraph, the file's name on one line (`fileTitle`: control characters become spaces; an unnamed file is "image" or "file", as B3 names uploads). It goes where New would put it: this notebook if the person can add notes there, otherwise their default notebook. The app opens it with `openRemote`; the operation shows "Opening its note…" with Open.
   Operations of another account or session generation end quietly; turning files off ends them all, each with a toast.
4. **The upload.** `uploadFor(account, generation, note)` hands an editor the file of the operation made for the note it shows, and no other. The editor's runtime takes it once (`startFileNote`) when `canUpload` holds (a live, editable note with the service, files on and the cache following this account and generation) and starts B3's upload with its mark after the title line (`uploadPoint(doc, 0)`). Files added one after another therefore each reach their own note, whichever opens first. From there it is B3's upload: progress and Cancel, Retry and Remove after a failure, every fence after every await, insertion by one step through the channel.
5. **If the upload does not land.** The note exists, and nothing is removed for the person:
   - a failure keeps B3's widget, with Retry and Remove, while the note is open;
   - Cancel or Remove, or closing the note mid-upload (B3 cancels), leave the note with its title only; the object fails or is deleted on the server (B1);
   - if no editor takes the file within 20 seconds (`FILE_NOTE_WAIT_MS`: the note did not open, files turned off, the note is read-only), the operation ends, its file is dropped from memory, and a toast says "“name” was not uploaded. Its note is there; add the file with + File." A handle taken earlier can no longer take the file. In another session nothing is said or done.

   No note is trashed automatically: another device or a collaborator may have typed in it.

### The file-note view

- `fileNotePlugin` (editor chunk) marks the file block of a file note with a node decoration that changes no DOM; the mark exists only while files are on. `fileNoteBlock` fails for most notes at the second block, before walking the document.
- The node views read the mark: B3's `ImageView` takes a `fileNote` flag (fitted to the width, no grip or size controls); a marked `file` block gets `FileNoteView` instead of the chip. When a note becomes or stops being a file note (an edit, a collaborator's step), `update` returns false and ProseMirror draws the block anew in the other form.
- `FileNoteView` keeps the chip's data attributes and status rendering ("Attachment unavailable" and so on); Download and Full screen go through `runtime.open`. Events in its buttons and the reader are theirs (`stopEvent`), and a selection inside the reader is not the editor's (`ignoreMutation`). ProseMirror makes the block draggable; for a PDF that attribute is removed once ProseMirror has set it, so a drag inside the reader selects text.
- While files are off there are no node views and no mark, so a file note renders as on `main` (its file block's name).

### The PDF reader

- **Port.** Deltos's engine, search and reader, rewritten in Palladian's style: one priority queue for page renders, thumbnails and text reads (two at a time; the page being read first), a 4-million-pixel cap per canvas computed from the page at scale 1, so a large page is never over the cap and a small page shown large is still sharp up to the screen's pixel ratio (`pdf-canvas.ts`, review round 1, F2), page sizes read a dozen at a time, pages near the view drawn and the rest freed, the rail windowed the same way. Deltos's temporary on-screen diagnostics were not ported. The text layer stretches each run to the width pdf.js gives it, so a selection covers the drawn glyphs.
- **Parsed, never run.** The scripting sandbox (`pdf.sandbox`) and QuickJS are never loaded or served, and no annotation layer is drawn, so a PDF's JavaScript and form actions never run. `enableXfa: false`. pdf.js 6.4 has no `isEvalSupported` option and no `eval` or `Function` code path left (checked in `pdf.mjs` and `pdf.worker.mjs`); `isEvalSupported: false` is still passed, as the brief asks, in case a later version reads it. The whole file is handed over (streaming, range requests and auto-fetch off), so pdf.js makes no request for the document.
- **Worker.** `PDFWorker.create({ port: new Worker(url, { type: "module" }) })` with the bundled worker file (`pdf.worker.min.mjs?url`), same origin. One worker per open document. pdf.js does not end a worker it is handed, so `openPdf` keeps the native `Worker` and terminates it itself, with the loading task destroyed, whenever the document goes: closed, failed (a damaged or encrypted file), or abandoned while it is still opening (`openPdf` takes the reader's abort signal). The reader aborts and destroys on unmount, which every fence and every close reaches (review round 1, F1).
- **pdf.js's data files** (CMaps, standard fonts, the JPX/JBIG2/ICC decoders) are served from the app's origin at `/pdfjs/`: a small Vite plugin serves them from `node_modules` in development and copies them into the build after bundling, so the service worker does not precache them. QuickJS is excluded.
- **Bytes.** The reader is handed a `Blob` that came through B3's authenticated read path and memory cache; pdf.js gets its own copy, so the cached bytes stay whole for the next opening. No URL, token or signed URL is involved; the page holds only the bytes.
- **Untrusted text.** PDF text reaches the page only as React text nodes (`splitItemForRender` only slices strings); the name in the dialog is set with `textContent`.
- **Loaded on demand.** `pdf-host.tsx` (editor chunk, small) imports `pdf-reader.tsx` with `import()`; pdf.js comes with it. If the chunk cannot load (offline, say), the place shows "This PDF could not be opened here." with "Download to view".

### Fences on the reader

- **Inline (file note).** `FileNoteView` watches its object wanting the bytes, exactly as a picture does (`runtime.watch(..., true)`): the read is fenced by the editor's lifetime, the account and session generation, the files gate, the cache ticket and the object's availability, rechecked after every await (B3). Whenever the record leaves "shown" (any clear of the cache, files off, a new generation, the object unavailable), its listener runs synchronously and `mountPdfReader`'s remover takes the reader's box off the page at once; React and pdf.js are torn down right after, in a microtask (never while React may be rendering). It shows "Loading…", "Not available offline", "Attachment unavailable" or "The PDF could not load." with Retry, and loads again once it may, as a picture does.
- **Full screen.** `runtime.open` now hands an opener a `FileOpening`: `bytes()` fenced as a download, a `signal`, `download()` and `release()`. The runtime tracks every download and opening with its object (`opens`) and aborts them for good on every clear, gate change, session change and editor close (`dropReads`, `destroy`), and those of one object when it becomes unavailable (`set(..., "unavailable")`). The dialog closes synchronously on abort; closing it releases the opening and stops a read still under way.
- **R5-1 (fixed here).** Because aborting on unavailability is permanent, a download or opening held while its object is removed delivers nothing and stores nothing in the cache, whatever the server's list says afterwards (unknown again, or listing it again); a new tap starts a fresh one. `FileView` and `FileNoteView` then say "This attachment is unavailable."
- **R5-2 (fixed here).** `admitted` keeps only the object that landed: an earlier request's admission answering after a Retry landed is released through the service that made it.

### List rows

- `useFileNotes` reads the cached documents (`store.read`) of the rows shown, after the list renders and only while files are on, and keeps the result per account, note, edit time and kind. Another device's text can reach the cache after its summary, so a row edited in the last minute is read again whenever the list renders; older rows are read once per edit.
- `FileRowVisual` shows the picture only if this page already holds the image's bytes (`attachmentCache.read` under a current ticket: shown or uploaded here); it never reads. It looks again when the list renders, and any clear takes the picture off the page at once. Otherwise a type icon.
- The label is `fileNoteLabel` ("PDF · 2.4 MB"; images only their type unless the bytes are held); the preview after it drops the file's name it starts with (`fileNoteRest`). The row's accessible name still starts with the title.
- **Why no backend field:** the device already caches every note's document, and a summary field would need cached summaries to keep it (`cache.ts`, `live.ts`: fundamentals).

## B4 requirements

| Requirement | How it is met | Evidence |
| --- | --- | --- |
| No new note kind; first line the filename, next block the file | `fileNoteStart` makes the title line; the editor uploads the file after it | Browser "a new file note uploads its file after the title…"; e2e "drop on the list", "phone upload" (server blocks `["report.pdf", "file:report.pdf"]`, `["harbour.png", "image:…"]`) |
| Phone Upload in the bottom bar; desktop drop on the list | `mobile-home-actions` button and hidden input (no `accept`, `capture`, `multiple`); `note-list` drag handlers | App harness "with files on and a connection, the list takes a file…" (both projects); e2e (real file chooser on an iPhone-sized touch context; a synthetic drop on desktop) |
| Offered only while writes are on; off as on `main`; nothing reachable writes | `fileNotesOn`; handlers and input absent while off; `makeFileNote` and its prepare step recheck `fileWritesEnabled()` | Browser "with files off, the list offers no Upload, leaves dropped files alone and lists file notes as before"; "with files on … Without the server, still no Upload and no drop" |
| Reuse B3's pipeline and fences | `startFileNote` → `UploadController.start`; `canUpload` | Browser "a new file note's upload: a failure keeps Retry and Remove; Cancel…", "…waits for a note that can take files" |
| Created through existing app paths with the account precondition and session fencing | `createFileNote` (`notes.create`, `account`, client key) inside `copyInSession`; `openRemote` | e2e (real `notes.create` with `account` on dev); app harness "…the list takes a file…", "F3: …", "F4: …"; `copyInSession` is A4's, with its unit tests |
| Defined failure or cancel after the note exists | Retry/Remove; the note keeps its title; 20 s handoff limit with a toast | Browser (Cancel, failure); e2e "cancel after the note exists" (object `failed` on dev, note `["big.zip"]`) |
| File-note view: image fitted, PDF in the reader, other type large with Download | `fileNotePlugin`, `ImageView(fileNote)`, `FileNoteView` | Browser "a file note's picture is fitted…", "any other file shows large…", "a PDF file note shows the reader inline…"; e2e (fitted on the phone; reader) |
| Renaming is editing the first line; editable below the file | Ordinary text; the view follows the document | Browser "only a title line, one file and text make a file note; renaming is editing the first line" |
| pdf.js lazily, scripting and eval off, a worker, pinned | Dynamic import; no sandbox or annotation layer; `isEvalSupported: false`, `enableXfa: false`; module worker; `6.4.299` exact | Browser (no `pdfjs-dist` or reader request before a PDF shows); build: pdf.js only in the reader chunk |
| Virtualized pages, thumbnail rail, page jump, search, text selection, Download to view | `pdf-reader.tsx` | Browser tests for each (30-page generated PDF; canvases fewer than pages); e2e search on the real bytes |
| Inline in a file note and full screen from a PDF chip | `FileNoteView`; `registerFileOpener` | Browser "a PDF chip opens the reader full screen…"; e2e "full screen from a chip" |
| Bytes only through B3's authenticated read path and memory cache | `watch` / `open` → `fetchBytes` | e2e: the phone's read is `/files/notes/<note>/<object>` with `Bearer` in a header, no token in the URL or page; the desktop reader showed its upload with no read |
| Every fence closes or blanks the reader | Inline via the record's status; full screen via `FileOpening.signal` | Browser "the inline reader leaves the page at once: …" (4) and "the full-screen reader closes at once: …" (5): checked in the same task as the change |
| Bundle out of the startup path | Lazy chunk; not precached | Build sizes below |
| List rows: thumbnail or type icon, type and size | `useFileNotes`, `FileRowVisual`, `fileNoteLabel` | Browser "with files on, file notes list…"; e2e "list row" and the thumbnail after the desktop showed the picture |
| Image thumbnails never read bytes per row | Memory cache lookups only | Browser (thumbnail from stored bytes; cleared at once) |

## Differences from plan B4, deliberately

- **One file makes one note, and only one at a time.** Deltos made a note per dropped file, uploaded first and created after. Here the note's editor uploads the file (B3's pipeline, so its fences hold), and only one note is open; several files dropped at once are refused with a message.
- **The note is made before the upload** (the brief's path through `notes.create`), so a failed or cancelled upload leaves a note with its title.
- **Renaming does not rename the file**: the file block keeps its own name, which a download uses.
- **A file note's picture ignores a saved width** and has no resize controls.
- **Download** is offered for every file note's file (a PDF also has Full screen), not only for other types.
- **R5-1 and R5-2 fixed** with the reader, since it uses those paths.

## Proposal touching the fundamentals

None is needed for B4. F4 (B3's proposal: copied attachments carry their source note through the channel) is unchanged and still blocks turning files on.

## Changed outside B4's own code

- **B3's download tests use a ZIP.** Plan B3 says "a PDF opens the reader", and with the reader registered a PDF chip no longer downloads. The B3 browser spec's album file and the attachments e2e's chip were `report.pdf`; they are now `report.zip` (`application/zip`) with the same bytes checks, labels ("ZIP · 2.4 MB") and fences. No assertion was removed. PDFs are tested opening the reader instead.
- **`registerFileOpener`'s opener** now gets a `FileOpening` instead of a bare bytes function (no opener was registered before), and its remover removes only its own opener.
- **`formatSize` and `typeLabel`** moved to `file-notes.ts` (the list needs them without editor code); `attachment-views.ts` re-exports them. B3's `uploadName` is `fileTitle` (same result, and control characters become spaces).
- **`offline-plugin.ts`** leaves the reader chunk, its CSS and the pdf.js worker out of the precache list; the build's version digest still covers them.

## Found during this work (not changed)

1. **Chromium with the iPhone user agent** (the mobile test project): ProseMirror treats the page as iOS and leaves a click right next to a selected block to the browser, which keeps the block selected. One test clicks at the line's start instead. Real taps are for the iPhone check.
2. **Image blocks record no size**, so an image file note's row shows "PNG" alone unless this page holds its bytes.
3. **A row's thumbnail** appears when the list next renders after the bytes arrive (opening the note, then anything that redraws the list). A row whose text reaches the cache more than a minute after its summary shows its label from its next edit or the next load.
4. **Text selection in the inline reader** sits inside the editable note: Chromium selects and copies it (tested); iOS selection handles inside an editor are for the iPhone check. The full-screen reader is outside the editor.
5. **Offline**, the reader's chunk is not cached, so a PDF whose bytes this page holds shows "Download to view" (no offline downloads either, D84).
6. **pdf.js warns** "Indexing all PDF objects" for a broken PDF (the fallback test); harmless.
7. **History previews** still show a file block as its name (B3 found 1).
8. **A delayed open can supersede a newer one** (review round 1, F6; the `openRemote` intent race already reported to the owner as a fundamentals issue, not changed here). With B4: make file note A, then open B while A's `fetchContent` is slow; A's `selectNote` can then replace B on screen, and A's editor takes A's file. The file still goes to its own note (operations are per note), but the newer navigation is lost. The fix belongs to the fundamentals change for `openRemote`.

## Defaults the owner may change

- One file per Upload or drop; several dropped at once are refused.
- A failed, cancelled or abandoned upload leaves its note with the title; nothing is trashed for you.
- The handoff waits 20 seconds for the new note's editor.
- While a file's note is on its way, a file with the same name, size and type is taken to be the same file (its retry, or nothing new).
- The inline reader's height (78% of the view, at most 960 px; 72% on phones); the rail docks at 640 px.
- The reader is not kept for offline use (smaller updates on every device).
- Image file notes fill the column, ignoring a saved width.

## Bundle

Production build, HEAD against `main` `eacfafd`:

| Chunk | `main` | HEAD | Loaded |
| --- | --- | --- | --- |
| Startup JS (`index`) | 446.76 kB (138.81 gz) | 453.20 kB (140.92 gz) | at start |
| Startup CSS | 43.76 kB | 44.54 kB | at start |
| Editor JS | 180.16 kB (57.97 gz) | 188.49 kB (59.88 gz) | first editor |
| Editor CSS | 5.60 kB | 8.66 kB | first editor |
| Reader + pdf.js (`pdf-reader`) | — | 443.31 kB (133.87 gz) + 2.98 kB CSS | first PDF shown; not precached |
| pdf.js worker | — | 1,264 kB | first PDF shown; not precached |
| `/pdfjs/` data files | — | CMaps, standard fonts, decoders | only those a PDF needs |

## Review round 1 responses

Review: [notes-file-notes-round1-astra-review.md](notes-file-notes-round1-astra-review.md), on `944e990`. Every regression below was run against `944e990` in a temporary checkout, with only the new tests and the test-only app harness copied in: all 24 browser runs (12 tests on both Chromium projects; the two F2 tests are desktop-only) and the unit test fail there at their scenario assertions, and all pass now.

| Finding | Response | Regression tests (fail on `944e990`, pass now) |
| --- | --- | --- |
| F1 (blocking before enablement) PDF workers survive the reader | `openPdf` keeps the native `Worker` and terminates it, with the loading task destroyed, on every exit: `destroy`, a failed open (damaged or encrypted), and an abort while opening (it takes the reader's signal; the reader aborts on unmount, which every fence and close reaches) | Browser "F1: closing the note or the full-screen reader ends the PDF's worker", "F1: a damaged / an encrypted PDF's worker ends with the failure", "F1: unavailable / files off / session change / cache clear ends the workers of the inline and full-screen readers", "F1: a reader closed while pdf.js is still starting leaves no worker" (the worker script held). The page's `Worker` is counted (constructed, terminated); on `944e990` none is ever terminated |
| F2 the canvas cap uses the wrong scale | `canvasScale` (`pdf-canvas.ts`) caps the absolute scale from the page at scale 1: `min(scale × ratio, √(4 MP / page area))` | Browser "F2: a page's canvas is sharp and within the pixel cap: a 10,000-unit page / a one-inch page at DPR 3" (on `944e990` the large page's canvas has 16,443,025 pixels, and the small page, shown 1,352 px wide, gets a 106-pixel bitmap); unit "F2: a canvas is sharp up to the screen's pixel ratio and never over the pixel cap" (the reviewer's 10,000-unit page at DPR 3, a 72-unit page at 1,152 px, a letter page at DPR 2) |
| F3 creation retries lose their key | `FileNoteOperations`: one operation per file, its key kept until the server answers; no answer shows Retry and Remove above the list; Retry or the same file again resends that key, and `notes.create` replays the note; the same file is not sent while its note is on its way | App harness "F3: a creation whose answer is lost keeps its key: the same file again, or Retry, makes no second note" (the stand-in server commits, then loses the answer), "F3: while a creation's answer is awaited, the same file is not sent again". On `944e990` neither shows a pending state, and the same file again is a new key and a second note. Unit `file-note-operations.test.ts` (keys, retry, duplicates) |
| F4 overlapping creations drop a file | Operations are independent; `uploadFor` hands each note's editor only that note's file | App harness "F4: files added one after another each reach their own note" (first.zip's open held while second.zip is made, opened and uploaded; then first.zip's note opens and gets first.zip). On `944e990` first.zip's note stays title-only. Unit "F4: each made note's file waits for that note's editor only" |
| F5 the list and editor classifiers disagree | `TITLE_BLOCKS` (every text block the schema has, a Mono title included) is the one rule for both | Unit "F5: the list and the editor agree on every block a note can start with" (on `944e990` the list rejects a code-block title the editor accepts); "F5: the title blocks are every text block the schema has" |
| F6 a delayed open can reclaim navigation | Not changed (`openRemote` is fundamentals); recorded as [Found 8](#found-during-this-work-not-changed) with B4's part: the file still reaches its own note | — |

Also changed:
- **A made note's file can no longer be taken after its wait ends** (found by the operations' unit test): the handle an editor holds returns nothing once the operation is gone.
- **The app harness** (`harness/app.html`, `src/harness/app.tsx`, test-only): the real `App`, notes cache and session, signed in and connected to a stand-in for the Convex client that keeps notes, step logs and file objects in the page, built as the unit tests' `fake-server.ts` builds a live layer. It also adds a mocked test of the entry points with files on: "with files on and a connection, the list takes a file (Upload on phones, a drop on wide screens) and makes a file note".
- **One test** ("the inline reader leaves the page at once: session change") now expects the PDF to be read again under the new generation: the harness keeps its editor open across generations (the app opens a new one), so its old "nothing cached" check raced that re-read.

## Review round 2 responses

Report: `notes-file-notes-round2-astra-review.md` (verbatim). **Accepted for release with files off.** F1 to F5 are resolved, and B3's R5-1 and R5-2 fixes pass. This acceptance does not cover turning files on.

| Finding | Response |
| --- | --- |
| R2-1: retry recovery ends with the in-memory operation | **Recorded as a boundary.** The operation is not persisted. **Remove** only stops waiting for the server's answer. If the server later commits the creation, a title-only note remains, and nothing is uploaded or opened. A reload loses the file and its creation key, so adding the file again can create a second note. Recovering retries durably would need a separately designed persistence change. |
| R2-2: the existing navigation race | **Unchanged.** It is the existing `openRemote` intent race in the fundamentals (F6; "Found during this work", item 8). It is already reported to the owner. |
| R2-3: B3 provenance | **Unchanged.** This is B3's F4 and needs owner approval. |

**Before files are turned on:**

- B3's F4, provenance for copied attachments: needs owner approval, then a protected change with its own review.
- Every device runs B3 and B4.
- The iPhone checks in Safari and the installed app: picker sources, uploads, reader interaction, text selection and downloads.

## Evidence

| Check | Result | Services |
| --- | --- | --- |
| App typecheck (app and tools, tests included) | Pass | — |
| App unit tests (`pnpm --filter @palladian/notes test`) | Pass: 20 session + 339 Vitest after round 1 (331 before). New: 10 in `file-notes.test.ts` (the file-note rule on JSON and on ProseMirror documents agree, labels, the rest of the preview, titles and refusals, PDF search and its text splitting, the title blocks, the canvas size), 1 in `file-notes-review1.test.ts` (F5), 5 in `file-note-operations.test.ts` (keys, retries, duplicates, each note's own file, the wait, sessions, files off) and 1 in `service-worker.test.ts` (the reader chunk, its CSS and the worker are left out of the precache list) | Node; pure functions, fake timers, and the offline plugin with a stand-in plugin context (**mock**) |
| Browser suite on a private port (5291), `notes-chromium` and `notes-mobile-chromium`, via `/tmp/palladian-queue/browser-on-port.sh` | After round 1: **270 passed, 22 skipped** (the 20 existing skips, and the two desktop-only F2 tests on the phone project; 194 before B4). Before it: 244 passed, 20 skipped. The B4 spec passed 3 repeats on both projects | Real Chromium, real editor and pdf.js on generated PDFs (a damaged and an encrypted one among them). The editor tests use the test-only editor harness with a stand-in for `files.createUpload`, `cancelUpload`, `noteObjects` and the token, and Playwright routes for `/files/*` (**mock**). The list-making tests use the test-only app harness: the real app, notes cache and session with a stand-in Convex client in the page (**mock**). The list-row tests run the app in fixture mode (no server; files turned on through the app's module) |
| Regressions R5-1 and R5-2 without their fixes (the two fixes reverted in place, the tests unchanged) | All 6 (3 tests × 2 projects) fail: the held download is delivered, the full-screen dialog stays open, no `cancelUpload` for the stranded admission | As above |
| Review round 1 regressions against `944e990` (temporary checkout; the new tests and the app harness copied in) | All 24 browser runs and the F5 unit test fail at their scenario assertions ([table](#review-round-1-responses)) | As above |
| `scripts/file-notes-e2e.mjs` through `/tmp/palladian-queue/with-app.sh`, `NOTES_FILES_ORIGIN=http://localhost:8796` | **PASS**, 11 steps; again after round 1 (`7df4038`) | **Real** dev Convex (`decisive-reindeer-520`, files on) and Better Auth, the app on 5178, a **real** local `wrangler dev` Worker with **local R2 simulation**, Chromium as a desktop and an iPhone-sized touch context. The Worker's own finalize is untrusted on dev (B1), so the script answers the PUT in the browser and calls `files:finalize` as the file service, as `attachments-e2e.mjs` does. `notes.create`, tickets, admission, reads through the Worker and pdf.js on the real bytes are real. The desktop drop is a synthetic `DragEvent` with real `File`s |
| `attachments-e2e.mjs` (its chip now a ZIP), `actions-e2e.mjs`, `live-e2e.mjs`, `history-e2e.mjs` (regressions) | **PASS**, all four, at `3d594b4`, `ab89a94` and after round 1 (`7df4038`). On the `ab89a94` run `live-e2e` and `history-e2e` first failed at account setup, while dev Convex answered `provision:setupOwner` with "Service temporarily unavailable (Code: 04)"; both passed on a retry minutes later | Real dev Convex, the app, Chromium; attachments also the local Worker as above |
| Offline suite (`pnpm --filter @palladian/notes test:offline`: production build, real service worker) | Pass (2) | Real Chromium, networking disabled |
| Backend, Worker, notes-core | Unchanged; nothing pushed to dev | — |
| WebKit | Cannot launch on this host | — |
| Assistive technology | Not checked with a screen reader; roles and names are checked in Chromium | — |
| Production | **Not deployed** | — |
| iPhone | **Pending (owner)**: Upload in the bottom bar and the picker's sources; a file note made from a photo and from Files; the reader inline and full screen (scrolling inside the note, the rail drawer, the page field and search with the keyboard, selecting and copying text, pinch); Download from a file note in Safari and in the home-screen app | — |

Pending: independent review of the round 1 responses; F4 and the owner's device confirmation before files are turned on; the iPhone check; owner answers to the defaults above.
