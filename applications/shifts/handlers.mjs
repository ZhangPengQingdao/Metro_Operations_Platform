import {createShiftsService} from './service.mjs';
const local=new Set(['INVALID_INPUT','INVALID_PERSON','FORM_TOO_LARGE','ACCESS_DENIED','CONFLICT']);
export function createShiftsHandlers(gateway){const service=createShiftsService(gateway);return new Map(Object.entries(service).map(([name,execute])=>[name,{method:'POST',path:`/${name}`,requireEmployeeContext:true,async execute(payload,signal,employee){
 try{if(!payload||typeof payload!=='object'||Array.isArray(payload)||['employee','personId','permissions','businessAuthorization'].some(key=>key in payload))throw Error('INVALID_INPUT');return {ok:true,result:await execute(payload,employee,signal)};}
 catch(error){return {ok:false,error:{code:local.has(error.message)?error.message:'OPERATION_UNCONFIRMED',writeOutcome:local.has(error.message)?'not_started':'unknown'}};}
}}]));}
