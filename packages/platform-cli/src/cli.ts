import {gzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {createAppProject} from '../../../server/src/app-platform/developer/scaffold.js';
import metadata from '../package.json';
import {randomUUID} from 'node:crypto';
import {AppPackageError,validateAppDirectory,packAppDirectory,snapshotPackage,readDeveloperFile} from '../../../server/src/app-platform/developer/package.js';
import {signAppDirectory,verifyAppDirectory,readPackageSignature} from '../../../server/src/app-platform/developer/signature.js';
const [command,...args]=process.argv.slice(2);
try{
 let result:unknown;
 if(command==='create'&&args.length===4)result=await createAppProject(args[0],args[1],args[2],args[3],{templates:new URL('./templates/',import.meta.url),sdkVersion:metadata.version});
 else if(command==='validate'&&args.length===1){const value=await validateAppDirectory(args[0]);result={appId:value.manifest.id,version:value.manifest.version,artifactBytes:value.artifactBytes};}
 else if(command==='pack'&&args.length===2)result=await packAppDirectory(args[0],args[1]);
 else if(command==='sign'&&args.length===4)result=await signAppDirectory(args[0],args[1],args[2],args[3]);
 else if(command==='verify'&&args.length===5)result=await verifyAppDirectory(args[0],args[1],{keyId:args[2],publisherId:args[3],publicKeyPem:(await readDeveloperFile(args[4],16384)).toString('utf8'),revoked:false});
 else if(command==='export-upload'&&args.length===3){
  const snapshot=await snapshotPackage(args[0]);await readPackageSignature(args[1]);
  const requestId=randomUUID(),value={requestId,manifest:snapshot.manifest,signature:(await readDeveloperFile(args[1],4096)).toString('utf8'),artifacts:snapshot.manifest.artifacts.map(a=>({id:a.id,base64:snapshot.files.get(a.path)!.toString('base64')}))};
  const json=JSON.stringify(value);if(Buffer.byteLength(json)>92*1024*1024)throw new AppPackageError('INSTALL_PACKAGE_TOO_LARGE');
  await writeFile(resolve(args[2]),args[2].endsWith('.gz')?gzipSync(json):json,{flag:'wx',mode:0o600});result={appId:value.manifest.id,version:value.manifest.version,requestId,output:resolve(args[2])};
 }else{
  console.error('Usage: mop-app create <new-dir> <app-id> <trusted|sandbox|backend> <publisher-id> | validate <built-dir> | pack <built-dir> <new-dir> | sign <built-dir> <key-id> <private-key-file> <new-signature-file> | verify <built-dir> <signature-file> <key-id> <publisher-id> <public-key-file> | export-upload <built-dir> <signature-file> <new-output.json|new-output.mop.gz>');process.exitCode=2;
 }
 if(result)console.log(JSON.stringify({ok:true,result}));
}catch(error){console.error(JSON.stringify({ok:false,code:error instanceof AppPackageError?error.code:'PACKAGE_IO_FAILED'}));process.exitCode=1;}
