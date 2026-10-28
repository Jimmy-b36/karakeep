import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchSpeechChunk,
  fetchSpeechVoices,
  ReadAloudPlayer,
  ReadAloudError,
} from "./read-aloud";
import type { AudioLike, SpeechChunk } from "./read-aloud";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function chunk(
  next: number | null,
  contentVersion: string,
  range = "0-10/10",
  text?: string,
): SpeechChunk {
  return { blob: new Blob(["audio"]), next, contentVersion, range, text };
}

function createFakeAudio() {
  const play = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const pause = vi.fn();
  const load = vi.fn();
  const removeAttribute = vi.fn();
  const audio: AudioLike = {
    playbackRate: 1,
    currentTime: 0,
    src: "",
    onended: null,
    onerror: null,
    play,
    pause,
    load,
    removeAttribute,
  };
  return { audio, play, pause, load, removeAttribute };
}

function setupPlayer() {
  const { audio, play } = createFakeAudio();
  const fetchChunk = vi.fn().mockResolvedValue(chunk(null, "v1"));
  let urlCounter = 0;
  const createObjectURL = vi.fn(() => `blob:${++urlCounter}`);
  const revokeObjectURL = vi.fn();
  const player = new ReadAloudPlayer(
    {
      fetchChunk,
      createAudio: () => audio,
      createObjectURL,
      revokeObjectURL,
      onSnapshot: vi.fn(),
    },
    "bookmark-1",
    "voice-a",
    1,
  );
  return { player, audio, play, fetchChunk, createObjectURL, revokeObjectURL };
}

describe("ReadAloudPlayer", () => {
  it("skips forward using the existing prefetch and disables navigation at boundaries", async () => {
    const { player, fetchChunk, play } = setupPlayer();
    const pending = deferred<SpeechChunk>();
    fetchChunk
      .mockResolvedValueOnce(chunk(100, "v1"))
      .mockReturnValueOnce(pending.promise);
    expect(player.currentSnapshot).toMatchObject({
      canPrevious: false,
      canNext: false,
    });
    player.previousChunk();
    player.nextChunk();
    expect(fetchChunk).not.toHaveBeenCalled();
    player.start();
    await flush();
    expect(player.currentSnapshot).toMatchObject({
      canPrevious: false,
      canNext: true,
    });
    player.previousChunk();
    player.nextChunk();
    expect(player.currentSnapshot).toMatchObject({
      status: "buffering",
      canPrevious: false,
      canNext: false,
    });
    player.nextChunk();
    pending.resolve(chunk(null, "v1"));
    await flush();
    expect(fetchChunk).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenCalledTimes(2);
    expect(player.currentSnapshot).toMatchObject({
      canPrevious: true,
      canNext: false,
    });
    player.nextChunk();
    expect(fetchChunk).toHaveBeenCalledTimes(2);
    player.stop();
    expect(player.currentSnapshot).toMatchObject({
      canPrevious: false,
      canNext: false,
    });
  });

  it("goes back after automatic advancement and ignores stale audio and prefetch results", async () => {
    const { player, audio, fetchChunk, play, revokeObjectURL } = setupPlayer();
    const stale = deferred<SpeechChunk>();
    fetchChunk
      .mockResolvedValueOnce(chunk(100, "v1"))
      .mockResolvedValueOnce(chunk(200, "v1"))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(chunk(100, "v1"))
      .mockResolvedValueOnce(chunk(200, "v1"));
    player.start();
    await flush();
    audio.onended!(new Event("ended"));
    await flush();
    const oldEnded = audio.onended;
    const signal = fetchChunk.mock.calls[2]![0].signal as AbortSignal;
    player.previousChunk();
    await flush();
    expect(signal.aborted).toBe(true);
    expect(fetchChunk.mock.calls[3]![0]).toMatchObject({
      start: 0,
      contentVersion: "v1",
    });
    expect(player.currentSnapshot.canPrevious).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:2");
    oldEnded!(new Event("ended"));
    stale.resolve(chunk(null, "v1"));
    await flush();
    expect(play).toHaveBeenCalledTimes(3);
    expect(fetchChunk.mock.calls.map(([request]) => request.start)).toEqual([
      0, 100, 200, 0, 100, 200,
    ]);
    player.stop();
  });

  it("keeps chunk navigation paused and resumes without fetching the target twice", async () => {
    const { player, fetchChunk, play } = setupPlayer();
    const next = deferred<SpeechChunk>();
    fetchChunk
      .mockResolvedValueOnce(chunk(100, "v1", "0-100/200", "First"))
      .mockReturnValueOnce(next.promise)
      .mockResolvedValueOnce(chunk(100, "v1", "0-100/200", "First"));
    player.start();
    await flush();
    player.pause();
    player.nextChunk();
    next.resolve(chunk(null, "v1", "100-200/200", "Second"));
    await flush();
    expect(player.currentSnapshot).toMatchObject({
      status: "paused",
      currentText: "Second",
    });
    expect(play).toHaveBeenCalledTimes(1);
    player.previousChunk();
    await flush();
    expect(player.currentSnapshot).toMatchObject({
      status: "paused",
      currentText: "First",
    });
    expect(play).toHaveBeenCalledTimes(1);
    player.resume();
    await flush();
    expect(player.currentSnapshot.status).toBe("playing");
    expect(play).toHaveBeenCalledTimes(2);
    player.stop();
  });

  it("can resume while a paused navigation request is still buffering", async () => {
    const { player, fetchChunk, play } = setupPlayer();
    const next = deferred<SpeechChunk>();
    fetchChunk
      .mockResolvedValueOnce(chunk(100, "v1"))
      .mockReturnValueOnce(next.promise);
    player.start();
    await flush();
    player.pause();
    player.nextChunk();
    player.resume();
    expect(play).toHaveBeenCalledTimes(1);
    next.resolve(chunk(null, "v1"));
    await flush();
    expect(player.currentSnapshot.status).toBe("playing");
    expect(play).toHaveBeenCalledTimes(2);
    player.stop();
  });

  it("preserves content-version checks when navigating backwards", async () => {
    const { player, fetchChunk } = setupPlayer();
    fetchChunk
      .mockResolvedValueOnce(chunk(100, "v1"))
      .mockResolvedValueOnce(chunk(null, "v1"))
      .mockResolvedValueOnce(chunk(100, "changed"));
    player.start();
    await flush();
    player.nextChunk();
    await flush();
    player.previousChunk();
    await flush();
    expect(fetchChunk.mock.calls[2]![0]).toMatchObject({
      start: 0,
      contentVersion: "v1",
    });
    expect(player.currentSnapshot.error?.code).toBe("restart");
    expect(player.currentSnapshot).toMatchObject({
      canPrevious: false,
      canNext: false,
    });
    player.stop();
  });

  it("remembers the server-snapped start and resets history on a new jump", async () => {
    const { player, fetchChunk } = setupPlayer();
    fetchChunk.mockImplementation(async ({ start }) =>
      start === 100
        ? chunk(null, "v1", "100-200/200")
        : chunk(100, "v1", "45-100/200"),
    );
    player.startAt(42);
    await flush();
    player.nextChunk();
    await flush();
    player.previousChunk();
    await flush();
    expect(fetchChunk.mock.calls[2]![0]).toMatchObject({
      start: 45,
      contentVersion: "v1",
    });
    player.startAt(100);
    await flush();
    expect(player.currentSnapshot).toMatchObject({
      canPrevious: false,
      canNext: false,
    });
    player.stop();
  });

  it("jumps, cancels the old session and continues from the server offset", async () => {
    const { player, audio, fetchChunk, revokeObjectURL } = setupPlayer();
    fetchChunk.mockResolvedValueOnce(chunk(10, "old"));
    fetchChunk.mockResolvedValueOnce(chunk(null, "old"));
    player.start();
    await flush();
    const signal = fetchChunk.mock.calls[1]![0].signal as AbortSignal;
    fetchChunk.mockResolvedValueOnce(chunk(80, "new"));
    fetchChunk.mockResolvedValueOnce(chunk(null, "new"));
    player.startAt(42);
    await flush();
    expect(signal.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:1");
    expect(fetchChunk.mock.calls[2]![0]).toMatchObject({ start: 42 });
    expect(fetchChunk.mock.calls[2]![0].contentVersion).toBeUndefined();
    expect(fetchChunk.mock.calls[3]![0]).toMatchObject({
      start: 80,
      contentVersion: "new",
    });
    audio.onended?.(new Event("ended"));
    await flush();
    expect(fetchChunk).toHaveBeenCalledTimes(4);
    expect(player.currentSnapshot.status).toBe("playing");
  });

  it.each([-1, NaN, Infinity, 1.5])(
    "ignores invalid start offset %s",
    (offset) => {
      const { player, fetchChunk } = setupPlayer();
      player.startAt(offset);
      expect(fetchChunk).not.toHaveBeenCalled();
    },
  );
  it("highlights words by audio time, including seek, pause and silence", async () => {
    const { player, audio, fetchChunk } = setupPlayer();
    const words = [
      { from: 0, to: 5, start: 0, end: 0.5 },
      { from: 6, to: 11, start: 0.7, end: 1.2 },
    ];
    fetchChunk.mockResolvedValueOnce({
      ...chunk(null, "v1", "0-11/11", "Hello world"),
      words,
    });
    player.start();
    await flush();
    expect(player.currentSnapshot.currentWord).toEqual(words[0]);
    audio.currentTime = 0.8;
    player.updateProgress();
    expect(player.currentSnapshot.currentWord).toEqual(words[1]);
    player.pause();
    audio.currentTime = 0.1;
    player.updateProgress();
    expect(player.currentSnapshot.currentWord).toEqual(words[1]);
    player.resume();
    await flush();
    player.updateProgress();
    expect(player.currentSnapshot.currentWord).toEqual(words[0]);
    audio.currentTime = 0.6;
    player.updateProgress();
    expect(player.currentSnapshot.currentWord).toBeNull();
    player.stop();
    expect(player.currentSnapshot.currentWord).toBeUndefined();
  });
  it("discards a prefetched old voice when the voice changes", async () => {
    const { player, fetchChunk, play } = setupPlayer();
    const oldNext = deferred<SpeechChunk>();
    fetchChunk
      .mockResolvedValueOnce(chunk(100, "v1"))
      .mockReturnValueOnce(oldNext.promise)
      .mockResolvedValueOnce(chunk(null, "v1"));
    player.start();
    await flush();
    const oldSignal = fetchChunk.mock.calls[1][0].signal;
    player.setVoice("voice-b");
    await flush();
    expect(oldSignal.aborted).toBe(true);
    expect(fetchChunk.mock.calls[2][0]).toMatchObject({
      voice: "voice-b",
      start: 0,
    });
    oldNext.resolve(chunk(null, "v1"));
    await flush();
    expect(play).toHaveBeenCalledTimes(2);
    player.stop();
  });
  it("retries a busy prefetch while current audio continues and cancels the retry on stop", async () => {
    vi.useFakeTimers();
    try {
      const { player, fetchChunk } = setupPlayer();
      fetchChunk.mockResolvedValueOnce(chunk(100, "v1")).mockRejectedValue(
        new ReadAloudError({
          code: "busy",
          message: "Busy",
          retryAfterSeconds: 1,
        }),
      );
      player.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(player.currentSnapshot.status).toBe("playing");
      expect(fetchChunk).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchChunk).toHaveBeenCalledTimes(3);
      expect(player.currentSnapshot.status).toBe("playing");
      player.stop();
      await vi.advanceTimersByTimeAsync(10000);
      expect(fetchChunk).toHaveBeenCalledTimes(3);
      expect(player.currentSnapshot.status).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
  it("preloads multiple segments while playing and reuses them at the boundary", async () => {
    const { player, audio, fetchChunk, createObjectURL } = setupPlayer();
    fetchChunk
      .mockResolvedValueOnce(chunk(100, "v1", "0-100/300", "First"))
      .mockResolvedValueOnce(chunk(200, "v1", "100-200/300", "Second"))
      .mockResolvedValueOnce(chunk(null, "v1", "200-300/300", "Third"));
    player.start();
    await flush();
    expect(fetchChunk).toHaveBeenCalledTimes(3);
    expect(player.currentSnapshot.currentText).toBe("First");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    audio.onended!(new Event("ended"));
    await flush();
    expect(player.currentSnapshot.currentText).toBe("Second");
    expect(fetchChunk).toHaveBeenCalledTimes(3);
    expect(fetchChunk.mock.calls.map(([request]) => request.start)).toEqual([
      0, 100, 200,
    ]);
    player.stop();
  });

  it("bounds the runway to three upcoming segments and refills it during playback", async () => {
    const { player, audio, fetchChunk } = setupPlayer();
    fetchChunk.mockImplementation(async ({ start }: { start: number }) =>
      chunk(start + 100, "v1"),
    );
    player.start();
    await flush();
    expect(fetchChunk.mock.calls.map(([request]) => request.start)).toEqual([
      0, 100, 200, 300,
    ]);
    audio.onended!(new Event("ended"));
    await flush();
    expect(fetchChunk.mock.calls.map(([request]) => request.start)).toEqual([
      0, 100, 200, 300, 400,
    ]);
    expect(player.currentSnapshot.status).toBe("playing");
    player.stop();
  });

  it("cancels speculative generation on stop without playing its late result", async () => {
    const { player, fetchChunk, play } = setupPlayer();
    const next = deferred<SpeechChunk>();
    fetchChunk
      .mockResolvedValueOnce(chunk(100, "v1"))
      .mockReturnValueOnce(next.promise);
    player.start();
    await flush();
    const signal = fetchChunk.mock.calls[1][0].signal;
    player.stop();
    expect(signal.aborted).toBe(true);
    next.resolve(chunk(null, "v1"));
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    expect(player.currentSnapshot.status).toBe("idle");
  });

  it("does not interrupt current audio when prefetch fails and retries the next offset", async () => {
    const { player, audio, fetchChunk } = setupPlayer();
    fetchChunk
      .mockResolvedValueOnce(chunk(100, "v1"))
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(chunk(null, "v1"));
    player.start();
    await flush();
    expect(player.currentSnapshot.status).toBe("playing");
    audio.onended!(new Event("ended"));
    await flush();
    expect(player.currentSnapshot.status).toBe("error");
    player.retry();
    await flush();
    expect(fetchChunk.mock.calls[2][0].start).toBe(100);
    expect(player.currentSnapshot.status).toBe("playing");
  });
  it("requests chunks in order, forwarding version and next offset", async () => {
    const {
      player,
      audio,
      play,
      fetchChunk,
      createObjectURL,
      revokeObjectURL,
    } = setupPlayer();

    const first = deferred<SpeechChunk>();
    const second = deferred<SpeechChunk>();
    fetchChunk
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    player.start();
    expect(player.currentSnapshot.status).toBe("buffering");
    const firstRequest = fetchChunk.mock.calls[0][0];
    expect(firstRequest.bookmarkId).toBe("bookmark-1");
    expect(firstRequest.voice).toBe("voice-a");
    expect(firstRequest.start).toBe(0);
    expect(firstRequest.contentVersion).toBeUndefined();

    first.resolve(chunk(100, "v1", "0-100/300"));
    await flush();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe("blob:1");
    expect(play).toHaveBeenCalledTimes(1);
    expect(player.currentSnapshot.status).toBe("playing");

    expect(fetchChunk).toHaveBeenCalledTimes(2);
    audio.onended!(new Event("ended"));
    await flush();

    expect(fetchChunk).toHaveBeenCalledTimes(2);
    const secondRequest = fetchChunk.mock.calls[1][0];
    expect(secondRequest.start).toBe(100);
    expect(secondRequest.contentVersion).toBe("v1");
    expect(player.currentSnapshot.status).toBe("buffering");

    second.resolve(chunk(null, "v1", "100-300/300"));
    await flush();
    expect(player.currentSnapshot.status).toBe("playing");

    audio.onended!(new Event("ended"));
    await flush();
    expect(player.currentSnapshot.status).toBe("idle");
    expect(fetchChunk).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:1");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:2");
  });

  it("aborts a pending fetch on stop and ignores its stale completion", async () => {
    const { player, play, fetchChunk, createObjectURL } = setupPlayer();

    const pending = deferred<SpeechChunk>();
    fetchChunk.mockReturnValueOnce(pending.promise);

    player.start();
    const signal = fetchChunk.mock.calls[0][0].signal;
    expect(signal.aborted).toBe(false);

    player.stop();
    expect(signal.aborted).toBe(true);
    expect(player.currentSnapshot.status).toBe("idle");

    pending.resolve(chunk(100, "v1"));
    await flush();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(player.currentSnapshot.status).toBe("idle");
  });

  it("revokes the current object URL and detaches audio on dispose", async () => {
    const { player, audio, fetchChunk, revokeObjectURL } = setupPlayer();

    const pending = deferred<SpeechChunk>();
    fetchChunk.mockReturnValueOnce(pending.promise);

    player.start();
    pending.resolve(chunk(null, "v1"));
    await flush();
    expect(player.currentSnapshot.status).toBe("playing");

    player.dispose();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:1");
    expect(audio.onended).toBeNull();
    expect(audio.onerror).toBeNull();
  });

  it("surfaces a rejected play as a playback error and can resume", async () => {
    const { player, play, fetchChunk } = setupPlayer();
    play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));

    const pending = deferred<SpeechChunk>();
    fetchChunk.mockReturnValueOnce(pending.promise);

    player.start();
    pending.resolve(chunk(100, "v1"));
    await flush();

    expect(player.currentSnapshot.status).toBe("error");
    expect(player.currentSnapshot.error?.code).toBe("playback");

    play.mockResolvedValueOnce(undefined);
    player.resume();
    await flush();

    expect(player.currentSnapshot.status).toBe("playing");
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("sets currentText when a chunk starts playing", async () => {
    const { player, fetchChunk } = setupPlayer();

    const pending = deferred<SpeechChunk>();
    fetchChunk.mockReturnValueOnce(pending.promise);

    player.start();
    pending.resolve(chunk(100, "v1", "0-100/300", "Hello world"));
    await flush();

    expect(player.currentSnapshot.status).toBe("playing");
    expect(player.currentSnapshot.currentText).toBe("Hello world");
  });

  it("clears currentText on stop", async () => {
    const { player, fetchChunk } = setupPlayer();

    const pending = deferred<SpeechChunk>();
    fetchChunk.mockReturnValueOnce(pending.promise);

    player.start();
    pending.resolve(chunk(100, "v1", "0-100/300", "Hello world"));
    await flush();
    expect(player.currentSnapshot.currentText).toBe("Hello world");

    player.stop();
    expect(player.currentSnapshot.currentText).toBeNull();
  });

  it("clears currentText when the stream ends", async () => {
    const { player, audio, fetchChunk } = setupPlayer();

    const pending = deferred<SpeechChunk>();
    fetchChunk.mockReturnValueOnce(pending.promise);

    player.start();
    pending.resolve(chunk(null, "v1", "0-10/10", "Hello world"));
    await flush();
    expect(player.currentSnapshot.currentText).toBe("Hello world");

    audio.onended!(new Event("ended"));
    await flush();

    expect(player.currentSnapshot.status).toBe("idle");
    expect(player.currentSnapshot.currentText).toBeNull();
  });

  it("fails with restart when a later chunk reports a new content version", async () => {
    const { player, audio, fetchChunk, createObjectURL } = setupPlayer();

    const first = deferred<SpeechChunk>();
    const second = deferred<SpeechChunk>();
    fetchChunk
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    player.start();
    first.resolve(chunk(100, "v1"));
    await flush();
    expect(player.currentSnapshot.status).toBe("playing");

    audio.onended!(new Event("ended"));
    await flush();
    second.resolve(chunk(null, "v2"));
    await flush();

    expect(player.currentSnapshot.status).toBe("error");
    expect(player.currentSnapshot.error?.code).toBe("restart");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe("fetchSpeechChunk", () => {
  it("reads Kokoro WAV and validated word offsets from JSON", async () => {
    const text = "Hello";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            audio: Buffer.from("RIFF0000WAVE").toString("base64"),
            duration: 1,
            words: [{ from: 0, to: 5, start: 0, end: 0.8 }],
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "X-Speech-Next": "",
              "X-Speech-Content-Version": "v1",
              "X-Speech-Text": Buffer.from(text).toString("base64url"),
            },
          },
        ),
      ),
    );
    const result = await fetchSpeechChunk({
      bookmarkId: "b1",
      voice: "kokoro:af_heart",
      start: 0,
      signal: new AbortController().signal,
    });
    expect(result.words).toEqual([{ from: 0, to: 5, start: 0, end: 0.8 }]);
    expect(result.blob.type).toBe("audio/wav");
    expect(result.text).toBe(text);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses the next offset, version, and range headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Blob(["audio"]), {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "X-Speech-Next": "100",
            "X-Speech-Content-Version": "v1",
            "X-Speech-Range": "0-100/300",
          },
        }),
      ),
    );

    const result = await fetchSpeechChunk({
      bookmarkId: "bookmark-1",
      voice: "voice-a",
      start: 0,
      signal: new AbortController().signal,
    });

    expect(result.next).toBe(100);
    expect(result.contentVersion).toBe("v1");
    expect(result.range).toBe("0-100/300");
    expect(result.blob.size).toBeGreaterThan(0);
  });

  it("treats an empty next header as the end of the stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Blob(["audio"]), {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "X-Speech-Next": "",
            "X-Speech-Content-Version": "v1",
          },
        }),
      ),
    );

    const result = await fetchSpeechChunk({
      bookmarkId: "bookmark-1",
      voice: "voice-a",
      start: 0,
      signal: new AbortController().signal,
    });

    expect(result.next).toBeNull();
  });

  it("decodes the X-Speech-Text header as UTF-8 base64url text", async () => {
    const text = "Héllo wörld — unicode 😀";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Blob(["audio"]), {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "X-Speech-Next": "",
            "X-Speech-Content-Version": "v1",
            "X-Speech-Text": Buffer.from(text, "utf8").toString("base64url"),
          },
        }),
      ),
    );

    const result = await fetchSpeechChunk({
      bookmarkId: "bookmark-1",
      voice: "voice-a",
      start: 0,
      signal: new AbortController().signal,
    });

    expect(result.text).toBe(text);
  });

  it("tolerates a missing X-Speech-Text header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Blob(["audio"]), {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "X-Speech-Next": "",
            "X-Speech-Content-Version": "v1",
          },
        }),
      ),
    );

    const result = await fetchSpeechChunk({
      bookmarkId: "bookmark-1",
      voice: "voice-a",
      start: 0,
      signal: new AbortController().signal,
    });

    expect(result.text).toBeUndefined();
  });

  it("tolerates an invalid X-Speech-Text header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Blob(["audio"]), {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "X-Speech-Next": "",
            "X-Speech-Content-Version": "v1",
            "X-Speech-Text": "not!base64",
          },
        }),
      ),
    );

    const result = await fetchSpeechChunk({
      bookmarkId: "bookmark-1",
      voice: "voice-a",
      start: 0,
      signal: new AbortController().signal,
    });

    expect(result.text).toBeUndefined();
  });

  it.each<{ name: string; headers: Record<string, string> }>([
    { name: "missing next", headers: { "X-Speech-Content-Version": "v1" } },
    {
      name: "invalid next",
      headers: { "X-Speech-Next": "abc", "X-Speech-Content-Version": "v1" },
    },
    { name: "missing version", headers: { "X-Speech-Next": "100" } },
    {
      name: "wrong content type",
      headers: {
        "X-Speech-Next": "100",
        "X-Speech-Content-Version": "v1",
        "Content-Type": "application/json",
      },
    },
  ])("rejects a protocol error when $name", async ({ headers }) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Blob(["audio"]), { status: 200, headers }),
        ),
    );

    await expect(
      fetchSpeechChunk({
        bookmarkId: "bookmark-1",
        voice: "voice-a",
        start: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ info: { code: "protocol" } });
  });

  it("maps a busy 503 response with Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: "Local speech is busy. Please retry." }),
          {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "3" },
          },
        ),
      ),
    );

    await expect(
      fetchSpeechChunk({
        bookmarkId: "bookmark-1",
        voice: "voice-a",
        start: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      info: { code: "busy", retryAfterSeconds: 3 },
    });
  });

  it("maps a 409 response to a restart error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "The bookmark content changed. Restart read-aloud.",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      fetchSpeechChunk({
        bookmarkId: "bookmark-1",
        voice: "voice-a",
        start: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ info: { code: "restart" } });
  });
});

describe("fetchSpeechVoices", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns only valid voice entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            voices: [
              { id: "a", name: "Aaron", language: "en-US" },
              { id: 7, name: "Invalid", language: "xx" },
              { id: "b", name: "Beth", language: "de-DE" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(fetchSpeechVoices()).resolves.toEqual([
      { id: "a", name: "Aaron", language: "en-US" },
      { id: "b", name: "Beth", language: "de-DE" },
    ]);
  });

  it("maps a configured 503 response to not-configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: "Local speech is not configured." }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    await expect(fetchSpeechVoices()).rejects.toMatchObject({
      info: { code: "not-configured" },
    });
  });

  it("rejects a non-array voices payload as a protocol error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ voices: "nope" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(fetchSpeechVoices()).rejects.toMatchObject({
      info: { code: "protocol" },
    });
  });
});
