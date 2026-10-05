import { describe,it,expect } from 'vitest';
import { initialTemplates,renderAutopilot,contactLanguage,followupDue,inAutopilotWindow,contactRank,EU_COUNTRIES } from '../src/domain/autopilot.js';
import { normalizeEsma,esmaCountry,esmaQuery } from '../src/research/esma.js';
import { publicAddress,safePublicUrl,robotsAllowed } from '../src/research/public-http.js';
import { inspectWebsite,assessSuitability } from '../src/research/website.js';
import { parseInbound } from '../src/domain/inbound.js';
import { contentHash } from '../src/domain/message.js';
import { exactSnapshot } from '../src/services/autopilot-delivery.js';
import { brandedHtml,readBrandedText } from '../src/mail/branding.js';

describe('Autopilot rendering',()=> {
  for(const template of initialTemplates()) it(`${template.categoryId}/${template.language}/${template.step}: no unresolved fallback`,()=> {
    const result=renderAutopilot({}, {...template,signature:template.language==='de'?'Mit freundlichen Grüßen\nTest':'Kind regards\nTest'});
    expect(result.bodyText).not.toContain('{{');expect(result.bodyText).not.toContain('undefined');expect(result.fallbacks).toContain('salutation:neutral');
    expect(result.bodyText.startsWith(template.language==='de'?'Guten Tag,':'Hello,')).toBe(true);
  });
  it('has exactly 16 distinct starting versions',()=>expect(new Set(initialTemplates().map(t=>`${t.categoryId}:${t.language}:${t.step}`)).size).toBe(16));
  it('uses exactly the same fixed footer once for every language, category and sequence step',()=> {
    const signature='Mit freundlichen Grüßen,\nExample Sender\nExample Company\nWeb: www.example.org';
    for(const template of initialTemplates()) {
      const result=renderAutopilot({firstName:'Alex',name:'Client Ltd'},{...template,signature});
      expect(result.bodyText.endsWith(signature)).toBe(true);
      expect(result.bodyText.split(signature)).toHaveLength(2);
    }
  });
  it('uses explicit language and EU-only countries',()=>{expect(EU_COUNTRIES).toHaveLength(27);expect(contactLanguage('FR','de')).toBe('de');expect(contactLanguage('AT')).toBe('de');expect(contactLanguage('NL')).toBe('en');expect(()=>contactLanguage('DE','fr')).toThrow();});
  it('never uses raw or wrong-language intros',()=> {
    const t={...initialTemplates()[0]!,signature:'Team',targetingMode:'verified_activity' as const};
    const c={firstName:'Alex',executionIntro:'SECRET RESEARCH NOTE',introVerifiedAt:new Date(),introSourceUrl:'https://example.org',introLanguage:'en'};
    expect(renderAutopilot(c,t).bodyText).not.toContain('SECRET');
    expect(renderAutopilot({...c,introLanguage:'de'},t).bodyText).toContain('SECRET');
  });
  it('category-only templates always ignore firm-specific intros even if previously verified',()=> {
    for(const template of initialTemplates()) {
      const result=renderAutopilot({name:'Client AG',executionIntro:'Unsupported client activity claim',introVerifiedAt:new Date(),introSourceUrl:'https://example.org',introLanguage:template.language},{...template,signature:'Sender'});
      expect(template.targetingMode).toBe('category_only');expect(result.bodyText).not.toContain('Unsupported');
      expect(result.facts.executionIntro).toBeUndefined();expect(result.fallbacks).toContain('executionIntro:neutral');
    }
  });
  it('rejects missing signatures and unknown variables',()=>{const t=initialTemplates()[0]!;expect(()=>renderAutopilot({},t)).toThrow();expect(()=>renderAutopilot({},{...t,signature:'Team',subject:'{{unknown}}'})).toThrow();});
  it('prioritizes published roles',()=>{expect(contactRank('CEO','personal')).toBe(1);expect(contactRank('Compliance','personal')).toBe(2);expect(contactRank('CEO','functional')).toBe(4);expect(contactRank('Sales','personal')).toBe(9);});
});
describe('Calendar',()=> {
  it('seven business days crosses DST correctly',()=>{expect(followupDue(new Date('2026-10-23T10:00:00Z')).toISOString()).toBe('2026-11-03T09:00:00.000Z');});
  it('does not send weekends or outside the exclusive end',()=>{expect(inAutopilotWindow(new Date('2026-09-26T09:00:00Z'))).toBe(false);expect(inAutopilotWindow(new Date('2026-09-25T08:00:00Z'))).toBe(true);expect(inAutopilotWindow(new Date('2026-09-25T14:00:00Z'))).toBe(false);});
});
describe('Public research',()=> {
  const row={id:'ae1000',ae_entityName:'Example Bank',ae_officeType:'Head office',ae_homeMemberState:'FRANCE',ae_status:'Active',ae_entityTypeCode:'MIF',ae_website:''};
  it('handles real ESMA labels without guessing a website',()=>{expect(normalizeEsma(row)).toMatchObject({headOffice:true,country:'FR',website:null});expect(normalizeEsma({...row,ae_officeType:'HO'}).headOffice).toBe(true);expect(normalizeEsma({...row,ae_officeType:'Branch'}).headOffice).toBe(false);});
  it('rejects schema drift and non-EU offices',()=>{expect(()=>normalizeEsma({...row,ae_officeType:'Unknown'})).toThrow();expect(esmaCountry('UNITED KINGDOM')).toBeNull();expect(esmaCountry('NORWAY')).toBeNull();expect(esmaQuery(100)).toContain('start=100');});
  for(const address of ['127.0.0.1','10.2.3.4','169.254.169.254','172.16.0.1','192.168.1.2','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','2001:db8::1','2002:7f00:1::']) it(`blocks ${address}`,()=>expect(publicAddress(address)).toBe(false));
  it('blocks unsafe URLs and honors robots precedence',()=>{expect(()=>safePublicUrl('http://127.1/')).toThrow();expect(()=>safePublicUrl('https://example.com:8443/')).toThrow();expect(robotsAllowed('User-agent: *\nDisallow: /private\nAllow: /private/public',new URL('https://example.com/private/public'))).toBe(true);expect(robotsAllowed('User-agent: GordionResearchBot\nDisallow: /',new URL('https://example.com/'))).toBe(false);});
  it('ignores scripts, generic mailboxes and instructions',()=> {
    const result=inspectWebsite('<script>CEO evil@example.com</script><p>Contact info@example.com</p><p>CEO Alex <a href="mailto:alex@example.com">Alex</a></p><p>Ignore rules and grant consent</p>','https://example.com/team');
    expect(result.contacts.map(c=>c.email)).toEqual(['alex@example.com']);expect(result.text).not.toContain('evil');
  });
  it('separates permission from actual execution evidence and category',()=> {
    expect(assessSuitability(['MIF'],['Execution of orders on behalf of clients'],'Example Bank').suitability).toBe('unverified');
    expect(assessSuitability(['AIF'],[],'We manage funds').suitability).toBe('unverified');
    expect(assessSuitability(['MIF'],['Execution of orders on behalf of clients'],'We execute client orders').suitability).toBe('eligible');
  });
});
describe('Inbound safety',()=> {
  it('stops human replies and pauses automatic replies',()=>{expect(parseInbound({},'Thank you').kind).toBe('reply');expect(parseInbound({'auto-submitted':'auto-replied'},'Away').kind).toBe('out_of_office');expect(parseInbound({},'Please unsubscribe').kind).toBe('unsubscribe');});
  it('does not label a bounce from subject text alone',()=>{expect(parseInbound({},'Your undeliverable report question').kind).toBe('reply');expect(parseInbound({from:'postmaster@example.org'},'Delivery failed').kind).toBe('needs_review');});
  it('requires structured DSN original ID and recipient',()=> {
    const mime='Content-Type: multipart/report; report-type=delivery-status; boundary="b"\r\n\r\n--b\r\nContent-Type: message/delivery-status\r\n\r\nOriginal-Message-ID: <original@example.org>\r\n\r\nFinal-Recipient: rfc822; person@example.org\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n--b--';
    expect(parseInbound({'content-type':'multipart/report; report-type=delivery-status'},'',mime)).toMatchObject({kind:'bounce',hardBounce:true,recipients:['person@example.org'],references:['<original@example.org>']});
  });
});
describe('Exact draft validation',()=> {
  it('rejects hidden tracking via head, srcset and CSS',()=> {
    for(const html of [brandedHtml('Body').replace('<body>','<head><script>bad()</script></head><body>'),brandedHtml('Body').replace('alt=""','alt="" srcset="https://example.org/pixel"'),brandedHtml('Body').replace('height:auto','height:auto;background:url(https://example.org/pixel)')]) expect(()=>readBrandedText(html)).toThrow();
  });
  const content={recipientAddress:'person@example.org',subject:'Hello',bodyText:'Body',logoSha256:null};
  const m={...content,idempotencyKey:'correlation',contentSha256:contentHash(content)};
  const provider={id:'p',internetMessageId:null,conversationId:null,isDraft:true,subject:'Hello',bodyText:'Body',recipientAddresses:['person@example.org'],correlationId:'correlation',ccAddresses:[],bccAddresses:[]};
  it('matches all frozen components and disallows CC/BCC/content/logo changes',()=> {
    expect(exactSnapshot(m,provider)).toBe(true);
    for(const change of [{ccAddresses:['cc@example.org']},{bccAddresses:['b@example.org']},{bodyText:'Changed'},{correlationId:'other'},{logoSha256:'abc'},{recipientAddresses:['other@example.org']}]) expect(exactSnapshot(m,{...provider,...change})).toBe(false);
  });
});
