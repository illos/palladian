import { useRef, type DragEvent } from "react";
import { Icon } from "./Icons";

/** A long press is a touch held this long without moving (as on note rows). */
const LONG_PRESS = 500;
const SLOP = 8;

type Anchor = { x: number; y: number };

/**
 * A notebook in the navigation: opens the notebook, shows how many notes
 * this device has in it, and opens its menu. Wide screens open the menu by
 * right-click, the hover "…" or the context-menu key; touch screens by a long
 * press (500 ms without moving). The click ending a long press is ignored,
 * menu or not. Without a menu, the browser's own context menu is left alone.
 */
export function NotebookNavItem({
  name,
  title,
  count,
  shared,
  active,
  dropping,
  hasMenu,
  onSelect,
  onMenu,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  name: string;
  title: string;
  count: number;
  shared: boolean;
  active: boolean;
  dropping: boolean;
  hasMenu: boolean;
  onSelect: () => void;
  /** At the pointer or button on wide screens; null opens the phone sheet. */
  onMenu: (anchor: Anchor | null) => void;
  onDragOver: (event: DragEvent<HTMLButtonElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLButtonElement>) => void;
}) {
  const press = useRef<{
    pointer: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  /** The click ending a long press only closes the press. */
  const swallowClick = useRef(false);
  const lastInput = useRef<"mouse" | "touch" | "keyboard">("mouse");
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  return (
    <div className="nav-row">
      <button
        className={active ? "nav-item active" : "nav-item"}
        title={title}
        data-drop={dropping ? "" : undefined}
        onClick={() => {
          if (swallowClick.current) {
            swallowClick.current = false;
            return;
          }
          onSelect();
        }}
        onKeyDown={() => {
          // The context-menu key or Shift+F10 follows; it is not a touch.
          lastInput.current = "keyboard";
          swallowClick.current = false;
        }}
        onPointerDown={(event) => {
          swallowClick.current = false;
          lastInput.current = event.pointerType === "mouse" ? "mouse" : "touch";
          cancelPress();
          if (event.pointerType === "mouse" || !event.isPrimary) return;
          // As on note rows, a long press never opens the notebook, even
          // when there is no menu to show.
          press.current = {
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            timer: setTimeout(() => {
              press.current = null;
              swallowClick.current = true;
              if (hasMenu) onMenu(null);
            }, LONG_PRESS),
          };
        }}
        onPointerMove={(event) => {
          const held = press.current;
          if (
            held &&
            held.pointer === event.pointerId &&
            (Math.abs(event.clientX - held.x) > SLOP ||
              Math.abs(event.clientY - held.y) > SLOP)
          )
            cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(event) => {
          if (!hasMenu) return;
          event.preventDefault();
          // A touch long press opens the sheet (above) instead.
          if (lastInput.current === "mouse")
            onMenu({ x: event.clientX, y: event.clientY });
          else if (lastInput.current === "keyboard") {
            const box = event.currentTarget.getBoundingClientRect();
            onMenu({ x: box.left + 24, y: box.bottom });
          }
        }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <Icon name="notebook" size={17} />
        <span>{name}</span>
        {shared && <small>Shared</small>}
        {/* A visual aid: the list header states the count for every reader. */}
        <small className="nav-count" aria-hidden="true">
          {count}
        </small>
      </button>
      {hasMenu && (
        <button
          type="button"
          className="nav-more"
          // A pointer shortcut, as on note rows: keyboards use the
          // context-menu key on the notebook or the list header's "…".
          aria-hidden="true"
          tabIndex={-1}
          title={`${name} actions`}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onMenu({ x: box.left, y: box.bottom });
          }}
        >
          <Icon name="more" size={16} />
        </button>
      )}
    </div>
  );
}
