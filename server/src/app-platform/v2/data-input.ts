/** Input schemas of the app data operations (`platform.app_data.*`). */
import {z} from 'zod';
import {runtimeListInput,runtimeCountInput,runtimeDailyCountInput} from './data-query.js';
const identifier=z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).refine(v=>!v.startsWith('pg_')&&!v.startsWith('platform_'));
const base={table:identifier,id:z.string().uuid()};
export const readInput=z.object(base).strict();
export const readManyInput=z.object({table:identifier,ids:z.array(z.string().uuid()).min(1).max(50)}).strict();
export const writeInput=z.object({...base,requestId:z.string().uuid(),action:z.enum(['insert','update','delete']),values:z.record(identifier,z.unknown()).optional()}).strict().refine(v=>v.action==='delete'?v.values===undefined:!!v.values&&Object.keys(v.values).length>0&&Object.keys(v.values).length<=63&&!('id'in v.values));
export const transactionItem=z.object({...base,action:z.enum(['insert','update','delete']),values:z.record(identifier,z.unknown()).optional(),expected:z.record(identifier,z.unknown()).optional()}).strict().refine(v=>
 (v.action==='delete'?v.values===undefined:!!v.values&&Object.keys(v.values).length>0&&Object.keys(v.values).length<=63&&!('id' in v.values))&&
 (v.action==='insert'?v.expected===undefined:!!v.expected&&Object.keys(v.expected).length>0&&Object.keys(v.expected).length<=63&&!('id' in v.expected)));
export const transactionInput=z.object({requestId:z.string().uuid(),operations:z.array(transactionItem).min(1).max(16)}).strict();
export const readBatchInput=z.object({operations:z.array(z.union([readInput,readManyInput,runtimeListInput,runtimeCountInput,runtimeDailyCountInput])).min(1).max(4)}).strict();
export function validValue(type:string,value:unknown){if(value===null)return true;if(type==='jsonb')return value!==undefined;
 if(type==='date')return typeof value==='string'&&value.slice(0,4)!=='0000'&&z.string().date().safeParse(value).success;
 if(type==='timestamptz')return typeof value==='string'&&z.string().datetime({offset:true}).safeParse(value).success;
 if(type==='text')return typeof value==='string';if(type==='uuid')return z.string().uuid().safeParse(value).success;
 if(type==='bool')return typeof value==='boolean';return typeof value==='number'&&Number.isInteger(value)&&value>=-2147483648&&value<=2147483647;
}
