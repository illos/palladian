import { assertSafeFragment, notesSchema } from "@palladian/notes-core/schema";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

const paragraph = notesSchema.nodes.paragraph!;
const hardBreak = notesSchema.nodes.hard_break!;
const lists = new Set(["bullet_list", "ordered_list", "task_list"]);

/** The notes-core Markdown functions the clipboard uses. */
export type MarkdownCodec = {
  parseMarkdownFragment(markdown: string): Fragment;
  blockToMarkdown(node: ProseMirrorNode): string;
};

let codec: MarkdownCodec | null = null;
let loading: Promise<MarkdownCodec> | null = null;
/**
 * Load the Markdown code after the editor opens. Startup never waits for it;
 * until it arrives, paste and copy keep ProseMirror's plain-text behaviour.
 */
export function loadMarkdown(): Promise<MarkdownCodec> {
  loading ??= import("@palladian/notes-core").then(
    (module) => (codec = module),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** True when parsed Markdown has more than plain paragraphs of plain text. */
export function hasMarkdownStructure(fragment: Fragment) {
  let found = false;
  fragment.descendants((node) => {
    if (found) return false;
    if (node.isBlock && node.type !== paragraph) found = true;
    else if (node.isText && node.marks.length) found = true;
    return !found;
  });
  return found;
}

/** Marks a line end that Markdown would join with the next line. */
const LINE = "\ue000";
// The marker follows a space so link detection never takes it into a URL.
const LINE_BREAK = / ?\ue000 ?/;
// A marked line end after parsing, where the line break itself became a space.
const MARKED_END = / \ue000(?= |$)/g;
// Code fences, also inside quotes and list items.
const FENCE = /^(?:\s*>)*\s*(?:(?:[-+*]|\d{1,9}[.)])\s+)?\s*(`{3,}|~{3,})/;
// Thematic breaks and setext heading underlines.
const RULE =
  /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|=+[ \t]*)$/;

/**
 * Mark line ends that Markdown would join with the next line: not in code,
 * not next to a rule or heading underline, not at an explicit line break.
 */
function markLines(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let fence: string | null = null;
  return lines
    .map((line, index) => {
      const match = FENCE.exec(line);
      const marker = match?.[1];
      if (fence) {
        const closes =
          marker !== undefined &&
          marker[0] === fence[0] &&
          marker.length >= fence.length &&
          !line.slice(match!.index + match![0].length).trim();
        if (closes) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      const next = lines[index + 1];
      if (
        !next?.trim() ||
        !line.trim() ||
        /^( {4}|\t)/.test(line) ||
        RULE.test(line) ||
        RULE.test(next) ||
        / {2}$|\\$/.test(line)
      )
        return line;
      return line + " " + LINE;
    })
    .join("\n");
}

/** A parse of marked text as it reads without the markers. */
function withoutMarkers(fragment: Fragment): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      const text = node.text!.replace(MARKED_END, "");
      if (text) nodes.push(notesSchema.text(text, node.marks));
    } else
      nodes.push(node.isLeaf ? node : node.copy(withoutMarkers(node.content)));
  });
  return Fragment.fromArray(nodes);
}

/**
 * Keep the pasted lines as separate lines where Markdown would join them
 * (Deltos's paste was line-based). The text is parsed again with line ends
 * marked, and that parse is used only if, markers aside, it is exactly the
 * plain one, so delimiters, code and literal text stay as parsed.
 */
function keepLines(text: string, parsed: Fragment, markdown: MarkdownCodec) {
  if (text.includes(LINE)) return parsed;
  const marked = markLines(text);
  if (!marked.includes(LINE)) return parsed;
  try {
    const lines = markdown.parseMarkdownFragment(marked);
    return withoutMarkers(lines).eq(parsed) ? splitLines(lines) : parsed;
  } catch {
    return parsed;
  }
}

/** Marked line ends split paragraphs; anywhere else they are dropped. */
function splitLines(fragment: Fragment): Fragment {
  const blocks: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (!node.isTextblock) {
      blocks.push(node.isLeaf ? node : node.copy(splitLines(node.content)));
      return;
    }
    const lines: ProseMirrorNode[][] = [[]];
    node.forEach((child) => {
      if (!child.isText || !child.text!.includes(LINE)) {
        lines[lines.length - 1]!.push(child);
        return;
      }
      child.text!.split(LINE_BREAK).forEach((part, index) => {
        if (index) {
          if (node.type === paragraph) lines.push([]);
          else if (part) part = " " + part;
        }
        if (part)
          lines[lines.length - 1]!.push(notesSchema.text(part, child.marks));
      });
    });
    if (lines.length > 1 && !lines[lines.length - 1]!.length) lines.pop();
    for (const line of lines) blocks.push(node.copy(Fragment.fromArray(line)));
  });
  return Fragment.fromArray(blocks);
}

/**
 * Plain text as structure when it is Markdown, else null for the default
 * paste. A leading or trailing paragraph stays open, so an inline snippet
 * merges into the current line (Deltos's `markdownTextToSlice`).
 */
export function markdownSlice(text: string, markdown: MarkdownCodec) {
  let fragment: Fragment;
  try {
    fragment = markdown.parseMarkdownFragment(text);
  } catch {
    return null;
  }
  if (!fragment.childCount || !hasMarkdownStructure(fragment)) return null;
  fragment = keepLines(text, fragment, markdown);
  return safeSlice(
    new Slice(
      fragment,
      fragment.firstChild!.type === paragraph ? 1 : 0,
      fragment.lastChild!.type === paragraph ? 1 : 0,
    ),
  );
}

const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LANGUAGE = /^[\w+#.-]{0,40}$/;
function clip(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

/**
 * Pasted content within the limits the server checks for every step
 * (`assertSafeNode`): list numbering, titles, alt text, code languages and
 * block IDs. A value outside them would make the server refuse the edit and
 * stop the note from saving.
 */
function withinLimits(fragment: Fragment): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    const marks = node.marks.map((mark) =>
      mark.type.name === "link" && mark.attrs.title !== null
        ? mark.type.create({
            ...mark.attrs,
            title: clip(mark.attrs.title, 500),
          })
        : mark,
    );
    if (node.isText) {
      nodes.push(node.mark(marks));
      return;
    }
    const attrs: Record<string, unknown> = { ...node.attrs };
    if (
      "id" in attrs &&
      attrs.id !== null &&
      !(typeof attrs.id === "string" && BLOCK_ID.test(attrs.id))
    )
      attrs.id = null;
    if (node.type.name === "ordered_list") {
      const order = Number(attrs.order);
      attrs.order = Number.isSafeInteger(order)
        ? Math.min(Math.max(order, 0), 1_000_000)
        : 1;
    }
    if (node.type.name === "image") {
      attrs.alt = clip(attrs.alt, 1000);
      attrs.title = clip(attrs.title, 500);
    }
    if (
      node.type.name === "code_block" &&
      !(typeof attrs.language === "string" && LANGUAGE.test(attrs.language))
    )
      attrs.language = "";
    nodes.push(node.type.create(attrs, withinLimits(node.content), marks));
  });
  return Fragment.fromArray(nodes);
}

/**
 * The editor's `transformPasted`, also used for Markdown: pasted content
 * kept within the server's limits; anything still refused pastes as text.
 */
export function safeSlice(slice: Slice): Slice {
  const content = withinLimits(slice.content);
  try {
    assertSafeFragment(content);
    return new Slice(content, slice.openStart, slice.openEnd);
  } catch {
    const lines = slice.content
      .textBetween(0, slice.content.size, "\n", " ")
      .split("\n")
      .map((line) =>
        paragraph.create(null, line ? notesSchema.text(line) : null),
      );
    return new Slice(Fragment.fromArray(lines), 1, 1);
  }
}

/** A pasted slice with nothing but unformatted paragraphs, e.g. from a code editor. */
export function isPlainSlice(slice: Slice) {
  let plain = true;
  slice.content.forEach((node) => {
    if (node.type !== paragraph) plain = false;
    else
      node.forEach((child) => {
        if (!child.isText || child.marks.length) plain = false;
      });
  });
  return plain;
}

/**
 * Paste: Markdown text arrives as headings, lists and formatting. Rich HTML
 * keeps ProseMirror's own parsing; code keeps the literal text.
 */
export function pasteMarkdown(
  view: EditorView,
  event: ClipboardEvent,
  slice: Slice,
): boolean {
  const data = event.clipboardData;
  const { $from } = view.state.selection;
  if (!codec || !data || $from.parent.type.spec.code) return false;
  if ($from.marks().some((mark) => mark.type.spec.code)) return false;
  const text = data.getData("text/plain");
  if (!text.trim()) return false;
  const html = data.getData("text/html");
  // Palladian's own copies (`data-pm-slice`) and rich HTML keep their structure.
  if (html && (html.includes("data-pm-slice") || !isPlainSlice(slice)))
    return false;
  const parsed = markdownSlice(text, codec);
  if (!parsed) return false;
  view.dispatch(
    view.state.tr
      .replaceSelection(parsed)
      .scrollIntoView()
      .setMeta("paste", true)
      .setMeta("uiEvent", "paste"),
  );
  return true;
}

function inlineText(content: Fragment, markdown: MarkdownCodec) {
  let plain = true;
  content.forEach((child) => {
    if (child.type !== hardBreak && (!child.isText || child.marks.length))
      plain = false;
  });
  if (plain)
    return content.textBetween(0, content.size, undefined, (leaf) =>
      leaf.type === hardBreak ? "\n" : "",
    );
  return markdown.blockToMarkdown(paragraph.create(null, content));
}

/**
 * Copy: the plain-text clipboard gets Markdown. Text from within one line
 * copies as that line's text (with inline formatting), not as a list item or
 * heading; whole blocks copy as the note's canonical Markdown.
 */
export function clipboardText(slice: Slice, markdown: MarkdownCodec | null) {
  let { content, openStart, openEnd } = slice;
  if (!markdown) return content.textBetween(0, content.size, "\n\n");
  for (;;) {
    const node = content.firstChild;
    if (content.childCount !== 1 || !node || node.isTextblock || node.isLeaf)
      break;
    if (lists.has(node.type.name)) {
      const item = node.firstChild!;
      if (node.childCount !== 1 || item.childCount !== 1) break;
      if (openStart < 2 || openEnd < 2) break;
      content = item.content;
      openStart -= 2;
      openEnd -= 2;
      continue;
    }
    if (node.childCount !== 1 || openStart < 1 || openEnd < 1) break;
    content = node.content;
    openStart--;
    openEnd--;
  }
  const only = content.childCount === 1 ? content.firstChild : null;
  if (only?.isTextblock && (openStart > 0 || openEnd > 0))
    return only.type.spec.code
      ? only.textContent
      : inlineText(only.content, markdown);
  if (content.childCount && content.firstChild!.isInline)
    return inlineText(content, markdown);
  const parts: string[] = [];
  content.forEach((node) => parts.push(markdown.blockToMarkdown(node)));
  return parts.join("\n\n");
}

/** The editor's `clipboardTextSerializer`. */
export function serializeClipboardText(slice: Slice) {
  return clipboardText(slice, codec);
}

const ACTIVE =
  "script, style, link, meta, iframe, object, embed, noscript, template, base";

/** Inline styles that mean bold, italics or strike become tags before styles go. */
function keepStyledMarks(element: HTMLElement) {
  const style = element.style;
  const name = element.localName;
  const document = element.ownerDocument;
  if (
    (name === "b" || name === "strong") &&
    /^(normal|400)$/.test(style.fontWeight)
  ) {
    // Google Docs wraps a whole copy in <b style="font-weight:normal">.
    const span = document.createElement("span");
    span.append(...Array.from(element.childNodes));
    element.replaceWith(span);
    return;
  }
  const tags: string[] = [];
  if (
    /^(bold|bolder|[5-9]\d\d)$/.test(style.fontWeight) &&
    name !== "b" &&
    name !== "strong"
  )
    tags.push("strong");
  if (style.fontStyle === "italic" && name !== "i" && name !== "em")
    tags.push("em");
  if (/line-through/.test(style.textDecoration || style.textDecorationLine))
    tags.push("s");
  for (const tag of tags) {
    const wrapper = document.createElement(tag);
    wrapper.append(...Array.from(element.childNodes));
    element.append(wrapper);
  }
}

/**
 * Pasted HTML is parsed in an inert document (nothing loads or runs, unlike
 * Deltos's live `innerHTML`), then loses script and style elements, event
 * handler attributes and inline styles.
 */
export function sanitizePastedHtml(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const element of Array.from(document.querySelectorAll(ACTIVE)))
    element.remove();
  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    if (element.hasAttribute("style") && "style" in element)
      keepStyledMarks(element as HTMLElement);
    for (const attribute of Array.from(element.attributes))
      if (/^on/i.test(attribute.name) || attribute.name === "style")
        element.removeAttribute(attribute.name);
  }
  return document.body.innerHTML;
}
