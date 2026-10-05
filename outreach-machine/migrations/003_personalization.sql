BEGIN;
CREATE TABLE lead_categories (
  id text PRIMARY KEY CHECK (id IN ('bank', 'broker', 'asset_manager', 'general')),
  name text NOT NULL,
  subject_template text NOT NULL,
  body_template text NOT NULL,
  signature_text text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO lead_categories (id, name, subject_template, body_template)
SELECT id, name, subject, '{{salutation}}' || E'\n\n' || '{{executionIntro}}' || E'\n\n' || paragraph || E'\n\n' ||
'Mit Gordion entwickeln wir eine spezialisierte Kontroll- und Evidenzschicht. Sie ergänzt bestehende Handels- und Abwicklungssysteme und kann innerhalb der Infrastruktur des Instituts betrieben werden, sodass sensible Orderdaten das Haus nicht verlassen müssen.' || E'\n\n' ||
'Ein möglicher Einstieg wäre ein eng abgegrenzter Pilot für eine liquide Instrumentklasse: von der Referenzdaten- und Schwellenwertprüfung bis zur vollständigen, freigabefähigen Evidenzakte.' || E'\n\n' ||
'Wären Sie offen für einen 20-minütigen Austausch dazu, wie Sie das Thema Ausführungsqualität in Ihrem Unternehmen einordnen und ob dieser Ansatz für Sie relevant sein könnte?'
FROM (VALUES
('bank', 'Banken', 'Gordion – Ausführungsqualität bei {{company}}', 'Im Bankenumfeld möchten wir insbesondere die laufende Kontrolle der Ausführungsqualität und die nachvollziehbare Bearbeitung von Abweichungen unterstützen.'),
('broker', 'Broker & Wertpapierfirmen', 'Gordion – Orderausführung und Evidenz bei {{company}}', 'Für Broker und Wertpapierfirmen möchten wir die Prüfung von Ausführungen über verschiedene Handelsplätze hinweg und die dazugehörige Evidenzaufbereitung unterstützen.'),
('asset_manager', 'Asset Manager & Vermögensverwalter', 'Gordion – Ausführungskontrolle bei {{company}}', 'Für Asset Manager und Vermögensverwalter möchten wir die strukturierte Beurteilung von Ausführungen und die nachvollziehbare Dokumentation der Prüfergebnisse unterstützen.'),
('general', 'Allgemein / noch unklar', 'Gordion – Kontroll- und Evidenzschicht', 'Unser Schwerpunkt liegt auf nachvollziehbaren Kontrollen, klaren Prüfschritten und einer strukturierten Evidenzakte.')) AS defaults(id,name,subject,paragraph);
ALTER TABLE contacts ADD COLUMN honorific text NOT NULL DEFAULT 'neutral' CHECK (honorific IN ('neutral','herr','frau'));
ALTER TABLE contacts ADD COLUMN category_id text NOT NULL DEFAULT 'general' REFERENCES lead_categories(id);
ALTER TABLE contacts ADD COLUMN execution_intro text NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN intro_source_url text;
ALTER TABLE contacts ADD COLUMN intro_verified_at timestamptz;
ALTER TABLE contacts ADD COLUMN is_test_data boolean NOT NULL DEFAULT false;
UPDATE contacts ct SET is_test_data = true FROM companies co WHERE co.id=ct.company_id AND (co.name ILIKE '%Testdaten%' OR co.domain::text LIKE '%.example' OR co.domain::text LIKE '%.test');
ALTER TABLE campaigns ADD COLUMN category_id text REFERENCES lead_categories(id);
ALTER TABLE messages ADD COLUMN personalization_fallbacks jsonb NOT NULL DEFAULT '[]';
INSERT INTO schema_migrations(filename) VALUES ('003_personalization.sql');
COMMIT;
