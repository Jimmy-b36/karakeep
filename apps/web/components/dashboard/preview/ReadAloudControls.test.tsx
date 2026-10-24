// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { useReadAloud } from "@/lib/hooks/useReadAloud";
import type { ReadAloudSnapshot } from "@/lib/read-aloud";

import ReadAloudControls from "./ReadAloudControls";

vi.mock("@/lib/i18n/client", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function controls(snapshot: Partial<ReadAloudSnapshot> = {}) {
  return {
    snapshot: {
      status: "idle",
      error: null,
      currentText: null,
      canPrevious: false,
      canNext: false,
      ...snapshot,
    },
    voices: [{ id: "voice-a", name: "Heart", language: "en-US" }],
    voicesStatus: "ready",
    voicesError: null,
    voiceId: "voice-a",
    speed: 1,
    setVoice: vi.fn(),
    setSpeed: vi.fn(),
    loadVoices: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    startAt: vi.fn().mockResolvedValue(undefined),
    previousChunk: vi.fn(),
    nextChunk: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
  } satisfies ReturnType<typeof useReadAloud>;
}

async function openControls(readAloud: ReturnType<typeof controls>) {
  render(<ReadAloudControls readAloud={readAloud} enabled />);
  fireEvent.click(screen.getByRole("button", { name: "preview.listen.title" }));
  return {
    previous: await screen.findByRole("button", {
      name: "preview.listen.previous_chunk",
    }),
    next: screen.getByRole("button", { name: "preview.listen.next_chunk" }),
  };
}

describe("ReadAloudControls chunk navigation", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["idle", "buffering"] as const)(
    "disables navigation while %s",
    async (status) => {
      const { previous, next } = await openControls(controls({ status }));
      expect(previous).toHaveProperty("disabled", true);
      expect(next).toHaveProperty("disabled", true);
    },
  );

  it("disables previous at the first chunk and wires next to the hook", async () => {
    const readAloud = controls({ status: "playing", canNext: true });
    const { previous, next } = await openControls(readAloud);
    expect(previous).toHaveProperty("disabled", true);
    expect(next).toHaveProperty("disabled", false);
    fireEvent.click(next);
    expect(readAloud.nextChunk).toHaveBeenCalledOnce();
  });

  it("wires previous while paused and disables next at the last chunk", async () => {
    const readAloud = controls({ status: "paused", canPrevious: true });
    const { previous, next } = await openControls(readAloud);
    expect(previous).toHaveProperty("disabled", false);
    expect(next).toHaveProperty("disabled", true);
    fireEvent.click(previous);
    expect(readAloud.previousChunk).toHaveBeenCalledOnce();
    expect(readAloud.resume).not.toHaveBeenCalled();
  });
});
