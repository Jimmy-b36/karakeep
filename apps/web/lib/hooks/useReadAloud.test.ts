// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchSpeechChunk: vi.fn(),
  fetchSpeechVoices: vi.fn(),
}));

vi.mock("@/lib/read-aloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/read-aloud")>();
  return {
    ...actual,
    fetchSpeechChunk: mocks.fetchSpeechChunk,
    fetchSpeechVoices: mocks.fetchSpeechVoices,
  };
});

import { useReadAloud } from "./useReadAloud";

class FakeAudio {
  playbackRate = 1;
  src = "";
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
}

async function startAndSettle(result: { current: { start: () => void } }) {
  await act(async () => {
    result.current.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useReadAloud voice selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.stubGlobal("Audio", FakeAudio);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    mocks.fetchSpeechVoices.mockResolvedValue([
      { id: "voice-a", name: "Aaron", language: "en-US" },
      { id: "voice-b", name: "Beth", language: "de-DE" },
    ]);
    mocks.fetchSpeechChunk.mockResolvedValue({
      blob: new Blob(["audio"]),
      next: null,
      contentVersion: "v1",
      range: "0-1/1",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the auto-selected first voice for the first request when nothing is stored", async () => {
    const { result } = renderHook(() => useReadAloud("bookmark-1", true));

    await act(async () => {
      await result.current.loadVoices();
    });

    expect(result.current.voiceId).toBe("voice-a");

    await startAndSettle(result);

    expect(mocks.fetchSpeechChunk).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSpeechChunk).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "voice-a", start: 0 }),
    );
  });

  it("uses the auto-selected first voice for the first request when the stored voice is stale", async () => {
    window.localStorage.setItem("karakeep-read-aloud-voice", "stale-voice");
    const { result } = renderHook(() => useReadAloud("bookmark-1", true));

    await act(async () => {
      await result.current.loadVoices();
    });

    expect(result.current.voiceId).toBe("voice-a");

    await startAndSettle(result);

    expect(mocks.fetchSpeechChunk).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "voice-a" }),
    );
  });

  it("keeps a valid stored voice for the first request", async () => {
    window.localStorage.setItem("karakeep-read-aloud-voice", "voice-b");
    const { result } = renderHook(() => useReadAloud("bookmark-1", true));

    await act(async () => {
      await result.current.loadVoices();
    });

    expect(result.current.voiceId).toBe("voice-b");

    await startAndSettle(result);

    expect(mocks.fetchSpeechChunk).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "voice-b" }),
    );
  });
});
