import { FullPageSpinner } from "@/components/ui/full-page-spinner";
import { toast } from "@/components/ui/sonner";
import { useTranslation } from "@/lib/i18n/client";
import {
  speechOffsetFromClick,
  speechOffsetFromKeyDown,
} from "@/lib/speech-highlight";
import { useSpeechHighlight } from "@/lib/hooks/useSpeechHighlight";
import { useQuery } from "@tanstack/react-query";
import { FileX } from "lucide-react";
import { useRef } from "react";

import BookmarkHTMLHighlighter from "@karakeep/shared-react/components/BookmarkHtmlHighlighter";
import ScrollProgressTracker from "@karakeep/shared-react/components/ScrollProgressTracker";
import {
  useCreateHighlight,
  useDeleteHighlight,
  useUpdateHighlight,
} from "@karakeep/shared-react/hooks/highlights";
import { useReadingProgress } from "@karakeep/shared-react/hooks/reading-progress";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import ReadingProgressBanner from "./ReadingProgressBanner";

export default function ReaderView({
  bookmarkId,
  className,
  style,
  readOnly,
  progressBarStyle,
  speechText,
  speechWord,
  onSpeechJump,
}: {
  bookmarkId: string;
  className?: string;
  style?: React.CSSProperties;
  readOnly: boolean;
  progressBarStyle?: React.CSSProperties;
  onSpeechJump?: (offset: number) => void;
  speechText?: string | null;
  speechWord?: { from: number; to: number } | null;
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const speechHighlightRef = useRef<HTMLElement>(null);
  useSpeechHighlight(speechHighlightRef, speechText, speechWord);
  const { data: highlights } = useQuery(
    api.highlights.getForBookmark.queryOptions({
      bookmarkId,
    }),
  );
  const { data: cachedContent, isPending: isCachedContentLoading } = useQuery(
    api.bookmarks.getBookmark.queryOptions(
      {
        bookmarkId,
        includeContent: true,
      },
      {
        select: (data) =>
          data.content.type == BookmarkTypes.LINK
            ? data.content.htmlContent
            : null,
      },
    ),
  );

  const {
    showBanner,
    bannerPercent,
    onContinue,
    onDismiss,
    restorePosition,
    readingProgressOffset,
    readingProgressAnchor,
    onSavePosition,
    onScrollPositionChange,
  } = useReadingProgress({
    bookmarkId,
  });

  const { mutate: createHighlight } = useCreateHighlight({
    onSuccess: () => {
      toast({
        description: "Highlight has been created!",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        description: "Something went wrong",
      });
    },
  });

  const { mutate: updateHighlight } = useUpdateHighlight({
    onSuccess: () => {
      toast({
        description: "Highlight has been updated!",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        description: "Something went wrong",
      });
    },
  });

  const { mutate: deleteHighlight } = useDeleteHighlight({
    onSuccess: () => {
      toast({
        description: "Highlight has been deleted!",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        description: "Something went wrong",
      });
    },
  });

  let content;
  if (isCachedContentLoading) {
    content = <FullPageSpinner />;
  } else if (!cachedContent) {
    content = (
      <div className="flex h-full w-full items-center justify-center p-4">
        <div className="max-w-sm space-y-4 text-center">
          <div className="flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <FileX className="h-8 w-8 text-muted-foreground" />
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-medium text-foreground">
              {t("preview.fetch_error_title")}
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("preview.fetch_error_description")}
            </p>
          </div>
        </div>
      </div>
    );
  } else {
    content = (
      <ScrollProgressTracker
        onSavePosition={onSavePosition}
        onScrollPositionChange={onScrollPositionChange}
        restorePosition={restorePosition}
        readingProgressOffset={readingProgressOffset}
        readingProgressAnchor={readingProgressAnchor}
        showProgressBar
        progressBarStyle={progressBarStyle}
      >
        {showBanner && (
          <ReadingProgressBanner
            percent={bannerPercent}
            onContinue={onContinue}
            onDismiss={onDismiss}
          />
        )}
        {/* Keep article semantics while exposing the paragraph speech shortcut to keyboard users. */}
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <article
          ref={speechHighlightRef}
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={onSpeechJump ? 0 : undefined}
          aria-keyshortcuts={onSpeechJump ? "Enter" : undefined}
          onKeyDown={(event) => {
            if (!onSpeechJump) return;
            const offset = speechOffsetFromKeyDown(event.currentTarget, event);
            if (offset !== null) {
              event.preventDefault();
              onSpeechJump(offset);
            }
          }}
          onClick={(event) => {
            if (!onSpeechJump) return;
            const offset = speechOffsetFromClick(event.currentTarget, event);
            if (offset !== null) onSpeechJump(offset);
          }}
        >
          <BookmarkHTMLHighlighter
            className={className}
            style={style}
            htmlContent={cachedContent || ""}
            highlights={highlights?.highlights ?? []}
            readOnly={readOnly}
            onDeleteHighlight={(h) =>
              deleteHighlight({
                highlightId: h.id,
              })
            }
            onUpdateHighlight={(h) =>
              updateHighlight({
                highlightId: h.id,
                color: h.color,
                note: h.note,
              })
            }
            onHighlight={(h) =>
              createHighlight({
                startOffset: h.startOffset,
                endOffset: h.endOffset,
                color: h.color,
                bookmarkId,
                text: h.text,
                note: h.note ?? null,
              })
            }
          />
        </article>
      </ScrollProgressTracker>
    );
  }
  return content;
}
