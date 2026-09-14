import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS,
  createMemoryPeopleDirectoryRepository,
  createPostgresPeopleDirectoryRepository,
  type ExternalIdentity,
  type OrganizationUnit,
  type Person,
  type Position
} from '../src/platform/people/index.ts';
import {
  PLATFORM_LOCATION_DIRECTORY_MIGRATIONS,
  createMemoryLocationDirectoryRepository,
  createPostgresLocationDirectoryRepository,
  type ExternalLocationReference,
  type Line,
  type LineStation,
  type Location,
  type LocationAlias
} from '../src/platform/locations/index.ts';
import {
  PLATFORM_ASSET_DIRECTORY_MIGRATIONS,
  createMemoryAssetDirectoryRepository,
  createPostgresAssetDirectoryRepository,
  type Asset,
  type AssetAlias,
  type AssetSystem,
  type AssetType,
  type ExternalAssetReference
} from '../src/platform/assets/index.ts';
import {
  EntityResolutionError,
  createEntityResolutionService,
  entityEditDistance,
  normalizeEntityText
} from '../src/platform/entity-resolution/index.ts';

const I={company:'43000000-0000-4000-8000-000000000001',workgroup:'43000000-0000-4000-8000-000000000002',workgroupRoad:'43000000-0000-4000-8000-000000000003',position:'43000000-0000-4000-8000-000000000004',personA:'43000000-0000-4000-8000-000000000011',personB:'43000000-0000-4000-8000-000000000012',identity:'43000000-0000-4000-8000-000000000013',line:'43000000-0000-4000-8000-000000000021',station:'43000000-0000-4000-8000-000000000022',stationRoad:'43000000-0000-4000-8000-000000000023',lineStation:'43000000-0000-4000-8000-000000000025',lineStationRoad:'43000000-0000-4000-8000-000000000026',locationAlias:'43000000-0000-4000-8000-000000000028',locationExternal:'43000000-0000-4000-8000-000000000029',system:'43000000-0000-4000-8000-000000000031',assetType:'43000000-0000-4000-8000-000000000032',assetA:'43000000-0000-4000-8000-000000000033',assetB:'43000000-0000-4000-8000-000000000034',assetRetired:'43000000-0000-4000-8000-000000000035',assetAlias:'43000000-0000-4000-8000-000000000036',assetExternal:'43000000-0000-4000-8000-000000000037'}as const;
const now='2026-08-31T04:30:00.000Z';

const organizations:OrganizationUnit[]=[
  {id:I.company,parentId:null,code:'company',name:'地铁公司',shortName:'公司',unitType:'company',status:'active',sortOrder:0,createdAt:now,updatedAt:now},
  {id:I.workgroup,parentId:I.company,code:'wg-xuejiadao',name:'薛家岛工班',shortName:'薛家岛班组',unitType:'workgroup',status:'active',sortOrder:1,createdAt:now,updatedAt:now},
  {id:I.workgroupRoad,parentId:I.company,code:'wg-xuejiadaolu',name:'薛家岛路工班',shortName:null,unitType:'workgroup',status:'active',sortOrder:2,createdAt:now,updatedAt:now}
];
const positions:Position[]=[{id:I.position,code:'afc-maintainer',name:'AFC检修工',description:null,status:'active',createdAt:now,updatedAt:now}];
const people:Person[]=[
  {id:I.personA,employeeNo:'06010001',name:'张三',phone:null,organizationUnitId:I.workgroup,positionId:I.position,employmentStatus:'active',avatarUrl:null,createdAt:now,updatedAt:now},
  {id:I.personB,employeeNo:'06010002',name:'张三',phone:null,organizationUnitId:I.workgroupRoad,positionId:I.position,employmentStatus:'active',avatarUrl:null,createdAt:now,updatedAt:now}
];
const externalIdentities:ExternalIdentity[]=[{id:I.identity,personId:I.personA,provider:'wecom',tenantKey:'default',externalUserId:'zhangsan',status:'active',verifiedAt:now,createdAt:now,updatedAt:now}];
const lines:Line[]=[{id:I.line,code:'L1',name:'1号线',shortName:null,status:'active',sortOrder:1,createdAt:now,updatedAt:now}];
const locations:Location[]=[
  {id:I.station,parentId:null,organizationUnitId:null,code:'station-xuejiadao',name:'薛家岛站',shortName:null,locationType:'station',status:'active',sortOrder:1,createdAt:now,updatedAt:now},
  {id:I.stationRoad,parentId:null,organizationUnitId:null,code:'station-xuejiadaolu',name:'薛家岛路站',shortName:null,locationType:'station',status:'active',sortOrder:2,createdAt:now,updatedAt:now}
];
const lineStations:LineStation[]=[
  {id:I.lineStation,lineId:I.line,stationId:I.station,stationCode:'L1-01',sortOrder:1,status:'active',createdAt:now,updatedAt:now},
  {id:I.lineStationRoad,lineId:I.line,stationId:I.stationRoad,stationCode:'L1-02',sortOrder:2,status:'active',createdAt:now,updatedAt:now}
];
const locationAliases:LocationAlias[]=[{id:I.locationAlias,locationId:I.stationRoad,alias:'凤凰岛站',aliasType:'historical',status:'active',createdAt:now,updatedAt:now}];
const locationExternalReferences:ExternalLocationReference[]=[{id:I.locationExternal,locationId:I.stationRoad,provider:'gis',tenantKey:'default',externalLocationId:'GIS-XJD',status:'active',verifiedAt:now,createdAt:now,updatedAt:now}];
const systems:AssetSystem[]=[{id:I.system,code:'AFC',name:'AFC',description:null,status:'active',sortOrder:1,createdAt:now,updatedAt:now}];
const assetTypes:AssetType[]=[{id:I.assetType,systemId:I.system,categoryId:null,code:'GATE',name:'闸机',description:null,status:'active',sortOrder:1,createdAt:now,updatedAt:now}];
const assets:Asset[]=[
  {id:I.assetA,systemId:I.system,categoryId:null,typeId:I.assetType,locationId:I.station,displayName:'AGM01',assetCode:'01500401',lifecycleState:'active',dataQualityStatus:'verified',remark:null,createdAt:now,updatedAt:now},
  {id:I.assetB,systemId:I.system,categoryId:null,typeId:I.assetType,locationId:I.stationRoad,displayName:'AGM01',assetCode:'01500402',lifecycleState:'active',dataQualityStatus:'verified',remark:null,createdAt:now,updatedAt:now},
  {id:I.assetRetired,systemId:I.system,categoryId:null,typeId:I.assetType,locationId:I.stationRoad,displayName:'AGM99',assetCode:'01500499',lifecycleState:'retired',dataQualityStatus:'verified',remark:null,createdAt:now,updatedAt:now}
];
const assetAliases:AssetAlias[]=[{id:I.assetAlias,assetId:I.assetA,alias:'进站闸机1号',aliasType:'display',status:'active',createdAt:now,updatedAt:now}];
const assetExternalReferences:ExternalAssetReference[]=[{id:I.assetExternal,assetId:I.assetA,provider:'eam',tenantKey:'default',externalAssetId:'EAM-AGM-01',status:'active',verifiedAt:now,createdAt:now,updatedAt:now}];

function setup(options:{includeStation?:boolean;includeRoad?:boolean;inactivePerson?:boolean;inactiveRoad?:boolean;inactiveAssetType?:boolean}={}){
  const includeStation=options.includeStation??true,includeRoad=options.includeRoad??true;
  const selectedLocations=locations.filter((item)=>(item.id!==I.station||includeStation)&&(item.id!==I.stationRoad||includeRoad)).map((item)=>item.id===I.stationRoad&&options.inactiveRoad?{...item,status:'inactive' as const}:item);
  const selectedIds=new Set(selectedLocations.map((item)=>item.id));
  const peopleRepository=createMemoryPeopleDirectoryRepository({organizationUnits:organizations,positions,people:people.map((item)=>item.id===I.personA&&options.inactivePerson?{...item,employmentStatus:'inactive' as const}:item),externalIdentities});
  const locationRepository=createMemoryLocationDirectoryRepository({locations:selectedLocations,lines,lineStations:lineStations.filter((item)=>selectedIds.has(item.stationId)),aliases:locationAliases.filter((item)=>selectedIds.has(item.locationId)),externalReferences:locationExternalReferences.filter((item)=>selectedIds.has(item.locationId))});
  const assetRepository=createMemoryAssetDirectoryRepository({systems,types:assetTypes.map((item)=>options.inactiveAssetType?{...item,status:'inactive' as const}:item),assets:assets.filter((item)=>selectedIds.has(item.locationId)),aliases:assetAliases,externalReferences:assetExternalReferences});
  return createEntityResolutionService({people:peopleRepository,locations:locationRepository,assets:assetRepository});
}

test('zero, one, and multiple eligible station candidates map to not_found, resolved, and ambiguous',async()=>{
  const onlyRoad=setup({includeStation:false});
  const resolved=await onlyRoad.resolve({source:'web',entityType:'location',lookup:{type:'text',text:'薛家岛'},filters:{locationType:'station'}});
  assert.equal(resolved.status,'resolved');assert.equal(resolved.resolved?.reference.id,I.stationRoad);assert.equal(resolved.resolved?.match.type,'contains');
  const both=await setup().resolve({source:'web',entityType:'location',lookup:{type:'text',text:'薛家岛'},filters:{locationType:'station'}});
  assert.equal(both.status,'ambiguous');assert.deepEqual(both.candidates.map((item)=>item.reference.id),[I.station,I.stationRoad]);
  assert.equal((await setup().resolve({source:'web',entityType:'location',lookup:{type:'text',text:'不存在'},filters:{locationType:'station'}})).status,'not_found');
});

test('controlled station suffix, alias, and typo matches are explainable',async()=>{
  const onlyRoad=setup({includeStation:false});
  assert.equal((await onlyRoad.resolve({source:'agent',entityType:'location',lookup:{type:'text',text:'薛家岛路'},filters:{locationType:'station'}})).resolved?.match.type,'normalized');
  assert.equal((await onlyRoad.resolve({source:'agent',entityType:'location',lookup:{type:'text',text:'凤凰岛站'},filters:{locationType:'station'}})).resolved?.match.type,'alias');
  const typo=await onlyRoad.resolve({source:'agent',entityType:'location',lookup:{type:'text',text:'薜家岛'},filters:{locationType:'station'}});
  assert.equal(typo.status,'resolved');assert.equal(typo.resolved?.match.type,'typo');
  assert.equal((await setup().resolve({source:'agent',entityType:'location',lookup:{type:'text',text:'薛'},filters:{locationType:'station'}})).status,'not_found');
});

test('same-name people require organization context while employee number and verified external identity resolve directly',async()=>{
  const resolver=setup();
  assert.equal((await resolver.resolve({source:'web',entityType:'person',lookup:{type:'text',text:'张三'}})).status,'ambiguous');
  assert.equal((await resolver.resolve({source:'web',entityType:'person',lookup:{type:'text',text:'张三'},filters:{organizationUnitId:I.workgroup}})).resolved?.reference.id,I.personA);
  assert.equal((await resolver.resolve({source:'import',entityType:'person',lookup:{type:'text',text:'06010001'}})).resolved?.match.type,'code');
  assert.equal((await resolver.resolve({source:'mcp',entityType:'person',lookup:{type:'external_id',provider:'wecom',externalId:'zhangsan'}})).resolved?.reference.id,I.personA);
});

test('workgroups are OrganizationReferences and callers must explicitly request organization type',async()=>{
  const resolver=setup();
  const team=await resolver.resolve({source:'web',entityType:'organization',lookup:{type:'text',text:'wg-xuejiadao'},filters:{unitTypes:['workgroup']}});
  assert.equal(team.status,'resolved');assert.equal(team.resolved?.reference.entityType,'organization');assert.equal((team.resolved?.reference as any).unitType,'workgroup');
  await assert.rejects(resolver.resolve({source:'web',entityType:'organization',lookup:{type:'external_id',provider:'hr',externalId:'team-1'}}),(error:unknown)=>error instanceof EntityResolutionError&&error.code==='UNSUPPORTED_EXTERNAL_REFERENCE');
  await assert.rejects(resolver.resolve({source:'web',entityType:'unknown' as any,lookup:{type:'text',text:'薛家岛'}}),(error:unknown)=>error instanceof EntityResolutionError&&error.code==='ENTITY_TYPE_REQUIRED');
});

test('asset context disambiguates duplicate display names and retired assets are excluded by default',async()=>{
  const resolver=setup();
  assert.equal((await resolver.resolve({source:'import',entityType:'asset',lookup:{type:'text',text:'AGM01'}})).status,'ambiguous');
  assert.equal((await resolver.resolve({source:'import',entityType:'asset',lookup:{type:'text',text:'AGM01'},filters:{locationId:I.stationRoad,typeId:I.assetType}})).resolved?.reference.id,I.assetB);
  assert.equal((await resolver.resolve({source:'web',entityType:'asset',lookup:{type:'text',text:'进站闸机1号'}})).resolved?.match.type,'alias');
  assert.equal((await resolver.resolve({source:'mcp',entityType:'asset',lookup:{type:'external_id',provider:'eam',externalId:'EAM-AGM-01'}})).resolved?.reference.id,I.assetA);
  assert.equal((await resolver.resolve({source:'web',entityType:'asset',lookup:{type:'text',text:'AGM99'}})).status,'not_found');
  assert.equal((await resolver.resolve({source:'web',entityType:'asset',lookup:{type:'text',text:'AGM99'},filters:{lifecycleStates:['retired']}})).resolved?.reference.id,I.assetRetired);
});

test('UUID, station code, and verified location external ID are stable direct matches',async()=>{
  const resolver=setup();
  assert.equal((await resolver.resolve({source:'web',entityType:'location',lookup:{type:'id',id:I.stationRoad}})).resolved?.match.type,'id');
  assert.equal((await resolver.resolve({source:'web',entityType:'location',lookup:{type:'text',text:'L1-02'},filters:{lineId:I.line}})).resolved?.reference.id,I.stationRoad);
  assert.equal((await resolver.resolve({source:'mcp',entityType:'location',lookup:{type:'external_id',provider:'gis',externalId:'GIS-XJD'}})).resolved?.reference.id,I.stationRoad);
});

test('inactive people, locations, and asset classifications do not resolve by default or stable ID',async()=>{
  assert.equal((await setup({inactivePerson:true}).resolve({source:'web',entityType:'person',lookup:{type:'id',id:I.personA}})).status,'not_found');
  assert.equal((await setup({inactiveRoad:true}).resolve({source:'web',entityType:'location',lookup:{type:'id',id:I.stationRoad}})).status,'not_found');
  assert.equal((await setup({inactiveAssetType:true}).resolve({source:'web',entityType:'asset',lookup:{type:'id',id:I.assetA}})).status,'not_found');
});

test('Web, import, Agent, and MCP sources share identical matching behavior',async()=>{
  const resolver=setup({includeStation:false});
  const results=[];
  for(const source of ['web','import','agent','mcp'] as const)results.push(await resolver.resolve({source,entityType:'location',lookup:{type:'text',text:'薜家岛'},filters:{locationType:'station'}}));
  assert.deepEqual(results.map((result)=>[result.status,result.resolved?.reference.id,result.resolved?.match.type]),Array(4).fill(['resolved',I.stationRoad,'typo']));
});

test('normalization and edit distance remain deterministic',()=>{
  assert.equal(normalizeEntityText(' ＡＧＭ-01 '),'agm01');
  assert.equal(entityEditDistance('薜家岛','薛家岛'),1);
});

test('directory candidate enumeration and resolver work through PostgreSQL repositories',async()=>{
  const db=new PGlite();const client={query(text:string,values?:readonly unknown[]){if(!values&&text.includes(';'))return db.exec(text);return db.query(text,values?[...values]:undefined);}};
  try{
    await PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS[0].run({client});await PLATFORM_LOCATION_DIRECTORY_MIGRATIONS[0].run({client});await PLATFORM_ASSET_DIRECTORY_MIGRATIONS[0].run({client});
    await db.query(`INSERT INTO platform_organization_units(id,parent_id,code,name,short_name,unit_type,status,sort_order,created_at,updated_at)VALUES($1,NULL,'company','公司',NULL,'company','active',0,NOW(),NOW()),($2,$1,'wg','薛家岛工班',NULL,'workgroup','active',1,NOW(),NOW())`,[I.company,I.workgroup]);
    await db.query(`INSERT INTO platform_positions(id,code,name,description,status,created_at,updated_at)VALUES($1,'maintainer','检修工',NULL,'active',NOW(),NOW())`,[I.position]);
    await db.query(`INSERT INTO platform_people(id,employee_no,name,phone,organization_unit_id,position_id,employment_status,avatar_url,created_at,updated_at)VALUES($1,'06010001','张三',NULL,$2,$3,'active',NULL,NOW(),NOW())`,[I.personA,I.workgroup,I.position]);
    await db.query(`INSERT INTO platform_locations(id,parent_id,organization_unit_id,code,name,short_name,location_type,status,sort_order,created_at,updated_at)VALUES($1,NULL,NULL,'xjd','薛家岛路站',NULL,'station','active',1,NOW(),NOW())`,[I.stationRoad]);
    await db.query(`INSERT INTO platform_asset_systems(id,code,name,description,status,sort_order,created_at,updated_at)VALUES($1,'AFC','AFC',NULL,'active',1,NOW(),NOW())`,[I.system]);
    await db.query(`INSERT INTO platform_asset_types(id,system_id,category_id,code,name,description,status,sort_order,created_at,updated_at)VALUES($1,$2,NULL,'GATE','闸机',NULL,'active',1,NOW(),NOW())`,[I.assetType,I.system]);
    await db.query(`INSERT INTO platform_assets(id,system_id,category_id,type_id,location_id,display_name,asset_code,lifecycle_state,data_quality_status,remark,created_at,updated_at)VALUES($1,$2,NULL,$3,$4,'AGM01','01500401','active','verified',NULL,NOW(),NOW())`,[I.assetA,I.system,I.assetType,I.stationRoad]);
    const resolver=createEntityResolutionService({people:createPostgresPeopleDirectoryRepository(client),locations:createPostgresLocationDirectoryRepository(client),assets:createPostgresAssetDirectoryRepository(client)});
    assert.equal((await resolver.resolve({source:'web',entityType:'person',lookup:{type:'text',text:'张三'}})).resolved?.reference.id,I.personA);
    assert.equal((await resolver.resolve({source:'agent',entityType:'location',lookup:{type:'text',text:'薛家岛'}})).resolved?.reference.id,I.stationRoad);
    assert.equal((await resolver.resolve({source:'import',entityType:'asset',lookup:{type:'text',text:'AGM01'}})).resolved?.reference.id,I.assetA);
  }finally{await db.close();}
});

test('entity resolver remains separate from legacy vector, MCP, Agent, and import implementations',async()=>{
  const source=await readFile(new URL('../src/platform/entity-resolution/index.ts',import.meta.url),'utf8');
  assert.doesNotMatch(source,/station-search|afc-ops-mcp|ai-runtime|modules\//);
  assert.doesNotMatch(source,/(embedding|vector|openai|prompt)/i);
});
