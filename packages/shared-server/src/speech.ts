import serverConfig from "@karakeep/shared/config";

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

async function workerRequest(path: string, body?: unknown): Promise<Response> {
  const { url, token } = resolveSpeechEndpoint(
    serverConfig.speech.url,
    serverConfig.speech.token,
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
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
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
  const response = await workerRequest("/voices");
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
