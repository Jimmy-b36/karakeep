import { describe, expect, it } from "vitest";

import { mapAlignedWords } from "./speech-offsets";

describe("mapAlignedWords", () => {
  it("maps verbatim tokens to UTF-16 offsets in order", () => {
    const text = "A sufficiently long sentence for listening.";
    const spans = mapAlignedWords(
      text,
      [
        { word: "A", start: 0, end: 1.5 },
        { word: "sufficiently", start: 1.5, end: 3 },
        { word: "long", start: 3, end: 4 },
        { word: "sentence", start: 4, end: 5.5 },
        { word: "for", start: 5.5, end: 6.5 },
        { word: "listening.", start: 6.5, end: 8 },
      ],
      8,
    );
    expect(spans?.map((span) => [span.from, span.to])).toEqual([
      [0, 1],
      [2, 14],
      [15, 19],
      [20, 28],
      [29, 32],
      [33, 43],
    ]);
  });

  it("resolves repeated words and keeps emoji surrogate pairs intact", () => {
    const repeated = mapAlignedWords(
      "the cat and the dog",
      [
        { word: "the", start: 0, end: 1 },
        { word: "cat", start: 1, end: 2 },
        { word: "and", start: 2, end: 3 },
        { word: "the", start: 3, end: 4 },
        { word: "dog", start: 4, end: 5 },
      ],
      5,
    );
    expect(repeated?.map((span) => [span.from, span.to])).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
      [12, 15],
      [16, 19],
    ]);

    const emojiText = "It costs 42 dollars \u{1F600} today.";
    const emoji = mapAlignedWords(
      emojiText,
      [
        { word: "It", start: 0, end: 1 },
        { word: "costs", start: 1, end: 2 },
        { word: "42", start: 2, end: 3 },
        { word: "dollars", start: 3, end: 4 },
        { word: "\u{1F600}", start: 4, end: 5 },
        { word: "today.", start: 5, end: 6 },
      ],
      6,
    );
    const emojiSpan = emoji?.[4];
    if (!emojiSpan) throw new Error("emoji span missing");
    expect(emojiSpan.to - emojiSpan.from).toBe(2);
  });

  it("rejects mismatched tokens, non-monotonic times and out-of-range end", () => {
    expect(
      mapAlignedWords(
        "the cat and the dog",
        [
          { word: "the", start: 0, end: 1 },
          { word: "and", start: 1, end: 2 },
          { word: "the", start: 2, end: 3 },
          { word: "dog", start: 3, end: 4 },
        ],
        4,
      ),
    ).toBeNull();
    expect(
      mapAlignedWords(
        "a b c",
        [
          { word: "a", start: 0, end: 2 },
          { word: "b", start: 3, end: 4 },
          { word: "c", start: 1, end: 2 },
        ],
        4,
      ),
    ).toBeNull();
    expect(
      mapAlignedWords(
        "a b",
        [
          { word: "a", start: 0, end: 1 },
          { word: "b", start: 1, end: 9 },
        ],
        2,
      ),
    ).toBeNull();
  });
});
