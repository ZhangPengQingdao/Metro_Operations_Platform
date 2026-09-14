import {createAppGatewayClient,AppGatewayClientError,type AppGatewayJson,type AppGatewayRequest} from './app-gateway.js';

export interface AppTestOperation {
 name:string;
 /** Explicit fake data/behavior. This is never platform authorization or a production adapter. */
 execute(params:AppGatewayJson,signal?:AbortSignal):Promise<AppGatewayJson>;
}
/** Deterministic local contract harness. No fetch, cookies, credentials or automatic retry.
 * Uses the real SDK client so request snapshots and error semantics match application code.
 * Unknown operations fail closed; callers must explicitly supply every available operation.
 */
export function createAppTestHost(operations:readonly AppTestOperation[]) {
 if(!Array.isArray(operations)||operations.length>128)throw new AppGatewayClientError('INVALID_TEST_HOST','not_started');
 const handlers=new Map<string,AppTestOperation['execute']>();
 for(const item of operations){
  if(!item||! /^[a-z][a-z0-9._-]{0,99}$/.test(item.name)||typeof item.execute!=='function'||handlers.has(item.name))throw new AppGatewayClientError('INVALID_TEST_HOST','not_started');
  handlers.set(item.name,item.execute);
 }
 let open=true,serial=0;
 const requests:AppGatewayRequest[]=[];
 const running=new Set<Promise<unknown>>();
 const client=createAppGatewayClient(async(request,signal)=>{
  if(!open||signal?.aborted)throw new AppGatewayClientError('ABORTED','not_started');
  const execute=handlers.get(request.operation);
  if(!execute)throw new AppGatewayClientError('OPERATION_DENIED','not_started');
  if(running.size>=16)throw new AppGatewayClientError('BUSY','not_started');
  if(requests.length>=1000)throw new AppGatewayClientError('TEST_HISTORY_FULL','not_started');
  requests.push(request);const id=`test-${++serial}`;
  const work=Promise.resolve().then(async()=>{
   if(!open||signal?.aborted)throw new AppGatewayClientError('ABORTED','not_started');
   const result=await execute(request.params,signal);
   if(!open||signal?.aborted)throw new AppGatewayClientError('ABORTED','unknown');
   return {version:'1.0',requestId:id,traceId:id,result};
  });
  running.add(work);
  try{return await work;}finally{running.delete(work);}
 });
 return Object.freeze({client,
  requests:():readonly AppGatewayRequest[]=>Object.freeze([...requests]),
  close:()=>{open=false;},
  async drain(){if(open)throw new AppGatewayClientError('DRAIN_REQUIRES_CLOSE','not_started');await Promise.allSettled([...running]);},
 });
}
