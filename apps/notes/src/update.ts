/**
 * Settings → About → Update now: the one way a waiting service worker takes
 * over (Deltos DEC-0002). An installed iPhone app rarely checks for a new build
 * by itself, so this asks the server, tells a waiting worker to activate, and
 * reloads once it has. Unsaved typing is safe across the reload: the editor's
 * recovery journal is already on the device.
 */
export type UpdateOutcome = "updating" | "latest" | "offline" | "unsupported";

export interface UpdateDeps {
  getRegistration?: () => Promise<ServiceWorkerRegistration | undefined>;
  reload?: () => void;
  online?: () => boolean;
}

/** The worker to activate: one already waiting, or one still installing. */
function pendingWorker(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorker | null> {
  if (registration.waiting) return Promise.resolve(registration.waiting);
  const installing = registration.installing;
  if (!installing) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onState = () => {
      if (
        installing.state === "installed" ||
        installing.state === "redundant"
      ) {
        installing.removeEventListener("statechange", onState);
        resolve(
          installing.state === "installed"
            ? (registration.waiting ?? installing)
            : null,
        );
      }
    };
    installing.addEventListener("statechange", onState);
  });
}

export async function updateApp(deps: UpdateDeps = {}): Promise<UpdateOutcome> {
  const online = deps.online ?? (() => navigator.onLine !== false);
  const reload = deps.reload ?? (() => location.reload());
  const getRegistration =
    deps.getRegistration ??
    (() =>
      "serviceWorker" in navigator
        ? navigator.serviceWorker.getRegistration()
        : Promise.resolve(undefined));
  if (!online()) return "offline";
  const registration = await getRegistration();
  if (!registration) return "unsupported";
  try {
    await registration.update();
  } catch {
    return "offline";
  }
  const worker = await pendingWorker(registration);
  if (!worker) return "latest";
  if (worker.state === "activated") {
    reload();
    return "updating";
  }
  const onState = () => {
    if (worker.state !== "activated") return;
    worker.removeEventListener("statechange", onState);
    reload();
  };
  worker.addEventListener("statechange", onState);
  worker.postMessage({ type: "SKIP_WAITING" });
  return "updating";
}
