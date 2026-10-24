import '../../applications/materials/test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {compileAppMigration} from '../src/app-platform/storage/declarative-migration.ts';
import {createMaterialsService} from '../../applications/materials/src/service.mjs';

test('independent materials service uses declarative schema and rolls back stock if ledger insertion fails',async()=>{
 const db=new PGlite(),schema='app_'+randomUUID().replaceAll('-','');
 try{
  await db.exec(`CREATE SCHEMA "${schema}"`);
  const migration=await readFile(new URL('../../applications/materials/migrations/001-initial.json',import.meta.url),'utf8');
  for(const sql of compileAppMigration(migration,schema))await db.exec(sql);
  const employee={personId:randomUUID(),organizationUnitId:randomUUID()};let failLedger=false;
  // Test-only SDK transport: application source uses no SQL or platform imports.
  const gateway={async invoke(operation:string,p:any){
   assert.ok(['materials','movements','reversals'].includes(p.table)||operation==='platform.app_data.transaction');
   if(operation==='platform.app_data.get')return {row:(await db.query(`SELECT * FROM "${schema}"."${p.table}" WHERE id=$1`,[p.id])).rows[0]??null};
   assert.equal(operation,'platform.app_data.transaction');
   return db.transaction(async tx=>{
    for(const op of p.operations){
     const names=Object.keys(op.values);assert.ok(names.every(n=>/^[a-z_]+$/.test(n)));
     if(op.table==='movements'&&failLedger)throw Error('ledger failed');
     if(op.action==='insert')await tx.query(`INSERT INTO "${schema}"."${op.table}" (id,${names.map(n=>`"${n}"`).join(',')}) VALUES (${Array.from({length:names.length+1},(_,i)=>'$'+(i+1)).join(',')})`,[op.id,...Object.values(op.values)]);
     else{
      const expected=Object.keys(op.expected),values=[...Object.values(op.values),op.id,...Object.values(op.expected)];
      const result=await tx.query(`UPDATE "${schema}"."${op.table}" SET ${names.map((n,i)=>`"${n}"=$${i+1}`).join(',')} WHERE id=$${names.length+1} AND ${expected.map((n,i)=>`"${n}" IS NOT DISTINCT FROM $${names.length+2+i}`).join(' AND ')} RETURNING id`,values);
      if(!result.rows.length)throw Error('STORAGE_CONFLICT');
     }
    }return {ok:true};
   });
  }};
  const service=createMaterialsService(gateway),material=await service.create({requestId:randomUUID(),name:'螺栓',sku:'BOLT',unit:'个'},employee);
  const inbound=await service.move({requestId:randomUUID(),materialId:material.id,direction:'in',quantity:8},employee);
  const upgrade=await readFile(new URL('../../applications/materials/migrations/002-specification.json',import.meta.url),'utf8');
  for(const sql of compileAppMigration(upgrade,schema))await db.exec(sql);
  const retained=(await db.query(`SELECT quantity,specification FROM "${schema}".materials`)).rows[0];assert.equal(retained.quantity,8);assert.equal(retained.specification,null);

  const receiverMigration=await readFile(new URL('../../applications/materials/migrations/003-receiver.json',import.meta.url),'utf8');
  for(const sql of compileAppMigration(receiverMigration,schema))await db.exec(sql);
  assert.equal((await db.query(`SELECT receiver_id FROM "${schema}".movements WHERE id=$1`,[inbound.id])).rows[0].receiver_id,null);
  failLedger=true;await assert.rejects(service.move({requestId:randomUUID(),materialId:material.id,direction:'out',quantity:3},employee),/ledger failed/);failLedger=false;
  assert.equal((await db.query(`SELECT quantity FROM "${schema}".materials`)).rows[0].quantity,8);
  assert.equal((await db.query(`SELECT count(*)::int n FROM "${schema}".movements`)).rows[0].n,1);
  await service.reverse({requestId:randomUUID(),movementId:inbound.id,reason:'录入错误'},employee);
  assert.equal((await db.query(`SELECT quantity FROM "${schema}".materials`)).rows[0].quantity,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM "${schema}".movements`)).rows[0].n,2);
  await assert.rejects(service.reverse({requestId:randomUUID(),movementId:inbound.id,reason:'重复'},employee),/ALREADY_REVERSED/);
 }finally{await db.close();}
});

test('materials handlers interoperate with SDK channel and preserve uncertainty without killing the backend',async()=>{
 const {PassThrough}=await import('node:stream');
 const {createAppBackend}=await import('@metro/platform-sdk/app-backend');
 const {createMaterialsHandlers}=await import('../../applications/materials/src/handlers.mjs');
 const {startAppStdioGateway}=await import('../src/app-platform/runtime/stdio-gateway.ts');
 const input=new PassThrough(),output=new PassThrough();let storageCalls=0;
 const backend=createAppBackend({input,output,handlers:createMaterialsHandlers({invoke:async()=>{storageCalls++;throw Error('unknown database response');}})});
 const host=startAppStdioGateway({appId:'materials',serviceCredential:'host-only',stdout:output,stdin:input,requireApiContext:true,gateway:{invokeService:async()=>{throw Error('not expected');},drain:async()=>{}}});
 const employee={version:'1.0' as const,personId:randomUUID(),organizationUnitId:randomUUID(),requestId:'request',traceId:'trace',permissions:['app.materials.manage']};
 try{
  const rejected:any=await host.api.invoke({handler:'create',method:'POST',path:'/create',payload:{},employee},undefined,async()=>{});
  assert.equal(rejected.error.code,'INVALID_INPUT');assert.equal(storageCalls,0);assert.equal(backend.signal.aborted,false);
  const uncertain:any=await host.api.invoke({handler:'create',method:'POST',path:'/create',payload:{requestId:randomUUID(),name:'Bolt',sku:'B',unit:'个'},employee},undefined,async()=>{});
  assert.equal(uncertain.error.writeOutcome,'unknown');assert.equal(storageCalls,1);assert.equal(backend.signal.aborted,false);
 }finally{backend.close();await backend.drain();host.api.confirmContainerStopped();await host.stop();}
});

/** Builds applications/materials with the public CLI and returns its single-file package and registry projection. */
async function buildMaterialsPackage(){
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{fileURLToPath}=await import('node:url');
 const app=fileURLToPath(new URL('../../applications/materials/',import.meta.url)),cli=fileURLToPath(new URL('../../packages/platform-cli/dist/cli.mjs',import.meta.url));
 await promisify(execFile)(process.execPath,[cli,'build'],{cwd:app});
 const bytes=await readFile(new URL('../../applications/materials/dist/materials-0.3.0.mopkg',import.meta.url));
 const {inspectMopkg,readMopkg}=await import('@metro/platform-sdk/mopkg'),{projectV2Manifest}=await import('../src/app-platform/v2/projection.ts'),{createHash}=await import('node:crypto');
 const inspection=inspectMopkg(bytes),files=readMopkg(bytes);
 return {inspection,files,projection:projectV2Manifest(inspection.manifest!,inspection,path=>createHash('sha256').update(files.get(path)!).digest('hex'))};
}

test('materials builds as one v2 package whose migrations equal the v1 files byte for byte',async()=>{
 const {inspection,files,projection}=await buildMaterialsPackage();
 assert.deepEqual(inspection.issues,[]);
 assert.deepEqual(inspection.migrations.map(m=>m.id),['001-initial','002-specification','003-receiver']);
 for(const [index,name] of ['001-initial','002-specification','003-receiver'].entries()){
  const source=await readFile(new URL(`../../applications/materials/migrations/${name}.json`,import.meta.url));
  assert.ok(files.get(inspection.migrations[index]!.file)!.equals(source));
 }
 assert.ok(!files.get('ui.js')!.toString('utf8').includes('createAppSandboxClient'),'the page no longer uses the sandbox bridge');
 assert.deepEqual(projection.api.filter(api=>api.businessEntry).map(api=>api.id).sort(),['bootstrap','list','recipients','session']);
 assert.equal(projection.api.find(api=>api.id==='reverse-outbound')?.businessPermission,'app.materials.delete-consumption');
 assert.deepEqual(projection.routes.map(route=>[route.path,route.permission]),[['/','app.materials.read-stock'],['/records','app.materials.read-records'],['/settings','app.materials.manage']]);
});

test('default composition accepts declared isolated app APIs without enabling unrelated extensions',async()=>{
 const {isAppRuntimeSupported}=await import('../src/app-platform/management/config.ts');
 const manifest=(await buildMaterialsPackage()).projection as any;
 const config:any={managedStorage:true,docker:{}};
 assert.equal(isAppRuntimeSupported(manifest,config),true);
 for(const change of [{api:[{...manifest.api[0],permission:'platform.authorization.manage'}]},{api:[{...manifest.api[0],permission:undefined}]},{tools:[{}]},{jobs:[{}]},{network:{frontendOrigins:[],backendOrigins:['https://example.com']}}])assert.equal(isAppRuntimeSupported({...manifest,...change},config),false);
 assert.equal(isAppRuntimeSupported(manifest,{...config,docker:undefined}),false);
 assert.equal(isAppRuntimeSupported(manifest,{...config,managedStorage:false}),false);
});
