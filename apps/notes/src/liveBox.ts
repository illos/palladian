import type { LiveController } from "./live";

/** Holds the deferred live layer once it loads; the UI renders without it. */
export class LiveBox {
  private value: LiveController | null = null;
  private readonly listeners = new Set<() => void>();
  get = () => this.value;
  set(value: LiveController) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}

const idle = { ready: false, accountId: null, profile: null, connected: false };
const noop = () => () => {};
export function liveStateSource(live: LiveController | null) {
  return live
    ? { subscribe: live.subscribe, get: live.getState }
    : { subscribe: noop, get: () => idle };
}
