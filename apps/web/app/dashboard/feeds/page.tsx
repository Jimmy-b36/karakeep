import Bookmarks from "@/components/dashboard/bookmarks/Bookmarks";
import FeedsEmptyState from "@/components/dashboard/feeds/FeedsEmptyState";
import FeedsHeader from "@/components/dashboard/feeds/FeedsHeader";
import { api } from "@/server/api/client";

export default async function FeedsPage() {
  const feeds = await api.feeds.list();

  return (
    <Bookmarks
      query={{ rssOnly: true }}
      showEditorCard={false}
      showDivider={true}
      header={<FeedsHeader />}
      emptyState={<FeedsEmptyState hasSubscriptions={feeds.feeds.length > 0} />}
    />
  );
}
