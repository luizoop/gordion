import { parse } from 'parse5';
import { z } from 'zod';
import type { Category } from '../domain/autopilot.js';

type Node = { nodeName:string; value?:string; attrs?:Array<{name:string;value:string}>; childNodes?:Node[] };
const ignored = new Set(['script','style','noscript','template','svg']);
function nodeText(n:Node):string { return ignored.has(n.nodeName) ? '' : n.value || (n.childNodes || []).map(nodeText).join(' '); }
export function inspectWebsite(html:string, sourceUrl:string) {
  const root = parse(html) as unknown as Node;
  const text = nodeText(root).replace(/\s+/g,' ').trim();
  if (/captcha|verify you are human|access denied|automated access (is )?(prohibited|not permitted)|scraping (is )?(prohibited|not permitted)/i.test(text)) throw new Error('site_access_restricted');
  const links = new Set<string>(), findings = new Map<string,{email:string;role:string;kind:'personal'|'functional';excerpt:string}>();
  function visit(n:Node, context:Node) {
    if (ignored.has(n.nodeName)) return;
    const block = ['p','li','td','article','section'].includes(n.nodeName) ? n : context;
    const href = n.attrs?.find(a=>a.name === 'href')?.value;
    if (href && !href.startsWith('mailto:')) {
      try { const url=new URL(href,sourceUrl); if (/kontakt|contact|team|about|impressum|legal|compliance|execution|ausf.hr|service|leistung|trading/i.test(href+' '+nodeText(n))) links.add(url.href); } catch { /* not a URL */ }
    }
    const candidates = `${href?.startsWith('mailto:') ? decodeURIComponent(href.slice(7).split('?')[0]!) : ''} ${n.value || ''}`.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    for (const raw of candidates) {
      const email = raw.toLowerCase(); if (!z.email().safeParse(email).success) continue;
      const [local,domain] = email.split('@') as [string,string];
      const host = new URL(sourceUrl).hostname.replace(/^www\./,'');
      if (domain !== host && !domain.endsWith(`.${host}`)) continue;
      if (/^(info|hello|contact|kontakt|office|support|sales|marketing|press|presse|privacy|datenschutz|jobs|careers|abuse|noreply|no-reply)([.+_-]|$)/i.test(local)) continue;
      const excerpt=nodeText(block).replace(/\s+/g,' ').slice(0,1500);
      const roleMatch = excerpt.match(/chief executive officer|chief operating officer|managing director|geschäftsführer(?:in)?|geschäftsführung|\bCEO\b|\bCOO\b|(?:head of |chief )?compliance(?: officer)?|(?:head of )?trading|(?:head of )?operations/iu);
      const functional = /^(compliance|trading|operations|geschaeftsfuehrung|management|ceo|coo)([.+_-]|$)/i.test(local);
      if (!functional && (block===root || excerpt.length>600 || (excerpt.match(/@/g)||[]).length>1)) continue;
      if (!roleMatch && !functional) continue;
      findings.set(email,{email,role:roleMatch?.[0] || local,kind:functional?'functional':'personal',excerpt});
    }
    for (const child of n.childNodes || []) visit(child,block);
  }
  visit(root,root);
  return {text,links:[...links],contacts:[...findings.values()]};
}
// Category is independent from suitability. A register authorisation alone is insufficient.
export function assessSuitability(entityTypes:string[], activeActivities:string[], text:string): {category:Category;suitability:'eligible'|'unverified'|'conflict';facts:string[]} {
  const authorizedExecution = activeActivities.some(a=>/execution of orders on behalf of clients/i.test(a));
  const execution = text.match(/we execute (?:our )?client orders|we provide (?:order )?execution services (?:to|for) (?:our )?clients|wir führen (?:die )?(?:orders|aufträge|wertpapieraufträge) (?:unserer|für unsere) kunden aus/iu);
  const credit = /(?:authorised|authorized|licensed) credit institution|kreditinstitut im sinne (?:des|von) §\s*1/i.test(text);
  const management = /we (?:provide|offer) (?:discretionary )?portfolio management|wir (?:bieten|erbringen) (?:individuelle )?finanzportfolioverwaltung/i.test(text);
  const category:Category = credit?'bank':management?'asset_manager':entityTypes.includes('MIF')?'broker':'general';
  return {category,suitability:authorizedExecution && execution ? 'eligible':'unverified',facts:[...(authorizedExecution?['register:active_client_order_execution']:[]),...(execution?[`website:${execution[0]}`]:[]),...(credit?['website:credit_institution']:[]),...(management?['website:portfolio_management']:[])]};
}
