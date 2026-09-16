import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {runtimeListInput,runtimeListQuery} from '../src/app-platform/storage/runtime-list.ts';
import {AppRuntimeDataService} from '../src/app-platform/storage/runtime-data.ts';
const id=(n:number)=>`55000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const columns=new Map([['id','uuid'],['name','text'],['quantity','int4'],['active','bool'],['extra','jsonb']]);
test('storage pages are ordered by UUID, use literal search and filter before applying the cursor limit',async()=>{
 const db=new PGlite();try{
  await db.exec('CREATE TABLE entries(id uuid PRIMARY KEY,name text,quantity integer,active boolean,extra jsonb)');
  for(const n of [3,1,4,2])await db.query('INSERT INTO entries VALUES($1,$2,$3,$4,$5)',[id(n),n===4?'other':'part_%',n,n!==2,null]);
  const run=async(input:unknown)=>{const q=runtimeListQuery(runtimeListInput.parse(input),columns);return (await db.query<{id:string}>('SELECT * FROM entries'+q.suffix,q.values)).rows;};
  assert.deepEqual((await run({table:'entries',pageSize:1})).map(r=>r.id),[id(1),id(2)]); // bounded lookahead
  assert.deepEqual((await run({table:'entries',pageSize:1,afterId:id(1)})).map(r=>r.id),[id(2),id(3)]);
  assert.deepEqual((await run({table:'entries',search:{column:'name',text:'_%'},filters:[{column:'active',value:true}]})).map(r=>r.id),[id(1),id(3)]);
  assert.equal((await run({table:'entries',search:{column:'name',text:"' OR true --"}})).length,0);
  assert.deepEqual((await run({table:'entries',filters:[{column:'quantity',value:4}]})).map(r=>r.id),[id(4)]);
  assert.equal((await run({table:'entries',afterId:id(4)})).length,0);
 }finally{await db.close();}
});
test('storage list rejects arbitrary SQL, schema, ordering, excessive pages and unsupported filter types',()=>{
 for(const value of [{table:'public.entries'},{table:'entries',pageSize:0},{table:'entries',pageSize:51},{table:'entries',afterId:'1'},{table:'entries',orderBy:'name'},{table:'entries',filters:[{column:'name";DROP TABLE entries;--',value:'a'}]},{table:'entries',search:{column:'name',text:''}}])assert.equal(runtimeListInput.safeParse(value).success,false);
 for(const value of [{filters:[{column:'missing',value:1}]},{filters:[{column:'quantity',value:'1'}]},{filters:[{column:'id',value:'bad'}]},{filters:[{column:'extra',value:null}]},{search:{column:'quantity',text:'1'}}])assert.throws(()=>runtimeListQuery(runtimeListInput.parse({table:'entries',...value}),columns),{code:'INVALID_PARAMS'});
});
test('storage list is read-authorized and never allows employee identity to open the storage connection',async()=>{
 let connections=0;
 const service=new AppRuntimeDataService({endpoint:{host:'127.0.0.1',port:5432,database:'test',ssl:false},connectAdmin:async()=>{connections++;throw Error('must not connect');},findInstallation:async()=>null});
 const op=service.operations().find(o=>o.name==='platform.app_data.list')!;
 assert.equal(op.permissionCode,'platform.app_data.read');assert.equal(op.mode,'read');
 const employee={actorType:'person',execution:{type:'application',appId:'example'}} as Parameters<typeof op.execute>[0];
 await assert.rejects(op.execute(employee,{table:'entries'},new AbortController().signal),/ACCESS_DENIED/);assert.equal(connections,0);
});
