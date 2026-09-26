import {allowsAppResource} from '@metro/platform-sdk/app-backend';

export const PERMISSIONS=['read','create','handle','manage','recurring','score'].map(name=>`app.todos.${name}`);
export const permit=(employee,action,row)=>allowsAppResource(employee,`app.todos.${action}`,{
 organizationUnitId:row.organization_id,ownerPersonId:row.created_by,
});
export function scope(employee,action){
 const grant=employee.businessAuthorization?.grants.find(g=>g.permission===`app.todos.${action}`);
 if(!grant)throw Error('ACCESS_DENIED');
 if(grant.all)return {};
 const anyOf=grant.organizationIds.map(id=>[{column:'organization_id',value:id}]);
 if(grant.self)anyOf.push([{column:'created_by',value:employee.personId}]);
 if(!anyOf.length)throw Error('ACCESS_DENIED');
 return {anyOf};
}
