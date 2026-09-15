import {Client} from 'pg';
const db=new Client({connectionString:process.env.DATABASE_URL});
try{
 await db.connect();
 const checks=[
  "SELECT 1 FROM platform_app_installations WHERE record->>'enabled'='true' LIMIT 1",
  "SELECT 1 FROM platform_app_runtime_work WHERE settled_at IS NULL LIMIT 1",
  "SELECT 1 FROM platform_app_runtime_storage_writes WHERE status='dispatched' LIMIT 1",
  "SELECT 1 FROM platform_app_storage_leases WHERE status='active' LIMIT 1",
  "SELECT 1 FROM platform_app_runtime_storage_leases WHERE status='active' LIMIT 1",
  "SELECT 1 FROM platform_app_migration_attempts WHERE status IN ('running','uncertain') LIMIT 1",
  "SELECT 1 FROM platform_app_storage_restores WHERE status='dispatched' LIMIT 1",
 ];
 for(const sql of checks){if((await db.query(sql)).rows.length)throw Error('ACTIVE_OR_UNCERTAIN_APP_WORK');}
 process.stdout.write('READY\n');
}catch{process.stderr.write('Platform has unresolved work or failed preflight.\n');process.exitCode=1;}finally{await db.end();}
