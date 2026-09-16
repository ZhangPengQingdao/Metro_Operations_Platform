import {isDeepStrictEqual} from 'node:util';
import type {AppManifest} from './index.js';
/** Installed migrations are immutable. Only append signed declarations to the existing prefix. */
export function isAppendOnlyStorageVersion(previous:AppManifest,next:AppManifest):boolean{
 if(previous.storage.mode!=='managed'||next.storage.mode!=='managed')return isDeepStrictEqual(previous.storage,next.storage);
 if(next.storage.migrations.length<previous.storage.migrations.length)return false;
 return previous.storage.migrations.every((declaration,index)=>
  isDeepStrictEqual(declaration,next.storage.mode==='managed'?next.storage.migrations[index]:undefined)&&
  !!previous.artifacts.find(a=>a.id===declaration.artifactId)&&
  isDeepStrictEqual(previous.artifacts.find(a=>a.id===declaration.artifactId),next.artifacts.find(a=>a.id===declaration.artifactId)));
}
