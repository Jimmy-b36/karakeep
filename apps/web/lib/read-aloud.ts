// Client-side helpers for the owner-only LINK bookmark read-aloud feature.
// Audio is synthesized by the Karakeep speech worker behind same-origin API
// routes; this module never uses browser speech synthesis or cloud fallbacks.

import { zTimedSpeech, validSpeechWords } from "@karakeep/shared/types/speech";
import type { SpeechWord } from "@karakeep/shared/types/speech";

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
  words?: SpeechWord[];
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
  if (contentType.toLowerCase().startsWith("application/json")) {
    try {
      const value = zTimedSpeech.parse(await response.json());
      const text = decodeSpeechText(response.headers.get("X-Speech-Text"));
      if (!text || !validSpeechWords(value.words, text, value.duration))
        throw new Error("Invalid words");
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.audio))
        throw new Error("Invalid encoding");
      const binary = atob(value.audio);
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
      if (binary.slice(0, 4) !== "RIFF" || binary.slice(8, 12) !== "WAVE")
        throw new Error("Invalid WAV");
      return {
        blob: new Blob([bytes], { type: "audio/wav" }),
        words: value.words,
        text,
        next,
        contentVersion: versionHeader,
        range: response.headers.get("X-Speech-Range") ?? "",
      };
    } catch {
      throw new ReadAloudError({
        code: "protocol",
        message: "The local speech response contains invalid word timings.",
      });
    }
  }
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
  canPrevious: boolean;
  canNext: boolean;
  error: ReadAloudErrorInfo | null;
  currentText: string | null;
  currentWord?: SpeechWord | null;
}

export interface AudioLike {
  playbackRate: number;
  currentTime?: number;
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
  private prefetched: {
    start: number;
    result: Promise<{ chunk: SpeechChunk } | { error: unknown }>;
  } | null = null;
  private objectUrl: string | null = null;
  private version: string | null = null;
  private currentStart = 0;
  private previousStarts: number[] = [];
  private paused = false;
  private nextOffset: number | null = 0;
  private sessionActive = false;
  private currentText: string | null = null;
  private loadedText: string | null = null;
  private words: SpeechWord[] = [];
  private currentWord: SpeechWord | null = null;
  private snapshot: ReadAloudSnapshot = {
    status: "idle",
    canPrevious: false,
    canNext: false,
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

  updateProgress(): void {
    if (
      !this.sessionActive ||
      !this.words.length ||
      this.snapshot.status !== "playing"
    )
      return;
    const time = this.audio.currentTime ?? 0;
    const word =
      this.words.find((value) => time >= value.start && time < value.end) ??
      null;
    if (word === this.currentWord) return;
    this.currentWord = word;
    this.emit({ status: "playing", error: null });
  }

  start(): void {
    this.startAt(0);
  }

  startAt(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) return;
    this.resetSession();
    this.sessionActive = true;
    this.currentStart = offset;
    this.nextOffset = offset;
    this.version = null;
    void this.playNext(this.session);
  }

  previousChunk(): void {
    if (!this.snapshot.canPrevious) return;
    this.navigateTo(this.previousStarts.pop()!);
  }

  nextChunk(): void {
    if (!this.snapshot.canNext || this.nextOffset === null) return;
    this.previousStarts.push(this.currentStart);
    this.navigateTo(this.nextOffset);
  }

  private navigateTo(start: number): void {
    this.session++;
    if (this.prefetched?.start !== start) {
      this.controller?.abort();
      this.controller = null;
      this.prefetched = null;
    }
    this.currentText = null;
    this.clearAudio();
    this.currentStart = start;
    this.nextOffset = null;
    void this.playNext(this.session);
  }

  pause(): void {
    if (!this.sessionActive) {
      return;
    }
    this.paused = true;
    this.audio.pause();
    this.emit({ status: "paused", error: null });
  }

  resume(): void {
    if (!this.sessionActive) {
      this.start();
      return;
    }
    this.paused = false;
    if (this.objectUrl) {
      void this.playCurrentAudio();
    } else {
      this.emit({ status: "buffering", error: null });
    }
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
    this.prefetched = null;
    this.sessionActive = false;
    this.version = null;
    this.currentStart = 0;
    this.previousStarts = [];
    this.paused = false;
    this.nextOffset = 0;
    this.currentText = null;
    this.clearAudio();
  }

  private clearAudio(): void {
    if (this.objectUrl) {
      this.deps.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.words = [];
    this.loadedText = null;
    this.currentWord = null;
    this.audio.onended = null;
    this.audio.onerror = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }

  private emit(snapshot: Pick<ReadAloudSnapshot, "status" | "error">): void {
    if (this.disposed) {
      return;
    }
    const navigable =
      this.sessionActive &&
      this.objectUrl !== null &&
      !snapshot.error &&
      (snapshot.status === "playing" || snapshot.status === "paused");
    this.snapshot = {
      ...snapshot,
      canPrevious: navigable && this.previousStarts.length > 0,
      canNext: navigable && this.nextOffset !== null,
      currentText: this.currentText,
      currentWord: this.words.length ? this.currentWord : undefined,
    };
    this.deps.onSnapshot(this.snapshot);
  }

  private fail(error: ReadAloudErrorInfo): void {
    this.controller?.abort();
    this.controller = null;
    this.currentText = null;
    this.currentWord = null;
    this.emit({ status: "error", error });
  }

  private async playNext(token: number): Promise<void> {
    if (token !== this.session || !this.sessionActive) {
      return;
    }
    this.emit({ status: "buffering", error: null });
    const start = this.currentStart;
    const prefetched = this.prefetched;
    this.prefetched = null;
    try {
      let chunk: SpeechChunk;
      if (prefetched?.start === start) {
        const result = await prefetched.result;
        if ("error" in result) throw result.error;
        chunk = result.chunk;
      } else {
        chunk = await this.fetchAt(start);
      }
      if (token !== this.session) {
        return;
      }
      if (this.version !== null && chunk.contentVersion !== this.version) {
        this.fail(RESTART_ERROR);
        return;
      }
      const rangeStart = /^(\d+)-\d+\/\d+$/.exec(chunk.range)?.[1];
      if (this.version === null && rangeStart !== undefined) {
        const offset = Number(rangeStart);
        if (Number.isSafeInteger(offset) && offset >= start)
          this.currentStart = offset;
      }
      this.version = chunk.contentVersion;
      this.nextOffset = chunk.next;

      this.objectUrl = this.deps.createObjectURL(chunk.blob);
      this.audio.onended = () => this.handleEnded(token);
      this.audio.onerror = () => this.handleAudioError(token);
      this.audio.src = this.objectUrl;
      this.audio.playbackRate = this.speed;
      this.loadedText = chunk.text ?? null;
      this.words = chunk.words ?? [];
      this.currentWord = null;
      if (this.paused) {
        this.currentText = this.loadedText;
        this.emit({ status: "paused", error: null });
        return;
      }

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
      if (this.paused) this.audio.pause();
      this.currentText = this.loadedText;
      this.emit({ status: this.paused ? "paused" : "playing", error: null });
      this.updateProgress();
      this.prefetchNext();
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

  private async fetchAt(start: number): Promise<SpeechChunk> {
    const controller = new AbortController();
    this.controller = controller;
    const request = {
      bookmarkId: this.bookmarkId,
      voice: this.voice,
      start,
      contentVersion: this.version ?? undefined,
      signal: controller.signal,
    };
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      try {
        return await this.deps.fetchChunk(request);
      } catch (error) {
        if (
          !(error instanceof ReadAloudError) ||
          error.info.code !== "busy" ||
          attempt >= 3
        )
          throw error;
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", abort);
            reject(controller.signal.reason);
          };
          const delay = Math.min(
            5,
            Math.max(1, error.info.retryAfterSeconds ?? 1),
          );
          const timer = setTimeout(finish, delay * 1000);
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
        });
      }
    }
  }

  private prefetchNext(): void {
    if (!this.sessionActive || this.nextOffset === null || this.prefetched)
      return;
    this.prefetched = {
      start: this.nextOffset,
      // A speculative failure is shown only when this audio is actually needed.
      result: this.fetchAt(this.nextOffset).then(
        (chunk) => ({ chunk }),
        (error: unknown) => ({ error }),
      ),
    };
  }

  private handleEnded(token: number): void {
    if (token !== this.session) {
      return;
    }
    if (this.nextOffset === null) {
      this.clearAudio();
      this.sessionActive = false;
      this.currentText = null;
      this.emit({ status: "idle", error: null });
      return;
    }
    this.nextChunk();
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
    if (this.paused) this.audio.pause();
    this.currentText = this.loadedText;
    this.emit({ status: this.paused ? "paused" : "playing", error: null });
    this.updateProgress();
    this.prefetchNext();
  }
}
