BEGIN;
CREATE TABLE sender_signature_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version integer NOT NULL UNIQUE CHECK(version>0),
  signature_text text NOT NULL CHECK(length(btrim(signature_text)) BETWEEN 8 AND 4000),
  use_logo boolean NOT NULL, logo_sha256 char(64), created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((use_logo AND logo_sha256 IS NOT NULL) OR (NOT use_logo AND logo_sha256 IS NULL))
);
CREATE TABLE sender_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision integer NOT NULL DEFAULT 0,
  signature_version_id uuid REFERENCES sender_signature_versions(id)
);
INSERT INTO sender_settings(singleton) VALUES(true);
-- Preserve an existing unanimous category signature. Conflicting/partial setups
-- are deliberately not guessed; the operator must choose one centrally.
-- Hash of the existing bundled Gordion PNG, not an external image URL.
INSERT INTO sender_signature_versions(version,signature_text,use_logo,logo_sha256,created_by)
SELECT 1,min(signature_text),bool_and(use_logo),
  CASE WHEN bool_and(use_logo) THEN '1cf729b402aba491c9e287056cec05927d0c2fd291d625ca0ddf4ef98d019445' ELSE NULL END,
  'migration:unanimous-existing-categories'
FROM lead_categories
HAVING count(*)=4 AND count(DISTINCT signature_text)=1 AND min(length(btrim(signature_text)))>=8
  AND count(DISTINCT use_logo)=1 AND bool_and(signature_text !~ '(\{\{|\}\}|\$\{)');
UPDATE sender_settings SET signature_version_id=(SELECT id FROM sender_signature_versions WHERE version=1),
  revision=CASE WHEN EXISTS(SELECT 1 FROM sender_signature_versions) THEN 1 ELSE 0 END;
ALTER TABLE messages ADD COLUMN sender_signature_version_id uuid REFERENCES sender_signature_versions(id);
CREATE FUNCTION protect_sender_signature() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Sender signature versions are immutable'; END $$;
CREATE TRIGGER sender_signature_immutable BEFORE UPDATE OR DELETE ON sender_signature_versions
  FOR EACH ROW EXECUTE FUNCTION protect_sender_signature();
CREATE FUNCTION protect_message_sender_signature() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sender_signature_version_id IS NOT NULL AND ROW(NEW.sender_signature_version_id,NEW.final_body_text,NEW.logo_sha256)
    IS DISTINCT FROM ROW(OLD.sender_signature_version_id,OLD.final_body_text,OLD.logo_sha256) THEN
    RAISE EXCEPTION 'Prepared sender signature is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_sender_signature_immutable BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION protect_message_sender_signature();
INSERT INTO schema_migrations(filename) VALUES('007_shared_sender_signature.sql');
COMMIT;
