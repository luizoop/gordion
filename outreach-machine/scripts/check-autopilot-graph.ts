import { loadConfig } from '../src/config.js';
import { createMailProvider } from '../src/mail/provider-factory.js';
import type { AutopilotMailProvider } from '../src/mail/provider.js';
import { ProviderError } from '../src/mail/provider.js';
// Explicitly read-only, regardless of runtime config. Does not create drafts, bind a DB mailbox, or approve checks.
try {
  const config=loadConfig({...process.env,DATABASE_URL:'unused-read-only-check',ADMIN_API_KEY:'offline-check-no-http-server-key-000000',MAIL_PROVIDER:'microsoft_graph',LOCAL_DASHBOARD_ENABLED:'false',LIVE_SEND_ENABLED:'false',GRAPH_ACCESS_STAGE:'read_only'});
  const provider=createMailProvider(config) as AutopilotMailProvider;
  const folders=await provider.listFolders();let sampledMessages=0;
  for(const folder of folders) {const page=await provider.getDeltaPage(folder.id);sampledMessages+=page.messages.length;}
  console.log({mode:'read_only',folders:folders.length,sampledMessages,fullSyncCompleted:false,writes:0,sends:0,mailboxIsolationNegativeControl:'not_tested'});
} catch(error) {
  console.error({check:'failed',code:error instanceof ProviderError?error.code:'configuration_or_response_error',status:error instanceof ProviderError?error.status:null,writes:0,sends:0});process.exitCode=1;
}
