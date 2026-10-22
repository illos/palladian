import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";
import { actionLabels, type ActionId, type SwipeLayout } from "./note-actions";

/**
 * A note row that swipes on touch screens, after Deltos's SwipeRow: an 8 px
 * slop locks the gesture to one axis; past 55 px the row rests open on its
 * actions; a left swipe past 200 px runs the full-swipe action (shown under the
 * row before release). A quick flick opens or closes the row. A long press
 * (500 ms without moving) opens the row's action sheet. Mouse input is left to
 * the desktop row menu.
 */

const SLOP = 8;
const REST = 55;
const FULL = 200;
const CLAMP = 240;
const ACTION_WIDTH = 76;
const FLICK = 0.4;
/** A pause this long before release means the finger stopped: no flick. */
const FLICK_EXPIRES = 100;
const LONG_PRESS = 500;

type IconName = Parameters<typeof Icon>[0]["name"];
export const actionIcons: Record<ActionId, IconName> = {
  duplicate: "copy",
  move: "notebook",
  share: "share",
  info: "info",
  export: "download",
  print: "print",
  trash: "trash",
  restore: "restore",
  delete: "trash",
};
const shortLabels: Partial<Record<ActionId, string>> = {
  move: "Move",
  share: "Share",
  trash: "Trash",
  delete: "Delete",
};

export function SwipeRow({
  layout,
  open,
  onOpenChange,
  onAction,
  onLongPress,
  onMenu,
  children,
}: {
  layout: SwipeLayout;
  /** Whether this row is the one resting open; one row is open at a time. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (action: ActionId) => void;
  onLongPress: () => void;
  /** A mouse right-click: the row menu at the pointer. */
  onMenu: (anchor: { x: number; y: number }) => void;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{
    pointer: number;
    x: number;
    y: number;
    start: number;
    axis: "x" | "y" | null;
    lastX: number;
    lastTime: number;
    velocity: number;
  } | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swallowClick = useRef(false);
  const lastPointer = useRef<string>("mouse");
  const leadingWidth = layout.leading.length * ACTION_WIDTH;
  const trailingWidth = layout.trailing.length * ACTION_WIDTH;
  const canSwipe =
    layout.leading.length > 0 ||
    layout.trailing.length > 0 ||
    layout.full !== null;

  // Another row opening closes this one.
  useEffect(() => {
    if (!open && !gesture.current) setOffset(0);
  }, [open]);
  // The actions can change while the row rests open (a role or Trash change,
  // the connection): rest on the new set, or close if that side has none.
  useEffect(() => {
    if (gesture.current || offset === 0) return;
    const next = offset > 0 ? leadingWidth : -trailingWidth;
    if (next === offset) return;
    setOffset(next);
    if (next === 0) onOpenChange(false);
  }, [leadingWidth, trailingWidth]);

  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const limit = (value: number) =>
    Math.max(
      layout.full || trailingWidth ? -CLAMP : 0,
      Math.min(leadingWidth ? CLAMP : 0, value),
    );
  const settle = (to: number) => {
    setOffset(to);
    onOpenChange(to !== 0);
  };
  const run = (action: ActionId) => {
    settle(0);
    onAction(action);
  };

  const full = layout.full !== null && offset <= -FULL;
  return (
    <div
      className={`swipe-row${dragging ? " dragging" : ""}`}
      onClickCapture={(event) => {
        // A tap on an open row, or the click ending a long press or a swipe,
        // only closes the row. Taps on the revealed actions go through.
        if (!(event.target as Element).closest(".swipe-front")) return;
        // Keyboard clicks are never part of a touch gesture.
        if (event.detail === 0) {
          swallowClick.current = false;
          if (offset !== 0) settle(0);
          return;
        }
        if (swallowClick.current || offset !== 0) {
          event.preventDefault();
          event.stopPropagation();
          swallowClick.current = false;
          if (offset !== 0) settle(0);
        }
      }}
    >
      {leadingWidth > 0 && offset > 0 && (
        <div className="swipe-actions leading" style={{ width: offset }}>
          {layout.leading.map((id) => (
            <button
              key={id}
              type="button"
              className={`swipe-action ${id}`}
              onClick={() => run(id)}
            >
              <Icon name={actionIcons[id]} size={20} />
              <span>{shortLabels[id] ?? actionLabels[id]}</span>
            </button>
          ))}
        </div>
      )}
      {offset < 0 && (
        <div
          className={`swipe-actions trailing${full ? " full" : ""}`}
          style={{ width: -offset }}
        >
          {full ? (
            <span className="swipe-action trash">
              <Icon name="trash" size={20} />
              <span>{shortLabels.trash}</span>
            </span>
          ) : (
            layout.trailing.map((id) => (
              <button
                key={id}
                type="button"
                className={`swipe-action ${id}`}
                onClick={() => run(id)}
              >
                <Icon name={actionIcons[id]} size={20} />
                <span>{shortLabels[id] ?? actionLabels[id]}</span>
              </button>
            ))
          )}
        </div>
      )}
      <div
        className="swipe-front"
        style={{ transform: offset ? `translateX(${offset}px)` : undefined }}
        onKeyDown={() => {
          // The context-menu key or Shift+F10 follows; it is not a touch.
          lastPointer.current = "keyboard";
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          // A touch long press opens the action sheet (onLongPress) instead.
          if (lastPointer.current === "mouse")
            onMenu({ x: event.clientX, y: event.clientY });
          else if (lastPointer.current === "keyboard") {
            const box = (event.target as Element).getBoundingClientRect();
            onMenu({ x: box.left, y: box.bottom });
          }
        }}
        onPointerDown={(event) => {
          // A swallowed click belongs to the previous gesture only.
          swallowClick.current = false;
          lastPointer.current = event.pointerType;
          if (event.pointerType === "mouse" || !event.isPrimary) return;
          gesture.current = {
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            start: offset,
            axis: null,
            lastX: event.clientX,
            lastTime: event.timeStamp,
            velocity: 0,
          };
          clearPress();
          pressTimer.current = setTimeout(() => {
            pressTimer.current = null;
            if (!gesture.current || gesture.current.axis) return;
            gesture.current = null;
            swallowClick.current = true;
            settle(0);
            onLongPress();
          }, LONG_PRESS);
        }}
        onPointerMove={(event) => {
          const g = gesture.current;
          if (!g || g.pointer !== event.pointerId) return;
          const dx = event.clientX - g.x;
          const dy = event.clientY - g.y;
          if (!g.axis) {
            if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
            clearPress();
            g.axis = Math.abs(dx) > Math.abs(dy) && canSwipe ? "x" : "y";
            if (g.axis === "y") {
              gesture.current = null;
              return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }
          const elapsed = event.timeStamp - g.lastTime;
          if (elapsed > 0) g.velocity = (event.clientX - g.lastX) / elapsed;
          g.lastX = event.clientX;
          g.lastTime = event.timeStamp;
          setOffset(limit(g.start + dx));
        }}
        onPointerUp={(event) => {
          clearPress();
          const g = gesture.current;
          gesture.current = null;
          if (!g || g.pointer !== event.pointerId || g.axis !== "x") return;
          setDragging(false);
          swallowClick.current = true;
          const at = limit(g.start + event.clientX - g.x);
          if (layout.full && at <= -FULL) return run(layout.full);
          // A quick flick opens the side it moves into, or closes the row
          // when it flicks back past the resting point.
          const moving = event.timeStamp - g.lastTime < FLICK_EXPIRES;
          if (moving && Math.abs(g.velocity) > FLICK) {
            if (g.velocity < 0)
              return settle(at < 0 && trailingWidth ? -trailingWidth : 0);
            return settle(at > 0 && leadingWidth ? leadingWidth : 0);
          }
          if (at >= REST && leadingWidth) return settle(leadingWidth);
          if (at <= -REST && trailingWidth) return settle(-trailingWidth);
          settle(0);
        }}
        onPointerCancel={() => {
          clearPress();
          const g = gesture.current;
          gesture.current = null;
          setDragging(false);
          if (g?.axis === "x") settle(g.start);
        }}
      >
        {children}
      </div>
    </div>
  );
}
