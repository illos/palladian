import { useCallback, useRef, useState } from "react";

/** Short notices with an optional action (Undo, Open), as in Deltos. */
export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

const DURATION = 4500;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const dismiss = useCallback(
    (id: number) => setToasts((all) => all.filter((toast) => toast.id !== id)),
    [],
  );
  const show = useCallback(
    (message: string, action?: Toast["action"]) => {
      const id = ++next.current;
      // The newest notice replaces older ones; there is room for one.
      setToasts([{ id, message, ...(action ? { action } : {}) }]);
      setTimeout(() => dismiss(id), DURATION);
    },
    [dismiss],
  );
  return { toasts, show, dismiss };
}

export function ToastHost({
  toasts,
  dismiss,
}: {
  toasts: Toast[];
  dismiss: (id: number) => void;
}) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                dismiss(toast.id);
                toast.action!.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
