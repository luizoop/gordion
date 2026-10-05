BEGIN;
ALTER TABLE contacts ADD COLUMN intro_language text CHECK(intro_language IN ('de','en'));
ALTER TABLE outreach_authorizations ADD COLUMN country_rule_id uuid REFERENCES country_send_rules(id);
ALTER TABLE outreach_authorizations ADD COLUMN prerequisites_verified_at timestamptz;
ALTER TABLE outreach_authorizations ADD COLUMN prerequisites_verified_by text;
ALTER TABLE autopilot_config ADD COLUMN provider_retry_after timestamptz;
CREATE TABLE backup_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),path text NOT NULL,sha256 text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION protect_country_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'enabled') IS DISTINCT FROM (to_jsonb(OLD)-'enabled') THEN RAISE EXCEPTION 'Create a new country rule version'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER country_rules_immutable BEFORE UPDATE ON country_send_rules FOR EACH ROW EXECUTE FUNCTION protect_country_rule();
INSERT INTO schema_migrations(filename) VALUES('006_autopilot_runtime.sql');
COMMIT;
