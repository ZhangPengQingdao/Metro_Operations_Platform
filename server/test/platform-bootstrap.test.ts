import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import type {QueryableClient} from '../src/core/database/index.ts';
test('empty platform database initializes atomically and repeated initialization preserves data',async()=>{
 const db=new PGlite();const client:QueryableClient={query:async(sql,values)=>values||/^SELECT/i.test(sql)?db.query(sql,values?[...values]:[]):db.exec(sql)};
 try{
  const applied=await initializePlatformDatabase(client);assert.ok(applied.length>20);
  await db.query("INSERT INTO system_configs(key,value) VALUES('bootstrap-test','{}')");
  assert.deepEqual(await initializePlatformDatabase(client),[]);
  assert.equal((await db.query("SELECT key FROM system_configs WHERE key='bootstrap-test'")).rows.length,1);
  const rows=await db.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.ok(rows.rows.some(r=>r.tablename==='platform_admin_accounts'));
  for(const name of ['users','faults','hazards','todos','workgroups'])assert.ok(!rows.rows.some(r=>r.tablename===name));
 }finally{await db.close();}
});
