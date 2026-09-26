import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Uploader } from "../../packages/ui/src/Uploader";
import { uploadDriver } from "../../apps/web/src/platform/transfer";
const pending = new Map();
const cancelled = [];
let scope = "first";
let root;
function render() {
  const activeScope = scope;
  const driver = uploadDriver({
    request: ({ name }) =>
      new Promise((resolve) => {
        pending.set(name, { resolve, scope: activeScope });
      }),
    finalize: async () => ({ state: "ready" }),
    cancel: (id) => {
      cancelled.push({ id, scope: activeScope });
      return new Promise(() => {});
    },
  });
  root.render(createElement(Uploader, { key: scope, driver, maxBytes: 1024 }));
}
export function mount() {
  document.getElementById("root")?.remove();
  const element = document.createElement("main");
  document.body.append(element);
  root = createRoot(element);
  render();
}
export function release(name) {
  const value = pending.get(name);
  if (!value) throw Error("Missing fixture request");
  value.resolve({ file: { id: name, state: "ready" }, upload: null });
  pending.delete(name);
}
export function state() {
  return { pending: [...pending.keys()], cancelled };
}
export function switchScope() {
  scope = "second";
  render();
}
