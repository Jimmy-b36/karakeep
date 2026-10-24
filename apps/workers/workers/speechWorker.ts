import { and, desc, eq, isNotNull, ne, or } from "drizzle-orm";

import { db } from "@karakeep/db";
import { bookmarkLinks, bookmarks } from "@karakeep/db/schema";
import {
  enqueueSpeechPreparation,
  SpeechBusyError,
  SpeechPreparationQueue,
  synthesizeTimedSpeech,
  zSpeechPreparationRequestSchema,
} from "@karakeep/shared-server";
import type { ZSpeechPreparationRequest } from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import {
  getQueueClient,
  QueueRetryAfterError,
} from "@karakeep/shared/queueing";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import {
  chunkKokoroSpeech,
  PREPARED_SPEECH_VOICE,
  readableSpeechText,
  speechContentVersion,
} from "@karakeep/shared/utils/speech";
import { Bookmark } from "@karakeep/trpc/models/bookmarks";

export async function prepareRecentSpeech(): Promise<void> {
  if (!serverConfig.speech.kokoroUrl || !serverConfig.speech.kokoroToken)
    return;
  let prepared = 0;
  for (let offset = 0; prepared < 10; offset += 25) {
    const recent = await db
      .select({
        id: bookmarks.id,
        userId: bookmarks.userId,
        htmlContent: bookmarkLinks.htmlContent,
        contentAssetId: bookmarkLinks.contentAssetId,
      })
      .from(bookmarks)
      .innerJoin(bookmarkLinks, eq(bookmarks.id, bookmarkLinks.id))
      .where(
        and(
          eq(bookmarks.type, BookmarkTypes.LINK),
          eq(bookmarks.inLibrary, true),
          or(
            ne(bookmarkLinks.htmlContent, ""),
            isNotNull(bookmarkLinks.contentAssetId),
          ),
        ),
      )
      .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
      .limit(25)
      .offset(offset);
    for (const bookmark of recent) {
      let html: string | null;
      try {
        html = await Bookmark.getBookmarkHtmlContent(bookmark, bookmark.userId);
      } catch {
        logger.warn(
          `[speech] Could not read article ${bookmark.id} during backfill`,
        );
        continue;
      }
      if (!readableSpeechText(html ?? "")) continue;
      await enqueueSpeechPreparation(bookmark.id, { groupId: bookmark.userId });
      if (++prepared === 10) break;
    }
    if (recent.length < 25) break;
  }
  logger.info(
    `[speech] Queued ${prepared} recent saved articles for Emma preparation`,
  );
}

export async function runSpeechPreparation(
  job: DequeuedJob<ZSpeechPreparationRequest>,
): Promise<void> {
  if (!serverConfig.speech.kokoroUrl || !serverConfig.speech.kokoroToken)
    return;
  job.abortSignal.throwIfAborted();
  const bookmark = await db.query.bookmarks.findFirst({
    where: eq(bookmarks.id, job.data.bookmarkId),
    with: { link: true },
  });
  if (!bookmark?.inLibrary || !bookmark.link) return;
  const html = await Bookmark.getBookmarkHtmlContent(
    bookmark.link,
    bookmark.userId,
  );
  const text = readableSpeechText(html ?? "");
  if (!text) return;
  const version = speechContentVersion(text);
  // Editing or re-crawling an article restarts preparation using its new content.
  const start =
    job.data.contentVersion && job.data.contentVersion !== version
      ? 0
      : job.data.start;
  const chunk = chunkKokoroSpeech(bookmark.id, text, start, version);
  if (!chunk?.content) return;
  try {
    await synthesizeTimedSpeech(chunk.content, PREPARED_SPEECH_VOICE, {
      background: true,
      signal: job.abortSignal,
    });
  } catch (error) {
    if (error instanceof SpeechBusyError) {
      throw new QueueRetryAfterError(
        "Speech is serving a listener",
        Math.max(1000, (error.retryAfterSeconds ?? 30) * 1000),
      );
    }
    throw error;
  }
  job.abortSignal.throwIfAborted();
  if (chunk.truncated) {
    await SpeechPreparationQueue.enqueue(
      {
        bookmarkId: bookmark.id,
        start: chunk.range.end,
        contentVersion: version,
      },
      {
        priority: job.priority,
        groupId: bookmark.userId,
        idempotencyKey: `speech:${bookmark.id}:${version}:${chunk.range.end}`,
      },
    );
  } else {
    logger.info(`[speech] Article ${bookmark.id} fully prepared with Emma`);
  }
}

export class SpeechWorker {
  static async build() {
    logger.info("Starting speech preparation worker ...");
    return (await getQueueClient()).createRunner(
      SpeechPreparationQueue,
      {
        run: runSpeechPreparation,
        onError: async (job) => {
          logger.error(
            `[speech][${job.id}] Preparation failed: ${job.error.message}`,
          );
        },
      },
      {
        concurrency: 1,
        pollIntervalMs: 1000,
        timeoutSecs: 90,
        validator: zSpeechPreparationRequestSchema,
      },
    );
  }
}
