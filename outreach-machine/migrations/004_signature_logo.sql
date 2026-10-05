BEGIN;
ALTER TABLE lead_categories ADD COLUMN use_logo boolean NOT NULL DEFAULT true;
ALTER TABLE campaigns ADD COLUMN logo_sha256 text CHECK (logo_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE messages ADD COLUMN logo_sha256 text CHECK (logo_sha256 ~ '^[a-f0-9]{64}$');
INSERT INTO schema_migrations(filename) VALUES ('004_signature_logo.sql');
COMMIT;
