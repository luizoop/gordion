import { DateTime } from 'luxon';
import { templateErrors } from './personalization.js';
import { validateFinalContent } from './message.js';

export const EU_COUNTRIES = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'] as const;
export const CATEGORIES = ['bank','broker','asset_manager','general'] as const;
export type Category = typeof CATEGORIES[number];
export type Language = 'de' | 'en';
export function isEu(country: string | null | undefined): boolean { return (EU_COUNTRIES as readonly string[]).includes(country || ''); }
export function contactLanguage(country: string | null, explicit?: string | null): Language {
  if (explicit && explicit !== 'de' && explicit !== 'en') throw new Error('unsupported_contact_language');
  return explicit as Language || (country === 'DE' || country === 'AT' ? 'de' : 'en');
}
export function inAutopilotWindow(now: Date): boolean {
  const t = DateTime.fromJSDate(now).setZone('Europe/Berlin');
  return t.weekday <= 5 && t.hour >= 10 && t.hour < 16;
}
export function followupDue(sentAt: Date): Date {
  let t = DateTime.fromJSDate(sentAt).setZone('Europe/Berlin');
  for (let workdays = 0; workdays < 7;) { t = t.plus({ days: 1 }); if (t.weekday <= 5) workdays++; }
  return t.set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toJSDate();
}
export function effectiveLimit(target: number, pilot: number): number { return Math.min(50, target, pilot); }
export function contactRank(role: string | null, kind: string): number {
  if (kind === 'functional') return 4;
  if (kind !== 'personal') return 9;
  if (/\b(ceo|coo|chief executive|chief operating|geschäftsführer|geschäftsführung|managing director)\b/i.test(role || '')) return 1;
  if (/compliance/i.test(role || '')) return 2;
  if (/trading|operations|handel/i.test(role || '')) return 3;
  return 9;
}
export interface AutopilotContact {
  firstName?: string | null; lastName?: string | null; honorific?: string | null;
  name?: string | null; roleTitle?: string | null;
  executionIntro?: string | null; introVerifiedAt?: unknown; introSourceUrl?: string | null; introLanguage?: string | null;
}
export interface LibraryTemplate {
  categoryId: Category; language: Language; step: 0 | 1; subject: string; body: string; signature: string;
  useLogo: boolean; logoSha256?: string | null;
  targetingMode?: 'verified_activity' | 'category_only';
}
export const optOut = {
  de: 'Falls Sie keine weitere Kontaktaufnahme wünschen, genügt eine kurze Antwort auf diese E-Mail.',
  en: 'If you would prefer not to be contacted again, please let me know by replying to this email.',
};
export function renderAutopilot(contact: AutopilotContact, template: LibraryTemplate) {
  const de = template.language === 'de';
  const errors = [...templateErrors(template.subject), ...templateErrors(template.body)];
  if (errors.length) throw new Error(errors.join('; '));
  if (!template.signature.trim() || /{{|}}|\$\{/.test(template.signature)) throw new Error('signature_missing_or_invalid');
  if (!template.body.includes(optOut[template.language])) throw new Error('language_optout_missing');
  const fallbacks = new Set<string>();
  const first = contact.firstName?.trim(), last = contact.lastName?.trim();
  const facts: Record<string, string> = {};
  let salutation: string;
  if (last && ['herr','frau'].includes(contact.honorific || '')) {
    salutation = de ? `${contact.honorific === 'herr' ? 'Sehr geehrter Herr' : 'Sehr geehrte Frau'} ${last},` : `Dear ${contact.honorific === 'herr' ? 'Mr' : 'Ms'} ${last},`;
  } else if (first) { salutation = `${de ? 'Guten Tag' : 'Hello'} ${first}${last ? ` ${last}` : ''},`; fallbacks.add('salutation:neutral_personal'); }
  else { salutation = de ? 'Guten Tag,' : 'Hello,'; fallbacks.add('salutation:neutral'); }
  facts.salutation = salutation;
  // Category-only outreach introduces our product, never asserts a recipient's
  // execution activity or regulatory applicability from the category alone.
  const intro = template.targetingMode !== 'category_only' && contact.executionIntro?.trim() && contact.introVerifiedAt && contact.introSourceUrl && contact.introLanguage === template.language ? contact.executionIntro.trim() : '';
  if (intro) facts.executionIntro = intro;
  else fallbacks.add('executionIntro:neutral');
  const values: Record<string,string | undefined> = {
    salutation, firstName: first, lastName: last, company: contact.name?.trim() || undefined,
    companyWithArticle: contact.name?.trim() || undefined, role: contact.roleTitle?.trim() || undefined,
    executionIntro: intro || undefined, evidence: intro || undefined,
  };
  const defaults: Record<string,string> = de ? {
    firstName:'Team',lastName:'Kontaktperson',company:'Ihr Unternehmen',companyWithArticle:'Ihrem Unternehmen',role:'zuständige Ansprechperson',
    executionIntro:'Ich möchte Ihnen Gordion vorstellen: einen Ansatz zur strukturierten Prüfung und Dokumentation der Ausführungsqualität.',
  } : {
    firstName:'team',lastName:'contact',company:'your company',companyWithArticle:'your company',role:'the appropriate contact',
    executionIntro:'I would like to introduce Gordion: an approach to structured execution-quality controls and documentation.',
  };
  defaults.evidence = defaults.executionIntro!;
  const substitute = (text: string) => text.replace(/{{\s*([a-zA-Z]+)(?:\|([^{}]*))?\s*}}/g, (_match, key: string, custom?: string) => {
    if (values[key]) { facts[key] = values[key]!; return values[key]!; }
    fallbacks.add(`${key}:${custom === undefined ? 'default' : 'custom'}`);
    return custom?.trim() || defaults[key] || '';
  });
  const subject = substitute(template.subject).trim();
  const bodyText = `${substitute(template.body).trim()}\n\n${template.signature.trim()}`;
  if (validateFinalContent({ recipientAddress:'preview@example.test',subject,bodyText }).length) throw new Error('rendered_content_invalid');
  return { subject, bodyText, fallbacks:[...fallbacks], facts };
}

export function initialTemplates(): LibraryTemplate[] {
  const benefits: Record<Category,Record<Language,string>> = {
    bank: { de:'Für Banken entwickeln wir Unterstützung für die laufende Kontrolle der Ausführungsqualität und die nachvollziehbare Bearbeitung von Abweichungen.', en:'For banks, we are developing support for ongoing execution-quality controls and a traceable process for investigating deviations.' },
    broker: { de:'Für Broker und Wertpapierfirmen liegt unser Schwerpunkt auf Ausführungskontrollen über Handelsplätze hinweg und der dazugehörigen Evidenz.', en:'For brokers and investment firms, our focus is on execution controls across venues and the supporting evidence.' },
    asset_manager: { de:'Für Asset Manager und Vermögensverwalter liegt unser Schwerpunkt auf der Ausführungsüberwachung und der nachvollziehbaren Dokumentation von Prüfergebnissen.', en:'For asset managers and portfolio managers, our focus is on execution monitoring and traceable documentation of review findings.' },
    general: { de:'Unser Schwerpunkt liegt auf nachvollziehbaren Kontrollen, klaren Prüfschritten und strukturierten Evidenzakten.', en:'Our focus is on traceable controls, clear review steps and structured evidence records.' },
  };
  return CATEGORIES.flatMap(categoryId => (['de','en'] as const).flatMap(language => ([0,1] as const).map(step => {
    const de = language === 'de';
    const subject = step === 0 ? (de ? 'Gordion – Ausführungsqualität: {{company}}' : 'Gordion – execution quality at {{company}}') : (de ? 'Kurze Nachfrage zu Gordion' : 'Following up on Gordion');
    const body = step === 0 ? (de ?
      `{{salutation}}\n\n{{executionIntro}}\n\n${benefits[categoryId].de}\n\nGordion soll bestehende Handels- und Abwicklungssysteme um eine spezialisierte Kontroll- und Evidenzschicht ergänzen. Der Betrieb innerhalb der Infrastruktur des Instituts ist vorgesehen, damit sensible Orderdaten das Haus nicht verlassen müssen.\n\nEin möglicher Einstieg wäre ein eng abgegrenzter Pilot für eine liquide Instrumentklasse: von der Referenzdaten- und Schwellenwertprüfung bis zu einer prüf- und freigabefähigen Evidenzakte.\n\nWären Sie offen für einen 20-minütigen Austausch dazu, ob dieser Ansatz für {{company}} relevant sein könnte?` :
      `{{salutation}}\n\n{{executionIntro}}\n\n${benefits[categoryId].en}\n\nGordion is intended to complement existing trading and settlement systems with a dedicated control and evidence layer. It is designed for deployment within an institution's own infrastructure so that sensitive order data can remain in-house.\n\nA possible starting point would be a narrowly scoped pilot for one liquid instrument class: from reference-data and threshold checks through to an evidence record ready for review and approval.\n\nWould you be open to a 20-minute conversation about whether this approach could be relevant to {{company}}?`) : (de ?
      '{{salutation}}\n\nIch möchte einmal kurz auf meine Nachricht zu Gordion zurückkommen. Wir entwickeln Unterstützung für die strukturierte Prüfung und Dokumentation der Ausführungsqualität.\n\nWäre ein kurzer Austausch für Sie interessant? Falls das Thema bei Ihnen derzeit keine Priorität hat, ist selbstverständlich keine Rückmeldung erforderlich.' :
      '{{salutation}}\n\nI wanted to follow up once on my message about Gordion. We are developing support for structured execution-quality checks and documentation.\n\nWould a short conversation be of interest? If this is not a priority for you at present, there is of course no need to reply.');
    return { categoryId,language,step,subject,body:`${body}\n\n${optOut[language]}`,signature:'',useLogo:true,targetingMode:'category_only' as const };
  })));
}
