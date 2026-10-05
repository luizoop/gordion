import type postgres from 'postgres';
import type { Database } from '../db.js';
import { readLogo } from '../mail/branding.js';
import { loadLogoAsset,normalizeLogo } from '../mail/logo-assets.js';

export async function senderSignature(sql:Database|postgres.TransactionSql) {
  const [row]=await sql`SELECT s.revision,s.selected_logo_sha256,v.id,v.version,v.signature_text,v.use_logo,v.logo_sha256
    FROM sender_settings s LEFT JOIN sender_signature_versions v ON v.id=s.signature_version_id WHERE s.singleton`;
  if(row!.useLogo) await loadLogoAsset(sql,row!.logoSha256);
  const selectedLogoSha256=(row!.selectedLogoSha256||row!.logoSha256||readLogo().sha256) as string;
  return {revision:row!.revision as number,id:row!.id as string|null,version:row!.version as number|null,
    signatureText:(row!.signatureText||'') as string,useLogo:Boolean(row!.useLogo),
    logoSha256:row!.logoSha256 as string|null,selectedLogoSha256};
}
export async function saveSenderSignature(sql:Database,input:{revision:number;signatureText:string;useLogo:boolean;actor:string;logoBase64?:string|undefined}) {
  const signature=input.signatureText.trim();
  if(signature.length<8 || signature.length>4000 || /{{|}}|\$\{|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(signature)) throw new Error('invalid_sender_signature');
  const upload=input.logoBase64===undefined?null:normalizeLogo(input.logoBase64);
  return sql.begin(async tx=> {
    const [settings]=await tx`SELECT revision,selected_logo_sha256 FROM sender_settings WHERE singleton FOR UPDATE`;
    if(settings!.revision!==input.revision) return null;
    const logo=upload || (settings!.selectedLogoSha256?await loadLogoAsset(tx,settings!.selectedLogoSha256):readLogo());
    await tx`INSERT INTO signature_logo_assets(sha256,bytes) VALUES(${logo.sha256},${logo.bytes}) ON CONFLICT(sha256) DO NOTHING`;
    const logoSha256=input.useLogo?logo.sha256:null;
    const [version]=await tx`INSERT INTO sender_signature_versions(version,signature_text,use_logo,logo_sha256,created_by)
      SELECT coalesce(max(version),0)+1,${signature},${input.useLogo},${logoSha256},${input.actor} FROM sender_signature_versions RETURNING id`;
    await tx`UPDATE sender_settings SET revision=revision+1,signature_version_id=${version!.id},selected_logo_sha256=${logo.sha256} WHERE singleton`;
    await tx`INSERT INTO audit_events(entity_type,entity_id,event_type,actor_type,actor_id)
      VALUES('sender_signature',${version!.id},'sender_signature.saved','user',${input.actor})`;
    return senderSignature(tx);
  });
}
