# Architektur des Outreach-Funnels

Stand: 24. September 2026

## Umsetzungsstand

Dieses Dokument beschreibt das Zielbild. Implementiert sind Backend-Schema, interne API, Simulator, grundlegende Queue-/Freigabelogik, eine lokale Review-Oberfläche mit JSON-Import, automatische regelgebundene Nachrichtenvorbereitung sowie ein standardmäßig schreibgeschützter Graph-Adapter mit Zertifikatanmeldung. Autonome Recherche, produktiver Versand-/Follow-up-Scheduler, automatische Subscription-Erneuerung und ein vollständiger Reconciliation-Worker sind noch nicht fertig. Die unten genannten Betriebs- und Doppelsendgarantien sind vor Produktivversand gesondert abzunehmen; sie sind nicht durch die bisherigen Unit-Tests nachgewiesen. Details: `automation-roadmap.md`.

## Zielbild

Die Maschine ist eine interne Kontrollanwendung, kein Massenmailer. Sie hält Recherche, Zulässigkeitsprüfung, Personalisierung, Freigabe, Versand, Antworterkennung und Sperren in einem nachvollziehbaren Zustandsmodell zusammen. Der öffentliche Gordion-Webauftritt bleibt unabhängig.

```text
Recherche/Import
      |
      v
Firma + Kontakt --(Prüfung)--> zulässig / zurückgestellt / gesperrt
      |
      v
Kampagnenaufnahme --> personalisierte Vorschau --> Freigabe
      |                                        |
      |                                 unveränderlicher Audit-Snapshot
      v                                        |
PostgreSQL-Queue --(Safety Gate + Lease)--------+
      |
      v
Microsoft-Entwurf --> expliziter Sendeschritt --> 202 angenommen
      |                                              |
      v                                              v
Sent-Items-Abgleich                           nicht als Zustellung werten
      |
      v
Webhook + Delta-Abgleich --> Antwort/Bounce/Abmeldung --> Sequenz sofort stoppen
```

## Laufzeitkomponenten

1. **Interne API** nimmt Importe, Prüfungen und Freigaben an. Sie versendet nie direkt.
2. **PostgreSQL** ist Quelle der Wahrheit für Leads, Kampagnen, finalen Mailtext, Queue, Sperren und Audit-Ereignisse.
3. **Delivery Worker** least jeweils wenige fällige Nachrichten mit `FOR UPDATE SKIP LOCKED`. Direkt vor jeder Provider-Aktion prüft er Kampagnenstatus, Sperrlisten, Antworten, Freigabe, Platzhalter, Geschäftszeit und Tageslimits erneut.
4. **Mail Provider** ist austauschbar. Der Simulator ist Standard; Microsoft Graph ist nur bei expliziter Konfiguration aktiv.
5. **Inbox Sync** kombiniert Graph-Webhooks (schnell) mit einem Delta-Cursor (vollständig/reparierbar). Webhooks enthalten keine vertrauenswürdigen Arbeitsanweisungen, sondern lösen nur einen kontrollierten Sync aus.
6. **Subscription Maintainer** erneuert Graph-Abonnements vor Ablauf. Ein abgelaufenes Abo pausiert Follow-ups, aber verliert dank Delta-Sync keine dauerhafte Zustandsänderung.

## Funnel-Zustände

### Firma/Kontakt

`needs_review -> eligible | rejected | suppressed`

Freigabe verlangt mindestens Quelle, Prüfdatum, Zielrolle, nachweisbare Relevanz und eine dokumentierte Versandgrundlage. Öffentlich auffindbar ist kein automatischer Freigabegrund.

### Kampagne

`draft -> paused -> active -> completed | archived`

`active` ist nur erlaubt, wenn Absender, Vorlagenversion, Limits, Zeitzone, Zielgruppe und Rechtsprüfung fixiert sind. Der globale Pause-Schalter hat Vorrang.

### Enrollment

`pending -> active -> replied | bounced | unsubscribed | booked | completed | paused`

Alle terminalen Antwort-/Sperrzustände annullieren noch nicht gesendete Schritte derselben Firma und Adresse.

### Nachricht

`planned -> rendered -> awaiting_approval -> approved -> leased -> draft_created -> send_accepted -> sent_confirmed`

Fehlerpfade:

- `cancelled`: Gate schlägt dauerhaft fehl oder Enrollment wurde gestoppt.
- `failed`: sicher fehlgeschlagen und begrenzt wiederholbar.
- `reconciliation_required`: Ergebnis einer nicht-idempotenten Graph-Operation ist unklar. Kein automatischer erneuter Versand.

`send_accepted` bedeutet nur, dass Microsoft die Verarbeitung angenommen hat. `sent_confirmed` bedeutet, dass die Kopie mit derselben unveränderlichen ID in „Gesendete Elemente“ gefunden wurde. Keiner der Zustände behauptet Zustellung beim Empfänger.

## Doppelsend-Schutz

- Eine Datenbank-Unique-Constraint erlaubt pro Enrollment und Sequenzschritt nur eine Nachricht.
- Jede Nachricht besitzt einen unveränderlichen `idempotency_key`, der als `x-gordion-message-id` im Entwurf gespeichert wird.
- Queue-Jobs werden mit kurzer Lease exklusiv verarbeitet. Abgelaufene Delivery-Leases werden jetzt in `reconciliation_required` gesetzt und pausieren global. Ein Integrationstest prüft, dass keine erneute Freigabe erfolgt. Vollständige Prozessabbruch-/Nebenläufigkeitstests und automatische Klärung bleiben vor Livebetrieb offen.
- Graph-Entwürfe werden mit `Prefer: IdType="ImmutableId"` erstellt. Die ID bleibt beim Verschieben in „Gesendete Elemente“ stabil.
- Ein als unklar erkannter Timeout beim Erstellen oder Senden erzeugt `reconciliation_required`. Geplant: Ein Reconciliation-Worker scannt Entwürfe/Gesendete Elemente nach ID beziehungsweise Gordion-Header, bevor ein Mensch einen Wiederholungsversuch freigeben kann. Dieser automatisierte Scan ist noch nicht implementiert.
- `send` wird nicht blind wiederholt. Bei `429` respektiert der Client `Retry-After`; Wiederholungen sind nur für sichere Leseoperationen automatisch.

## Follow-ups

Follow-ups werden in Arbeitstagen berechnet. Vor dem Rendering prüft der Scheduler den letzten bestätigten Schritt und alle Stoppsignale. Für denselben Outlook-Thread wird nach dem Pilot ein `createReplyAll`-Entwurf auf Basis der gesendeten Ursprungsnachricht verwendet; Empfänger und Inhalt werden anschließend vollständig geprüft, bevor der Entwurf sendbar wird. Diese Provider-Eigenschaft ist Teil des verpflichtenden Integrationstests und wird nicht vorausgesetzt.

## Antwort-, Bounce- und Abmeldeerkennung

- Webhook: `created`-Ereignisse auf dem Inbox-Ordner; `clientState` wird zeitkonstant geprüft und der HTTP-Request innerhalb von drei Sekunden bestätigt.
- Delta: pro Ordner persistierter undurchsichtiger `@odata.deltaLink`; alle Seiten bis `@odata.deltaLink` werden verarbeitet.
- Matching: zuerst `conversationId`/`inReplyTo`, dann bekannte Empfängeradresse plus Zeitfenster. Unsichere Treffer gehen in manuelle Prüfung.
- Abwesenheit: pausiert das Enrollment, setzt aber keine positive Antwort.
- Bounce: NDR-Absender und strukturierte Zustellberichte werden als technisches Ereignis gespeichert; Adresse wird bis zur Prüfung gesperrt.
- Abmeldung: eindeutige Abmeldeabsicht setzt eine globale Adresssperre. Freitextklassifikation darf niemals Empfänger oder Berechtigungen ändern.

## Daten- und Sicherheitsgrenzen

- Keine Orderdaten; nur B2B-Kontakt-, Recherche- und Kommunikationsdaten.
- Secrets ausschließlich im Secret Store der Laufzeit. `.env` dient nur lokal und ist ignoriert.
- Produktiv bevorzugt Zertifikat oder Workload Identity statt langlebigem Client Secret.
- Interne API hinter SSO/privatem Netzwerk; der API-Key im Fundament ist nur ein lokaler Bootstrap.
- E-Mail-Inhalte sind untrusted input. HTML wird nie als aktiver Inhalt in einer Admin-Oberfläche ausgeführt.
- Audit-Ereignisse sind append-only; finale Nachrichtensnapshots werden nicht nachträglich überschrieben.
- Aufbewahrungs- und Löschfristen werden vor Produktionsstart festgelegt.

## Betriebsregeln

- Startwerte: 10 neue Kontakte und 15 Gesamtnachrichten pro Arbeitstag, `Europe/Berlin`, Montag bis Freitag, 09:00–16:30 Uhr.
- Die Tageszählung umfasst Erstkontakt und Follow-ups und basiert auf tatsächlich angenommenen Sendeschritten.
- C-Leads bleiben außerhalb aktiver Kampagnen.
- Überhöhte Bounce-/Fehlerrate, Graph-Authentifizierungsfehler, abgelaufene Inbox-Synchronisation oder eine unklare Sendetransaktion aktivieren den globalen Pause-Zustand.
- Healthchecks unterscheiden Prozessgesundheit, Datenbankbereitschaft, Graph-Authentifizierung und Sync-Frische.

## Ausbaureihenfolge

1. Fundament, Schema, Simulator, Gates und Audit (dieser Stand).
2. Bestehende Arbeitsmappe mit explizitem Feldmapping importieren; bekannte Sends und Sperren zuerst abgleichen.
3. Interne Review-Oberfläche für Leadprüfung, Vorschau und Einzel-/Batchfreigabe.
4. Graph-Verbindung im Testpostfach: Entwurf, Versand, Antwort, NDR, Abmeldung, Timeout und Worker-Neustart.
5. Pilot mit wenigen ausdrücklich freigegebenen Empfängern; erst danach zeitgesteuerte Aktivierung.
