// Client-side helpers for the owner-only LINK bookmark read-aloud feature.
// Audio is synthesized by the Karakeep speech worker behind same-origin API
// routes; this module never uses browser speech synthesis or cloud fallbacks.

export interface SpeechVoice {
  id: string;
  name: string;
  language: string;
}

export type ReadAloudErrorCode =
  | "auth"
  | "forbidden"
  | "not-found"
  | "no-content"
  | "restart"
  | "busy"
  | "not-configured"
  | "upstream"
  | "protocol"
  | "playback"
  | "network"
  | "invalid";

export interface ReadAloudErrorInfo {
  code: ReadAloudErrorCode;
  message: string;
  retryAfterSeconds?: number;
}

export class ReadAloudError extends Error {
  readonly info: ReadAloudErrorInfo;

  constructor(info: ReadAloudErrorInfo) {
    super(info.message);
    this.name = "ReadAloudError";
    this.info = info;
  }
}

export interface SpeechChunk {
  blob: Blob;
  next: number | null;
  contentVersion: string;
  range: string;
  text?: string;
}

export interface SpeechChunkRequest {
  bookmarkId: string;
  voice: string;
  start: number;
  contentVersion?: string;
  signal: AbortSignal;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function decodeSpeechText(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function readErrorResponse(
  response: Response,
): Promise<ReadAloudErrorInfo> {
  let message = "Read-aloud failed.";
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data?.error === "string" && data.error) {
      message = data.error;
    }
  } catch {
    // Keep the fallback message when the body is not JSON.
  }

  const retryAfterSeconds = parseRetryAfter(
    response.headers.get("Retry-After"),
  );

  switch (response.status) {
    case 401:
      return { code: "auth", message };
    case 403:
      return { code: "forbidden", message };
    case 404:
      return { code: "not-found", message };
    case 409:
      return { code: "restart", message };
    case 422:
      return { code: "no-content", message };
    case 502:
      return { code: "upstream", message };
    case 503:
      return retryAfterSeconds !== undefined
        ? { code: "busy", message, retryAfterSeconds }
        : { code: "not-configured", message };
    default:
      return { code: "invalid", message };
  }
}

export async function fetchSpeechChunk(
  params: SpeechChunkRequest,
): Promise<SpeechChunk> {
  const response = await fetch(
    `/api/v1/bookmarks/${encodeURIComponent(params.bookmarkId)}/speech`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        voice: params.voice,
        start: params.start,
        ...(params.contentVersion !== undefined
          ? { contentVersion: params.contentVersion }
          : {}),
      }),
      signal: params.signal,
    },
  );

  if (!response.ok) {
    throw new ReadAloudError(await readErrorResponse(response));
  }

  const nextHeader = response.headers.get("X-Speech-Next");
  const versionHeader = response.headers.get("X-Speech-Content-Version");
  if (nextHeader === null || !versionHeader) {
    throw new ReadAloudError({
      code: "protocol",
      message: "The read-aloud response was missing required data.",
    });
  }

  let next: number | null;
  if (nextHeader === "") {
    next = null;
  } else if (/^\d+$/.test(nextHeader)) {
    next = Number(nextHeader);
  } else {
    throw new ReadAloudError({
      code: "protocol",
      message: "The read-aloud response was missing required data.",
    });
  }

  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("audio/")) {
    throw new ReadAloudError({
      code: "protocol",
      message: "The read-aloud response was missing required data.",
    });
  }

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new ReadAloudError({
      code: "protocol",
      message: "The read-aloud response was missing required data.",
    });
  }

  return {
    blob,
    next,
    contentVersion: versionHeader,
    range: response.headers.get("X-Speech-Range") ?? "",
    text: decodeSpeechText(response.headers.get("X-Speech-Text")),
  };
}

export async function fetchSpeechVoices(
  signal?: AbortSignal,
): Promise<SpeechVoice[]> {
  const response = await fetch("/api/v1/speech/voices", {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new ReadAloudError(await readErrorResponse(response));
  }

  let data: { voices?: unknown };
  try {
    data = (await response.json()) as { voices?: unknown };
  } catch {
    throw new ReadAloudError({
      code: "protocol",
      message: "The voices response was missing required data.",
    });
  }

  if (!Array.isArray(data.voices)) {
    throw new ReadAloudError({
      code: "protocol",
      message: "The voices response was missing required data.",
    });
  }

  const voices: SpeechVoice[] = [];
  for (const item of data.voices) {
    const voice = item as Record<string, unknown>;
    if (
      typeof voice?.id === "string" &&
      typeof voice?.name === "string" &&
      typeof voice?.language === "string"
    ) {
      voices.push({
        id: voice.id,
        name: voice.name,
        language: voice.language,
      });
    }
  }
  return voices;
}

export type ReadAloudStatus =
  | "idle"
  | "buffering"
  | "playing"
  | "paused"
  | "error";

export interface ReadAloudSnapshot {
  status: ReadAloudStatus;
  error: ReadAloudErrorInfo | null;
  currentText: string | null;
}

export interface AudioLike {
  playbackRate: number;
  src: string;
  onended: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}

export interface ReadAloudPlayerDeps {
  fetchChunk: (params: SpeechChunkRequest) => Promise<SpeechChunk>;
  createAudio: () => AudioLike;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  onSnapshot: (snapshot: ReadAloudSnapshot) => void;
}

const PLAYBACK_ERROR: ReadAloudErrorInfo = {
  code: "playback",
  message: "The browser blocked or could not play the audio.",
};

const NETWORK_ERROR: ReadAloudErrorInfo = {
  code: "network",
  message: "Could not reach the local speech service.",
};

const RESTART_ERROR: ReadAloudErrorInfo = {
  code: "restart",
  message: "The bookmark content changed. Restart read-aloud.",
};

export class ReadAloudPlayer {
  private readonly audio: AudioLike;
  private session = 0;
  private controller: AbortController | null = null;
  private objectUrl: string | null = null;
  private version: string | null = null;
  private currentStart = 0;
  private nextOffset: number | null = 0;
  private sessionActive = false;
  private currentText: string | null = null;
  private snapshot: ReadAloudSnapshot = {
    status: "idle",
    error: null,
    currentText: null,
  };
  private disposed = false;

  constructor(
    private readonly deps: ReadAloudPlayerDeps,
    private readonly bookmarkId: string,
    private voice: string,
    private speed: number,
  ) {
    this.audio = deps.createAudio();
    this.audio.playbackRate = speed;
  }

  get currentSnapshot(): ReadAloudSnapshot {
    return this.snapshot;
  }

  start(): void {
    this.resetSession();
    this.sessionActive = true;
    this.currentStart = 0;
    this.nextOffset = 0;
    this.version = null;
    void this.playNext(this.session);
  }

  pause(): void {
    if (!this.sessionActive) {
      return;
    }
    this.audio.pause();
    this.emit({ status: "paused", error: null });
  }

  resume(): void {
    if (!this.sessionActive) {
      this.start();
      return;
    }
    void this.playCurrentAudio();
  }

  retry(): void {
    if (!this.sessionActive) {
      this.start();
      return;
    }
    if (this.snapshot.error?.code === "restart") {
      this.start();
      return;
    }
    if (this.snapshot.error?.code === "playback" && this.objectUrl) {
      void this.playCurrentAudio();
      return;
    }
    void this.playNext(this.session);
  }

  stop(): void {
    this.resetSession();
    this.emit({ status: "idle", error: null });
  }

  setVoice(voice: string): void {
    if (this.voice === voice) {
      return;
    }
    this.voice = voice;
    if (this.sessionActive) {
      this.start();
    }
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.audio.playbackRate = speed;
  }

  dispose(): void {
    this.disposed = true;
    this.resetSession();
  }

  private resetSession(): void {
    this.session++;
    this.controller?.abort();
    this.controller = null;
    this.sessionActive = false;
    this.version = null;
    this.currentStart = 0;
    this.nextOffset = 0;
    this.currentText = null;
    this.clearAudio();
  }

  private clearAudio(): void {
    if (this.objectUrl) {
      this.deps.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.audio.onended = null;
    this.audio.onerror = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }

  private emit(snapshot: Omit<ReadAloudSnapshot, "currentText">): void {
    if (this.disposed) {
      return;
    }
    this.snapshot = { ...snapshot, currentText: this.currentText };
    this.deps.onSnapshot(this.snapshot);
  }

  private fail(error: ReadAloudErrorInfo): void {
    this.controller?.abort();
    this.controller = null;
    this.currentText = null;
    this.emit({ status: "error", error });
  }

  private async playNext(token: number): Promise<void> {
    if (token !== this.session || !this.sessionActive) {
      return;
    }
    this.emit({ status: "buffering", error: null });
    const controller = new AbortController();
    this.controller = controller;
    const start = this.currentStart;
    try {
      const chunk = await this.deps.fetchChunk({
        bookmarkId: this.bookmarkId,
        voice: this.voice,
        start,
        contentVersion: this.version ?? undefined,
        signal: controller.signal,
      });
      if (token !== this.session) {
        return;
      }
      if (this.version !== null && chunk.contentVersion !== this.version) {
        this.fail(RESTART_ERROR);
        return;
      }
      this.version = chunk.contentVersion;
      this.nextOffset = chunk.next;

      this.objectUrl = this.deps.createObjectURL(chunk.blob);
      this.audio.onended = () => this.handleEnded(token);
      this.audio.onerror = () => this.handleAudioError(token);
      this.audio.src = this.objectUrl;
      this.audio.playbackRate = this.speed;

      try {
        await this.audio.play();
      } catch (error) {
        if (token !== this.session) {
          return;
        }
        if (isAbortError(error)) {
          return;
        }
        this.fail(PLAYBACK_ERROR);
        return;
      }
      if (token !== this.session) {
        return;
      }
      this.currentText = chunk.text ?? null;
      this.emit({ status: "playing", error: null });
    } catch (error) {
      if (token !== this.session) {
        return;
      }
      if (isAbortError(error)) {
        return;
      }
      this.fail(error instanceof ReadAloudError ? error.info : NETWORK_ERROR);
    }
  }

  private handleEnded(token: number): void {
    if (token !== this.session) {
      return;
    }
    const next = this.nextOffset;
    this.clearAudio();
    if (next === null) {
      this.sessionActive = false;
      this.currentText = null;
      this.emit({ status: "idle", error: null });
      return;
    }
    this.currentStart = next;
    void this.playNext(token);
  }

  private handleAudioError(token: number): void {
    if (token !== this.session) {
      return;
    }
    this.fail(PLAYBACK_ERROR);
  }

  private async playCurrentAudio(): Promise<void> {
    const token = this.session;
    try {
      await this.audio.play();
    } catch (error) {
      if (token !== this.session) {
        return;
      }
      if (isAbortError(error)) {
        return;
      }
      this.fail(PLAYBACK_ERROR);
      return;
    }
    if (token !== this.session) {
      return;
    }
    this.emit({ status: "playing", error: null });
  }
}
