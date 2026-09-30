import {createHuicetongService} from './service.mjs';
const definitive=new Set(['INVALID_INPUT','EMPLOYEE_REQUIRED','ACCESS_DENIED','CONFLICT','NOT_FOUND','CYCLE_EXISTS','CYCLE_LOCKED','CATEGORY_INVALID','PERSON_INVALID','ITEM_TOO_LARGE','BINDING_MISSING','REVIEW_NOT_OPEN','REVIEW_PENDING','SIGNATURE_PENDING']);
const reads=new Set(['session','members','cycle-list','cycle-get','category-list','item-list','item-get','binding-list','cycle.signature-status','change.list']);
export function createHuicetongHandlers(gateway){
 const service=createHuicetongService(gateway);
 return new Map(Object.entries(service).map(([name,execute])=>[name,{method:'POST',path:`/${name}`,requireEmployeeContext:true,async execute(payload,signal,employee){
  try{
   // A binding's personId is the target person, never the authenticated actor.
   if(!payload||typeof payload!=='object'||Array.isArray(payload)||['employee','permissions','businessAuthorization'].some(key=>key in payload)||name!=='binding-upsert'&&'personId' in payload)throw Error('INVALID_INPUT');
   return {ok:true,result:await execute(payload,employee,signal)};
  }catch(error){const code=definitive.has(error.message)?error.message:reads.has(name)?'READ_FAILED':'OPERATION_UNCONFIRMED';return {ok:false,error:{code,writeOutcome:definitive.has(code)||reads.has(name)?'not_started':'unknown',...(code==='BINDING_MISSING'?{details:error.details}: {})}};}
 }}]));
}
