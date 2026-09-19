import type {MigrationDefinition} from '../../core/migrations/index.js';

export const appAudienceMigration:MigrationDefinition={
 id:'app-audience-delegation-expand',title:'Application audience and scoped role delegation',
 ownerTaskId:'PLATFORM-L4-021',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-072'],
 sourceTables:[],targetTables:['platform_app_authorization','platform_app_role_delegations','platform_app_delegated_members'],
 dependsOn:['app-business-authorization-expand'],
 recoveryNotes:'Additive. A null audience preserves existing role admission until the owner explicitly saves an audience. Delegated assignments never become direct role memberships.',
 async run({client}){await client.query(`
 ALTER TABLE platform_app_authorization ADD COLUMN audience jsonb;
 CREATE TABLE platform_app_role_delegations(
  installation_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission text NOT NULL,
  PRIMARY KEY(installation_id,role_id),
  FOREIGN KEY(installation_id,role_id) REFERENCES platform_app_business_roles(installation_id,id)
 );
 CREATE TABLE platform_app_delegated_members(
  installation_id uuid NOT NULL,
  role_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES platform_people(id),
  organization_id uuid NOT NULL REFERENCES platform_organization_units(id),
  assigned_by uuid NOT NULL REFERENCES platform_people(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(installation_id,role_id,person_id,organization_id),
  FOREIGN KEY(installation_id,role_id) REFERENCES platform_app_role_delegations(installation_id,role_id) ON DELETE CASCADE
 );
 `);}
};
