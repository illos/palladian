import type { Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/**
 * Connects a collaborative editor to its note channel. The editor starts at an
 * accepted revision, replays unconfirmed local steps, and reports every
 * transaction so the channel can journal and send them.
 */
export interface EditorBinding {
  version: number;
  clientId: string;
  pending: string[];
  attach(view: EditorView): () => void;
  changed(view: EditorView, tr: Transaction): void;
}
