import {Server,InMemoryTransport,ProtocolError,ProtocolErrorCode,type Tool} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/client';
import {z} from 'zod';
import type {AppToolDefinition,AppToolInputSchema,AppToolInfo} from '@metro/platform-sdk/app-tools';
import {GatewayError,type GatewayJson} from '../gateway/model.js';
import {AppV2CallError} from '../v2/host.js';

export type ToolScope={appId:string;personId:string};
export type ToolBinding=AppToolDefinition&{installationId:string;revision:number};
export interface ToolDependencies {
  catalog(scope:ToolScope):Promise<ToolBinding[]>;
  invoke(scope:ToolScope,tool:ToolBinding,args:unknown,signal:AbortSignal):Promise<unknown>;
}
const reply=z.discriminatedUnion('ok',[
  z.object({ok:z.literal(true),result:z.unknown().refine(value=>value!==undefined)}).strict(),
  z.object({ok:z.literal(false),error:z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),writeOutcome:z.enum(['not_started','unknown']).optional()}).strict()}).strict(),
]);
/** One execution path for both transports. The host API boundary owns argument validation. */
export class AppToolService {
  constructor(private readonly deps:ToolDependencies){}
  async list(scope:ToolScope):Promise<{tools:AppToolInfo[]}>{
    return {tools:(await this.deps.catalog(scope)).map(({id,name,description,inputSchema,mode})=>({id,name,description,inputSchema,mode}))};
  }
  async call(scope:ToolScope,toolId:string,args:unknown,signal:AbortSignal){
    signal.throwIfAborted();
    const tool=(await this.deps.catalog(scope)).find(item=>item.id===toolId);
    if(!tool)throw new GatewayError('ACCESS_DENIED',403);
    let value:unknown;
    try{value=await this.deps.invoke(scope,tool,args,signal);}
    catch(error){if(error instanceof AppV2CallError)throw new GatewayError(error.code,error.statusCode);throw error;}
    const parsed=reply.safeParse(value);
    if(!parsed.success)throw new GatewayError('INVALID_RESULT',502);
    const result=parsed.data;
    return result.ok?{ok:true as const,result:result.result as GatewayJson}:{ok:false as const,error:{code:result.error.code}};
  }
  /** A short-lived MCP session, bound by the host rather than protocol-supplied identity. */
  async mcp(scope:ToolScope,request:{toolId?:string;arguments?:unknown},signal:AbortSignal){
    const server=createAppToolMcpServer(this,scope),client=new Client({name:'metro-application-host',version:'1.0.0'});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    try{
      signal.throwIfAborted();
      await server.connect(serverTransport);
      await client.connect(clientTransport,{signal,timeout:30000});
      if(!request.toolId){
        const result=await client.listTools(undefined,{signal,timeout:30000});
        return {tools:result.tools.map(tool=>({id:tool.name,name:tool.title??tool.name,description:tool.description??'',mode:'read' as const,inputSchema:tool.inputSchema as unknown as AppToolInputSchema}))};
      }
      const result=await client.callTool({name:request.toolId,arguments:request.arguments as Record<string,unknown>},{signal,timeout:30000});
      return result.structuredContent as {ok:true;result:GatewayJson}|{ok:false;error:{code:string}};
    }catch(error){
      if(signal.aborted)throw new GatewayError('ABORTED',499);
      if(error instanceof ProtocolError&&error.data&&typeof error.data==='object'&&'code' in error.data&&typeof error.data.code==='string')throw new GatewayError(error.data.code,'statusCode' in error.data&&typeof error.data.statusCode==='number'?error.data.statusCode:502);
      throw error;
    }finally{await client.close();await server.close();}
  }
}

/** Standard MCP lifecycle and tools methods; no listener, token or external port. */
export function createAppToolMcpServer(service:AppToolService,scope:ToolScope){
  const server=new Server({name:`metro-${scope.appId}-tools`,version:'1.0.0'},{capabilities:{tools:{}}});
  async function respond<T>(work:()=>Promise<T>):Promise<T>{
    try{return await work();}
    catch(error){
      if(error instanceof GatewayError)throw new ProtocolError(ProtocolErrorCode.InvalidParams,error.code,{code:error.code,statusCode:error.statusCode});
      throw error;
    }
  }
  server.setRequestHandler('tools/list',()=>respond(async()=>({tools:(await service.list(scope)).tools.map(tool=>({
    name:tool.id,title:tool.name,description:tool.description,inputSchema:tool.inputSchema as unknown as Tool['inputSchema'],
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  }))})));
  server.setRequestHandler('tools/call',(request,context)=>respond(async()=>{
    const result=await service.call(scope,request.params.name,request.params.arguments??{},context.mcpReq.signal);
    return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result,...(!result.ok?{isError:true}:{})};
  }));
  return server;
}
