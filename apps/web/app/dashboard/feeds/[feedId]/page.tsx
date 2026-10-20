import { notFound } from "next/navigation";
import Bookmarks from "@/components/dashboard/bookmarks/Bookmarks";
import FeedsEmptyState from "@/components/dashboard/feeds/FeedsEmptyState";
import FeedsHeader from "@/components/dashboard/feeds/FeedsHeader";
import { api } from "@/server/api/client";
import { TRPCError } from "@trpc/server";

export default async function FeedPage(props: {
  params: Promise<{ feedId: string }>;
}) {
  const params = await props.params;
  let feed;
  try {
    feed = await api.feeds.get({ feedId: params.feedId });
  } catch (e) {
    if (e instanceof TRPCError) {
      if (e.code == "NOT_FOUND") {
        notFound();
      }
    }
    throw e;
  }

  return (
    <Bookmarks
      query={{ rssFeedId: feed.id }}
      showDivider={true}
      showEditorCard={false}
      header={<FeedsHeader currentFeedId={feed.id} />}
      emptyState={<FeedsEmptyState hasSubscriptions={true} />}
    />
  );
}
