import type {SandboxBridgeOperation,SandboxJson} from '../host/sandbox/bridge';
export interface EmployeeApiRoute {id:string;method:string;path:string}
/** Routes come from the platform's verified manifest response, never from a sandbox message. */
export function createEmployeeApiBridge(routes:readonly EmployeeApiRoute[],invoke:(request:{apiId:string;method:string;path:string;payload:SandboxJson},signal:AbortSignal)=>Promise<SandboxJson>){
 const operations=new Map<string,SandboxBridgeOperation>();
 if(routes.length>128)throw Error('INVALID_APP_API_ROUTES');
 for(const source of routes){
  const route={...source};
  if((route.id.length>64||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(route.id))||!['GET','POST','PUT','PATCH','DELETE'].includes(route.method)||route.path.length>256||!(route.path==='/'||/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(route.path))||operations.has(`application.api.${route.id}`))throw Error('INVALID_APP_API_ROUTES');
  operations.set(`application.api.${route.id}`,{
   validate:()=>true, // The broker bounds JSON; application and server validate business input.
   authorize:async()=>true, // Fresh employee + application authorization is enforced by the server.
   execute:(payload,signal)=>invoke({apiId:route.id,method:route.method,path:route.path,payload},signal),
  });
 }
 return operations;
}
