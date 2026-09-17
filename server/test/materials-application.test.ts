import '../../applications/materials/test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {compileAppMigration} from '../src/app-platform/storage/declarative-migration.ts';
import {createMaterialsService} from '../../applications/materials/service.mjs';

test('independent materials service uses declarative schema and rolls back stock if ledger insertion fails',async()=>{
 const db=new PGlite(),schema='app_'+randomUUID().replaceAll('-','');
 try{
  await db.exec(`CREATE SCHEMA "${schema}"`);
  const migration=await readFile(new URL('../../applications/materials/migration-001.json',import.meta.url),'utf8');
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
  const upgrade=await readFile(new URL('../../applications/materials/migration-002.json',import.meta.url),'utf8');
  for(const sql of compileAppMigration(upgrade,schema))await db.exec(sql);
  const retained=(await db.query(`SELECT quantity,specification FROM "${schema}".materials`)).rows[0];assert.equal(retained.quantity,8);assert.equal(retained.specification,null);

  const receiverMigration=await readFile(new URL('../../applications/materials/migration-003.json',import.meta.url),'utf8');
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
 const {createMaterialsHandlers}=await import('../../applications/materials/handlers.mjs');
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

test('materials build can be signed and exported by standalone public CLI',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const exec=promisify(execFile);
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {generateKeyPairSync}=await import('node:crypto');const root=await mkdtemp(join(tmpdir(),'mop-material-package-'));
 const repository=new URL('../../',import.meta.url),cli=new URL('../../packages/platform-cli/dist/cli.mjs',import.meta.url);
 const {fileURLToPath}=await import('node:url');const app=fileURLToPath(new URL('../../applications/materials/dist',import.meta.url));
 try{
  await exec(process.execPath,['applications/materials/build.mjs'],{cwd:repository});
  await exec(process.execPath,['applications/materials/build.mjs','--upgrade'],{cwd:repository});
  const original=JSON.parse(await readFile(join(app,'manifest.json'),'utf8')),upgraded=JSON.parse(await readFile(join(app+'-upgrade','manifest.json'),'utf8'));
  const {isAppendOnlyStorageVersion}=await import('../src/app-platform/manifest/storage-version.ts');assert.equal(isAppendOnlyStorageVersion(original,upgraded),true);
  const run=(...args:string[])=>exec(process.execPath,[fileURLToPath(cli),...args],{cwd:root});
  const pair=generateKeyPairSync('ed25519');await writeFile(join(root,'key.pem'),pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  await writeFile(join(root,'public.pem'),pair.publicKey.export({type:'spki',format:'pem'}));
  await run('validate',app);await run('sign',app,'test-key','key.pem','signature.json');
  await run('verify',app,'signature.json','test-key','metro-apps','public.pem');
  await run('export-upload',app,'signature.json','materials.json');
  const upload=JSON.parse(await readFile(join(root,'materials.json'),'utf8'));assert.equal(upload.manifest.id,'materials');assert.equal(upload.artifacts.length,5);assert.deepEqual(upload.manifest.storage.migrations.map((m:any)=>m.id),['initial','specification','receiver']);
  const {withInstallUpload}=await import('../src/app-platform/install/wire.ts');
  const {verifyAppDirectory}=await import('../src/app-platform/developer/signature.ts');
  await withInstallUpload(upload,join(root,'uploads'),input=>verifyAppDirectory(input.directory,input.signatureFile,{keyId:'test-key',publisherId:'metro-apps',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString(),revoked:false}));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('default composition accepts declared isolated app APIs without enabling unrelated extensions',async()=>{
 const {isAppRuntimeSupported}=await import('../src/app-platform/management/config.ts');
 const manifest=JSON.parse(await readFile(new URL('../../applications/materials/dist/manifest.json',import.meta.url),'utf8'));
 const config:any={managedStorage:true,docker:{}};
 assert.equal(isAppRuntimeSupported(manifest,config),true);
 for(const change of [{api:[{...manifest.api[0],permission:'platform.authorization.manage'}]},{api:[{...manifest.api[0],permission:undefined}]},{tools:[{}]},{jobs:[{}]},{network:{frontendOrigins:[],backendOrigins:['https://example.com']}}])assert.equal(isAppRuntimeSupported({...manifest,...change},config),false);
 assert.equal(isAppRuntimeSupported(manifest,{...config,docker:undefined}),false);
 assert.equal(isAppRuntimeSupported(manifest,{...config,managedStorage:false}),false);
});
