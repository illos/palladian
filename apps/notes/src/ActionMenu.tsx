import { useEffect, useRef } from "react";
import { Icon } from "./Icons";
import { actionLabels, type ActionId } from "./note-actions";
import { actionIcons } from "./SwipeRow";

type IconName = Parameters<typeof Icon>[0]["name"];
export interface MenuItem<Id extends string> {
  id: Id;
  label: string;
  icon: IconName;
  danger?: boolean;
}

/** A note's actions as menu entries. */
export function noteMenuItems(actions: ActionId[]): MenuItem<ActionId>[] {
  return actions.map((id) => ({
    id,
    label: actionLabels[id],
    icon: actionIcons[id],
    danger: id === "trash" || id === "delete",
  }));
}

/**
 * A note's or notebook's actions: a bottom sheet on phones, a small menu at
 * the pointer or button on wider screens. Escape, the backdrop and Cancel
 * close it.
 */
export function ActionMenu<Id extends string>({
  title,
  label,
  items,
  anchor,
  sheet,
  onPick,
  onClose,
}: {
  title: string;
  /** The dialog's accessible name; "Actions for <title>" by default. */
  label?: string;
  items: MenuItem<Id>[];
  /** Where a desktop menu opens; ignored for the phone sheet. */
  anchor: { x: number; y: number } | null;
  sheet: boolean;
  onPick: (action: Id) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  /**
   * The click that ends the long press which opened the sheet lands on
   * whatever is under the finger: the backdrop or one of the actions. Only a
   * press that starts once the menu is open counts; keyboard clicks always do.
   */
  const pressedBackdrop = useRef(false);
  const pressed = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector("button")?.focus();
  }, []);
  // Keep a desktop menu on screen.
  const style =
    !sheet && anchor
      ? {
          left: Math.min(anchor.x, innerWidth - 240),
          top: Math.min(anchor.y, innerHeight - (items.length * 40 + 60)),
        }
      : undefined;
  return (
    <dialog
      ref={ref}
      className={sheet ? "action-sheet" : "action-menu"}
      aria-label={label ?? `Actions for ${title}`}
      style={style}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        pressed.current = true;
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedBackdrop.current)
          onClose();
        pressedBackdrop.current = false;
      }}
    >
      {sheet && <p className="action-title">{title}</p>}
      <div role="menu">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={item.danger ? "danger-text" : ""}
            onClick={(event) => {
              if (event.detail !== 0 && !pressed.current) return;
              onClose();
              onPick(item.id);
            }}
          >
            <Icon name={item.icon} size={18} />
            {item.label}
          </button>
        ))}
      </div>
      {sheet && (
        <button
          type="button"
          className="action-cancel"
          onClick={(event) => {
            if (event.detail !== 0 && !pressed.current) return;
            onClose();
          }}
        >
          Cancel
        </button>
      )}
    </dialog>
  );
}
