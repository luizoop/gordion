import type postgres from 'postgres';

export async function mailboxBudgetCounts(tx:postgres.TransactionSql,mailboxId:string,at:Date) {
  const [counts]=await tx`SELECT count(*) FILTER(WHERE state IN ('reserved','uncertain','accepted') OR (coalesce(sent_at,reserved_at) AT TIME ZONE 'Europe/Berlin')::date=(${at}::timestamptz AT TIME ZONE 'Europe/Berlin')::date)::int AS daily,
    count(*) FILTER(WHERE state IN ('reserved','uncertain','accepted') OR coalesce(sent_at,reserved_at)>${at}::timestamptz-interval '24 hours')::int AS rolling
    FROM mailbox_send_ledger WHERE mailbox_connection_id=${mailboxId} AND state<>'released'`;
  return counts as {daily:number;rolling:number};
}

// A crash can leave both a local reservation and an independently observed Sent
// item. They describe one send. Only merge an unassigned observation after the
// caller has established the exact mailbox/message identity.
export async function confirmMailboxSend(tx:postgres.TransactionSql,mailboxId:string,messageId:string,providerId:string,sentAt:string|Date) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mailbox-budget:${mailboxId}`},0))`;
  const [observed]=await tx`SELECT id,message_id FROM mailbox_send_ledger WHERE mailbox_connection_id=${mailboxId} AND provider_id=${providerId} FOR UPDATE`;
  if(observed?.messageId && observed.messageId!==messageId) throw new Error('provider_message_already_assigned');
  const [reserved]=await tx`SELECT id FROM mailbox_send_ledger WHERE message_id=${messageId} FOR UPDATE`;
  if(observed && reserved && observed.id!==reserved.id) {
    await tx`DELETE FROM mailbox_send_ledger WHERE id=${observed.id} AND message_id IS NULL`;
  } else if(observed && !reserved) {
    await tx`UPDATE mailbox_send_ledger SET message_id=${messageId},state='confirmed',sent_at=${sentAt} WHERE id=${observed.id}`;
    return;
  }
  await tx`INSERT INTO mailbox_send_ledger(mailbox_connection_id,message_id,provider_id,state,sent_at)
    VALUES(${mailboxId},${messageId},${providerId},'confirmed',${sentAt})
    ON CONFLICT(message_id) DO UPDATE SET provider_id=EXCLUDED.provider_id,state='confirmed',sent_at=EXCLUDED.sent_at`;
}
