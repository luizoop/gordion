export function parseHeaders(raw:string):Record<string,string> {
  const out:Record<string,string>={};
  for(const line of raw.replace(/\r?\n[ \t]+/g,' ').split(/\r?\n/)) {
    const colon=line.indexOf(':');if(colon<1) continue;const key=line.slice(0,colon).trim().toLowerCase();out[key]=[out[key],line.slice(colon+1).trim()].filter(Boolean).join(' ');
  }return out;
}
export interface InboundSignal {kind:'reply'|'out_of_office'|'bounce'|'unsubscribe'|'needs_review';hardBounce:boolean;references:string[];recipients:string[];}
export function parseInbound(headers:Record<string,string>,text:string,mime?:string):InboundSignal {
  const references=(headers['in-reply-to']+' '+headers.references).match(/<[^<>\s]+>/g)||[];
  const result:InboundSignal={kind:'reply',hardBounce:false,references,recipients:[]};
  const suspectedDsn=/report-type\s*=\s*"?delivery-status/i.test(headers['content-type'] || '') || /mailer-daemon|postmaster/i.test(headers.from || '');
  if(suspectedDsn) {
    result.kind='needs_review';
    if(!mime) return result;
    let structured=false,failed=false,hard=false;
    function part(raw:string,depth:number) {
      if(depth>6 || raw.length>4_000_000) return;
      const split=raw.search(/\r?\n\r?\n/);if(split<0) return;
      const h=parseHeaders(raw.slice(0,split));let body=raw.slice(split).replace(/^\r?\n\r?\n/,'');
      const ct=h['content-type'] || '';
      if(h['content-transfer-encoding']==='base64') body=Buffer.from(body.replace(/\s/g,''),'base64').toString('utf8');
      if(/^multipart\//i.test(ct)) {
        const boundary=ct.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);const value=boundary?.[1]||boundary?.[2];
        if(value) for(const child of body.split(`--${value}`).slice(1)) if(!child.startsWith('--')) part(child.replace(/^\r?\n/,''),depth+1);
      } else if(/^message\/delivery-status/i.test(ct)) {
        structured=true;
        for(const block of body.split(/\r?\n\r?\n/)) {
          const fields=parseHeaders(block);
          const recipient=(fields['final-recipient']||fields['original-recipient'])?.split(';').slice(1).join(';').trim().toLowerCase();
          if(recipient) result.recipients.push(recipient);
          if(fields.action?.toLowerCase()==='failed') {failed=true;if(/^5\.\d{1,3}\.\d{1,3}$/.test(fields.status || '')) hard=true;}
          const id=fields['original-message-id'];if(id && /^<[^<>\s]+>$/.test(id)) result.references.push(id);
        }
      } else if(/^message\/(rfc822|global)|^text\/rfc822-headers/i.test(ct)) {
        const original=parseHeaders(body.split(/\r?\n\r?\n/)[0] || '');if(original['message-id']) result.references.push(original['message-id']);
      }
    }
    part(mime,0);
    if(structured && failed && result.references.length && result.recipients.length) {result.kind='bounce';result.hardBounce=hard;}
    return result;
  }
  if((headers['auto-submitted'] && headers['auto-submitted'].toLowerCase()!=='no') || headers['x-autoreply'] || headers['x-autorespond']) {result.kind='out_of_office';return result;}
  if(/automatic reply|auto-reply|out of office|automatische antwort|abwesenheitsnotiz/i.test(text)) {result.kind='out_of_office';return result;}
  if(/please unsubscribe|remove me from (your|this) list|do not contact|don't contact|keine weiteren (e-?mails|nachrichten)|bitte.{0,30}abmeld|nicht mehr kontaktieren|no further emails/i.test(text)) result.kind='unsubscribe';
  return result;
}
