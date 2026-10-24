import {permissionFor,allowed} from './business-policy.mjs';
import {createAppDataClient} from '@metro/platform-sdk/app-gateway';
import {createMaterialsAccess} from './access.mjs';
import {createMaterialsService} from './service.mjs';
const businessErrors=new Set(['INVALID_INPUT','EMPLOYEE_REQUIRED','MATERIAL_DENIED','MOVEMENT_DENIED','INSUFFICIENT_STOCK','QUANTITY_LIMIT','ALREADY_REVERSED','REVERSAL_NOT_ALLOWED','ACCESS_DENIED','SETTINGS_CONFLICT','MATERIAL_CONFLICT']);
export function createMaterialsHandlers(gateway){
 const access=createMaterialsAccess(gateway);
 const routes={recipients:'recipients',update:'update','correct-inbound':'correct','correct-outbound':'correct',create:'create',inbound:'move',outbound:'move','reverse-inbound':'reverse','reverse-outbound':'reverse',list:'list',session:'session',bootstrap:'bootstrap',members:'members','set-manager':'setManager'};
 return new Map(Object.entries(routes).map(([name,operation])=>[name,{method:'POST',path:`/${name}`,requireEmployeeContext:true,
  async execute(payload,signal,employee){
   try{
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||'direction' in payload||'expectedKind' in payload||'ownOnly' in payload)throw Error('INVALID_INPUT');
    if(operation==='bootstrap'){
     if(Object.keys(payload).length!==1||!['home','stock','records','settings'].includes(payload.route)||employee.businessAuthorization&&payload.route==='settings')throw Error('INVALID_INPUT');
     const session=employee.businessAuthorization?{business:true,leader:false,manageMaterials:false,organizations:employee.businessAuthorization.organizations,permissions:employee.businessAuthorization.grants.map(g=>g.permission)}:await access.capabilities(employee,signal);
     if(payload.route==='settings'&&!session.leader)throw Error('ACCESS_DENIED');
     const kind=payload.route==='records'||payload.route==='home'&&employee.businessAuthorization&&!session.permissions.includes('app.materials.read-stock')?'consumptions':'materials';
     const permission=permissionFor('list',{kind});
     if(employee.businessAuthorization&&!session.permissions.includes(permission))throw Error('ACCESS_DENIED');
     const page=payload.route==='settings'?await access.members({},employee,signal):await createMaterialsService(gateway,{permission}).list({kind,pageSize:20},employee,signal);
     return {ok:true,result:{session,page}};
    }
    if(employee.businessAuthorization){
     if(operation==='session'){if(Object.keys(payload).length)throw Error('INVALID_INPUT');return {ok:true,result:{business:true,leader:false,manageMaterials:false,organizations:employee.businessAuthorization.organizations,permissions:employee.businessAuthorization.grants.map(g=>g.permission)}};}
     if(['members','setManager'].includes(operation))throw Error('ACCESS_DENIED');
     if(operation==='recipients'){
      const org=payload.organizationId??employee.organizationUnitId;
      if(Object.keys(payload).some(k=>!['organizationId','search'].includes(k))||!employee.businessAuthorization.organizations.some(o=>o.id===org))throw Error('ACCESS_DENIED');
      return {ok:true,result:await gateway.invoke('platform.people.members',{organizationUnitId:org,...(payload.search?{search:payload.search}:{})},signal)};
     }
     const permission=permissionFor(name,payload);
     if(!employee.businessAuthorization.grants.some(g=>g.permission===permission))throw Error('ACCESS_DENIED');
     let value=operation==='move'?{...payload,direction:name==='inbound'?'in':'out'}:payload;
     if(['outbound','correct-outbound'].includes(name)){
      const data=createAppDataClient(gateway),{row}=await data.get(name==='outbound'?'materials':'movements',name==='outbound'?payload.materialId:payload.movementId,signal);
      if(!row||!allowed(employee,permission,row)||'receiver' in payload)throw Error('ACCESS_DENIED');
      const recipient=await access.recipient(payload.receiverId,{...employee,organizationUnitId:row.organization_id},signal);value={...value,receiver:recipient.name};
     }
     const service=createMaterialsService(gateway,{permission});
     return {ok:true,result:['reverse','correct'].includes(operation)?await service[operation](value,employee,signal,{expectedKind:name.endsWith('-inbound')?'in':'out',ownOnly:false}):await service[operation](value,employee,signal)};
    }
    if(operation==='session'){if(Object.keys(payload).length)throw Error('INVALID_INPUT');return {ok:true,result:await access.capabilities(employee,signal)};}
    if(['members','setManager','recipients'].includes(operation))return {ok:true,result:await access[operation](payload,employee,signal)};
    const elevated=['correct-outbound','reverse-outbound'].includes(name)&&(await access.capabilities(employee,signal)).manageMaterials;
    const privileged=['create','update','inbound','reverse-inbound','correct-inbound'].includes(name);
    const guards=privileged||elevated?await access.guard(employee,signal):[];
    const service=createMaterialsService({invoke:(operation,params,signal)=>gateway.invoke(operation,operation==='platform.app_data.transaction'?{...params,operations:[...guards,...params.operations]}:params,signal)});
    let value=operation==='move'?{...payload,direction:name==='inbound'?'in':'out'}:payload;
    if(['outbound','correct-outbound'].includes(name)){
     if('receiver' in payload)throw Error('INVALID_INPUT');
     const recipient=await access.recipient(payload.receiverId,employee,signal);
     value={...value,receiver:recipient.name};
    }
    return {ok:true,result:['reverse','correct'].includes(operation)?await service[operation](value,employee,signal,{expectedKind:name.endsWith('-inbound')?'in':'out',ownOnly:name.endsWith('-outbound')&&!elevated}):await service[operation](value,employee,signal)};
   }
   catch(error){
    // Only local validation/business rejections are definitive. Storage failures retain uncertainty.
    if(businessErrors.has(error.message))return {ok:false,error:{code:error.message,writeOutcome:'not_started'}};
    return {ok:false,error:{code:'OPERATION_UNCONFIRMED',writeOutcome:'unknown'}};
   }
  },
 }]));
}
