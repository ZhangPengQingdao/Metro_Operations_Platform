import type {PlatformManagementContext} from '../../platform/context/index.js';
import type {AppLifecycleHost} from '../runtime/lifecycle-host.js';
import type {AppManifest} from '../manifest/index.js';
import {buildSandboxDocument,type SandboxDocument} from '../sandbox/document.js';
import {assertInstallAdmin} from '../install/service.js';
import {frontendRunMode} from '../registry/index.js';
export class AppManagementError extends Error {constructor(readonly code:string){super(code);}}
export async function readInstalledAdminUi(options:{context:PlatformManagementContext;host:Pick<AppLifecycleHost,'status'>;appId:string;path:string;origin:string;publish?:(document:SandboxDocument,authorize:()=>Promise<void>,trustedAppId?:string)=>{mode:'isolated-origin';url:string;platformOrigin:string;frontendRunMode?:'trusted'};readArtifact(manifest:AppManifest,id:string,bytes:number):Promise<Uint8Array>}){
 await assertInstallAdmin(options.context);
 const {installation,serving}=await options.host.status(options.context);
 if(!serving||!installation.enabled)throw new AppManagementError('APP_NOT_SERVING');
 const manifest=installation.manifest;
 if(manifest.id!==options.appId||manifest.ui.mode!=='sandbox')throw new AppManagementError('APP_UI_UNSUPPORTED');
 if(!manifest.routes.some(route=>route.path===options.path))throw new AppManagementError('APP_ROUTE_NOT_FOUND');
 // Admin can inspect an installed app shell, but receives no employee/business grants.
 const origin=new URL(options.origin);
 if(!options.publish&&(origin.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(origin.hostname)))throw new AppManagementError('APP_RESOURCE_ORIGIN_NOT_CONFIGURED');
 const entryArtifactId=manifest.ui.entryArtifactId;
 const artifact=manifest.artifacts.find(item=>item.id===entryArtifactId);
 if(!artifact)throw new AppManagementError('APP_UI_ARTIFACT_MISSING');
 const bytes=await options.readArtifact(manifest,artifact.id,artifact.bytes);
 const trusted=frontendRunMode(installation)==='trusted';
 const document=buildSandboxDocument({platformOrigin:origin.origin,route:options.path,script:{text:Buffer.from(bytes).toString('utf8'),bytes:artifact.bytes,sha256:artifact.sha256},...(trusted?{trusted:{appId:options.appId}}:{})});
 // Recheck after artifact IO so disabling/revising cannot hand out stale resources.
 const fresh=await options.host.status(options.context);
 if(!fresh.serving||fresh.installation.revision!==installation.revision)throw new AppManagementError('APP_NOT_SERVING');
 return {appId:manifest.id,name:manifest.name,requiresEmployee:manifest.api.some(api=>api.businessEntry||api.businessPermission),instanceKey:`${installation.id}:${installation.revision}:${options.path}`,resource:options.publish?options.publish(document,async()=>{await assertInstallAdmin(options.context);const current=await options.host.status(options.context);if(!current.serving||current.installation.revision!==installation.revision)throw new AppManagementError('APP_NOT_SERVING');},trusted?options.appId:undefined):{mode:'local-demo' as const,html:document.html,platformOrigin:origin.origin}};
}
