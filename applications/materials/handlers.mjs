import {createMaterialsAccess} from './access.mjs';
import {createMaterialsService} from './service.mjs';
const businessErrors=new Set(['INVALID_INPUT','EMPLOYEE_REQUIRED','MATERIAL_DENIED','MOVEMENT_DENIED','INSUFFICIENT_STOCK','QUANTITY_LIMIT','ALREADY_REVERSED','REVERSAL_NOT_ALLOWED','ACCESS_DENIED','SETTINGS_CONFLICT']);
export function createMaterialsHandlers(gateway){
 const access=createMaterialsAccess(gateway);
 const routes={create:'create',inbound:'move',outbound:'move','reverse-inbound':'reverse','reverse-outbound':'reverse',list:'list',session:'session',members:'members','set-manager':'setManager'};
 return new Map(Object.entries(routes).map(([name,operation])=>[name,{method:'POST',path:`/${name}`,requireEmployeeContext:true,
  async execute(payload,signal,employee){
   try{
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||'direction' in payload||'expectedKind' in payload||'ownOnly' in payload)throw Error('INVALID_INPUT');
    if(operation==='session'){if(Object.keys(payload).length)throw Error('INVALID_INPUT');return {ok:true,result:await access.capabilities(employee,signal)};}
    if(['members','setManager'].includes(operation))return {ok:true,result:await access[operation](payload,employee,signal)};
    const privileged=['create','inbound','reverse-inbound'].includes(name);
    const guards=privileged?await access.guard(employee,signal):[];
    const service=createMaterialsService({invoke:(operation,params,signal)=>gateway.invoke(operation,operation==='platform.app_data.transaction'?{...params,operations:[...guards,...params.operations]}:params,signal)});
    const value=operation==='move'?{...payload,direction:name==='inbound'?'in':'out'}:payload;
    return {ok:true,result:operation==='reverse'?await service.reverse(value,employee,signal,{expectedKind:name==='reverse-inbound'?'in':'out',ownOnly:name==='reverse-outbound'}):await service[operation](value,employee,signal)};
   }
   catch(error){
    // Only local validation/business rejections are definitive. Storage failures retain uncertainty.
    if(businessErrors.has(error.message))return {ok:false,error:{code:error.message,writeOutcome:'not_started'}};
    return {ok:false,error:{code:'OPERATION_UNCONFIRMED',writeOutcome:'unknown'}};
   }
  },
 }]));
}
