import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decodeReadableContentCursor } from "./readableContent";
import {
  chunkKokoroSpeech,
  KOKORO_SPEECH_MAX_CHARS,
  readableSpeechText,
  speechContentVersion,
} from "./speech";

function chunks(text: string, start = 0) {
  const parts: string[] = [];
  const version = speechContentVersion(text);
  let offset = start;
  for (;;) {
    const chunk = chunkKokoroSpeech("bookmark", text, offset, version)!;
    expect(chunk.range.start).toBe(offset);
    expect(chunk.range.end).toBeGreaterThan(offset);
    expect(chunk.range.total).toBe(Array.from(text).length);
    expect(Array.from(chunk.content).length).toBeLessThanOrEqual(
      KOKORO_SPEECH_MAX_CHARS,
    );
    parts.push(chunk.content);
    if (!chunk.truncated) break;
    expect(decodeReadableContentCursor(chunk.nextCursor!)?.offset).toBe(
      chunk.range.end,
    );
    offset = chunk.range.end;
  }
  expect(parts.join("")).toBe(Array.from(text).slice(start).join(""));
  return parts;
}

describe("canonical speech chunks", () => {
  it("reconstructs Unicode articles with bounded, matching playback/preparation chunks", () => {
    const text = readableSpeechText(
      "<p>" +
        "Read these words 😀, repeated words. ".repeat(30) +
        "</p><p>The end.</p>",
    );
    const parts = chunks(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.trimEnd()).toMatch(/[.!?]$/);
    expect(chunks(text)).toEqual(parts);
  });

  it("groups short sentences rather than making one request per full stop", () => {
    const text = "Yes. Exactly. That is the point. No. Go. Stop.";
    expect(chunks(text)).toEqual([text]);
  });

  it("allows a short group to run past the target to finish the next sentence", () => {
    const text = "Yes. " + "This " + "thought ".repeat(32) + "ends here.";
    expect(text.length).toBeGreaterThan(240);
    expect(chunks(text)).toEqual([text]);
  });

  it("ends ordinary groups at complete sentences, not the hard character limit", () => {
    const first = "A".repeat(170) + ". ";
    const second = "B".repeat(70) + ". ";
    const third = "C".repeat(100) + ".";
    expect(chunks(first + second + third)).toEqual([first, second + third]);
  });

  it("absorbs a short final sentence when it still fits the hard ceiling", () => {
    const text = "A".repeat(245) + ". Yes.";
    expect(chunks(text)).toEqual([text]);
  });

  it("repairs title/initial and quoted-dialogue fragments at a batch boundary", () => {
    const prefix = "A".repeat(170) + ". ";
    for (const sentence of [
      "Dr. Smith " + "arrived ".repeat(10) + "today.",
      "J. R. Smith " + "arrived ".repeat(10) + "today.",
      "For example, e.g. Alice " + "arrived ".repeat(10) + "today.",
      "For example, i.e. Alice " + "arrived ".repeat(10) + "today.",
      "Team A vs. Team B " + "competed ".repeat(9) + "today.",
      "The Acme Inc. Team " + "arrived ".repeat(10) + "today.",
      "“Really?” she asked " + "very ".repeat(20) + "quietly.",
    ]) {
      const tail = " Next thought.";
      expect(chunks(prefix + sentence + tail)).toEqual([
        prefix,
        sentence + tail,
      ]);
    }
  });

  it("keeps decimals, versions, URLs and abbreviations intact", () => {
    const sentence =
      "The U.S. team paid $3.14 for v1.2.3 at https://example.com/a.b. ";
    const parts = chunks(sentence.repeat(12));
    for (const part of parts) expect(part.trimEnd()).toMatch(/a\.b\.$/);
  });

  it("preserves wrapped lines but flushes at a paragraph break", () => {
    const paragraph =
      "This " + "thought ".repeat(20) + "continues\non this line.\n \n";
    expect(chunks(paragraph + "Next paragraph.")).toEqual([
      paragraph,
      "Next paragraph.",
    ]);
  });

  it("consumes whitespace-only blank lines without emitting a silent chunk", () => {
    const first = "Read this.\n \n \n  ";
    const text = first + "The next paragraph.";
    expect(chunks(text)).toEqual([first, "The next paragraph."]);
    expect(chunks(text, "Read this.".length)).toEqual([
      text.slice("Read this.".length),
    ]);
  });

  it("splits an oversized sentence at a substantial clause before falling back to words", () => {
    const first = "word ".repeat(36) + "pause;";
    const text = first + " " + "more words ".repeat(60) + "end.";
    expect(chunks(text)[0]).toBe(first);
    for (const part of chunks("word ".repeat(200)))
      expect(part.endsWith(" ")).toBe(true);
  });

  it("bounds a single oversized token without splitting a surrogate pair", () => {
    const parts = chunks("😀".repeat(400));
    expect(Array.from(parts[0]!)).toHaveLength(KOKORO_SPEECH_MAX_CHARS);
    expect(parts[0]!.includes("�")).toBe(false);
  });

  it("preserves arbitrary codepoint jump offsets and subsequent continuations", () => {
    const text = "😀 Dr. Smith reads this sentence. ".repeat(25);
    for (const start of [1, 8, 159, 321]) chunks(text, start);
  });

  it("versions the grouping policy while ignoring irrelevant markup", () => {
    const first = readableSpeechText("<p>Hello <strong>world</strong>.</p>");
    const second = readableSpeechText("<p>Hello world.</p>");
    expect(speechContentVersion(first)).toBe(speechContentVersion(second));
    expect(speechContentVersion(first + " changed")).not.toBe(
      speechContentVersion(first),
    );
    const legacy = `sha256:${createHash("sha256").update("text").update("\0").update(first).digest("hex")}`;
    expect(speechContentVersion(first)).not.toBe(legacy);
  });

  it.each([-1, 100, 0.5, Number.NaN])(
    "rejects invalid or out-of-range offset %s",
    (start) => {
      expect(
        chunkKokoroSpeech("bookmark", "Hello", start, "version"),
      ).toBeNull();
    },
  );
});
