import type { NotesStore } from "./cache";
import type { SessionController } from "./session";

/** Download initiation is not proof that the user retained a recovery copy. */
export function settleDrafts(store: NotesStore, session: SessionController, accountId: string): Promise<boolean> {
  if (session.getSnapshot().accountId !== accountId) return Promise.resolve(false);
  return new Promise((resolve) => {
    const generation = session.getSnapshot().generation;
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Unsaved drafts");
    const heading = document.createElement("h2");
    heading.textContent = "Keep your unsaved drafts";
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = "These drafts have not reached the server. Choose how to keep them before signing out.";
    dialog.append(heading, status);
    let finished = false;
    let download: string | null = null;
    const finish = (proceed: boolean) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      if (download) URL.revokeObjectURL(download);
      dialog.close();
      dialog.remove();
      resolve(proceed);
    };
    const current = () => session.getSnapshot().accountId === accountId && session.getSnapshot().generation === generation;
    const unsubscribe = session.subscribe(() => { if (!current()) finish(false); });
    const button = (label: string, action: () => void) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      element.addEventListener("click", action);
      dialog.append(element);
      return element;
    };
    button("Wait for save", () => {
      status.textContent = "Server saving is not connected in this foundation. Stay signed in to keep your drafts, or export a copy.";
    });
    const exportButton = button("Export drafts", () => {
      exportButton.disabled = true;
      void store.exportDrafts(accountId).then((drafts) => {
        if (!current() || finished) return;
        if (download) URL.revokeObjectURL(download);
        download = URL.createObjectURL(new Blob([JSON.stringify({ format: "palladian-recovery-v1", drafts }, null, 2)], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = download;
        link.download = "palladian-unsaved-drafts.json";
        link.click();
        status.textContent = "Confirm that you saved the recovery file before signing out. A cancelled download does not keep your drafts.";
        confirmExport.hidden = false;
      }).catch(() => {
        status.textContent = "Export failed. Your drafts remain here. Try again or cancel sign-out.";
      }).finally(() => { exportButton.disabled = false; });
    });
    const confirmExport = button("Export saved — sign out", () => { if (current()) finish(true); });
    confirmExport.hidden = true;
    button("Discard drafts and sign out", () => { if (current()) finish(true); });
    button("Cancel", () => finish(false));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
    document.body.append(dialog);
    dialog.showModal();
  });
}
