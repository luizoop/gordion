import { randomBytes,scryptSync } from 'node:crypto';
import { mkdir,open } from 'node:fs/promises';
import process from 'node:process';
// Read the password from stdin, not a command-line argument or log. Existing configuration is never overwritten.
if(process.stdin.isTTY) process.stderr.write('Choose an operator password (at least 16 characters), enter it and finish stdin. Prefer a password-manager pipe to avoid terminal echo.\n');
let input='';for await(const chunk of process.stdin) {input+=String(chunk);if(input.length>1024) throw new Error('Password too long');}
const password=input.trim();if(password.length<16) throw new Error('Password must have at least 16 characters');
const salt=randomBytes(16).toString('hex'),hash=scryptSync(password,salt,64).toString('hex');
await mkdir('.outreach-data',{recursive:true,mode:0o700});
const file=await open('.outreach-data/operator.env','wx',0o600);
try {await file.writeFile(`OPERATOR_PASSWORD_HASH=scrypt:${salt}:${hash}\n`);} finally {await file.close();}
console.log('Operator password hash saved with owner-only access. Restart the supervisor to use it.');
