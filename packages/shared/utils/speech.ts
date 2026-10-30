import { createHash } from "node:crypto";

import { htmlToSpeechText } from "./htmlUtils";
import { encodeReadableContentCursor } from "./readableContent";

export const PREPARED_SPEECH_VOICE = "kokoro:bf_emma";
// shortcut: provisional envelope; tune only after Pi latency/RSS and listening checks.
export const KOKORO_SPEECH_MAX_CHARS = 320;
const TARGET_CHARS = 240;
const MIN_CHARS = 160;
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const abbreviationEnd =
  /(?:^|[\s.])(?:Mrs?|Ms|Dr|Prof|Rev|St|Mt|Jr|Sr|No|Vol|Ch|Fig|pp?|e\.g|i\.e|vs|etc|Ltd|Inc|Co|[Dd]ept|[Ee]st|[A-Z])\.\s*$/;

export function readableSpeechText(html: string): string {
  return htmlToSpeechText(html).replace(/\r\n?/g, "\n").trim();
}

export function speechContentVersion(text: string): string {
  return `sha256:${createHash("sha256").update("speech-sentences-v1").update("\0").update(text).digest("hex")}`;
}

function speechSentences(paragraph: string): string[] {
  // Keep UTF-16 indices identical to the source, including wrapped lines.
  const view = paragraph.replace(/[\r\n]/g, " ");
  const segments = Array.from(sentenceSegmenter.segment(view));
  const sentences: string[] = [];
  let pending = "";
  for (let i = 0; i < segments.length; i++) {
    const { index, segment } = segments[i]!;
    pending += paragraph.slice(index, index + segment.length);
    const next = segments[i + 1];
    if (
      next &&
      (abbreviationEnd.test(pending) || /^\s*[a-z]/.test(next.segment))
    )
      continue;
    sentences.push(pending);
    pending = "";
  }
  return sentences;
}

function splitOversizedSentence(sentence: string): number {
  const characters = Array.from(sentence);
  for (let i = KOKORO_SPEECH_MAX_CHARS - 1; i >= MIN_CHARS; i--) {
    if (/[,;:—–]/.test(characters[i]!) && /\s/.test(characters[i + 1]!))
      return i + 1;
  }
  for (let i = KOKORO_SPEECH_MAX_CHARS - 1; i >= 0; i--) {
    if (/\s/.test(characters[i]!)) return i + 1;
  }
  // A single overlong token still has to fit the service's safety ceiling.
  return KOKORO_SPEECH_MAX_CHARS;
}

export function chunkKokoroSpeech(
  bookmarkId: string,
  text: string,
  start: number,
  contentVersion: string,
) {
  const characters = Array.from(text);
  if (!Number.isSafeInteger(start) || start < 0 || start > characters.length)
    return null;
  const remaining = characters.slice(start).join("");
  const firstWord = Math.max(0, remaining.search(/\S/));
  const paragraphBreak = /\n(?:[\t ]*\n)+[\t ]*/.exec(
    remaining.slice(firstWord),
  );
  const paragraph = paragraphBreak
    ? remaining.slice(
        0,
        firstWord + paragraphBreak.index + paragraphBreak[0].length,
      )
    : remaining;
  const sentences = speechSentences(paragraph);
  let length = 0;
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]!;
    const count = Array.from(sentence).length;
    if (count > KOKORO_SPEECH_MAX_CHARS) {
      if (length === 0) length = splitOversizedSentence(sentence);
      break;
    }
    const total = length + count;
    const shortTail = i === sentences.length - 1 && count < MIN_CHARS;
    if (
      total > KOKORO_SPEECH_MAX_CHARS ||
      (total > TARGET_CHARS && length >= MIN_CHARS && !shortTail)
    )
      break;
    length = total;
  }
  const end = start + length;
  const truncated = end < characters.length;
  return {
    content: characters.slice(start, end).join(""),
    range: { start, end, total: characters.length },
    truncated,
    nextCursor: truncated
      ? encodeReadableContentCursor({
          bookmarkId,
          contentVersion,
          format: "text",
          offset: end,
          version: 1,
        })
      : null,
  };
}
