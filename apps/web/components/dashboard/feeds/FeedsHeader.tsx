"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Settings } from "lucide-react";

import { useTranslation } from "@/lib/i18n/client";

import { FeedSelector } from "./FeedSelector";

export default function FeedsHeader({
  currentFeedId,
}: {
  currentFeedId?: string;
}) {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <div className="flex items-center gap-3">
      <div className="text-2xl">{t("common.rss")}</div>
      <FeedSelector
        className="w-64"
        allItemLabel={t("feeds.all_feeds")}
        value={currentFeedId ?? "all"}
        onChange={(feedId) =>
          router.push(
            feedId === "all"
              ? "/dashboard/feeds"
              : `/dashboard/feeds/${feedId}`,
          )
        }
      />
      <Link
        href="/settings/feeds"
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <Settings className="size-4" />
        {t("feeds.manage_feeds")}
      </Link>
    </div>
  );
}
