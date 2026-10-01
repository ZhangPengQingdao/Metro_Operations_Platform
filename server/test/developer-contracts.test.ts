import test from 'node:test';
import assert from 'node:assert/strict';
import {isAppApiDocumentation,matchesAppContract,type AppApiDocumentation} from '@metro/platform-sdk/app-api-documentation';
import {createPlatformDirectoryClient} from '@metro/platform-sdk/app-directory';
import {createPlatformNotificationsClient} from '@metro/platform-sdk/app-gateway';
import {PLATFORM_APP_OPERATIONS,PLATFORM_SDK_MODULES} from '@metro/platform-sdk/app-contracts';
import {readFile,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createNotificationGatewayOperations} from '../src/app-platform/gateway/notifications.ts';
import {createDirectoryGatewayOperations} from '../src/app-platform/gateway/directory.ts';
import {createPeopleDirectoryOperation} from '../src/app-platform/gateway/people-directory.ts';
import {createOrganizationContextOperation} from '../src/app-platform/gateway/organization-context.ts';
import {createAiCompletionOperation} from '../src/app-platform/gateway/ai.ts';
import {createWebhookOperation} from '../src/app-platform/gateway/webhook.ts';
import {createSignatureGatewayOperations} from '../src/app-platform/gateway/signatures.ts';
const documentation:AppApiDocumentation={description:'Record lookup',input:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},output:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false},examples:[{title:'Read',params:{id:'id'},result:{title:'Title'}}],errors:[]};
test('API contract metadata validates examples and rejects unsafe or excessive schema',()=>{
 assert.equal(isAppApiDocumentation(documentation),true);
 for(const change of [{...documentation,input:{$ref:'https://example.com/schema'}},{...documentation,examples:[{title:'Wrong',params:{},result:{title:'Title'}}]},{...documentation,description:'x'.repeat(17000)},{...documentation,input:{type:'object',properties:JSON.parse('{"__proto__":{"type":"string"}}')}}])assert.equal(isAppApiDocumentation(change),false);
 let nested:unknown={type:'string'};for(let i=0;i<10;i++)nested={type:'array',items:nested};assert.equal(isAppApiDocumentation({...documentation,input:nested}),false);
 assert.equal(matchesAppContract(documentation.input,{id:'id',extra:1}),false);
});
test('directory typed client delegates without identity overrides or automatic retries',async()=>{
 const requests:unknown[]=[];const gateway={invoke:async(...args:unknown[])=>{requests.push(args);return {rows:[]};}};
 const client=createPlatformDirectoryClient(gateway);
 await client.members({organizationUnitId:'org'});await client.locations({pageSize:20,afterId:'cursor'});await client.asset('asset');
 assert.deepEqual(requests.map((x:any)=>x.slice(0,2)),[['platform.people.members',{organizationUnitId:'org'}],['platform.locations.list',{pageSize:20,afterId:'cursor'}],['platform.assets.get',{id:'asset'}]]);
 assert.throws(()=>client.locations({pageSize:51}),/INVALID_PARAMS/);assert.equal(requests.length,3);
 let calls=0;await assert.rejects(createPlatformDirectoryClient({invoke:async()=>{calls++;throw Error('OFFLINE');}}).location('id'),/OFFLINE/);assert.equal(calls,1);
});
test('public reference operation names, permissions and modes agree with registered adapters',()=>{
 const deps={locations:{},assets:{},listLocations:async()=>[],listAssets:async()=>[],listResponsibleStations:async()=>({})} as any;
 const ops=[...createDirectoryGatewayOperations(deps),createPeopleDirectoryOperation({} as any),createOrganizationContextOperation({} as any),createAiCompletionOperation(),createWebhookOperation(),...createSignatureGatewayOperations({} as any),...createNotificationGatewayOperations({} as any)];
 for(const operation of ops){const reference=PLATFORM_APP_OPERATIONS.find(item=>item.id===operation.name);assert.ok(reference,operation.name);assert.equal(reference.permission,operation.permissionCode);assert.equal(reference.mode,operation.mode);}
});
test('general and legacy notifications use different operations and never retry',async()=>{
 const calls:unknown[]=[];const client=createPlatformNotificationsClient({invoke:async(...args)=>{calls.push(args);return {id:'id'};}});
 await client.publish({id:'id',entityId:'entity',entityType:'record',personIds:['person'],title:'Title',body:'Body',routeId:'home'});
 await client.create({id:'id',entityId:'entity',personId:'person',title:'Title',body:'Body'});
 assert.equal((calls[0] as any)[0],'platform.notifications.publish');assert.equal((calls[1] as any)[0],'platform.notifications.create');
});

test('SDK entrypoint audit covers published modules and documents file helper exports',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../../packages/platform-sdk/package.json',import.meta.url),'utf8'));
 assert.deepEqual(PLATFORM_SDK_MODULES.map(m=>m.path).sort(),Object.keys(pkg.exports).sort());
 assert.equal(new Set(PLATFORM_APP_OPERATIONS.map(op=>op.id)).size,PLATFORM_APP_OPERATIONS.length);
 for(const path of ['app-files','app-files-backend','app-spreadsheets']){
  const exports=await import(`@metro/platform-sdk/${path}`);
  const references=PLATFORM_APP_OPERATIONS.filter(op=>op.entrypoint===`@metro/platform-sdk/${path}`).map(op=>op.call).join('\n');
  for(const [name,value] of Object.entries(exports))if(typeof value==='function'&&name!=='AppFileError')assert.ok(references.includes(name),`missing public file helper: ${name}`);
 }
});

test('distributed spreadsheet module parses and generates files without repository dependencies',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'metro-spreadsheet-'));
 try{
  const file=join(dir,'spreadsheets.mjs');
  await copyFile(new URL('../../packages/platform-sdk/dist/app-spreadsheets.js',import.meta.url),file);
  const sdk=await import(pathToFileURL(file).href);
  const blob=sdk.jsonToExcelBlob({data:[{title:'车站记录',count:2},{title:'=1+1',count:0}],sheetName:'记录',columns:[{key:'title',header:'标题'},{key:'count',header:'数量'}]});
  const rows=await sdk.parseExcelFile(blob);
  assert.deepEqual(rows,[{'标题':'车站记录','数量':2},{'标题':'=1+1','数量':0}]);
  const workbook=await sdk.parseExcelWorkbook(await blob.arrayBuffer(),'records.xlsx');
  assert.deepEqual(workbook.sheetNames,['记录']);
  assert.deepEqual(workbook.sheets['记录'].headers,['标题','数量']);
  assert.equal(workbook.sheets['记录'].rowCount,3);
  assert.throws(()=>sdk.exportToExcel({data:[{x:1}],filename:'../unsafe.xlsx'}),/INVALID_DOWNLOAD/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
