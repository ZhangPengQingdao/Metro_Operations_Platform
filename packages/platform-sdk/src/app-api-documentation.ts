import type {AppGatewayJson} from './app-gateway.js';

/** Bounded JSON Schema subset for documentation; no remote references or executable validators. */
export interface AppContractSchema {
  type:'object'|'array'|'string'|'number'|'integer'|'boolean'|'null';
  description?:string;
  properties?:Record<string,AppContractSchema>;
  required?:string[];
  additionalProperties?:boolean;
  items?:AppContractSchema;
  enum?:AppGatewayJson[];
}
export interface AppApiDocumentation {
  description:string;
  input:AppContractSchema;
  output:AppContractSchema;
  examples:{title:string;params:AppGatewayJson;result:AppGatewayJson}[];
  errors:{code:string;description:string}[];
}

/** Validate metadata before signing. This never grants access or replaces handler validation. */
export function isAppApiDocumentation(value:unknown):value is AppApiDocumentation {
  try {
    let jsonNodes=0;const seen=new Set<object>();
    const json=(v:unknown,depth=0):boolean=>{
      if(++jsonNodes>4096||depth>24)return false;
      if(v===null||typeof v==='string'||typeof v==='boolean')return true;
      if(typeof v==='number')return Number.isFinite(v);
      if(!v||typeof v!=='object'||seen.has(v)||!([Object.prototype,Array.prototype,null].includes(Object.getPrototypeOf(v))))return false;
      seen.add(v);
      const names=Reflect.ownKeys(v);
      if(Array.isArray(v)&&names.length!==v.length+1)return false;
      const valid=names.every(key=>{
        if(Array.isArray(v)&&key==='length')return true;
        if(typeof key!=='string')return false;
        const descriptor=Object.getOwnPropertyDescriptor(v,key)!;
        return descriptor.enumerable&&'value' in descriptor&&json(descriptor.value,depth+1);
      });seen.delete(v);return valid;
    };
    if(!json(value))return false;
    const encoded=JSON.stringify(value);
    if(!encoded||new TextEncoder().encode(encoded).length>16384)return false;
    const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
    const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
    const text=(v:unknown,max=1024):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
    let nodes=0;
    const schema=(v:unknown,depth=0):v is AppContractSchema=>{
      if(++nodes>128||depth>8||!object(v)||!keys(v,['type','description','properties','required','additionalProperties','items','enum'])||!['object','array','string','number','integer','boolean','null'].includes(String(v.type)))return false;
      if(v.description!==undefined&&!text(v.description))return false;
      if(v.enum!==undefined&&(!Array.isArray(v.enum)||!v.enum.length||v.enum.length>32))return false;
      if(v.type==='object') {
        if(v.items!==undefined||v.properties!==undefined&&(!object(v.properties)||Object.keys(v.properties).some(k=>k.length>128||['__proto__','constructor','prototype'].includes(k))||!Object.values(v.properties).every(s=>schema(s,depth+1))))return false;
        if(v.required!==undefined&&(!Array.isArray(v.required)||new Set(v.required).size!==v.required.length||v.required.some(k=>typeof k!=='string'||!object(v.properties)||!Object.hasOwn(v.properties,k))))return false;
        if(v.additionalProperties!==undefined&&typeof v.additionalProperties!=='boolean')return false;
      }else if(v.properties!==undefined||v.required!==undefined||v.additionalProperties!==undefined)return false;
      if(v.type==='array') {if(!schema(v.items,depth+1))return false;}else if(v.items!==undefined)return false;
      return true;
    };
    if(!object(value)||!keys(value,['description','input','output','examples','errors'])||!text(value.description)||!schema(value.input)||!schema(value.output))return false;
    if(!Array.isArray(value.examples)||value.examples.length<1||value.examples.length>4||!value.examples.every(e=>object(e)&&keys(e,['title','params','result'])&&text(e.title,80)&&Object.hasOwn(e,'params')&&Object.hasOwn(e,'result')&&matchesAppContract(value.input as AppContractSchema,e.params)&&matchesAppContract(value.output as AppContractSchema,e.result)))return false;
    return Array.isArray(value.errors)&&value.errors.length<=16&&value.errors.every(e=>object(e)&&keys(e,['code','description'])&&typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(e.code)&&text(e.description));
  }catch{return false;}
}

/** Matches the supported schema subset, for examples and application-owned validation. */
export function matchesAppContract(schema:AppContractSchema,value:unknown,depth=0):boolean {
  if(depth>16)return false;
  if(schema.enum&&!schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)))return false;
  switch(schema.type){
    case 'null':return value===null;
    case 'string':return typeof value==='string';
    case 'boolean':return typeof value==='boolean';
    case 'number':return typeof value==='number'&&Number.isFinite(value);
    case 'integer':return typeof value==='number'&&Number.isSafeInteger(value);
    case 'array':return Array.isArray(value)&&value.every(item=>!!schema.items&&matchesAppContract(schema.items,item,depth+1));
    case 'object':{
      if(!value||typeof value!=='object'||Array.isArray(value))return false;
      const record=value as Record<string,unknown>;
      return (schema.required??[]).every(key=>Object.hasOwn(record,key))&&Object.entries(record).every(([key,item])=>{
        const property=Object.hasOwn(schema.properties??{},key)?schema.properties![key]:undefined;
        return property?matchesAppContract(property,item,depth+1):schema.additionalProperties!==false;
      });
    }
  }
}
