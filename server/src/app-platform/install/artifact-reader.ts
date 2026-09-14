import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readDeveloperFile } from '../developer/package.js';
import type { InstallRecord } from './journal.js';
import { InstallError } from './journal.js';
/** Pin runtime reads to durable binding, never the transient upload directory. */
export function createInstalledArtifactReader(record:InstallRecord){
 const prepared=structuredClone(record.prepared);
 return async(manifest:unknown,artifactId:string,maxBytes:number)=>{
  if(!isDeepStrictEqual(manifest,prepared.manifest))throw new InstallError('INSTALL_ARTIFACT_BINDING_MISMATCH');
  const artifact=prepared.manifest.artifacts.find(a=>a.id===artifactId);
  if(!artifact||artifact.bytes!==maxBytes)throw new InstallError('INSTALL_ARTIFACT_BINDING_MISMATCH');
  return readDeveloperFile(join(prepared.path,artifact.path),maxBytes);
 };
}
