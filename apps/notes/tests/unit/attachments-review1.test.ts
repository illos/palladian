import { afterEach, describe, expect, test, vi } from "vitest";
import { liveAttachmentService } from "../../src/attachments";
import type { LiveController } from "../../src/live";

/**
 * Review round 1 of B3: F7 (an admission answered after the upload stopped
 * waiting). F2's tests went with the persistent cache in round 3.
 */

const OBJECT = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4a";

afterEach(() => {
  vi.useRealTimers();
});

describe("F7: an admission that answers after the upload stopped waiting", () => {
  test("the live service hands back the admission, however long it takes", async () => {
    vi.useFakeTimers();
    let answer!: (grant: unknown) => void;
    const live = {
      getState: () => ({ ready: true, accountId: "ada", connected: true }),
      client: {
        mutation: () => new Promise((resolve) => (answer = resolve)),
      },
      auth: {},
    } as unknown as LiveController;
    const service = liveAttachmentService(live, "ada");
    const admission = service.createUpload({
      noteId: "k1700000000000000000000000000note",
      name: "photo.png",
      mimeType: "image/png",
      size: 1,
      sha256: "0".repeat(64),
      requestId: "upload-review1",
    });
    const settled = vi.fn();
    admission.then(settled, settled);
    await vi.advanceTimersByTimeAsync(31_000);
    answer({
      objectId: OBJECT,
      state: "pending",
      ticket: "t",
      name: "photo.png",
      mimeType: "image/png",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: OBJECT }),
    );
  });
});
