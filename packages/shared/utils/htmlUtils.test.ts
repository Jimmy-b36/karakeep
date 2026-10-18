import { describe, expect, it } from "vitest";

import { htmlToSpeechText } from "./htmlUtils";

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function naiveTagStrip(html: string): string {
  return collapseWhitespace(html.replace(/<[^>]*>/g, " "));
}

describe("htmlToSpeechText", () => {
  it("returns an empty string for empty input", () => {
    expect(htmlToSpeechText("")).toBe("");
  });

  it("omits link URLs", () => {
    const text = collapseWhitespace(
      htmlToSpeechText('<a href="https://x.com">link text</a>'),
    );

    expect(text).toBe("link text");
    expect(text).not.toContain("https://x.com");
  });

  it("preserves heading casing", () => {
    const text = collapseWhitespace(htmlToSpeechText("<h2>Heading</h2>"));

    expect(text).toBe("Heading");
    expect(text).not.toContain("HEADING");
  });

  it("removes unordered list bullets", () => {
    const text = collapseWhitespace(htmlToSpeechText("<ul><li>item</li></ul>"));

    expect(text).toBe("item");
    expect(text).not.toContain("*");
  });

  it("collapses to the same text as a naive tag strip", () => {
    const html =
      "<h1>Title</h1>" +
      '<p>First <a href="https://example.com/a">link</a> paragraph</p>' +
      "<ul><li>one</li><li>two</li></ul>" +
      "<p>Last line with <strong>bold</strong> text</p>" +
      '<hr/><img src="x.png" alt="ignored"/>';

    expect(collapseWhitespace(htmlToSpeechText(html))).toBe(
      naiveTagStrip(html),
    );
  });
});
