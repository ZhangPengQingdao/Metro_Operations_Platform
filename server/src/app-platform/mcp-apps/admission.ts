import { isDeepStrictEqual } from 'node:util';
import { assertPlatformMcpToolContribution, assertPlatformMcpToolResult, type PlatformMcpToolContribution, type PlatformMcpToolResult } from '../../platform/mcp/index.js';
import type { AppInstallation } from '../registry/index.js';
import { validateAppManifest } from '../manifest/index.js';

export interface McpViewAdmissionOptions {
 /** Trusted binding to the installed contribution, never selected by model input. */
 appId:string;
 contribution:PlatformMcpToolContribution;
 getInstallation():Promise<AppInstallation|null>;
 authorize(installation:AppInstallation,toolName:string):Promise<boolean>;
}
/** Resource admission only: no HTML execution, network fetch or tool replay. */
export async function admitMcpView(options:McpViewAdmissionOptions,toolName:string,result:PlatformMcpToolResult){
 assertPlatformMcpToolResult(result);
 const fallback=structuredClone(result);
 try{
  assertPlatformMcpToolContribution(options.contribution);
  const {callTool:_call,...metadata}=options.contribution;
  const contribution=structuredClone(metadata);
  const tool=contribution.tools.find(tool=>tool.name===toolName);
  if(!tool?._meta?.ui.resourceUri)return {kind:'text' as const,result:fallback};
  const before=await options.getInstallation();
  if(!before||!before.enabled||before.appId!==options.appId||!validateAppManifest(before.manifest).ok)throw Error();
  const installation=structuredClone(before);
  if(tool.owner.type!=='application'||tool.owner.id!==installation.appId)throw Error();
  const declaration=installation.manifest.tools.find(item=>item.name===toolName);
  const declaredResource=installation.manifest.resources.find(item=>item.id===declaration?.uiResourceId&&item.kind==='mcp-ui');
  const artifact=installation.manifest.artifacts.find(item=>item.id===declaredResource?.artifactId);
  const resource=contribution.resources?.find(item=>item.uri===tool._meta!.ui.resourceUri);
  if(!declaration||!declaredResource||!artifact||!resource||resource.owner.type!=='application'||resource.owner.id!==installation.appId
   ||artifact.sha256!==resource.sha256||artifact.bytes!==Buffer.byteLength(resource.html,'utf8'))throw Error();
  if(!await options.authorize(installation,toolName))throw Error();
  const after=await options.getInstallation();
  if(!isDeepStrictEqual(after,installation)||!await options.authorize(installation,toolName))throw Error();
  return {kind:'resource' as const,result:fallback,installationId:installation.id,revision:installation.revision,version:installation.manifest.version,
   contributionId:contribution.id,resource};
 }catch{return {kind:'text' as const,result:fallback,reason:'CARD_UNAVAILABLE' as const};}
}
