import type { AtomicParticipant, QueryableClient } from '../../core/database/index.js';
import type { MigrationDefinition } from '../../core/migrations/index.js';
import type { prepareAppInstallation } from '../developer/install-preparation.js';
export type InstallState = 'registered' | 'installing' | 'installed' | 'recovery_required' | 'recovering' | 'recovered';
export interface InstallRecord {
 appId: string; requestId: string; installationId: string; revision: number; state: InstallState;
 prepared: Awaited<ReturnType<typeof prepareAppInstallation>>;
 actorId: string; updatedAt: string;
}
export interface InstallJournal extends AtomicParticipant {
 get(appId:string,lock?:boolean):Promise<InstallRecord|null>;
 insert(record:InstallRecord):Promise<void>;
 save(record:InstallRecord,expectedRevision:number):Promise<void>;
}
export class InstallError extends Error { constructor(readonly code:string){super(code);this.name='InstallError';} }
export class MemoryInstallJournal implements InstallJournal {
 private records=new Map<string,InstallRecord>();
 readonly atomic={snapshot:()=>{const old=structuredClone(this.records);return()=>{this.records=old;};}};
 async get(appId:string){return structuredClone(this.records.get(appId)??null);}
 async insert(record:InstallRecord){if(this.records.has(record.appId))throw new InstallError('INSTALL_EXISTS');this.records.set(record.appId,structuredClone(record));}
 async save(record:InstallRecord,expected:number){const old=this.records.get(record.appId);if(!old||old.revision!==expected||record.revision!==expected+1)throw new InstallError('INSTALL_CONFLICT');this.records.set(record.appId,structuredClone(record));}
}
export class PostgresInstallJournal implements InstallJournal {
 readonly atomic;
 constructor(private readonly client:QueryableClient){this.atomic={client};}
 async get(appId:string,lock=false){const result=await this.client.query(`SELECT record FROM platform_app_install_requests WHERE app_id=$1${lock?' FOR UPDATE':''}`,[appId]) as {rows:{record:InstallRecord}[]};return result.rows[0]?.record??null;}
 async insert(record:InstallRecord){await this.client.query('INSERT INTO platform_app_install_requests(app_id,installation_id,revision,record) VALUES($1,$2,$3,$4::jsonb)',[record.appId,record.installationId,record.revision,JSON.stringify(record)]);}
 async save(record:InstallRecord,expected:number){const result=await this.client.query('UPDATE platform_app_install_requests SET revision=$3,record=$4::jsonb WHERE app_id=$1 AND revision=$2 AND $3=$2+1 RETURNING app_id',[record.appId,expected,record.revision,JSON.stringify(record)]) as {rows:unknown[]};if(!result.rows.length)throw new InstallError('INSTALL_CONFLICT');}
}
export const APP_INSTALL_SQL=`CREATE TABLE IF NOT EXISTS platform_app_install_requests (
 app_id varchar(64) PRIMARY KEY, installation_id uuid NOT NULL UNIQUE REFERENCES platform_app_installations(id),
 revision integer NOT NULL CHECK(revision>0), record jsonb NOT NULL,
 CHECK ((record->>'appId'=app_id AND record->>'installationId'=installation_id::text AND (record->>'revision')::integer=revision) IS TRUE),
 CHECK ((record->>'state' IN ('registered','installing','installed','recovery_required','recovering','recovered')) IS TRUE)
);`;
export const APP_INSTALL_MIGRATIONS:readonly MigrationDefinition[]=[{
 id:'app-install-requests-expand',title:'Bind first-install requests to verified artifacts and installation identity',ownerTaskId:'PLATFORM-L4-010',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-051'],sourceTables:[],targetTables:['platform_app_install_requests'],dependsOn:['app-registry-expand'],
 recoveryNotes:'Preserve package binding and uncertain installation state; never retry runtime writes or delete retained application data automatically.',
 async run({client}){await client.query(APP_INSTALL_SQL);return {applied:true};},
}];
