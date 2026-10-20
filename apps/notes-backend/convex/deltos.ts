import { isSafeHref, notesSchema, plainText } from "@palladian/notes-core";
import { Mark, type Node as ProseMirrorNode } from "prosemirror-model";

/**
 * Deltos → Palladian note conversion for the one-off import (D100–D101). A
 * Deltos body is an ordered tree of typed blocks whose text is a list of
 * segments with boolean marks; see the read-only Deltos reference,
 * packages/shared/src/spine/{block,searchText,markdownOut,fileNote,extract}.ts.
 */
export interface DeltosNote {
  title: string;
  /** The Deltos block body, as stored (JSON). */
  body: string;
  /** A file note: a file plus its extracted text (the file itself follows later). */
  fileNote: boolean;
  /** The file note's extracted text, flattened; null when there is none. */
  fileExtract: string | null;
}

/** What did not come over exactly, by kind and count. Never any content. */
export type Warnings = Record<string, number>;

/** A body that is valid JSON but not a Deltos block list. */
export class DeltosShapeError extends Error {
  constructor() {
    super("The Deltos body is not a valid block list.");
  }
}

/**
 * Deltos's block envelope (spine/block.ts BlockSchema): an ID, an open,
 * non-empty type string, opaque content and optional child blocks. Text runs
 * are `content.segments: [{ text }]` wherever present.
 */
interface Block {
  id: string;
  type: string;
  content: Record<string, unknown>;
  children: Block[];
}
type Segment = Record<string, unknown> & { text: string };

const s = notesSchema;

function nodeType(name: string) {
  const type = s.nodes[name];
  if (!type) throw new Error(`Unknown node type ${name}`);
  return type;
}
function markType(name: string) {
  const type = s.marks[name];
  if (!type) throw new Error(`Unknown mark type ${name}`);
  return type;
}
const node = {
  doc: nodeType("doc"),
  paragraph: nodeType("paragraph"),
  heading: nodeType("heading"),
  blockquote: nodeType("blockquote"),
  code_block: nodeType("code_block"),
  horizontal_rule: nodeType("horizontal_rule"),
  bullet_list: nodeType("bullet_list"),
  ordered_list: nodeType("ordered_list"),
  list_item: nodeType("list_item"),
  task_list: nodeType("task_list"),
  task_item: nodeType("task_item"),
  hard_break: nodeType("hard_break"),
};
const mark = {
  link: markType("link"),
  code: markType("code"),
  strong: markType("strong"),
  em: markType("em"),
  strike: markType("strike"),
};
const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LANGUAGE = /^[\w+#.-]{0,40}$/;
const MAX_DEPTH = 100;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check the envelope of every block, so malformed bodies fail rather than import empty. */
function blocksOf(raw: unknown, depth = 0): Block[] {
  if (!Array.isArray(raw) || depth > MAX_DEPTH) throw new DeltosShapeError();
  return raw.map((item: unknown) => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.type !== "string" ||
      !item.type ||
      (item.content !== undefined &&
        item.content !== null &&
        !record(item.content))
    )
      throw new DeltosShapeError();
    const content = record(item.content) ? item.content : {};
    const segments = content.segments;
    if (
      segments !== undefined &&
      (!Array.isArray(segments) ||
        !segments.every((run) => record(run) && typeof run.text === "string"))
    )
      throw new DeltosShapeError();
    return {
      id: item.id,
      type: item.type,
      content,
      children:
        item.children === undefined ? [] : blocksOf(item.children, depth + 1),
    };
  });
}

/** Deltos block IDs are UUIDs; keeping them lets later steps find a block again. */
function idOf(block: Block) {
  return BLOCK_ID.test(block.id) ? block.id : null;
}

function segmentsOf(block: Block): Segment[] {
  return Array.isArray(block.content.segments)
    ? (block.content.segments as Segment[])
    : [];
}

class Converter {
  readonly warnings: Warnings = {};

  warn(kind: string) {
    this.warnings[kind] = (this.warnings[kind] ?? 0) + 1;
  }

  /** Text with hard line breaks, all under the same marks. */
  text(value: string, marks: readonly Mark[] = []): ProseMirrorNode[] {
    const out: ProseMirrorNode[] = [];
    value.split("\n").forEach((part, index) => {
      if (index > 0) out.push(node.hard_break.create());
      if (part) out.push(s.text(part, marks));
    });
    return out;
  }

  inline(segments: Segment[]): ProseMirrorNode[] {
    const out: ProseMirrorNode[] = [];
    for (const item of segments) {
      if (!item.text) continue;
      // A formula keeps only its source; Deltos recomputed the value.
      if (record(item.formula) || item.math === true) {
        this.warn("formula kept as its source text");
        out.push(...this.text(item.text));
        continue;
      }
      const marks: Mark[] = [];
      const link =
        typeof item.link === "string" && isSafeHref(item.link)
          ? item.link.trim()
          : null;
      if (typeof item.link === "string" && !link)
        this.warn("link that is not http, https or mailto kept as text");
      if (link) marks.push(mark.link.create({ href: link }));
      // Inline code excludes every other mark in Palladian; a link wins.
      if (item.code === true) {
        if (link) this.warn("inline code inside a link dropped");
        else marks.push(mark.code.create());
      }
      if (item.code !== true || link) {
        if (item.bold === true) marks.push(mark.strong.create());
        if (item.italic === true) marks.push(mark.em.create());
        if (item.strike === true) marks.push(mark.strike.create());
      }
      if (item.underline === true) this.warn("underline dropped");
      if (item.highlight === true) this.warn("highlight dropped");
      out.push(...this.text(item.text, Mark.setFrom(marks)));
    }
    return out;
  }

  paragraph(id: string | null, segments: Segment[]) {
    return node.paragraph.create({ id }, this.inline(segments));
  }

  /** A run of blocks; consecutive to-dos become one checklist. */
  blocks(blocks: Block[]): ProseMirrorNode[] {
    const out: ProseMirrorNode[] = [];
    let tasks: ProseMirrorNode[] = [];
    const flush = () => {
      if (tasks.length) out.push(node.task_list.create(null, tasks));
      tasks = [];
    };
    for (const block of blocks) {
      if (block.type === "todo") {
        tasks.push(this.taskItem(block));
        continue;
      }
      flush();
      out.push(...this.block(block));
    }
    flush();
    return out;
  }

  taskItem(block: Block) {
    return node.task_item.create(
      { id: idOf(block), checked: block.content.checked === true },
      [this.paragraph(null, segmentsOf(block)), ...this.blocks(block.children)],
    );
  }

  listItem(block: Block) {
    return node.list_item.create({ id: idOf(block) }, [
      this.paragraph(null, segmentsOf(block)),
      ...this.blocks(block.children),
    ]);
  }

  /**
   * A Deltos list; to-do items split it into checklists where they occur.
   * Numbering continues across the split.
   */
  list(block: Block): ProseMirrorNode[] {
    const ordered = block.content.ordered === true;
    const runs: { tasks: boolean; items: ProseMirrorNode[] }[] = [];
    for (const child of block.children) {
      const tasks = child.type === "todo";
      const item = tasks ? this.taskItem(child) : this.listItem(child);
      const last = runs.at(-1);
      if (last?.tasks === tasks) last.items.push(item);
      else runs.push({ tasks, items: [item] });
    }
    let order = 1;
    return runs.map((run, index) => {
      const id = index === 0 ? idOf(block) : null;
      if (run.tasks) return node.task_list.create({ id }, run.items);
      if (!ordered) return node.bullet_list.create({ id }, run.items);
      const list = node.ordered_list.create({ id, order }, run.items);
      order += run.items.length;
      return list;
    });
  }

  block(block: Block): ProseMirrorNode[] {
    const id = idOf(block);
    const content = block.content;
    switch (block.type) {
      case "paragraph":
        return [
          this.paragraph(id, segmentsOf(block)),
          ...this.blocks(block.children),
        ];
      case "heading": {
        const raw = content.level;
        const level =
          typeof raw === "number" && raw >= 1
            ? Math.min(Math.floor(raw), 3)
            : 1;
        if (typeof raw === "number" && raw > 3)
          this.warn("heading below level 3 raised to level 3");
        return [
          node.heading.create({ id, level }, this.inline(segmentsOf(block))),
          ...this.blocks(block.children),
        ];
      }
      case "quote": {
        // Quotes nest any blocks; the quote's own text, if any, comes first.
        const own = this.inline(segmentsOf(block));
        const inner = this.blocks(block.children);
        return [
          node.blockquote.create(
            { id },
            own.length || !inner.length
              ? [node.paragraph.create(null, own), ...inner]
              : inner,
          ),
        ];
      }
      case "code": {
        const code = typeof content.code === "string" ? content.code : "";
        let language =
          typeof content.language === "string" ? content.language : "";
        if (!LANGUAGE.test(language)) {
          this.warn("code language label dropped");
          language = "";
        }
        return [
          node.code_block.create({ id, language }, code ? s.text(code) : null),
          ...this.blocks(block.children),
        ];
      }
      case "divider":
        return [
          node.horizontal_rule.create({ id }),
          ...this.blocks(block.children),
        ];
      case "list":
        return this.list(block);
      case "attachment": {
        this.warn("attachment to bring over with files");
        const name =
          typeof content.name === "string" && content.name.trim()
            ? content.name.trim()
            : "attachment";
        return [
          node.paragraph.create(
            { id },
            s.text(`📎 ${name} (file to be added)`),
          ),
          ...this.blocks(block.children),
        ];
      }
      case "link_card": {
        this.warn("link card kept as a link");
        const url = typeof content.url === "string" ? content.url.trim() : "";
        const label =
          typeof content.title === "string" && content.title.trim()
            ? content.title.trim()
            : url;
        const marks = isSafeHref(url) ? [mark.link.create({ href: url })] : [];
        return [
          ...(label
            ? [node.paragraph.create({ id }, this.text(label, marks))]
            : []),
          ...this.blocks(block.children),
        ];
      }
      default: {
        const segments = segmentsOf(block);
        if (segments.length) {
          this.warn(`"${block.type}" block kept as text`);
          return [this.paragraph(id, segments), ...this.blocks(block.children)];
        }
        if (typeof content.code === "string" && content.code) {
          this.warn(`"${block.type}" block kept as code`);
          return [
            node.code_block.create({ id, language: "" }, s.text(content.code)),
            ...this.blocks(block.children),
          ];
        }
        this.warn(`"${block.type}" block skipped`);
        return this.blocks(block.children);
      }
    }
  }

  /** A file note's extracted text: paragraphs at blank lines. */
  extract(text: string): ProseMirrorNode[] {
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (!paragraphs.length) return [];
    return [
      node.paragraph.create(
        null,
        s.text("Text extracted from the file:", [mark.em.create()]),
      ),
      ...paragraphs.map((part) => node.paragraph.create(null, this.text(part))),
    ];
  }
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The first logical line, as Palladian derives titles (projection.ts), untruncated. */
function firstLine(blocks: ProseMirrorNode[]) {
  const text = plainText(node.doc.create(null, blocks));
  const newline = text.indexOf("\n");
  return collapse(newline < 0 ? text : text.slice(0, newline));
}

/**
 * Convert one Deltos note. The title becomes the first line (Palladian takes
 * the title from it) unless the body's first line already is the title.
 * Throws a SyntaxError for invalid JSON and DeltosShapeError for a body that
 * is not a block list; the caller reports the note as failed.
 */
export function deltosToDoc(note: DeltosNote): {
  doc: ProseMirrorNode;
  warnings: Warnings;
} {
  const converter = new Converter();
  const blocks = converter.blocks(blocksOf(JSON.parse(note.body)));
  if (note.fileNote && note.fileExtract)
    blocks.push(...converter.extract(note.fileExtract));
  const title = collapse(note.title);
  if (title && (!blocks.length || firstLine(blocks) !== title))
    blocks.unshift(node.heading.create({ level: 1 }, s.text(title)));
  if (!blocks.length) blocks.push(node.paragraph.create());
  const doc = node.doc.create(null, blocks);
  doc.check();
  return { doc, warnings: converter.warnings };
}

/**
 * The source text of a Deltos note, gathered independently of the converter
 * the way Deltos's own search text does (spine/searchText.ts: segment runs
 * and code, through all children), plus attachment names, link-card labels,
 * the title and extracted file text. Used to verify an import kept every
 * piece; whitespace is collapsed.
 */
export function deltosSourceText(note: DeltosNote): string[] {
  const out = [note.title];
  const walk = (raw: unknown) => {
    if (!Array.isArray(raw)) return;
    for (const item of raw as unknown[]) {
      if (!record(item)) continue;
      const content = record(item.content) ? item.content : {};
      if (Array.isArray(content.segments))
        out.push(
          content.segments
            .map((run: unknown) =>
              record(run) && typeof run.text === "string" ? run.text : "",
            )
            .join(""),
        );
      if (typeof content.code === "string") out.push(content.code);
      if (item.type === "attachment" && typeof content.name === "string")
        out.push(content.name);
      if (item.type === "link_card")
        out.push(
          typeof content.title === "string" && content.title.trim()
            ? content.title
            : typeof content.url === "string"
              ? content.url
              : "",
        );
      walk(item.children);
    }
  };
  walk(JSON.parse(note.body));
  if (note.fileNote && note.fileExtract)
    out.push(...note.fileExtract.split(/\n\s*\n/));
  return out.map(collapse).filter(Boolean);
}

export { collapse as collapseWhitespace };
