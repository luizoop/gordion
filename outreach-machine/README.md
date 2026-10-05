# Gordion Outreach Machine

Interne Outreach-Anwendung für den kontrollierten B2B-Funnel über Outlook/Microsoft Graph. Sie ist bewusst vom öffentlichen statischen Webauftritt getrennt.

## Sicherheitszustand beim Start

- `MAIL_PROVIDER=simulated`: alle Aktionen bleiben lokal.
- `LIVE_SEND_ENABLED=false`: selbst mit gültigen Graph-Zugangsdaten ist `send` gesperrt.
- Kampagnen beginnen als `draft` und Kontakte als `needs_review`.
- Eine Nachricht kann nur nach dokumentierter Freigabe, außerhalb jeder Sperre und innerhalb aller Limits geleast werden.

## Lokal starten

Für einen sicheren lokalen Testbetrieb reicht bei laufendem Docker Desktop:

```bash
npm ci
npm run local:start
```

Dieser Start benötigt weder Merge noch Microsoft-Zugangsdaten. Er startet die lokale Datenbank, wendet fehlende Migrationen an und startet die API ausschließlich auf `127.0.0.1:4310`. Vorhandene Daten bleiben erhalten. Der Simulator und die Versandsperre werden unabhängig von Umgebungswerten erzwungen; Worker und Microsoft-Synchronisierung starten nicht. Ein zufälliger lokaler API-Schlüssel bleibt in der Git-ignorierten Datei `.outreach-data/local-admin-api-key` (Dateirechte `600`) und wird nicht ausgegeben.

Die lokale Bedienoberfläche liegt auf `http://127.0.0.1:4310/`: Kontakte, Quellenprüfung, Sperren, Kampagnen, Vorschauen, Freigaben und Importverlauf. `npm run local:status` zeigt den geschützten Systemstatus. Zum Stoppen der API `Ctrl+C`, für die Datenbank `docker compose stop postgres` verwenden (kein Löschen des Datenvolumes).

Die lokale Oberfläche meldet den Browser über eine kurzlebige HttpOnly-/SameSite-Session an. Dies ist bewusst **kein Mehrbenutzer- oder Produktionslogin**: Auf diesem Rechner angemeldete Personen können die Konsole öffnen. Sie funktioniert ausschließlich mit `LOCAL_DASHBOARD_ENABLED=true`, Loopback-Bindung und Simulator ohne Liveversand. Host-/Origin-Prüfung schützt gegen fremde Webseiten und DNS-Rebinding. Nicht per Tunnel oder Reverse Proxy veröffentlichen. Produktiv sind SSO, individuelle Rollen und Nutzer-Audit noch erforderlich.

## Automatische Recherche, Import und Vorbereitung

- **Implementiert:** `POST /v1/imports` für strukturierte Recherche-Ergebnisse. Ein separater `RESEARCH_IMPORT_API_KEY` darf mit dem Header `x-research-api-key` nur diesen Eingang nutzen, keine Kontaktdaten lesen, Freigaben erteilen oder versenden. Dieser Schlüssel wird noch nicht automatisch erstellt oder an einen Dienst weitergegeben.
- **Dubletten:** gleiche Lauf-ID plus gleicher Inhalt ist idempotent; geänderter Inhalt mit gleicher ID erzeugt einen Konflikt. Bestehende Kontakte werden nicht überschrieben. Aktive Sperren bleiben erhalten.
- **Prüfung:** Importe landen in `needs_review`. Quelle und fachliche Eignung sind keine Versandgrundlage. Nachweise werden getrennt hinterlegt; das Importschema lehnt Freigabe- und Berechtigungsfelder ab.
- **Automatische Vorbereitung:** Einmal je Kampagne aktivierbar. Alle 30 Sekunden verarbeitet die lokale API bereits geprüfte A-/B-Kontakte im ausgewählten Land, mit höchstens 90 Tage alter Quelle und gültigem Nachweis. Eine freigegebene Vorlage plus Signatur werden eingefroren und nachvollziehbar freigegeben. Pro Firma wird keine zweite bestehende Sequenz angelegt. Unpassende Kontakte bleiben liegen. **Dies startet keinen Versand.**
- **Noch nicht implementiert:** autonome Websuche/Rechercheanbieter, wiederkehrende Suchläufe, vertrauenswürdiger automatischer Abgleich von Einwilligungsnachweisen und produktiver Versand-Scheduler/Follow-ups. Die vorhandene XLSX-Arbeitsmappe wurde nicht importiert; der aktuelle Eingang unterstützt JSON.

Details und nächste Freigaben: [automation-roadmap.md](docs/automation-roadmap.md).

Für die manuelle Konfiguration (bestehende lokale Dateien **nicht überschreiben**, einen eigenen zufälligen `ADMIN_API_KEY` setzen):

```bash
cp .env.example .env
cp config/microsoft-365.example.json config/microsoft-365.json
docker compose up -d postgres
npm install
npm run db:migrate
npm test
npm run dev
```

Der API-Prozess läuft standardmäßig auf `http://127.0.0.1:4310`. Der Worker ist ein separater Prozess (`npm run dev:worker`), damit API-Neustarts keine Versandjobs duplizieren.

`npm run smoke:worker` darf nur auf einer separaten, entbehrlichen lokalen Datenbank mit dem Namenssuffix `_test` laufen. Er verändert den globalen Pausenzustand und legt synthetische Datensätze an. Die CI nutzt dafür einen frischen PostgreSQL-Service und ausschließlich den Simulator; keine Microsoft-Anmeldung oder Secrets sind nötig.

`npm run smoke:console` hat denselben Datenbankschutz und prüft Importberechtigungen, CSRF/Host-Schutz, Dubletten, Nachweisprüfung, manuelle und automatische Vorbereitung, Sperren und unsichere abgelaufene Versand-Leases. Testdaten bleiben ausschließlich in der separaten Testdatenbank.

## Verzeichnisstruktur

- `docs/architecture.md`: Systemgrenzen, Funnel und Fehlermodelle
- `docs/microsoft-graph-setup.md`: Microsoft-Einrichtung und Berechtigungsprüfung
- `config/microsoft-365.example.json`: Vorlage; echte Konfiguration bleibt lokal und Git-ignoriert
- `migrations/`: PostgreSQL-Schema als technische Quelle der Wahrheit
- `src/domain/`: Zustände und reine Versandregeln
- `src/mail/`: Provider-Schnittstelle, Simulator und Graph-Adapter
- `src/repositories/`: transaktionale Queue- und Audit-Zugriffe
- `src/services/`: Versand- und Inbox-Orchestrierung
- `src/http/`: interne API und Graph-Webhook

## Noch bewusst nicht aktiviert

Es gibt keine echte Empfängerliste und keine Live-Kampagne. Microsoft-Zugangsdaten und konkrete Tenant-Konfiguration gehören nicht ins Repository. Die lokale Review-Oberfläche ist implementiert; dies ist weiterhin keine produktionsreife Versandmaschine. Die produktive Aktivierung ist weder über die neue Oberfläche noch durch automatische Importe möglich.

## Microsoft 365 – aktueller Einrichtungsstand

Kontotyp und IDs werden lokal in `config/microsoft-365.json` hinterlegt. Der Graph-Adapter startet zusätzlich im Modus `read_only` und blockiert Schreiboperationen unmittelbar am API-Zugriff. Eine geschäftliche Signatur bleibt offen.

`npm run graph:check` zeigt fehlende Einrichtungswerte ohne Netzwerkzugriff. Fehlt die lokale Tenant-Konfiguration, wird die Beispielvorlage mit `configured: false` angezeigt und eine Verbindung verweigert. Start-, Migrations- und Diagnosebefehle laden optionale `.env`-Werte selbst. Mit `-- --connect` führt die Diagnose nach Zertifikateinrichtung einen Lese- und Negativtest durch. Anleitung: `docs/microsoft-graph-setup.md`.
