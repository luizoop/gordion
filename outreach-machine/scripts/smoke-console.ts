import assert from "node:assert/strict";
import { randomUUID,scryptSync } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import { buildHttpApp } from "../src/http/app.js";
import { prepareAutomaticCampaigns } from "../src/services/preparation.js";
import { MessageRepository } from "../src/repositories/message-repository.js";
import { senderSignature,saveSenderSignature } from '../src/services/sender-signature.js';
import { PNG } from 'pngjs';
import { normalizeLogo,loadLogoAsset } from '../src/mail/logo-assets.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL required");
const target = new URL(databaseUrl);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
  !target.pathname.endsWith("_test")
) {
  throw new Error("Requires a disposable local database ending in _test");
}
const adminKey = randomUUID().repeat(2),
  researchKey = randomUUID().repeat(2);
const operatorPassword=randomUUID(),operatorSalt='a'.repeat(32);
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  ADMIN_API_KEY: adminKey,
  RESEARCH_IMPORT_API_KEY: researchKey,
  LOCAL_DASHBOARD_ENABLED: "true",
  LOG_LEVEL: "silent",
  OPERATOR_PASSWORD_HASH:`scrypt:${operatorSalt}:${scryptSync(operatorPassword,operatorSalt,64).toString('hex')}`,
});
const sql = createDatabase(config),
  app = buildHttpApp(config, sql);
const admin = { "x-admin-api-key": adminKey },
  research = { "x-research-api-key": researchKey };
const batchId = randomUUID(),
  domain = `broker-${batchId}.example`;
const payload = {
  externalId: batchId,
  source: "research",
  contacts: [
    {
      companyName: "Synthetic Broker",
      domain,
      countryCode: "DE",
      fitTier: "A",
      email: `compliance@${domain}`,
      firstName: "Test",
      roleTitle: "Compliance",
      sourceUrl: `https://${domain}/team`,
      sourceCheckedAt: new Date().toISOString(),
      executionEvidence: "Synthetic only; never a real researched prospect.",
      executionEvidenceUrl: `https://${domain}/services`,
    },
  ],
};
try {
  const signature=await senderSignature(sql);
  await saveSenderSignature(sql,{revision:signature.revision,signatureText:'Synthetic shared signature only',useLogo:true,actor:'smoke'});
  const noAuth = await app.inject({ url: "/v1/console" });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/local/session",
        headers: { host: "127.0.0.1:4310", origin: "https://evil.example" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/local/session",
        headers: { host: "evil.example", origin: "http://evil.example" },
      })
    ).statusCode,
    403,
  );
  const session = await app.inject({
    method: "POST",
    url: "/local/session",
    headers: { host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310" },
  });
  assert.equal(session.statusCode, 200);
  const cookie = String(session.headers["set-cookie"]).split(";")[0]!;
  assert.equal(
    (
      await app.inject({
        url: "/v1/console",
        headers: { host: "127.0.0.1:4310", cookie },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/system/pause",
        headers: { host: "127.0.0.1:4310", cookie },
        payload: { reason: "CSRF", actor: "test" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: "/v1/console", headers: research })).statusCode,
    403,
  );
  const imported = await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload,
  });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().importedCount, 1);
  const repeated = await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload,
  });
  assert.equal(repeated.json().replayed, true);
  const changed = await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload: {
      ...payload,
      contacts: [{ ...payload.contacts[0], firstName: "Changed" }],
    },
  });
  assert.equal(changed.statusCode, 409);
  const duplicate = await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload: { ...payload, externalId: randomUUID() },
  });
  assert.equal(duplicate.json().duplicateCount, 1);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/imports",
        headers: research,
        payload: {
          ...payload,
          externalId: randomUUID(),
          contacts: [{ ...payload.contacts[0], reviewStatus: "eligible" }],
        },
      })
    ).statusCode,
    400,
  );
  const [contact] =
    await sql`SELECT * FROM contacts WHERE email = ${payload.contacts[0]!.email}`;
  assert.equal(contact!.reviewStatus, "needs_review");
  assert.equal(contact!.outreachBasis, null);
  const consoleData = (
    await app.inject({ url: "/v1/console", headers: admin })
  ).json();
  assert.equal(consoleData.categories.length, 4);
  const defaultCategory = consoleData.categories.find(
    (c: { id: string }) => c.id === "general",
  );
  const categoryDefaults = {
    name: defaultCategory.name,
    subject: defaultCategory.subjectTemplate,
    body: defaultCategory.bodyTemplate,
    signature: "Synthetic signature only",
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/categories/general",
        headers: research,
        payload: categoryDefaults,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/categories/general",
        headers: admin,
        payload: {
          ...categoryDefaults,
          body: "Hello {{misspelled}} invalid template",
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/categories/general",
        headers: admin,
        payload: categoryDefaults,
      })
    ).statusCode,
    200,
  );
  const preview = (
    await app.inject({
      method: "POST",
      url: `/v1/contacts/${contact!.id}/preview`,
      headers: admin,
      payload: {},
    })
  ).json();
  assert.ok(preview.bodyText.startsWith("Guten Tag Test,"));
  assert.ok(!preview.bodyText.includes("Synthetic only; never"));
  assert.ok(preview.fallbacks.includes("executionIntro"));
  const profile = {
    firstName: "Test",
    lastName: "Beispiel",
    honorific: "frau",
    categoryId: "general",
    executionIntro: "Geprüfter synthetischer Einstieg.",
    introSourceUrl: "https://example.test",
    introVerified: true,
    isTestData: true,
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/contacts/${contact!.id}/profile`,
        headers: admin,
        payload: profile,
      })
    ).statusCode,
    200,
  );
  const personalized = (
    await app.inject({
      method: "POST",
      url: `/v1/contacts/${contact!.id}/preview`,
      headers: admin,
      payload: {},
    })
  ).json();
  assert.ok(personalized.bodyText.startsWith("Sehr geehrte Frau Beispiel,"));
  assert.ok(personalized.bodyText.includes(profile.executionIntro));
  const campaign = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: admin,
    payload: {
      name: `Synthetic ${batchId}`,
      subject: "Hello {{company}}",
      body: "Hello {{firstName}}, this is a synthetic preview only.",
      signature: "Synthetic test signature only",
      useLogo: true,
      legalReference: "Own synthetic test addresses only",
      countries: ["DE"],
      initialLimit: 5,
      totalLimit: 5,
      confirmation: "APPROVE_TEMPLATE_ONLY",
    },
  });
  assert.equal(campaign.statusCode, 200, campaign.body);
  const campaignId = campaign.json().id;
  const prepare = () =>
    app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/prepare`,
      headers: admin,
      payload: {},
    });
  assert.equal((await prepare()).json().prepared, 0);
  const review = await app.inject({
    method: "POST",
    url: `/v1/contacts/${contact!.id}/authorize`,
    headers: admin,
    payload: {
      basis: "own_test_address",
      evidence: "Synthetic simulator fixture, not a real recipient",
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      confirmation: "VERIFY_OUTREACH_BASIS",
    },
  });
  assert.equal(review.statusCode, 200, review.body);
  const bankCampaign = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: admin,
    payload: {
      name: "Synthetic bank category",
      categoryId: "bank",
      subject: "Banken {{company}}",
      body: "{{salutation}}\n\n{{executionIntro}}",
      signature: "Synthetic signature",
      legalReference: "Own synthetic test addresses only",
      countries: ["DE"],
      initialLimit: 5,
      totalLimit: 5,
      confirmation: "APPROVE_TEMPLATE_ONLY",
      useLogo: true,
    },
  });
  assert.equal(bankCampaign.statusCode, 200, bankCampaign.body);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/campaigns/${bankCampaign.json().id}/prepare`,
        headers: admin,
        payload: {},
      })
    ).json().prepared,
    0,
  );
  const prepared = await prepare();
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json().prepared, 1);
  assert.equal((await prepare()).json().prepared, 0);
  const [message] =
    await sql`SELECT m.* FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.campaign_id = ${campaignId}`;
  assert.equal(message!.status, "awaiting_approval");
  assert.match(message!.logoSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/categories/general",
        headers: admin,
        payload: {
          ...categoryDefaults,
          body: "Changed default {{salutation}}",
        },
      })
    ).statusCode,
    200,
  );
  const [unchanged] =
    await sql`SELECT final_body_text FROM messages WHERE id=${message!.id}`;
  assert.equal(unchanged!.finalBodyText, message!.finalBodyText);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/contacts/${contact!.id}/profile`,
        headers: admin,
        payload: { ...profile, categoryId: "bank" },
      })
    ).statusCode,
    409,
  );
  const approve = await app.inject({
    method: "POST",
    url: `/v1/messages/${message!.id}/approve`,
    headers: admin,
    payload: { contentSha256: message!.contentSha256 },
  });
  assert.equal(approve.statusCode, 200, approve.body);
  // Stale/replaced preview must not approve a different content snapshot.
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/messages/${message!.id}/approve`,
        headers: admin,
        payload: { contentSha256: "a".repeat(64) },
      })
    ).statusCode,
    409,
  );
  const autoDomain = `auto-${batchId}.example`;
  const autoPayload = {
    ...payload,
    externalId: randomUUID(),
    contacts: [
      {
        ...payload.contacts[0],
        domain: autoDomain,
        email: `person@${autoDomain}`,
      },
    ],
  };
  await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload: autoPayload,
  });
  const [autoContact] =
    await sql`SELECT id FROM contacts WHERE email = ${autoPayload.contacts[0]!.email}`;
  await app.inject({
    method: "POST",
    url: `/v1/campaigns/${campaignId}/automation`,
    headers: admin,
    payload: { enabled: true, confirmation: "PREPARATION_ONLY_NO_SEND" },
  });
  await prepareAutomaticCampaigns(sql);
  const [before] =
    await sql`SELECT count(*)::int AS count FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.campaign_id = ${campaignId}`;
  assert.equal(
    before!.count,
    1,
    "Unreviewed automatic import must not create a message",
  );
  await app.inject({
    method: "POST",
    url: `/v1/contacts/${autoContact!.id}/authorize`,
    headers: admin,
    payload: {
      basis: "own_test_address",
      evidence: "Synthetic automatically prepared fixture only",
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      confirmation: "VERIFY_OUTREACH_BASIS",
    },
  });
  await prepareAutomaticCampaigns(sql);
  await prepareAutomaticCampaigns(sql);
  const automaticMessages =
    await sql`SELECT m.* FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.contact_id = ${autoContact!.id}`;
  assert.equal(automaticMessages.length, 1);
  assert.equal(automaticMessages[0]!.status, "approved");
  assert.equal(automaticMessages[0]!.approvedBy, "campaign-policy");
  assert.ok(automaticMessages[0]!.finalBodyText.endsWith('Synthetic shared signature only'));
  const globalBefore=await senderSignature(sql);
  const signatureUpdate={revision:globalBefore.revision,signatureText:'One shared footer for every category',useLogo:true,actor:'smoke',confirmation:'SAVE_SHARED_SIGNATURE'};
  assert.equal((await app.inject({method:'POST',url:'/v1/sender-signature',headers:admin,payload:signatureUpdate})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/v1/sender-signature',headers:research,payload:signatureUpdate})).statusCode,403);
  const local={host:'127.0.0.1:4310',origin:'http://127.0.0.1:4310'};
  const login=await app.inject({method:'POST',url:'/local/operator/login',headers:local,payload:{password:operatorPassword}});
  assert.equal(login.statusCode,200,login.body);
  const operatorHeaders={...admin,...local,cookie:String(login.headers['set-cookie']).split(';')[0]!};
  const saved=await app.inject({method:'POST',url:'/v1/sender-signature',headers:operatorHeaders,payload:signatureUpdate});
  assert.equal(saved.statusCode,200,saved.body);
  assert.equal((await app.inject({method:'POST',url:'/v1/sender-signature',headers:operatorHeaders,payload:signatureUpdate})).statusCode,409,'stale edits never overwrite a newer signature');
  assert.equal((await app.inject({method:'POST',url:'/v1/sender-signature',headers:operatorHeaders,payload:{...signatureUpdate,revision:globalBefore.revision+1,signatureText:'Hello {{firstName}}'}})).statusCode,400);
  const previewAfter=(await app.inject({method:'POST',url:`/v1/contacts/${contact!.id}/preview`,headers:admin,payload:{}})).json();
  assert.ok(previewAfter.bodyText.endsWith(signatureUpdate.signatureText),'preview uses central signature, not category override');
  const [preserved]=await sql`SELECT final_body_text,sender_signature_version_id FROM messages WHERE id=${automaticMessages[0]!.id}`;
  assert.equal(preserved!.finalBodyText,automaticMessages[0]!.finalBodyText);
  assert.equal(preserved!.senderSignatureVersionId,globalBefore.id);
  await assert.rejects(sql`UPDATE sender_signature_versions SET signature_text='tampered' WHERE id=${globalBefore.id}`);
  await assert.rejects(sql`UPDATE messages SET sender_signature_version_id=${saved.json().signature.id} WHERE id=${automaticMessages[0]!.id}`);
  const uploadBytes=PNG.sync.write({width:1,height:1,data:Buffer.from([10,20,30,255])} as PNG);
  const logoBase64=uploadBytes.toString('base64'),uploadedLogo=normalizeLogo(logoBase64);
  const uploadPayload={...signatureUpdate,revision:saved.json().signature.revision,logoBase64};
  assert.equal((await app.inject({method:'POST',url:'/v1/sender-signature',headers:admin,payload:uploadPayload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/v1/sender-signature',headers:research,payload:uploadPayload})).statusCode,403);
  const uploaded=await app.inject({method:'POST',url:'/v1/sender-signature',headers:operatorHeaders,payload:uploadPayload});
  assert.equal(uploaded.statusCode,200,uploaded.body);
  assert.equal(uploaded.json().signature.logoSha256,uploadedLogo.sha256);
  const logoPath=`/v1/sender-signature/logos/${uploadedLogo.sha256}`;
  assert.equal((await app.inject({url:logoPath})).statusCode,401);
  const image=await app.inject({url:logoPath,headers:admin});
  assert.equal(image.statusCode,200);assert.equal(image.headers['content-type'],'image/png');
  assert.deepEqual(image.rawPayload,uploadedLogo.bytes);
  assert.deepEqual((await loadLogoAsset(sql,uploadedLogo.sha256)).bytes,uploadedLogo.bytes);
  assert.equal((await app.inject({method:'POST',url:`/v1/contacts/${contact!.id}/preview`,headers:admin,payload:{}})).json().logoSha256,uploadedLogo.sha256);
  assert.equal((await loadLogoAsset(sql,globalBefore.logoSha256!)).sha256,globalBefore.logoSha256,'old logo remains available for frozen drafts');
  await assert.rejects(sql`UPDATE signature_logo_assets SET bytes=${Buffer.from('invalid')} WHERE sha256=${uploadedLogo.sha256}`);
  const badUpload=await app.inject({method:'POST',url:'/v1/sender-signature',headers:operatorHeaders,payload:{...uploadPayload,revision:uploaded.json().signature.revision,logoBase64:Buffer.from('<svg/>').toString('base64')}});
  assert.equal(badUpload.statusCode,400);assert.equal((await senderSignature(sql)).revision,uploaded.json().signature.revision);
  assert.equal((await app.inject({method:'POST',url:'/v1/sender-signature',headers:operatorHeaders,payload:uploadPayload})).statusCode,409);
  const off=await saveSenderSignature(sql,{...signatureUpdate,revision:uploaded.json().signature.revision,useLogo:false});
  assert.equal(off!.logoSha256,null);assert.equal(off!.selectedLogoSha256,uploadedLogo.sha256);
  const on=await saveSenderSignature(sql,{...signatureUpdate,revision:off!.revision});
  assert.equal(on!.logoSha256,uploadedLogo.sha256,'reenabling preserves the selected uploaded logo');
  assert.equal((await sql`SELECT logo_sha256 FROM messages WHERE id=${automaticMessages[0]!.id}`)[0]!.logoSha256,globalBefore.logoSha256);
  const [inactive] =
    await sql`SELECT status, live_send_enabled FROM campaigns WHERE id = ${campaignId}`;
  assert.equal(inactive!.status, "draft");
  assert.equal(inactive!.liveSendEnabled, false);
  await sql`UPDATE messages SET status = 'leased', lease_owner = 'crashed', lease_expires_at = now() - interval '3 minutes' WHERE id = ${message!.id}`;
  await new MessageRepository(sql).leaseNextDraftCreation("recovery-test");
  const [recovered] =
    await sql`SELECT status FROM messages WHERE id = ${message!.id}`;
  assert.equal(recovered!.status, "reconciliation_required");
  const [control] = await sql`SELECT globally_paused FROM system_control`;
  assert.equal(control!.globallyPaused, true);
  const suppression = await app.inject({
    method: "POST",
    url: `/v1/contacts/${contact!.id}/suppress`,
    headers: admin,
    payload: { reason: "Synthetic unsubscribe test" },
  });
  assert.equal(suppression.statusCode, 200);
  const blocked = await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload: { ...payload, externalId: randomUUID() },
  });
  assert.equal(blocked.json().blockedCount, 1);
  await prepareAutomaticCampaigns(sql);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/system/resume",
        headers: admin,
        payload: {
          reason: "Attempted activation",
          actor: "test",
          confirmation: "RESUME_OUTREACH",
        },
      })
    ).statusCode,
    409,
  );
  const page = await app.inject({
    url: "/",
    headers: { host: "127.0.0.1:4310" },
  });
  assert.equal(page.statusCode, 200);
  assert.match(
    String(page.headers["content-security-policy"]),
    /frame-ancestors 'none'/,
  );
  console.log(
    "Console smoke passed: local auth/CSRF, import scopes, dedupe, review, preview, automatic preparation, expired-lease quarantine, suppression and send lock.",
  );
} finally {
  await app.close();
  await sql.end();
}
