// Best-effort transient highlight for the text of the read-aloud chunk
// currently playing. Chunk text comes from the plain-text render while the
// page renders the original HTML, so matching is done on whitespace-normalized
// text and never throws if the two representations drift apart.

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

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
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
  });

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
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
        pendingSpace = false;
        spacePosition = null;
      }
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

  let firstSpan: HTMLSpanElement | null = null;
  // Wrap text nodes separately: extracting a cross-block Range splits paragraphs.
  for (const [original, segment] of segments) {
    let node = original;
    if (segment.end < node.length) node.splitText(segment.end);
    if (segment.start > 0) node = node.splitText(segment.start);
    const span = document.createElement("span");
    span.setAttribute("data-speech-highlight", "true");
    span.style.background = "rgba(250,204,21,0.6)";
    span.style.borderRadius = "2px";
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
    highlightRange(
      container,
      normalized,
      matchIndex,
      matchIndex + search.length,
    );
  } catch {
    // Highlighting is purely cosmetic; never interrupt read-aloud playback.
  }
}
