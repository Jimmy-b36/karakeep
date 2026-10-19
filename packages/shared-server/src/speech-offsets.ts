import type { SpeechWord } from "@karakeep/shared/types/speech";

export interface AlignedWord {
  word: string;
  start: number;
  end: number;
}

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Maps verbatim aligner tokens back to UTF-16 offsets in the original text.
 * Returns null when the tokens do not reconstruct the text, so callers can
 * keep the untimed audio instead of displaying fabricated highlight positions.
 */
export function mapAlignedWords(
  text: string,
  words: AlignedWord[],
  duration: number,
): SpeechWord[] | null {
  if (!Array.isArray(words) || words.length === 0) return null;
  const spans: SpeechWord[] = [];
  let cursor = 0;

  for (const word of words) {
    if (typeof word.word !== "string" || !word.word) return null;
    if (
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < 0 ||
      word.end < word.start
    ) {
      return null;
    }
    let index = text.indexOf(word.word, cursor);
    if (index < 0) {
      index = text.toLowerCase().indexOf(word.word.toLowerCase(), cursor);
    }
    if (index < 0) return null;
    const end = index + word.word.length;
    if (index >= end) return null;
    spans.push({ from: index, to: end, start: word.start, end: word.end });
    cursor = end;
  }

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    if (span.start > span.end || span.end > duration + 0.1) return null;
    if (
      i > 0 &&
      (span.start < spans[i - 1]!.start || span.from < spans[i - 1]!.to)
    ) {
      return null;
    }
  }

  if (
    normalized(
      spans.map((span) => text.slice(span.from, span.to)).join(" "),
    ) !== normalized(text)
  ) {
    return null;
  }
  return spans;
}
