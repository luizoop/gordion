import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export const CRAWLER = 'GordionResearchBot';
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0:|db8:|10:|20:)/i.test(address) && !/^2002:/i.test(address);
  if (family !== 4) return false;
  const [a,b,c] = address.split('.').map(Number) as [number,number,number,number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99) || (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export function safePublicUrl(value: string): URL {
  const u = new URL(value);
  if (!['https:','http:'].includes(u.protocol) || u.username || u.password || u.port || u.hostname.endsWith('.local') || !u.hostname.includes('.') ||
      (isIP(u.hostname.replace(/[\[\]]/g,'')) && !publicAddress(u.hostname.replace(/[\[\]]/g,'')))) throw new Error('unsafe_public_url');
  u.hash = ''; return u;
}
export interface PublicPage { url: string; status: number; contentType: string; body: string; retryAfterSeconds:number|null; }
// Resolve once and pin that exact address to the socket; validation alone followed by fetch permits DNS rebinding.
export async function publicGet(value: string, beforeRequest: (url: URL) => Promise<void>, maxBytes = 1_500_000, redirects = 0): Promise<PublicPage> {
  if (redirects > 3) throw new Error('redirect_limit');
  const u = safePublicUrl(value);
  const addresses = await lookup(u.hostname, { all:true, verbatim:true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('non_public_dns');
  await beforeRequest(u);
  const pinned = addresses[0]!;
  const response = await new Promise<{ status:number; location?: string; contentType:string; body:string; retryAfterSeconds:number|null }>((resolve,reject) => {
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
      method:'GET', headers:{ 'user-agent':`${CRAWLER}/1.0 (+https://www.gordion.io/)`,accept:'text/html,application/json,text/plain;q=0.8','accept-encoding':'identity' },
      lookup: ((_hostname: unknown, options: unknown, cb: (...args: unknown[]) => void) => {
        if ((options as {all?: boolean}).all) cb(null,[pinned]); else cb(null,pinned.address,pinned.family);
      }) as never,
      signal:AbortSignal.timeout(15_000),
    }, res => {
      if (Number(res.headers['content-length'] || 0) > maxBytes || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) { res.destroy(); reject(new Error('page_size_or_encoding')); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data',(chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) { res.destroy(); reject(new Error('page_too_large')); } else chunks.push(chunk); });
      res.on('error',reject);
      const retry=res.headers['retry-after'];const seconds=retry?Number(retry):NaN;
      const retryAfterSeconds=Number.isFinite(seconds)?Math.max(0,seconds):retry && Number.isFinite(Date.parse(retry))?Math.max(0,Math.ceil((Date.parse(retry)-Date.now())/1000)):null;
      res.on('end',() => resolve({status:res.statusCode || 0,...(res.headers.location ? {location:res.headers.location} : {}),contentType:res.headers['content-type'] || '',body:Buffer.concat(chunks).toString('utf8'),retryAfterSeconds}));
    }); req.on('error',reject); req.end();
  });
  if (response.status >= 300 && response.status < 400 && response.location) {
    const next = safePublicUrl(new URL(response.location,u).href);
    if (u.protocol === 'https:' && next.protocol !== 'https:') throw new Error('unsafe_redirect_downgrade');
    // Only www/non-www redirects are automatic. Cross-domain moves require a new sourced URL.
    if (next.hostname.replace(/^www\./,'') !== u.hostname.replace(/^www\./,'')) throw new Error('cross_domain_redirect');
    return publicGet(next.href,beforeRequest,maxBytes,redirects+1);
  }
  return {url:u.href,status:response.status,contentType:response.contentType,body:response.body,retryAfterSeconds:response.retryAfterSeconds};
}

export function robotsAllowed(text: string, url: URL): boolean {
  const groups: Array<{ agents:string[]; rules:Array<{allow:boolean;path:string}>;longDelay:boolean }> = [];
  let group = {agents:[] as string[],rules:[] as Array<{allow:boolean;path:string}>,longDelay:false};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0]?.trim() || ''; const colon = line.indexOf(':'); if (colon < 0) continue;
    const key = line.slice(0,colon).trim().toLowerCase(), value = line.slice(colon+1).trim();
    if (key === 'user-agent') { if (group.rules.length || group.longDelay) { groups.push(group); group={agents:[],rules:[],longDelay:false}; } group.agents.push(value.toLowerCase()); }
    else if (['allow','disallow'].includes(key) && group.agents.length && value) group.rules.push({allow:key === 'allow',path:value});
    // A crawler that cannot honor a site's custom crawl-delay must not ignore it.
    else if (key === 'crawl-delay' && Number(value) > 5 && group.agents.length) group.longDelay=true;
  }
  groups.push(group);
  const specific = groups.filter(g=>g.agents.some(a=>a !== '*' && CRAWLER.toLowerCase().startsWith(a)));
  const applicable = specific.length ? specific : groups.filter(g=>g.agents.includes('*'));
  if(applicable.some(g=>g.longDelay || g.rules.some(r=>r.path.length>2000 || (r.path.match(/\*/g)||[]).length>10))) return false;
  const matches = applicable.flatMap(g=>g.rules).filter(rule=> {
    const end = rule.path.endsWith('$'); const raw = end ? rule.path.slice(0,-1) : rule.path;
    const pattern = raw.split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
    return new RegExp(`^${pattern}${end ? '$' : ''}`).test(url.pathname+url.search);
  }).sort((a,b)=>b.path.length-a.path.length || Number(b.allow)-Number(a.allow));
  return matches[0]?.allow ?? true;
}
