# Separate RSS board

## Goal

Keep automatically imported RSS articles off Home (`/dashboard/bookmarks`). Add a dedicated RSS board where users can browse all subscriptions or an individual feed. Explicitly saving an article to the library makes it appear on Home without duplicating it or removing it from RSS.

This is a web-dashboard change, with additive shared API support. It does not change the default meaning of an unfiltered bookmarks API request or redesign mobile/CLI clients.

## Current implementation

- Home renders `Bookmarks` with `{ archived: false }` in `apps/web/app/dashboard/bookmarks/page.tsx`.
- `apps/workers/workers/feedWorker.ts` creates bookmarks with `source: "rss"`, then associates them with subscriptions through `rssFeedImports`.
- `packages/trpc/routers/bookmarks.ts` deduplicates link creation. Manual re-saves restore and refresh an existing bookmark; RSS/import re-saves deliberately do nothing.
- Individual feed boards already exist at `/dashboard/feeds/[feedId]`. There is no aggregate feed board.
- `packages/trpc/models/bookmarks.ts` applies filters before cursor pagination. The existing `rssFeedId` filter uses feed-import associations, not bookmark source.
- Dashboard navigation is shared by desktop and mobile in `apps/web/app/dashboard/layout.tsx`.
- Deleting a subscription cascades its import associations, not its bookmarks. Filtering solely on those associations would strand unsaved articles after unsubscribe.

## Behavior

| Article | Home | RSS board |
| --- | --- | --- |
| Manually saved, unrelated to RSS | Yes, unless archived | No |
| Automatically imported from RSS | No | Yes |
| RSS article explicitly saved to library | Yes, unless archived | Yes |
| Manually saved before a feed imports the same URL | Remains on Home | Also appears in the relevant feed |
| RSS article after its subscription is deleted | Only if saved | Remains discoverable in All feeds |

- Keep existing individual-feed routes and feed settings.
- RSS board uses the existing bookmark cards, preview, layout preferences, sorting, and pagination. Do not add the new-bookmark editor there.
- RSS shows archived and unarchived articles, matching today's individual-feed pages. Home continues excluding archived articles.
- Saving is an explicit action. Reading, favouriting, tagging, or adding to a list does not silently save an article to Home.
- Search, tags, lists, favourites, archive, exports, and public sharing retain their existing scope. This is separation from Home, not a new privacy boundary.

## Design

### 1. Track library membership separately from source

Add a non-null `inLibrary` boolean to bookmarks, defaulting to `true` for backwards-compatible ordinary creation. Preserve `source` as provenance; do not change `source: "rss"` to simulate saving.

Creation rules:

- New RSS bookmarks: `inLibrary = false`, assigned server-side from the creation source.
- Other new bookmarks: `inLibrary = true`.
- RSS or import deduplication: retain existing membership, timestamps, and metadata.
- Manual link re-save: set `inLibrary = true` in the existing deduplication update, preserving its restore/refresh behavior.

Do not expose arbitrary library membership on creation requests. Add a narrowly scoped, authenticated `saveToLibrary({ bookmarkId })` mutation. Reuse the existing authorized bookmark lookup; update only membership and the timestamps/archive state needed to match manual re-saving. An already-saved article is an idempotent no-op, including timestamps. Keep the ordinary URL re-save behavior unchanged.

Return `inLibrary` in bookmark responses so UI actions can show the right state. Check explicit serializers as well as inferred database types.

### 2. Filter at the database layer

Add optional `inLibrary` and `rssOnly` filters to `zGetBookmarksRequestSchema` and implement them in `packages/trpc/models/bookmarks.ts` before pagination.

- Home requests `{ archived: false, inLibrary: true }`.
- All feeds requests `{ rssOnly: true }`.
- Individual feeds continue requesting `{ rssFeedId }`.
- An omitted filter preserves existing API behavior.

For `rssOnly`, select bookmarks whose `source` is `rss` **or** which have an import association to a feed owned by the current user. Use a correlated `EXISTS`, not a multiplying join, so articles shared by multiple feeds appear once. Retain the outer bookmark-owner restriction. The source fallback keeps RSS-origin articles discoverable after unsubscribe.

Do not filter only by `source`: a feed can import an already-manually-saved bookmark whose source remains `web`, `api`, etc. Do not fetch every feed separately and merge client-side.

Apply membership consistently across existing query strategies, without silently changing list/tag/ID lookups. Verify any select-all/bulk operations use the same query as the displayed board.

### 3. Add the RSS board and save action

- Add `apps/web/app/dashboard/feeds/page.tsx`, reusing `Bookmarks`.
- Add an RSS navigation item through the shared `items` definition in `apps/web/app/dashboard/layout.tsx` so it appears on desktop and mobile.
- Add an All feeds / individual feed selector in the RSS header. Reuse the existing feed-query and select-component patterns from `components/dashboard/feeds/FeedSelector.tsx`; leave its rule-builder callers unchanged. Route selections to the existing individual-feed pages and provide a clear return to All feeds.
- Include a Manage feeds link to `/settings/feeds`. Distinguish no subscriptions from a subscribed feed with no articles. Retained articles must still render when there are no subscriptions.
- Add an accessible **Save to library** action for owned, unsaved bookmarks using the existing bookmark action/menu conventions. Expose it wherever those shared actions render, including article preview. Show **Saved to library** as a disabled state, not a second toggle.
- Saving keeps the article visible on RSS and makes it available on Home immediately. Reuse `packages/shared-react/hooks/bookmarks.ts` mutation patterns, invalidating relevant bookmark detail, board, and search caches; include existing derived/stat caches if affected. Do not optimistically remove the article from RSS.
- Add localized labels, success/error messages, and empty states. Follow the repository's translation skill when English strings change.

No bulk-save workflow or “remove from library” action in this change.

### 4. Migrate existing data deliberately

Generate the Drizzle migration through the repository command (`pnpm db:generate --name separate_rss_library`).

- Ordinary existing bookmarks retain `inLibrary = true`.
- Existing `source = 'rss'` bookmarks become `inLibrary = false`, except where the implementation can establish a reliable historical explicit-save signal.
- Before finalizing the backfill, inspect the migration that introduced `lastSavedAt` and the manual re-save code/history. A timestamp difference alone must not be treated as proof without checking how those values were initialized and whether RSS/import jobs can change them.
- If a reliable signal exists, preserve those known manual saves and test that migration case. Otherwise document the limitation rather than guess from favourites, tags, notes, or list membership.
- Never delete, duplicate, re-import, or change article content, feed associations, source, archive state, or original creation time during migration.

**Known limitation:** the current schema has no explicit historical library-membership flag. If prior manual saves cannot be reconstructed reliably, some previously saved RSS-origin articles will move off Home with other imports. They remain in RSS and can be restored with Save to library. State this plainly in release notes before shipping.

**Implemented backfill (migration `0096`, user-facing warning):** because `lastSavedAt` was initialized to the row's creation time in migration `0092` and `createdAt` is user-editable, no reliable signal distinguishes manually re-saved RSS articles. The backfill therefore moves **all** pre-existing `source = 'rss'` bookmarks off Home. Nothing is deleted — article data, source, feed associations, archive state, and original creation times are untouched — and every affected article stays on the RSS board, where it can be restored to Home via **Save to library**.

## Implementation checklist

- [ ] Add `inLibrary` to `packages/db/schema.ts`; inspect timestamp migration history and generate/review the backfill migration.
- [ ] Extend bookmark response/query schemas in `packages/shared/types/bookmarks.ts` and explicit response mappings.
- [ ] Implement creation, deduplication, and authorized/idempotent save behavior in `packages/trpc/routers/bookmarks.ts` and existing model helpers where appropriate.
- [ ] Implement server-side membership and aggregate-RSS filtering in `packages/trpc/models/bookmarks.ts`.
- [ ] Check `packages/api/routes/bookmarks.ts`, OpenAPI generation, SDK types, exports/importers, and fixtures for shared-schema assumptions. Update generated contracts using existing scripts; do not hand-edit generated output.
- [ ] Add the aggregate RSS route, shared navigation, feed selector/header, and empty states; update Home's query.
- [ ] Add the shared save mutation hook, action, cache invalidation, and translated copy.
- [ ] Add regression tests and run scoped checks.
- [ ] Verify desktop/mobile navigation and the full import → browse → save → Home flow in the browser.

## Regression tests

Extend `packages/trpc/routers/bookmarks.test.ts` and `packages/trpc/routers/feeds.test.ts`, with focused worker coverage where existing harnesses permit:

1. RSS creation produces an unsaved article; ordinary creation produces a library bookmark.
2. Home excludes unsaved RSS but includes saved/manual articles and still excludes archived articles.
3. All feeds includes RSS-origin and association-only articles, excludes unrelated manual bookmarks, deduplicates multiple-feed articles, and paginates correctly in both sort orders.
4. Feed-specific queries retain current behavior. Saving an article keeps it on its feed and adds it to Home under the same bookmark ID.
5. Manual URL re-save promotes an RSS bookmark. RSS/import deduplication never demotes saved bookmarks or refreshes their timestamps.
6. Save is idempotent; another user's bookmark cannot be saved or returned by aggregate/per-feed queries.
7. Deleting or disabling a subscription does not unexpectedly move unsaved articles to Home; deleted-subscription RSS-origin articles remain discoverable.
8. Migration preserves ordinary bookmarks and article data; any historical-save preservation rule has explicit fixtures.
9. Existing unfiltered API requests, list/tag queries, bulk selection, and bookmark detail access keep their previous scope.
10. UI save state updates after success; failure leaves the action retryable and never claims the article was saved.

Run package-scoped tests, typecheck, lint, and formatting using the repo's Turbo filters. Probe changed source paths with LSP diagnostics. Inspect the Home and RSS query plans on a realistically sized dataset; add an index only if evidence shows the existing user/cursor and feed-association indexes are insufficient.

## Acceptance criteria

- Imported articles no longer flood Home, including after migration.
- RSS is reachable on desktop and mobile, with All feeds and individual-feed views.
- Saving creates no duplicate and preserves RSS provenance and feed membership.
- Pagination, ownership, error feedback, and existing bookmark workflows remain correct.
- Historical migration limitations are disclosed before release.

## Out of scope

Unread/read tracking, feed folders, RSS-specific retention, new ingestion infrastructure, separate article storage, recommendation features, subscription-management redesign, and changes to native mobile/extension navigation.
