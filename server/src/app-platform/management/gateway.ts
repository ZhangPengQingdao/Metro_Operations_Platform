import {createOrganizationContextOperation} from '../gateway/organization-context.js';
import {createWebhookOperation} from '../gateway/webhook.js';
import {createSignatureGatewayOperations} from '../gateway/signatures.js';
import {AppBusinessAuthorization} from '../business-authorization/service.js';
import type {ConnectablePool,QueryableClient} from '../../core/database/index.js';
import {createPostgresCoreTechnicalAuditRepository} from '../../core/observability/index.js';
import {createPlatformActorContextResolver,type PlatformActorContextResolver} from '../../platform/context/index.js';
import {createPostgresPeopleDirectoryRepository} from '../../platform/people/index.js';
import {createAuthorizationService,createPostgresAuthorizationRepository} from '../../platform/authorization/index.js';
import {createPostgresLocationDirectoryRepository} from '../../platform/locations/index.js';
import {createPostgresAssetDirectoryRepository} from '../../platform/assets/index.js';
import {AppRegistryService,PostgresAppRegistryRepository} from '../registry/index.js';
import type {AppGatewayOperation} from '../gateway/model.js';
import {AppGateway} from '../gateway/gateway.js';
import {createPeopleDirectoryOperation} from '../gateway/people-directory.js';
import {createLocationListReader} from '../gateway/location-list.js';
import {createAssetListReader} from '../gateway/asset-list.js';
import {createDirectoryGatewayOperations} from '../gateway/directory.js';

/** Runtime requests never borrow the lifecycle manager's transaction session. */
function createManagementContexts(pool:ConnectablePool&QueryableClient){
 async function withContext<T>(work:(value:ReturnType<typeof services>)=>Promise<T>):Promise<T>{
  const client=await pool.connect();try{return await work(services(client));}finally{client.release();}
 }
 function services(client:QueryableClient){
  const people=createPostgresPeopleDirectoryRepository(client);
  const authorization=createAuthorizationService(createPostgresAuthorizationRepository(client),{findPerson:id=>people.findPersonById(id)});
  const registry=new AppRegistryService(new PostgresAppRegistryRepository(client),{authorization,host:()=>{throw Error('RUNTIME_READ_ONLY');}});
  return {registry,resolver:createPlatformActorContextResolver({people,authorization,resolveAppGrant:registry.createGrantResolver()})};
 }
 const contextResolver:Pick<PlatformActorContextResolver,'resolve'>={async resolve(input){
  const snapshot=structuredClone(input);
  const actor=await withContext(s=>s.resolver.resolve(snapshot));
  return {...actor,
   authorize:(permission,resource)=>withContext(async s=>(await s.resolver.resolve(snapshot)).authorize(permission,resource)),
   authorizeApplication:(permission,resource)=>withContext(async s=>(await s.resolver.resolve(snapshot)).authorizeApplication!(permission,resource))};
 }};
 return {contextResolver,authenticateServiceCredential:(...args:Parameters<AppRegistryService['authenticateServiceCredential']>)=>withContext(s=>s.registry.authenticateServiceCredential(...args))};
}
export function createManagementGateway(pool:ConnectablePool&QueryableClient,additionalOperations:readonly AppGatewayOperation[]=[]){
 const {contextResolver,authenticateServiceCredential}=createManagementContexts(pool);
 return new AppGateway({registry:{authenticateServiceCredential},contextResolver,
  auditRepository:createPostgresCoreTechnicalAuditRepository(pool),
  operations:[createOrganizationContextOperation(createPostgresPeopleDirectoryRepository(pool)),createWebhookOperation(),...createSignatureGatewayOperations(pool),createPeopleDirectoryOperation(createPostgresPeopleDirectoryRepository(pool)),...createDirectoryGatewayOperations({listLocations:createLocationListReader(pool),listAssets:createAssetListReader(pool),locations:createPostgresLocationDirectoryRepository(pool),assets:createPostgresAssetDirectoryRepository(pool)}),...additionalOperations]});
}
/** Without a trusted business resource adapter, only truly unrestricted grants can pass {}. */
export function createManagementApiAuthorization(pool:ConnectablePool&QueryableClient){
 const {contextResolver}=createManagementContexts(pool),business=new AppBusinessAuthorization(pool);
 type Actor=Awaited<ReturnType<PlatformActorContextResolver['resolve']>>;
 const snapshots=new WeakMap<Actor,ReturnType<AppBusinessAuthorization['resolve']>>();
 const businessSessions=new Map<string,{value:ReturnType<AppBusinessAuthorization['resolve']>;expires:number}>();
 const cache=<T>(entries:Map<string,{value:Promise<T>;expires:number}>,key:string,load:()=>Promise<T>,limit:number):Promise<T>=>{
  const entry=entries.get(key);
  if(entry&&entry.expires>Date.now()){entries.delete(key);entries.set(key,entry);return entry.value;}
  const value=load();entries.set(key,{value,expires:Date.now()+30_000});
  if(entries.size>limit)entries.delete(entries.keys().next().value!);
  void value.catch(()=>{if(entries.get(key)?.value===value)entries.delete(key);});
  return value;
 };
 function rulesFor(context:Actor){
  if(context.actorType!=='person'||context.execution.type!=='application')return Promise.resolve(null);
  let rules=snapshots.get(context);
  if(!rules){const appId=context.execution.appId,personId=context.person.id;rules=cache(businessSessions,`${personId}:${appId}:${context.person.organization?.id??''}`,()=>business.resolve(appId,personId),512);snapshots.set(context,rules);}
  return rules;
 }
 return {contextResolver,
  clearSessions:()=>businessSessions.clear(),
  businessAuthorization:async(context:Awaited<ReturnType<PlatformActorContextResolver['resolve']>>)=>{
   if(context.actorType!=='person'||context.execution.type!=='application')return undefined;
   return await rulesFor(context)??undefined;
  },
  authorize:async(context:Awaited<ReturnType<PlatformActorContextResolver['resolve']>>,permission:string)=>{
   if(context.actorType!=='person'||context.execution.type!=='application')return false;
   const rules=await rulesFor(context);
   if(!rules)return (await context.authorize(permission,{})).allowed;
   return permission.startsWith(`app.${context.execution.appId}.`)&&rules.grants.some(g=>g.permission===permission);
  }};
}
