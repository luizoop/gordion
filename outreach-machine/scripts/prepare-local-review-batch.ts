import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DateTime} from 'luxon';
import {createDatabase} from '../src/db.js';
import {contactLanguage,contactRank,isEu,renderAutopilot,type Category,type LibraryTemplate} from '../src/domain/autopilot.js';
import {senderSignature} from '../src/services/sender-signature.js';
import {loadLogoAsset} from '../src/mail/logo-assets.js';

// Offline review packet only. Database transaction is read-only; no Graph client,
// message queue writes, template approvals or authorization creation.
const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl || !['127.0.0.1','localhost'].includes(new URL(databaseUrl).hostname)) throw new Error('local_database_required');
const sql=createDatabase({DATABASE_URL:databaseUrl});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
try {
  const packet=await sql.begin('isolation level repeatable read read only',async tx=> {
    const [config]=await tx`SELECT * FROM autopilot_config WHERE singleton`;
    if(!config?.paused) throw new Error('pause_outreach_before_review');
    const [run]=await tx`SELECT * FROM research_runs WHERE cursor->>'workflow'='contact-site-audit-v1' ORDER BY started_at DESC LIMIT 1`;
    if(!run) throw new Error('contact_audit_required');
    const targets=(run.cursor.targets as Array<{id:string}>).filter(t=>run.cursor.results[t.id]).slice(0,100);
    if(targets.length!==100) throw new Error('one_hundred_audited_companies_required');
    const signature=await senderSignature(tx);
    if(!signature.id) throw new Error('shared_signature_required');
    const logo=signature.useLogo?await loadLogoAsset(tx,signature.logoSha256!):null;
    const drafts=[];
    for(const target of targets) {
      const [company]=await tx`SELECT * FROM companies WHERE id=${target.id}`;
      if(!company || !isEu(company.countryCode)) throw new Error('unexpected_non_eu_company');
      const published=run.cursor.results[target.id].contacts as Array<{email:string;kind:string;dnsValid:boolean;sourceUrl:string;notes?:string[]}>;
      const candidates=await tx`SELECT * FROM contacts WHERE company_id=${target.id} AND NOT is_test_data
        AND contact_kind IN ('personal','functional') AND dns_valid AND source_checked_at>now()-interval '90 days'
        AND review_status IN ('needs_review','eligible')
        AND NOT EXISTS(SELECT 1 FROM suppression_entries s WHERE s.active AND
          ((s.scope='email' AND s.normalized_value=contacts.email) OR (s.scope='company' AND s.normalized_value=contacts.company_id::text)
          OR (s.scope='domain' AND s.normalized_value=split_part(contacts.email::text,'@',2))))`;
      const ranked=candidates.filter(c=>published.some(p=>p.email===c.email&&p.kind!=='unverified'&&p.dnsValid))
        .sort((a,b)=>contactRank(a.roleTitle,a.contactKind)-contactRank(b.roleTitle,b.contactKind)||b.sourceQuality-a.sourceQuality||a.email.localeCompare(b.email));
      const [history]=await tx`SELECT EXISTS(SELECT 1 FROM company_outreach_history WHERE company_id=${target.id}) AS prior,
        EXISTS(SELECT 1 FROM enrollments WHERE company_id=${target.id} AND status<>'cancelled') AS sequence`;
      const contact=!history!.prior&&!history!.sequence?ranked[0]:undefined;
      const language=contactLanguage(company.countryCode,contact?.language);
      const [template]=await tx`SELECT * FROM template_versions WHERE category_id=${company.categoryId} AND language=${language} AND step=0
        AND status IN ('draft','approved') AND targeting_mode='category_only' ORDER BY version DESC LIMIT 1`;
      if(!template) throw new Error('category_language_preview_template_missing');
      const content=renderAutopilot({name:company.name,firstName:contact?.firstName,lastName:contact?.lastName,honorific:contact?.honorific,roleTitle:contact?.roleTitle},
        {...template,categoryId:company.categoryId as Category,language,step:0,signature:signature.signatureText,useLogo:signature.useLogo} as LibraryTemplate);
      if(!content.bodyText.endsWith(signature.signatureText)||/{{|}}|\$\{/.test(content.subject+content.bodyText)) throw new Error('invalid_preview_content');
      drafts.push({companyId:company.id,company:company.name,categoryId:company.categoryId,language,contactId:contact?.id??null,
        recipient:contact?.email??null,sourceUrl:contact?.sourceUrl??null,role:contact?.roleTitle??null,
        priorContact:history!.prior,existingSequence:history!.sequence,templateId:template.id,templateVersion:template.version,templateStatus:template.status,
        signatureId:signature.id,signatureVersion:signature.version,logoSha256:signature.logoSha256,
        ...content,contentSha256:hash(JSON.stringify({subject:content.subject,body:content.bodyText,recipient:contact?.email??null,logo:signature.logoSha256})),
        deliveryStatus:'not_queued',sendReady:false});
    }
    drafts.sort((a,b)=>Number(!a.recipient)-Number(!b.recipient)||a.company.localeCompare(b.company));
    return {id:randomUUID(),createdAt:new Date().toISOString(),researchRunId:run.id,mode:'local_review_only',
      summary:{draftTexts:drafts.length,withSourcedRecipient:drafts.filter(d=>d.recipient).length,withoutRecipient:drafts.filter(d=>!d.recipient).length,
        sendReady:0,queued:0,providerDraftsCreated:0,sends:0},
      currentLimits:{dailyTarget:config.dailyTarget,pilotLimit:config.pilotLimit,hardDailyLimit:50},
      signature,logoBase64:logo?.bytes.toString('base64')??null,drafts};
  });
  if(new Set(packet.drafts.map(d=>d.companyId)).size!==100) throw new Error('duplicate_company');
  const recipients=packet.drafts.flatMap(d=>d.recipient?[d.recipient]:[]);
  if(new Set(recipients).size!==recipients.length) throw new Error('duplicate_recipient');
  const directory=path.resolve('.outreach-data',`review-batch-${DateTime.now().setZone('Europe/Berlin').toISODate()}-${packet.id}`);
  await mkdir(directory,{mode:0o700});
  const logo=packet.logoBase64?`<img src="data:image/png;base64,${packet.logoBase64}" width="200" style="width:200px;max-width:100%;height:auto" alt="Gordion">`:'';
  const rows=packet.drafts.map((d,i)=>`<details ${i===0?'open':''}><summary>${i+1}. ${esc(d.company)} — ${d.recipient?'Empfänger belegt':'Empfänger fehlt'}</summary><p><strong>An:</strong> ${esc(d.recipient??'Noch nicht festgelegt – keine Ersatzadresse geraten')}<br>Kategorie: ${esc(d.categoryId)} · Sprache: ${esc(d.language.toUpperCase())} · Vorlagenversion ${d.templateVersion} (${esc(d.templateStatus)})<br>${d.sourceUrl?`Quelle: <a href="${esc(d.sourceUrl)}">veröffentlichter Geschäftskontakt</a>`:'Keine ausreichend zugeordnete Kontaktadresse.'}</p><h3>${esc(d.subject)}</h3><pre>${esc(d.bodyText)}</pre>${logo}<p class="note">Nur lokaler Textentwurf, nicht in Outlook und nicht in der Versandwarteschlange. ${d.recipient?'Kontaktbeleg ist keine Versandfreigabe.':'Ohne Empfänger nicht versendbar.'}</p><details><summary>Verwendete Fakten und Fallbacks</summary><pre>${esc(JSON.stringify({facts:d.facts,fallbacks:d.fallbacks},null,2))}</pre></details></details>`).join('');
  const html=`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gordion – 100 lokale Textentwürfe</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:0 24px;color:#17232a}h1{font-size:30px}details{border:1px solid #d5dde0;border-radius:8px;padding:16px;margin:14px 0}summary{cursor:pointer;font-weight:650}pre{font:15px/1.6 Arial,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}p{line-height:1.6}.note{font-size:13px;color:#53616b}.banner{padding:18px;background:#fff4d8;border-radius:8px}a{overflow-wrap:anywhere}</style><h1>100 lokale Textentwürfe</h1><p>Stand: ${esc(DateTime.fromISO(packet.createdAt).setZone('Europe/Berlin').toFormat('dd.MM.yyyy HH:mm'))}. Eine Firma pro Entwurf; gemeinsame Signatur und Logo mit 200 px Breite.</p><div class="banner"><strong>${packet.summary.withSourcedRecipient} mit belegtem Empfänger · ${packet.summary.withoutRecipient} ohne Empfänger · 0 versandbereit</strong><p>Dies ist eine Vorschau, keine Outlook-Entwurfsablage oder Versandwarteschlange. Vorlagenfreigaben, Versandgrundlagen und Betriebsprüfungen werden hier nicht ersetzt. Der Versand bleibt pausiert. 100 Textentwürfe erhöhen das bestehende Tageslimit nicht.</p></div>${rows}</html>`;
  await writeFile(path.join(directory,'index.html'),html,{mode:0o600,flag:'wx'});
  await writeFile(path.join(directory,'snapshots.json'),JSON.stringify(packet,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({directory,...packet.summary},null,2));
} finally {await sql.end({timeout:5});}
