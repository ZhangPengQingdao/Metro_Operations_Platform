import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {readDeveloperFile} from '../developer/package.js';
import type {AppManifest} from '../manifest/index.js';
const absolute=z.string().min(1).refine(value=>isAbsolute(value)&&!/[\x00-\x1f,]/.test(value));
const schema=z.object({
 version:z.literal(1), artifactRoot:absolute, runtimeRoot:absolute, uploadRoot:absolute,
 publisherPolicyFile:absolute,
 // Exact manifest approval is separate from publisher signature trust.
 approvedManifestDigests:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(512),
 managedStorage:z.boolean().optional(),
 docker:z.object({socketPath:absolute,runtimeImage:z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
  approval:z.object({imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),config:z.record(z.unknown())}).strict(),
 }).strict().optional(),
}).strict();
export interface AppManagementConfig {version:1;artifactRoot:string;runtimeRoot:string;uploadRoot:string;publisherPolicyFile:string;approvedManifestDigests:string[];managedStorage?:boolean;docker?:{socketPath:string;runtimeImage:string;approval:{imageId:string;config:Record<string,unknown>}}}
export async function loadAppManagementConfig(file:string):Promise<AppManagementConfig>{
 const data=schema.parse(JSON.parse((await readDeveloperFile(file,262144)).toString('utf8')));
 return {version:1,artifactRoot:data.artifactRoot!,runtimeRoot:data.runtimeRoot!,uploadRoot:data.uploadRoot!,publisherPolicyFile:data.publisherPolicyFile!,approvedManifestDigests:data.approvedManifestDigests!,...(data.managedStorage!==undefined?{managedStorage:data.managedStorage}:{}),...(data.docker?{docker:{socketPath:data.docker.socketPath!,runtimeImage:data.docker.runtimeImage!,approval:{imageId:data.docker.approval!.imageId!,config:data.docker.approval!.config!}}}:{})};
}
function canonical(value:unknown):string{if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value!==null&&typeof value==='object'){const record=value as Record<string,unknown>;return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;}return JSON.stringify(value);}
export function manifestApprovalDigest(manifest:AppManifest){return createHash('sha256').update(canonical(manifest)).digest('hex');}
export function isAppRuntimeSupported(manifest:AppManifest,config:AppManagementConfig){
 // Admission never silently ignores uncomposed capabilities.
 return ['none','sandbox'].includes(manifest.ui.mode)
  && (manifest.backend.mode==='none'||(manifest.backend.mode==='isolated'&&!!config.docker))
  && (manifest.storage.mode==='none'||(manifest.storage.mode==='managed'&&config.managedStorage===true)) && !manifest.events.publish.length && !manifest.events.subscribe.length
  && !manifest.jobs.length && !manifest.tools.length
  && (!manifest.api.length || (manifest.backend.mode==='isolated' && !!config.docker
   && manifest.api.every(api=>!!api.permission && api.permission.startsWith(`app.${manifest.id}.`)
    && manifest.permissions.defined.some(permission=>permission.code===api.permission))))
  && !manifest.network.frontendOrigins.length && !manifest.network.backendOrigins.length;
}
