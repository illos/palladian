import { describe, expect, test, vi } from "vitest";
import { serviceWorkerSource } from "../../offline-plugin";

type Listener = (event: Record<string, unknown>) => void;

/** Runs a generated worker against in-memory caches and a window count. */
function run(
  version: string,
  assets: string[],
  caches: Map<string, Map<string, string>>,
) {
  const listeners: Record<string, Listener> = {};
  const state = { windows: 1 };
  const registration: { installing: unknown; waiting: unknown } = {
    installing: null,
    waiting: null,
  };
  const self = {
    registration,
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener;
    },
    skipWaiting: vi.fn(),
    clients: {
      matchAll: async () => Array.from({ length: state.windows }, () => ({})),
      claim: async () => undefined,
    },
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
    async match(path: string) {
      for (const cache of caches.values())
        if (cache.has(path)) return cache.get(path);
      return undefined;
    },
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
  return { self, state, registration, dispatch, get };
}

const OLD = "palladian-notes-shell-old";
const NEW = "palladian-notes-shell-new";

describe("service worker updates", () => {
  test("a waiting build takes over only when asked", async () => {
    const worker = run("new", ["/"], new Map());
    await worker.dispatch("message", { data: { type: "OTHER" } });
    expect(worker.self.skipWaiting).not.toHaveBeenCalled();
    await worker.dispatch("message", { data: { type: "SKIP_WAITING" } });
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
  });

  test("another window keeps the old build's files until it is the only window", async () => {
    const caches = new Map([
      [OLD, new Map([["/assets/old-chunk.js", "old chunk"]])],
    ]);
    const worker = run("new", ["/", "/assets/new-chunk.js"], caches);
    await worker.dispatch("install");
    worker.state.windows = 2;
    await worker.dispatch("activate");
    expect(caches.has(OLD)).toBe(true);
    // The other window, still on the old build, lazy-loads one of its chunks.
    expect(await worker.get("/assets/old-chunk.js")).toBe("old chunk");
    expect(await worker.get("/assets/new-chunk.js")).toBe(
      NEW + "/assets/new-chunk.js",
    );
    // Once a single window is left, its next page load removes the old build.
    worker.state.windows = 1;
    await worker.get("/", "navigate");
    expect([...caches.keys()]).toEqual([NEW]);
  });

  test("a single window clears older builds on activation", async () => {
    const caches = new Map([[OLD, new Map([["/", "old shell"]])]]);
    const worker = run("new", ["/"], caches);
    await worker.dispatch("install");
    await worker.dispatch("activate");
    expect([...caches.keys()]).toEqual([NEW]);
  });

  test("a waiting build keeps its files while the current one serves page loads", async () => {
    const caches = new Map<string, Map<string, string>>();
    const current = run("old", ["/", "/assets/old.js"], caches);
    await current.dispatch("install");
    await current.dispatch("activate");
    const next = run("new", ["/", "/assets/new.js"], caches);
    await next.dispatch("install");
    // The new build waits; the current one keeps loading pages meanwhile.
    current.registration.waiting = {};
    await current.get("/", "navigate");
    expect([...caches.keys()].sort()).toEqual([NEW, OLD]);
    // Activated with one window left, the new build has its own files and
    // retires the old ones.
    await next.dispatch("activate");
    expect([...caches.keys()]).toEqual([NEW]);
    expect(await next.get("/assets/new.js")).toBe(NEW + "/assets/new.js");
  });

  test("an installing build keeps its files too", async () => {
    const caches = new Map([[NEW, new Map([["/", "new shell"]])]]);
    const current = run("old", ["/"], caches);
    await current.dispatch("install");
    current.registration.installing = {};
    await current.get("/", "navigate");
    expect(caches.has(NEW)).toBe(true);
  });

  test("note and Settings links open the cached shell", async () => {
    const worker = run("new", ["/"], new Map());
    await worker.dispatch("install");
    expect(await worker.get("/settings/about", "navigate")).toBe(NEW + "/");
    expect(await worker.get("/settings", "navigate")).toBe(NEW + "/");
    expect(await worker.get("/notes/abc_1", "navigate")).toBe(NEW + "/");
  });
});
