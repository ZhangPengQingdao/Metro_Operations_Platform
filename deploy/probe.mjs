import {Client} from 'pg';
const db=new Client({connectionString:process.env.DATABASE_URL});
try{
 await db.connect();
 const checks=[
  // Applications are stopped (maintenance mode) before an update; app writes are transactional, so no other state can be in flight.
  "SELECT 1 FROM platform_app_installations WHERE record->>'enabled'='true' LIMIT 1",
 ];
 for(const sql of checks){if((await db.query(sql)).rows.length)throw Error('ENABLED_APPLICATIONS');}
 process.stdout.write('READY\n');
}catch{process.stderr.write('Applications are still enabled or the preflight failed.\n');process.exitCode=1;}finally{await db.end();}
