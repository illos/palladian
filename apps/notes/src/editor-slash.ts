import { notesSchema } from "@palladian/notes-core/schema";
import {
  EditorState,
  Plugin,
  PluginKey,
  type Command,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  insertDivider,
  setBlock,
  startList,
  toggleQuote,
  quoteActive,
} from "./editor-commands";

const { heading, paragraph, code_block } = notesSchema.nodes;

export type SlashAction = {
  label: string;
  keywords: readonly string[];
  /** "link" opens the link form instead of running a command. */
  command: Command | "link";
};

/** Blocks the schema already has (plan 08, A3). Files join with Track B. */
export const slashActions: readonly SlashAction[] = [
  {
    label: "Title",
    keywords: ["h1", "heading 1"],
    command: setBlock(heading!, { level: 1 }),
  },
  {
    label: "Heading",
    keywords: ["h2", "heading 2"],
    command: setBlock(heading!, { level: 2 }),
  },
  {
    label: "Subhead",
    keywords: ["h3", "heading 3", "subheading"],
    command: setBlock(heading!, { level: 3 }),
  },
  {
    label: "Body",
    keywords: ["text", "paragraph", "plain"],
    command: setBlock(paragraph!),
  },
  {
    label: "Bullet list",
    keywords: ["ul", "unordered", "bulleted"],
    command: startList("bullet"),
  },
  {
    label: "Numbered list",
    keywords: ["ol", "ordered"],
    command: startList("ordered"),
  },
  {
    label: "Checklist",
    keywords: ["todo", "task", "checkbox"],
    command: startList("checklist"),
  },
  {
    label: "Quote",
    keywords: ["blockquote"],
    command: (state, dispatch, view) =>
      quoteActive(state) || toggleQuote(state, dispatch, view),
  },
  {
    label: "Code",
    keywords: ["mono", "pre", "code block"],
    command: setBlock(code_block!),
  },
  {
    label: "Divider",
    keywords: ["hr", "rule", "line", "separator"],
    command: insertDivider,
  },
  { label: "Link", keywords: ["url", "address", "web"], command: "link" },
];

/** The open palette: where its `/` is, what follows it, and the highlighted entry. */
export type SlashState = { from: number; query: string; index: number } | null;
type SlashMeta =
  | { type: "open"; from: number }
  | { type: "close" }
  | { type: "move"; index: number };
export const slashKey = new PluginKey<SlashState>("slashPalette");

/** Entries matching the query that can apply once the `/query` text is gone. */
export function slashChoices(state: EditorState): SlashAction[] {
  const slash = slashKey.getState(state);
  if (!slash) return [];
  const query = slash.query.toLowerCase();
  const tr = state.tr.delete(slash.from, state.selection.from);
  const cleared = EditorState.create({ doc: tr.doc, selection: tr.selection });
  return slashActions.filter(
    (action) =>
      (action.label.toLowerCase().includes(query) ||
        action.keywords.some((word) => word.includes(query))) &&
      (action.command === "link" || action.command(cleared)),
  );
}

/** Remove the typed `/query` and apply the chosen entry. */
export function runSlash(
  view: EditorView,
  action: SlashAction,
  openLink: (view: EditorView) => void,
) {
  const slash = slashKey.getState(view.state);
  if (!slash) return;
  view.dispatch(
    view.state.tr
      .delete(slash.from, view.state.selection.from)
      .setMeta(slashKey, { type: "close" } satisfies SlashMeta),
  );
  if (action.command === "link") openLink(view);
  else {
    action.command(view.state, view.dispatch, view);
    view.focus();
  }
}

/**
 * The desktop slash palette (ported from Deltos's `slashPalettePlugin`). It
 * opens when `/` is typed on an empty line or after a space, outside code,
 * tracks the query typed after it, and takes the arrow keys, Enter, Tab and
 * Escape while it has matching entries.
 */
export function slashPalette(options: {
  enabled: () => boolean;
  openLink: (view: EditorView) => void;
}) {
  return new Plugin<SlashState>({
    key: slashKey,
    state: {
      init: () => null,
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(slashKey) as SlashMeta | undefined;
        if (meta?.type === "close") return null;
        if (meta?.type === "open")
          return { from: meta.from, query: "", index: 0 };
        if (!value) return null;
        if (meta?.type === "move") return { ...value, index: meta.index };
        const mapped = tr.mapping.mapResult(value.from, 1);
        const { selection } = state;
        const cursor = selection.$from;
        if (mapped.deleted || !selection.empty || cursor.pos <= mapped.pos)
          return null;
        if (state.doc.resolve(mapped.pos).start() !== cursor.start())
          return null;
        if (state.doc.textBetween(mapped.pos, mapped.pos + 1) !== "/")
          return null;
        const query = state.doc.textBetween(
          mapped.pos + 1,
          cursor.pos,
          undefined,
          "\ufffc",
        );
        if (/[\s\ufffc]/.test(query) || query.length > 32) return null;
        return {
          from: mapped.pos,
          query,
          index: query === value.query ? value.index : 0,
        };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== "/" || from !== to || view.composing) return false;
        if (!options.enabled() || slashKey.getState(view.state)) return false;
        const $from = view.state.doc.resolve(from);
        const block = $from.parent;
        if (!block.isTextblock || block.type.spec.code) return false;
        if ($from.marks().some((mark) => mark.type.spec.code)) return false;
        const before = block.textBetween(
          0,
          $from.parentOffset,
          undefined,
          "\ufffc",
        );
        if (block.content.size > 0 && !/\s$/.test(before)) return false;
        view.dispatch(
          view.state.tr
            .insertText("/", from, to)
            .setMeta(slashKey, { type: "open", from } satisfies SlashMeta),
        );
        return true;
      },
      handleKeyDown(view, event) {
        const slash = slashKey.getState(view.state);
        if (!slash) return false;
        if (event.key === "Escape") {
          view.dispatch(
            view.state.tr.setMeta(slashKey, {
              type: "close",
            } satisfies SlashMeta),
          );
          return true;
        }
        const choices = slashChoices(view.state);
        if (!choices.length) return false;
        const index = Math.min(slash.index, choices.length - 1);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const step = event.key === "ArrowDown" ? 1 : -1;
          const next = (index + step + choices.length) % choices.length;
          view.dispatch(
            view.state.tr.setMeta(slashKey, {
              type: "move",
              index: next,
            } satisfies SlashMeta),
          );
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          runSlash(view, choices[index]!, options.openLink);
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        blur(view) {
          if (slashKey.getState(view.state))
            view.dispatch(
              view.state.tr.setMeta(slashKey, {
                type: "close",
              } satisfies SlashMeta),
            );
          return false;
        },
      },
    },
  });
}
