import serverConfig from "@karakeep/shared/config";
import type { SpeechWord, TimedSpeech } from "@karakeep/shared/types/speech";
import { zTimedSpeech, validSpeechWords } from "@karakeep/shared/types/speech";

import type { AlignedWord } from "./speech-offsets";
import { mapAlignedWords } from "./speech-offsets";

export interface SpeechVoice {
  id: string;
  name: string;
  language: string;
}

export class SpeechNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechNotConfiguredError";
  }
}

export class SpeechBusyError extends Error {
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "SpeechBusyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class SpeechInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechInvalidInputError";
  }
}

export class SpeechUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechUpstreamError";
  }
}

const MAX_TEXT_LENGTH = 10_000;
const MAX_VOICE_LENGTH = 300;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_VOICES_RESPONSE_BYTES = 1024 * 1024;
const WORKER_TIMEOUT_MS = 70_000;
const ALIGN_TIMEOUT_MS = 90_000;
const MAX_ALIGN_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMED_AUDIO_BASE64 = 45_000_000;

type WorkerKind = "speech" | "kokoro" | "align";

export function resolveSpeechEndpoint(
  baseUrl: string | undefined,
  token: string | undefined,
  allowPrivateHttp: boolean,
  path: string,
): { url: URL; token: string } {
  if (!baseUrl || !token) {
    throw new SpeechNotConfiguredError(
      "Local speech is not configured. Set the private worker URL and token.",
    );
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new SpeechNotConfiguredError("Invalid local speech worker URL.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new SpeechNotConfiguredError("Invalid local speech worker URL.");
  }

  const isLoopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const isAllowedHttp =
    url.protocol === "http:" && (isLoopback || allowPrivateHttp);
  if (url.protocol !== "https:" && !isAllowedHttp) {
    throw new SpeechNotConfiguredError(
      "Local speech requires HTTPS, except for localhost or an explicitly configured private bridge.",
    );
  }

  url.pathname = path;
  return { url, token };
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds)
    : undefined;
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) {
    throw new SpeechUpstreamError(
      "Local speech worker returned no response body.",
    );
  }

  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new SpeechUpstreamError(
          "Local speech worker response was interrupted.",
        );
      }
      if (result.done) {
        break;
      }
      const { value } = result;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new SpeechUpstreamError(
          "Local speech worker response is too large.",
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {
      // Ignore cancel errors; the response is already done or aborted.
    });
  }
  return Buffer.concat(chunks);
}

async function workerRequest(
  path: string,
  body?: unknown,
  kind: WorkerKind = "speech",
): Promise<Response> {
  const { url, token } = resolveSpeechEndpoint(
    kind === "kokoro"
      ? serverConfig.speech.kokoroUrl
      : kind === "align"
        ? serverConfig.speech.alignUrl
        : serverConfig.speech.url,
    kind === "kokoro"
      ? serverConfig.speech.kokoroToken
      : kind === "align"
        ? serverConfig.speech.alignToken
        : serverConfig.speech.token,
    serverConfig.speech.allowPrivateHttp,
    path,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(
        path === "/voices"
          ? 5000
          : kind === "align"
            ? ALIGN_TIMEOUT_MS
            : WORKER_TIMEOUT_MS,
      ),
    });
  } catch {
    throw new SpeechUpstreamError("Local speech worker is unavailable.");
  }

  if (!response.ok) {
    if (response.body) {
      await response.body.cancel().catch(() => {
        // Ignore cancel errors while discarding an error response body.
      });
    }
    if (response.status === 503) {
      throw new SpeechBusyError(
        "Local speech worker is busy. Please retry.",
        parseRetryAfterSeconds(response.headers.get("Retry-After")),
      );
    }
    if (response.status === 400) {
      throw new SpeechInvalidInputError("Invalid voice or speech request.");
    }
    throw new SpeechUpstreamError("Local speech worker is unavailable.");
  }

  return response;
}

function isSpeechVoice(value: unknown): value is SpeechVoice {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { language?: unknown }).language === "string"
  );
}

export async function getSpeechVoices(): Promise<SpeechVoice[]> {
  if (!serverConfig.speech.kokoroUrl) return getWorkerVoices(false);
  const results = await Promise.allSettled([
    getWorkerVoices(true),
    getWorkerVoices(false),
  ]);
  const voices = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (voices.length) return voices;
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return [];
}

async function getWorkerVoices(kokoro: boolean): Promise<SpeechVoice[]> {
  const response = await workerRequest(
    "/voices",
    undefined,
    kokoro ? "kokoro" : "speech",
  );
  const body = await readBodyCapped(response, MAX_VOICES_RESPONSE_BYTES);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new SpeechUpstreamError(
      "Local speech worker returned invalid voices.",
    );
  }

  if (!Array.isArray(parsed)) {
    throw new SpeechUpstreamError(
      "Local speech worker returned invalid voices.",
    );
  }

  const voices: SpeechVoice[] = [];
  for (const item of parsed) {
    if (!isSpeechVoice(item)) {
      throw new SpeechUpstreamError(
        "Local speech worker returned invalid voices.",
      );
    }
    voices.push({
      id: item.id,
      name: item.name,
      language: item.language,
    });
  }
  return voices;
}

export async function synthesizeTimedSpeech(text: string, voice: string) {
  if (
    !voice.startsWith("kokoro:") ||
    !text.trim() ||
    text.length > 10000 ||
    voice.length > 300
  ) {
    throw new SpeechInvalidInputError("Invalid timed speech request.");
  }
  const response = await workerRequest(
    "/synthesize",
    { text, voice },
    "kokoro",
  );
  const bytes = await readBodyCapped(response, MAX_TIMED_AUDIO_BASE64);
  try {
    const value = zTimedSpeech.parse(JSON.parse(bytes.toString("utf8")));
    if (!validSpeechWords(value.words, text, value.duration))
      throw new Error("Invalid words");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.audio))
      throw new Error("Invalid encoding");
    const audio = Buffer.from(value.audio, "base64");
    if (
      audio.length > MAX_AUDIO_BYTES ||
      audio.toString("ascii", 0, 4) !== "RIFF" ||
      audio.toString("ascii", 8, 12) !== "WAVE"
    ) {
      throw new Error("Invalid audio");
    }
    return value;
  } catch {
    throw new SpeechUpstreamError(
      "Local word-timed speech returned invalid audio or timings.",
    );
  }
}

function parseAlignedWords(value: unknown): AlignedWord[] | null {
  if (!value || typeof value !== "object") return null;
  const words = (value as { words?: unknown }).words;
  if (!Array.isArray(words) || words.length === 0 || words.length > 2000)
    return null;
  const parsed: AlignedWord[] = [];
  for (const item of words) {
    if (!item || typeof item !== "object") return null;
    const word = item as Record<string, unknown>;
    if (
      typeof word.word !== "string" ||
      !word.word ||
      typeof word.start !== "number" ||
      typeof word.end !== "number" ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < 0 ||
      word.end < word.start
    ) {
      return null;
    }
    parsed.push({ word: word.word, start: word.start, end: word.end });
  }
  return parsed;
}

export function alignedSpeechConfigured(): boolean {
  return Boolean(
    serverConfig.speech.alignUrl && serverConfig.speech.alignToken,
  );
}

async function alignSpeech(
  text: string,
  audio: Buffer,
): Promise<{ words: SpeechWord[]; duration: number } | null> {
  try {
    const response = await workerRequest(
      "/align",
      { text, wav: audio.toString("base64") },
      "align",
    );
    const bytes = await readBodyCapped(response, MAX_ALIGN_RESPONSE_BYTES);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object") return null;
    const duration = (value as { duration?: unknown }).duration;
    if (
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 600
    ) {
      return null;
    }
    const aligned = parseAlignedWords(value);
    if (!aligned) return null;
    const words = mapAlignedWords(text, aligned, duration);
    if (!words || !validSpeechWords(words, text, duration)) return null;
    return { words, duration };
  } catch {
    // Alignment is optional: never block or fail audio because it is unavailable.
    return null;
  }
}

/**
 * Synthesizes untimed voices, then adds word timings when the local aligner is
 * configured. Alignment failure degrades to plain WAV, preserving playback.
 */
export async function synthesizeAlignedSpeech(
  text: string,
  voice: string,
): Promise<{ audio: Buffer; timed: TimedSpeech | null }> {
  const audio = await synthesizeSpeech(text, voice);
  if (!alignedSpeechConfigured()) return { audio, timed: null };
  const aligned = await alignSpeech(text, audio);
  if (!aligned) return { audio, timed: null };
  return {
    audio,
    timed: {
      audio: audio.toString("base64"),
      words: aligned.words,
      duration: aligned.duration,
    },
  };
}

export async function synthesizeSpeech(
  text: string,
  voice: string,
): Promise<Buffer> {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > MAX_TEXT_LENGTH
  ) {
    throw new SpeechInvalidInputError("Invalid text for speech.");
  }
  if (
    typeof voice !== "string" ||
    voice.length === 0 ||
    voice.length > MAX_VOICE_LENGTH
  ) {
    throw new SpeechInvalidInputError("Invalid voice for speech.");
  }

  const response = await workerRequest("/synthesize", { text, voice });
  const audio = await readBodyCapped(response, MAX_AUDIO_BYTES);

  if (
    audio.length < 12 ||
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new SpeechUpstreamError(
      "Local speech worker returned invalid audio.",
    );
  }

  return audio;
}
