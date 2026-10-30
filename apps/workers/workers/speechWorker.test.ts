import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
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
    owners: vi.fn(),
    createRunner: vi.fn(),
    errorLog: vi.fn(),
    scheduledRun: null as (() => Promise<void>) | null,
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
    query: {
      bookmarks: { findFirst: mocks.find },
      users: { findMany: mocks.owners },
    },
  },
}));
vi.mock("@karakeep/shared/config", () => ({ default: mocks.config }));
vi.mock("@karakeep/shared/logger", () => ({
  default: { info: vi.fn(), error: mocks.errorLog, warn: vi.fn() },
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

vi.mock("node-cron", () => ({
  default: {
    schedule: (_expression: string, callback: () => Promise<void>) => {
      mocks.scheduledRun = callback;
      return { start: vi.fn(), stop: vi.fn() };
    },
  },
}));
vi.mock("@karakeep/shared/queueing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@karakeep/shared/queueing")>()),
  getQueueClient: async () => ({ createRunner: mocks.createRunner }),
}));

import { speechContentVersion } from "@karakeep/shared/utils/speech";
import {
  prepareRecentSpeech,
  runSpeechPreparation,
  SpeechWorker,
} from "./speechWorker";

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
  mocks.owners.mockResolvedValue([{ id: "owner" }]);
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

  it("queues ten readable articles independently for each user", async () => {
    mocks.owners.mockResolvedValue([{ id: "owner" }, { id: "second-owner" }]);
    mocks.select.offset.mockImplementation(async () =>
      Array.from({ length: 12 }, (_, index) => ({
        id: `article-${mocks.select.offset.mock.calls.length}-${index}`,
        userId:
          mocks.select.offset.mock.calls.length === 1
            ? "owner"
            : "second-owner",
      })),
    );
    await prepareRecentSpeech();
    expect(mocks.initial).toHaveBeenCalledTimes(20);
    expect(
      mocks.initial.mock.calls.filter(
        ([, options]) => options.groupId === "owner",
      ),
    ).toHaveLength(10);
    expect(
      mocks.initial.mock.calls.filter(
        ([, options]) => options.groupId === "second-owner",
      ),
    ).toHaveLength(10);
    expect(mocks.select.offset.mock.calls).toEqual([[0], [0]]);
    const dialect = new SQLiteSyncDialect();
    const filters = mocks.select.where.mock.calls.map(([sql]) =>
      dialect.sqlToQuery(sql),
    );
    expect(filters[0]!.sql).toContain('"bookmarks"."userId" = ?');
    expect(filters[0]!.params).toContain("owner");
    expect(filters[1]!.params).toContain("second-owner");
  });

  it("reconciles again after a failed pass without requiring a restart", async () => {
    mocks.owners.mockRejectedValueOnce(new Error("Database unavailable"));
    await mocks.scheduledRun!();
    expect(mocks.errorLog).toHaveBeenCalledWith(
      expect.stringContaining("Could not queue recent articles"),
    );
    await mocks.scheduledRun!();
    expect(mocks.initial).toHaveBeenCalledTimes(2);
  });

  it("does not overlap reconciliation passes and releases the guard after completion", async () => {
    let finish!: (owners: { id: string }[]) => void;
    mocks.owners.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const running = prepareRecentSpeech();
    await mocks.scheduledRun!();
    expect(mocks.owners).toHaveBeenCalledOnce();
    finish([{ id: "owner" }]);
    await running;
    await mocks.scheduledRun!();
    expect(mocks.owners).toHaveBeenCalledTimes(2);
  });

  it("revisits a failed continuation and reaches the rest of the article", async () => {
    const text = "Read this interesting article together. ".repeat(12).trim();
    const version = speechContentVersion(text);
    await runSpeechPreparation(job());
    const next = mocks.enqueue.mock.calls[0]![0].start;
    mocks.synthesize.mockRejectedValueOnce(new Error("Synthesis unavailable"));
    await expect(runSpeechPreparation(job(next, version))).rejects.toThrow(
      "Synthesis unavailable",
    );
    expect(mocks.enqueue).toHaveBeenCalledOnce();

    mocks.select.offset.mockResolvedValue([
      { id: "bookmark", userId: "owner" },
    ]);
    await mocks.scheduledRun!();
    expect(mocks.initial).toHaveBeenCalledWith("bookmark", {
      groupId: "owner",
    });
    mocks.enqueue.mockClear();
    mocks.synthesize.mockClear();
    await runSpeechPreparation(job());
    for (const [continuation] of mocks.enqueue.mock.calls) {
      await runSpeechPreparation(
        job(continuation.start, continuation.contentVersion),
      );
    }
    expect(
      mocks.synthesize.mock.calls.map(([content]) => content).join(""),
    ).toBe(text);
  });

  it("logs failed chunk identity and retries remaining", async () => {
    await SpeechWorker.build();
    const callbacks = mocks.createRunner.mock.calls[0]![1];
    await callbacks.onError({
      ...job(160, "version"),
      numRetriesLeft: 0,
      error: new Error("Unavailable"),
    });
    expect(mocks.errorLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "bookmark=bookmark start=160 version=version retriesLeft=0",
      ),
    );
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
