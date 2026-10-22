import { describe, expect, test } from "vitest";
import { serviceWorkerSource } from "../../offline-plugin";

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
