-- The project index becomes shared rather than one copy per user.
--
-- Per-user made a scheduled rebuild impossible: 145 projects is 145 Zoho calls, and against a
-- 100-per-120-seconds limit fifteen people would take three quarters of an hour per run.
-- Nothing in it differed between users except `last_logged_at`, which is now derived from
-- `commit_logs` at read time.
--
-- Rebuilt rather than deduplicated: the index is a cache with a known source, and the next
-- refresh repopulates it within minutes.
DELETE FROM "project_indexes";

ALTER TABLE "project_indexes" DROP CONSTRAINT IF EXISTS "project_indexes_user_id_fkey";
DROP INDEX IF EXISTS "project_indexes_user_id_project_id_key";
DROP INDEX IF EXISTS "project_indexes_user_id_idx";

ALTER TABLE "project_indexes"
  DROP COLUMN "user_id",
  DROP COLUMN "last_logged_at";

CREATE UNIQUE INDEX "project_indexes_project_id_key" ON "project_indexes"("project_id");
