import { describe, expect, test } from "vitest";
import type { Rollup } from "vite";
import { offlineShell, serviceWorkerSource } from "../../offline-plugin";

type Listener = (event: Record<string, unknown>) => void;

/** Runs a generated worker against in-memory caches. */
function run(
  version: string,
  assets: string[],
  caches: Map<string, Map<string, string>>,
) {
  const listeners: Record<string, Listener> = {};
  const self = {
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener;
    },
    clients: { claim: async () => undefined },
    location: { origin: "https://notes.test" },
  };
  const cacheStorage = {
    async open(name: string) {
      if (!caches.has(name)) caches.set(name, new Map());
      const cache = caches.get(name)!;
      return {
        addAll: async (paths: string[]) => {
          for (const path of paths) cache.set(path, `${name}${path}`);
        },
        match: async (path: string) => cache.get(path),
      };
    },
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
  };
  const network = async (request: { url: string }) =>
    "network:" + new URL(request.url).pathname;
  new Function("self", "caches", "fetch", serviceWorkerSource(version, assets))(
    self,
    cacheStorage,
    network,
  );
  async function dispatch(type: string, extra: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    let response: Promise<unknown> | undefined;
    listeners[type]!({
      ...extra,
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      respondWith: (promise: Promise<unknown>) => {
        response = promise;
      },
    });
    await Promise.all(waits);
    return response ? await response : undefined;
  }
  const get = (path: string, mode = "no-cors") =>
    dispatch("fetch", {
      request: {
        url: "https://notes.test" + path,
        method: "GET",
        mode,
        headers: new Headers(),
      },
    });
  return { listeners, dispatch, get };
}

const OLD = "palladian-notes-shell-old";
const NEW = "palladian-notes-shell-new";

describe("service worker", () => {
  test("note and Settings links open the cached shell", async () => {
    const worker = run("new", ["/"], new Map());
    await worker.dispatch("install");
    expect(await worker.get("/settings", "navigate")).toBe(NEW + "/");
    expect(await worker.get("/settings/about", "navigate")).toBe(NEW + "/");
    expect(await worker.get("/notes/abc_1", "navigate")).toBe(NEW + "/");
    // Other pages and unknown files are left to the network.
    expect(await worker.get("/invite", "navigate")).toBeUndefined();
    expect(await worker.get("/settings/x/y", "navigate")).toBeUndefined();
  });

  test("a new build waits for every window to close, then retires the old one", async () => {
    const caches = new Map([[OLD, new Map([["/", "old shell"]])]]);
    const worker = run("new", ["/"], caches);
    // No message makes a waiting build take over early.
    expect(worker.listeners.message).toBeUndefined();
    await worker.dispatch("install");
    await worker.dispatch("activate");
    expect([...caches.keys()]).toEqual([NEW]);
  });
});

describe("the offline shell's file list (plan 08 B4)", () => {
  /** The paths the generated worker precaches, for a bundle of these files. */
  function precached(bundle: Record<string, unknown>) {
    const hook = offlineShell().generateBundle;
    const generate = typeof hook === "function" ? hook : hook?.handler;
    let source = "";
    generate?.call(
      {
        emitFile: (file: { source: string }) => {
          source = file.source;
          return "sw.js";
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as Rollup.OutputBundle,
      false,
    );
    return JSON.parse(
      /const ASSETS = (\[.*?\]);/.exec(source)![1]!,
    ) as string[];
  }

  test("the PDF reader, its styles and pdf.js's worker are not precached", () => {
    const chunk = (code: string, moduleIds: string[], css: string[] = []) => ({
      type: "chunk",
      code,
      moduleIds,
      viteMetadata: { importedCss: new Set(css), importedAssets: new Set() },
    });
    const asset = (source: string, originalFileNames: string[]) => ({
      type: "asset",
      source,
      originalFileNames,
    });
    const paths = precached({
      "assets/index-a.js": chunk("app", ["/repo/apps/notes/src/App.tsx"]),
      "assets/editor-b.js": chunk("editor", [
        "/repo/apps/notes/src/editor.tsx",
      ]),
      "assets/pdf-reader-c.js": chunk(
        "reader",
        [
          "/repo/node_modules/.pnpm/pdfjs-dist@6.4.299/node_modules/pdfjs-dist/build/pdf.mjs",
          "/repo/apps/notes/src/pdf-reader.tsx",
        ],
        ["assets/pdf-reader-d.css"],
      ),
      "assets/pdf-reader-d.css": asset("css", ["src/pdf-reader.tsx"]),
      "assets/pdf.worker.min-e.mjs": asset("worker", [
        "../../node_modules/.pnpm/pdfjs-dist@6.4.299/node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
      ]),
    });
    expect(paths).toContain("/assets/index-a.js");
    expect(paths).toContain("/assets/editor-b.js");
    expect(paths.filter((path) => path.includes("pdf"))).toEqual([]);
  });
});
