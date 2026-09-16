import type {MigrationDefinition} from '../../core/migrations/index.js';
export const appGatewayPermissionsMigration:MigrationDefinition={id:'app-gateway-directory-permissions',title:'Application directory read permissions',ownerTaskId:'PLATFORM-L4-015',phase:'expand',layer:'L3',dataRows:[],migrationRows:['MIG-057'],sourceTables:[],targetTables:['platform_permissions'],dependsOn:['platform-authorization-expand'],recoveryNotes:'Adds permission definitions only. Does not assign employee roles or application grants.',async run({client}){
 await client.query(`INSERT INTO platform_permissions(id,code,name,description,status,created_at,updated_at) VALUES
 ('49000000-0000-4000-8000-000000000001','platform.locations.read','读取位置目录','应用按授权范围读取位置','active',now(),now()),
 ('49000000-0000-4000-8000-000000000002','platform.assets.read','读取设备目录','应用按授权范围读取设备','active',now(),now()) ON CONFLICT(code) DO NOTHING`);
}};

export const appPeoplePermissionMigration:MigrationDefinition={id:'app-gateway-people-permission',title:'Active workgroup directory permission',ownerTaskId:'PLATFORM-L4-016',phase:'expand',layer:'L3',dataRows:[],migrationRows:['MIG-062'],sourceTables:[],targetTables:['platform_permissions'],dependsOn:['platform-authorization-expand'],recoveryNotes:'Permission catalog only; no employee or service grant.',async run({client}){
 await client.query(`INSERT INTO platform_permissions(id,code,name,description,status,created_at,updated_at) VALUES ('49000000-0000-4000-8000-000000000005','platform.people.read','读取工班成员','按授权范围读取在职工班成员姓名和工号','active',now(),now()) ON CONFLICT(code) DO NOTHING`);
}};
