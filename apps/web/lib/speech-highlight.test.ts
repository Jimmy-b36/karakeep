// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { applySpeechHighlight } from "./speech-highlight";

function createContainer(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

function highlightedSpan(container: HTMLElement): HTMLSpanElement | null {
  return container.querySelector('[data-speech-highlight="true"]');
}

beforeEach(() => {
  // jsdom does not implement scrolling; the util swallows that failure.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

describe("applySpeechHighlight", () => {
  it("maps a timed word after an explicit line break", () => {
    const container = createContainer("<p>Hello<br>world</p>");
    applySpeechHighlight(container, "Hello\nworld", { from: 6, to: 11 });
    expect(highlightedSpan(container)?.textContent).toBe("world");
    applySpeechHighlight(container, null);
    expect(container.innerHTML).toBe("<p>Hello<br>world</p>");
  });
  it("does not insert spaces inside inline-split words", () => {
    const container = createContainer(
      "<p>Read <strong>high</strong>lighting now.</p>",
    );
    applySpeechHighlight(container, "Read highlighting now.");
    expect(highlightedSpan(container)).not.toBeNull();
    applySpeechHighlight(container, null);
    expect(container.innerHTML).toBe(
      "<p>Read <strong>high</strong>lighting now.</p>",
    );
  });

  it("preserves paragraph structure and saved highlights across blocks", () => {
    const html =
      '<p>First <span data-highlight="true">saved</span> sentence.</p><p>Second sentence.</p>';
    const container = createContainer(html);
    applySpeechHighlight(container, "First saved sentence. Second sentence.");
    expect(highlightedSpan(container)).not.toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelector("[data-speech-highlight] p")).toBeNull();
    applySpeechHighlight(container, null);
    expect(container.innerHTML).toBe(html);
  });
  it("matches text despite inter-tag and newline whitespace differences", () => {
    const container = createContainer(
      "<p>Hello <strong>world</strong>\n  again</p>",
    );

    applySpeechHighlight(container, "Hello world again");

    const span = highlightedSpan(container);
    expect(span).not.toBeNull();
    expect(container.textContent).toBe("Hello world\n  again");
    expect(
      Array.from(container.querySelectorAll("[data-speech-highlight]"))
        .map((element) => element.textContent)
        .join(""),
    ).toBe("Hello world\n  again");
  });

  it("clears the prior span when the text changes", () => {
    const container = createContainer("<p>first second third</p>");

    applySpeechHighlight(container, "first");
    expect(
      container.querySelectorAll('[data-speech-highlight="true"]').length,
    ).toBe(1);

    applySpeechHighlight(container, "second");
    const spans = container.querySelectorAll('[data-speech-highlight="true"]');
    expect(spans.length).toBe(1);
    expect((spans[0] as HTMLSpanElement).textContent).toBe("second");
  });

  it("unwrap restores the original text content after clear", () => {
    const container = createContainer("<p>one two three</p>");
    const original = container.textContent;

    applySpeechHighlight(container, "two");
    expect(container.textContent).toBe(original);

    applySpeechHighlight(container, null);
    expect(container.textContent).toBe(original);
    expect(
      container.querySelectorAll('[data-speech-highlight="true"]').length,
    ).toBe(0);
  });

  it("does not throw on no match and clears the previous span", () => {
    const container = createContainer("<p>alpha beta</p>");

    applySpeechHighlight(container, "alpha");
    expect(
      container.querySelectorAll('[data-speech-highlight="true"]').length,
    ).toBe(1);

    expect(() => applySpeechHighlight(container, "not present")).not.toThrow();
    expect(
      container.querySelectorAll('[data-speech-highlight="true"]').length,
    ).toBe(0);
    expect(container.textContent).toBe("alpha beta");
  });

  it("clears the prior span for empty text", () => {
    const container = createContainer("<p>alpha</p>");

    applySpeechHighlight(container, "alpha");
    expect(
      container.querySelectorAll('[data-speech-highlight="true"]').length,
    ).toBe(1);

    applySpeechHighlight(container, "");
    expect(
      container.querySelectorAll('[data-speech-highlight="true"]').length,
    ).toBe(0);
    expect(container.textContent).toBe("alpha");
  });

  it("does not match img alt text because img contributes no text nodes", () => {
    const container = createContainer(
      '<p>before <img alt="alt text"> after</p>',
    );

    expect(() => applySpeechHighlight(container, "alt text")).not.toThrow();
    expect(highlightedSpan(container)).toBeNull();
  });
});
