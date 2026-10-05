import { spawn,type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
process.chdir(fileURLToPath(new URL('../',import.meta.url)));
const config=loadConfig();if(config.HOST!=='127.0.0.1') throw new Error('Supervisor binds loopback only');
const children=new Set<ChildProcess>();let stopping=false;
const stopSignal=new AbortController();
function shutdown() {stopping=true;stopSignal.abort();for(const child of children) child.kill('SIGTERM');}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
// Keep-awake is explicit and tied to this supervisor process, never a persistent system preference.
if(process.argv.includes('--keep-awake') && process.platform==='darwin') {
  const awake=spawn('/usr/bin/caffeinate',['-s','-w',String(process.pid)],{stdio:'ignore'});children.add(awake);awake.once('exit',()=>children.delete(awake));
}
async function supervise(entry:string) {
  let failures=0;
  while(!stopping) {
    const started=Date.now();const child=spawn(process.execPath,['--import','tsx',entry],{stdio:'inherit',env:process.env});children.add(child);
    await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.once('error',()=>resolve());});children.delete(child);
    if(stopping) return;
    failures=Date.now()-started>60000?0:failures+1;
    if(failures>=5) {process.stderr.write(`${entry}: repeated startup failures, supervisor stopped\n`);shutdown();process.exitCode=1;return;}
    await delay(Math.min(30000,1000*2**failures),undefined,{signal:stopSignal.signal}).catch(error=>{if(!stopping) throw error;});
  }
}
await Promise.all([supervise('src/server.ts'),supervise('src/autopilot-main.ts')]);
