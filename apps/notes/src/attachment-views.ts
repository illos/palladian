import {
  attachmentObjectId,
  IMAGE_WIDTH_MAX,
  IMAGE_WIDTH_MIN,
  isObjectId,
  notesSchema,
} from "@palladian/notes-core/schema";
import type { Node as ProseMirrorNode, NodeType } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type {
  EditorView,
  NodeView,
  ViewMutationRecord,
} from "prosemirror-view";
import { AttachmentReadError } from "./attachments";
import {
  opensFile,
  type AttachmentRuntime,
  type FileInfo,
  type ObjectStatus,
} from "./editor-attachments";
import { fileWritesEnabled, onFileWritesChange } from "./file-capability";

/**
 * How images and file blocks look in the editor (plan 08 B3). Their bytes
 * and status come from the editor's AttachmentRuntime (editor-attachments.ts).
 */

const image = notesSchema.nodes.image as NodeType;

/** The smallest width a drag gives an image. */
const MIN_DRAG_WIDTH = 48;

/** "2.4 MB", "512 KB", "12 B". */
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A short type label: "PDF", "PNG", or the extension. */
export function typeLabel(name: string, mimeType: string) {
  if (mimeType === "application/pdf") return "PDF";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  if (/^[A-Za-z0-9]{1,5}$/.test(extension)) return extension.toUpperCase();
  return mimeType.startsWith("image/") ? "Image" : "File";
}

const SVG = "http://www.w3.org/2000/svg";
function glyph(kind: "file" | "image" | "missing") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const paths =
    kind === "image"
      ? ["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M15.5 9.5h.01"]
      : kind === "missing"
        ? ["M6 3h8l4 4v14H6z", "M14 3v4h4", "M9.5 12.5l5 5", "M14.5 12.5l-5 5"]
        : ["M6 3h8l4 4v14H6z", "M14 3v4h4", "M9 13h6", "M9 17h6"];
  for (const d of paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Keys that open an attachment from its focused control. */
const activates = (event: KeyboardEvent) =>
  event.key === "Enter" || event.key === " ";
const keyboard = (event: Event) => event.type.startsWith("key");

/** Whether the node at `getPos()` is the selected node. */
function selected(view: EditorView, getPos: () => number | undefined) {
  const pos = getPos();
  const { selection } = view.state;
  return (
    pos !== undefined &&
    selection instanceof NodeSelection &&
    selection.from === pos
  );
}

/**
 * An image: natural size up to the column width, or its saved width. In an
 * editable note the first tap selects it (to resize, copy or delete it) and
 * a tap on the selected image opens it full screen; in a read-only note a
 * tap opens it. A corner drag resizes it and saves `width`; double-clicking
 * the corner returns it to natural size.
 *
 * Without a pointer (review round 1, F8): the shown picture is a focusable
 * control that Enter or Space opens; in an editable note, labelled Smaller,
 * Larger and Natural size buttons (also the -, + and 0 keys on the focused
 * picture) resize it.
 */
export class ImageView implements NodeView {
  readonly dom: HTMLElement;
  private readonly frame: HTMLElement;
  private picture: HTMLImageElement | null = null;
  private placeholder: HTMLElement | null = null;
  private readonly grip: HTMLElement;
  private readonly sizes: HTMLElement;
  private url: string | null = null;
  private objectId: string | null = null;
  private stopWatch: (() => void) | null = null;
  private readonly stopWrites: () => void;
  private pressedSelected = false;
  private drag: { startX: number; startWidth: number; max: number } | null =
    null;

  constructor(
    private node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly runtime: AttachmentRuntime,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "note-image";
    this.dom.contentEditable = "false";
    this.frame = document.createElement("span");
    this.frame.className = "note-image-frame";
    this.grip = document.createElement("span");
    this.grip.className = "image-grip";
    this.grip.title = "Drag to resize. Double-click for natural size.";
    this.grip.setAttribute("aria-hidden", "true");
    this.sizes = document.createElement("div");
    this.sizes.className = "image-size";
    this.sizes.setAttribute("role", "group");
    this.sizes.setAttribute("aria-label", "Picture size");
    for (const [label, change] of [
      ["Smaller", () => this.step(-1)],
      ["Larger", () => this.step(1)],
      ["Natural size", () => this.commit(null)],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", change);
      this.sizes.append(button);
    }
    this.dom.append(this.frame);
    this.frame.addEventListener("pointerdown", () => {
      this.pressedSelected = selected(this.view, this.getPos);
    });
    this.frame.addEventListener("click", (event) => this.tap(event));
    this.frame.addEventListener("keydown", (event) => this.key(event));
    this.grip.addEventListener("pointerdown", (event) => this.grab(event));
    this.grip.addEventListener("pointermove", (event) => this.move(event));
    this.grip.addEventListener("pointerup", (event) => this.release(event));
    this.grip.addEventListener("pointercancel", () => this.cancelDrag());
    this.grip.addEventListener("dblclick", (event) => {
      event.preventDefault();
      this.commit(null);
    });
    this.stopWrites = onFileWritesChange(() => this.placeGrip());
    this.show(node);
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type) return false;
    const previous = this.node;
    this.node = node;
    if (node.attrs.src !== previous.attrs.src) this.show(node);
    else {
      this.label();
      this.applyWidth();
    }
    return true;
  }

  selectNode() {
    this.dom.classList.add("ProseMirror-selectednode");
    this.picture?.classList.add("ProseMirror-selectednode");
  }

  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode");
    this.picture?.classList.remove("ProseMirror-selectednode");
  }

  stopEvent(event: Event) {
    const target = event.target;
    if (!(target instanceof Node)) return false;
    return (
      this.grip.contains(target) ||
      this.sizes.contains(target) ||
      (target instanceof Element && !!target.closest(".attachment-retry")) ||
      (keyboard(event) && this.frame.contains(target))
    );
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    return mutation.type !== "selection";
  }

  destroy() {
    this.stopWatch?.();
    this.stopWrites();
    this.revoke();
  }

  /** Draw the image for the node's source: a web address, or an object. */
  private show(node: ProseMirrorNode) {
    this.stopWatch?.();
    this.stopWatch = null;
    this.revoke();
    const src = String(node.attrs.src ?? "");
    this.dom.dataset.src = src;
    this.objectId = attachmentObjectId(src);
    if (this.objectId) {
      const objectId = this.objectId;
      this.stopWatch = this.runtime.watch(objectId, () => this.render(), true);
      this.render();
      return;
    }
    // A source from before attachments that names no object grants nothing
    // (B2, review F7).
    if (/^\s*attachment:/i.test(src)) {
      this.render();
      return;
    }
    // A web image, as before attachments.
    delete this.dom.dataset.status;
    this.placeholder?.remove();
    this.placeholder = null;
    const picture = this.pictureElement();
    if (/^https:/i.test(src.trim())) picture.src = src;
    this.label();
    this.applyWidth();
  }

  private render() {
    const record = this.objectId
      ? this.runtime.record(this.objectId)
      : undefined;
    const status = this.objectId ? (record?.status ?? "idle") : "unavailable";
    this.dom.dataset.status = status;
    if (status === "shown" && record?.blob) {
      this.revoke();
      this.url = URL.createObjectURL(record.blob);
      const picture = this.pictureElement();
      picture.src = this.url;
      this.placeholder?.remove();
      this.placeholder = null;
    } else {
      this.revoke();
      this.picture?.remove();
      this.picture = null;
      this.grip.remove();
      this.placeholderElement(status);
    }
    this.label();
    this.applyWidth();
  }

  /** Enter or Space opens the picture; -, + and 0 resize it. */
  private key(event: KeyboardEvent) {
    if (!this.picture) return;
    if (activates(event)) {
      event.preventDefault();
      this.openPicture();
    } else if (this.resizable() && /^[-+=0]$/.test(event.key)) {
      event.preventDefault();
      if (event.key === "0") this.commit(null);
      else this.step(event.key === "-" ? -1 : 1);
    }
  }

  private pictureElement() {
    if (this.picture) return this.picture;
    const picture = document.createElement("img");
    picture.draggable = false;
    picture.addEventListener("load", () => this.placeGrip());
    this.picture = picture;
    this.frame.prepend(picture);
    if (this.dom.classList.contains("ProseMirror-selectednode"))
      picture.classList.add("ProseMirror-selectednode");
    return picture;
  }

  private placeholderElement(status: ObjectStatus) {
    const box = this.placeholder ?? document.createElement("span");
    box.className = "attachment-placeholder";
    box.dataset.status = status;
    box.replaceChildren(glyph(status === "unavailable" ? "missing" : "image"));
    const text = document.createElement("span");
    text.className = "attachment-placeholder-text";
    text.textContent =
      status === "unavailable"
        ? "Attachment unavailable"
        : status === "offline"
          ? "Not available offline"
          : status === "failed"
            ? "The picture could not load."
            : "Loading…";
    box.append(text);
    if (status === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "attachment-retry";
      retry.textContent = "Retry";
      retry.addEventListener("mousedown", (event) => event.preventDefault());
      retry.addEventListener("click", () => {
        if (this.objectId) this.runtime.retry(this.objectId);
      });
      box.append(retry);
    }
    if (!this.placeholder) this.frame.prepend(box);
    this.placeholder = box;
  }

  private label() {
    const alt = String(this.node.attrs.alt ?? "");
    const title = this.node.attrs.title;
    if (this.picture) {
      this.picture.alt = alt;
      if (typeof title === "string") this.picture.title = title;
      else this.picture.removeAttribute("title");
      // The shown picture is a control a keyboard can reach and open.
      this.frame.setAttribute("role", "button");
      this.frame.tabIndex = 0;
      this.frame.setAttribute(
        "aria-label",
        "View picture" + (alt ? `: ${alt}` : ""),
      );
    } else {
      this.frame.removeAttribute("role");
      this.frame.removeAttribute("tabindex");
      this.frame.removeAttribute("aria-label");
    }
    if (this.placeholder) {
      this.placeholder.setAttribute("role", "img");
      const status = this.placeholder.dataset.status;
      this.placeholder.setAttribute(
        "aria-label",
        status === "unavailable"
          ? "Attachment unavailable" + (alt ? `: ${alt}` : "")
          : alt || "Picture",
      );
    }
  }

  private applyWidth() {
    const width = this.node.attrs.width;
    const sized = typeof width === "number";
    for (const element of [this.picture, this.placeholder]) {
      if (!element) continue;
      element.style.width = sized ? `${width}px` : "";
    }
    if (this.picture) {
      if (sized) {
        this.picture.setAttribute("width", String(width));
        this.picture.setAttribute("data-width", String(width));
      } else {
        this.picture.removeAttribute("width");
        this.picture.removeAttribute("data-width");
      }
    }
    this.placeGrip();
  }

  private loaded() {
    return (
      !!this.picture && this.picture.complete && this.picture.naturalWidth > 0
    );
  }

  /** Whether the picture can be resized here now (a width is a file feature). */
  private resizable() {
    return this.loaded() && fileWritesEnabled() && this.view.editable;
  }

  /** The corner grip and the size buttons, while the image can be resized. */
  private placeGrip() {
    if (this.loaded() && fileWritesEnabled()) {
      if (!this.grip.isConnected) this.frame.append(this.grip);
      if (!this.sizes.isConnected) this.dom.append(this.sizes);
    } else {
      if (this.grip.isConnected) this.grip.remove();
      if (this.sizes.isConnected) this.sizes.remove();
    }
  }

  private tap(event: MouseEvent) {
    if (this.grip.contains(event.target as Node)) return;
    if (!this.loaded() || (this.view.editable && !this.pressedSelected)) return;
    event.preventDefault();
    this.openPicture();
  }

  private openPicture() {
    if (!this.loaded()) return;
    this.runtime.showImage({
      src: this.picture!.src,
      alt: String(this.node.attrs.alt ?? ""),
      objectId: this.objectId,
    });
  }

  /** The widest the picture may be: its pixels, the column and the limit. */
  private maxWidth() {
    const column = this.dom.getBoundingClientRect().width;
    return Math.min(this.picture?.naturalWidth ?? 0, column, IMAGE_WIDTH_MAX);
  }

  /** One step smaller or larger (a fifth), within the drag's limits. */
  private step(direction: -1 | 1) {
    if (!this.picture || !this.resizable()) return;
    const max = this.maxWidth();
    if (max < IMAGE_WIDTH_MIN) return;
    const min = Math.max(IMAGE_WIDTH_MIN, Math.min(MIN_DRAG_WIDTH, max));
    const width = this.node.attrs.width;
    const current =
      typeof width === "number"
        ? width
        : this.picture.getBoundingClientRect().width;
    const next = Math.round(
      Math.max(min, Math.min(max, current * (direction < 0 ? 0.8 : 1.25))),
    );
    if (next !== width) this.commit(next);
  }

  private grab(event: PointerEvent) {
    if (!this.view.editable || !fileWritesEnabled() || !this.picture) return;
    const max = this.maxWidth();
    if (max < IMAGE_WIDTH_MIN) return;
    event.preventDefault();
    event.stopPropagation();
    this.grip.setPointerCapture(event.pointerId);
    this.drag = {
      startX: event.clientX,
      startWidth: this.picture.getBoundingClientRect().width,
      max,
    };
    this.dom.classList.add("is-resizing");
  }

  private width(event: PointerEvent) {
    const { startX, startWidth, max } = this.drag!;
    const min = Math.max(IMAGE_WIDTH_MIN, Math.min(MIN_DRAG_WIDTH, max));
    return Math.round(
      Math.max(min, Math.min(max, startWidth + event.clientX - startX)),
    );
  }

  private move(event: PointerEvent) {
    if (!this.drag || !this.picture) return;
    // The picture follows the pointer; the note changes once, on release.
    this.picture.style.width = `${this.width(event)}px`;
  }

  private release(event: PointerEvent) {
    if (!this.drag) return;
    const width = this.width(event);
    const moved = Math.abs(event.clientX - this.drag.startX) >= 1;
    this.cancelDrag();
    if (moved) this.commit(width);
  }

  private cancelDrag() {
    this.drag = null;
    this.dom.classList.remove("is-resizing");
    this.applyWidth();
  }

  /** Save a width, or null for natural size, as one change. */
  private commit(width: number | null) {
    const pos = this.getPos();
    if (pos === undefined || !this.view.editable) return;
    // A width is a file feature: only while the server accepts them.
    if (width !== null && !fileWritesEnabled()) return;
    const node = this.view.state.doc.nodeAt(pos);
    if (!node || node.type !== image || node.attrs.width === width) return;
    this.view.dispatch(
      this.view.state.tr.setNodeAttribute(pos, "width", width),
    );
  }

  private revoke() {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

/**
 * A file block: a chip with its type, name and size. In an editable note
 * the first tap selects it and a tap on the selected chip opens it; in a
 * read-only note a tap opens it. Opening downloads the file, or runs the
 * opener registered for its type (B4's PDF reader). The chip is also a
 * focusable control that Enter or Space opens (review round 1, F8).
 */
export class FileView implements NodeView {
  readonly dom: HTMLElement;
  private readonly chip: HTMLElement;
  private readonly name: HTMLElement;
  private readonly meta: HTMLElement;
  private stopWatch: (() => void) | null = null;
  private pressedSelected = false;
  private opening = false;
  private problem: string | null = null;

  constructor(
    private node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly runtime: AttachmentRuntime,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "note-file";
    this.dom.contentEditable = "false";
    this.chip = document.createElement("span");
    this.chip.className = "file-chip";
    this.name = document.createElement("span");
    this.name.className = "file-name";
    this.meta = document.createElement("span");
    this.meta.className = "file-meta";
    const text = document.createElement("span");
    text.className = "file-text";
    text.append(this.name, this.meta);
    this.chip.append(glyph("file"), text);
    this.dom.append(this.chip);
    this.chip.addEventListener("pointerdown", () => {
      this.pressedSelected = selected(this.view, this.getPos);
    });
    this.chip.addEventListener("click", (event) => {
      if (this.view.editable && !this.pressedSelected) return;
      event.preventDefault();
      void this.open();
    });
    this.chip.setAttribute("role", "button");
    this.chip.tabIndex = 0;
    this.chip.addEventListener("keydown", (event) => {
      if (!activates(event)) return;
      event.preventDefault();
      void this.open();
    });
    this.show();
  }

  stopEvent(event: Event) {
    return (
      keyboard(event) &&
      event.target instanceof Node &&
      this.chip.contains(event.target)
    );
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type) return false;
    const objectChanged = node.attrs.objectId !== this.node.attrs.objectId;
    this.node = node;
    if (objectChanged) this.problem = null;
    this.show(objectChanged);
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    return mutation.type !== "selection";
  }

  destroy() {
    this.stopWatch?.();
  }

  private info(): FileInfo {
    const { objectId, name, mimeType, size } = this.node.attrs;
    return {
      objectId: String(objectId),
      name: String(name),
      mimeType: String(mimeType ?? ""),
      size: typeof size === "number" ? size : null,
    };
  }

  private show(rewatch = !this.stopWatch) {
    const info = this.info();
    // Keep the attributes the clipboard and tests know file blocks by.
    this.dom.dataset.objectId = info.objectId;
    this.dom.dataset.name = info.name;
    this.dom.dataset.mimeType = info.mimeType;
    if (info.size === null) delete this.dom.dataset.size;
    else this.dom.dataset.size = String(info.size);
    if (rewatch) {
      this.stopWatch?.();
      this.stopWatch = isObjectId(info.objectId)
        ? this.runtime.watch(info.objectId, () => this.render(), false)
        : null;
    }
    this.render();
  }

  private render() {
    const info = this.info();
    const status = isObjectId(info.objectId)
      ? (this.runtime.record(info.objectId)?.status ?? "idle")
      : "unavailable";
    const unavailable = status === "unavailable";
    this.dom.dataset.status = status;
    this.name.textContent = info.name;
    const details = [typeLabel(info.name, info.mimeType)];
    if (info.size !== null) details.push(formatSize(info.size));
    this.meta.textContent = unavailable
      ? "Attachment unavailable"
      : this.opening
        ? "Downloading…"
        : (this.problem ?? details.join(" · "));
    this.chip.setAttribute(
      "aria-label",
      unavailable
        ? `${info.name}: attachment unavailable`
        : `${opensFile(info.mimeType) ? "Open" : "Download"} ${info.name}, ${details.join(", ")}`,
    );
  }

  private async open() {
    const info = this.info();
    if (this.opening) return;
    if (this.runtime.record(info.objectId)?.status === "unavailable") {
      this.runtime.hooks.notify("This attachment is unavailable.");
      return;
    }
    this.opening = true;
    this.problem = null;
    this.render();
    try {
      await this.runtime.open(info);
    } catch (error) {
      const kind = error instanceof AttachmentReadError ? error.kind : "failed";
      const gone = this.runtime.record(info.objectId)?.status === "unavailable";
      // Not readable yet while our own change bringing it in is unsent.
      this.problem =
        kind === "unavailable"
          ? gone
            ? null
            : "Not saved to the server yet. Try again in a moment."
          : kind === "signed-out"
            ? "Not available offline"
            : "The download failed. Tap to try again.";
      if (gone) this.runtime.hooks.notify("This attachment is unavailable.");
    } finally {
      this.opening = false;
      this.render();
    }
  }
}
