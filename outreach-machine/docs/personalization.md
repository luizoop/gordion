# Kategorien und automatische Personalisierung

Die lokale Konsole bietet vier feste Kategorie-IDs mit bearbeitbaren Namen und Standardmails:

- `bank`: Banken
- `broker`: Broker & Wertpapierfirmen
- `asset_manager`: Asset Manager & Vermögensverwalter
- `general`: Allgemein / noch unklar

Nicht zugeordnete Kontakte erhalten `general`; eine unbekannte explizite ID wird als Eingabefehler abgewiesen. Keine automatische Branchenvermutung aus Namen oder E-Mail-Domains. „Personalisieren“ am Kontakt erlaubt Namen, bestätigte Anrede und Kategorie zu bearbeiten. „Mailvorschau“ funktioniert ohne Kampagne oder Versandfreigabe und zeigt die verwendeten Ersatztexte. Eine Vorschau erteilt selbst keine Freigabe.

Unter „Kategorien & Vorlagen“ lassen sich Betreff und Mailtext je Kategorie speichern. Signatur und Logo werden einmal zentral für alle Vorlagen gepflegt. Neue Kampagnen übernehmen den gewählten Nachrichtentext als eigenen freigegebenen Stand und berücksichtigen ausschließlich Kontakte dieser Kategorie. Jeder neue Entwurf erhält die aktuelle zentrale Signatur; bestehende Nachrichten bleiben unverändert. Vor der Migration bestehende Kampagnen mit `category_id = NULL` behalten ihre bisherige kategorienübergreifende Auswahl. Kontakte mit noch offener Sequenz können nicht nachträglich umpersonalisiert werden.

## Platzhalter

| Variable | Quelle / Ersatz |
| --- | --- |
| `{{salutation}}` | Bestätigtes Herr/Frau + Nachname; sonst „Guten Tag Vorname Nachname,“ mit vorhandenen Namen; ohne Vorname „Guten Tag,“ |
| `{{company}}` | Firmenname; sonst „Ihrem Unternehmen“ |
| `{{executionIntro}}` | Vollständiger Mailabsatz, durch lokalen Betreiber anhand einer Quelle geprüft; sonst neutraler Gordion-Einstieg |
| `{{firstName}}` | Vorname; sonst „Team“ |
| `{{lastName}}` | Nachname; sonst „Kontaktperson“ – für Anreden stattdessen `salutation` verwenden |
| `{{role}}` | Hinterlegte Rolle; sonst „zuständige Ansprechperson“ |

Eigener Ersatz ist möglich: `{{firstName|liebes Team}}`. Bekannte Angaben haben Vorrang. Tippfehler, unbekannte Variablen, ungültige Syntax oder Platzhalter innerhalb der Kontaktwerte werden blockiert; es gibt keine rekursive Auswertung. Signaturen sind fertiger Text ohne Platzhalter. `evidence` ist aus Sicherheitsgründen ein Alias für den geprüften Einstieg, **nicht** für interne Recherchebelege. `companyWithArticle` ist ein Kompatibilitätsalias für den Firmennamen; grammatische Artikel werden nicht geraten. Texte möglichst ohne vorausgesetzten Firmenartikel formulieren.

## Import

Zusätzlich unterstützt `/v1/imports`: `lastName`, `honorific` (`neutral`, `herr`, `frau`), `categoryId`, `executionIntro`, `introSourceUrl`, `isTestData`. Die bisherigen Felder bleiben gültig. Ein Import kann den Firmeneinstieg nicht als geprüft markieren und keine Versandgrundlage erteilen. Bestehende Kontakte werden bei Dubletten weiterhin nicht überschrieben. Markierte bzw. anhand eindeutiger Testkennzeichen erkannte Testdaten können nur mit belegter Grundlage `own_test_address` für eine Kampagne vorbereitet werden.

## Signatur / Logo

Unter „Logo auswählen“ kann ein eigenes PNG hochgeladen werden (maximal 500 KB, 4096 Pixel je Seite und 4 Millionen Pixel). Die Vorschau zeigt Text und Bild vor dem Speichern. Erst „Signatur für alle neuen Entwürfe speichern“ übernimmt die Auswahl nach Betreiberanmeldung. Hochgeladene Logos werden geprüft, neu kodiert und unveränderlich in der Datenbank gesichert; damit sind sie auch im lokalen Backup enthalten. Alte Nachrichten und ihre Bilder bleiben beim Ersetzen erhalten. „Logo einbetten“ kann deaktiviert werden, ohne die Auswahl zu verlieren.

Signatur und Logoauswahl werden zentral und versioniert gepflegt, nicht mehr pro Kategorie oder Kampagne. Alle Sprachen und Sequenzschritte verwenden denselben festen Block. Änderungen erfordern die Betreiberanmeldung und gelten nur für neue Entwürfe. Personenbezogene Betreiberangaben werden nicht in Migrationen oder das öffentliche Repository geschrieben. Das bereitgestellte PNG liegt in `assets/gordion-logo.png` und wird ohne externe Bildabrufe als Inline-Anhang übertragen. Texte werden HTML-escaped. Signaturversion und Versandprüfung binden die exakten Logobytes über SHA-256 mit ein. Ein nachträglich ausgetauschtes Logo wird nicht stillschweigend versendet. Zusätzliche Empfänger (einschließlich CC/BCC), veränderte Texte, zusätzliche Anhänge, andere Bilder oder nicht unterstützte Outlook-HTML-Umschreibungen blockieren die Freigabeprüfung. Nach bereits erfolgter Entwurfserstellung werden unklare Ergebnisse zur Klärung angehalten, nicht erneut erstellt.

Der neue HTML-Ablauf wurde lokal und mit simulierten Graph-Antworten geprüft; ein erneuter realer Microsoft-Versand wurde dafür nicht ausgelöst. Die zwei älteren, separat freigegebenen Einzeltests sind keine Liveabnahme dieses Kampagnenpfads.

Liveversand, globale Pause, Kontaktfreigaben, Länder-/Firmenfilter, Sperrlisten und die übrigen Versandvoraussetzungen bleiben unabhängig von Kategorie, Fallback oder Logo bestehen. Automatische Suche sowie vollständige Produktivabnahme bleiben wie in der Automation-Roadmap offen.
