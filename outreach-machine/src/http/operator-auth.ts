import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir,open } from 'node:fs/promises';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
const derive=promisify(scrypt);
export function registerOperatorAuth(app:FastifyInstance,config:AppConfig) {
  const sessions=new Map<string,number>(); let failures=0,resetAt=Date.now()+900000;
  const cookieName=`gordion_operator_${config.PORT}`;
  const local=(r:FastifyRequest)=>r.ip==='127.0.0.1' && r.headers.host===`127.0.0.1:${config.PORT}` && (['GET','HEAD'].includes(r.method) || r.headers.origin===`http://127.0.0.1:${config.PORT}`);
  app.post('/local/operator/setup',async(request,reply)=> {
    if(!local(request) || !config.LOCAL_DASHBOARD_ENABLED || config.MAIL_PROVIDER!=='simulated' || config.LIVE_SEND_ENABLED) return reply.code(403).send({error:'local_simulator_setup_only'});
    if(config.OPERATOR_PASSWORD_HASH) return reply.code(409).send({error:'operator_already_configured'});
    const p=z.strictObject({password:z.string().min(16).max(1024),confirmation:z.literal('CREATE_LOCAL_OPERATOR')}).parse(request.body);
    const salt=randomBytes(16).toString('hex'),hash=(await derive(p.password,salt,64) as Buffer).toString('hex');
    const encoded=`scrypt:${salt}:${hash}`;
    await mkdir('.outreach-data',{recursive:true,mode:0o700});
    let file;
    try {file=await open('.outreach-data/operator.env','wx',0o600);} catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST') return reply.code(409).send({error:'operator_exists_restart_required'});throw error;}
    try {await file.writeFile(`OPERATOR_PASSWORD_HASH=${encoded}\n`);} finally {await file.close();}
    config.OPERATOR_PASSWORD_HASH=encoded;
    return reply.header('cache-control','no-store').send({configured:true,runtimeRestartRequired:true,sendingEnabled:false});
  });
  app.post('/local/operator/login',async(request,reply)=> {
    if(!local(request)) return reply.code(403).send({error:'local_origin_required'});
    if(!config.OPERATOR_PASSWORD_HASH) return reply.code(409).send({error:'operator_not_configured'});
    if(Date.now()>resetAt) {failures=0;resetAt=Date.now()+900000;}
    if(failures>=5) return reply.code(429).send({error:'login_cooldown'});
    failures++;
    const {password}=z.strictObject({password:z.string().min(12).max(1024)}).parse(request.body);
    const [,salt,expected]=config.OPERATOR_PASSWORD_HASH.split(':');
    const actual=await derive(password,salt!,64) as Buffer;
    if(!timingSafeEqual(actual,Buffer.from(expected!,'hex'))) return reply.code(401).send({error:'invalid_login'});
    failures=0;
    for(const [token,until] of sessions) if(until<Date.now()) sessions.delete(token);
    if(sessions.size>=20) sessions.clear();
    const token=randomBytes(32).toString('hex');sessions.set(token,Date.now()+3600000);
    return reply.header('cache-control','no-store').header('set-cookie',`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`).send({authenticated:true});
  });
  return (request:FastifyRequest)=> {
    const token=request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
    return local(request) && Boolean(token && (sessions.get(token)||0)>Date.now());
  };
}
