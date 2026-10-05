import { describe,it,expect,vi } from 'vitest';
import { PNG } from 'pngjs';
import { normalizeLogo,InvalidLogo } from '../src/mail/logo-assets.js';
import { brandedHtml,digest,logoContentId } from '../src/mail/branding.js';
import { MicrosoftGraphMailProvider } from '../src/mail/microsoft-graph-provider.js';

const png=()=>PNG.sync.write({width:2,height:1,data:Buffer.from([255,0,0,255,0,0,0,0])} as PNG);
describe('Uploaded signature logos',()=>{
  it('validates a PNG and preserves transparent pixels when normalizing',()=>{
    const logo=normalizeLogo(png().toString('base64'));
    expect(logo.sha256).toBe(digest(logo.bytes));
    expect([...PNG.sync.read(logo.bytes).data]).toEqual([255,0,0,255,0,0,0,0]);
  });
  it('rejects SVG/HTML, malformed base64, corruption, trailing content and oversized images',()=>{
    const corrupted=png();corrupted[corrupted.length-1]=corrupted[corrupted.length-1]!^1;
    const huge=png();huge.writeUInt32BE(5000,16);
    for(const value of ['@@@@',Buffer.from('<svg onload="alert(1)"/>').toString('base64'),corrupted.toString('base64'),huge.toString('base64'),Buffer.concat([png(),Buffer.from('<script/>')]).toString('base64'),Buffer.alloc(500_001).toString('base64')]) {
      expect(()=>normalizeLogo(value)).toThrow(InvalidLogo);
    }
  });
  for(const step of ['initial','followup']) it(`embeds the frozen uploaded bytes in ${step}, not the bundled logo`,async()=>{
    const logo=normalizeLogo(png().toString('base64'));
    const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
      if(init?.method==='POST') {
        const body=JSON.parse(String(init.body));const message=step==='followup'?body.message:body;
        expect(message.attachments[0]).toMatchObject({contentType:'image/png',isInline:true,contentId:logoContentId,contentBytes:logo.bytes.toString('base64')});
        expect(message.body.content).toBe(brandedHtml('Body'));
        return Response.json({id:'draft'},{status:201});
      }
      if(String(url).includes('/attachments')) return Response.json({value:[{'@odata.type':'#microsoft.graph.fileAttachment',contentType:'image/png',isInline:true,contentId:logoContentId,contentBytes:logo.bytes.toString('base64')}]});
      return Response.json({id:'draft',isDraft:true,subject:'Hello',body:{contentType:'html',content:brandedHtml('Body')},toRecipients:[{emailAddress:{address:'test@example.test'}}],ccRecipients:[],bccRecipients:[]});
    });
    const loadLogo=vi.fn(async()=>logo);
    const provider=new MicrosoftGraphMailProvider({mailboxObjectId:'test',tokenProvider:{getAccessToken:async()=>'test'},fetchImplementation:fetcher,accessStage:'drafts',loadLogo});
    const message={idempotencyKey:'test',recipientAddress:'test@example.test',subject:'Hello',bodyText:'Body',logoSha256:logo.sha256};
    const result=step==='initial'?await provider.createDraft(message):await provider.createReplyDraft('parent',message);
    expect(loadLogo).toHaveBeenCalledWith(logo.sha256);expect(result.logoSha256).toBe(logo.sha256);
    expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
  });
});
