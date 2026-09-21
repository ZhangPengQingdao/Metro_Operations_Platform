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
  assert.deepEqual((await run({table:'entries',pageSize:1,filters:[{column:'active',value:true}],anyOf:[[{column:'quantity',value:2}],[{column:'quantity',value:4}],[{column:'quantity',value:3}]]})).map(r=>r.id),[id(3),id(4)]);
  assert.throws(()=>runtimeListQuery(runtimeListInput.parse({table:'entries',anyOf:[[{column:'missing',value:'x'}]]}),columns),{code:'INVALID_PARAMS'});
  assert.equal(runtimeListInput.safeParse({table:'entries',anyOf:[[]]}).success,false);

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

test('date range and descending composite cursor keep ties and organization filters stable',async()=>{
 const db=new PGlite();try{await db.exec('CREATE TABLE ledger(id uuid PRIMARY KEY,day date,org text)');
 for(const [n,day,org] of [[1,'2026-09-19','a'],[2,'2026-09-20','a'],[3,'2026-09-20','a'],[4,'2026-09-21','b']])await db.query('INSERT INTO ledger VALUES($1,$2,$3)',[id(Number(n)),day,org]);
 const schema=new Map([['id','uuid'],['day','date'],['org','text']]);
 const base={table:'ledger',pageSize:1,filters:[{column:'org',value:'a'}],range:{column:'day',from:'2026-09-19',to:'2026-09-21'},order:{column:'day',direction:'desc'}};
 const query=async(input:unknown)=>{const q=runtimeListQuery(runtimeListInput.parse(input),schema);return (await db.query<{id:string}>('SELECT * FROM ledger'+q.suffix,q.values)).rows.map(r=>r.id);};
 assert.deepEqual(await query(base),[id(3),id(2)]);
 assert.deepEqual(await query({...base,after:{value:'2026-09-20',id:id(3)}}),[id(2),id(1)]);
 assert.deepEqual(await query({...base,after:{value:'2026-09-20',id:id(2)}}),[id(1)]);
 assert.throws(()=>runtimeListQuery(runtimeListInput.parse({...base,order:{column:'missing',direction:'desc'}}),schema),/INVALID_PARAMS/);
 assert.throws(()=>runtimeListQuery(runtimeListInput.parse({...base,afterId:id(1)}),schema),/INVALID_PARAMS/);
 }finally{await db.close();}
});

test('JSON participant scope is applied before paging with bounded parameterized containment',async()=>{
 const db=new PGlite();try{await db.exec('CREATE TABLE records(id uuid PRIMARY KEY,people jsonb)');
 await db.query('INSERT INTO records VALUES($1,$2),($3,$4)',[id(1),JSON.stringify([{id:id(8)}]),id(2),JSON.stringify([{id:id(9)}])]);
 const input=runtimeListInput.parse({table:'records',pageSize:1,anyOf:[[{column:'people',contains:[{id:id(9)}]}]]});
 const q=runtimeListQuery(input,new Map([['id','uuid'],['people','jsonb']]));
 assert.deepEqual((await db.query<{id:string}>('SELECT * FROM records'+q.suffix,q.values)).rows.map(r=>r.id),[id(2)]);
 assert.throws(()=>runtimeListQuery(input,new Map([['people','text']])),/INVALID_PARAMS/);
 }finally{await db.close();}
});
