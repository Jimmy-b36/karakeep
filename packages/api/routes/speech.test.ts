import { TRPCError } from "@trpc/server";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "@karakeep/trpc";

const {
  getSpeechVoicesMock,
  synthesizeSpeechMock,
  synthesizeTimedSpeechMock,
  SpeechNotConfiguredError,
  SpeechBusyError,
  SpeechInvalidInputError,
  SpeechUpstreamError,
  bookmarkFromIdMock,
  config,
} = vi.hoisted(() => {
  class SpeechNotConfiguredError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SpeechNotConfiguredError";
    }
  }
  class SpeechBusyError extends Error {
    retryAfterSeconds?: number;
    constructor(message: string, retryAfterSeconds?: number) {
      super(message);
      this.name = "SpeechBusyError";
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
  class SpeechInvalidInputError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SpeechInvalidInputError";
    }
  }
  class SpeechUpstreamError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SpeechUpstreamError";
    }
  }
  return {
    getSpeechVoicesMock: vi.fn(),
    synthesizeSpeechMock: vi.fn(),
    synthesizeTimedSpeechMock: vi.fn(),
    SpeechNotConfiguredError,
    SpeechBusyError,
    SpeechInvalidInputError,
    SpeechUpstreamError,
    bookmarkFromIdMock: vi.fn(),
    config: {
      publicUrl: "https://karakeep.example.com",
    },
  };
});

vi.mock("@karakeep/trpc", () => ({
  createCallerFactory: () => () => ({}),
}));
vi.mock("@karakeep/shared/config", () => ({ default: config }));
vi.mock("@karakeep/trpc/routers/_app", () => ({
  appRouter: {},
}));
vi.mock("@karakeep/shared-server", () => ({
  getSpeechVoices: getSpeechVoicesMock,
  synthesizeSpeech: synthesizeSpeechMock,
  synthesizeTimedSpeech: synthesizeTimedSpeechMock,
  SpeechNotConfiguredError,
  SpeechBusyError,
  SpeechInvalidInputError,
  SpeechUpstreamError,
}));
vi.mock("@karakeep/trpc/models/bookmarks", () => ({
  Bookmark: { fromId: bookmarkFromIdMock },
}));

import { speechBookmarkRoutes, speechVoicesRoutes } from "./speech";

const sessionCtx: Context = {
  user: { id: "user-1", role: "user" },
  auth: { type: "session" },
  db: {} as never,
  req: { ip: "127.0.0.1" },
};

const apiKeyCtx: Context = {
  user: { id: "user-1", role: "user" },
  auth: { type: "apiKey", keyId: "key-1", scopes: ["fullaccess"] },
  db: {} as never,
  req: { ip: "127.0.0.1" },
};

const unauthedCtx: Context = {
  user: null,
  auth: null,
  db: {} as never,
  req: { ip: "127.0.0.1" },
};

function buildVoicesApp(ctx: Context) {
  return new Hono<{ Variables: { ctx: Context } }>()
    .use(async (c, next) => {
      c.set("ctx", ctx);
      await next();
    })
    .route("/speech", speechVoicesRoutes);
}

function buildBookmarkApp(ctx: Context) {
  return new Hono<{ Variables: { ctx: Context } }>()
    .use(async (c, next) => {
      c.set("ctx", ctx);
      await next();
    })
    .route("/bookmarks", speechBookmarkRoutes);
}

function speechVersionFor(text: string): string {
  return `sha256:${createHash("sha256")
    .update("text")
    .update("\0")
    .update(text)
    .digest("hex")}`;
}

function fakeBookmark(overrides?: {
  ensureOwnershipError?: TRPCError;
  type?: "link" | "text" | "asset";
  htmlContent?: string;
}) {
  const bookmark = {
    ensureOwnership: vi.fn(() => {
      if (overrides?.ensureOwnershipError) {
        throw overrides.ensureOwnershipError;
      }
    }),
    asZBookmark: vi.fn(() => ({
      id: "bm1",
      content:
        overrides?.type && overrides.type !== "link"
          ? { type: overrides.type }
          : {
              type: "link" as const,
              htmlContent: overrides?.htmlContent ?? "Hello world.",
            },
    })),
  };
  bookmarkFromIdMock.mockResolvedValue(bookmark);
  return bookmark;
}

async function postSpeech(
  app: ReturnType<typeof buildBookmarkApp>,
  body: unknown,
  headers: Record<string, string> = { "Content-Type": "application/json" },
): Promise<Response> {
  return await app.request("http://localhost/bookmarks/bm1/speech", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSpeechVoicesMock.mockReset();
  synthesizeSpeechMock.mockReset();
  synthesizeTimedSpeechMock.mockReset();
  bookmarkFromIdMock.mockReset();
});

describe("GET /speech/voices", () => {
  it("rejects unauthenticated requests", async () => {
    const app = buildVoicesApp(unauthedCtx);

    const response = await app.request("http://localhost/speech/voices");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getSpeechVoicesMock).not.toHaveBeenCalled();
  });

  it("rejects API-key authentication", async () => {
    const app = buildVoicesApp(apiKeyCtx);

    const response = await app.request("http://localhost/speech/voices");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "API keys cannot use local speech.",
    });
    expect(getSpeechVoicesMock).not.toHaveBeenCalled();
  });

  it("returns the validated voice catalog for a session", async () => {
    getSpeechVoicesMock.mockResolvedValue([
      { id: "voice-1", name: "Voice One", language: "en-US" },
    ]);
    const app = buildVoicesApp(sessionCtx);

    const response = await app.request("http://localhost/speech/voices");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      voices: [{ id: "voice-1", name: "Voice One", language: "en-US" }],
    });
    expect(getSpeechVoicesMock).toHaveBeenCalledOnce();
  });

  it("maps not configured to 503", async () => {
    getSpeechVoicesMock.mockRejectedValue(
      new SpeechNotConfiguredError("missing"),
    );
    const app = buildVoicesApp(sessionCtx);

    const response = await app.request("http://localhost/speech/voices");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Local speech is not configured.",
    });
  });

  it("maps busy to 503 with Retry-After", async () => {
    getSpeechVoicesMock.mockRejectedValue(new SpeechBusyError("busy", 2));
    const app = buildVoicesApp(sessionCtx);

    const response = await app.request("http://localhost/speech/voices");

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toEqual({
      error: "Local speech is busy. Please retry.",
    });
  });
});

describe("POST /bookmarks/:bookmarkId/speech", () => {
  it("uses shorter word-boundary chunks for local timed speech", async () => {
    fakeBookmark({ htmlContent: "<p>" + "sample words ".repeat(80) + "</p>" });
    synthesizeTimedSpeechMock.mockResolvedValueOnce({
      audio: "test",
      duration: 1,
      words: [],
    });
    const response = await postSpeech(buildBookmarkApp(sessionCtx), {
      voice: "kokoro:af_heart",
    });
    expect(response.status).toBe(200);
    const text = synthesizeTimedSpeechMock.mock.calls[0][0] as string;
    expect(Array.from(text).length).toBeLessThanOrEqual(400);
    expect(text.endsWith(" ")).toBe(true);
    expect(Number(response.headers.get("X-Speech-Next"))).toBe(
      Array.from(text).length,
    );
  });
  it("denies timed synthesis to nonowners without contacting either worker", async () => {
    fakeBookmark({
      ensureOwnershipError: new TRPCError({ code: "FORBIDDEN" }),
    });
    const response = await postSpeech(buildBookmarkApp(sessionCtx), {
      voice: "kokoro:af_heart",
    });
    expect(response.status).toBe(403);
    expect(synthesizeTimedSpeechMock).not.toHaveBeenCalled();
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });
  it("returns Kokoro audio and word metadata only after owner authorization", async () => {
    fakeBookmark();
    const timed = {
      audio: "UklGRjAwMDBXQVZF",
      duration: 1,
      words: [{ from: 0, to: 5, start: 0, end: 0.8 }],
    };
    synthesizeTimedSpeechMock.mockResolvedValueOnce(timed);
    const response = await postSpeech(buildBookmarkApp(sessionCtx), {
      voice: "kokoro:af_heart",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(timed);
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
    expect(synthesizeTimedSpeechMock).toHaveBeenCalledWith(
      "Hello world.",
      "kokoro:af_heart",
    );
  });
  it("rejects unauthenticated requests without synthesis", async () => {
    const app = buildBookmarkApp(unauthedCtx);

    const response = await postSpeech(app, { voice: "voice-1" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("rejects API-key authentication without synthesis", async () => {
    const app = buildBookmarkApp(apiKeyCtx);

    const response = await postSpeech(app, { voice: "voice-1" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "API keys cannot use local speech.",
    });
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("rejects foreign Origin without content lookup or synthesis", async () => {
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(
      app,
      { voice: "voice-1" },
      {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Cross-origin speech requests are not allowed.",
    });
    expect(bookmarkFromIdMock).not.toHaveBeenCalled();
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("rejects cross-site Sec-Fetch-Site when Origin is absent", async () => {
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(
      app,
      { voice: "voice-1" },
      {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Cross-origin speech requests are not allowed.",
    });
    expect(bookmarkFromIdMock).not.toHaveBeenCalled();
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("allows same-origin and missing-Origin non-browser requests", async () => {
    fakeBookmark();
    synthesizeSpeechMock.mockResolvedValue(Buffer.from("RIFFxxxxWAVEyyyy"));
    const app = buildBookmarkApp(sessionCtx);

    const sameOrigin = await postSpeech(
      app,
      { voice: "voice-1" },
      {
        "Content-Type": "application/json",
        Origin: "https://karakeep.example.com",
      },
    );
    expect(sameOrigin.status).toBe(200);

    const missingOrigin = await postSpeech(app, { voice: "voice-1" });
    expect(missingOrigin.status).toBe(200);

    expect(synthesizeSpeechMock).toHaveBeenCalledTimes(2);
  });

  it("rejects non-JSON content types without content lookup or synthesis", async () => {
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(
      app,
      { voice: "voice-1" },
      { "Content-Type": "text/plain" },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid request content type.",
    });
    expect(bookmarkFromIdMock).not.toHaveBeenCalled();
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("accepts application/json with a charset parameter", async () => {
    fakeBookmark();
    synthesizeSpeechMock.mockResolvedValue(Buffer.from("RIFFxxxxWAVEyyyy"));
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(
      app,
      { voice: "voice-1" },
      { "Content-Type": "application/json; charset=utf-8" },
    );

    expect(response.status).toBe(200);
    expect(synthesizeSpeechMock).toHaveBeenCalledOnce();
  });

  it("rejects non-owners without synthesis", async () => {
    const bookmark = fakeBookmark({
      ensureOwnershipError: new TRPCError({ code: "FORBIDDEN" }),
    });
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(app, { voice: "voice-1" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "You do not have access to this bookmark.",
    });
    expect(bookmark.asZBookmark).not.toHaveBeenCalled();
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("maps missing bookmarks to 404", async () => {
    bookmarkFromIdMock.mockRejectedValue(new TRPCError({ code: "NOT_FOUND" }));
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(app, { voice: "voice-1" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Bookmark not found." });
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported bookmark types with 422", async () => {
    fakeBookmark({ type: "text" });
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(app, { voice: "voice-1" });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "This bookmark cannot be read aloud.",
    });
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("rejects empty readable content with 422", async () => {
    fakeBookmark({ htmlContent: "   " });
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(app, { voice: "voice-1" });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "This bookmark has no readable content.",
    });
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("rejects invalid requests with 400 before synthesis", async () => {
    fakeBookmark();
    const app = buildBookmarkApp(sessionCtx);

    const missingVoice = await postSpeech(app, { start: 0 });
    expect(missingVoice.status).toBe(400);
    expect(await missingVoice.json()).toEqual({ error: "Invalid request." });

    const negativeStart = await postSpeech(app, {
      voice: "voice-1",
      start: -1,
    });
    expect(negativeStart.status).toBe(400);
    expect(await negativeStart.json()).toEqual({ error: "Invalid request." });

    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("renders LINK HTML as DOM-matching speech text", async () => {
    fakeBookmark({
      htmlContent:
        '<a href="https://x.com">link text</a>' +
        "<h2>Heading</h2>" +
        "<ul><li>item</li></ul>",
    });
    synthesizeSpeechMock.mockResolvedValue(Buffer.from("RIFFxxxxWAVEyyyy"));
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(app, { voice: "voice-1", start: 0 });

    expect(response.status).toBe(200);
    const header = response.headers.get("X-Speech-Text");
    expect(header).not.toBeNull();
    const text = Buffer.from(header!, "base64url").toString("utf8");
    expect(text).toContain("link text");
    expect(text).not.toContain("https://x.com");
    expect(text).toContain("Heading");
    expect(text).not.toContain("HEADING");
    expect(text).toContain("item");
    expect(text).not.toContain("*");
  });

  it("returns 409 on content-version mismatch before synthesis", async () => {
    const bookmark = fakeBookmark({ htmlContent: "Hello world." });
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(app, {
      voice: "voice-1",
      start: 0,
      contentVersion: "sha256:old",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The bookmark content changed. Restart read-aloud.",
    });
    expect(bookmark.asZBookmark).toHaveBeenCalledOnce();
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("synthesizes a chunk and returns WAV with range headers", async () => {
    const content = "a".repeat(1200);
    const contentVersion = speechVersionFor(content);
    fakeBookmark({ htmlContent: content });
    synthesizeSpeechMock.mockResolvedValue(Buffer.from("RIFFxxxxWAVEyyyy"));
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(app, {
      voice: "voice-1",
      start: 0,
      contentVersion,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Speech-Content-Version")).toBe(
      contentVersion,
    );
    expect(response.headers.get("X-Speech-Range")).toBe("0-1000/1200");
    expect(response.headers.get("X-Speech-Next")).toBe("1000");
    expect(synthesizeSpeechMock).toHaveBeenCalledOnce();
    const text = synthesizeSpeechMock.mock.calls[0]![0] as string;
    expect([...text].length).toBe(1000);
    expect(
      Buffer.from(response.headers.get("X-Speech-Text")!, "base64url").toString(
        "utf8",
      ),
    ).toBe(text);
  });

  it("returns the chunk text as a UTF-8 base64url header", async () => {
    const content = "Héllo wörld — unicode 😀";
    fakeBookmark({ htmlContent: content });
    synthesizeSpeechMock.mockResolvedValue(Buffer.from("RIFFxxxxWAVEyyyy"));
    const app = buildBookmarkApp(sessionCtx);

    const response = await postSpeech(app, {
      voice: "voice-1",
      start: 0,
      contentVersion: speechVersionFor(content),
    });

    expect(response.status).toBe(200);
    const header = response.headers.get("X-Speech-Text");
    expect(header).not.toBeNull();
    expect(Buffer.from(header!, "base64url").toString("utf8")).toBe(content);
  });

  it("iterates long Unicode text in 1000-codepoint chunks", async () => {
    const content = "😀".repeat(1200) + "b".repeat(1300);
    const contentVersion = speechVersionFor(content);
    fakeBookmark({ htmlContent: content });
    synthesizeSpeechMock.mockResolvedValue(Buffer.from("RIFFxxxxWAVEyyyy"));
    const app = buildBookmarkApp(sessionCtx);

    const texts: string[] = [];
    let start = 0;
    while (true) {
      const response = await postSpeech(app, {
        voice: "voice-1",
        start,
        contentVersion,
      });

      expect(response.status).toBe(200);
      const lastCall = synthesizeSpeechMock.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const text = lastCall![0] as string;
      expect(text.length).toBeGreaterThan(0);
      expect([...text].length).toBeLessThanOrEqual(1000);
      expect(text.length).toBeLessThanOrEqual(2000);
      texts.push(text);

      const next = response.headers.get("X-Speech-Next");
      if (!next) {
        break;
      }
      start = Number(next);
    }

    expect(texts.join("")).toBe(content);
  });

  it("returns 422 for out-of-range offsets without synthesis", async () => {
    const content = "abc";
    const contentVersion = speechVersionFor(content);
    fakeBookmark({ htmlContent: content });
    const app = buildBookmarkApp(sessionCtx);

    const atEnd = await postSpeech(app, {
      voice: "voice-1",
      start: 3,
      contentVersion,
    });
    expect(atEnd.status).toBe(422);
    expect(await atEnd.json()).toEqual({ error: "No more content to read." });

    const beyondEnd = await postSpeech(app, {
      voice: "voice-1",
      start: 4,
      contentVersion,
    });
    expect(beyondEnd.status).toBe(422);
    expect(await beyondEnd.json()).toEqual({
      error: "No more content to read.",
    });

    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });
});
