"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchSpeechChunk,
  fetchSpeechVoices,
  ReadAloudError,
  ReadAloudPlayer,
} from "@/lib/read-aloud";
import type {
  ReadAloudErrorInfo,
  ReadAloudSnapshot,
  SpeechVoice,
} from "@/lib/read-aloud";

export const READ_ALOUD_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

const VOICE_STORAGE_KEY = "karakeep-read-aloud-voice-v2";
const SPEED_STORAGE_KEY = "karakeep-read-aloud-speed";

function readStoredVoice(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(VOICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readStoredSpeed(): number {
  if (typeof window === "undefined") {
    return 1;
  }
  try {
    const value = Number(window.localStorage.getItem(SPEED_STORAGE_KEY));
    return (READ_ALOUD_SPEEDS as readonly number[]).includes(value) ? value : 1;
  } catch {
    return 1;
  }
}

function writeStoredValue(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preferences are optional; never block playback on storage failures.
  }
}

export type VoicesStatus = "idle" | "loading" | "ready" | "error";

export function useReadAloud(bookmarkId: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<ReadAloudSnapshot>({
    status: "idle",
    canPrevious: false,
    canNext: false,
    error: null,
    currentText: null,
  });
  const [voices, setVoices] = useState<SpeechVoice[]>([]);
  const [voicesStatus, setVoicesStatus] = useState<VoicesStatus>("idle");
  const [voicesError, setVoicesError] = useState<ReadAloudErrorInfo | null>(
    null,
  );
  const [voiceId, setVoiceIdState] = useState<string | null>(readStoredVoice);
  const [speed, setSpeedState] = useState<number>(readStoredSpeed);

  const playerRef = useRef<ReadAloudPlayer | null>(null);
  const voiceRef = useRef<string | null>(voiceId);
  const speedRef = useRef<number>(speed);
  const voicesLoadedRef = useRef(false);
  const voicesRequestRef = useRef<Promise<void> | null>(null);
  const startRequestRef = useRef(0);

  voiceRef.current = voiceId;
  speedRef.current = speed;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const player = new ReadAloudPlayer(
      {
        fetchChunk: fetchSpeechChunk,
        createAudio: () => new Audio(),
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
        onSnapshot: setSnapshot,
      },
      bookmarkId,
      voiceRef.current ?? "",
      speedRef.current,
    );
    playerRef.current = player;
    setSnapshot(player.currentSnapshot);
    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, [bookmarkId, enabled]);

  // Losing owner eligibility (or navigating to a non-LINK bookmark) stops
  // playback and clears the previous session's UI state.
  useEffect(() => {
    if (!enabled) {
      setSnapshot({
        status: "idle",
        canPrevious: false,
        canNext: false,
        error: null,
        currentText: null,
      });
    }
  }, [enabled]);

  const timedPlayback = snapshot.currentWord !== undefined;
  useEffect(() => {
    if (
      !timedPlayback ||
      snapshot.status !== "playing" ||
      typeof requestAnimationFrame === "undefined"
    )
      return;
    let frame: number;
    const tick = () => {
      playerRef.current?.updateProgress();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [snapshot.status, timedPlayback]);

  const loadVoices = useCallback(async () => {
    if (voicesRequestRef.current) return voicesRequestRef.current;
    if (voicesLoadedRef.current) return;
    voicesLoadedRef.current = true;
    setVoicesStatus("loading");
    setVoicesError(null);
    voicesRequestRef.current = (async () => {
      try {
        const list = await fetchSpeechVoices();
        const current = voiceRef.current;
        const chosen =
          current && list.some((voice) => voice.id === current)
            ? current
            : (list[0]?.id ?? null);
        setVoices(list);
        if (chosen !== current) {
          setVoiceIdState(chosen);
          voiceRef.current = chosen;
          if (chosen) {
            writeStoredValue(VOICE_STORAGE_KEY, chosen);
            playerRef.current?.setVoice(chosen);
          }
        }
        setVoicesStatus("ready");
      } catch (error) {
        voicesLoadedRef.current = false;
        setVoicesError(
          error instanceof ReadAloudError
            ? error.info
            : {
                code: "network",
                message: "Could not reach the local speech service.",
              },
        );
        setVoicesStatus("error");
      } finally {
        voicesRequestRef.current = null;
      }
    })();
    return voicesRequestRef.current;
  }, []);

  useEffect(() => {
    if (enabled) void loadVoices();
  }, [enabled, loadVoices]);

  const setVoice = useCallback((id: string) => {
    setVoiceIdState(id);
    writeStoredValue(VOICE_STORAGE_KEY, id);
    playerRef.current?.setVoice(id);
  }, []);

  const setSpeed = useCallback((value: number) => {
    setSpeedState(value);
    writeStoredValue(SPEED_STORAGE_KEY, String(value));
    playerRef.current?.setSpeed(value);
  }, []);

  const start = useCallback(() => {
    startRequestRef.current++;
    playerRef.current?.start();
  }, []);
  const startAt = useCallback(
    async (offset: number) => {
      const player = playerRef.current;
      if (!player) return;
      const request = ++startRequestRef.current;
      await loadVoices();
      if (
        request === startRequestRef.current &&
        playerRef.current === player &&
        voicesLoadedRef.current &&
        voiceRef.current
      )
        player.startAt(offset);
    },
    [loadVoices],
  );
  const previousChunk = useCallback(() => {
    startRequestRef.current++;
    playerRef.current?.previousChunk();
  }, []);
  const nextChunk = useCallback(() => {
    startRequestRef.current++;
    playerRef.current?.nextChunk();
  }, []);
  const pause = useCallback(() => {
    playerRef.current?.pause();
  }, []);
  const resume = useCallback(() => {
    playerRef.current?.resume();
  }, []);
  const stop = useCallback(() => {
    startRequestRef.current++;
    playerRef.current?.stop();
  }, []);
  const retry = useCallback(() => {
    playerRef.current?.retry();
  }, []);

  return {
    snapshot,
    voices,
    voicesStatus,
    voicesError,
    voiceId,
    speed,
    setVoice,
    setSpeed,
    loadVoices,
    start,
    startAt,
    previousChunk,
    nextChunk,
    pause,
    resume,
    stop,
    retry,
  };
}
