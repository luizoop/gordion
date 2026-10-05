import type { Database } from '../db.js';
import { CATEGORIES,EU_COUNTRIES,contactLanguage,contactRank,followupDue,renderAutopilot,type LibraryTemplate } from '../domain/autopilot.js';
import { contentHash } from '../domain/message.js';
import { openException } from './autopilot-state.js';
import { senderSignature } from './sender-signature.js';

export async function planAutopilot(sql:Database) {
  return sql.begin(async tx=> {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-autopilot-planner',0))`;
    const [config]=await tx`SELECT * FROM autopilot_config WHERE singleton`;
    if(!config?.mailboxConnectionId || !config.seedReconciledAt) return {prepared:0};
    const signature=await senderSignature(tx);
    if(!signature.id) return {prepared:0};
    let [campaign]=await tx`SELECT * FROM campaigns WHERE autopilot AND mailbox_connection_id=${config.mailboxConnectionId} AND status<>'archived' ORDER BY created_at LIMIT 1`;
    if(!campaign) [campaign]=await tx`INSERT INTO campaigns(name,mailbox_connection_id,autopilot,status,timezone,send_window_start,send_window_end,daily_initial_limit,daily_total_limit,followup_workday_offsets,max_followups,legal_review_reference,target_countries)
      VALUES('EU Autopilot',${config.mailboxConnectionId},true,'paused','Europe/Berlin','10:00','16:00',45,50,ARRAY[7]::smallint[],1,'Per-message reviewed authorization and country rule',${[...EU_COUNTRIES]}) RETURNING *`;
    // Follow-up snapshots use the original contact/facts and the version frozen at enrolment.
    const parents=await tx`SELECT m.*,e.contact_id,e.company_id,e.followup_template_id,ct.language,co.country_code,co.suitability
      FROM messages m JOIN enrollments e ON e.id=m.enrollment_id JOIN campaigns c ON c.id=e.campaign_id
      JOIN contacts ct ON ct.id=e.contact_id JOIN companies co ON co.id=e.company_id
      WHERE c.id=${campaign!.id} AND m.sequence_index=0 AND m.status='sent_confirmed' AND e.status='active'
      AND NOT EXISTS(SELECT 1 FROM messages f WHERE f.enrollment_id=e.id AND f.sequence_index=1)
      ORDER BY m.sent_confirmed_at,m.id LIMIT 50`;
    let prepared=0;
    for(const parent of parents) {
      const due=followupDue(parent.sentConfirmedAt); if(due.getTime()>Date.now()) continue;
      const [template]=await tx`SELECT * FROM template_versions WHERE id=${parent.followupTemplateId} AND status IN ('approved','retired')`;
      if(!template) continue;
      if(!['eligible','unverified'].includes(parent.suitability) || (parent.suitability!=='eligible' && template.targetingMode!=='category_only')) continue;
      const rendered=renderAutopilot(parent.snapshot.contact,{...template,signature:signature.signatureText,useLogo:signature.useLogo} as LibraryTemplate);
      const subject=`Re: ${parent.finalSubject.replace(/^Re:\s*/i,'')}`;
      const hash=contentHash({recipientAddress:parent.recipientAddress,subject,bodyText:rendered.bodyText,logoSha256:signature.logoSha256});
      await tx`INSERT INTO messages(enrollment_id,sequence_index,message_kind,status,recipient_address,final_subject,final_body_text,content_sha256,due_at,approved_at,approved_by,approval_content_sha256,authorization_id,personalization_fallbacks,logo_sha256,template_version_id,country_rule_id,snapshot,parent_message_id,sender_signature_version_id)
        VALUES(${parent.enrollmentId},1,'followup','approved',${parent.recipientAddress},${subject},${rendered.bodyText},${hash},${due},now(),'autopilot-template-policy',${hash},${parent.authorizationId},${tx.json(rendered.fallbacks)},${signature.logoSha256},${template.id},${parent.countryRuleId},${tx.json({...parent.snapshot,targetingMode:template.targetingMode,templateVersionId:template.id,templateVersion:template.version,signature:signature.signatureText,signatureVersionId:signature.id,logoSha256:signature.logoSha256,step:1,facts:rendered.facts,fallbacks:rendered.fallbacks} as never)},${parent.id},${signature.id})`;
      prepared++;
    }
    // SQL excludes ineligible records before batching: UI pagination never limits the eligible population.
    const categories=[...CATEGORIES];const previous=categories.indexOf(config.lastCategory);if(previous>=0) categories.push(...categories.splice(0,previous+1));
    for(const category of categories) {
      // Preserve PostgreSQL microseconds: JavaScript Date truncation would repeat
      // the last row forever when an entire page cannot be prepared.
      let afterCreated:string|null=null,afterId:string|null=null;
      const categoryStart=prepared;
      while(prepared-categoryStart<25) {
      const companies:Array<{id:string;pageCreatedAt:string;countryCode:string;name:string;suitability:string;suitabilityEvidence:unknown}>=await tx`SELECT co.*,co.created_at::text AS page_created_at FROM companies co WHERE co.country_code::text=ANY(${[...EU_COUNTRIES]}::text[])
        AND (${afterCreated}::text IS NULL OR (co.created_at,co.id)>(${afterCreated}::text::timestamptz,${afterId}::uuid))
        AND co.suitability IN ('eligible','unverified') AND co.category_id=${category} AND co.review_status NOT IN ('rejected','suppressed')
        AND co.researched_at>now()-interval '90 days' AND co.prior_contact_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM company_outreach_history h WHERE h.company_id=co.id)
        AND NOT EXISTS(SELECT 1 FROM enrollments e WHERE e.company_id=co.id)
        AND EXISTS(SELECT 1 FROM contacts ct JOIN outreach_authorizations a ON a.contact_id=ct.id JOIN country_send_rules r ON r.id=a.country_rule_id
          WHERE ct.company_id=co.id AND ct.review_status='eligible' AND ct.dns_valid AND ct.source_checked_at>now()-interval '90 days'
          AND ct.dns_checked_at>now()-interval '30 days' AND a.revoked_at IS NULL AND a.valid_until>now() AND a.prerequisites_verified_at IS NOT NULL
          AND r.enabled AND r.valid_until>now() AND r.country_code=co.country_code AND r.basis=a.basis
          AND (NOT ct.is_test_data OR a.basis='own_test_address'))
        ORDER BY co.created_at,co.id LIMIT 25`;
      if(!companies.length) break;
      for(const company of companies) {
        afterCreated=company.pageCreatedAt;afterId=company.id;
        const contacts=await tx`SELECT ct.*,a.id AS authorization_id,a.country_rule_id FROM contacts ct
          JOIN LATERAL(SELECT a.* FROM outreach_authorizations a
            JOIN country_send_rules r ON r.id=a.country_rule_id AND r.enabled AND r.valid_until>now() AND r.country_code=${company.countryCode} AND r.basis=a.basis
            WHERE a.contact_id=ct.id AND a.revoked_at IS NULL AND a.valid_until>now() AND a.prerequisites_verified_at IS NOT NULL
            AND (NOT ct.is_test_data OR a.basis='own_test_address') ORDER BY a.verified_at DESC,a.id LIMIT 1) a ON true
          WHERE ct.company_id=${company.id} AND ct.review_status='eligible' AND ct.dns_valid AND ct.dns_checked_at>now()-interval '30 days' AND ct.source_checked_at>now()-interval '90 days'
          AND (NOT ct.is_test_data OR a.basis='own_test_address')
          AND NOT EXISTS(SELECT 1 FROM suppression_entries s WHERE s.active AND (
            (s.scope='email' AND s.normalized_value=ct.email) OR (s.scope='company' AND s.normalized_value=ct.company_id::text::citext)
            OR (s.scope='domain' AND (s.normalized_value=split_part(ct.email::text,'@',2)::citext OR EXISTS(SELECT 1 FROM company_domains d WHERE d.company_id=ct.company_id AND d.domain=s.normalized_value)))))`;
        contacts.sort((a,b)=>contactRank(a.roleTitle,a.contactKind)-contactRank(b.roleTitle,b.contactKind)||b.sourceQuality-a.sourceQuality||b.sourceCheckedAt.getTime()-a.sourceCheckedAt.getTime()||a.id.localeCompare(b.id));
        const contact=contacts.find(c=>contactRank(c.roleTitle,c.contactKind)<9);if(!contact) continue;
        const language=contactLanguage(company.countryCode,contact.language);
        const templates=await tx`SELECT * FROM template_versions WHERE category_id=${category} AND language=${language} AND status='approved' ORDER BY step`;
        const initial=templates.find(t=>t.step===0),followup=templates.find(t=>t.step===1);if(!initial||!followup) continue;
        if(company.suitability!=='eligible' && (initial.targetingMode!=='category_only' || followup.targetingMode!=='category_only')) continue;
        try {
          const frozenContact={firstName:contact.firstName,lastName:contact.lastName,honorific:contact.honorific,name:company.name,roleTitle:contact.roleTitle,executionIntro:contact.executionIntro,introSourceUrl:contact.introSourceUrl,introVerifiedAt:contact.introVerifiedAt,introLanguage:contact.introLanguage};
          const rendered=renderAutopilot(frozenContact,{...initial,signature:signature.signatureText,useLogo:signature.useLogo} as LibraryTemplate);
          const hash=contentHash({recipientAddress:contact.email,subject:rendered.subject,bodyText:rendered.bodyText,logoSha256:signature.logoSha256});
          const [enrollment]=await tx`INSERT INTO enrollments(campaign_id,company_id,contact_id,status,followup_template_id) VALUES(${campaign!.id},${company.id},${contact.id},'active',${followup.id}) RETURNING id`;
          const snapshot={contact:frozenContact,category,language,targetingMode:initial.targetingMode,templateVersionId:initial.id,templateVersion:initial.version,signature:signature.signatureText,signatureVersionId:signature.id,logoSha256:signature.logoSha256,countryRuleId:contact.countryRuleId,sourceUrl:contact.sourceUrl,sourceCheckedAt:contact.sourceCheckedAt,facts:rendered.facts,fallbacks:rendered.fallbacks,suitabilityEvidence:company.suitabilityEvidence};
          await tx`INSERT INTO messages(enrollment_id,sequence_index,message_kind,status,recipient_address,final_subject,final_body_text,content_sha256,due_at,approved_at,approved_by,approval_content_sha256,authorization_id,personalization_fallbacks,logo_sha256,template_version_id,country_rule_id,snapshot,sender_signature_version_id)
            VALUES(${enrollment!.id},0,'initial','approved',${contact.email},${rendered.subject},${rendered.bodyText},${hash},now(),now(),'autopilot-template-policy',${hash},${contact.authorizationId},${tx.json(rendered.fallbacks)},${signature.logoSha256},${initial.id},${contact.countryRuleId},${tx.json(snapshot as never)},${signature.id})`;
          prepared++;
        } catch(e) {
          // Rendering is deterministic; a bad template must not create a provider side effect.
          if((e as {code?:string}).code) throw e;
          await openException(sql,`render:${company.id}`,'personalization_blocked',{},company.id);
        }
        if(prepared-categoryStart>=25) break;
      }
      }
    }
    return {prepared};
  });
}
