import {z} from 'zod';
import {GatewayError} from '../gateway/model.js';
const identifier=z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).refine(v=>!v.startsWith('pg_')&&!v.startsWith('platform_'));
export const runtimeListInput=z.object({
 table:identifier,afterId:z.string().uuid().optional(),pageSize:z.number().int().min(1).max(50).default(20),
 filters:z.array(z.object({column:identifier,value:z.union([z.string().max(1024),z.number().int().min(-2147483648).max(2147483647),z.boolean(),z.null()])}).strict()).max(8).default([]),
 search:z.object({column:identifier,text:z.string().min(1).max(100)}).strict().optional(),
}).strict();
/** Identifiers are verified against the inspected ordinary table, and all query values are parameters. */
export function runtimeListQuery(input:z.infer<typeof runtimeListInput>,columns:ReadonlyMap<string,string>){
 const values:unknown[]=[],conditions:string[]=[];
 const param=(value:unknown)=>{values.push(value);return `$${values.length}`;};
 if(input.afterId)conditions.push(`id>${param(input.afterId)}::uuid`);
 for(const filter of input.filters){
  const type=columns.get(filter.column),value=filter.value;
  if(!type||!['text','uuid','bool','int4'].includes(type)||value!==null&&!(type==='text'?typeof value==='string':type==='uuid'?z.string().uuid().safeParse(value).success:type==='bool'?typeof value==='boolean':typeof value==='number'))throw new GatewayError('INVALID_PARAMS');
  conditions.push(`"${filter.column}" IS NOT DISTINCT FROM ${param(value)}::${type}`);
 }
 if(input.search){
  if(columns.get(input.search.column)!=='text')throw new GatewayError('INVALID_PARAMS');
  conditions.push(`strpos(lower("${input.search.column}"),lower(${param(input.search.text)}::text))>0`);
 }
 return {suffix:`${conditions.length?` WHERE ${conditions.join(' AND ')}`:''} ORDER BY id LIMIT ${param(input.pageSize+1)}`,values};
}
