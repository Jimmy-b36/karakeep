import { createHash } from "node:crypto";

import { htmlToSpeechText } from "./htmlUtils";
import { chunkReadableContent } from "./readableContent";

export const PREPARED_SPEECH_VOICE = "kokoro:bf_emma";

export function readableSpeechText(html: string): string {
  return htmlToSpeechText(html).replace(/\r\n?/g, "\n").trim();
}

export function speechContentVersion(text: string): string {
  return `sha256:${createHash("sha256").update("text").update("\0").update(text).digest("hex")}`;
}

export function chunkKokoroSpeech(
  bookmarkId: string,
  text: string,
  start: number,
  contentVersion: string,
) {
  const characters = Array.from(text);
  let maxChars = Math.min(160, characters.length - start);
  if (start + maxChars < characters.length) {
    for (let offset = maxChars - 1; offset >= 80; offset--) {
      if (/\s/.test(characters[start + offset]!)) {
        maxChars = offset + 1;
        break;
      }
    }
  }
  return chunkReadableContent({
    bookmarkId,
    content: text,
    contentVersion,
    format: "text",
    maxChars: Math.max(0, maxChars),
    start,
  });
}
