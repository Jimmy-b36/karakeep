import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class SpeechBusyError extends Error {
    constructor(public retryAfterSeconds = 30) {
      super("Busy");
    }
  }
  const select = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn(),
  };
  return {
    select,
    find: vi.fn(),
    html: vi.fn(),
    synthesize: vi.fn(),
    enqueue: vi.fn(),
    initial: vi.fn(),
    SpeechBusyError,
    config: {
      speech: { kokoroUrl: "http://kokoro:4320", kokoroToken: "configured" },
    },
  };
});
vi.mock("@karakeep/db", () => ({
  db: {
    select: () => mocks.select,
    query: { bookmarks: { findFirst: mocks.find } },
  },
}));
vi.mock("@karakeep/shared/config", () => ({ default: mocks.config }));
vi.mock("@karakeep/shared/logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("@karakeep/shared-server", () => ({
  enqueueSpeechPreparation: mocks.initial,
  SpeechPreparationQueue: { enqueue: mocks.enqueue },
  SpeechBusyError: mocks.SpeechBusyError,
  synthesizeTimedSpeech: mocks.synthesize,
  zSpeechPreparationRequestSchema: undefined,
}));
vi.mock("@karakeep/trpc/models/bookmarks", () => ({
  Bookmark: { getBookmarkHtmlContent: mocks.html },
}));

import { speechContentVersion } from "@karakeep/shared/utils/speech";
import { prepareRecentSpeech, runSpeechPreparation } from "./speechWorker";

function job(start = 0, contentVersion?: string) {
  return {
    id: "job",
    data: { bookmarkId: "bookmark", start, contentVersion },
    priority: 50,
    runNumber: 0,
    abortSignal: new AbortController().signal,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.speech.kokoroUrl = "http://kokoro:4320";
  mocks.find.mockResolvedValue({
    id: "bookmark",
    userId: "owner",
    inLibrary: true,
    link: { htmlContent: "html" },
  });
  mocks.html.mockResolvedValue(
    "<p>" + "Read this interesting article together. ".repeat(12) + "</p>",
  );
  mocks.synthesize.mockResolvedValue(undefined);
  mocks.select.offset.mockResolvedValue([
    { id: "newest", userId: "owner" },
    { id: "older", userId: "owner" },
  ]);
});

describe("speech preparation", () => {
  it("seeds the ten most recent saved readable links", async () => {
    await prepareRecentSpeech();
    expect(mocks.select.limit).toHaveBeenCalledWith(25);
    expect(mocks.initial.mock.calls).toEqual([
      ["newest", { groupId: "owner" }],
      ["older", { groupId: "owner" }],
    ]);
  });

  it("replaces unreadable newer links until ten actual articles are queued", async () => {
    const readable = Array.from({ length: 10 }, (_, index) => ({
      id: `readable-${index}`,
      userId: "owner",
      htmlContent: "<p>Readable article.</p>",
    }));
    mocks.select.offset.mockResolvedValue([
      { id: "image-only", userId: "owner", htmlContent: "<img src='image'>" },
      ...readable,
    ]);
    mocks.html.mockImplementation(async (link) => link.htmlContent);
    await prepareRecentSpeech();
    expect(mocks.initial).toHaveBeenCalledTimes(10);
    expect(mocks.initial.mock.calls[0]![0]).toBe("readable-0");
    expect(mocks.initial.mock.calls[9]![0]).toBe("readable-9");
  });

  it("pages past unreadable links without blocking the ten-article backfill", async () => {
    mocks.select.offset
      .mockResolvedValueOnce(
        Array.from({ length: 25 }, (_, index) => ({
          id: `empty-${index}`,
          userId: "owner",
          htmlContent: "<img src='image'>",
        })),
      )
      .mockResolvedValueOnce(
        Array.from({ length: 10 }, (_, index) => ({
          id: `readable-${index}`,
          userId: "owner",
          htmlContent: "<p>Read me.</p>",
        })),
      );
    mocks.html.mockImplementation(async (link) => link.htmlContent);
    await prepareRecentSpeech();
    expect(mocks.select.offset.mock.calls).toEqual([[0], [25]]);
    expect(mocks.initial).toHaveBeenCalledTimes(10);
  });

  it("generates only one Emma chunk per job and queues a versioned continuation", async () => {
    const request = job();
    await runSpeechPreparation(request);
    expect(mocks.html).toHaveBeenCalledWith(expect.anything(), "owner");
    expect(mocks.synthesize).toHaveBeenCalledOnce();
    const [text, voice, options] = mocks.synthesize.mock.calls[0]!;
    expect(Array.from(text).length).toBeLessThanOrEqual(160);
    expect(voice).toBe("kokoro:bf_emma");
    expect(options).toEqual({ background: true, signal: request.abortSignal });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        bookmarkId: "bookmark",
        start: text.length,
        contentVersion: expect.stringMatching(/^sha256:/),
      }),
      expect.objectContaining({ groupId: "owner", priority: 50 }),
    );
  });

  it("finishes without a continuation on the last chunk", async () => {
    mocks.html.mockResolvedValue("<p>Short article.</p>");
    await runSpeechPreparation(job());
    expect(mocks.synthesize).toHaveBeenCalledWith(
      "Short article.",
      "kokoro:bf_emma",
      expect.anything(),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("restarts preparation when the article changes", async () => {
    mocks.html.mockResolvedValue("<p>New text.</p>");
    await runSpeechPreparation(job(300, speechContentVersion("old text")));
    expect(mocks.synthesize).toHaveBeenCalledWith(
      "New text.",
      "kokoro:bf_emma",
      expect.anything(),
    );
  });

  it("defers busy work without consuming retry attempts or advancing the article", async () => {
    mocks.synthesize.mockRejectedValueOnce(new mocks.SpeechBusyError(30));
    await expect(runSpeechPreparation(job())).rejects.toMatchObject({
      name: "QueueRetryAfterError",
      delayMs: 30000,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { id: "bookmark", inLibrary: false, link: {} },
    { id: "bookmark", inLibrary: true, link: null },
  ])("skips missing or unsaved articles", async (bookmark) => {
    mocks.find.mockResolvedValue(bookmark);
    await runSpeechPreparation(job());
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it("does no work when Kokoro is not configured or the job was aborted", async () => {
    mocks.config.speech.kokoroUrl = "";
    await prepareRecentSpeech();
    await runSpeechPreparation(job());
    expect(mocks.initial).not.toHaveBeenCalled();
    expect(mocks.synthesize).not.toHaveBeenCalled();
    mocks.config.speech.kokoroUrl = "http://kokoro:4320";
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSpeechPreparation({ ...job(), abortSignal: controller.signal }),
    ).rejects.toThrow();
  });
});
