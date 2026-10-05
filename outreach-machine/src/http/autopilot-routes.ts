import type { FastifyInstance,FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import type { AppConfig } from '../config.js';
import { autopilotPreflight,pauseAutopilot } from '../services/autopilot-state.js';
import { CATEGORIES,isEu,renderAutopilot } from '../domain/autopilot.js';
import { senderSignature,saveSenderSignature } from '../services/sender-signature.js';
import { InvalidLogo,loadLogoAsset,MAX_LOGO_UPLOAD_BYTES } from '../mail/logo-assets.js';
import { legalResearchFor,LEGAL_RESEARCH_VERSION } from '../domain/legal-research.js';

const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).default(0)});
const actor=z.string().trim().min(2).max(120);
const text=z.string().trim().min(1).max(10000);
const template=z.strictObject({categoryId:z.enum(CATEGORIES),language:z.enum(['de','en']),step:z.union([z.literal(0),z.literal(1)]),subject:text.max(255),body:text,signature:z.string().max(4000).optional(),useLogo:z.boolean().optional(),targetingMode:z.enum(['verified_activity','category_only']).default('verified_activity')});
export function registerAutopilotRoutes(app:FastifyInstance,sql:Database,config:AppConfig,operator:(r:FastifyRequest)=>boolean) {
  app.get('/v1/autopilot/legal-research',async(request)=> {
    const p=paging.parse(request.query);
    const countries=await sql`SELECT co.country_code,count(DISTINCT co.id)::int AS companies,count(ct.id)::int AS contacts,
      count(ct.id) FILTER(WHERE EXISTS(SELECT 1 FROM outreach_authorizations a JOIN country_send_rules r ON r.id=a.country_rule_id
        WHERE a.contact_id=ct.id AND a.revoked_at IS NULL AND a.valid_until>now() AND a.prerequisites_verified_at IS NOT NULL
        AND r.enabled AND r.valid_until>now() AND r.country_code=co.country_code AND r.basis=a.basis))::int AS documented_basis
      FROM companies co LEFT JOIN contacts ct ON ct.company_id=co.id AND NOT ct.is_test_data
      GROUP BY co.country_code ORDER BY count(DISTINCT co.id) DESC,co.country_code`;
    return {version:LEGAL_RESEARCH_VERSION,total:countries.length,limit:p.limit,offset:p.offset,
      items:countries.slice(p.offset,p.offset+p.limit).map(c=>({...c,research:legalResearchFor(c.countryCode??'')})),
      notice:'Quellenrecherche ist keine Rechtsberatung oder Versandfreigabe. Dokumentierte Basis ist noch keine vollständige Versandbereitschaft.'};
  });
  app.get('/v1/sender-signature',async()=>senderSignature(sql));
  app.get('/v1/sender-signature/logos/:sha256',async(request,reply)=> {
    const {sha256}=z.object({sha256:z.string().regex(/^[0-9a-f]{64}$/)}).parse(request.params);
    try {const logo=await loadLogoAsset(sql,sha256);return reply.type('image/png').header('x-content-type-options','nosniff').send(logo.bytes);}
    catch {return reply.code(404).send({error:'logo_not_found'});}
  });
  app.post('/v1/sender-signature',async(request,reply)=> {
    if(!operator(request)) return reply.code(403).send({error:'operator_login_required'});
    const p=z.strictObject({revision:z.number().int().min(0),signatureText:z.string().trim().min(8).max(4000).refine(v=>!/{{|}}|\$\{|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)),useLogo:z.boolean(),logoBase64:z.string().min(1).max(Math.ceil(MAX_LOGO_UPLOAD_BYTES/3)*4).optional(),actor,confirmation:z.literal('SAVE_SHARED_SIGNATURE')}).parse(request.body);
    let result;
    try {result=await saveSenderSignature(sql,p);} catch(error) {if(error instanceof InvalidLogo) return reply.code(400).send({error:'invalid_logo'});throw error;}
    return result?{saved:true,signature:result,existingMessagesChanged:false}:reply.code(409).send({error:'signature_version_conflict'});
  });
  app.get('/v1/autopilot',async()=> {
    const [settings]=await sql`SELECT * FROM autopilot_config WHERE singleton`;
    const [coverage]=await sql`SELECT count(*)::int AS companies,count(*) FILTER(WHERE suitability='eligible')::int AS suitable,
      count(*) FILTER(WHERE prior_contact_at IS NOT NULL OR EXISTS(SELECT 1 FROM company_outreach_history h WHERE h.company_id=co.id))::int AS contacted,
      count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM contacts ct WHERE ct.company_id=co.id AND dns_valid AND source_checked_at>now()-interval '90 days'))::int AS missing_contacts,
      count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM contacts ct JOIN outreach_authorizations a ON a.contact_id=ct.id WHERE ct.company_id=co.id AND a.revoked_at IS NULL AND a.valid_until>now()))::int AS missing_basis FROM companies co`;
    const messages=await sql`SELECT message_kind,status,count(*)::int AS count FROM messages GROUP BY message_kind,status`;
    const [responses]=await sql`SELECT count(*) FILTER(WHERE classification IN ('reply','positive_reply','negative_reply'))::int AS replies,count(*) FILTER(WHERE hard_bounce)::int AS hard_bounces FROM inbound_messages`;
    const [exceptions]=await sql`SELECT count(*)::int AS count FROM autopilot_exceptions WHERE status='open'`;
    const workers=await sql`SELECT * FROM worker_heartbeats ORDER BY worker`;
    return {settings,coverage,messages,responses,exceptions:exceptions!.count,workers};
  });
  app.get('/v1/autopilot/preflight',async()=>autopilotPreflight(sql,config));
  app.post('/v1/autopilot/configure',async(request,reply)=> {
    if(!operator(request)) return reply.code(403).send({error:'operator_login_required'});
    const p=z.strictObject({version:z.number().int(),mode:z.enum(['simulator','shadow','live']),researchEnabled:z.boolean(),mailboxConnectionId:z.uuid().nullable(),dailyTarget:z.number().int().min(1).max(50),pilotLimit:z.number().int().min(1).max(50),actor,confirmation:z.literal('SAVE_PAUSED_CONFIGURATION')}).parse(request.body);
    if(p.mode==='simulator' && config.MAIL_PROVIDER!=='simulated') return reply.code(409).send({error:'simulator_requires_simulated_provider'});
    if(p.mode==='shadow' && (config.MAIL_PROVIDER!=='microsoft_graph' || config.GRAPH_ACCESS_STAGE!=='read_only' || config.LIVE_SEND_ENABLED)) return reply.code(409).send({error:'shadow_requires_read_only_runtime'});
    if(p.pilotLimit>10) { const [check]=await sql`SELECT name FROM operational_checks WHERE name='scale_review' AND valid_until>now()`;if(!check) return reply.code(409).send({error:'scale_review_required'}); }
    const ok=await sql.begin(async tx=> {
      await tx`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
      const rows=await tx`UPDATE autopilot_config SET mode=${p.mode},research_enabled=${p.researchEnabled},mailbox_connection_id=${p.mailboxConnectionId},daily_target=${p.dailyTarget},pilot_limit=${p.pilotLimit},paused=true,pause_kind='manual',pause_reason='Configuration changed',version=version+1,updated_at=now() WHERE singleton AND version=${p.version} RETURNING version`;
      if(!rows.length) return false;
      await tx`UPDATE system_control SET globally_paused=true,pause_reason='Autopilot configuration changed',updated_by=${p.actor} WHERE singleton`;
      await tx`UPDATE campaigns SET status='paused',live_send_enabled=false WHERE autopilot AND status NOT IN ('archived','completed')`;
      await tx`INSERT INTO autopilot_decisions(config_version,action,actor,detail) VALUES(${rows[0]!.version},'configure',${p.actor},${tx.json(p)})`;return true;
    });return reply.code(ok?200:409).send({saved:ok,paused:true});
  });
  app.post('/v1/autopilot/activate',async(request,reply)=> {
    if(!operator(request)) return reply.code(403).send({error:'operator_login_required'});
    const p=z.strictObject({version:z.number().int(),actor,confirmation:z.literal('ACTIVATE_LIVE_AUTOPILOT')}).parse(request.body);
    const preflight=await autopilotPreflight(sql,config); if(!preflight.ready) return reply.code(409).send(preflight);
    const ok=await sql.begin(async tx=> {
      await tx`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
      const rows=await tx`UPDATE autopilot_config SET paused=false,pause_kind='none',pause_reason='Explicit operator activation',version=version+1,updated_at=now() WHERE singleton AND mode='live' AND version=${p.version} RETURNING version`;
      if(!rows.length) return false;
      await tx`UPDATE system_control SET globally_paused=false,pause_reason='Autopilot activated',updated_by=${p.actor} WHERE singleton`;
      await tx`UPDATE campaigns SET status='active',live_send_enabled=true WHERE autopilot AND mailbox_connection_id=(SELECT mailbox_connection_id FROM autopilot_config WHERE singleton) AND status NOT IN ('archived','completed')`;
      await tx`INSERT INTO autopilot_decisions(config_version,action,actor,detail) VALUES(${rows[0]!.version},'activate',${p.actor},${tx.json({preflightVersion:preflight.configVersion})})`;return true;
    });return reply.code(ok?200:409).send({activated:ok});
  });
  app.post('/v1/autopilot/pause',async(request)=> { const p=z.strictObject({actor,reason:text.max(500)}).parse(request.body);await pauseAutopilot(sql,p.reason,p.actor,true);return {paused:true}; });
  app.post('/v1/autopilot/checks',async(request,reply)=> {
    if(!operator(request)) return reply.code(403).send({error:'operator_login_required'});
    const p=z.strictObject({name:z.enum(['shadow_day','own_address_threading_logo_reply_unsubscribe','backup_restore','mailbox_scope','pilot_review','scale_review']),reference:text.min(12),actor,validUntil:z.iso.datetime({offset:true}),confirmation:z.literal('ATTEST_COMPLETED_CHECK')}).parse(request.body);
    if(Date.parse(p.validUntil)<=Date.now()) return reply.code(400).send({error:'expired_check'});
    await sql`INSERT INTO operational_checks(name,passed_at,valid_until,reference,verified_by) VALUES(${p.name},now(),${p.validUntil},${p.reference},${p.actor}) ON CONFLICT(name) DO UPDATE SET passed_at=now(),valid_until=EXCLUDED.valid_until,reference=EXCLUDED.reference,verified_by=EXCLUDED.verified_by`;
    return {recorded:true};
  });
  app.post('/v1/autopilot/seed-reconciliation',async(request,reply)=> {
    if(!operator(request)) return reply.code(403).send({error:'operator_login_required'});
    const p=z.strictObject({actor,reference:text.min(20),confirmation:z.literal('CONFIRM_PREVIOUS_OUTREACH_RECONCILED')}).parse(request.body);
    await sql.begin(async tx=> {
      await tx`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
      await tx`UPDATE autopilot_config SET seed_reconciled_at=now(),seed_reference=${p.reference},version=version+1 WHERE singleton`;
      await tx`INSERT INTO autopilot_decisions(config_version,action,actor,detail) SELECT version,'seed_reconciled',${p.actor},${tx.json({reference:p.reference})} FROM autopilot_config WHERE singleton`;
    });return {recorded:true};
  });
  app.post('/v1/autopilot/authorizations/:id/rule',async(request,reply)=> {
    if(!operator(request)) return reply.code(403).send({error:'operator_login_required'});
    const {id}=z.object({id:z.uuid()}).parse(request.params);
    const p=z.strictObject({ruleId:z.uuid(),actor,evidence:text.min(20),confirmation:z.literal('VERIFY_COUNTRY_PREREQUISITES')}).parse(request.body);
    const result=await sql.begin(async tx=> {
      await tx`SELECT singleton FROM system_control WHERE singleton FOR UPDATE`;
      const [a]=await tx`SELECT a.id FROM outreach_authorizations a JOIN contacts ct ON ct.id=a.contact_id JOIN companies co ON co.id=ct.company_id JOIN country_send_rules r ON r.id=${p.ruleId} WHERE a.id=${id} AND a.revoked_at IS NULL AND a.valid_until>now() AND r.enabled AND r.valid_until>now() AND r.country_code=co.country_code AND r.basis=a.basis`;
      if(!a) return false;
      await tx`UPDATE outreach_authorizations SET country_rule_id=${p.ruleId},prerequisites_verified_at=now(),prerequisites_verified_by=${p.actor} WHERE id=${id}`;
      await tx`INSERT INTO audit_events(entity_type,entity_id,event_type,actor_type,actor_id,detail) VALUES('authorization',${id},'country_prerequisites.verified','user',${p.actor},${tx.json({ruleId:p.ruleId,evidence:p.evidence})})`;return true;
    });return reply.code(result?200:409).send({verified:result});
  });
  app.get('/v1/research/runs',async(request)=> { const p=paging.parse(request.query);const rows=await sql`SELECT *,count(*) OVER()::int AS total FROM research_runs ORDER BY started_at DESC,id LIMIT ${p.limit} OFFSET ${p.offset}`;return {items:rows,limit:p.limit,offset:p.offset}; });
  app.get('/v1/exceptions',async(request)=> { const p=paging.parse(request.query);const rows=await sql`SELECT ex.*,co.name AS company_name,count(*) OVER()::int AS total FROM autopilot_exceptions ex LEFT JOIN companies co ON co.id=ex.company_id WHERE ex.status='open' ORDER BY ex.created_at,ex.id LIMIT ${p.limit} OFFSET ${p.offset}`;return {items:rows,limit:p.limit,offset:p.offset}; });
  app.get('/v1/templates/versions',async(request)=> {const p=paging.parse(request.query);return {items:await sql`SELECT *,count(*) OVER()::int AS total FROM template_versions ORDER BY category_id,language,step,version DESC LIMIT ${p.limit} OFFSET ${p.offset}`};});
  app.post('/v1/templates/versions',async(request)=> {
    const p=template.parse(request.body);
    return sql.begin(async tx=> {await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-template-seed',0))`;
      const [result]=await tx`INSERT INTO template_versions(category_id,language,step,version,subject,body,signature,use_logo,targeting_mode)
        SELECT ${p.categoryId},${p.language},${p.step},coalesce(max(version),0)+1,${p.subject},${p.body},'',false,${p.targetingMode} FROM template_versions WHERE category_id=${p.categoryId} AND language=${p.language} AND step=${p.step} RETURNING *`;return result;
    });
  });
  app.post('/v1/templates/versions/:id/approve',async(request,reply)=> {
    if(!operator(request)) return reply.code(403).send({error:'operator_login_required'});
    const {id}=z.object({id:z.uuid()}).parse(request.params),p=z.strictObject({actor,confirmation:z.literal('APPROVE_TEMPLATE_VERSION')}).parse(request.body);
    return sql.begin(async tx=> {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-template-seed',0))`;
      const [t]=await tx`SELECT * FROM template_versions WHERE id=${id} AND status='draft' FOR UPDATE`;
      if(!t) return reply.code(409).send({error:'not_draft'});
      const signature=await senderSignature(tx);
      if(!signature.id) return reply.code(409).send({error:'shared_signature_missing'});
      renderAutopilot({},{...t,signature:signature.signatureText,useLogo:signature.useLogo} as never);
      await tx`UPDATE template_versions SET status='retired' WHERE category_id=${t.categoryId} AND language=${t.language} AND step=${t.step} AND status='approved'`;
      await tx`UPDATE template_versions SET status='approved',approved_at=now(),approved_by=${p.actor} WHERE id=${id}`;
      await tx`INSERT INTO audit_events(entity_type,entity_id,event_type,actor_type,actor_id) VALUES('template',${id},'template.approved','user',${p.actor})`;
      return {approved:true};
    });
  });
  app.get('/v1/autopilot/country-rules',async(request)=> {const p=paging.parse(request.query);return {items:await sql`SELECT *,count(*) OVER()::int AS total FROM country_send_rules ORDER BY country_code,version DESC LIMIT ${p.limit} OFFSET ${p.offset}`};});
  app.post('/v1/autopilot/country-rules',async(request,reply)=> {
    if(!operator(request)) return reply.code(403).send({error:'operator_login_required'});
    const p=z.strictObject({countryCode:z.string().refine(isEu),basis:z.enum(['consent','reviewed_customer_exception','own_test_address']),prerequisites:text.min(12),reference:text.min(12),validUntil:z.iso.datetime({offset:true}),actor,confirmation:z.literal('APPROVE_COUNTRY_RULE')}).parse(request.body);
    if(Date.parse(p.validUntil)<=Date.now()) return reply.code(400).send({error:'rule_expired'});
    return sql.begin(async tx=> {await tx`SELECT pg_advisory_xact_lock(hashtextextended('gordion-country-rules',0))`;
      const [rule]=await tx`INSERT INTO country_send_rules(country_code,version,basis,prerequisites,reference,reviewed_by,reviewed_at,valid_until,enabled)
        SELECT ${p.countryCode},coalesce(max(version),0)+1,${p.basis},${p.prerequisites},${p.reference},${p.actor},now(),${p.validUntil},true FROM country_send_rules WHERE country_code=${p.countryCode} AND basis=${p.basis} RETURNING *`;return rule;
    });
  });
}
