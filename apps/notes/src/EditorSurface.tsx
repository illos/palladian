import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isPlainDocument, textDocument } from "./document";
import type { NoteEditor } from "./editor";

let editorModule: Promise<typeof import("./editor")> | undefined;
export function EditorSurface({
  document,
  editedLabel,
  text,
  editable,
  onChange,
}: {
  document: string;
  editedLabel?: string;
  text: string;
  editable: boolean;
  onChange: (document: string, text: string) => void;
}) {
  const [Editor, setEditor] = useState<typeof NoteEditor | null>(null);
  const [plainText, setPlainText] = useState(text);
  const plainEditable = editable && isPlainDocument(document);
  const latestDocument = useRef(document);
  const [loadError, setLoadError] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const scrollBeforeUpgrade = useRef<number | null>(null);
  useEffect(() => {
    let alive = true;
    let loaded: typeof import("./editor") | null = null;
    const upgrade = () => {
      if (!alive || !loaded || !host.current) return;
      // Do not replace a user's active text selection or an in-progress draft.
      const selection = window.getSelection();
      const selecting =
        selection &&
        !selection.isCollapsed &&
        selection.anchorNode &&
        host.current.contains(selection.anchorNode);
      const typing =
        editable && host.current.contains(window.document.activeElement);
      if (selecting || typing) return;
      try {
        loaded.validateDocument(latestDocument.current);
      } catch {
        setLoadError(true);
        return;
      }
      scrollBeforeUpgrade.current =
        host.current.closest(".note-surface")?.scrollTop ?? null;
      setEditor(() => loaded!.NoteEditor);
    };
    editorModule ??= import("./editor");
    void editorModule
      .then((module) => {
        loaded = module;
        upgrade();
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    window.document.addEventListener("selectionchange", upgrade);
    window.document.addEventListener("focusout", upgrade);
    return () => {
      alive = false;
      window.document.removeEventListener("selectionchange", upgrade);
      window.document.removeEventListener("focusout", upgrade);
    };
  }, [editable]);
  useLayoutEffect(() => {
    if (Editor && host.current && scrollBeforeUpgrade.current !== null) {
      const surface = host.current.closest(".note-surface");
      if (surface) surface.scrollTop = scrollBeforeUpgrade.current;
    }
  }, [Editor]);
  return (
    <div ref={host}>
      {editable && !plainEditable && !Editor && (
        <p className="foundation-banner">
          This formatted draft will be editable when formatting is ready.
        </p>
      )}
      {loadError && (
        <p className="error" role="alert">
          The rich editor could not load. Your cached text remains available.
        </p>
      )}
      {Editor ? (
        <Editor
          editedLabel={editedLabel}
          document={latestDocument.current}
          editable={editable}
          onChange={onChange}
        />
      ) : plainEditable ? (
        <div className="editor-host">
          {editedLabel && <p className="edited-date">{editedLabel}</p>}
          <textarea
            className="draft-fallback"
            aria-label="Note content"
            value={plainText}
            onChange={(event) => {
              const next = event.target.value;
              setPlainText(next);
              latestDocument.current = textDocument(next.split("\n"));
              onChange(latestDocument.current, next);
            }}
          />
        </div>
      ) : (
        <div className="editor-host">
          {editedLabel && <p className="edited-date">{editedLabel}</p>}
          <div
            className="cached-text"
            role="textbox"
            aria-label="Note content"
            aria-multiline="true"
            contentEditable={false}
          >
            {plainText.split("\n").map((line, index) => (
              <p key={index}>{line || "\u00a0"}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
