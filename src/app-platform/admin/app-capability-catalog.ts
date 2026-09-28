import type {AppManifest} from '@metro/platform-sdk/app-manifest';

export interface CatalogInstallation {
  appId:string;
  enabled:boolean;
  manifest:Pick<AppManifest,'id'|'name'|'version'|'api'|'permissions'>;
}

export function appCapabilityCatalog(installations:readonly CatalogInstallation[],publications:readonly {appId:string;apiId:string}[]){
  const active=new Set(publications.map(item=>`${item.appId}:${item.apiId}`));
  return installations.map(installation=>{
    const manifest=installation.manifest;
    const exposed=manifest.api.filter(api=>api.expose).map(api=>({
      id:`${manifest.id}.${api.id}`,
      apiId:api.id,
      description:manifest.permissions.defined.find(permission=>permission.code===api.businessPermission)?.description??'',
      method:api.method,
      path:api.path,
      permission:api.businessPermission!,
      contractVersion:api.expose!.contractVersion,
      mode:api.expose!.mode,
      published:installation.enabled&&active.has(`${installation.appId}:${api.id}`),
    }));
    return {appId:installation.appId,name:manifest.name,version:manifest.version,enabled:installation.enabled,
      apiCount:manifest.api.length,capabilities:exposed};
  }).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')||a.appId.localeCompare(b.appId));
}
