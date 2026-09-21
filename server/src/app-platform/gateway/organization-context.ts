import {z} from 'zod';
import type {PeopleDirectoryRepository} from '../../platform/people/index.js';
import {GatewayError,type AppGatewayOperation} from './model.js';
const params=z.object({organizationUnitId:z.string().uuid()}).strict();
export function createOrganizationContextOperation(people:Pick<PeopleDirectoryRepository,'findOrganizationUnitById'>):AppGatewayOperation{
 return {name:'platform.people.organization_context',permissionCode:'platform.people.read',mode:'read',
  validateParams:value=>params.safeParse(value).success,
  resolveResources:async(_context,value)=>[{organizationUnitId:params.parse(value).organizationUnitId}],
  async execute(_context,value){
   let id:string|null=params.parse(value).organizationUnitId;
   const organizations:{id:string;name:string;unitType:string}[]=[],seen=new Set<string>();
   while(id){
    if(seen.has(id)||seen.size>=32)throw new GatewayError('INVALID_RESULT');seen.add(id);
    const org=await people.findOrganizationUnitById(id);
    if(!org||org.status!=='active')throw new GatewayError('ACCESS_DENIED',403);
    organizations.push({id:org.id,name:org.name,unitType:org.unitType});id=org.parentId;
   }
   return {organizations};
  },validateResult:()=>true};
}
