import { TRPCError } from "@trpc/server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import serverConfig from "@karakeep/shared/config";
import {
  getSpeechVoices,
  SpeechBusyError,
  SpeechInvalidInputError,
  SpeechNotConfiguredError,
  SpeechUpstreamError,
  synthesizeSpeech,
} from "@karakeep/shared-server";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { Bookmark } from "@karakeep/trpc/models/bookmarks";

import { authMiddleware } from "../middlewares/auth";
import { chunkReadableContent } from "../utils/readableContent";

const SPEECH_CHUNK_MAX_CHARS = 1000;

export const zBookmarkSpeechRequestSchema = z.object({
  voice: z.string().min(1).max(300),
  start: z.number().int().nonnegative().optional().default(0),
  contentVersion: z.string().optional(),
});

interface SpeechErrorResponse {
  status: ContentfulStatusCode;
  error: string;
  retryAfterSeconds?: number;
}

function errorResponse(error: unknown): SpeechErrorResponse {
  if (error instanceof HTTPException) {
    return { status: error.status, error: error.message };
  }
  if (error instanceof TRPCError) {
    switch (error.code) {
      case "NOT_FOUND":
        return { status: 404, error: "Bookmark not found." };
      case "FORBIDDEN":
        return {
          status: 403,
          error: "You do not have access to this bookmark.",
        };
      default:
        return { status: 500, error: "Internal server error." };
    }
  }
  if (error instanceof SpeechNotConfiguredError) {
    return { status: 503, error: "Local speech is not configured." };
  }
  if (error instanceof SpeechBusyError) {
    return {
      status: 503,
      error: "Local speech is busy. Please retry.",
      retryAfterSeconds: error.retryAfterSeconds ?? 1,
    };
  }
  if (error instanceof SpeechInvalidInputError) {
    return { status: 400, error: "Invalid speech request." };
  }
  if (error instanceof SpeechUpstreamError) {
    return { status: 502, error: "Local speech worker is unavailable." };
  }
  return { status: 500, error: "Internal server error." };
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json";
}

function isSameOrigin(c: {
  req: { header: (name: string) => string | undefined };
}): boolean {
  const publicOrigin = new URL(serverConfig.publicUrl).origin;
  const origin = c.req.header("Origin");
  if (origin) {
    return origin === publicOrigin;
  }
  // Cross-site browser requests always send both Origin and
  // Sec-Fetch-Site: cross-site. Non-browser clients and same-origin
  // browsers may omit Origin, so only reject an explicit cross-site signal.
  return c.req.header("Sec-Fetch-Site") !== "cross-site";
}

export const speechVoicesRoutes = new Hono()
  .use(authMiddleware)
  .get("/voices", async (c) => {
    if (c.var.ctx.auth?.type === "apiKey") {
      return c.json({ error: "API keys cannot use local speech." }, 403);
    }
    const voices = await getSpeechVoices();
    return c.json({ voices }, 200);
  })
  .onError((error, c) => {
    const res = errorResponse(error);
    if (res.retryAfterSeconds !== undefined) {
      c.header("Retry-After", String(res.retryAfterSeconds));
    }
    return c.json({ error: res.error }, res.status);
  });

export const speechBookmarkRoutes = new Hono()
  .use(authMiddleware)
  .post("/:bookmarkId/speech", async (c) => {
    if (c.var.ctx.auth?.type === "apiKey") {
      return c.json({ error: "API keys cannot use local speech." }, 403);
    }
    if (!isSameOrigin(c)) {
      return c.json(
        { error: "Cross-origin speech requests are not allowed." },
        403,
      );
    }
    if (!isJsonContentType(c.req.header("Content-Type"))) {
      return c.json({ error: "Invalid request content type." }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body." }, 400);
    }
    const parsed = zBookmarkSpeechRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request." }, 400);
    }
    const { voice, start, contentVersion } = parsed.data;

    const bookmarkId = c.req.param("bookmarkId");
    const bookmark = await Bookmark.fromId(c.var.ctx, bookmarkId, true);
    bookmark.ensureOwnership();

    const readable = bookmark.asReadableContent("text");
    if (readable.bookmarkType !== BookmarkTypes.LINK) {
      return c.json({ error: "This bookmark cannot be read aloud." }, 422);
    }
    if (!readable.content.trim()) {
      return c.json({ error: "This bookmark has no readable content." }, 422);
    }
    if (
      contentVersion !== undefined &&
      contentVersion !== readable.contentVersion
    ) {
      return c.json(
        { error: "The bookmark content changed. Restart read-aloud." },
        409,
      );
    }

    const chunk = chunkReadableContent({
      bookmarkId,
      content: readable.content,
      contentVersion: readable.contentVersion,
      format: "text",
      maxChars: SPEECH_CHUNK_MAX_CHARS,
      start,
    });
    if (!chunk || chunk.content.length === 0) {
      return c.json({ error: "No more content to read." }, 422);
    }

    const audio = await synthesizeSpeech(chunk.content, voice);

    c.header("Content-Type", "audio/wav");
    c.header("Cache-Control", "private, no-store");
    c.header(
      "X-Speech-Range",
      `${chunk.range.start}-${chunk.range.end}/${chunk.range.total}`,
    );
    c.header("X-Speech-Next", chunk.truncated ? String(chunk.range.end) : "");
    c.header("X-Speech-Content-Version", readable.contentVersion);
    c.header(
      "X-Speech-Text",
      Buffer.from(chunk.content, "utf8").toString("base64url"),
    );
    // Copy exact bytes: Buffer is Uint8Array<ArrayBufferLike>, not Hono's Data.
    return c.body(new Uint8Array(audio), 200);
  })
  .onError((error, c) => {
    const res = errorResponse(error);
    if (res.retryAfterSeconds !== undefined) {
      c.header("Retry-After", String(res.retryAfterSeconds));
    }
    return c.json({ error: res.error }, res.status);
  });
