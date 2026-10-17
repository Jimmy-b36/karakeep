"use client";

import { useState } from "react";
import {
  AudioLines,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/lib/i18n/client";
import { READ_ALOUD_SPEEDS, useReadAloud } from "@/lib/hooks/useReadAloud";
import type { ReadAloudErrorCode } from "@/lib/read-aloud";

interface ReadAloudControlsProps {
  readAloud: ReturnType<typeof useReadAloud>;
  enabled: boolean;
}

export default function ReadAloudControls({
  readAloud,
  enabled,
}: ReadAloudControlsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (!enabled) {
    return null;
  }

  const { snapshot, voices, voicesStatus, voicesError, voiceId } = readAloud;
  const active = snapshot.status !== "idle";
  const buffering = snapshot.status === "buffering";

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      void readAloud.loadVoices();
    }
  };

  const describeError = (code: ReadAloudErrorCode, message: string) => {
    switch (code) {
      case "playback":
        return t("preview.listen.error_playback");
      case "protocol":
        return t("preview.listen.error_protocol");
      case "network":
        return t("preview.listen.error_network");
      default:
        return message || t("preview.listen.error_fallback");
    }
  };

  const retryableError =
    snapshot.error?.code === "busy" ||
    snapshot.error?.code === "upstream" ||
    snapshot.error?.code === "network" ||
    snapshot.error?.code === "protocol";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant={active ? "default" : "ghost"}
          size="icon"
          aria-label={t("preview.listen.title")}
        >
          {buffering ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <AudioLines className="size-4" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={16}
        className="flex w-80 flex-col gap-4 p-4"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AudioLines className="size-4" />
            <h3 className="font-semibold">{t("preview.listen.title")}</h3>
          </div>
          {active && !snapshot.error && (
            <span role="status" className="text-xs text-muted-foreground">
              {buffering
                ? t("preview.listen.buffering")
                : snapshot.status === "paused"
                  ? t("preview.listen.paused")
                  : t("preview.listen.playing")}
            </span>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">
            {t("preview.listen.voice")}
          </label>
          {voicesStatus === "loading" ? (
            <p className="text-sm text-muted-foreground">
              {t("preview.listen.loading_voices")}
            </p>
          ) : voicesStatus === "error" ? (
            <p className="text-sm text-destructive" role="alert">
              {voicesError
                ? describeError(voicesError.code, voicesError.message)
                : t("preview.listen.error_fallback")}
            </p>
          ) : voices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("preview.listen.no_voices")}
            </p>
          ) : (
            <Select
              value={voiceId ?? undefined}
              onValueChange={readAloud.setVoice}
            >
              <SelectTrigger aria-label={t("preview.listen.voice")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {voices.map((voice) => (
                  <SelectItem key={voice.id} value={voice.id}>
                    {voice.name} · {voice.language}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">
            {t("preview.listen.speed")}
          </label>
          <Select
            value={String(readAloud.speed)}
            onValueChange={(value) => readAloud.setSpeed(Number(value))}
          >
            <SelectTrigger aria-label={t("preview.listen.speed")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {READ_ALOUD_SPEEDS.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {value}×
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {snapshot.error ? (
          <div className="space-y-2 rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <p className="text-sm text-destructive" role="alert">
              {describeError(snapshot.error.code, snapshot.error.message)}
            </p>
            <div className="flex items-center gap-2">
              {snapshot.error.code === "restart" ? (
                <Button onClick={readAloud.start} className="flex-1">
                  <RotateCcw className="size-4" />
                  {t("preview.listen.restart")}
                </Button>
              ) : snapshot.error.code === "playback" ? (
                <Button onClick={readAloud.resume} className="flex-1">
                  <Play className="size-4" />
                  {t("preview.listen.try_again")}
                </Button>
              ) : retryableError ? (
                <Button onClick={readAloud.retry} className="flex-1">
                  <RotateCcw className="size-4" />
                  {t("preview.listen.retry")}
                </Button>
              ) : null}
              <Button onClick={readAloud.stop} variant="outline">
                <Square className="size-4" />
                {t("preview.listen.stop")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {snapshot.status === "playing" ? (
              <Button
                onClick={readAloud.pause}
                variant="secondary"
                className="flex-1"
              >
                <Pause className="size-4" />
                {t("preview.listen.pause")}
              </Button>
            ) : snapshot.status === "paused" ? (
              <Button onClick={readAloud.resume} className="flex-1">
                <Play className="size-4" />
                {t("preview.listen.resume")}
              </Button>
            ) : (
              <Button
                onClick={readAloud.start}
                className="flex-1"
                disabled={buffering || !voiceId}
              >
                {buffering ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                {buffering
                  ? t("preview.listen.buffering")
                  : t("preview.listen.play")}
              </Button>
            )}
            <Button
              onClick={readAloud.stop}
              variant="outline"
              disabled={!active}
            >
              <Square className="size-4" />
              {t("preview.listen.stop")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
