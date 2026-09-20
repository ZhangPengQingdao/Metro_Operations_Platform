import type {PickerOrganization,PickerPerson} from '../../components/ui/OrganizationPeoplePicker';

export type Audience={all:boolean;personIds:string[];organizationIds:string[];departmentIds:string[];excludedPersonIds:string[];excludedOrganizationIds:string[];personOverrides?:{personId:string;organizationId:string}[]};
export const emptyAudience:Audience={all:false,personIds:[],organizationIds:[],departmentIds:[],excludedPersonIds:[],excludedOrganizationIds:[]};
export function lineage(id:string,orgs:PickerOrganization[]){const ids:string[]=[];let current=orgs.find(o=>o.id===id);while(current&&!ids.includes(current.id)){ids.push(current.id);current=orgs.find(o=>o.id===current!.parentId)}return ids;}
export function included(a:Audience,p:PickerPerson,orgs:PickerOrganization[]){
 const chain=lineage(p.organizationId,orgs);
 return !a.excludedPersonIds.includes(p.id)&&(a.personOverrides?.some(o=>o.personId===p.id&&o.organizationId===p.organizationId)||!chain.some(id=>a.excludedOrganizationIds.includes(id))&&(a.all||a.personIds.includes(p.id)||a.organizationIds.includes(p.organizationId)||chain.some(id=>a.departmentIds.includes(id))));
}
export function selectPerson(a:Audience,p:PickerPerson,checked:boolean,orgs:PickerOrganization[]):Audience{
 const excluded=lineage(p.organizationId,orgs).some(id=>a.excludedOrganizationIds.includes(id));
 return {...a,personIds:checked&&!excluded?[...new Set([...a.personIds,p.id])]:a.personIds.filter(id=>id!==p.id),
  excludedPersonIds:checked?a.excludedPersonIds.filter(id=>id!==p.id):[...new Set([...a.excludedPersonIds,p.id])],
  personOverrides:[...(a.personOverrides??[]).filter(o=>o.personId!==p.id),...(checked&&excluded?[{personId:p.id,organizationId:p.organizationId}]:[])]};
}
export function selectOrganization(a:Audience,id:string,checked:boolean,orgs:PickerOrganization[]):Audience{
 const descendants=(target:string)=>lineage(target,orgs).includes(id);
 return {...a,organizationIds:a.organizationIds.filter(o=>!descendants(o)),departmentIds:[...a.departmentIds.filter(o=>!descendants(o)),...(checked?[id]:[])],
  excludedOrganizationIds:[...a.excludedOrganizationIds.filter(o=>!descendants(o)),...(!checked?[id]:[])],
  personOverrides:(a.personOverrides??[]).filter(o=>!descendants(o.organizationId))};
}
