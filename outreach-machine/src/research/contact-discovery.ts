import {parse} from 'parse5';
import {z} from 'zod';

type Node={nodeName:string;value?:string;attrs?:Array<{name:string;value:string}>;childNodes?:Node[]};
const ignored=new Set(['script','style','noscript','template','svg']);
const textOf=(n:Node):string=>ignored.has(n.nodeName)?'':n.value??(n.childNodes??[]).map(textOf).join(' ');
export interface PublishedContact {email:string;kind:'personal'|'functional'|'unverified';role:string|null;excerpt:string;notes:string[];}
const emailPattern=/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const privacyContext=/data protection|datenschutz|privacy|GDPR|zaštitu osobn|protecția datelor|protecţia datelor|ochrony danych|προστασία.{0,20}δεδομέν|защита.{0,20}данни/i;
const generic=/^(info|hello|contact|kontakt|office|biuro|recepcja|recepcion|support|customerservice|customer.service|clientservice|sales|marketing|commercial|comercial|press|presse|privacy|datenschutz|dpo|gdpr|complaints|reclamatii|jobs|careers|hr|abuse|noreply|no-reply|webmaster)([.+_-]|$)/i;
const functional=/(^|[._-])(compliance|trading|operations|backoffice|frontoffice|management|geschaeftsfuehrung|ceo|coo)([._-]|$)/i;
const roles=/chief executive officer|chief operating officer|managing director|geschäftsführer(?:in)?|geschäftsführung|\bCEO\b|\bCOO\b|(?:head of |chief )compliance(?: officer)?|compliance officer|head of trading|head of operations|director general|director ejecutivo|dyrektor zarządzający|výkonný ředitel|изпълнителен директор|διευθύνων σύμβουλος|vezérigazgató/iu;
const contactLink=/contact|kontakt|team|people|management|leadership|about|impressum|compliance|trading|operations|echipa|conducere|kontakty|zesp[oó]ł|zarz[aą]d|kapcsolat|vezet|t[iý]m|kontakti|uprava|επι[κκ]οινων|ομάδα|διοίκηση|контакт|екип|ръковод|nosotros|equipo/i;
export function discoverContacts(html:string,sourceUrl:string) {
  const root=parse(html) as unknown as Node,plain=textOf(root).replace(/\s+/g,' ').trim();
  if(/verify you are human|access denied|automated access (is )?(prohibited|not permitted)|scraping (is )?(prohibited|not permitted)/i.test(plain)) throw new Error('site_access_restricted');
  const contacts=new Map<string,PublishedContact>(),excluded=new Set<string>(),links=new Set<string>();
  const host=new URL(sourceUrl).hostname.replace(/^www\./,'');
  function visit(node:Node,context:Node,ancestors:Node[]=[]) {
    if(ignored.has(node.nodeName)) return;
    const block=['p','li','td','article','section','address','div'].includes(node.nodeName)?node:context;
    const href=node.attrs?.find(a=>a.name==='href')?.value;
    let mailto='';
    if(href?.startsWith('mailto:')) {try {mailto=decodeURIComponent(href.slice(7).split('?')[0]!);} catch {/* malformed link is data, not a crash */}}
    else if(href && contactLink.test(href+' '+textOf(node))) {
      try {const u=new URL(href,sourceUrl);u.hash='';if(['https:','http:'].includes(u.protocol) && u.hostname.replace(/^www\./,'')===host) links.add(u.href);} catch {/* invalid link */}
    }
    for(const raw of (`${mailto} ${node.value??''}`).match(emailPattern)??[]) {
      const email=raw.toLowerCase();if(!z.email().safeParse(email).success) continue;
      const [local,domain]=email.split('@') as [string,string];
      if(generic.test(local)) {excluded.add(email);continue;}
      // Do not associate external group, vendor or privacy contacts with this
      // legal entity merely because they occur on the same website.
      if(domain!==host && !domain.endsWith(`.${host}`)) {excluded.add(email);continue;}
      const excerpt=textOf(block).replace(/\s+/g,' ').trim().slice(0,1200);
      const role=roles.exec(excerpt.replace(emailPattern,''))?.[0]??null;
      const anchor=[node,...ancestors.slice().reverse()].find(n=>n.nodeName==='a');
      const anchorHref=anchor?.attrs?.find(a=>a.name==='href')?.value??'';
      let mismatch=false;
      if(anchor && anchorHref.startsWith('mailto:')) {
        try {const target=decodeURIComponent(anchorHref.slice(7).split('?')[0]!).toLowerCase();const visible=textOf(anchor).match(emailPattern)??[];mismatch=visible.some(a=>a.toLowerCase()!==target);} catch {mismatch=true;}
      }
      const privacy=[block,...ancestors.slice().reverse()].some(n=> {const text=textOf(n);return text.length<1800 && privacyContext.test(text);});
      const isFunctional=functional.test(local);
      const contextSafe=block!==root && excerpt.length<=700 && (excerpt.match(/@/g)??[]).length<=1;
      const kind=mismatch||privacy?'unverified':isFunctional?'functional':role && contextSafe?'personal':'unverified';
      const candidate:PublishedContact={email,kind,role:kind==='functional'?role??local:kind==='personal'?role:null,excerpt,
        notes:[...(mismatch?['mailto_display_mismatch']:[]),...(privacy?['privacy_contact_context']:[])]};
      const previous=contacts.get(email);
      if(!previous || (previous.kind==='unverified' && kind!=='unverified')) contacts.set(email,candidate);
    }
    for(const child of node.childNodes??[]) visit(child,block,[...ancestors,node]);
  }
  visit(root,root);
  return {contacts:[...contacts.values()],excluded:[...excluded],links:[...links].sort((a,b)=>Number(!/contact|kontakt|контакт|επικοινων|kapcsolat/i.test(a))-Number(!/contact|kontakt|контакт|επικοινων|kapcsolat/i.test(b))),text:plain};
}
