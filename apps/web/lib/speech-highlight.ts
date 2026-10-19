// Best-effort transient highlight for the text of the read-aloud chunk
// currently playing. Chunk text comes from the plain-text render while the
// page renders the original HTML, so matching is done on whitespace-normalized
// text and never throws if the two representations drift apart.

import { READER_DEFAULTS } from "@karakeep/shared/types/readers";

interface RawPosition {
  node: Text;
  offset: number;
}

interface NormalizedText {
  text: string;
  positions: RawPosition[];
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clearSpeechHighlight(container: HTMLElement): void {
  const highlights = Array.from(
    container.querySelectorAll("[data-speech-highlight]"),
  );
  for (const highlight of highlights) {
    highlight.replaceWith(...Array.from(highlight.childNodes));
  }
  container.normalize();
}

function buildNormalizedText(container: HTMLElement): NormalizedText {
  const parts: string[] = [];
  const positions: RawPosition[] = [];
  let pendingSpace = false;
  let spacePosition: RawPosition | null = null;
  let previousBlock: Element | null = null;

  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (
          parent &&
          (parent.tagName === "SCRIPT" || parent.tagName === "STYLE")
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let entry: Node | null;
  while ((entry = walker.nextNode())) {
    if (entry.nodeType !== Node.TEXT_NODE) {
      if ((entry as Element).tagName === "BR") {
        pendingSpace = true;
        spacePosition = null;
      }
      continue;
    }
    const node = entry as Text;
    const block =
      node.parentElement?.closest(
        "p,div,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th",
      ) ?? null;
    if (previousBlock && block !== previousBlock) {
      pendingSpace = true;
      spacePosition = null;
    }
    previousBlock = block;
    const data = node.data;
    for (let index = 0; index < data.length; index++) {
      const character = data[index]!;
      if (/\s/.test(character)) {
        if (!pendingSpace) {
          spacePosition = { node, offset: index };
        }
        pendingSpace = true;
        continue;
      }
      if (pendingSpace && parts.length > 0) {
        parts.push(" ");
        positions.push(spacePosition ?? { node, offset: index });
      }
      pendingSpace = false;
      spacePosition = null;
      parts.push(character);
      positions.push({ node, offset: index });
    }
  }

  return { text: parts.join(""), positions };
}

function highlightRange(
  container: HTMLElement,
  normalized: NormalizedText,
  start: number,
  end: number,
  color: string,
): void {
  const segments = new Map<Text, { start: number; end: number }>();
  for (const position of normalized.positions.slice(start, end)) {
    const segment = segments.get(position.node);
    if (segment) {
      segment.end = position.offset + 1;
    } else {
      segments.set(position.node, {
        start: position.offset,
        end: position.offset + 1,
      });
    }
  }

  const rgb = [1, 3, 5].map((start) =>
    parseInt(color.slice(start, start + 2), 16),
  );
  const background = `rgba(${rgb.join(",")},0.35)`;
  let firstSpan: HTMLSpanElement | null = null;
  // Wrap text nodes separately: extracting a cross-block Range splits paragraphs.
  for (const [original, segment] of segments) {
    let node = original;
    if (segment.end < node.length) node.splitText(segment.end);
    if (segment.start > 0) node = node.splitText(segment.start);
    const span = document.createElement("span");
    span.setAttribute("data-speech-highlight", "true");
    span.style.background = background;
    span.style.borderRadius = "6px";
    // Paint outside the word without changing line breaks or glyph positions.
    span.style.boxShadow = `0 0 0 0.12em ${background}`;
    span.style.boxDecorationBreak = "clone";
    node.replaceWith(span);
    span.appendChild(node);
    firstSpan ??= span;
  }

  try {
    firstSpan?.scrollIntoView({ block: "nearest" });
  } catch {
    // scrollIntoView is unavailable in some test environments.
  }
}

export function applySpeechHighlight(
  container: HTMLElement | null,
  text: string | null | undefined,
  word?: { from: number; to: number } | null,
  color: string = READER_DEFAULTS.speechHighlightColor,
): void {
  if (!container) {
    return;
  }
  try {
    clearSpeechHighlight(container);
    const search = normalizeText(text ?? "");
    if (!search) {
      return;
    }
    const normalized = buildNormalizedText(container);
    const matchIndex = normalized.text.indexOf(search);
    if (matchIndex === -1) {
      return;
    }
    const prefix = (offset: number) =>
      (text ?? "").slice(0, offset).replace(/\s+/g, " ").trimStart().length;
    const start = word ? matchIndex + prefix(word.from) : matchIndex;
    const end = word
      ? matchIndex + prefix(word.to)
      : matchIndex + search.length;
    if (start < end && end <= matchIndex + search.length) {
      highlightRange(container, normalized, start, end, color);
    }
  } catch {
    // Highlighting is purely cosmetic; never interrupt read-aloud playback.
  }
}

// Approximate normalized offset; the server uses raw speech-text code points.
export function speechOffsetBefore(
  container: HTMLElement,
  element: Element,
): number | null {
  if (!container.contains(element)) return null;
  const normalized = buildNormalizedText(container);
  const index = normalized.positions.findIndex(
    (position, index) =>
      element.contains(position.node) && normalized.text[index] !== " ",
  );
  return index < 0 ? null : Array.from(normalized.text.slice(0, index)).length;
}

export function speechOffsetFromClick(
  container: HTMLElement,
  event: Pick<
    MouseEvent,
    | "target"
    | "defaultPrevented"
    | "button"
    | "detail"
    | "altKey"
    | "ctrlKey"
    | "metaKey"
    | "shiftKey"
  >,
): number | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.detail === 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    container.ownerDocument.getSelection()?.toString() ||
    !(event.target instanceof Element) ||
    event.target.closest(
      'a,button,input,textarea,select,summary,[role="button"],[role="link"],[tabindex],[contenteditable]:not([contenteditable="false"]),[data-highlight]',
    )
  )
    return null;
  const block = event.target.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote");
  return block ? speechOffsetBefore(container, block) : null;
}

export function speechOffsetFromKeyDown(
  container: HTMLElement,
  event: Pick<
    KeyboardEvent,
    | "key"
    | "target"
    | "defaultPrevented"
    | "altKey"
    | "ctrlKey"
    | "metaKey"
    | "shiftKey"
  >,
): number | null {
  if (
    event.key !== "Enter" ||
    event.target !== container ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return null;
  const anchor = container.ownerDocument.getSelection()?.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  const selectedBlock = element?.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote");
  const block =
    selectedBlock && container.contains(selectedBlock)
      ? selectedBlock
      : container.querySelector("p,li,h1,h2,h3,h4,h5,h6,blockquote");
  return block ? speechOffsetBefore(container, block) : null;
}
