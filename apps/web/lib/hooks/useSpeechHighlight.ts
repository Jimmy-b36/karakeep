"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

import { applySpeechHighlight } from "@/lib/speech-highlight";

export function useSpeechHighlight(
  containerRef: RefObject<HTMLElement | null>,
  text: string | null | undefined,
  word?: { from: number; to: number } | null,
  color?: string,
): void {
  useEffect(() => {
    applySpeechHighlight(containerRef.current, text, word, color);
    return () => {
      applySpeechHighlight(containerRef.current, null);
    };
  }, [containerRef, text, word, color]);
}
