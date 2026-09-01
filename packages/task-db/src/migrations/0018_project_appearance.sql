-- Per-project identity: an accent color carried into every surface that shows
-- the project, and the repository's own favicon inlined as a data URL.
-- Both are nullable so already-registered projects migrate without a backfill;
-- the renderer derives an accent from the name until one is stored.
ALTER TABLE projects ADD COLUMN color text;
ALTER TABLE projects ADD COLUMN icon_data_url text;
