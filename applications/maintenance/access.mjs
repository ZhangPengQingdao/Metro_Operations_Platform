import {allowsAppResource} from '@metro/platform-sdk/app-backend';

export const permission=name=>`app.maintenance.${name}`;
export const allowed=(employee,name,row)=>allowsAppResource(employee,permission(name),{organizationUnitId:row.organization_id,ownerPersonId:row.created_by});
export function scope(employee,name){
 const grant=employee.businessAuthorization?.grants.find(item=>item.permission===permission(name));
 if(!grant)throw Error('ACCESS_DENIED');
 if(grant.all)return {};
 const anyOf=grant.organizationIds.map(id=>[{column:'organization_id',value:id}]);
 if(grant.self)anyOf.push([{column:'created_by',value:employee.personId}]);
 if(!anyOf.length)throw Error('ACCESS_DENIED');
 return {anyOf};
}
