# Lokaler EU-Autopilot

## Stand und Betriebsgrenze

Implementiert sind Recherche-Queue, ESMA-A2A-Adapter, Websiteprüfung, Vorlagenbibliothek, regelbasierte DE/EN-Personalisierung, unabhängiger Planer, postfachweites Versandbuch, Provider-Journal, Delta-Abgleich aller ermittelten Ordner, Stoppsignale und lokale Betreiberanmeldung. Der Supervisor startet Oberfläche und Hintergrundprozesse getrennt.

**Kein freigegebener Livebetrieb.** Ausgangsvorlagen sind Entwürfe, Recherche ist standardmäßig aus, jeder Start ist pausiert. Eine technische oder fachliche Freigabe ersetzt keine dokumentierte Versandgrundlage. Der Rechercheprozess erstellt und bestätigt keine Einwilligungen.

### Lokal geprüfter Stand vom 26. September 2026

- 116 Kandidaten aus dem bestehenden Workbook übernommen; 25 frühere Recherche-/Kontaktfälle separat für neue Erstkontakte ausgeschlossen. Zwei vorhandene Testkontakte erhalten. Keine Autorisierungen erzeugt.
- Backup vor Migration erstellt und tatsächlich in eine neue, separate Datenbank zurückgespielt. Wiederherstellung migriert den Stand und erzwingt Pause, Schattenmodus und vollständigen Mailabgleich. Originaldatenbank bleibt unangetastet.
- Unit- und PostgreSQL-Smoke-Tests prüfen unter anderem 16 Vorlagen, Sprache/Fallbacks, ESMA-Feldabweichungen, URL-/Robots-Grenzen, Rolle/Kategorie, DSN-Auswertung, unveränderliche Snapshots, parallele Reservierungen, alte ungewisse Sends, Junk-Antworten anderer Firmenmitarbeiter und die Betreibergrenze.
- Der zusätzliche Fehler-Test prüft dauerhaft protokollierte Versuche vor Provider-Aufrufen, Abbrüche vor/nach Entwurf und Send, verlorene Antworten, einen Datenbankfehler nach Provider-Annahme, wiederholten Versandabgleich ohne Doppelversand und den Neuabgleich nach abgelaufenem Delta-Cursor. Alle Provider-Operationen dieses Tests sind rein simuliert. Ein wiedergefundenes Send-Element wird mit seiner lokalen Budgetreservierung zusammengeführt und zählt nicht doppelt.
- Die Planung blättert auch über vollständig ungeeignete Kandidatenseiten hinweg; PostgreSQL-Zeitstempel behalten dabei ihre vollständige Genauigkeit. Freigabe/Pause steuert auch die zugehörige Kampagne. Die bisherigen Versand-Worker dürfen keine Autopilot-Nachrichten übernehmen.
- Datenbanktests prüfen Berliner Mitternacht sowie beide Sommerzeitwechsel gegen das unabhängige rollierende 24-Stunden-Budget. Reservierte, ungewisse und nur angenommene, noch nicht bestätigte Vorgänge bleiben bis zur Klärung budgetwirksam, auch wenn sie älter sind.
- Echter **lesender** Graph-Vertragstest: acht Ordner, 16 Nachrichten auf den ersten Delta-Seiten, keine Writes/Sends. Das ist kein vollständiger Schattenlauf und kein negativer Postfach-Isolationstest.

## Start

Stand 1. Oktober: [Länderrecherche, Kategorieansprache und verbleibende Freigaben](legal-readiness.md). Die 16 neutralen Ausgangsentwürfe können allein anhand der Kategorie gewählt werden, ohne regulatorische Betroffenheit zu behaupten. Kontakt- und Versandprüfung bleiben getrennt.

`npm run local:shadow-check` bindet das bereits konfigurierte Zertifikatspostfach bei pausiertem Betrieb und führt einen vollständigen lesenden Abgleich aus. `npm run local:shadow` hält Oberfläche und Hintergrundabgleich am Laufen. Beide erzwingen lesenden Zugriff; Betreiberanmeldung erforderlich. Keine automatische Freigabe von Vorlagen, Länderregeln oder Betriebsprüfungen.

`npm run local:start` startet PostgreSQL, Migrationen und den Supervisor ausschließlich im Simulator auf `http://127.0.0.1:4310`. Ein offen gehaltenes Browserfenster ist nicht erforderlich. Bestehende Personalisierungsfunktionen bleiben vorhanden.

`npm run autopilot:start` verwendet hingegen die explizite lokale `.env` sowie `.outreach-data/operator.env`. Graph-Laufzeit erst nach geprüfter Konfiguration verwenden. Die alten Graph-Worker-Einstiegspunkte brechen ab, damit niemand die neuen postfachweiten Schranken versehentlich umgeht.

`npm run autopilot:launchagent` erstellt lediglich eine prüfbare LaunchAgent-Datei. `-- --install` installiert und startet sie ausdrücklich. `-- --keep-awake` verwendet auf macOS ein prozessgebundenes Wachhalten am Netzteil. Docker muss verfügbar sein. Ausgeschaltet oder mit geschlossenem Deckel ist kein zuverlässiger Dauerbetrieb möglich.

## Betreiberanmeldung

Das Passwort wählt der Betreiber selbst. Im lokalen Simulator steht bei fehlendem Passwort unter **Autopilot → Betreiberanmeldung** eine einmalige Einrichtung bereit. Sie erfordert den exakten lokalen Ursprung und kann eine vorhandene Passwortdatei nicht überschreiben. Danach anmelden und vor dem Schattenbetrieb den Supervisor neu starten.

Nicht in Chat, Git oder Kommandozeilenargumente schreiben. Alternativ liest `npm run autopilot:operator-setup` das Passwort über stdin und speichert nur einen gesalzenen scrypt-Hash in `.outreach-data/operator.env` mit Modus 0600. Für eine verdeckte interaktive Eingabe beispielsweise:

```zsh
read -rs 'outreach_password?Neues Betreiberpasswort (mindestens 16 Zeichen): '
print -rn -- "$outreach_password" | npm run autopilot:operator-setup
unset outreach_password
```

Danach Supervisor neu starten und unter **Autopilot → Betreiberanmeldung** anmelden. Der automatische Entwicklungs-Cookie und der API-Schlüssel dürfen keine Liveaktivierung, Vorlagenfreigabe oder Regelprüfung ersetzen. Fünf fehlgeschlagene Loginversuche führen zu einer 15-minütigen Sperre; Sitzungen laufen nach einer Stunde ab.

## Zentrale Signatur

**Logo hochladen:** PNG unter „Logo auswählen“ auswählen (maximal 500 KB, 4096 Pixel je Seite, 4 Millionen Pixel insgesamt), Vorschau prüfen und „Signatur für alle neuen Entwürfe speichern“. Die Betreiberanmeldung ist erforderlich. Die Auswahl allein speichert noch nichts. Das bisherige Gordion-Logo bleibt bis zum Speichern erhalten. Abwählen von „Logo einbetten“ entfernt es aus neuen Nachrichten, ohne die Auswahl zu verlieren.

Migration 008 ergänzt unveränderliche Logo-Assets in PostgreSQL. Hochgeladene PNGs werden geprüft und aus dekodierten Pixeln neu kodiert; keine SVGs, Animationen oder externen Bild-URLs. Assets sind Teil des Datenbankbackups. Vorschau und beide Graph-Entwurfspfade laden genau den im Nachrichtensnapshot gespeicherten Hash; ein späterer Upload verändert alte Nachrichten nicht. Logoabrufe unter `/v1/sender-signature/logos/:sha256` erfordern eine angemeldete Sitzung oder den vorhandenen Admin-Zugang.

Unter **Kategorien & Vorlagen → Eine Signatur für alle Mailentwürfe** wird genau ein fester Absenderblock samt Logoauswahl gepflegt. Er gilt unverändert für alle vier Kategorien, DE/EN, Erstmail und Follow-up sowie für Kontaktvorschauen und manuell/automatisch vorbereitete Kampagnen. Keine automatische Übersetzung der Signatur.

Migration 007 übernimmt die bisherige Signatur nur, wenn alle vier Kategorien exakt übereinstimmen. Uneinheitliche oder leere Altbestände bleiben zur zentralen Einrichtung offen. Es werden keine persönlichen Absenderangaben im Quellcode hinterlegt. Ändern erfordert die lokale Betreiberanmeldung; Speichern aktiviert weder Vorlagen noch Versand. Gleichzeitige Änderungen werden über eine Versionsprüfung abgesichert.

Jeder neue Entwurf friert die aktuell gespeicherte Signaturversion und den Logo-Hash ein. Eine später vorbereitete Nachfrage übernimmt die dann aktuelle zentrale Signatur; bereits vorbereitete Nachrichten werden nie stillschweigend verändert. Historische Signaturfelder in Vorlagen/Kampagnen bleiben zur Nachvollziehbarkeit erhalten, steuern aber keine neuen Entwürfe mehr. Alte API-Felder `signature` und `useLogo` an Kategorie-/Vorlagen-/Kampagnenendpunkten werden nur noch aus Kompatibilitätsgründen angenommen und nicht als Override verwendet.

## Postfachbindung / Schattenbetrieb

Es gilt genau eine Verbindung aus `mailbox_connections`. `MAILBOX_CONNECTION_ID`, `GRAPH_TENANT_ID`, `GRAPH_MAILBOX_OBJECT_ID`, bestätigte primäre Absenderadresse und `autopilot_config.mailbox_connection_id` müssen übereinstimmen. Keine Auswahl allein nach Adresse und keine automatische Auswahl des ersten Postfachs.

Für Schattenbetrieb:

```dotenv
HOST=127.0.0.1
LOCAL_DASHBOARD_ENABLED=true
MAIL_PROVIDER=microsoft_graph
GRAPH_AUTH_MODE=app_only
GRAPH_ACCESS_STAGE=read_only
LIVE_SEND_ENABLED=false
# MAILBOX_CONNECTION_ID und vorhandene geprüfte Zertifikat-/Identitätswerte lokal setzen.
```

Zertifikat und privaten Schlüssel außerhalb des Repositorys aufbewahren. Bestehende Exchange Application RBAC-Beschränkung erhalten; keine zusätzlichen tenantweiten Mailrechte vergeben. `graph:autopilot-check` prüft die lesenden API-Formate ohne Datenbankbindung und ohne Provider-Writes.

Die Oberfläche speichert Änderungen zunächst pausiert. `/v1/autopilot/preflight` nennt konkrete Liveblocker; Betriebsfreigaben müssen echte Prüfnachweise enthalten, nicht bloße Häkchen zur Umgehung der Prüfung.

## Verarbeitung und Sicherheitsregeln

### Bestehende Kontaktfirmen gezielt nachrecherchieren

`npm run research:contact-sites` prüft ausschließlich die bereits im lokalen Kontaktbestand enthaltenen Firmenwebsites. Die lokale Datenbank muss ausdrücklich über `DATABASE_URL` konfiguriert und der Autopilot pausiert sein. Der Befehl importiert keine Registerfirmen, verändert keine Kategorien oder Freigaben und verwendet kein Microsoft Graph.

Der erste Lauf friert seine Firmenliste ein. Ergebnisse, Tageskontingent und Abrufreservierungen bleiben in PostgreSQL erhalten. Wiederholte Starts setzen nur offene Firmen fort; höchstens 100 Firmen und 1.000 Abrufreservierungen pro Berliner Kalendertag, zehn Abrufe je Firma einschließlich Robots/Weiterleitungen, zwei parallele Firmen und mindestens fünf Sekunden pro Domain. Unterbrochene Netzwerkversuche bleiben gegen das Abrufbudget gezählt. Das globale Recherche-Lock verhindert einen gleichzeitigen Lauf des bestehenden Recherche-Workers. Keine selbständige spätere Ausführung: verbleibende Firmen werden erst mit erneutem Start bearbeitet.

Veröffentlichte nicht-generische Adressen werden als Quellenfunde gespeichert. Nur passende Rollen-/Fachadressentreffer mit MX-Nachweis werden als neue oder aktualisierte Kontakte in `needs_review` übernommen. MX ist kein Mailboxnachweis. `info@`, allgemeine Kontaktadressen, Datenschutz-/Presse-/Bewerbungsadressen und fremde Domains sind kein automatischer Ersatz. Widersprüchliche sichtbare Adressen und Mail-Links sowie Datenschutzkontext bleiben ungeprüft. Bestehende geprüfte oder gesperrte Kontakte werden nicht überschrieben. Keine Einwilligungen, Versandfreigaben, Nachrichten oder Sends werden angelegt.

Am Ende entsteht ein privater, Git-ignorierter HTML-Bericht unter `.outreach-data/contact-site-audit-<run-id>.html`. Er unterscheidet zugängliche Websites, technisch blockierte Prüfungen, veröffentlichte Kandidaten und rollenbezogene Kontaktübernahmen; bestehende aktualisierte Kontakte sind keine zusätzlichen Empfänger. `npm run research:contact-sites -- --report-only` erstellt nach Ende des aktiven Laufs ausschließlich den Bericht neu, ohne Websites abzurufen. Nicht-lesbare, PDF- oder nur per JavaScript zugängliche Inhalte gelten nicht als vollständig überprüft.

### Allgemeine Autopilot-Grenzen

`npm run drafts:local-review` erstellt bei pausiertem Betrieb ein privates HTML-/JSON-Prüfpaket für die ersten 100 bereits bearbeiteten Firmen des Kontaktprüflaufs. Es nutzt eine ausschließlich lesende Datenbanktransaktion und die vorhandenen Kategorie-/Sprachvorlagen sowie die zentrale Signatur mit eingefrorenem Logo. Pro Firma wird höchstens ein veröffentlichter, ausreichend zugeordneter und nicht gesperrter Kontakt gewählt; bekannte Erstkontakte und bestehende Sequenzen erhalten keinen Empfänger. Fehlende Kontakte bleiben ausdrücklich leer, statt alte `info@`-Adressen einzusetzen. Die Dateien liegen in einem neuen geschützten Unterverzeichnis von `.outreach-data/`. Dies sind **nur lokale Textvorschauen**, keine Outlook-Entwürfe, Kampagnen oder versandbereiten Queue-Einträge. Freigaben, Nachweise und Tageslimits bleiben unverändert.

- EU27; DE für Deutschland/Österreich, sonst EN; explizite unterstützte Kontaktsprache hat Vorrang.
- ESMA-Register wöchentlich, Quellenanreicherung regelmäßig. Maximal 100 Firmenprüfungen / 1.000 Abrufe pro Berliner Kalendertag, zehn Websiteabrufe je Firma einschließlich Robots/Weiterleitungen. Aktuell ein Rechercheabruf zur Zeit, also unter der Obergrenze von zwei.
- Nur Register-/Seed-belegte Websites. Keine geratenen Domains, Adressen oder `info@`-Ersatzkontakte. DNS/MX-Prüfung ist **kein** Nachweis einer existierenden Mailbox.
- Öffentliche IP-Prüfung vor jedem Abruf, DNS-Adresse auf die Verbindung festgelegt, keine privaten Ziele oder HTTPS-Downgrades. Cross-Domain-Weiterleitungen verlangen eine neue belegte Quelle. HTML wird ohne JavaScript-Ausführung gelesen. Schranken und erkannte Zugriffsbeschränkungen führen zum Ausschluss.
- Registeraktivität allein macht einen Lead nicht fachlich geeignet. Konservative Regeln benötigen zusätzliche konkrete Websitebelege. Nicht unterstützte / unklare Aussagen landen in der Prüfung. PDF- und JavaScript-only-Seiten werden aktuell nicht als fachlicher Nachweis ausgewertet.
- LEI / Registeridentität und Land vor Domain. Gemeinsame Domains vereinigen keine verschiedenen Rechtsträger. Ein Seed-Namensabgleich erfolgt nur exakt, eindeutig und ohne widersprechende Identitätsdaten; Namensvarianten bleiben zur historischen Prüfung offen.
- Jede Länderregel hat Version, Basis, Voraussetzungen, Referenz, Prüfer und Ablauf. Zusätzlich muss pro vorhandener Kontakt-Autorisierung die Erfüllung der konkreten Regelvoraussetzungen bestätigt werden.
- Initial- und Follow-up-Vorlagenversion werden bei Aufnahme festgehalten. Kontakt, Sprache, Quellen, Fallbacks, Fakten, Signatur und Logo-Hash werden im Nachrichtensnapshot eingefroren. Alte Versionen werden nicht überschrieben.
- Erstmail + maximal eine Nachfrage, sieben Montag-bis-Freitag-Werktage nach bestätigtem Versand, keine Feiertagskalender. Nachfrage als Reply-All-Entwurf zum gesendeten Original, mit ausdrücklich genau einem externen Empfänger und leerem CC/BCC. Provider-Rücklesung muss Inhalt, Korrelation und Logo exakt bestätigen.
- Versand Mo–Fr 10–16 Uhr Europe/Berlin, mindestens acht Minuten Abstand. Tagesziel 45, Pilotgrenze 10, absolute Grenze 50 pro Kalenderdatum **und** rollierenden 24 Stunden. Nachfragen zuerst, danach Kategorien reihum. Bei sechs Stunden und acht Minuten Abstand sind maximal 45 Sendestarts möglich.
- Angenommene, bestätigte, reservierte und ungewisse Sends teilen das Budget. Ungewisse Vorgänge altern nicht einfach aus der Sperre. Erkannte externe Postfachsendungen werden ebenfalls gezählt; zusätzliche manuelle Sends außerhalb der Anwendung kann sie nicht verhindern oder vor ihrer Sichtbarkeit berücksichtigen.
- Journal wird vor Provider-Writes committed. Fehlender Fund und vorhandener Entwurf widerlegen keinen möglichen Send. Keine automatische Wiederholung ungewisser Vorgänge. `202 Accepted` bedeutet nicht Zustellung.
- Alle ermittelten Ordner einschließlich Junk/Unterordnern werden gepollt. Jeder Seitencursor wird erst nach Verarbeitung gespeichert. Abgelaufene Cursor beginnen neu; unvollständiger/älter als zwei Minuten gewordener Abgleich blockiert Versand.
- Menschliche Antwort stoppt die Firma, Abmeldung sperrt zusätzlich dauerhaft, automatische Antwort pausiert. Mehrdeutige Zuordnung pausiert die betroffenen Sequenzen. Bounces benötigen strukturierte DSN-Daten, Original-ID und passenden Empfänger; unbekannte Zustellmeldungen werden zur Prüfung gesperrt.
- Drei aufeinanderfolgende Hard Bounces oder mindestens zwei unter den letzten 40 bestätigten Sends pausieren. Manuelle Pause wird nie automatisch aufgehoben. Neustart verlangt zusätzlich erneute Aktivierung.

## Schnittstellen

Alle `/v1`-Aufrufe benötigen lokale Sitzung oder API-Schlüssel. Betreiberentscheidungen benötigen zusätzlich den getrennten, gleichursprünglichen Betreiber-Cookie. Recherche-Schlüssel bleibt auf `POST /v1/imports` mit `source=research` beschränkt.

| Route | Zweck |
|---|---|
| `GET /v1/autopilot` | Gesamtsummen, Betrieb, Worker |
| `GET /v1/autopilot/preflight` | Liveblocker und Warnungen |
| `POST /v1/autopilot/configure` | versioniert, speichert pausiert |
| `POST /v1/autopilot/activate`, `/pause` | ausdrückliche Betreiberentscheidung / Stopp |
| `POST /v1/autopilot/checks` | tatsächlichen technischen Prüfnachweis attestieren |
| `POST /v1/autopilot/seed-reconciliation` | abgeschlossenen Historienabgleich bestätigen |
| `GET/POST /v1/autopilot/country-rules` | Länderregelversionen |
| `POST /v1/autopilot/authorizations/:id/rule` | bestehende Rechtsgrundlage mit geprüften Regelvoraussetzungen verbinden |
| `GET/POST /v1/templates/versions` | versionierte Bibliothek |
| `POST /v1/templates/versions/:id/approve` | gespeicherten Nachrichtentext freigeben; zentrale Signatur muss vorhanden sein |
| `GET/POST /v1/sender-signature` | eine gemeinsame Signatur samt Logo, Änderungen nur als Betreiber |
| `GET /v1/research/runs`, `/v1/exceptions` | paginierte Läufe / Klärungsfälle |

Listen nutzen `limit` und `offset`. `GET /v1/console` liefert echte Gesamtsummen, unabhängig von sichtbaren Seiten. Die Kontakt-Suche in der bestehenden Oberfläche filtert derzeit die geladenen Einträge; weitere Seiten lassen sich nachladen.

## Backups

`npm run backup:create` erstellt einen PostgreSQL-Custom-Dump unter `.outreach-data/backups`, prüft dessen Inhaltsverzeichnis und protokolliert SHA-256. Im Supervisor täglich, 14 Punkte, Dateien 0600 / Ordner 0700. Keine Garantie gegen Verlust des Macs; für externe Sicherung ist ein eigener geschützter Speicher nötig.

`npm run backup:restore-test -- <backup.dump> gordion_NAME_restore_test` legt ausschließlich eine **neue** lokale Datenbank an. Existiert sie bereits, bricht der Befehl ab. Er überschreibt und löscht keine Datenbank. Nach Restore/Migration werden Liveflags entfernt, Pause gesetzt und alle Sync-Cursor ungültig gemacht. Erst ein erneuter vollständiger Postfach-/Providerabgleich darf einer expliziten Aktivierung vorausgehen. Die Hilfsprogramme unterstützen bewusst nur den vorhandenen lokalen Docker-PostgreSQL auf Port 54329.

## Noch vor echter Freigabe zu erledigen

1. Betreiberpasswort setzen und geprüfte lokale Postfachverbindung binden; Identitäts-/RBAC-Nachweise bestätigen, verbleibenden negativen Isolationstest klären.
2. Die 16 Nachrichtentexte einmal gemeinsam prüfen/freigeben; die zentrale Signatur nur einmal pflegen. Regulierungssnippets sind separat versioniert, aber nicht automatisch in Texte eingesetzt; Anwendung ab 12. Februar 2028, keine pauschale Betroffenheitsgarantie.
3. Frühere Anschreiben vollständig mit dem Postfach abgleichen. Namensvarianten / die 25 ausgeschlossenen Bestandsfirmen bleiben bis zur Klärung gesperrt.
4. Länderregeln und passende Kontakt-Autorisierungen mit echten Nachweisen hinterlegen. Kein Ersetzen durch „wir fragen nur an“.
5. Vollständiger Schatten-Tageslauf mit realer Recherche und komplettem lesendem Postfachabgleich. Quellenquoten, fehlende Websites und Ausschlüsse prüfen. Ein API-Verbindungstest genügt nicht.
6. Ausdrücklich autorisierter Outlook-Funktionstest auf eigene Adressen: Erstmail, Reply-All-Nachfrage, HTML-/Logo-Rücklesung, CC/BCC, Antwort, Abmeldung, OOO und strukturierter Bounce. Die neue Follow-up-/Branding-Strecke wurde bisher **nicht** schreibend gegen Outlook abgenommen.
7. Simulierte Crash-Grenzen, Cursor-Reparatur und datenbankgestützte Mitternachts-/Sommerzeit-Budgetfälle sind geprüft. Noch offen sind vollständige End-to-End-Abnahme mit allen positiven Live-Gates, Zertifikatsfehler im echten Betrieb und Schlaf-/Wiederanlauf über den Supervisor. Die vorhandenen Tests ersetzen diese vollständige Abnahmematrix nicht.
8. Erst danach ausdrücklich freigegebener Pilot mit maximal zehn Mails täglich. Erhöhung erfordert eigenen `scale_review`-Nachweis und Betreiberentscheidung.

## Primärdokumentation

- [ESMA A2A / Solr](https://registers.esma.europa.eu/publication/helpApp)
- [Microsoft: Message Delta](https://learn.microsoft.com/en-us/graph/delta-query-messages)
- [Microsoft: Reply-All-Entwurf](https://learn.microsoft.com/en-us/graph/api/message-createreplyall?view=graph-rest-1.0)
- [Microsoft: abfragbare Extended Properties](https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-get?view=graph-rest-1.0)
- [Microsoft: Exchange-Versandgrenzen](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits#sending-limits)
