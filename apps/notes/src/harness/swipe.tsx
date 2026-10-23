import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SwipeRow } from "../SwipeRow";
import type { SwipeLayout } from "../note-actions";
import "../theme.css";
import "../styles.css";

/**
 * Test-only page (harness/swipe.html, served by the dev server, not built):
 * two swipe rows whose actions and open state the browser tests control.
 */
const layouts = {
  full: {
    leading: ["duplicate"],
    trailing: ["move", "share"],
    full: "trash",
    fullLeading: "pin",
  },
  trashed: {
    leading: ["restore"],
    trailing: ["delete"],
    full: null,
    fullLeading: null,
  },
  none: { leading: [], trailing: [], full: null, fullLeading: null },
} satisfies Record<string, SwipeLayout>;
type LayoutName = keyof typeof layouts;

interface SwipeHarness {
  log: string[];
  open: string | null;
  setLayout(id: string, name: LayoutName): void;
  setOpen(id: string | null): void;
}
declare global {
  interface Window {
    __swipe: SwipeHarness;
  }
}

const harness: SwipeHarness = {
  log: [],
  open: null,
  setLayout: () => undefined,
  setOpen: () => undefined,
};
window.__swipe = harness;

function Harness() {
  const [open, setOpen] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, LayoutName>>({
    A: "full",
    B: "full",
  });
  harness.open = open;
  harness.setLayout = (id, name) => setNames((all) => ({ ...all, [id]: name }));
  harness.setOpen = setOpen;
  return (
    <div className="note-list">
      {["A", "B"].map((id) => (
        <div className="note-row-wrap" key={id} data-row={id}>
          <SwipeRow
            layout={layouts[names[id]!]}
            open={open === id}
            onOpenChange={(isOpen) =>
              setOpen((current) =>
                isOpen ? id : current === id ? null : current,
              )
            }
            onAction={(action) => harness.log.push(`${id}:${action}`)}
            onLongPress={() => harness.log.push(`${id}:long-press`)}
            onMenu={() => harness.log.push(`${id}:menu`)}
          >
            <button
              type="button"
              className="note-row"
              onClick={() => harness.log.push(`${id}:select`)}
            >
              <strong>Row {id}</strong>
            </button>
          </SwipeRow>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
