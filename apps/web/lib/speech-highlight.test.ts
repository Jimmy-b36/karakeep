// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applySpeechHighlight,
  speechOffsetBefore,
  speechOffsetFromClick,
  speechOffsetFromKeyDown,
} from "./speech-highlight";

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

describe("speech offsets", () => {
  it("counts normalized code points across nested and highlighted blocks", () => {
    const container = createContainer(
      "<p>😀  Hello<br>world</p><blockquote><p>Second <em>block</em></p></blockquote><p>  </p>",
    );
    const block = container.querySelector("blockquote p")!;
    expect(speechOffsetBefore(container, block)).toBe(14);
    applySpeechHighlight(container, "Second block");
    expect(speechOffsetBefore(container, block)).toBe(14);
    expect(
      speechOffsetBefore(container, container.lastElementChild!),
    ).toBeNull();
    expect(
      speechOffsetBefore(container, document.createElement("p")),
    ).toBeNull();
  });

  it("only accepts plain pointer clicks on unselected text blocks", () => {
    const container = createContainer(
      '<p>First</p><li><p><em>Second</em> <a href="#">link</a><button>button</button><span data-highlight>saved</span><span tabindex="0">focus</span></p></li>',
    );
    // The real article wrapper is focusable for its Enter-to-read shortcut.
    container.tabIndex = 0;
    const event = {
      target: container.querySelector("em"),
      defaultPrevented: false,
      button: 0,
      detail: 1,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };
    expect(speechOffsetFromClick(container, event)).toBe(6);
    for (const guard of [
      { defaultPrevented: true },
      { button: 1 },
      { detail: 0 },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      ...["a", "button", "[data-highlight]", "[tabindex]"].map((selector) => ({
        target: container.querySelector(selector),
      })),
    ]) {
      expect(
        speechOffsetFromClick(container, { ...event, ...guard }),
      ).toBeNull();
    }
    document.body.appendChild(container);
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(container.querySelector("em")!);
    selection.addRange(range);
    expect(speechOffsetFromClick(container, event)).toBeNull();
    selection.removeAllRanges();
    container.remove();
  });
});

describe("applySpeechHighlight", () => {
  it("centers each spoken word without horizontal jumps or scroll animations", () => {
    const container = createContainer("<p>First second</p>");
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView);

    for (const word of [
      { from: 0, to: 5 },
      { from: 6, to: 12 },
    ]) {
      applySpeechHighlight(container, "First second", word);
      expect(scroll).toHaveBeenLastCalledWith({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
      expect(scroll.mock.instances.at(-1)).toBe(highlightedSpan(container));
    }
    expect(scroll).toHaveBeenCalledTimes(2);
    applySpeechHighlight(container, null);
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("matches the opening chunk after leading article whitespace", () => {
    const container = createContainer(
      '<div class="page"><section>\n\t\n<p>Working with outside collaborators.</p>\n<p>A second paragraph.</p></section></div>',
    );
    applySpeechHighlight(container, "Working with outside collaborators.", {
      from: 0,
      to: 7,
    });
    expect(highlightedSpan(container)?.textContent).toBe("Working");
  });

  it("uses a soft rounded highlight without changing inline layout", () => {
    const container = createContainer("<p>Hello</p>");
    applySpeechHighlight(container, "Hello");
    const style = highlightedSpan(container)!.style;
    expect(style.background).toBe("rgba(250, 204, 21, 0.35)");
    expect(style.borderRadius).toBe("6px");
    expect(style.padding).toBe("");
    expect(style.boxShadow).toBe("0 0 0 0.12em rgba(250,204,21,0.35)");
  });
  it("uses the chosen highlight color", () => {
    const container = createContainer("<p>Hello</p>");
    applySpeechHighlight(container, "Hello", undefined, "#60a5fa");
    const style = highlightedSpan(container)!.style;
    expect(style.background).toBe("rgba(96, 165, 250, 0.35)");
    expect(style.boxShadow).toBe("0 0 0 0.12em rgba(96,165,250,0.35)");
  });
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

describe("speechOffsetFromKeyDown", () => {
  it("jumps to the selected paragraph or defaults to the first block", () => {
    const container = createContainer(
      "<p>First</p><p>Second <a href='/'>link</a></p>",
    );
    document.body.append(container);
    const event = new KeyboardEvent("keydown", { key: "Enter" });
    const input = {
      ...event,
      key: "Enter",
      target: container,
      defaultPrevented: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    expect(speechOffsetFromKeyDown(container, input)).toBe(0);
    selection.collapse(container.lastElementChild!.firstChild, 2);
    expect(speechOffsetFromKeyDown(container, input)).toBe(6);
    for (const guard of [
      { key: " " },
      { defaultPrevented: true },
      { target: container.querySelector("a") },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
    ]) {
      expect(
        speechOffsetFromKeyDown(container, { ...input, ...guard }),
      ).toBeNull();
    }
    selection.removeAllRanges();
    container.remove();
  });
});
