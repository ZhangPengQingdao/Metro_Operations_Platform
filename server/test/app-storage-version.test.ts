import test from 'node:test';
import assert from 'node:assert/strict';
import {isAppendOnlyStorageVersion} from '../src/app-platform/manifest/storage-version.ts';
import type {AppManifest} from '../src/app-platform/manifest/index.ts';
const previous={storage:{mode:'managed',migrations:[{id:'initial',artifactId:'initial'}]},artifacts:[{id:'initial',kind:'migration',path:'initial.json',sha256:'a'.repeat(64),bytes:100}]} as AppManifest;
function next(){return {...structuredClone(previous),storage:{mode:'managed' as const,migrations:[...structuredClone(previous.storage.mode==='managed'?previous.storage.migrations:[]),{id:'append',artifactId:'append'}]},artifacts:[...structuredClone(previous.artifacts),{id:'append',kind:'migration' as const,path:'append.json',sha256:'b'.repeat(64),bytes:120}]};}
test('storage versions allow an identical signed prefix and appended migrations',()=>{
 assert.equal(isAppendOnlyStorageVersion(previous,structuredClone(previous)),true);
 assert.equal(isAppendOnlyStorageVersion(previous,next()),true);
});
test('storage versions reject mutation, removal, reorder, storage mode changes and missing original artifacts',()=>{
 for(const mutate of [
  (m:ReturnType<typeof next>)=>{m.storage.migrations.reverse();},
  (m:ReturnType<typeof next>)=>{m.storage.migrations=[];},
  (m:ReturnType<typeof next>)=>{m.storage.migrations[0].id='renamed';},
  (m:ReturnType<typeof next>)=>{m.artifacts[0].sha256='c'.repeat(64);},
  (m:ReturnType<typeof next>)=>{m.artifacts[0].path='moved.json';},
  (m:ReturnType<typeof next>)=>{m.artifacts[0].bytes=101;},
  (m:ReturnType<typeof next>)=>{m.artifacts.shift();},
 ]){const target=next();mutate(target);assert.equal(isAppendOnlyStorageVersion(previous,target),false);}
 assert.equal(isAppendOnlyStorageVersion(previous,{...previous,storage:{mode:'none'}}),false);
 assert.equal(isAppendOnlyStorageVersion(next(),previous),false); // schema downgrade must not discard applied history
});
