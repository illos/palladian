import { useEffect, useRef, useState } from "react";

export interface UploadDriver {
  /** The driver owns scoped intent, byte transfer, server verification and
   * cancellation. Successful completion means server-confirmed ready bytes. */
  upload(input: {
    file: File;
    idempotencyKey: string;
    signal: AbortSignal;
    progress: (fraction: number) => void;
  }): Promise<void>;
}
export function Uploader({
  driver,
  maxBytes,
}: {
  driver: UploadDriver;
  maxBytes: number;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const intent = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  async function submit() {
    if (!file || busy) return;
    if (file.size < 1 || file.size > maxBytes) {
      setMessage(
        `Choose a file between 1 byte and ${Math.floor(maxBytes / 1024 / 1024)} MiB.`,
      );
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    intent.current ??= crypto.randomUUID();
    setBusy(true);
    setProgress(0);
    setMessage("Preparing upload…");
    const current = () => mounted.current && request.current === controller;
    try {
      await driver.upload({
        file,
        idempotencyKey: intent.current,
        signal: controller.signal,
        progress: (fraction) => {
          if (current() && !controller.signal.aborted) {
            setProgress(Math.min(1, Math.max(0, fraction)));
            setMessage(fraction >= 1 ? "Verifying file…" : "Uploading…");
          }
        },
      });
      if (current() && !controller.signal.aborted) {
        intent.current = null;
        if (input.current) input.current.value = "";
        setFile(null);
        setMessage("File verified and ready.");
      }
    } catch {
      if (current())
        setMessage(
          controller.signal.aborted
            ? "Transfer stopped. Server cleanup may still be pending."
            : "Upload could not be confirmed. Retry uses the same file request.",
        );
    } finally {
      if (current()) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section aria-label="File uploader">
      <label>
        Choose file
        <input
          ref={input}
          type="file"
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            intent.current = null;
            setMessage("");
            setProgress(0);
          }}
        />
      </label>
      <button
        type="button"
        disabled={busy || !file}
        onClick={() => {
          void submit();
        }}
      >
        Upload file
      </button>
      <button
        type="button"
        disabled={!busy}
        onClick={() => {
          const prior = request.current;
          request.current = null;
          intent.current = null;
          setBusy(false);
          setProgress(0);
          setMessage("Transfer stopped. Server cleanup may still be pending.");
          prior?.abort();
        }}
      >
        Cancel upload
      </button>
      {busy && (
        <progress aria-label="Upload progress" value={progress} max={1} />
      )}
      <p role="status">{message}</p>
    </section>
  );
}
