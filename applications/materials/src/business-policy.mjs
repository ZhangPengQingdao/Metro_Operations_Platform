import {allowsAppResource} from '@metro/platform-sdk/app-backend';
export const actionPermission={
 create:'create',update:'update',inbound:'inbound',outbound:'outbound',
 'correct-inbound':'inbound','reverse-inbound':'inbound','correct-outbound':'modify-consumption','reverse-outbound':'delete-consumption',
};
export const permissionFor=(action,input)=>'app.materials.'+(action==='list'?(input.kind==='materials'?'read-stock':'read-records'):actionPermission[action]);
export function allowed(employee,permission,row){
 return allowsAppResource(employee,permission,{organizationUnitId:row.organization_id,ownerPersonId:row.operator_id});
}
export function listScope(employee,permission){
 const grant=employee.businessAuthorization.grants.find(g=>g.permission===permission);
 if(!grant)throw Error('ACCESS_DENIED');
 if(grant.all)return {};
 const groups=grant.organizationIds.map(id=>[{column:'organization_id',value:id}]);
 if(grant.self)groups.push([{column:'operator_id',value:employee.personId}]);
 if(!groups.length)throw Error('ACCESS_DENIED');
 return {anyOf:groups};
}
