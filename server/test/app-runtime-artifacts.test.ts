import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stageAppArtifacts } from '../src/app-platform/runtime/artifacts.ts';
import type { AppManifest } from '../src/app-platform/manifest/index.ts';
const bytes=Buffer.from('export const value = 1;');
function manifest():AppManifest{return {manifestVersion:'1.0',id:'demo',version:'1.0.0',name:'Demo',description:'test',publisherId:'example',compatibility:{platform:{minInclusive:'0.0.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:[],defined:[]},ui:{mode:'sandbox',entryArtifactId:'front'},backend:{mode:'none'},storage:{mode:'none'},routes:[],api:[],navigation:[],events:{publish:[],subscribe:[]},tools:[],jobs:[],network:{frontendOrigins:[],backendOrigins:[]},resources:[],artifacts:[{id:'front',kind:'frontend',path:'ui/front.js',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};}
test('artifact staging publishes only verified bytes and independent bundles',async()=>{
 const root=await mkdtemp(join(tmpdir(),'afc-artifacts-'));try{
 const a=await stageAppArtifacts({root,manifest:manifest(),read:async()=>bytes});
 assert.equal(await readFile(join(a.path,'ui/front.js'),'utf8'),bytes.toString());
 const b=await stageAppArtifacts({root,manifest:manifest(),read:async()=>bytes});assert.notEqual(a.path,b.path);assert.equal(a.manifestDigest,b.manifestDigest);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('invalid hash/size rejects and removes unpublished staging',async()=>{
 const root=await mkdtemp(join(tmpdir(),'afc-artifacts-'));try{
 for(const bad of [Buffer.from('bad'),Buffer.alloc(bytes.length)])await assert.rejects(stageAppArtifacts({root,manifest:manifest(),read:async()=>bad}),/ARTIFACT_(SIZE|HASH)_MISMATCH/);
 assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('manifest is snapshotted before reader awaits and caller bytes are copied',async()=>{
 const root=await mkdtemp(join(tmpdir(),'afc-artifacts-'));try{
 const m=manifest();let release!:(value:Uint8Array)=>void;
 const staged=stageAppArtifacts({root,manifest:m,read:()=>new Promise(resolve=>{release=resolve;})});
 m.artifacts[0].path='changed.js';
 while(!release)await new Promise(resolve=>setImmediate(resolve));release(bytes);
 const result=await staged;assert.equal(await readFile(join(result.path,'ui/front.js'),'utf8'),bytes.toString());
 }finally{await rm(root,{recursive:true,force:true});}
});
test('artifact reader failure leaves no published bundle and no secret error',async()=>{
 const root=await mkdtemp(join(tmpdir(),'afc-artifacts-'));try{
 await assert.rejects(stageAppArtifacts({root,manifest:manifest(),read:async()=>{throw new Error('secret');}}),/ARTIFACT_STAGE_FAILED/);assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('published artifacts remain readable by container user with restrictive host umask', async () => {
 const root = await mkdtemp(join(tmpdir(), 'afc-artifacts-'));
 const previous = process.umask(0o077);
 try {
  const m = manifest(); m.artifacts[0].path = 'ui/nested/front.js';
  const bundle = await stageAppArtifacts({ root, manifest: m, read: async () => bytes });
  for (const path of [bundle.path, join(bundle.path, 'ui'), join(bundle.path, 'ui/nested')]) {
   assert.equal((await stat(path)).mode & 0o777, 0o755);
  }
  assert.equal((await stat(join(bundle.path, 'ui/nested/front.js'))).mode & 0o777, 0o444);
 } finally { process.umask(previous); await rm(root, { recursive: true, force: true }); }
});
