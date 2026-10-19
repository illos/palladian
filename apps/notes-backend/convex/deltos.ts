import { isSafeHref, notesSchema } from "@palladian/notes-core";
import { Mark, type Node as ProseMirrorNode } from "prosemirror-model";

/**
 * Deltos → Palladian note conversion for the one-off import (Q15). A Deltos
 * body is a tree of typed blocks whose text is a list of segments with
 * boolean marks; see the read-only Deltos reference,
 * packages/shared/src/spine/{block,markdownOut,fileNote,extract}.ts.
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Deltos block IDs are UUIDs; keeping them lets later steps find a block again. */
function blockId(block: Record<string, unknown>) {
  return typeof block.id === "string" && BLOCK_ID.test(block.id)
    ? block.id
    : null;
}

function segmentsOf(block: Record<string, unknown>) {
  return record(block.content) ? block.content.segments : undefined;
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

  inline(raw: unknown): ProseMirrorNode[] {
    const out: ProseMirrorNode[] = [];
    for (const item of list(raw)) {
      if (!record(item) || typeof item.text !== "string" || !item.text)
        continue;
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

  paragraph(id: string | null, raw: unknown) {
    return node.paragraph.create({ id }, this.inline(raw));
  }

  /** A run of blocks; consecutive to-dos become one checklist. */
  blocks(raw: unknown): ProseMirrorNode[] {
    const out: ProseMirrorNode[] = [];
    let tasks: ProseMirrorNode[] = [];
    const flush = () => {
      if (tasks.length) out.push(node.task_list.create(null, tasks));
      tasks = [];
    };
    for (const block of list(raw)) {
      if (!record(block)) continue;
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

  taskItem(block: Record<string, unknown>) {
    const checked = record(block.content) && block.content.checked === true;
    return node.task_item.create({ id: blockId(block), checked }, [
      this.paragraph(null, segmentsOf(block)),
      ...this.blocks(block.children),
    ]);
  }

  listItem(block: Record<string, unknown>) {
    return node.list_item.create({ id: blockId(block) }, [
      this.paragraph(null, segmentsOf(block)),
      ...this.blocks(block.children),
    ]);
  }

  /** A Deltos list; to-do items split it into checklists where they occur. */
  list(block: Record<string, unknown>): ProseMirrorNode[] {
    const ordered = record(block.content) && block.content.ordered === true;
    const runs: { tasks: boolean; items: ProseMirrorNode[] }[] = [];
    for (const child of list(block.children)) {
      if (!record(child)) continue;
      const tasks = child.type === "todo";
      const item = tasks ? this.taskItem(child) : this.listItem(child);
      const last = runs.at(-1);
      if (last?.tasks === tasks) last.items.push(item);
      else runs.push({ tasks, items: [item] });
    }
    return runs.map((run, index) => {
      const id = index === 0 ? blockId(block) : null;
      if (run.tasks) return node.task_list.create({ id }, run.items);
      return (ordered ? node.ordered_list : node.bullet_list).create(
        { id },
        run.items,
      );
    });
  }

  block(block: Record<string, unknown>): ProseMirrorNode[] {
    const id = blockId(block);
    const content = record(block.content) ? block.content : {};
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
      case "quote":
        return [
          node.blockquote.create({ id }, [
            this.paragraph(null, segmentsOf(block)),
            ...list(block.children)
              .filter(record)
              .map((child) =>
                this.paragraph(blockId(child), segmentsOf(child)),
              ),
          ]),
        ];
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
        ];
      }
      case "divider":
        return [node.horizontal_rule.create({ id })];
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
        ];
      }
      case "link_card": {
        this.warn("link card kept as a link");
        const url = typeof content.url === "string" ? content.url.trim() : "";
        const label =
          typeof content.title === "string" && content.title.trim()
            ? content.title.trim()
            : url;
        if (!label) return [];
        const marks = isSafeHref(url) ? [mark.link.create({ href: url })] : [];
        return [node.paragraph.create({ id }, this.text(label, marks))];
      }
      default: {
        const segments = segmentsOf(block);
        const type = typeof block.type === "string" ? block.type : "unknown";
        if (list(segments).length) {
          this.warn(`"${type}" block kept as text`);
          return [this.paragraph(id, segments), ...this.blocks(block.children)];
        }
        this.warn(`"${type}" block skipped`);
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

function sameText(node: ProseMirrorNode | undefined, text: string) {
  return !!node && node.isTextblock && node.textContent.trim() === text;
}

/**
 * Convert one Deltos note. The title becomes the first line (Palladian takes
 * the title from it) unless the body already starts with it. Throws when the
 * body is not valid JSON; the caller reports the note as failed.
 */
export function deltosToDoc(note: DeltosNote): {
  doc: ProseMirrorNode;
  warnings: Warnings;
} {
  const converter = new Converter();
  const body: unknown = JSON.parse(note.body);
  const blocks = converter.blocks(body);
  if (note.fileNote && note.fileExtract)
    blocks.push(...converter.extract(note.fileExtract));
  const title = note.title.replace(/\s+/g, " ").trim();
  if (title && !sameText(blocks[0], title))
    blocks.unshift(node.heading.create({ level: 1 }, s.text(title)));
  if (!blocks.length) blocks.push(node.paragraph.create());
  const doc = node.doc.create(null, blocks);
  doc.check();
  return { doc, warnings: converter.warnings };
}
