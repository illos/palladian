import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
} from "prosemirror-markdown";
import { Fragment, type Node as ProseMirrorNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { assignBlockIds } from "./ids.ts";
import {
  attachmentObjectId,
  attachmentSource,
  FILE_NAME_LIMIT,
  isFileSize,
  isImageWidth,
  isMimeType,
  isSafeHref,
  isSafeImageSource,
  notesSchema,
} from "./schema.ts";

/** Markdown accepted from agents and imports; raw HTML is treated as text. */
export const MARKDOWN_LIMIT = 500_000;

const tokenizer = MarkdownIt("commonmark", {
  html: false,
  linkify: true,
}).enable(["strikethrough", "linkify"]);

const TASK = /^\[([ xX])\](?:[ \t]+|$)/;

function closingIndex(tokens: Token[], open: number) {
  const level = tokens[open]!.level;
  const closeType = tokens[open]!.type.replace(/_open$/, "_close");
  for (let i = open + 1; i < tokens.length; i++)
    if (tokens[i]!.type === closeType && tokens[i]!.level === level) return i;
  return -1;
}

/** Remove link marks whose destination is not an allowed web or mail link. */
function sanitizeInline(children: Token[]) {
  const drop = new Set<number>();
  const stack: { index: number; unsafe: boolean }[] = [];
  children.forEach((token, index) => {
    if (token.type === "link_open") {
      const unsafe = !isSafeHref(token.attrGet("href"));
      stack.push({ index, unsafe });
      if (unsafe) drop.add(index);
    } else if (token.type === "link_close") {
      if (stack.pop()?.unsafe) drop.add(index);
    }
  });
  return children.filter((_, index) => !drop.has(index));
}

/** Rewrite list items that all begin with `[ ]` or `[x]` into a task list. */
function convertTaskLists(tokens: Token[]) {
  for (let open = 0; open < tokens.length; open++) {
    if (tokens[open]!.type !== "bullet_list_open") continue;
    const close = closingIndex(tokens, open);
    const level = tokens[open]!.level;
    const items: { open: number; close: number; inline: Token }[] = [];
    for (let i = open + 1; i < close; i++) {
      const token = tokens[i]!;
      if (token.type !== "list_item_open" || token.level !== level + 1)
        continue;
      const inline =
        tokens[i + 1]?.type === "paragraph_open" ? tokens[i + 2] : undefined;
      if (!inline || inline.type !== "inline" || !TASK.test(inline.content)) {
        items.length = 0;
        break;
      }
      items.push({ open: i, close: closingIndex(tokens, i), inline });
    }
    if (!items.length) continue;
    tokens[open]!.type = "task_list_open";
    tokens[close]!.type = "task_list_close";
    for (const item of items) {
      const match = TASK.exec(item.inline.content)!;
      const checked = match[1] !== " ";
      item.inline.content = item.inline.content.slice(match[0].length);
      const first = item.inline.children?.[0];
      if (first?.type === "text") {
        const prefix = TASK.exec(first.content);
        if (prefix) first.content = first.content.slice(prefix[0].length);
      }
      tokens[item.open]!.type = "task_item_open";
      tokens[item.open]!.attrSet("checked", String(checked));
      tokens[item.close]!.type = "task_item_close";
    }
  }
}

/**
 * Attributes written directly after an image or attachment link, in the
 * Pandoc style: `![chart](attachment:…){width=480}` and
 * `[report.pdf](attachment:…){type=application/pdf size=24576}`. Only known
 * keys with valid values are read; anything else stays literal text.
 */
const ATTRIBUTES = /^\{([^{}\n]{1,300})\}/;
type Readers = Record<string, (value: string) => boolean>;
const IMAGE_ATTRIBUTES: Readers = {
  width: (value) => /^\d{1,5}$/.test(value) && isImageWidth(Number(value)),
};
const FILE_ATTRIBUTES: Readers = {
  type: (value) => isMimeType(value),
  size: (value) => /^\d{1,13}$/.test(value) && isFileSize(Number(value)),
};

/**
 * Literal text. This rule runs before markdown-it joins text, so an escaped
 * character is still its own `text_special` token.
 */
function isText(token: Token) {
  return token.type === "text" || token.type === "text_special";
}

/** Read and remove an attribute block starting at `children[index]`. */
function takeAttributes(
  children: Token[],
  index: number,
  readers: Readers,
): Record<string, string> {
  let end = index;
  let text = "";
  while (end < children.length && isText(children[end]!))
    text += children[end++]!.content;
  const match = ATTRIBUTES.exec(text);
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const pair of match[1]!.trim().split(/\s+/)) {
    const [, key, value] = /^([a-z]+)=(\S+)$/.exec(pair) ?? [];
    if (!key || !value || key in values || !readers[key]?.(value)) return {};
    values[key] = value;
  }
  let remove = match[0].length;
  for (let k = index; k < end && remove > 0; k++) {
    const token = children[k]!;
    const cut = Math.min(remove, token.content.length);
    token.content = token.content.slice(cut);
    remove -= cut;
  }
  for (let k = end - 1; k >= index; k--)
    if (!children[k]!.content) children.splice(k, 1);
  return values;
}

/** A link label as plain text, made into an acceptable file name. */
function fileName(tokens: Token[]) {
  const text = tokens
    .map((token) =>
      isText(token) || token.type === "code_inline"
        ? token.content
        : token.type === "softbreak" || token.type === "hardbreak"
          ? " "
          : "",
    )
    .join("")
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, FILE_NAME_LIMIT)
    .trim();
  return text || "Attachment";
}

/**
 * Turn each link to `attachment:<objectId>` into one `file_ref` token with its
 * name and attributes, and read image attributes, before unsafe links are
 * dropped: an attachment link is a file block, not a web link.
 */
function collectAttachments(children: Token[], TokenClass: typeof Token) {
  const result = [...children];
  for (let i = 0; i < result.length; i++) {
    const token = result[i]!;
    if (token.type === "image") {
      const { width } = takeAttributes(result, i + 1, IMAGE_ATTRIBUTES);
      if (width) token.attrSet("width", width);
      continue;
    }
    if (token.type !== "link_open") continue;
    const objectId = attachmentObjectId(token.attrGet("href"));
    if (!objectId) continue;
    const close = result.findIndex(
      (other, k) => k > i && other.type === "link_close",
    );
    if (close < 0) continue;
    const ref = new TokenClass("file_ref", "", 0);
    ref.attrSet("objectId", objectId);
    ref.attrSet("name", fileName(result.slice(i + 1, close)));
    const attributes = takeAttributes(result, close + 1, FILE_ATTRIBUTES);
    if (attributes.type) ref.attrSet("mimeType", attributes.type);
    if (attributes.size) ref.attrSet("size", attributes.size);
    result.splice(i, close - i + 1, ref);
  }
  return result;
}

/** Outside paragraphs (headings), images and files can only be their text. */
function flattenAttachments(children: Token[], TokenClass: typeof Token) {
  return children.flatMap((child) => {
    if (child.type !== "image" && child.type !== "file_ref") return [child];
    const label =
      child.type === "image"
        ? (child.children?.map((c) => c.content).join("") ?? "")
        : (child.attrGet("name") ?? "");
    if (!label) return [];
    const text = new TokenClass("text", "", 0);
    text.content = label;
    return [text];
  });
}

/** Images and files are blocks in notes: lift them out of paragraphs. */
function liftBlocks(state: { tokens: Token[]; Token: typeof Token }) {
  const tokens = state.tokens;
  tokens.forEach((token, index) => {
    if (
      token.type === "inline" &&
      token.children &&
      tokens[index - 1]?.type !== "paragraph_open"
    )
      token.children = flattenAttachments(token.children, state.Token);
  });
  for (let i = tokens.length - 3; i >= 0; i--) {
    const open = tokens[i]!;
    const inline = tokens[i + 1]!;
    if (open.type !== "paragraph_open" || inline.type !== "inline") continue;
    const children = inline.children ?? [];
    if (!children.some((c) => c.type === "image" || c.type === "file_ref"))
      continue;
    const blocks: Token[] = [];
    const kept: Token[] = [];
    for (const child of children) {
      if (child.type === "file_ref") {
        const block = new state.Token("file_block", "div", 0);
        for (const name of ["objectId", "name", "mimeType", "size"]) {
          const value = child.attrGet(name);
          if (value !== null) block.attrSet(name, value);
        }
        block.level = open.level;
        block.block = true;
        blocks.push(block);
        continue;
      }
      if (child.type !== "image") {
        kept.push(child);
        continue;
      }
      const src = child.attrGet("src");
      const alt = child.children?.map((c) => c.content).join("") ?? "";
      if (!isSafeImageSource(src)) {
        if (alt) {
          const text = new state.Token("text", "", 0);
          text.content = alt;
          kept.push(text);
        }
        continue;
      }
      const block = new state.Token("image_block", "img", 0);
      block.attrSet("src", src);
      if (alt) block.attrSet("alt", alt);
      const title = child.attrGet("title");
      if (title) block.attrSet("title", title);
      const width = child.attrGet("width");
      if (width) block.attrSet("width", width);
      block.level = open.level;
      block.block = true;
      blocks.push(block);
    }
    const hasText = kept.some(
      (child) =>
        !(child.type === "softbreak" || child.type === "hardbreak") &&
        !(child.type === "text" && !child.content.trim()),
    );
    inline.children = kept;
    tokens.splice(i + 3, 0, ...blocks);
    if (!hasText) tokens.splice(i, 3);
  }
}

tokenizer.core.ruler.after("inline", "palladian_notes", (state) => {
  for (const token of state.tokens)
    if (token.type === "inline" && token.children)
      token.children = sanitizeInline(
        collectAttachments(token.children, state.Token),
      );
  convertTaskLists(state.tokens);
  liftBlocks(state);
  return true;
});

const parser = new MarkdownParser(notesSchema, tokenizer, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "list_item" },
  bullet_list: { block: "bullet_list" },
  ordered_list: {
    block: "ordered_list",
    getAttrs: (tok) => ({ order: Number(tok.attrGet("start")) || 1 }),
  },
  task_list: { block: "task_list" },
  task_item: {
    block: "task_item",
    getAttrs: (tok) => ({ checked: tok.attrGet("checked") === "true" }),
  },
  heading: {
    block: "heading",
    getAttrs: (tok) => ({
      level: Math.min(Math.max(Number(tok.tag.slice(1)) || 1, 1), 3),
    }),
  },
  code_block: { block: "code_block", noCloseToken: true },
  fence: {
    block: "code_block",
    getAttrs: (tok) => ({
      language:
        (tok.info || "")
          .trim()
          .split(/\s+/)[0]
          ?.replace(/[^\w+#.-]/g, "")
          .slice(0, 40) ?? "",
    }),
    noCloseToken: true,
  },
  hr: { node: "horizontal_rule" },
  image_block: {
    node: "image",
    getAttrs: (tok) => ({
      src: tok.attrGet("src"),
      alt: tok.attrGet("alt") || null,
      title: tok.attrGet("title") || null,
      width: tok.attrGet("width") ? Number(tok.attrGet("width")) : null,
    }),
  },
  file_block: {
    node: "file",
    getAttrs: (tok) => ({
      objectId: tok.attrGet("objectId"),
      name: tok.attrGet("name"),
      mimeType: tok.attrGet("mimeType") ?? "",
      size: tok.attrGet("size") === null ? null : Number(tok.attrGet("size")),
    }),
  },
  hardbreak: { node: "hard_break" },
  em: { mark: "em" },
  strong: { mark: "strong" },
  s: { mark: "strike" },
  link: {
    mark: "link",
    getAttrs: (tok) => ({
      href: tok.attrGet("href"),
      title: tok.attrGet("title") || null,
    }),
  },
  code_inline: { mark: "code", noCloseToken: true },
});

export class MarkdownLimitError extends Error {}

/** Parse Markdown into blocks without IDs; callers assign IDs in context. */
export function parseMarkdownFragment(markdown: string): Fragment {
  if (markdown.length > MARKDOWN_LIMIT)
    throw new MarkdownLimitError("Markdown exceeds the supported size.");
  const doc = parser.parse(markdown.replace(/\r\n?/g, "\n"));
  return doc.content;
}

/** Parse a complete note document with fresh block IDs. */
export function markdownToDoc(markdown: string): ProseMirrorNode {
  const content = parseMarkdownFragment(markdown);
  const doc = notesSchema.topNodeType.createAndFill(null, content);
  if (!doc) throw new Error("Markdown did not produce a valid note.");
  const tr = assignBlockIds(new Transform(doc));
  tr.doc.check();
  return tr.doc;
}

const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    bullet_list(state, node) {
      state.renderList(node, "  ", () => "- ");
    },
    task_list(state, node) {
      state.renderList(node, "  ", (index) =>
        node.child(index).attrs.checked ? "- [x] " : "- [ ] ",
      );
    },
    task_item(state, node) {
      state.renderContent(node);
    },
    code_block(state, node) {
      const backticks = node.textContent.match(/`{3,}/gm);
      const fence = backticks ? backticks.sort().slice(-1)[0] + "`" : "```";
      state.write(fence + String(node.attrs.language || "") + "\n");
      state.text(node.textContent, false);
      state.write("\n");
      state.write(fence);
      state.closeBlock(node);
    },
    image(state, node) {
      defaultMarkdownSerializer.nodes.image!(state, node, node, 0);
      if (isImageWidth(node.attrs.width))
        state.write(`{width=${node.attrs.width}}`);
      state.closeBlock(node);
    },
    file(state, node) {
      const { objectId, name, mimeType, size } = node.attrs;
      // `&` would otherwise start an entity reference when read back.
      const label = state
        .esc(String(name))
        .replace(/&(?=#?[a-z0-9]+;)/gi, "\\&");
      state.write(`[${label}](${attachmentSource(String(objectId))})`);
      const attributes = [
        mimeType ? `type=${mimeType}` : "",
        size !== null ? `size=${size}` : "",
      ].filter(Boolean);
      if (attributes.length) state.write(`{${attributes.join(" ")}}`);
      state.closeBlock(node);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    strike: {
      open: "~~",
      close: "~~",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
  },
);

/** Markdown for one block, as it appears in the note's canonical Markdown. */
export function blockToMarkdown(node: ProseMirrorNode): string {
  return serializer
    .serialize(notesSchema.topNodeType.create(null, node), { tightLists: true })
    .trimEnd();
}

/**
 * The canonical note Markdown: top-level blocks joined by blank lines.
 * Agent text edits match against exactly this representation.
 */
export function docToMarkdown(doc: ProseMirrorNode): string {
  const parts: string[] = [];
  doc.forEach((node) => parts.push(blockToMarkdown(node)));
  return parts.join("\n\n");
}
