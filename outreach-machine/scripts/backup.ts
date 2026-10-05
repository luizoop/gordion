import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { createLocalBackup } from '../src/services/local-backup.js';
const config=loadConfig(),sql=createDatabase(config);
try {console.log(await createLocalBackup(sql,config.DATABASE_URL,true));} finally {await sql.end({timeout:5});}
