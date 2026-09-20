export interface MembershipAudience {
 all:boolean;personIds:string[];organizationIds:string[];departmentIds:string[];
 excludedPersonIds?:string[];excludedOrganizationIds?:string[];
 personOverrides?:{personId:string;organizationId:string}[];
}
export function audienceIncludes(a:MembershipAudience,personId:string,organizationId:string,orgs:{id:string;parentId:string|null;status?:string}[]):boolean{
 if(a.excludedPersonIds?.includes(personId))return false;
 const map=new Map(orgs.map(o=>[o.id,o])),seen=new Set<string>();
 let org=map.get(organizationId),included=a.all||a.personIds.includes(personId)||a.organizationIds.includes(organizationId),excluded=false;
 while(org&&!seen.has(org.id)){
  if(org.status&&org.status!=='active')return false;
  seen.add(org.id);if(a.excludedOrganizationIds?.includes(org.id))excluded=true;
  if(a.departmentIds.includes(org.id))included=true;
  org=org.parentId?map.get(org.parentId):undefined;
 }
 if(org&&seen.has(org.id))return false;
 return !!a.personOverrides?.some(o=>o.personId===personId&&o.organizationId===organizationId)||!excluded&&included;
}
