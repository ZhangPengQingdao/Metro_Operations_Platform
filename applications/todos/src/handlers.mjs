import {createAppToolClient} from '@metro/platform-sdk/app-tools';
import {readAppAgentInput} from '@metro/platform-sdk/app-agent';
import {createTodosService} from './service.mjs';

const localErrors=new Set(['INVALID_INPUT','INVALID_TARGET','EMPLOYEE_REQUIRED','ACCESS_DENIED','CONFLICT','INACTIVE_TEMPLATE','PAYLOAD_LIMIT']);
const operations={'tool-list-todos':'tool-list-todos','agent-todos':'agentTodos','dashboard-summary':'dashboard-summary',session:'session',directory:'directory',list:'list',detail:'detail','create-task':'createTask','update-task':'updateTask','delete-task':'deleteTask','handle-item':'handleItem','save-template':'saveTemplate','template-state':'templateState',trigger:'trigger'};
export function createTodosHandlers(gateway){
 const service={...createTodosService(gateway)},tools=createAppToolClient(gateway,'mcp');
 service.agentTodos=async(payload,employee,signal)=>{
  const task=readAppAgentInput(payload);
  const status=/(?:已完成|已办结|完成了)/.test(task.message)?'completed':'active';
  const result=await tools.call('list-todos',{status},signal);
  return {kind:'reply',text:[`你有权查看的${status==='active'?'未完成':'已完成'}待办（按创建时间倒序，最多 20 条）：`,...result.rows.map((row,index)=>`${index+1}. ${row.title}`),!result.rows.length?'当前没有符合该状态的待办。':'',result.nextCursor?'更多待办请打开应用查看。':''].filter(Boolean).join('\n\n')};
 };

 return new Map(Object.entries(operations).map(([id,method])=>[id,{
  method:'POST',path:`/${id}`,
  async execute(payload,signal,employee){
   try{return {ok:true,result:await service[method](payload,employee,signal)};}
   catch(error){
    if(error&&typeof error==='object'&&localErrors.has(error.message)&&!('writeOutcome'in error))return {ok:false,error:{code:error.message,writeOutcome:'not_started'}};
    if(error?.code==='STORAGE_CONFLICT')return {ok:false,error:{code:'CONFLICT',writeOutcome:error.writeOutcome==='not_started'?'not_started':'unknown'}};
    if(['tool-list-todos','agent-todos','dashboard-summary','session','directory','list','detail'].includes(id))return {ok:false,error:{code:'READ_FAILED',writeOutcome:'not_started'}};
    return {ok:false,error:{code:'OPERATION_UNCONFIRMED',writeOutcome:'unknown'}};
   }
  },
 }]));
}
