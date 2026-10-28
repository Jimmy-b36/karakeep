import { describe, expect, it } from "vitest";

import {
  chunkKokoroSpeech,
  readableSpeechText,
  speechContentVersion,
} from "./speech";

describe("canonical speech chunks", () => {
  it("reconstructs entire articles with identical <=160-character playback chunks", () => {
    const text = readableSpeechText(
      "<p>" +
        "Read these words 😀, repeated words. ".repeat(30) +
        "</p><p>The end.</p>",
    );
    const version = speechContentVersion(text);
    let start = 0;
    const parts = [];
    for (;;) {
      const chunk = chunkKokoroSpeech("bookmark", text, start, version)!;
      expect(Array.from(chunk.content).length).toBeLessThanOrEqual(160);
      expect(chunk.range.end).toBeGreaterThan(start);
      parts.push(chunk.content);
      if (!chunk.truncated) break;
      start = chunk.range.end;
    }
    expect(parts.join("")).toBe(text);
    expect(parts.length).toBeGreaterThan(1);
  });

  it("changes the version with spoken content but not irrelevant markup", () => {
    const first = readableSpeechText("<p>Hello <strong>world</strong>.</p>");
    const second = readableSpeechText("<p>Hello world.</p>");
    expect(speechContentVersion(first)).toBe(speechContentVersion(second));
    expect(speechContentVersion(first + " changed")).not.toBe(
      speechContentVersion(first),
    );
  });

  it("returns no chunk for an offset beyond the article", () => {
    expect(chunkKokoroSpeech("bookmark", "Hello", 100, "version")).toBeNull();
  });
});
