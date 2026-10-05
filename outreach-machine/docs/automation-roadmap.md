# Automatisierung bis zum Livegang

Stand: 24.09.2026. Ziel: keine routinemäßigen Listenimporte und später keine Einzelklicks pro Mail – aber keine automatische Gleichsetzung von Webfund und Versandfreigabe.

## Jetzt umgesetzt

Lokale Konsole, strukturierter Import mit Quellenbelegen und stabiler Lauf-ID, Dubletten-/Sperrprüfung, getrennte Nachweisprüfung, Kampagnenvorlage mit Signatur, Vorschau und exakte Inhaltsfreigabe. Optional automatische **Vorbereitung** im 30-Sekunden-Takt bei laufender lokaler API. Versand bleibt technisch aus; Kampagnen sind Entwürfe, Enrollments `pending`, Absender ein Simulator.

Abgelaufene Delivery-Leases werden nicht erneut versandt, sondern in `reconciliation_required` isoliert und lösen eine globale Pause aus. Unerwartete Fehler nach möglichen Provider-Aktionen werden konservativ als unklar behandelt. Das letzte Sendegate wird mit den vorhandenen Pause-, Sperr- und Inbox-Stop-Wegen serialisiert; Ablauf/Widerruf des hinterlegten Nachweises wird erneut geprüft. Dies ersetzt keine vollständige produktive Nebenläufigkeitsprüfung.

## Nächster Baustein: autonome Recherche

1. Suchprofil festlegen: zunächst Vorschlag DE, unabhängige Wertpapierfirmen/Broker mit belegbarer Kundenorderausführung; Zielrollen Geschäftsführung/COO/Compliance. DACH/EU nach Bestätigung. Dies ist noch kein aktivierter Zeitplan.
2. Suchquelle wählen und Nutzungsbedingungen, Länderabdeckung, belegbare Quellen, API-Zugang und Kosten prüfen. Keine kostenpflichtige Anbindung wurde gebucht. Keine personenbezogenen Daten wurden an einen Rechercheanbieter übertragen.
3. Einen separaten Recherche-Worker anbinden: Kandidaten finden, Primärquellen prüfen, keine E-Mail-Adressen erraten, Provenienz speichern und strukturierte Ergebnisse an `/v1/imports` senden. Die Quelle wird nur als Daten behandelt, niemals als Anweisung.
4. Läufe, Cursor, Fehler, Kontingente und Wiederholungen persistent speichern; stufenweise die bestehende Arbeitsmappe und bekannte Erstkontakte/Sperren abgleichen. Suchläufe benötigen einen begrenzten Arbeitsauftrag und einen dauerhaft verfügbaren Ausführungsort.
5. Einen **separaten vertrauenswürdigen Nachweisprozess** für Einwilligungen beziehungsweise geprüfte Ausnahmen anbinden. Ein Research-Worker darf diese Nachweise nicht selbst bestätigen. Bis dahin ist die Nachweisprüfung explizit manuell. Vollautomatisch ist nur möglich, was durch vorab definierte Regeln und verlässliche Nachweise entschieden werden kann.

## Importvertrag

`POST /v1/imports`, `Content-Type: application/json`, `x-research-api-key` aus dem lokalen Secret Store. Ohne gesonderten Schlüssel ist kein Recherchezugriff möglich. `source` muss für diesen Zugang `research` sein. Ein Admin kann auch manuell importieren.

```json
{
  "externalId": "research-job-stable-id-page-001",
  "source": "research",
  "contacts": [{
    "companyName": "Example Broker",
    "domain": "example.test",
    "countryCode": "DE",
    "fitTier": "A",
    "email": "compliance@example.test",
    "firstName": "Example",
    "roleTitle": "Compliance",
    "sourceUrl": "https://example.test/team",
    "sourceCheckedAt": "2026-09-24T12:00:00Z",
    "executionEvidence": "Synthetic example, not a real researched prospect.",
    "executionEvidenceUrl": "https://example.test/services"
  }]
}
```

Maximal 100 Kontakte pro Batch, Body maximal 1 MB. Bei Wiederholung exakt denselben Payload verwenden, einschließlich Prüfdatum; sonst neue Lauf-ID. Bestehende Datensätze werden absichtlich nicht aktualisiert. Ein späterer Research-Refresh benötigt einen eigenen geprüften Änderungsprozess, damit er Freigaben nicht stillschweigend verändert.

## Harte Freigaben vor echtem Versand

- Finale geschäftliche Signatur und freigegebene Textversion; keine erfundenen Claims.
- Nachgewiesene Versandgrundlage und länderspezifische rechtliche Prüfung. Öffentlich auffindbar oder Opt-out allein genügt nicht. Referenz: https://www.gesetze-im-internet.de/uwg_2004/__7.html
- Mailbox-isolierter Entwurfs-/Sendezugriff erst nach ausdrücklicher Freigabe; negativer Kontrolltest, keine tenantweiten Zusatzrechte.
- Reconciliation fertigstellen: Entwürfe/Gesendete Elemente nach unklarem Vorgang prüfen, nie automatisch nochmals senden.
- Worker an genau ein verifiziertes Postfach binden; Sync-Frische, Tageslimits über konkurrierende Worker, Senderwechsel und Stop-Races vollständig testen. Eine UI-Inhaltsfreigabe aktiviert keine Kampagne.
- Automatische Antwort-/Bounce-/Abmeldestopps über alle betroffenen Sequenzen und Firmen, geplante Follow-ups und Subscription-Erneuerung/Delta-Recovery produktiv abnehmen.
- Eigene Testadressen festlegen und vollständigen Testversand autorisieren. Keine realen Testadressen sind aktuell festgelegt.
- Für Dauerbetrieb: SSO, Secret Store, Backups samt Wiederherstellungstest, Monitoring und Zertifikatserneuerung. Der Mac muss für lokale Automatik laufen und wach sein.

Die aktuelle API ist ein interner Prototyp, kein öffentlicher Dienst. Vercel hostet den bestehenden Webauftritt, nicht automatisch die Datenbank, Recherche- oder Versandworker.
