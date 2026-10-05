BEGIN;
-- Existing approved content keeps its stricter targeting policy and snapshots.
ALTER TABLE template_versions ADD COLUMN targeting_mode text NOT NULL DEFAULT 'verified_activity'
  CHECK(targeting_mode IN ('verified_activity','category_only'));
INSERT INTO schema_migrations(filename) VALUES('009_template_targeting.sql');
COMMIT;
