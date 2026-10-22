import { isSafeHref, notesSchema } from "@palladian/notes-core/schema";
import type { Node as ProseMirrorNode, Mark } from "prosemirror-model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { InputRule } from "prosemirror-inputrules";

const link = notesSchema.marks.link!;

/**
 * Bare domains link only with these common endings (Deltos's allowlist), so
 * "etc.", "file.txt", "3.14" or "U.S." never become links.
 */
const TLDS = [
  "com",
  "org",
  "net",
  "io",
  "dev",
  "co",
  "app",
  "ai",
  "edu",
  "gov",
  "me",
  "info",
  "xyz",
  "blog",
  "tech",
  "design",
];
// U+FFFC stands for a line break or other inline node in matched text.
const SCHEME = String.raw`(https?:\/\/[^\s\ufffc]+)`;
// The lookbehind keeps email domains and the tail of a longer word unlinked.
const BARE = String.raw`(?<![@\w.-])((?:[a-z0-9-]+\.)+(?:${TLDS.join("|")})(?:\/[^\s\ufffc]*)?)`;
const SCHEME_END = new RegExp(SCHEME + "$", "i");
const BARE_END = new RegExp(BARE + "$", "i");

const EMAIL = /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/;
const HOST = /^(localhost|[^\s/?#.:@]+(\.[^\s/?#.:@]+)+)(:\d+)?([/?#]|$)/i;

/**
 * A safe link address from typed input, or null. Bare domains get https://,
 * email addresses mailto:; only web and mail links pass `isSafeHref`.
 */
export function normalizeHref(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  let href = value;
  if (EMAIL.test(value)) href = "mailto:" + value;
  else if (!/^(https?:\/\/|mailto:)/i.test(value)) {
    // A host, with or without a port; anything else keeps its own scheme
    // and must pass isSafeHref.
    const bare = value.replace(/^\/\//, "");
    if (HOST.test(bare)) href = "https://" + bare;
  }
  if (!isSafeHref(href)) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "mailto:" && !url.hostname) return null;
  } catch {
    return null;
  }
  return href;
}

/** Drop sentence punctuation and an unmatched closing bracket after a URL. */
export function trimUrl(url: string) {
  let end = url.length;
  const count = (text: string, char: string) => text.split(char).length - 1;
  for (;;) {
    const char = url[end - 1];
    const text = url.slice(0, end);
    if (char && ".,;:!?'\"".includes(char)) end--;
    else if (char === ")" && count(text, "(") < count(text, ")")) end--;
    else if (char === "]" && count(text, "[") < count(text, "]")) end--;
    else break;
  }
  return url.slice(0, end);
}

/** The URL or allowlisted bare domain that `text` ends with, or null. */
export function detectTrailingUrl(text: string) {
  const scheme = SCHEME_END.exec(text);
  const match = scheme ?? BARE_END.exec(text);
  if (!match) return null;
  const url = trimUrl(match[1]!);
  const href = normalizeHref(url);
  return href ? { index: match.index, url, href } : null;
}

function hasCode(state: EditorState, from: number, to: number) {
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && node.marks.some((mark) => mark.type.spec.code))
      found = true;
  });
  return found;
}

/** Link the URL that `text` (a block's text up to the caret) ends with. */
function linkUrlBefore(
  state: EditorState,
  text: string,
  blockStart: number,
): Transaction | null {
  const found = detectTrailingUrl(text);
  if (!found) return null;
  const from = blockStart + found.index;
  const to = from + found.url.length;
  if (state.doc.rangeHasMark(from, to, link) || hasCode(state, from, to))
    return null;
  return state.tr.addMark(from, to, link.create({ href: found.href }));
}

/**
 * Space after a URL or bare domain links it. The rule types the space itself,
 * so Backspace right afterwards (`undoInputRule`) restores the plain text.
 */
export const autolinkOnSpace = new InputRule(
  /(\S+)(\s)$/,
  (state, match, start, end) => {
    // Only a single typed space; longer replacements (autocorrect) pass.
    if (!state.selection.empty || end - start !== match[0].length - 1)
      return null;
    const $start = state.doc.resolve(start);
    const before = $start.parent.textBetween(
      0,
      $start.parentOffset + match[1]!.length,
      undefined,
      "\ufffc",
    );
    const tr = linkUrlBefore(state, before, $start.start());
    if (!tr) return null;
    return tr.insertText(match[2]!, end).removeStoredMark(link);
  },
  { inCodeMark: false },
);

/** Enter after a URL or bare domain links it before the line breaks. */
export const linkBeforeCaret: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.spec.code || !$from.parent.inlineContent)
    return false;
  if ($from.marks().some((mark) => mark.type.spec.code)) return false;
  const before = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    "\ufffc",
  );
  const tr = linkUrlBefore(state, before, $from.start());
  if (!tr) return false;
  if (dispatch) dispatch(tr.removeStoredMark(link));
  return true;
};

/**
 * Backspace at a link's right edge removes the link but keeps its text; a
 * second Backspace deletes as usual (Deltos's unwrap).
 */
export const unlinkAtEdge: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  const before = $from.nodeBefore;
  const mark = before?.isText ? link.isInSet(before.marks) : undefined;
  if (!mark) return false;
  const after = $from.nodeAfter;
  if (after?.isText && mark.isInSet(after.marks)) return false;
  let from = $from.pos;
  for (;;) {
    const node = state.doc.resolve(from).nodeBefore;
    if (node?.isText && mark.isInSet(node.marks)) from -= node.nodeSize;
    else break;
  }
  if (dispatch) dispatch(state.tr.removeMark(from, $from.pos, link));
  return true;
};

export type LinkRange = { from: number; to: number; href: string };

/** The whole link at `pos`: the one after the position, else the one before it. */
export function linkRangeAt(
  doc: ProseMirrorNode,
  pos: number,
): LinkRange | null {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.inlineContent) return null;
  const start = $pos.start();
  const children: { from: number; to: number; mark: Mark | undefined }[] = [];
  $pos.parent.forEach((child, offset) =>
    children.push({
      from: start + offset,
      to: start + offset + child.nodeSize,
      mark: link.isInSet(child.marks),
    }),
  );
  let index = children.findIndex(
    (child) => child.mark && child.from <= pos && pos < child.to,
  );
  if (index < 0) index = children.findIndex((c) => c.mark && c.to === pos);
  const mark = children[index]?.mark;
  if (!mark) return null;
  let first = index;
  let last = index;
  while (first > 0 && children[first - 1]!.mark?.eq(mark)) first--;
  while (last < children.length - 1 && children[last + 1]!.mark?.eq(mark))
    last++;
  return {
    from: children[first]!.from,
    to: children[last]!.to,
    href: String(mark.attrs.href),
  };
}

export type LinkDraft = {
  from: number;
  to: number;
  text: string;
  href: string;
};

/**
 * What the link form starts with: the link under the caret or selection, or
 * the selected text (as the address too when it is one). Null where a link
 * cannot go: across blocks, in code, or in a read-only position.
 */
export function linkDraftFor(state: EditorState): LinkDraft | null {
  const { from, to, empty, $from, $to } = state.selection;
  if (!$from.sameParent($to) || !$from.parent.inlineContent) return null;
  if ($from.parent.type.spec.code || !$from.parent.type.allowsMarkType(link))
    return null;
  if (
    empty
      ? $from.marks().some((m) => m.type.spec.code)
      : hasCode(state, from, to)
  )
    return null;
  const existing = linkRangeAt(state.doc, from);
  if (existing && (empty || (from >= existing.from && to <= existing.to)))
    return {
      ...existing,
      text: state.doc.textBetween(existing.from, existing.to),
    };
  const text = state.doc.textBetween(from, to);
  const address = text.trim();
  const href = !/\s/.test(address) && normalizeHref(address) ? address : "";
  return { from, to, text, href };
}

/**
 * Apply the link form to the range it targets. When the person did not edit
 * the Text field, the link goes on whatever text the range holds now, so a
 * collaborator's edits there stay. Edited text replaces the range, unless the
 * range changed while the form was open (`touched`): then, as when text the
 * form was opened on has been deleted, this returns null and the form must be
 * checked again. An empty text shows the address.
 */
export function applyLink(
  state: EditorState,
  from: number,
  to: number,
  text: string,
  href: string,
  options: { textEdited?: boolean; touched?: boolean } = {},
): Transaction | null {
  const textEdited = options.textEdited ?? true;
  if (options.touched && (textEdited || from === to)) return null;
  const label = text.trim() ? text : href;
  const mark = link.create({ href });
  const tr = state.tr;
  let end = to;
  if (from < to && (!textEdited || state.doc.textBetween(from, to) === label))
    tr.addMark(from, to, mark);
  else {
    tr.insertText(label, from, to);
    end = from + label.length;
    tr.addMark(from, end, mark);
  }
  return tr.setSelection(TextSelection.create(tr.doc, end)).scrollIntoView();
}

export function removeLink(state: EditorState, from: number, to: number) {
  return state.tr.removeMark(from, to, link);
}

/**
 * Which link the UI is working on, mapped through every edit. "menu" is the
 * Open · Edit · Remove popover after a tap; it closes on local typing or when
 * the caret leaves the link. "form" is the link form's target range.
 */
export type LinkUi = {
  mode: "menu" | "form";
  from: number;
  to: number;
  /** The form's text changed (by anyone) since it opened. */
  touched?: boolean;
} | null;
export const linkUiKey = new PluginKey<LinkUi>("linkUi");

export const linkUi = new Plugin<LinkUi>({
  key: linkUiKey,
  state: {
    init: () => null,
    apply(tr, value, _old, state) {
      const meta = tr.getMeta(linkUiKey) as LinkUi | undefined;
      if (meta !== undefined) return meta;
      if (!value) return null;
      if (!tr.docChanged && (value.mode === "form" || !tr.selectionSet))
        return value;
      let { from, to } = value;
      let touched = value.touched ?? false;
      for (const map of tr.mapping.maps) {
        // A change inside the range, or an insertion strictly within it.
        map.forEach((start, end) => {
          if (
            (end > from && start < to) ||
            (start === end && start > from && start < to)
          )
            touched = true;
        });
        from = map.map(from, 1);
        to = Math.max(from, map.map(to, -1));
      }
      if (value.mode === "menu") {
        if (tr.docChanged && tr.getMeta("rebased") === undefined) return null;
        const { selection } = state;
        if (selection.from < from || selection.to > to || from === to)
          return null;
        return { mode: "menu", from, to };
      }
      return { mode: "form", from, to, touched };
    },
  },
  props: {
    handleKeyDown(view, event) {
      if (
        event.key !== "Escape" ||
        linkUiKey.getState(view.state)?.mode !== "menu"
      )
        return false;
      view.dispatch(view.state.tr.setMeta(linkUiKey, null));
      return true;
    },
  },
});
