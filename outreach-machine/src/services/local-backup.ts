import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream,createWriteStream } from 'node:fs';
import { mkdir,readdir,rename,stat,unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { Database } from '../db.js';

export function localDatabase(databaseUrl:string) {
  const u=new URL(databaseUrl);
  if(!['127.0.0.1','localhost'].includes(u.hostname)||u.port!=='54329'||!/^\/[a-z0-9_]+$/.test(u.pathname)||u.username!=='gordion') throw new Error('Backup helper supports only the configured local Docker database');
  return u.pathname.slice(1);
}
export async function dockerDatabase(args:string[],input?:string,output?:string) {
  const child=spawn('docker',['exec',...(input?['-i']:[]),'outreach-machine-postgres-1',...args],{stdio:[input?'pipe':'ignore','pipe','pipe']});
  const finished=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('database_tool_failed')));});
  child.stderr!.resume();
  const streams:Promise<unknown>[]=[];
  if(input) streams.push(pipeline(createReadStream(input),child.stdin!));
  if(output) streams.push(pipeline(child.stdout!,createWriteStream(output,{flags:'wx',mode:0o600})));else child.stdout!.resume();
  await Promise.all([finished,...streams]);
}
export async function createLocalBackup(sql:Database,databaseUrl:string,force=false) {
  const database=localDatabase(databaseUrl);
  const owner=await sql.reserve();const [lock]=await owner`SELECT pg_try_advisory_lock(hashtextextended('gordion-backup',0)) AS ok`;
  if(!lock?.ok) {owner.release();return null;}
  try {
    const [table]=await sql`SELECT to_regclass('backup_runs') IS NOT NULL AS exists`;
    if(table!.exists) {const [recent]=await sql`SELECT id FROM backup_runs WHERE created_at>now()-interval '24 hours' LIMIT 1`;if(recent&&!force) return null;}
    const directory=path.resolve('.outreach-data/backups');await mkdir(directory,{recursive:true,mode:0o700});
    const name=`gordion-${new Date().toISOString().replace(/[:.]/g,'-')}.dump`,target=path.join(directory,name),partial=target+'.partial';
    await dockerDatabase(['pg_dump','-U','gordion','-d',database,'--format=custom','--no-owner','--no-acl'],undefined,partial);
    await dockerDatabase(['pg_restore','--list'],partial);
    const hash=createHash('sha256');for await(const chunk of createReadStream(partial)) hash.update(chunk);const digest=hash.digest('hex');
    await rename(partial,target);
    if(table!.exists) await sql`INSERT INTO backup_runs(path,sha256) VALUES(${target},${digest})`;
    const points=(await readdir(directory)).filter(f=>/^gordion-\d{4}-\d{2}-\d{2}T[\d-]+Z\.dump$/.test(f)).sort().reverse();
    for(const old of points.slice(14)) {const full=path.join(directory,old);if((await stat(full)).isFile()) await unlink(full);}
    return {path:target,sha256:digest};
  } finally {await owner`SELECT pg_advisory_unlock(hashtextextended('gordion-backup',0))`;owner.release();}
}
