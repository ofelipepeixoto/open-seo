ALTER TABLE `reports` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `approved_content_hash` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `approved_by_user_id` text;
--> statement-breakpoint
UPDATE "reports" SET "share_token" = NULL, "shared_at" = NULL;
