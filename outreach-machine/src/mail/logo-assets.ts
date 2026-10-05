import { PNG } from 'pngjs';
import { inflateSync } from 'node:zlib';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { digest, readLogo } from './branding.js';

export const MAX_LOGO_UPLOAD_BYTES=500_000;
export class InvalidLogo extends Error {}

// Decode then re-encode pixels: uploaded metadata, appended payloads and filenames
// never enter mail HTML or storage paths. Bound dimensions before allocating pixels.
export function normalizeLogo(base64:string) {
  if(!base64 || base64.length>Math.ceil(MAX_LOGO_UPLOAD_BYTES/3)*4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new InvalidLogo('invalid_logo');
  const input=Buffer.from(base64,'base64');
  if(input.toString('base64')!==base64 || input.length>MAX_LOGO_UPLOAD_BYTES || input.length<33 ||
    input.subarray(0,8).toString('hex')!=='89504e470d0a1a0a' || input.readUInt32BE(8)!==13 || input.toString('ascii',12,16)!=='IHDR') throw new InvalidLogo('invalid_logo');
  const width=input.readUInt32BE(16),height=input.readUInt32BE(20);
  if(!width || !height || width>4096 || height>4096 || width*height>4_000_000) throw new InvalidLogo('logo_dimensions');
  let offset=8,headers=0,ended=false;
  const compressed:Buffer[]=[];
  while(offset+12<=input.length) {
    const size=input.readUInt32BE(offset),type=input.toString('ascii',offset+4,offset+8);
    if(offset+size+12>input.length || type==='acTL' || (type==='IHDR' && ++headers!==1)) throw new InvalidLogo('invalid_logo');
    if(type==='IDAT') compressed.push(input.subarray(offset+8,offset+8+size));
    offset+=size+12;
    if(type==='IEND') {ended=size===0 && offset===input.length;break;}
  }
  if(!ended) throw new InvalidLogo('invalid_logo');
  try {
    // Bound decompression even for interlaced PNGs before invoking the decoder.
    inflateSync(Buffer.concat(compressed),{maxOutputLength:width*height*8+height*8+1024});
    const decoded=PNG.sync.read(input,{checkCRC:true});
    const bytes=PNG.sync.write(decoded,{colorType:6,bitDepth:8});
    if(bytes.length>1_000_000) throw new Error('encoded_logo_too_large');
    return {bytes,sha256:digest(bytes)};
  } catch {throw new InvalidLogo('invalid_logo');}
}

export async function loadLogoAsset(sql:Database|postgres.TransactionSql,sha256:string) {
  if(!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid_logo_hash');
  const [row]=await sql`SELECT bytes FROM signature_logo_assets WHERE sha256=${sha256}`;
  const logo=row?{bytes:row.bytes as Buffer,sha256:digest(row.bytes as Buffer)}:readLogo();
  if(logo.sha256!==sha256) throw new Error('logo_asset_missing_or_changed');
  return logo;
}
