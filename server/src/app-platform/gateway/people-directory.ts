import {z} from 'zod';
import type {PeopleDirectoryRepository} from '../../platform/people/index.js';
import {GatewayError,type AppGatewayOperation} from './model.js';

const params=z.object({organizationUnitId:z.string().uuid(),personId:z.string().uuid().optional(),personIds:z.array(z.string().uuid()).min(1).max(50).optional(),search:z.string().max(100).optional()}).strict();
const person=z.object({id:z.string().uuid(),name:z.string(),employeeNo:z.string(),organizationUnitId:z.string().uuid()}).strict();
const result=z.object({organizationUnitId:z.string().uuid(),rows:z.array(person).max(50)}).strict();
/** Bounded active-member lookup; personal contact and external identity fields never leave the platform. */
export function createPeopleDirectoryOperation(people:Pick<PeopleDirectoryRepository,'searchPeople'|'getPersonProfile'>):AppGatewayOperation{
 return {name:'platform.people.members',permissionCode:'platform.people.read',mode:'read',
  validateParams:value=>params.safeParse(value).success,
  resolveResources:async(_context,value)=>[{organizationUnitId:params.parse(value).organizationUnitId}],
  async execute(_context,value){
   const p=params.parse(value);
   const profiles=p.personIds?await Promise.all(p.personIds.map(id=>people.getPersonProfile(id))):p.personId?[await people.getPersonProfile(p.personId)]:await people.searchPeople({organizationUnitId:p.organizationUnitId,employmentStatus:'active',query:p.search,limit:50});
   const rows=profiles.filter(profile=>profile&&profile.person.organizationUnitId===p.organizationUnitId&&profile.person.employmentStatus==='active'&&profile.organizationUnit.status==='active'&&profile.organizationUnit.unitType==='workgroup'&&profile.position.status==='active').map(profile=>({id:profile!.person.id,name:profile!.person.name,employeeNo:profile!.person.employeeNo,organizationUnitId:profile!.person.organizationUnitId}));
   if(rows.length>50)throw new GatewayError('INVALID_RESULT',502);
   return {organizationUnitId:p.organizationUnitId,rows};
  },
  validateResult:value=>result.safeParse(value).success,
  resolveResultResources:async(_context,value)=>{const page=result.parse(value);return [{organizationUnitId:page.organizationUnitId},...page.rows.map(row=>({organizationUnitId:row.organizationUnitId,ownerPersonId:row.id}))];},
 };
}

/** A bounded organization tree for choosing a responsible person's workgroup within a department. */
export function createWorkgroupDirectoryOperation(people:Pick<PeopleDirectoryRepository,'listOrganizationUnits'>):AppGatewayOperation{
 const input=z.object({organizationUnitId:z.string().uuid()}).strict();
 return {name:'platform.people.workgroups',permissionCode:'platform.people.read',mode:'read',validateParams:value=>input.safeParse(value).success,
  resolveResources:async(_context,value)=>[{organizationUnitId:(value as z.infer<typeof input>).organizationUnitId}],
  async execute(_context,value){const root=(value as z.infer<typeof input>).organizationUnitId,units=await people.listOrganizationUnits(),byId=new Map(units.map(unit=>[unit.id,unit]));if(byId.get(root)?.status!=='active')throw new GatewayError('ACCESS_DENIED',403);const rows=units.filter(unit=>{if(unit.status!=='active'||unit.unitType!=='workgroup')return false;let current:typeof unit|undefined=unit;const seen=new Set<string>();while(current&&!seen.has(current.id)){if(current.status!=='active')return false;if(current.id===root)return true;seen.add(current.id);current=current.parentId?byId.get(current.parentId):undefined;}return false;}).map(unit=>({id:unit.id,name:unit.name}));if(rows.length>128)throw new GatewayError('INVALID_RESULT');return {rows};},
  validateResult:value=>!!value&&typeof value==='object'&&'rows' in value&&Array.isArray(value.rows)};
}
