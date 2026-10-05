BEGIN;
CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('manual', 'research')),
  external_id text NOT NULL UNIQUE,
  payload_sha256 text NOT NULL,
  imported_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  blocked_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE import_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES import_batches(id),
  contact_id uuid REFERENCES contacts(id),
  email citext NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('imported', 'duplicate', 'blocked')),
  reason text,
  source_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Imported claims cannot create permission to send. Only the admin workflow can
-- attest evidence, separately from the untrusted research/import input.
CREATE TABLE outreach_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id),
  basis text NOT NULL CHECK (basis IN ('consent', 'reviewed_customer_exception', 'own_test_address')),
  evidence_reference text NOT NULL,
  valid_until timestamptz NOT NULL,
  verified_by text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
ALTER TABLE campaigns ADD COLUMN preparation_mode text NOT NULL DEFAULT 'manual'
  CHECK (preparation_mode IN ('manual', 'automatic'));
ALTER TABLE campaigns ADD COLUMN target_countries text[] NOT NULL DEFAULT ARRAY['DE'];
ALTER TABLE campaigns ADD COLUMN signature_text text NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN automation_approved_at timestamptz;
ALTER TABLE campaigns ADD COLUMN automation_approved_by text;
ALTER TABLE messages ADD COLUMN authorization_id uuid REFERENCES outreach_authorizations(id);
INSERT INTO schema_migrations (filename) VALUES ('002_console_import.sql');
COMMIT;
