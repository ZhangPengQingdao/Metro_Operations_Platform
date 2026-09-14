import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { validateAppManifest } from '../manifest/index.js';
import { readDeveloperFile, snapshotPackage } from '../developer/package.js';
import { InstallError } from './journal.js';
export const INSTALL_BODY_LIMIT=92*1024*1024;
const schema=z.object({requestId:z.string().regex(/^[a-zA-Z0-9-]{16,64}$/),manifest:z.unknown(),signature:z.string().max(4096),artifacts:z.array(z.object({id:z.string().max(64),base64:z.string().max(90*1024*1024)}).strict()).max(128)}).strict();
export async function encodeInstallPackage(directory:string,signatureFile:string,requestId:string){
 const snapshot=await snapshotPackage(directory);const signature=(await readDeveloperFile(signatureFile,4096)).toString('utf8');
 return {requestId,manifest:snapshot.manifest,signature,artifacts:snapshot.manifest.artifacts.map(a=>({id:a.id,base64:snapshot.files.get(a.path)!.toString('base64')}))};
}
/** Bounded wire format, no archive extraction or client filesystem paths. */
export async function withInstallUpload<T>(value:unknown,root:string,run:(input:{requestId:string;directory:string;signatureFile:string})=>Promise<T>){
 const parsed=schema.safeParse(value);if(!parsed.success)throw new InstallError('INVALID_INSTALL_PACKAGE');
 const input=parsed.data;const valid=validateAppManifest(input.manifest);if(!valid.ok)throw new InstallError('INVALID_INSTALL_PACKAGE');
 const manifest=valid.manifest;
 if(manifest.artifacts.length!==input.artifacts.length||manifest.artifacts.reduce((sum,a)=>sum+a.bytes,0)>64*1024*1024)throw new InstallError('INVALID_INSTALL_PACKAGE');
 const ids=new Set<string>();const files=new Map<string,Buffer>();
 const paths=new Set(['manifest.json','package-signature.json']);
 for(const a of manifest.artifacts){const path=a.path.toLowerCase();if(paths.has(path))throw new InstallError('INVALID_INSTALL_PACKAGE');paths.add(path);}
 for(const path of paths){const parts=path.split('/');for(let i=1;i<parts.length;i++)if(paths.has(parts.slice(0,i).join('/')))throw new InstallError('INVALID_INSTALL_PACKAGE');}
 for(const item of input.artifacts){
  const a=manifest.artifacts.find(a=>a.id===item.id);if(!a||ids.has(item.id)||item.base64.length!==4*Math.ceil(a.bytes/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64))throw new InstallError('INVALID_INSTALL_PACKAGE');
  ids.add(item.id);const bytes=Buffer.from(item.base64,'base64');if(bytes.length!==a.bytes||bytes.toString('base64')!==item.base64)throw new InstallError('INVALID_INSTALL_PACKAGE');files.set(a.path,bytes);
 }
 await mkdir(root,{recursive:true,mode:0o700});const directory=await mkdtemp(join(root,'upload-'));const signatureFile=join(directory,'package-signature.json');
 try{
  await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest),{flag:'wx',mode:0o600});
  await writeFile(signatureFile,input.signature,{flag:'wx',mode:0o600});
  for(const [path,bytes]of files){await mkdir(dirname(join(directory,path)),{recursive:true,mode:0o700});await writeFile(join(directory,path),bytes,{flag:'wx',mode:0o600});}
  return await run({requestId:input.requestId,directory,signatureFile});
 }finally{await rm(directory,{recursive:true,force:true});}
}
