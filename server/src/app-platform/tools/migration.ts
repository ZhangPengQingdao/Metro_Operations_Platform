import type {MigrationDefinition} from '../../core/migrations/index.js';
export const toolsMigration:MigrationDefinition={id:'platform-tools-read-permission',title:'Application read-only tools',ownerTaskId:'PLATFORM-TOOLS-001',phase:'expand',layer:'L3',dataRows:[],migrationRows:['MIG-TOOLS'],sourceTables:[],targetTables:['platform_permissions'],dependsOn:['platform-authorization-expand'],recoveryNotes:'Adds a permission definition; no employee grants.',async run({client}){
 await client.query("INSERT INTO platform_permissions(id,code,name,description,status,created_at,updated_at) VALUES('49000000-0000-4000-8000-000000000009','platform.tools.read','调用本应用只读工具','绑定员工并通过统一入口调用声明的只读工具','active',now(),now()) ON CONFLICT(code) DO NOTHING");
}};
