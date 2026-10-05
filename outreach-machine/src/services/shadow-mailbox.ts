import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';

/** Call only after a successful read-only Graph probe and identity-evidence check.
 * Binding never approves mailbox isolation, historical reconciliation or sending.
 */
export async function bindShadowMailbox(sql:Database,config:AppConfig) {
  if(config.HOST!=='127.0.0.1' || config.MAIL_PROVIDER!=='microsoft_graph' || config.GRAPH_ACCESS_STAGE!=='read_only' || config.LIVE_SEND_ENABLED ||
    !config.OPERATOR_PASSWORD_HASH || !config.GRAPH_TENANT_ID || !config.GRAPH_MAILBOX_OBJECT_ID || !config.GRAPH_SENDER_ADDRESS ||
    !config.GRAPH_CERTIFICATE_PATH || !config.GRAPH_PRIVATE_KEY_PATH || config.GRAPH_CLIENT_SECRET) throw new Error('shadow_runtime_required');
  return sql.begin(async tx=> {
    await tx`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
    const [control]=await tx`SELECT globally_paused FROM system_control WHERE singleton`;
    const [settings]=await tx`SELECT * FROM autopilot_config WHERE singleton FOR UPDATE`;
    if(!control?.globallyPaused || !settings?.paused) throw new Error('pause_before_shadow_binding');
    const connections=await tx`SELECT * FROM mailbox_connections WHERE status<>'disabled' FOR UPDATE`;
    if(connections.length>1) throw new Error('ambiguous_mailbox_binding');
    let mailbox=connections[0];
    if(mailbox && (mailbox.provider!=='microsoft_graph' || mailbox.authMode!=='app_only' ||
      mailbox.tenantId!==config.GRAPH_TENANT_ID || mailbox.mailboxObjectId!==config.GRAPH_MAILBOX_OBJECT_ID ||
      mailbox.senderAddress.toLowerCase()!==config.GRAPH_SENDER_ADDRESS!.toLowerCase() || !['testing','ready'].includes(mailbox.status))) throw new Error('existing_mailbox_mismatch');
    if((settings.mailboxConnectionId && settings.mailboxConnectionId!==mailbox?.id) ||
       (config.MAILBOX_CONNECTION_ID && config.MAILBOX_CONNECTION_ID!==mailbox?.id)) throw new Error('existing_binding_mismatch');
    if(!mailbox) [mailbox]=await tx`INSERT INTO mailbox_connections(name,provider,auth_mode,tenant_id,mailbox_object_id,sender_address,status,last_auth_check_at)
      VALUES('Local read-only outreach mailbox','microsoft_graph','app_only',${config.GRAPH_TENANT_ID!},${config.GRAPH_MAILBOX_OBJECT_ID!},${config.GRAPH_SENDER_ADDRESS!},'testing',now()) RETURNING *`;
    else await tx`UPDATE mailbox_connections SET last_auth_check_at=now() WHERE id=${mailbox.id}`;
    const [updated]=await tx`UPDATE autopilot_config SET mailbox_connection_id=${mailbox!.id},mode='shadow',paused=true,
      startup_reconciled_at=NULL,version=version+1,updated_at=now() WHERE singleton RETURNING version`;
    await tx`INSERT INTO autopilot_decisions(config_version,action,actor,detail)
      VALUES(${updated!.version},'bind_shadow','local-shadow-launcher',${tx.json({mailboxConnectionId:mailbox!.id,mode:'shadow',providerWrites:false,legalApprovals:false})})`;
    return mailbox!.id as string;
  });
}
