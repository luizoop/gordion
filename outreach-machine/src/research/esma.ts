import { z } from 'zod';
import { isEu } from '../domain/autopilot.js';
import { safePublicUrl } from './public-http.js';

export const ESMA_ENDPOINT = 'https://registers.esma.europa.eu/solr/esma_registers_upreg/select';
export const esmaPageSchema = z.object({responseHeader:z.object({status:z.literal(0)}),response:z.object({numFound:z.number().int().nonnegative(),start:z.number().int().nonnegative(),docs:z.array(z.record(z.string(),z.unknown()))})});
const names = ['AUSTRIA','BELGIUM','BULGARIA','CROATIA','CYPRUS','CZECH REPUBLIC','DENMARK','ESTONIA','FINLAND','FRANCE','GERMANY','GREECE','HUNGARY','IRELAND','ITALY','LATVIA','LITHUANIA','LUXEMBOURG','MALTA','NETHERLANDS','POLAND','PORTUGAL','ROMANIA','SLOVAKIA','SLOVENIA','SPAIN','SWEDEN'];
const codes = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
export function esmaCountry(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  if (isEu(normalized)) return normalized;
  if (normalized === 'CZECHIA') return 'CZ'; if (normalized === 'EL') return 'GR';
  return codes[names.indexOf(normalized)] || null;
}
const text = (r:Record<string,unknown>, k:string):string => typeof r[k] === 'string' ? r[k] as string : '';
export function normalizeEsma(row:Record<string,unknown>) {
  const id = text(row,'id'), name = text(row,'ae_entityName'), office = text(row,'ae_officeType').toLowerCase();
  if (!id || !name || !text(row,'ae_status') || !office || !text(row,'ae_homeMemberState')) throw new Error('esma_required_field_changed');
  if (!['head office','ho','branch','br'].includes(office)) throw new Error(`esma_unknown_office_type:${office}`);
  const country = esmaCountry(text(row,'ae_homeMemberState'));
  const active = text(row,'ae_status').toLowerCase() === 'active';
  const headOffice = ['head office','ho'].includes(office);
  const leiValue = text(row,'ae_lei').trim().toUpperCase();
  const lei = /^[A-Z0-9]{18}[0-9]{2}$/.test(leiValue) ? leiValue : null;
  const rawWebsite = text(row,'ae_website').trim();
  let website: string | null = null;
  // An explicit register domain is evidence, but an absent field never results in a guessed domain.
  if (rawWebsite) { try { website=safePublicUrl(/^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`).href; } catch { /* invalid URL stays missing */ } }
  return { id,name,country,active,headOffice,lei,website,entityType:text(row,'ae_entityTypeCode'),officeType:headOffice?'head_office':'branch',status:text(row,'ae_status') };
}
export function esmaQuery(start = 0, activityRoot?: string): string {
  const u = new URL(ESMA_ENDPOINT);
  if (activityRoot && !/^ae\d+$/.test(activityRoot)) throw new Error('invalid_esma_id');
  u.searchParams.set('q',activityRoot ? `_root_:${activityRoot} AND entity_type:aeActivity` : 'type_s:parent AND (ae_entityTypeCode:MIF OR ae_entityTypeCode:AIF OR ae_entityTypeCode:UCI)');
  u.searchParams.set('sort','id asc');u.searchParams.set('start',String(start));u.searchParams.set('rows','100');u.searchParams.set('wt','json');return u.href;
}
