import { describe,it,expect,vi } from 'vitest';
import { MicrosoftGraphMailProvider,CORRELATION_PROPERTY } from '../src/mail/microsoft-graph-provider.js';
import { ProviderError } from '../src/mail/provider.js';
const mailboxObjectId='00000000-0000-4000-8000-000000000002';
const correlation='00000000-0000-4000-8000-000000000003';
const tokenProvider={getAccessToken:async()=> 'unit-test-token'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const message={idempotencyKey:correlation,recipientAddress:'person@example.org',subject:'Hello',bodyText:'Body'};
const graphDraft={id:'draft-1',isDraft:true,subject:'Hello',body:{contentType:'text',content:'Body'},toRecipients:[{emailAddress:{address:'person@example.org'}}],ccRecipients:[],bccRecipients:[],singleValueExtendedProperties:[{id:CORRELATION_PROPERTY,value:correlation}]};
describe('Autopilot Graph contracts',()=> {
  it('continues real OData nextLink/deltaLink without changing opaque tokens',async()=> {
    const cursor=`https://graph.microsoft.com/v1.0/users/${mailboxObjectId}/mailFolders('AQMk_example==')/messages/delta?$skiptoken=opaque%2Bvalue`;
    const delta=cursor.replace('$skiptoken=opaque%2Bvalue','$deltatoken=next%2Bvalue');
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json({value:[],'@odata.deltaLink':delta}));
    const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher});
    expect(await provider.getDeltaPage('AQMk_example==',cursor)).toMatchObject({deltaLink:delta});
    expect(fetcher.mock.calls[0]![0]).toBe(cursor);
  });
  it('rejects OData cursor origin/mailbox/operation escapes before any request',async()=> {
    const root=`https://graph.microsoft.com/v1.0/users/${mailboxObjectId}`;
    for(const cursor of [
      `${root}/mailFolders('folder')/messages`,`${root}/mailFolders('folder')/messages/delta/extra`,
      `${root}/mailFolders('folder')/messages/delta#fragment`,`${root}/mailFolders('folder')/messages/delta`.replace(mailboxObjectId,'other'),
      `${root}/mailFolders('folder')/messages/delta`.replace('graph.microsoft.com','attacker.example'),
      `${root}/mailFolders('folder')/messages/delta`.replace('https://','https://user:pass@'),
    ]) {
      const fetcher=vi.fn<typeof fetch>();const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher});
      await expect(provider.getDeltaPage('folder',cursor)).rejects.toMatchObject({code:'unsafe_graph_cursor'});expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it('tags creation with the queryable property and a custom header',async()=> {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json(graphDraft,201));
    const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher,accessStage:'drafts'});
    await provider.createDraft(message);
    const payload=JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(payload.singleValueExtendedProperties).toEqual([{id:CORRELATION_PROPERTY,value:correlation}]);
    expect(payload.internetMessageHeaders[0]).toMatchObject({name:'x-gordion-message-id',value:correlation});
    expect(fetcher.mock.calls[0]![1]!.redirect).toBe('error');
  });
  it('never retries a draft-creation timeout or send timeout',async()=> {
    const fetcher=vi.fn<typeof fetch>().mockRejectedValue(new Error('simulated disconnect after remote side effect'));
    const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher,accessStage:'send',liveSendEnabled:true});
    await expect(provider.createDraft(message)).rejects.toMatchObject({uncertain:true});
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(provider.sendDraft('draft')).rejects.toMatchObject({uncertain:true});expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('returns acceptance, never labels it delivered',async()=> {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:202,headers:{'request-id':'accepted'}}));
    const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher,accessStage:'send',liveSendEnabled:true});
    expect(await provider.sendDraft('draft')).toEqual({requestId:'accepted'});
  });
  it('creates reply in the original thread with explicit To and empty CC/BCC, then rereads',async()=> {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json(graphDraft,201)).mockResolvedValueOnce(json(graphDraft)).mockResolvedValueOnce(json({value:[]}));
    const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher,accessStage:'drafts'});
    expect(await provider.createReplyDraft('parent/id',message)).toMatchObject({correlationId:correlation,ccAddresses:[],bccAddresses:[]});
    expect(String(fetcher.mock.calls[0]![0])).toContain('/messages/parent%2Fid/createReplyAll');
    const payload=JSON.parse(fetcher.mock.calls[0]![1]!.body as string).message;
    expect(payload.toRecipients).toEqual([{emailAddress:{address:message.recipientAddress}}]);expect(payload.ccRecipients).toEqual([]);expect(payload.bccRecipients).toEqual([]);
  });
  it('treats successful reply creation followed by failed verification as uncertain',async()=> {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json(graphDraft,201)).mockResolvedValue(json({error:{code:'ErrorAccessDenied'}},403));
    const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher,accessStage:'drafts'});
    await expect(provider.createReplyDraft('parent',message)).rejects.toMatchObject({uncertain:true});
    expect(fetcher.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
  });
  it('blocks every write in shadow/read-only mode',async()=> {
    const fetcher=vi.fn<typeof fetch>();const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher});
    await expect(provider.createDraft(message)).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.createReplyDraft('parent',message)).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.sendDraft('draft')).rejects.toBeInstanceOf(ProviderError);expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects malformed delta payloads instead of reporting a fresh empty mailbox',async()=> {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json({value:[]}));const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher});
    await expect(provider.getDeltaPage('junkemail')).rejects.toMatchObject({code:'invalid_delta_response'});
  });
  it('does not follow a correlation pagination URL into a different mailbox',async()=> {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json({value:[],'@odata.nextLink':'https://graph.microsoft.com/v1.0/users/other/messages'}));
    const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher});
    await expect(provider.findByCorrelation(correlation)).rejects.toMatchObject({code:'unsafe_graph_cursor'});expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects unexpected attachments even when no logo was selected',async()=> {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json(graphDraft)).mockResolvedValueOnce(json({value:[{name:'unexpected.pdf'}]}));
    const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher});
    await expect(provider.getMessage('draft')).rejects.toMatchObject({code:'unexpected_attachment'});
  });
  it('surfaces a long Retry-After instead of blocking the worker or retrying too early',async()=> {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({error:{code:'TooManyRequests'}}),{status:429,headers:{'retry-after':'180'}}));
    const provider=new MicrosoftGraphMailProvider({mailboxObjectId,tokenProvider,fetchImplementation:fetcher});
    await expect(provider.getDeltaPage('inbox')).rejects.toMatchObject({status:429,retryAfterSeconds:180});expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
