import {z} from 'zod';
import {GatewayError} from '../gateway/model.js';
const identifier=z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).refine(v=>!v.startsWith('pg_')&&!v.startsWith('platform_'));
const scalar=z.union([z.string().max(1024),z.number().int().min(-2147483648).max(2147483647),z.boolean(),z.null()]);
const filter=z.union([z.object({column:identifier,value:scalar}).strict(),z.object({column:identifier,contains:z.array(z.record(scalar)).min(1).max(10)}).strict()]);
type RuntimeFilter=z.infer<typeof filter>;
export const runtimeListInput=z.object({
 table:identifier,afterId:z.string().uuid().optional(),pageSize:z.number().int().min(1).max(50).default(20),
 filters:z.array(filter).max(8).default([]),
 anyOf:z.array(z.array(filter).min(1).max(8)).min(1).max(128).optional(),
 order:z.object({column:identifier,direction:z.enum(['asc','desc'])}).strict().optional(),
 after:z.object({value:z.string().max(1024),id:z.string().uuid()}).strict().optional(),
 range:z.object({column:identifier,from:z.string().max(100).optional(),to:z.string().max(100).optional()}).strict().optional(),
 search:z.object({column:identifier,text:z.string().min(1).max(100)}).strict().optional(),
}).strict();
/** Identifiers are verified against the inspected ordinary table, and all query values are parameters. */
export function runtimeListQuery(input:z.infer<typeof runtimeListInput>,columns:ReadonlyMap<string,string>){
 const values:unknown[]=[],conditions:string[]=[];
 const param=(value:unknown)=>{values.push(value);return `$${values.length}`;};
 if(input.afterId&&input.order||input.after&&!input.order)throw new GatewayError('INVALID_PARAMS');
 if(input.afterId)conditions.push(`id>${param(input.afterId)}::uuid`);
 const clause=(filter:RuntimeFilter)=>{
  const type=columns.get(filter.column);
  if('contains' in filter){if(type!=='jsonb')throw new GatewayError('INVALID_PARAMS');return `"${filter.column}" @> ${param(JSON.stringify(filter.contains))}::jsonb`;}
  const value=filter.value;
  if(!type||!['text','uuid','bool','int4','date','timestamptz'].includes(type)||value!==null&&!(['text','date','timestamptz'].includes(type)?typeof value==='string':type==='uuid'?z.string().uuid().safeParse(value).success:type==='bool'?typeof value==='boolean':typeof value==='number'))throw new GatewayError('INVALID_PARAMS');
  return `"${filter.column}" IS NOT DISTINCT FROM ${param(value)}::${type}`;
 }
 for(const f of input.filters)conditions.push(clause(f));
 if(input.anyOf)conditions.push('('+input.anyOf.map(group=>'('+group.map(clause).join(' AND ')+')').join(' OR ')+')');
 if(input.search){
  if(columns.get(input.search.column)!=='text')throw new GatewayError('INVALID_PARAMS');
  conditions.push(`strpos(lower("${input.search.column}"),lower(${param(input.search.text)}::text))>0`);
 }
 const sortable=(column:string)=>{const type=columns.get(column);if(!type||!['text','date','timestamptz'].includes(type))throw new GatewayError('INVALID_PARAMS');return type;};
 if(input.range){const r=input.range,type=sortable(r.column);if(r.from)conditions.push(`"${r.column}">=${param(r.from)}::${type}`);if(r.to)conditions.push(`"${r.column}"<=${param(r.to)}::${type}`);}
 let order='id';
 if(input.order){const o=input.order,type=sortable(o.column),direction=o.direction==='desc'?'DESC':'ASC';order=`"${o.column}" ${direction},id ${direction}`;
  if(input.after)conditions.push(`("${o.column}",id)${o.direction==='desc'?'<':'>'}(${param(input.after.value)}::${type},${param(input.after.id)}::uuid)`);
 }
 return {suffix:`${conditions.length?` WHERE ${conditions.join(' AND ')}`:''} ORDER BY ${order} LIMIT ${param(input.pageSize+1)}`,values};
}
