import {allowsAppResource} from '@metro/platform-sdk/app-backend';
export function grant(employee,permission){return employee.businessAuthorization?.grants.find(g=>g.permission===permission);}
export function allowed(employee,permission,org,owner){return allowsAppResource(employee,permission,{organizationUnitId:org,ownerPersonId:owner});}
export function requireAccess(employee,permission,org,owner){if(!allowed(employee,permission,org,owner))throw Error('ACCESS_DENIED');}
export function scope(employee,permission){
 const g=grant(employee,permission);if(!g)throw Error('ACCESS_DENIED');if(g.all)return {};
 const anyOf=g.organizationIds.map(id=>[{column:'organization_id',value:id}]);if(g.self)anyOf.push([{column:'created_by',value:employee.personId}],[{column:'people',contains:[{id:employee.personId}]}]);
 if(!anyOf.length)throw Error('ACCESS_DENIED');return {anyOf};
}
