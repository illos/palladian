/**
 * Settings → About → Update now: the one way a waiting service worker takes
 * over (Deltos DEC-0002). An installed iPhone app rarely checks for a new build
 * by itself, so this asks the server for one. If one is waiting, `ready`
 * confirms that everything typed is stored on the device before the new build
 * activates, and again just before the reload; the recovery journal restores
 * stored work after it. A failed check holds the activation or the reload.
 */
export type UpdateOutcome =
  | "updating"
  | "latest"
  | "offline"
  | "unsupported"
  | "unsaved"
  | "installed"
  | "failed";

export interface UpdateDeps {
  getRegistration?: () => Promise<ServiceWorkerRegistration | undefined>;
  reload?: () => void;
  online?: () => boolean;
  /** Whether a reload would keep all typing, before activation and before reload. */
  ready?: (stage: "activate" | "reload") => Promise<boolean>;
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

/** Ask a waiting worker to take over; true once it is active. */
function activate(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    if (worker.state === "activated") return resolve(true);
    const onState = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") return;
      worker.removeEventListener("statechange", onState);
      resolve(worker.state === "activated");
    };
    worker.addEventListener("statechange", onState);
    worker.postMessage({ type: "SKIP_WAITING" });
  });
}

export async function updateApp(deps: UpdateDeps = {}): Promise<UpdateOutcome> {
  const online = deps.online ?? (() => navigator.onLine !== false);
  const reload = deps.reload ?? (() => location.reload());
  const ready = deps.ready ?? (async () => true);
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
  if (!(await ready("activate"))) return "unsaved";
  if (!(await activate(worker))) return "failed";
  if (!(await ready("reload"))) return "installed";
  reload();
  return "updating";
}
