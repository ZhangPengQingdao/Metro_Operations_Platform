import {allowsAppResource} from '@metro/platform-sdk/app-backend';

export const categories=['设备运行维修','设施监测养护','行车组织','客运组织','运营环境','人员管理','施工管理','仓储管理'];
export const levels=['一般隐患II级','一般隐患I级','重大隐患'];
export const permission=name=>'app.hazards.'+name;
export const validId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const fail=code=>{throw Error(code);};
export const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const text=(value,max,required=false)=>typeof value==='string'&&value.length<=max&&(!required||!!value.trim())&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
export const iso=value=>typeof value==='string'&&!Number.isNaN(Date.parse(value))&&/^\d{4}-\d{2}-\d{2}T/.test(value);
export const allowed=(employee,name,row)=>allowsAppResource(employee,permission(name),{organizationUnitId:row.organization_id,ownerPersonId:row.created_by});
export function requireAllowed(employee,name,row){if(!allowed(employee,name,row))fail('ACCESS_DENIED');}
export function targetOrganization(employee,name,id){
 const grant=employee.businessAuthorization?.grants.find(item=>item.permission===permission(name));
 if(!grant||!validId(id)||!(grant.all||grant.organizationIds.includes(id)||grant.self&&id===employee.organizationUnitId))fail('ACCESS_DENIED');
}
export function scope(employee,name){
 const grant=employee.businessAuthorization?.grants.find(item=>item.permission===permission(name));
 if(!grant)fail('ACCESS_DENIED');
 if(grant.all)return {};
 const anyOf=grant.organizationIds.map(id=>[{column:'organization_id',value:id}]);
 if(grant.self)anyOf.push([{column:'created_by',value:employee.personId}]);
 if(!anyOf.length)fail('ACCESS_DENIED');
 return {anyOf};
}
export function validateRecord(input){
 if(!plain(input)||Object.keys(input).some(key=>!['organizationId','inspectedAt','stationId','location','line','description','category','level','temporaryControls','governanceMeasures','governanceDeadline','governanceDetails','responsiblePerson','responsiblePersonId','beforePhotoId','afterPhotoId','status','aiConfidence','aiBasis'].includes(key)))fail('INVALID_INPUT');
 if(!validId(input.organizationId)||!iso(input.inspectedAt)||!text(input.location,150,true)||!validId(input.stationId)||!text(input.line,100,true)||!text(input.description,2000,true)||!categories.includes(input.category)||!levels.includes(input.level)||!text(input.temporaryControls??'',1000)||!text(input.governanceMeasures??'',2000)||input.governanceDeadline!=null&&!iso(input.governanceDeadline)||!text(input.governanceDetails??'',2000)||!text(input.responsiblePerson,100,true)||!validId(input.responsiblePersonId)||input.beforePhotoId!=null&&!validId(input.beforePhotoId)||input.afterPhotoId!=null&&!validId(input.afterPhotoId)||!['open','pending_review'].includes(input.status)||input.aiConfidence!=null&&(!Number.isFinite(Number(input.aiConfidence))||Number(input.aiConfidence)<0||Number(input.aiConfidence)>1)||!text(input.aiBasis??'',1000))fail('INVALID_INPUT');
 if(input.status==='pending_review'&&(!input.governanceMeasures?.trim()||!input.governanceDetails?.trim()||!input.governanceDeadline||!input.afterPhotoId))fail('CLOSURE_EVIDENCE_REQUIRED');
 return {
  organization_id:input.organizationId,inspected_at:new Date(input.inspectedAt).toISOString(),station_id:input.stationId??null,
  location:input.location.trim(),line:input.line,description:input.description.trim(),category:input.category,level:input.level,
  temporary_controls:input.temporaryControls?.trim()||null,governance_measures:input.governanceMeasures?.trim()||null,
  governance_deadline:input.governanceDeadline?new Date(input.governanceDeadline).toISOString():null,
  governance_details:input.governanceDetails?.trim()||null,responsible_person:input.responsiblePerson.trim(),responsible_person_id:input.responsiblePersonId,
  before_photo_id:input.beforePhotoId??null,after_photo_id:input.afterPhotoId??null,status:input.status,
  ai_confidence:input.aiConfidence==null?null:String(input.aiConfidence),ai_basis:input.aiBasis?.trim()||null,
  search_text:[input.location,input.line,input.description,input.category,input.level,input.responsiblePerson,input.governanceMeasures].filter(Boolean).join(' ').toLowerCase()
 };
}
export function qualityScore(row){
 let score=row.description.trim().length>=15?20:10;
 if(row.category)score+=10;
 if(row.level)score+=10;
 if(row.governance_measures?.trim().length>=8)score+=20;
 if(row.governance_details?.trim().length>=8)score+=15;
 if(row.after_photo_id)score+=15;
 if(row.before_photo_id)score+=10;
 return Math.min(100,score);
}
