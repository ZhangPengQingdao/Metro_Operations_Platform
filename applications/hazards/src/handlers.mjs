import {createHazardService} from './service.mjs';

const definitive=new Set(['INVALID_INPUT','INVALID_STATION','INVALID_PERSON','EMPLOYEE_REQUIRED','ACCESS_DENIED','INVALID_PHOTO','PHOTO_NOT_FOUND','PHOTO_INCOMPLETE','PHOTO_CORRUPT','CLOSURE_EVIDENCE_REQUIRED','SELF_REVIEW_DENIED','NOT_READY_TO_CLOSE','CONFLICT','NOT_FOUND','AI_INVALID_RESULT','AI_UNAVAILABLE']);
const reads=new Set(['session','catalog','list','detail','cases','suggest','photo-read']);
export function createHazardHandlers(gateway){
 const service=createHazardService(gateway);
 return new Map(Object.entries(service).map(([name,execute])=>[name,{method:'POST',path:`/${name}`,requireEmployeeContext:true,async execute(payload,signal,employee){
  try{if(!payload||typeof payload!=='object'||Array.isArray(payload)||['employee','personId','businessAuthorization','permissions'].some(key=>key in payload))throw Error('INVALID_INPUT');return {ok:true,result:await execute(payload,employee,signal)};}
  catch(error){const code=definitive.has(error.message)?error.message:reads.has(name)?'READ_FAILED':'OPERATION_UNCONFIRMED';return {ok:false,error:{code,writeOutcome:definitive.has(code)||reads.has(name)?'not_started':'unknown'}};}
 }}]));
}
