import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';

export class AppManagementError extends Error {constructor(readonly code:string){super(code);}}

const absolute=z.string().min(1).refine(value=>isAbsolute(value)&&!/[\x00-\x1f,]/.test(value));
const schema=z.object({
 version:z.literal(1),
 /** Installed `.mopkg` files, unpacked per version under `<artifactRoot>/v2`. */
 artifactRoot:absolute,
 /** Temporary upload files. */
 uploadRoot:absolute,
 // Keys written by platform versions before 1.0.0 (signed packages, Docker runtime); accepted and ignored.
 runtimeRoot:z.unknown().optional(),publisherPolicyFile:z.unknown().optional(),approvedManifestDigests:z.unknown().optional(),managedStorage:z.unknown().optional(),docker:z.unknown().optional(),
}).strict();
export interface AppManagementConfig {version:1;artifactRoot:string;uploadRoot:string}
export async function loadAppManagementConfig(file:string):Promise<AppManagementConfig>{
 if(!isAbsolute(file))throw new AppManagementError('APP_MANAGEMENT_CONFIG_INVALID');
 const text=await readFile(file,'utf8');
 if(Buffer.byteLength(text)>262144)throw new AppManagementError('APP_MANAGEMENT_CONFIG_INVALID');
 const data=schema.parse(JSON.parse(text));
 return {version:1,artifactRoot:data.artifactRoot,uploadRoot:data.uploadRoot};
}
