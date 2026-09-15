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
import {createDirectoryGatewayOperations} from '../gateway/directory.js';

/** Runtime requests never borrow the lifecycle manager's transaction session. */
export function createManagementGateway(pool:ConnectablePool&QueryableClient,additionalOperations:readonly AppGatewayOperation[]=[]){
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
 return new AppGateway({registry:{authenticateServiceCredential:(...args)=>withContext(s=>s.registry.authenticateServiceCredential(...args))},contextResolver,
  auditRepository:createPostgresCoreTechnicalAuditRepository(pool),
  operations:[...createDirectoryGatewayOperations({locations:createPostgresLocationDirectoryRepository(pool),assets:createPostgresAssetDirectoryRepository(pool)}),...additionalOperations]});
}
