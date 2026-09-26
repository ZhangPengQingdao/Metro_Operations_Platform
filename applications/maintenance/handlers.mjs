import {createMaintenanceService} from './service.mjs';
const definitive=new Set(['INVALID_INPUT','PLAN_TOO_LARGE','ACCESS_DENIED','INVALID_PERSON','INVALID_STATION','CONFLICT','COMPLETED_PROTECTED','EMPLOYEE_REQUIRED']);
const reads=new Set(['session','catalog','list','detail','export']);
export function createMaintenanceHandlers(gateway){
 const service=createMaintenanceService(gateway);
 return new Map(Object.entries(service).map(([name,execute])=>[name,{method:'POST',path:`/${name}`,requireEmployeeContext:true,async execute(payload,signal,employee){
  try{
   if(!payload||typeof payload!=='object'||Array.isArray(payload)||['employee','personId','businessAuthorization','permissions'].some(key=>key in payload))throw Error('INVALID_INPUT');
   return {ok:true,result:await execute(payload,employee,signal)};
  }catch(error){
   const code=definitive.has(error.message)?error.message:reads.has(name)?'READ_FAILED':'OPERATION_UNCONFIRMED';
   return {ok:false,error:{code,writeOutcome:definitive.has(code)||reads.has(name)?'not_started':'unknown'}};
  }
 }}]));
}
