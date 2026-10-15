import type { Draft, NotesStore } from "./cache";
import type { SessionController } from "./session";

/** Download initiation is not proof that the user retained a recovery copy. */
export function settleDrafts(
  store: NotesStore,
  session: SessionController,
  accountId: string,
  flush?: () => Promise<boolean>,
  purpose: "sign-out" | "switch" = "sign-out",
): Promise<boolean> {
  const leaving = purpose === "switch" ? "switching accounts" : "signing out";
  const leave = purpose === "switch" ? "switch accounts" : "sign out";
  if (session.getSnapshot().accountId !== accountId)
    return Promise.resolve(false);
  return new Promise((resolve) => {
    const generation = session.getSnapshot().generation;
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Unsaved drafts");
    const heading = document.createElement("h2");
    heading.textContent = "Keep your unsaved drafts";
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent =
      (purpose === "switch"
        ? "Another account signed in on this device. "
        : "") +
      `These drafts have not reached the server. Choose how to keep them before ${leaving}.`;
    // Work held while the server confirms access is kept but not exportable.
    // Holds can begin or end while the dialog is open, so this stays current.
    const held = document.createElement("p");
    held.hidden = true;
    dialog.append(heading, status, held);
    const describeHeld = (count: number) =>
      count === 1
        ? `One draft is waiting for the server to confirm your access to its note. It cannot be exported until then, and ${leaving} discards it.`
        : `${count} drafts are waiting for the server to confirm your access to their notes. They cannot be exported until then, and ${leaving} discards them.`;
    const refreshHeld = () =>
      void store
        .unsavedWork(accountId)
        .then((work) => {
          if (finished) return;
          held.textContent = work.held ? describeHeld(work.held) : "";
          held.hidden = !work.held;
        })
        .catch(() => undefined);
    const unsubscribeStore = store.subscribe(refreshHeld);
    refreshHeld();
    let finished = false;
    let download: string | null = null;
    /** What the last export contained; confirmation requires it still to be everything kept. */
    let exported: string | null = null;
    const fingerprint = (drafts: Draft[]) =>
      JSON.stringify(
        drafts
          .map((draft) => [draft.id, draft.updatedAt, draft.document])
          .sort(),
      );
    const finish = (proceed: boolean) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      unsubscribeStore();
      if (download) URL.revokeObjectURL(download);
      dialog.close();
      dialog.remove();
      resolve(proceed);
    };
    const current = () =>
      session.getSnapshot().accountId === accountId &&
      session.getSnapshot().generation === generation;
    const unsubscribe = session.subscribe(() => {
      if (!current()) finish(false);
    });
    const button = (label: string, action: () => void) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      element.addEventListener("click", action);
      dialog.append(element);
      return element;
    };
    const wait = button("Wait for save", () => {
      if (!flush) {
        status.textContent =
          "Your drafts cannot reach the server right now. Stay signed in to keep your drafts, or export a copy.";
        return;
      }
      wait.disabled = true;
      status.textContent = "Saving your drafts to the server…";
      void flush()
        .then((saved) => {
          if (!current() || finished) return;
          if (saved) finish(true);
          else
            status.textContent =
              "Some drafts have not reached the server yet. Stay signed in to keep your drafts, or export a copy.";
        })
        .finally(() => {
          wait.disabled = false;
        });
    });
    const exportButton = button("Export drafts", () => {
      exportButton.disabled = true;
      void store
        .exportDrafts(accountId)
        .then((drafts) => {
          if (!current() || finished) return;
          exported = fingerprint(drafts);
          if (download) URL.revokeObjectURL(download);
          download = URL.createObjectURL(
            new Blob(
              [
                JSON.stringify(
                  { format: "palladian-recovery-v1", drafts },
                  null,
                  2,
                ),
              ],
              { type: "application/json" },
            ),
          );
          const link = document.createElement("a");
          link.href = download;
          link.download = "palladian-unsaved-drafts.json";
          link.click();
          status.textContent = `Confirm that you saved the recovery file before ${leaving}. A cancelled download does not keep your drafts.`;
          confirmExport.hidden = false;
        })
        .catch(() => {
          status.textContent =
            "Export failed. Your drafts remain here. Try again or cancel.";
        })
        .finally(() => {
          exportButton.disabled = false;
        });
    });
    const confirmExport = button(`Export saved — ${leave}`, () => {
      confirmExport.disabled = true;
      // The export must still cover all kept work, read at one point: nothing
      // newer, nothing held.
      void store
        .settlement(accountId)
        .then((work) => {
          if (!current() || finished) return;
          if (work.held) {
            status.textContent = `${describeHeld(work.held)} Cancel to keep it, or discard drafts to ${leave}.`;
            confirmExport.hidden = true;
          } else if (fingerprint(work.drafts) !== exported) {
            status.textContent = `Your drafts changed after the export. Export again before ${leaving}.`;
            confirmExport.hidden = true;
          } else finish(true);
        })
        .catch(() => {
          status.textContent =
            "Your drafts could not be checked. Try again or cancel.";
        })
        .finally(() => {
          confirmExport.disabled = false;
        });
    });
    confirmExport.hidden = true;
    button(`Discard drafts and ${leave}`, () => {
      if (current()) finish(true);
    });
    button("Cancel", () => finish(false));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
