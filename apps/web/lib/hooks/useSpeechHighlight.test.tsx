// @vitest-environment jsdom

import { useRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BookmarkHTMLHighlighter from "@karakeep/shared-react/components/BookmarkHtmlHighlighter";
import { htmlToSpeechText } from "@karakeep/shared/utils/htmlUtils";

import { useSpeechHighlight } from "./useSpeechHighlight";

const html =
  '<p>Read <strong>high</strong>lighting with <a href="https://example.com">links</a>.</p><p>A second paragraph.</p><ol><li>First step.</li><li>Second step.</li></ol>';

function ReaderFixture({
  text,
  word,
}: {
  text: string | null;
  word?: { from: number; to: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSpeechHighlight(ref, text, word);
  return (
    <div ref={ref}>
      <BookmarkHTMLHighlighter htmlContent={html} highlights={[]} readOnly />
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("reader speech highlighting", () => {
  it("moves between exact words, including a word split by inline markup", () => {
    const text = htmlToSpeechText(html);
    const { container, rerender } = render(
      <ReaderFixture text={text} word={{ from: 0, to: 4 }} />,
    );
    const selected = () =>
      Array.from(container.querySelectorAll("[data-speech-highlight]"))
        .map((span) => span.textContent)
        .join("");
    expect(selected()).toBe("Read");
    rerender(<ReaderFixture text={text} word={{ from: 5, to: 17 }} />);
    expect(selected()).toBe("highlighting");
    expect(container.querySelectorAll("p")).toHaveLength(2);
    rerender(<ReaderFixture text={null} />);
    expect(selected()).toBe("");
    expect(container.querySelector('[role="presentation"]')?.innerHTML).toBe(
      html,
    );
  });
  it("renders the spoken text in the actual article component without changing paragraphs", () => {
    const { container, rerender } = render(<ReaderFixture text={null} />);
    rerender(<ReaderFixture text={htmlToSpeechText(html)} />);
    expect(
      container.querySelectorAll("[data-speech-highlight]").length,
    ).toBeGreaterThan(0);
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelector("strong")?.textContent).toBe("high");
    rerender(<ReaderFixture text={null} />);
    expect(container.querySelector("[data-speech-highlight]")).toBeNull();
    expect(container.querySelector('[role="presentation"]')?.innerHTML).toBe(
      html,
    );
  });
});
