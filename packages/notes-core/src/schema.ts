import {
  Schema,
  type DOMOutputSpec,
  type Fragment,
  type Mark,
  type Node as ProseMirrorNode,
  type NodeSpec,
  type MarkSpec,
} from "prosemirror-model";

/**
 * Every block carries a stable `id` used for agent targeting and history.
 * IDs are internal: they never split ordinary writing into separate boxes.
 */
const id = { id: { default: null } };

function blockAttrs(node: ProseMirrorNode) {
  return node.attrs.id ? { "data-block-id": String(node.attrs.id) } : {};
}
function readId(dom: HTMLElement | string) {
  return typeof dom === "string" ? null : dom.getAttribute("data-block-id");
}

export function isSafeHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length > 2048) return false;
  return /^(https?:|mailto:)/i.test(href.trim());
}
/** Images reference uploaded objects or public web addresses; no inline data. */
export function isSafeImageSource(src: unknown): src is string {
  if (typeof src !== "string" || src.length > 2048) return false;
  return /^(https:|attachment:)/i.test(src.trim());
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: {
    group: "block",
    content: "inline*",
    attrs: id,
    parseDOM: [{ tag: "p", getAttrs: (dom) => ({ id: readId(dom) }) }],
    toDOM: (node): DOMOutputSpec => ["p", blockAttrs(node), 0],
  },
  heading: {
    group: "block",
    content: "inline*",
    attrs: { ...id, level: { default: 1 } },
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: "h" + level,
      getAttrs: (dom: HTMLElement | string) => ({
        id: readId(dom),
        level: Math.min(level, 3),
      }),
    })),
    toDOM: (node): DOMOutputSpec => [
      "h" + Number(node.attrs.level),
      blockAttrs(node),
      0,
    ],
  },
  blockquote: {
    group: "block",
    content: "block+",
    attrs: id,
    defining: true,
    parseDOM: [{ tag: "blockquote", getAttrs: (dom) => ({ id: readId(dom) }) }],
    toDOM: (node): DOMOutputSpec => ["blockquote", blockAttrs(node), 0],
  },
  code_block: {
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    attrs: { ...id, language: { default: "" } },
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs: (dom) => ({ id: readId(dom) }),
      },
    ],
    toDOM: (node): DOMOutputSpec => ["pre", blockAttrs(node), ["code", 0]],
  },
  horizontal_rule: {
    group: "block",
    attrs: id,
    parseDOM: [{ tag: "hr", getAttrs: (dom) => ({ id: readId(dom) }) }],
    toDOM: (node): DOMOutputSpec => ["hr", blockAttrs(node)],
  },
  bullet_list: {
    group: "block",
    content: "list_item+",
    attrs: id,
    parseDOM: [{ tag: "ul", getAttrs: (dom) => ({ id: readId(dom) }) }],
    toDOM: (node): DOMOutputSpec => ["ul", blockAttrs(node), 0],
  },
  ordered_list: {
    group: "block",
    content: "list_item+",
    attrs: { ...id, order: { default: 1 } },
    parseDOM: [
      {
        tag: "ol",
        getAttrs: (dom) => ({
          id: readId(dom),
          order:
            typeof dom === "string"
              ? 1
              : Number(dom.getAttribute("start") ?? 1) || 1,
        }),
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      "ol",
      {
        ...blockAttrs(node),
        ...(node.attrs.order === 1 ? {} : { start: node.attrs.order }),
      },
      0,
    ],
  },
  list_item: {
    content: "paragraph block*",
    attrs: id,
    defining: true,
    parseDOM: [{ tag: "li", getAttrs: (dom) => ({ id: readId(dom) }) }],
    toDOM: (node): DOMOutputSpec => ["li", blockAttrs(node), 0],
  },
  task_list: {
    group: "block",
    content: "task_item+",
    attrs: id,
    parseDOM: [
      {
        tag: "ul[data-type=tasks]",
        priority: 60,
        getAttrs: (dom) => ({ id: readId(dom) }),
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      "ul",
      { ...blockAttrs(node), "data-type": "tasks" },
      0,
    ],
  },
  task_item: {
    content: "paragraph block*",
    attrs: { ...id, checked: { default: false } },
    defining: true,
    parseDOM: [
      {
        tag: "li[data-checked]",
        priority: 60,
        getAttrs: (dom) => ({
          id: readId(dom),
          checked:
            typeof dom !== "string" &&
            dom.getAttribute("data-checked") === "true",
        }),
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      "li",
      { ...blockAttrs(node), "data-checked": String(!!node.attrs.checked) },
      0,
    ],
  },
  image: {
    group: "block",
    attrs: { ...id, src: {}, alt: { default: null }, title: { default: null } },
    draggable: true,
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom) => {
          if (typeof dom === "string") return false;
          const src = dom.getAttribute("src");
          if (!isSafeImageSource(src)) return false;
          return {
            id: readId(dom),
            src,
            alt: dom.getAttribute("alt"),
            title: dom.getAttribute("title"),
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      "img",
      {
        ...blockAttrs(node),
        // Never render a source the schema would not accept.
        ...(isSafeImageSource(node.attrs.src) ? { src: node.attrs.src } : {}),
        alt: node.attrs.alt,
        title: node.attrs.title,
      },
    ],
  },
  text: { group: "inline" },
  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: (): DOMOutputSpec => ["br"],
  },
};

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) => {
          if (typeof dom === "string") return false;
          const href = dom.getAttribute("href");
          return isSafeHref(href)
            ? { href, title: dom.getAttribute("title") }
            : false;
        },
      },
    ],
    toDOM: (mark): DOMOutputSpec => [
      "a",
      {
        ...(isSafeHref(mark.attrs.href) ? { href: mark.attrs.href } : {}),
        title: mark.attrs.title,
        rel: "noopener noreferrer",
      },
      0,
    ],
  },
  em: {
    parseDOM: [
      { tag: "i" },
      { tag: "em" },
      { style: "font-style=italic" },
      { style: "font-style=normal", clearMark: (m) => m.type.name === "em" },
    ],
    toDOM: (): DOMOutputSpec => ["em", 0],
  },
  strong: {
    parseDOM: [
      { tag: "strong" },
      {
        tag: "b",
        getAttrs: (node) =>
          typeof node !== "string" && node.style.fontWeight !== "normal"
            ? null
            : false,
      },
      {
        style: "font-weight=400",
        clearMark: (m) => m.type.name === "strong",
      },
      {
        style: "font-weight",
        getAttrs: (value) =>
          typeof value === "string" && /^(bold(er)?|[5-9]\d{2,})$/.test(value)
            ? null
            : false,
      },
    ],
    toDOM: (): DOMOutputSpec => ["strong", 0],
  },
  strike: {
    parseDOM: [
      { tag: "s" },
      { tag: "del" },
      { tag: "strike" },
      { style: "text-decoration=line-through" },
      { style: "text-decoration-line=line-through" },
    ],
    toDOM: (): DOMOutputSpec => ["s", 0],
  },
  code: {
    code: true,
    excludes: "_",
    parseDOM: [{ tag: "code" }],
    toDOM: (): DOMOutputSpec => ["code", 0],
  },
};

export const notesSchema = new Schema({ nodes, marks });
export type NotesSchema = typeof notesSchema;

/** Node types that carry a stable block identity. */
export function hasBlockId(node: ProseMirrorNode) {
  return node.type.spec.attrs?.id !== undefined;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LANGUAGE_PATTERN = /^[\w+#.-]{0,40}$/;
function optionalText(value: unknown, max: number) {
  return value === null || (typeof value === "string" && value.length <= max);
}

export class UnsafeDocumentError extends Error {}

/**
 * Attribute validation for documents arriving from clients as JSON or steps.
 * `Node.check()` validates structure only; this enforces the same link and
 * image rules as parsing, and sane values for every other attribute.
 */
function unsafe(message: string): never {
  throw new UnsafeDocumentError(message);
}

/** Validate one mark's attributes. */
export function assertSafeMark(mark: Mark): void {
  if (mark.type.name !== "link") return;
  if (!isSafeHref(mark.attrs.href))
    unsafe("Links must use http, https or mailto.");
  if (!optionalText(mark.attrs.title, 500)) unsafe("Invalid link title.");
}

/** Validate one node's own attributes and marks (not its children). */
export function assertSafeNode(node: ProseMirrorNode): void {
  for (const mark of node.marks) assertSafeMark(mark);
  if (hasBlockId(node)) {
    const id = node.attrs.id;
    if (id !== null && (typeof id !== "string" || !ID_PATTERN.test(id)))
      unsafe("Invalid block identity.");
  }
  switch (node.type.name) {
    case "image":
      if (!isSafeImageSource(node.attrs.src))
        unsafe("Images must use https or an attachment reference.");
      if (
        !optionalText(node.attrs.alt, 1000) ||
        !optionalText(node.attrs.title, 500)
      )
        unsafe("Invalid image text.");
      break;
    case "heading":
      if (![1, 2, 3].includes(node.attrs.level))
        unsafe("Invalid heading level.");
      break;
    case "ordered_list":
      if (
        !Number.isSafeInteger(node.attrs.order) ||
        node.attrs.order < 0 ||
        node.attrs.order > 1_000_000
      )
        unsafe("Invalid list start.");
      break;
    case "task_item":
      if (typeof node.attrs.checked !== "boolean")
        unsafe("Invalid checklist state.");
      break;
    case "code_block":
      if (
        typeof node.attrs.language !== "string" ||
        !LANGUAGE_PATTERN.test(node.attrs.language)
      )
        unsafe("Invalid code language.");
      break;
  }
}

/**
 * Attribute validation for documents arriving from clients as JSON or steps.
 * `Node.check()` validates structure only; this enforces the same link and
 * image rules as parsing, and sane values for every other attribute.
 */
export function assertSafeDocument(doc: ProseMirrorNode): void {
  doc.descendants((node) => {
    assertSafeNode(node);
    return true;
  });
}

/** Validate every node in a fragment, such as the content a step inserts. */
export function assertSafeFragment(fragment: Fragment): void {
  fragment.descendants((node) => {
    assertSafeNode(node);
    return true;
  });
}
