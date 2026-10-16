import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchSpeechChunk,
  fetchSpeechVoices,
  ReadAloudPlayer,
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
): SpeechChunk {
  return { blob: new Blob(["audio"]), next, contentVersion, range };
}

function createFakeAudio() {
  const play = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const pause = vi.fn();
  const load = vi.fn();
  const removeAttribute = vi.fn();
  const audio: AudioLike = {
    playbackRate: 1,
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
  const fetchChunk = vi.fn();
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
    fetchChunk.mockReturnValueOnce(first.promise);

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

    const second = deferred<SpeechChunk>();
    fetchChunk.mockReturnValueOnce(second.promise);
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

  it("fails with restart when a later chunk reports a new content version", async () => {
    const { player, audio, fetchChunk, createObjectURL } = setupPlayer();

    const first = deferred<SpeechChunk>();
    fetchChunk.mockReturnValueOnce(first.promise);
    player.start();
    first.resolve(chunk(100, "v1"));
    await flush();
    expect(player.currentSnapshot.status).toBe("playing");

    const second = deferred<SpeechChunk>();
    fetchChunk.mockReturnValueOnce(second.promise);
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
