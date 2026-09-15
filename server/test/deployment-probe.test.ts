import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
test('deployment preflight queries match the actual platform database schema',async()=>{
 const pg=new PGlite();try{
  await initializePlatformDatabase({query:async(sql,args)=>args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!});
  const source=await readFile(new URL('../../deploy/probe.mjs',import.meta.url),'utf8');
  const queries=[...source.matchAll(/"(SELECT 1 FROM [^"\n]+)"/g)].map(m=>m[1]);
  assert.equal(queries.length,7);
  for(const sql of queries)assert.equal((await pg.query(sql)).rows.length,0);
 }finally{await pg.close();}
});
