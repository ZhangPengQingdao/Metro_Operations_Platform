import {AppGatewayClientError, type AppGatewayJson} from './app-gateway.js';

export interface DirectoryPerson {id:string;name:string;employeeNo:string;organizationUnitId:string}
export interface DirectoryLocation {id:string;code:string;name:string;locationType:string;status:string;organizationUnitId:string|null}
export interface DirectoryAsset {id:string;displayName:string;assetCode:string|null;locationId:string;typeId:string;lifecycleState:string;organizationUnitId:string|null}
export interface DirectoryPage<T> {organizationUnitId:string|null;rows:T[];nextCursor:string|null}
export interface LocationQuery {afterId?:string;pageSize?:number;search?:string;status?:'active'|'inactive';organizationUnitId?:string}
export interface AssetQuery {afterId?:string;pageSize?:number;search?:string;lifecycleState?:'planned'|'active'|'suspended'|'retired';organizationUnitId?:string;locationId?:string;typeId?:string;typeName?:string}
export interface ResponsibleStations {organizationUnitId:string;lines:{id:string;name:string}[];stations:{id:string;name:string;lineId:string;lineName:string}[]}
export interface DirectoryGateway {invoke(operation:string,params:AppGatewayJson,signal?:AbortSignal):Promise<AppGatewayJson>}

/** Use the backend's host-bound Gateway. Grants and resource scopes are checked by the platform on every request. */
export function createPlatformDirectoryClient(gateway:DirectoryGateway) {
  const call=<T>(operation:string,params:object,signal?:AbortSignal)=>gateway.invoke(operation,params as AppGatewayJson,signal) as Promise<T>;
  const page=(query:LocationQuery|AssetQuery)=>{
    if(query.pageSize!==undefined&&(!Number.isInteger(query.pageSize)||query.pageSize<1||query.pageSize>50))
      throw new AppGatewayClientError('INVALID_PARAMS','not_started');
  };
  return Object.freeze({
    members(params:{organizationUnitId:string;personId?:string;personIds?:readonly string[];search?:string},signal?:AbortSignal) {
      return call<{organizationUnitId:string;rows:DirectoryPerson[]}>('platform.people.members',params,signal);
    },
    organizationContext(organizationUnitId:string,signal?:AbortSignal) {
      return call<{organizations:{id:string;name:string;unitType:string}[]}>('platform.people.organization_context',{organizationUnitId},signal);
    },
    locations(query:LocationQuery={},signal?:AbortSignal) {page(query);return call<DirectoryPage<DirectoryLocation>>('platform.locations.list',query,signal);},
    location(id:string,signal?:AbortSignal) {return call<DirectoryLocation>('platform.locations.get',{id},signal);},
    assets(query:AssetQuery={},signal?:AbortSignal) {page(query);return call<DirectoryPage<DirectoryAsset&{typeName:string}>>('platform.assets.list',query,signal);},
    asset(id:string,signal?:AbortSignal) {return call<DirectoryAsset>('platform.assets.get',{id},signal);},
    responsibleStations(params:{organizationUnitId:string;lineName?:string;stationId?:string;search?:string},signal?:AbortSignal) {
      return call<ResponsibleStations>('platform.locations.responsible_stations',params,signal);
    },
  });
}
