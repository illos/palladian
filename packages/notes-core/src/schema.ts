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

/**
 * Uploaded objects (B1) are referenced as `attachment:<objectId>`. Object IDs
 * are opaque backend document IDs: lowercase letters and digits only, so a
 * reference can never smuggle a path, query or other scheme.
 */
export const ATTACHMENT_SCHEME = "attachment:";
const OBJECT_ID_PATTERN = /^[a-z0-9]{16,64}$/;
export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}
export function attachmentSource(objectId: string): string {
  return ATTACHMENT_SCHEME + objectId;
}
/** The object ID an `attachment:` reference names, or null for anything else. */
export function attachmentObjectId(src: unknown): string | null {
  if (typeof src !== "string" || !src.startsWith(ATTACHMENT_SCHEME))
    return null;
  const objectId = src.slice(ATTACHMENT_SCHEME.length);
  return isObjectId(objectId) ? objectId : null;
}

/** Images reference uploaded objects or public web addresses; no inline data. */
export function isSafeImageSource(src: unknown): src is string {
  if (typeof src !== "string" || src.length > 2048) return false;
  return /^https:/i.test(src.trim()) || attachmentObjectId(src) !== null;
}

/**
 * The image sources accepted before attachments existed: `https:` or any
 * `attachment:` text, in any case, with outer spaces. Documents already
 * stored (current content, checkpoints, history) may keep them so they still
 * open and edit; a loose `attachment:` source names no object and so grants
 * nothing. New content must use `isSafeImageSource`.
 */
export function isLegacyImageSource(src: unknown): src is string {
  if (typeof src !== "string" || src.length > 2048) return false;
  return /^(https:|attachment:)/i.test(src.trim());
}

/** A resized image's display width in CSS pixels; null shows natural size. */
export const IMAGE_WIDTH_MIN = 32;
export const IMAGE_WIDTH_MAX = 4096;
export function isImageWidth(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= IMAGE_WIDTH_MIN &&
    value <= IMAGE_WIDTH_MAX
  );
}

/** File names: 1–255 characters, no control characters, no outer spaces. */
export const FILE_NAME_LIMIT = 255;
export function isFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= FILE_NAME_LIMIT &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value)
  );
}

/**
 * A media type as stored on file blocks: lowercase `type/subtype` from a
 * conservative character set, so it also survives the Markdown attribute
 * syntax unescaped. Parameters (`; charset=…`) are not kept.
 */
const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/;
export function isMimeType(value: unknown): value is string {
  return typeof value === "string" && MIME_TYPE_PATTERN.test(value);
}

/** Recorded file sizes, in bytes; bounded well above any upload limit. */
export const FILE_SIZE_LIMIT = 1_000_000_000_000;
export function isFileSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= FILE_SIZE_LIMIT
  );
}

/** Whether a file block's attributes are acceptable (see `assertSafeNode`). */
export function isSafeFileAttrs(attrs: {
  objectId: unknown;
  name: unknown;
  mimeType: unknown;
  size: unknown;
}): boolean {
  return (
    isObjectId(attrs.objectId) &&
    isFileName(attrs.name) &&
    (attrs.mimeType === "" || isMimeType(attrs.mimeType)) &&
    (attrs.size === null || isFileSize(attrs.size))
  );
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
    attrs: {
      ...id,
      src: {},
      alt: { default: null },
      title: { default: null },
      width: { default: null },
    },
    draggable: true,
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom) => {
          if (typeof dom === "string") return false;
          const src = dom.getAttribute("src");
          if (!isSafeImageSource(src)) return false;
          const width = Number(dom.getAttribute("width"));
          return {
            id: readId(dom),
            src,
            alt: dom.getAttribute("alt"),
            title: dom.getAttribute("title"),
            width: isImageWidth(width) ? width : null,
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
        ...(isImageWidth(node.attrs.width)
          ? { width: String(node.attrs.width) }
          : {}),
      },
    ],
  },
  /**
   * An uploaded file other than an inline image: a reference to the object
   * plus the name, media type and size shown before its bytes load. In
   * Markdown it is a link to `attachment:<objectId>` labelled with the name.
   */
  file: {
    group: "block",
    atom: true,
    draggable: true,
    attrs: {
      ...id,
      objectId: {},
      name: {},
      mimeType: { default: "" },
      size: { default: null },
    },
    parseDOM: [
      {
        tag: "div[data-object-id]",
        getAttrs: (dom) => {
          if (typeof dom === "string") return false;
          const size = dom.getAttribute("data-size");
          const attrs = {
            id: readId(dom),
            objectId: dom.getAttribute("data-object-id"),
            name: dom.getAttribute("data-name"),
            mimeType: dom.getAttribute("data-mime-type") ?? "",
            size: size === null ? null : Number(size),
          };
          return isSafeFileAttrs(attrs) ? attrs : false;
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      // Never render attributes the schema would not accept.
      const { objectId, name, mimeType, size } = node.attrs;
      const safe = isSafeFileAttrs({ objectId, name, mimeType, size });
      return [
        "div",
        {
          ...blockAttrs(node),
          ...(safe
            ? {
                "data-object-id": objectId,
                "data-name": name,
                "data-mime-type": mimeType,
                ...(size === null ? {} : { "data-size": String(size) }),
              }
            : {}),
        },
        safe ? String(name) : "",
      ];
    },
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

/**
 * Validate one node's own attributes and marks (not its children). With
 * `legacySources`, an image may keep a source from before attachments
 * (`isLegacyImageSource`); only stored documents are checked that way.
 */
export function assertSafeNode(
  node: ProseMirrorNode,
  options: { legacySources?: boolean } = {},
): void {
  for (const mark of node.marks) assertSafeMark(mark);
  if (hasBlockId(node)) {
    const id = node.attrs.id;
    if (id !== null && (typeof id !== "string" || !ID_PATTERN.test(id)))
      unsafe("Invalid block identity.");
  }
  switch (node.type.name) {
    case "image":
      if (
        !isSafeImageSource(node.attrs.src) &&
        !(options.legacySources && isLegacyImageSource(node.attrs.src))
      )
        unsafe("Images must use https or an attachment reference.");
      if (
        !optionalText(node.attrs.alt, 1000) ||
        !optionalText(node.attrs.title, 500)
      )
        unsafe("Invalid image text.");
      if (node.attrs.width !== null && !isImageWidth(node.attrs.width))
        unsafe("Invalid image width.");
      break;
    case "file": {
      const { objectId, name, mimeType, size } = node.attrs;
      if (!isSafeFileAttrs({ objectId, name, mimeType, size }))
        unsafe("Invalid file attachment.");
      break;
    }
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
export function assertSafeDocument(
  doc: ProseMirrorNode,
  options: { legacySources?: boolean } = {},
): void {
  doc.descendants((node) => {
    assertSafeNode(node, options);
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
