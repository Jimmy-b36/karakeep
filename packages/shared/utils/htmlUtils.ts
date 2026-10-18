import { compile } from "html-to-text";

const compiledConvert = compile({
  selectors: [{ selector: "img", format: "skip" }],
});

const compiledSpeechConvert = compile({
  wordwrap: null,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "hr", format: "skip" },
    { selector: "a", options: { ignoreHref: true } },
    { selector: "h1", options: { uppercase: false } },
    { selector: "h2", options: { uppercase: false } },
    { selector: "h3", options: { uppercase: false } },
    { selector: "h4", options: { uppercase: false } },
    { selector: "h5", options: { uppercase: false } },
    { selector: "h6", options: { uppercase: false } },
    { selector: "ul", options: { itemPrefix: " " } },
    { selector: "ol", format: "unorderedList", options: { itemPrefix: " " } },
  ],
});

/**
 * Converts HTML content to plain text
 */
export function htmlToPlainText(htmlContent: string): string {
  if (!htmlContent) {
    return "";
  }

  // TODO, we probably should also remove singlefile inline images from the content
  return compiledConvert(htmlContent);
}

/**
 * Converts HTML content to text that mirrors the rendered article DOM, so the
 * read-aloud chunk text can be matched back onto the page for highlighting.
 */
export function htmlToSpeechText(htmlContent: string): string {
  if (!htmlContent) {
    return "";
  }

  return compiledSpeechConvert(htmlContent);
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "'": "&#x27;",
  "`": "&#x60;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
};

/**
 * Escapes HTML special characters so that untrusted input can be safely
 * interpolated into an HTML context (e.g. email bodies, exported files).
 */
export function escapeHtml(input: string): string {
  return input.replace(/[&'`"<>]/g, (match) => HTML_ESCAPE_MAP[match] || "");
}
