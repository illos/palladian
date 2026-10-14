import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin, type Transaction } from "prosemirror-state";
import type { Transform } from "prosemirror-transform";
import { hasBlockId } from "./schema.ts";

const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Short random block IDs; uniqueness is enforced per document. */
export function newBlockId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let id = "";
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

/** Append steps that give every block a present, document-unique ID. */
export function assignBlockIds(tr: Transform): Transform {
  const seen = new Set<string>();
  tr.doc.descendants((node, pos) => {
    if (!hasBlockId(node)) return true;
    const current = node.attrs.id;
    if (typeof current === "string" && current && !seen.has(current)) {
      seen.add(current);
      return true;
    }
    let next = newBlockId();
    while (seen.has(next)) next = newBlockId();
    seen.add(next);
    tr.setNodeAttribute(pos, "id", next);
    return true;
  });
  return tr;
}

export function blockIdProblems(doc: ProseMirrorNode): number {
  const seen = new Set<string>();
  let problems = 0;
  doc.descendants((node) => {
    if (!hasBlockId(node)) return true;
    const current = node.attrs.id;
    if (typeof current !== "string" || !current || seen.has(current))
      problems++;
    else seen.add(current);
    return true;
  });
  return problems;
}

/** Editor plugin: repair IDs after local edits such as Enter or paste. */
export function blockIdPlugin(isRemote: (tr: Transaction) => boolean) {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged && !isRemote(tr)))
        return null;
      if (!blockIdProblems(state.doc)) return null;
      const tr = state.tr;
      assignBlockIds(tr);
      return tr.steps.length ? tr.setMeta("addToHistory", false) : null;
    },
  });
}
