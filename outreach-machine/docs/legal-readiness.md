# Versandgrundlagen und Kategorieansprache

Rechercheversion: 2026-10-01.1. Dies ist eine technische Prüfhilfe, keine Rechtsberatung oder Einzelfallfreigabe.

## Getrennte Entscheidungen

1. **Kategorie** wählt den Schwerpunkt der Nachricht. `category_only` genügt für eine neutrale Produktvorstellung. Sie bestätigt weder tatsächliche Ausführungstätigkeit noch regulatorische Betroffenheit. Widersprüche, Ausschlüsse und Sperren bleiben wirksam.
2. **Kontaktprüfung** belegt veröffentlichte Adresse, passenden Ansprechpartner, Aktualität und DNS. Keine geratenen oder automatisch gewählten `info@`-Adressen.
3. **Versandgrundlage** benötigt eine freigegebene Länderregel und einen passenden Einzelnachweis. Webseiten, Registereintrag, DNS oder Kategorie erzeugen keine Einwilligung.
4. **Betriebsprüfung** bleibt separat: Postfachbindung, frischer vollständiger Abgleich, Inhalt, Budget und Pilotfreigabe.

## Quellenstand im Dashboard

`GET /v1/autopilot/legal-research` liefert paginiert tatsächliche Länderabdeckung, vorhandene Kontakte, dokumentierte Länderbasis und Quellen. Ein vorhandener Nachweis bedeutet noch keine vollständige Versandreife. Die versionierte, redaktionell gepflegte Recherche in `src/domain/legal-research.ts` ist ausdrücklich nicht mit `country_send_rules` oder `outreach_authorizations` verbunden.

- **DE:** [§ 7 UWG](https://www.gesetze-im-internet.de/uwg_2004/__7.html): ausdrückliche vorherige Einwilligung oder vollständige Bestandskundenausnahme.
- **ES:** [Art. 21 LSSI](https://www.boe.es/buscar/act.php?id=BOE-A-2002-13758#a21): vorherige Anforderung/Erlaubnis oder begrenzte Vertragskunden-Ausnahme.
- **CZ:** [ÚOOÚ](https://uoou.gov.cz/index.php/profesional/qa-otazky-a-odpovedi/obchodni-sdeleni): Einwilligung oder passende Kundenbeziehung; öffentliche Adresse und unverlangte Einwilligungs-Anfrage sind kein Ersatz.
- **GR:** [Datenschutzbehörde](https://www.dpa.gr/el/enimerwtiko/thematikes_enotites/eisagwgi_prowthisi): vorheriges Opt-in; Kunden-/Transaktionsausnahme gesondert prüfen.
- **RO:** [Art. 12 Gesetz 506/2004](https://legislatie.just.ro/Public/DetaliiDocument/257056): grundsätzlich vorherige ausdrückliche Einwilligung, auch für juristische Personen; begrenzte Kunden-Ausnahme.
- **PL:** [UKE, PKE Art. 398–400](https://cik.uke.gov.pl/gfx/cik/userfiles/_public/ustawa_prawo_komunikacji_elektronicznej_z_12_lipca_2024_r.pdf): vorherige Zustimmung; gezielte Adressbereitstellung zum Empfang kommerzieller Informationen nicht mit allgemeiner Veröffentlichung verwechseln. Quelle ist die amtliche Fassung von 2024; aktuellen Gesamtstand vor rechtlicher Freigabe prüfen.
- **BG:** [Gesetz über elektronischen Handel, Art. 6](https://www.mtc.government.bg/bg/category/324/zakon-za-elektronnata-trgoviya): möglicher Sonderweg für juristische Personen, mit eindeutiger Kennzeichnung und [KZP-Widerspruchsprüfung](https://kzp.bg/bg/proverka-na-e-adres). Verbraucher ausnehmen. Registerprüfung ist nicht durchgeführt und nicht fingiert. Keine undokumentierte API implementiert.
- **FR:** [CNIL, aktualisiert 10.06.2026](https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-electronique-sms-mms-et-automate-dappel): beruflich relevante B2B-Ansprache kann unter Informations- und Widerspruchsvoraussetzungen auf berechtigtes Interesse gestützt werden.

Andere Länder sind ausdrücklich als nicht recherchiert gekennzeichnet. Keine pauschale EU-Regel ableiten. Grenzüberschreitende Anwendbarkeit für einen deutschen Absender sowie ggf. DSGVO-Rechtsgrundlage, Interessenabwägung, Transparenz und Widerspruch müssen separat geprüft werden. Die BG-/FR-Sonderwege sind **nicht** als versandfähige Basis implementiert/aktiviert und dürfen nicht unter `consent` verbucht werden. Dafür fehlen konkrete juristische Freigabe und entsprechende Belege.

## Vorlagen und Bestandsschutz

Die 16 neutralen Ausgangsvorlagen verwenden `category_only`. Nur exakt unveränderte, noch nicht freigegebene Ausgangsentwürfe werden beim Seed auf diesen Modus gesetzt. Benutzertexte und freigegebene Versionen werden nicht umgestellt. Neue benutzerdefinierte Versionen sind standardmäßig `verified_activity`; eine andere Auswahl ist bei der Inhaltsfreigabe ausdrücklich sichtbar.

`category_only` unterdrückt firmenspezifische Einleitungsabsätze auch dann, wenn diese zuvor geprüft wurden. Die manuelle Vorlagenprüfung muss weiterhin unbelegte Aussagen im freien Text ausschließen. Die Nachricht friert Zielauswahl und Vorlagenversion ein. Der finale Versand prüft die Zielauswahl erneut. Alte Snapshots erhalten keine nachträgliche Lockerung. Signatur und Logo bleiben zentral und werden für neue Nachrichten eingefroren.

## Lokaler Schattenbetrieb

`npm run local:shadow-check` prüft die konfigurierte Zertifikatsidentität, bindet das Postfach nur bei pausiertem Betrieb und führt einen vollständigen Delta-Zyklus aus. `npm run local:shadow` startet die Oberfläche und Worker mit zwingend lesender Graph-Verbindung. Betreiberpasswort erforderlich; keine Entwicklungs-Anmeldung im Graph-Modus.

Beide Befehle erzwingen `LIVE_SEND_ENABLED=false` und `GRAPH_ACCESS_STAGE=read_only`. Bestehende abweichende Postfachbindungen führen zum Abbruch. Kein Import von Versandfreigaben, keine Bestätigung der Postfachisolation und kein automatisches Abzeichnen historischer Anschreiben. Erfolgreicher Lesezugriff allein beweist keine Postfachbeschränkung.

Für einen Livepilot weiterhin nötig: belegte und geprüfte Versandgrundlage pro Kontakt, Kontaktprüfung, Vorlagenfreigabe, historische Abstimmung, eigener Funktionstest, getestete Postfachbeschränkung, Wiederherstellungstest, vollständiger Schattenlauf und ausdrückliche Aktivierung. Kein Versandstoß zum Erreichen einer Tageszielzahl.
