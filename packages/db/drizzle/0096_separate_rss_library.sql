ALTER TABLE `bookmarks` ADD `inLibrary` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- Backfill: existing RSS-imported bookmarks were never explicitly saved to
-- the library. There is no reliable historical signal for manual saves (the
-- `lastSavedAt` backfill in migration 0092 set it equal to `createdAt` for
-- every row, and RSS creation can't be distinguished from a manual re-save
-- by timestamps alone), so previously manually-saved RSS articles move off
-- Home with other imports. They remain in RSS and can be re-saved.
UPDATE `bookmarks` SET `inLibrary` = 0 WHERE `source` = 'rss';
