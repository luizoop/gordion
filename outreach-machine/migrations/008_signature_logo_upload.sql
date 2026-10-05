BEGIN;
CREATE TABLE signature_logo_assets (
  sha256 char(64) PRIMARY KEY CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER signature_logo_asset_immutable BEFORE UPDATE OR DELETE ON signature_logo_assets
  FOR EACH ROW EXECUTE FUNCTION protect_sender_signature();
-- Keep the selected logo even when embedding is temporarily disabled.
ALTER TABLE sender_settings ADD COLUMN selected_logo_sha256 char(64);
UPDATE sender_settings s SET selected_logo_sha256=v.logo_sha256
  FROM sender_signature_versions v WHERE v.id=s.signature_version_id;
INSERT INTO schema_migrations(filename) VALUES('008_signature_logo_upload.sql');
COMMIT;
