import { useEffect, useRef } from "react";
import { Icon } from "./Icons";
import { actionLabels, type ActionId } from "./note-actions";
import { actionIcons } from "./SwipeRow";

/**
 * A note's actions: a bottom sheet on phones, a small menu at the pointer or
 * button on wider screens. Escape, the backdrop and Cancel close it.
 */
export function ActionMenu({
  title,
  actions,
  anchor,
  sheet,
  onPick,
  onClose,
}: {
  title: string;
  actions: ActionId[];
  /** Where a desktop menu opens; ignored for the phone sheet. */
  anchor: { x: number; y: number } | null;
  sheet: boolean;
  onPick: (action: ActionId) => void;
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
          top: Math.min(anchor.y, innerHeight - (actions.length * 40 + 60)),
        }
      : undefined;
  return (
    <dialog
      ref={ref}
      className={sheet ? "action-sheet" : "action-menu"}
      aria-label={`Actions for ${title}`}
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
        {actions.map((id) => (
          <button
            key={id}
            type="button"
            role="menuitem"
            className={id === "trash" || id === "delete" ? "danger-text" : ""}
            onClick={(event) => {
              if (event.detail !== 0 && !pressed.current) return;
              onClose();
              onPick(id);
            }}
          >
            <Icon name={actionIcons[id]} size={18} />
            {actionLabels[id]}
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
