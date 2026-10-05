BEGIN;

-- Legal entities may share a domain. Existing values remain intact.
DROP INDEX companies_domain_unique;
CREATE INDEX companies_domain_idx ON companies(domain);
CREATE TABLE company_domains (
  company_id uuid NOT NULL REFERENCES companies(id), domain citext NOT NULL,
  source_url text, checked_at timestamptz, PRIMARY KEY(company_id, domain)
);
INSERT INTO company_domains SELECT id, domain, website, researched_at FROM companies WHERE domain IS NOT NULL;
ALTER TABLE companies ADD COLUMN lei text;
CREATE UNIQUE INDEX companies_lei_unique ON companies(lei) WHERE lei IS NOT NULL;
ALTER TABLE companies ADD COLUMN category_id text NOT NULL DEFAULT 'general' REFERENCES lead_categories(id);
ALTER TABLE companies ADD COLUMN suitability text NOT NULL DEFAULT 'unverified' CHECK(suitability IN ('unverified','eligible','conflict','excluded'));
ALTER TABLE companies ADD COLUMN suitability_evidence jsonb NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN research_status text NOT NULL DEFAULT 'pending';
ALTER TABLE companies ADD COLUMN prior_contact_at timestamptz;
ALTER TABLE companies ADD COLUMN prior_contact_reference text;
ALTER TABLE contacts ADD COLUMN language text CHECK(language IN ('de','en'));
ALTER TABLE contacts ADD COLUMN contact_kind text NOT NULL DEFAULT 'unverified' CHECK(contact_kind IN ('unverified','personal','functional'));
ALTER TABLE contacts ADD COLUMN source_quality integer NOT NULL DEFAULT 0 CHECK(source_quality BETWEEN 0 AND 100);
ALTER TABLE contacts ADD COLUMN dns_checked_at timestamptz;
ALTER TABLE contacts ADD COLUMN dns_valid boolean NOT NULL DEFAULT false;
CREATE TABLE register_identities (
  source text NOT NULL, register_id text NOT NULL, country_code char(2) NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id), office_type text NOT NULL,
  status text NOT NULL, raw_data jsonb NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source, register_id, country_code)
);
CREATE TABLE company_relationships (
  company_id uuid NOT NULL REFERENCES companies(id), related_company_id uuid NOT NULL REFERENCES companies(id),
  relationship text NOT NULL, source_url text NOT NULL,
  PRIMARY KEY(company_id, related_company_id, relationship)
);
CREATE TABLE research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('register','enrichment','seed')),
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
  cursor jsonb NOT NULL DEFAULT '{}', counts jsonb NOT NULL DEFAULT '{}', error text,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE UNIQUE INDEX research_one_run ON research_runs(kind) WHERE status='running';
CREATE TABLE research_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid REFERENCES companies(id),
  run_id uuid REFERENCES research_runs(id), source_url text NOT NULL, source_kind text NOT NULL,
  content_sha256 text NOT NULL, facts jsonb NOT NULL DEFAULT '{}', excerpt text NOT NULL DEFAULT '',
  checked_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id, source_url, content_sha256)
);
CREATE TABLE company_activities (
  company_id uuid NOT NULL REFERENCES companies(id), source text NOT NULL, activity_id text NOT NULL,
  activity_name text NOT NULL, status text NOT NULL, evidence_id uuid REFERENCES research_evidence(id),
  PRIMARY KEY(company_id, source, activity_id)
);
CREATE TABLE contact_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  email citext NOT NULL, role text, kind text NOT NULL, evidence_id uuid NOT NULL REFERENCES research_evidence(id),
  checked_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,email,evidence_id)
);
CREATE TABLE research_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL UNIQUE REFERENCES companies(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0, due_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, last_error text
);
CREATE TABLE research_daily_usage (
  day date PRIMARY KEY, companies integer NOT NULL DEFAULT 0, pages integer NOT NULL DEFAULT 0
);
CREATE TABLE research_domain_access (domain text PRIMARY KEY, next_at timestamptz NOT NULL);

CREATE TABLE regulatory_snippets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), language text NOT NULL CHECK(language IN ('de','en')),
  version integer NOT NULL, body text NOT NULL, source_url text NOT NULL,
  applies_from date NOT NULL, approved_by text, approved_at timestamptz,
  UNIQUE(language,version)
);
INSERT INTO regulatory_snippets(language,version,body,source_url,applies_from) VALUES
('de',1,'Die Delegierte Verordnung (EU) 2026/825 gilt ab dem 12. Februar 2028. Ob und in welchem Umfang sie für Ihr Unternehmen einschlägig ist, muss anhand Ihrer konkreten Tätigkeiten geprüft werden.','https://eur-lex.europa.eu/eli/reg_del/2026/825/oj','2028-02-12'),
('en',1,'Delegated Regulation (EU) 2026/825 applies from 12 February 2028. Whether and to what extent it is relevant to your company needs to be assessed against your specific activities.','https://eur-lex.europa.eu/eli/reg_del/2026/825/oj','2028-02-12');
CREATE TABLE template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category_id text NOT NULL REFERENCES lead_categories(id),
  language text NOT NULL CHECK(language IN ('de','en')), step integer NOT NULL CHECK(step IN (0,1)),
  version integer NOT NULL CHECK(version>0), subject text NOT NULL, body text NOT NULL,
  signature text NOT NULL DEFAULT '', use_logo boolean NOT NULL DEFAULT true, logo_sha256 text,
  regulatory_snippet_id uuid REFERENCES regulatory_snippets(id),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','retired')),
  approved_at timestamptz, approved_by text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(category_id,language,step,version)
);
CREATE UNIQUE INDEX template_one_approved ON template_versions(category_id,language,step) WHERE status='approved';
CREATE TABLE country_send_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), country_code char(2) NOT NULL, version integer NOT NULL,
  basis text NOT NULL CHECK(basis IN ('consent','reviewed_customer_exception','own_test_address')),
  prerequisites text NOT NULL, reference text NOT NULL, reviewed_by text, reviewed_at timestamptz,
  valid_until timestamptz NOT NULL, enabled boolean NOT NULL DEFAULT false,
  UNIQUE(country_code,basis,version), CHECK(NOT enabled OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
);
CREATE TABLE autopilot_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL DEFAULT 1,
  mode text NOT NULL DEFAULT 'simulator' CHECK(mode IN ('simulator','shadow','live')),
  paused boolean NOT NULL DEFAULT true, pause_kind text NOT NULL DEFAULT 'manual', pause_reason text NOT NULL DEFAULT 'Not activated',
  research_enabled boolean NOT NULL DEFAULT false, mailbox_connection_id uuid REFERENCES mailbox_connections(id),
  daily_target integer NOT NULL DEFAULT 45 CHECK(daily_target BETWEEN 1 AND 50),
  pilot_limit integer NOT NULL DEFAULT 10 CHECK(pilot_limit BETWEEN 1 AND 50),
  minimum_gap_minutes integer NOT NULL DEFAULT 8 CHECK(minimum_gap_minutes>=8),
  last_send_start timestamptz, last_category text, startup_reconciled_at timestamptz,
  seed_reconciled_at timestamptz, seed_reference text, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO autopilot_config(singleton) VALUES(true);
CREATE TABLE autopilot_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), config_version integer NOT NULL,
  action text NOT NULL, actor text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operational_checks (
  name text PRIMARY KEY, passed_at timestamptz NOT NULL, valid_until timestamptz NOT NULL,
  reference text NOT NULL, verified_by text NOT NULL
);
CREATE TABLE autopilot_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dedupe_key text NOT NULL,
  company_id uuid REFERENCES companies(id), message_id uuid REFERENCES messages(id),
  code text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), resolved_by text
);
CREATE UNIQUE INDEX exception_open_key ON autopilot_exceptions(dedupe_key) WHERE status='open';
CREATE TABLE worker_heartbeats (worker text PRIMARY KEY, last_success_at timestamptz, last_error text, updated_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE campaigns ADD COLUMN autopilot boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN template_version_id uuid REFERENCES template_versions(id);
ALTER TABLE messages ADD COLUMN country_rule_id uuid REFERENCES country_send_rules(id);
ALTER TABLE messages ADD COLUMN snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE messages ADD COLUMN parent_message_id uuid REFERENCES messages(id);
ALTER TABLE enrollments ADD COLUMN followup_template_id uuid REFERENCES template_versions(id);
CREATE TABLE company_outreach_history (
  company_id uuid PRIMARY KEY REFERENCES companies(id), initial_message_id uuid UNIQUE REFERENCES messages(id),
  reference text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
-- History never disappears when a campaign/enrollment is cancelled.
INSERT INTO company_outreach_history(company_id,initial_message_id,reference)
SELECT DISTINCT ON(e.company_id) e.company_id,m.id,'existing message history' FROM messages m JOIN enrollments e ON e.id=m.enrollment_id
WHERE m.message_kind='initial' AND m.status IN ('send_accepted','sent_confirmed','reconciliation_required') ORDER BY e.company_id,m.created_at;
CREATE TABLE provider_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mailbox_connection_id uuid NOT NULL REFERENCES mailbox_connections(id),
  message_id uuid NOT NULL REFERENCES messages(id), operation text NOT NULL CHECK(operation IN ('create_draft','create_reply','patch_reply','send')),
  status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','succeeded','failed','uncertain','reconciled')),
  correlation_id uuid NOT NULL, provider_id text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, error_code text
);
CREATE UNIQUE INDEX provider_operation_open ON provider_operations(message_id,operation) WHERE status IN ('started','uncertain');
CREATE TABLE mailbox_send_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mailbox_connection_id uuid NOT NULL REFERENCES mailbox_connections(id),
  message_id uuid UNIQUE REFERENCES messages(id), provider_id text,
  state text NOT NULL CHECK(state IN ('reserved','uncertain','accepted','confirmed','external','released')),
  reserved_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
  UNIQUE(mailbox_connection_id,provider_id)
);
CREATE INDEX mailbox_ledger_time ON mailbox_send_ledger(mailbox_connection_id,reserved_at,sent_at);
ALTER TABLE graph_sync_cursors DROP CONSTRAINT graph_sync_cursors_folder_name_check;
ALTER TABLE graph_sync_cursors ADD COLUMN next_link text;
ALTER TABLE graph_sync_cursors ADD COLUMN complete boolean NOT NULL DEFAULT false;
CREATE TABLE mailbox_folders (
  mailbox_connection_id uuid NOT NULL REFERENCES mailbox_connections(id), provider_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('inbound','sent','drafts','ignored')), checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mailbox_connection_id,provider_id)
);
ALTER TABLE inbound_messages ADD COLUMN hard_bounce boolean NOT NULL DEFAULT false;
ALTER TABLE inbound_messages ADD COLUMN evidence jsonb NOT NULL DEFAULT '{}';

CREATE FUNCTION protect_autopilot_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.template_version_id IS NOT NULL AND
    ROW(NEW.recipient_address,NEW.final_subject,NEW.final_body_text,NEW.content_sha256,NEW.logo_sha256,NEW.snapshot,NEW.template_version_id,NEW.country_rule_id,NEW.authorization_id,NEW.parent_message_id)
    IS DISTINCT FROM ROW(OLD.recipient_address,OLD.final_subject,OLD.final_body_text,OLD.content_sha256,OLD.logo_sha256,OLD.snapshot,OLD.template_version_id,OLD.country_rule_id,OLD.authorization_id,OLD.parent_message_id) THEN
    RAISE EXCEPTION 'Autopilot snapshots are immutable; cancel and prepare a new version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_snapshot_immutable BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION protect_autopilot_snapshot();
CREATE FUNCTION protect_approved_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved','retired') AND
    (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
    RAISE EXCEPTION 'Approved template versions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_versions_immutable BEFORE UPDATE ON template_versions FOR EACH ROW EXECUTE FUNCTION protect_approved_template();
INSERT INTO schema_migrations(filename) VALUES('005_autopilot.sql');
COMMIT;
