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
    pendingSpace = true;
  }

  return { text: parts.join(""), positions };
}

function highlightRange(
  container: HTMLElement,
  normalized: NormalizedText,
  start: number,
  end: number,
): void {
  const startPosition = normalized.positions[start]!;
  const endPosition =
    end < normalized.positions.length
      ? normalized.positions[end]!
      : (() => {
          const last = normalized.positions[end - 1]!;
          return { node: last.node, offset: last.offset + 1 };
        })();

  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);

  const span = document.createElement("span");
  span.setAttribute("data-speech-highlight", "true");
  span.style.background = "rgba(250,204,21,0.35)";
  span.style.borderRadius = "2px";
  span.style.transition = "background-color 150ms";
  span.appendChild(range.extractContents());
  range.insertNode(span);

  try {
    span.scrollIntoView({ block: "nearest" });
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
