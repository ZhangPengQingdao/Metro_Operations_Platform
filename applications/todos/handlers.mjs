import {createTodosService} from './service.mjs';

const localErrors=new Set(['INVALID_INPUT','INVALID_TARGET','EMPLOYEE_REQUIRED','ACCESS_DENIED','CONFLICT','INACTIVE_TEMPLATE','PAYLOAD_LIMIT']);
const operations={session:'session',directory:'directory',list:'list',detail:'detail','create-task':'createTask','update-task':'updateTask','delete-task':'deleteTask','handle-item':'handleItem','save-template':'saveTemplate','template-state':'templateState',trigger:'trigger'};
export function createTodosHandlers(gateway){
 const service=createTodosService(gateway);
 return new Map(Object.entries(operations).map(([id,method])=>[id,{
  method:'POST',path:`/${id}`,requireEmployeeContext:true,
  async execute(payload,signal,employee){
   try{return {ok:true,result:await service[method](payload,employee,signal)};}
   catch(error){
    if(error&&typeof error==='object'&&localErrors.has(error.message)&&!('writeOutcome'in error))return {ok:false,error:{code:error.message,writeOutcome:'not_started'}};
    if(error?.code==='STORAGE_CONFLICT')return {ok:false,error:{code:'CONFLICT',writeOutcome:error.writeOutcome==='not_started'?'not_started':'unknown'}};
    if(['session','directory','list','detail'].includes(id))return {ok:false,error:{code:'READ_FAILED',writeOutcome:'not_started'}};
    return {ok:false,error:{code:'OPERATION_UNCONFIRMED',writeOutcome:'unknown'}};
   }
  },
 }]));
}
