"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

import { applySpeechHighlight } from "@/lib/speech-highlight";

export function useSpeechHighlight(
  containerRef: RefObject<HTMLElement | null>,
  text: string | null | undefined,
): void {
  useEffect(() => {
    applySpeechHighlight(containerRef.current, text);
    return () => {
      applySpeechHighlight(containerRef.current, null);
    };
  }, [containerRef, text]);
}
