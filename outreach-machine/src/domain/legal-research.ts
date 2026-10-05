/** Research, not a legal opinion, country-rule approval or recipient authorization.
 * No planner/importer may convert this catalogue into outreach_authorizations.
 * Cross-border applicability and GDPR duties must be reviewed separately.
 */
export const LEGAL_RESEARCH_VERSION = '2026-10-01.1';
export interface LegalResearch {
  countryCode:string; checkedOn:string|null;
  status:'evidence_required'|'conditional_b2b_review'|'not_researched';
  summary:string; requirements:string[]; sources:{title:string;url:string}[];
  grantsPermission:false;
}
const common = [
  'Anwendbares Recht für den Versand aus Deutschland gesondert prüfen.',
  'Absenderidentität, einfacher Widerspruch und dauerhafte Sperrliste sicherstellen.',
  'Bei personenbezogenen Daten: Rechtsgrundlage, Informationspflichten und Widerspruchsrecht gesondert dokumentieren.',
];
const findings:Record<string,Omit<LegalResearch,'countryCode'|'checkedOn'|'grantsPermission'>> = {
  DE:{status:'evidence_required',summary:'Vorherige ausdrückliche Einwilligung oder vollständig belegte Bestandskundenausnahme. Eine veröffentlichte Adresse genügt nicht.',
    requirements:['Einwilligung: Empfänger, Absender, Kanal, Zweck, Datum und Originalnachweis.', 'Bestandskunde: Adresse beim Verkauf erhalten; eigene ähnliche Leistung; kein Widerspruch; Hinweis auf Widerspruch bei Erhebung und jeder Verwendung.'],
    sources:[{title:'§ 7 UWG',url:'https://www.gesetze-im-internet.de/uwg_2004/__7.html'}]},
  ES:{status:'evidence_required',summary:'Vorherige Anforderung oder ausdrückliche Erlaubnis; alternativ passende frühere Vertragsbeziehung nach Art. 21 LSSI.',
    requirements:['Konkrete Anfrage/Erlaubnis nachweisen oder frühere Vertragsbeziehung, rechtmäßige Erhebung und eigene ähnliche Leistungen belegen.', 'Einfachen kostenlosen Widerspruch bei Erhebung und in jeder Nachricht sowie gültige elektronische Abmeldeadresse sicherstellen.'],
    sources:[{title:'BOE – LSSI Art. 20–22',url:'https://www.boe.es/buscar/act.php?id=BOE-A-2002-13758#a21'}]},
  BG:{status:'conditional_b2b_review',summary:'Möglicher Weg für unaufgeforderte kommerzielle Nachrichten an juristische Personen. Keine pauschale Freigabe; nicht als Einwilligung speichern.',
    requirements:['Empfänger als juristische Person und Adresse als deren Geschäftskontakt belegen; Verbraucher nicht einbeziehen.', 'Amtliches KZP-Widerspruchsregister prüfen und Ergebnis samt Adresse/Domain, Datum und Beleg dokumentieren; nicht geprüft bedeutet nicht frei.', 'Nachricht bereits bei Eingang eindeutig als unaufgeforderte kommerzielle Nachricht kennzeichnen.', 'Grenzüberschreitende Anwendbarkeit und Datenschutz prüfen lassen. Dieser Sonderweg ist noch nicht als Versandbasis aktiviert.'],
    sources:[{title:'Ministerium – Gesetz über elektronischen Handel, Art. 6 und 19 (Stand Nov. 2025)',url:'https://www.mtc.government.bg/bg/category/324/zakon-za-elektronnata-trgoviya'}, {title:'KZP – amtliche Prüfung des Widerspruchsregisters',url:'https://kzp.bg/bg/proverka-na-e-adres'}]},
  FR:{status:'conditional_b2b_review',summary:'Die CNIL beschreibt beruflich relevante B2B-Ansprache auf Basis berechtigten Interesses unter Informations- und Widerspruchsvoraussetzungen. Keine automatische Freigabe.',
    requirements:['Bezug des Angebots zur konkreten beruflichen Tätigkeit und Interessenabwägung dokumentieren.', 'Information über Nutzung der Kontaktdaten und einfache Widerspruchsmöglichkeit nachweisen; bei Daten Dritter ebenfalls prüfen.', 'Grenzüberschreitende Anwendbarkeit gesondert prüfen lassen. Dieser Sonderweg ist noch nicht als Versandbasis aktiviert.'],
    sources:[{title:'CNIL – elektronische Direktansprache, aktualisiert 10.06.2026',url:'https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-electronique-sms-mms-et-automate-dappel'}]},
  CZ:{status:'evidence_required',summary:'Vorherige Einwilligung oder passende Kundenbeziehung; öffentliche Adressen und unverlangte E-Mails zur Einholung einer Einwilligung genügen nicht.',
    requirements:['Einwilligung für konkreten Absender und Zweck nachweisen oder Kundenbeziehung und eigene ähnliche Leistungen dokumentieren.', 'Einfache Ablehnung bei Erhebung und jeder Nachricht sowie erkennbare kommerzielle Identität sicherstellen.'],
    sources:[{title:'ÚOOÚ – Fragen und Antworten zu kommerziellen Nachrichten',url:'https://uoou.gov.cz/index.php/profesional/qa-otazky-a-odpovedi/obchodni-sdeleni'}]},
  GR:{status:'evidence_required',summary:'Die Datenschutzbehörde beschreibt vorherige ausdrückliche Einwilligung für elektronische Direktansprache; die Kunden-/Transaktionsausnahme muss gesondert belegt werden.',
    requirements:['Einwilligung oder Voraussetzungen der bestehenden Kunden-/Transaktionsbeziehung nach Art. 11 dokumentieren.', 'Keine unverlangte Einwilligungs-Anfrage per E-Mail als Umgehung verwenden.'],
    sources:[{title:'Griechische Datenschutzbehörde – Direktmarketing',url:'https://www.dpa.gr/el/enimerwtiko/thematikes_enotites/eisagwgi_prowthisi'}, {title:'Griechische Datenschutzbehörde – Pflichten',url:'https://www.dpa.gr/el/enimerwtiko/thematikes_enotites/proothisiproiontwn/hlektronika_mesa_proothisi/upoxrewseis_upef'}]},
  RO:{status:'evidence_required',summary:'Art. 12 des Gesetzes 506/2004 verlangt grundsätzlich vorherige ausdrückliche Einwilligung, auch für juristische Personen; eine begrenzte Kundenausnahme ist vorgesehen.',
    requirements:['Einwilligung oder direkt beim Verkauf erhobene Adresse, eigene ähnliche Leistungen und Widerspruchshinweise nachweisen.', 'Identität offenlegen und gültige Adresse für den Widerspruch angeben.'],
    sources:[{title:'Rumänisches Gesetzgebungsportal – Gesetz 506/2004, Art. 12',url:'https://legislatie.just.ro/Public/DetaliiDocument/257056'}]},
  PL:{status:'evidence_required',summary:'Art. 398 PKE verlangt vorherige Zustimmung zur elektronischen kommerziellen Ansprache. Veröffentlichung einer Adresse allein wird hier nicht als Zustimmung gewertet.',
    requirements:['Zustimmung zum konkreten Versandzweck nachweisen. Eine gezielte Bereitstellung der Adresse für kommerzielle Informationen ist von bloßer Veröffentlichung zu unterscheiden.', 'Aktuellen Rechtsstand und Anwendbarkeit im grenzüberschreitenden Fall vor Freigabe prüfen.'],
    sources:[{title:'UKE – PKE vom 12.07.2024, Art. 398–400',url:'https://cik.uke.gov.pl/gfx/cik/userfiles/_public/ustawa_prawo_komunikacji_elektronicznej_z_12_lipca_2024_r.pdf'}]},
};
export function legalResearchFor(countryCode:string):LegalResearch {
  const finding=findings[countryCode];
  return {countryCode,checkedOn:finding?'2026-10-01':null,grantsPermission:false,
    ...(finding ?? {status:'not_researched' as const,summary:'Für dieses Land liegt noch keine abgeschlossene Quellenrecherche vor. Keine Versandfreigabe.',requirements:[],sources:[]}),
    requirements:[...(finding?.requirements??[]),...common]};
}
