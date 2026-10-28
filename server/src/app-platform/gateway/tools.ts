import {z} from 'zod';
import {GatewayError,type AppGatewayOperation} from './model.js';
import type {AppToolService} from '../tools/index.js';

const transport=z.enum(['direct','mcp']);
const list=z.object({transport}).strict();
const call=z.object({transport,toolId:z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64),arguments:z.record(z.unknown())}).strict();
/** Only the protocol envelope is checked here; arguments belong to the host API ingress. */
export function createToolOperations(service:AppToolService):AppGatewayOperation[]{
  return (['list','call'] as const).map(action=>({
    name:`platform.tools.${action}`,permissionCode:'platform.tools.read',mode:'read',
    validateParams:value=>(action==='list'?list:call).safeParse(value).success,
    resolveResources:async()=>[{}],validateResult:()=>true,
    auditMetadata:value=>{const p=value as unknown as z.infer<typeof call>;return {transport:p.transport,...(action==='call'?{toolId:p.toolId}:{})};},
    async execute(context,value,signal){
      const employee=context.employeeActor;
      if(context.actorType!=='service'||!employee||employee.execution.type!=='application'||employee.execution.appId!==context.execution.appId)throw new GatewayError('ACCESS_DENIED',403);
      const scope={appId:context.execution.appId,personId:employee.person.id},input=value as unknown as z.infer<typeof call>;
      if(input.transport==='mcp')return service.mcp(scope,action==='list'?{}:{toolId:input.toolId,arguments:input.arguments},signal);
      return action==='list'?service.list(scope):service.call(scope,input.toolId,input.arguments,signal);
    },
  }));
}
