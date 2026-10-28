import { afterEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  speech: { kokoroUrl: "", kokoroToken: "" },
}));
vi.mock("@karakeep/shared/config", () => ({ default: config }));

import {
  enqueueSpeechPreparation,
  QueuePriority,
  SpeechPreparationQueue,
} from "./queues";

afterEach(() => {
  vi.restoreAllMocks();
  config.speech.kokoroUrl = "";
  config.speech.kokoroToken = "";
});

describe("enqueueSpeechPreparation", () => {
  it("does not enqueue when Kokoro is not configured", async () => {
    const enqueue = vi.spyOn(SpeechPreparationQueue, "enqueue");
    await enqueueSpeechPreparation("bookmark");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("deduplicates the initial article job at low priority", async () => {
    config.speech.kokoroUrl = "http://kokoro:4320";
    config.speech.kokoroToken = "configured";
    const enqueue = vi
      .spyOn(SpeechPreparationQueue, "enqueue")
      .mockResolvedValue("job");
    await enqueueSpeechPreparation("bookmark", { groupId: "owner" });
    expect(enqueue).toHaveBeenCalledWith(
      { bookmarkId: "bookmark", start: 0 },
      {
        priority: QueuePriority.Low,
        groupId: "owner",
        idempotencyKey: "speech:bookmark:initial",
      },
    );
  });
});
