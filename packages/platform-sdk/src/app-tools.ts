import type {AppGatewayJson,createAppGatewayClient} from './app-gateway.js';

/** First tool contract: a closed, flat object of bounded scalar arguments. */
export interface AppToolProperty {
  type:'string'|'integer'|'number'|'boolean';
  description?:string;
  enum?:(string|number|boolean)[];
  minLength?:number;maxLength?:number;
  minimum?:number;maximum?:number;
  format?:'uuid';
}
export interface AppToolInputSchema {
  type:'object';properties:Record<string,AppToolProperty>;required:string[];additionalProperties:false;
}
export interface AppToolDefinition {
  id:string;name:string;description:string;apiId:string;permission:string;mode:'read';inputSchema:AppToolInputSchema;
}
export type AppToolInfo=Pick<AppToolDefinition,'id'|'name'|'description'|'mode'|'inputSchema'>;
export type AppToolTransport='direct'|'mcp';
export class AppToolError extends Error {constructor(readonly code:string){super(code);}}

/** Package boundary; execution validates arguments only at the host's API ingress. */
export function isAppToolInputSchema(value:unknown):value is AppToolInputSchema {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const schema=value as AppToolInputSchema;
  if(Object.keys(schema).sort().join(',')!=='additionalProperties,properties,required,type'||schema.type!=='object'||schema.additionalProperties!==false||!schema.properties||typeof schema.properties!=='object'||Array.isArray(schema.properties))return false;
  const names=Object.keys(schema.properties);
  if(names.length>16||names.some(name=>!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(name)||['constructor','prototype'].includes(name))||!Array.isArray(schema.required)||new Set(schema.required).size!==schema.required.length||schema.required.some(name=>!names.includes(name)))return false;
  return Object.values(schema.properties).every(p=>{
    if(!p||typeof p!=='object'||Array.isArray(p)||!['string','integer','number','boolean'].includes(p.type)||Object.keys(p).some(key=>!['type','description','enum','minLength','maxLength','minimum','maximum','format'].includes(key)))return false;
    if(p.description!==undefined&&(typeof p.description!=='string'||p.description.length>300))return false;
    const {enum:values,...withoutEnum}=p;
    if(values!==undefined&&(!Array.isArray(values)||!values.length||values.length>32||values.some(item=>!matchesAppToolProperty(withoutEnum,item))))return false;
    if(p.type==='string')return p.minimum===undefined&&p.maximum===undefined&&(p.format===undefined||p.format==='uuid')&&Number.isInteger(p.maxLength)&&p.maxLength! >= 1&&p.maxLength! <= 1500&&(p.minLength===undefined||Number.isInteger(p.minLength)&&p.minLength>=0&&p.minLength<=p.maxLength!);
    if(p.minLength!==undefined||p.maxLength!==undefined||p.format!==undefined)return false;
    if(p.type==='boolean')return p.minimum===undefined&&p.maximum===undefined;
    return Number.isFinite(p.minimum)&&Number.isFinite(p.maximum)&&p.minimum! <= p.maximum!&&(p.type!=='integer'||Number.isSafeInteger(p.minimum)&&Number.isSafeInteger(p.maximum));
  });
}
function matchesAppToolProperty(schema:AppToolProperty,value:unknown):boolean {
  if(schema.enum&&!schema.enum.includes(value as string|number|boolean))return false;
  if(schema.type==='boolean')return typeof value==='boolean';
  if(schema.type==='string')return typeof value==='string'&&value.length>=(schema.minLength??0)&&value.length<=schema.maxLength!&&(schema.format!=='uuid'||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
  return typeof value==='number'&&Number.isFinite(value)&&value>=schema.minimum!&&value<=schema.maximum!&&(schema.type!=='integer'||Number.isSafeInteger(value));
}
export function matchesAppToolInput(schema:AppToolInputSchema,value:unknown):boolean {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const input=value as Record<string,unknown>;
  return schema.required.every(name=>Object.hasOwn(input,name))&&Object.entries(input).every(([name,v])=>Object.hasOwn(schema.properties,name)&&matchesAppToolProperty(schema.properties[name]!,v));
}

/** Bound to the calling employee and this application by the host. No app/user overrides. */
export function createAppToolClient(gateway:Pick<ReturnType<typeof createAppGatewayClient>,'invoke'>,transport:AppToolTransport='direct') {
  return {
    list:(signal?:AbortSignal)=>gateway.invoke('platform.tools.list',{transport},signal) as unknown as Promise<{tools:AppToolInfo[]}>,
    async call<T=AppGatewayJson>(toolId:string,args:Record<string,AppGatewayJson>,signal?:AbortSignal):Promise<T>{
      const result=await gateway.invoke('platform.tools.call',{transport,toolId,arguments:args},signal) as unknown as {ok:true;result:T}|{ok:false;error:{code:string}};
      if(!result.ok)throw new AppToolError(result.error.code);
      return result.result;
    },
  };
}
