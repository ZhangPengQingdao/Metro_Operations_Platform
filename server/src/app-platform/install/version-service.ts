import {isDeepStrictEqual} from 'node:util';
import {runAtomicOperation,type QueryableClient,type AtomicParticipant} from '../../core/database/index.js';
import type {MigrationDefinition} from '../../core/migrations/index.js';
import type {PlatformManagementContext} from '../../platform/context/index.js';
import type {AppRegistryService} from '../registry/index.js';
import type {AppLifecycleHost} from '../runtime/lifecycle-host.js';
import {prepareAppInstallation} from '../developer/install-preparation.js';
import {validateAppDirectory} from '../developer/package.js';
import {verifyAppWithPublisherPolicy} from '../developer/publisher-policy.js';
import {assertInstallAdmin} from './service.js';
import {createInstalledArtifactReader} from './artifact-reader.js';
import {InstallError,type InstallJournal,type InstallRecord} from './journal.js';
export interface AppVersionRecord {appId:string;requestId:string;installationId:string;revision:number;state:'prepared'|'updating'|'updated'|'recovery_required'|'recovering'|'recovered';prepared:InstallRecord['prepared'];updatedAt:string;}
export interface AppVersionJournal extends AtomicParticipant {list(appId:string,lock?:boolean):Promise<AppVersionRecord[]>;insert(record:AppVersionRecord):Promise<void>;save(record:AppVersionRecord,expected:number):Promise<void>;}
export class PostgresAppVersionJournal implements AppVersionJournal {
 readonly atomic;constructor(private readonly db:QueryableClient){this.atomic={client:db};}
 async list(appId:string,lock=false){const result=await this.db.query(`SELECT record FROM platform_app_versions WHERE app_id=$1 ORDER BY created_at DESC,request_id DESC${lock?' FOR UPDATE':''}`,[appId]) as {rows:{record:AppVersionRecord}[]};return result.rows.map(row=>row.record);}
 async insert(record:AppVersionRecord){await this.db.query('INSERT INTO platform_app_versions(app_id,request_id,installation_id,revision,state,record) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[record.appId,record.requestId,record.installationId,record.revision,record.state,JSON.stringify(record)]);}
 async save(record:AppVersionRecord,expected:number){const result=await this.db.query('UPDATE platform_app_versions SET revision=$4,state=$5,record=$6::jsonb WHERE app_id=$1 AND request_id=$2 AND revision=$3 AND $4=$3+1 RETURNING request_id',[record.appId,record.requestId,expected,record.revision,record.state,JSON.stringify(record)]) as {rows:unknown[]};if(!result.rows.length)throw new InstallError('VERSION_CONFLICT');}
}
export const APP_VERSION_SQL=`CREATE TABLE IF NOT EXISTS platform_app_versions (
 app_id varchar(64) NOT NULL,request_id varchar(64) NOT NULL,installation_id uuid NOT NULL REFERENCES platform_app_installations(id),
 revision integer NOT NULL CHECK(revision>0),state text NOT NULL,record jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(app_id,request_id),
 CHECK(state IN ('prepared','updating','updated','recovery_required','recovering','recovered')),
 CHECK((record->>'appId'=app_id AND record->>'requestId'=request_id AND record->>'installationId'=installation_id::text AND (record->>'revision')::integer=revision AND record->>'state'=state) IS TRUE)
);CREATE UNIQUE INDEX IF NOT EXISTS platform_app_versions_one_pending ON platform_app_versions(app_id) WHERE state IN ('prepared','updating','recovery_required','recovering');`;
export const APP_VERSION_MIGRATIONS:readonly MigrationDefinition[]=[{id:'app-signed-versions-expand',title:'Retain signed version packages and uncertain upgrades',ownerTaskId:'PLATFORM-L4-013',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-053'],sourceTables:[],targetTables:['platform_app_versions'],dependsOn:['app-install-requests-expand'],recoveryNotes:'Preserve signed bundles and pending upgrades. No automatic retry or deletion.',async run({client}){await client.query(APP_VERSION_SQL);return {applied:true};}}];
const pending=(record:AppVersionRecord)=>!['updated','recovered'].includes(record.state);
export class AppVersionService {
 constructor(private readonly options:{registry:AppRegistryService;journal:AppVersionJournal;installJournal:InstallJournal;artifactRoot:string;loadPublisherPolicy():Promise<unknown>;approve(context:PlatformManagementContext,manifest:InstallRecord['prepared']['manifest']):Promise<boolean>;getHost(appId:string):Promise<Pick<AppLifecycleHost,'execute'|'recover'|'status'>>}){}
 async status(context:PlatformManagementContext,appId:string){await assertInstallAdmin(context);return {versions:(await this.options.journal.list(appId)).map(({prepared,...record})=>({...record,version:prepared.manifest.version}))};}
 async assertActivationAllowed(context:PlatformManagementContext,appId:string){await assertInstallAdmin(context);if((await this.options.journal.list(appId)).some(pending))throw new InstallError('VERSION_RECOVERY_REQUIRED');}
 private async change(record:AppVersionRecord,state:AppVersionRecord['state']){return runAtomicOperation([this.options.journal],async()=>{const next={...record,state,revision:record.revision+1,updatedAt:new Date().toISOString()};await this.options.journal.save(next,record.revision);return next;});}
 async update(context:PlatformManagementContext,input:{appId:string;revision:number;requestId:string;directory:string;signatureFile:string;action?:'upgrade'|'rollback'}){
  await assertInstallAdmin(context);
  if(!/^[a-zA-Z0-9-]{16,64}$/.test(input.requestId))throw new InstallError('INVALID_INSTALL_REQUEST');
  const {manifest}=await validateAppDirectory(input.directory);
  if(manifest.id!==input.appId)throw new InstallError('VERSION_IDENTITY_MISMATCH');
  const rows=await this.options.journal.list(input.appId),prior=rows.find(row=>row.requestId===input.requestId);
  if(prior){if(!isDeepStrictEqual(prior.prepared.manifest,manifest))throw new InstallError('VERSION_CONFLICT');return this.public(prior);}
  if(rows.some(pending))throw new InstallError('VERSION_RECOVERY_REQUIRED');
  const current=await this.options.registry.get(context,input.appId),binding=await this.options.installJournal.get(input.appId);
  if(current.revision!==input.revision)throw new InstallError('STALE_REVISION');
  if(!binding||binding.installationId!==current.id||manifest.publisherId!==current.manifest.publisherId)throw new InstallError('VERSION_IDENTITY_MISMATCH');
  if(!['installed','recovered'].includes(binding.state))throw new InstallError('INSTALL_RECOVERY_REQUIRED');
  if(!await this.options.approve(context,manifest))throw new InstallError('INSTALL_POLICY_DENIED');
  const prepared=await prepareAppInstallation({...input,context,artifactRoot:this.options.artifactRoot,loadPublisherPolicy:this.options.loadPublisherPolicy});
  const record=await runAtomicOperation([this.options.registry,this.options.journal],async()=>{
   await assertInstallAdmin(context);const fresh=await this.options.registry.get(context,input.appId);
   if(fresh.id!==current.id||fresh.revision!==input.revision)throw new InstallError('STALE_REVISION');
   const verified=await verifyAppWithPublisherPolicy(input.directory,input.signatureFile,this.options.loadPublisherPolicy);
   if(verified.manifestSha256!==prepared.signatureManifestSha256||verified.policySha256!==prepared.publisherPolicySha256||!await this.options.approve(context,manifest))throw new InstallError('INSTALL_ADMISSION_CHANGED');
   if((await this.options.journal.list(input.appId,true)).some(pending))throw new InstallError('VERSION_RECOVERY_REQUIRED');
   const record:AppVersionRecord={appId:input.appId,requestId:input.requestId,installationId:current.id,revision:1,state:'prepared',prepared,updatedAt:new Date().toISOString()};
   await this.options.journal.insert(record);return record;
  });
  const running=await this.change(record,'updating');
  try{
   await assertInstallAdmin(context);const verified=await verifyAppWithPublisherPolicy(input.directory,input.signatureFile,this.options.loadPublisherPolicy);
   if(verified.policySha256!==prepared.publisherPolicySha256||verified.manifestSha256!==prepared.signatureManifestSha256||!await this.options.approve(context,manifest))throw new InstallError('INSTALL_ADMISSION_CHANGED');
   const host=await this.options.getHost(input.appId);const result=await host.execute(context,{revision:input.revision,action:input.action??'upgrade',targetManifest:manifest});
   if(result.enabled||result.id!==current.id||!isDeepStrictEqual(result.manifest,manifest)||result.lifecycle?.status!=='completed')throw new InstallError('VERSION_UNCONFIRMED');
   return this.public(await this.change(running,'updated'));
  }catch{try{await this.change(running,'recovery_required');}catch{throw new InstallError('VERSION_OUTCOME_UNKNOWN');}throw new InstallError('VERSION_RECOVERY_REQUIRED');}
 }
 private public({prepared,...record}:AppVersionRecord){return {...record,version:prepared.manifest.version};}
 async recover(context:PlatformManagementContext,appId:string,requestId:string){
  await assertInstallAdmin(context);const record=(await this.options.journal.list(appId)).find(row=>row.requestId===requestId);
  if(!record||!pending(record))throw new InstallError('VERSION_CONFLICT');
  const claimed=await this.change(record,'recovering');
  const current=await this.options.registry.get(context,appId);if(current.id!==record.installationId)throw new InstallError('VERSION_IDENTITY_MISMATCH');
  const host=await this.options.getHost(appId);const result=await host.recover(context,current.revision);
  if(result.enabled)throw new InstallError('VERSION_UNCONFIRMED');return this.public(await this.change(claimed,'recovered'));
 }
}
export function createVersionedArtifactReader(installs:InstallJournal,versions:AppVersionJournal){
 return async(manifest:InstallRecord['prepared']['manifest'],id:string,bytes:number)=>{
  const installation=await installs.get(manifest.id);if(!installation)throw new InstallError('INSTALL_NOT_FOUND');
  if(isDeepStrictEqual(installation.prepared.manifest,manifest))return createInstalledArtifactReader(installation)(manifest,id,bytes);
  const record=(await versions.list(manifest.id)).find(row=>row.installationId===installation.installationId&&isDeepStrictEqual(row.prepared.manifest,manifest));
  if(!record)throw new InstallError('INSTALL_ARTIFACT_BINDING_MISMATCH');
  return createInstalledArtifactReader({...installation,prepared:record.prepared})(manifest,id,bytes);
 };
}
