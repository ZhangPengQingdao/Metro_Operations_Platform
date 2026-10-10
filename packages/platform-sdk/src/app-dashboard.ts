import type {AppDataCount,AppDataListOptions,AppDataRead} from './app-gateway.js';

export interface AppDashboardSnapshot {
 version:'1.0';
 generatedAt:string;
 scopeLabel:string;
 metrics:{id:string;label:string;value:number;unit:string}[];
 completion?:{completed:number;total:number};
 items:{id:string;title:string;description?:string;occurredAt?:string}[];
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const date=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v));
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(key=>allowed.includes(key));
/** Bounded display data only: no HTML, arbitrary links, code or employee identity. */
export function isAppDashboardSnapshot(value:unknown):value is AppDashboardSnapshot {
 if(!object(value)||!keys(value,['version','generatedAt','scopeLabel','metrics','completion','items'])||value.version!=='1.0'||!date(value.generatedAt)||!text(value.scopeLabel,100))return false;
 if(!Array.isArray(value.metrics)||value.metrics.length<1||value.metrics.length>4||!value.metrics.every(m=>object(m)&&keys(m,['id','label','value','unit'])&&text(m.id,64)&&text(m.label,40)&&count(m.value)&&text(m.unit,12))||new Set(value.metrics.map(m=>m.id)).size!==value.metrics.length)return false;
 if(value.completion!==undefined&&(!object(value.completion)||!keys(value.completion,['completed','total'])||!count(value.completion.completed)||!count(value.completion.total)||value.completion.completed>value.completion.total))return false;
 return Array.isArray(value.items)&&value.items.length<=5&&value.items.every(i=>object(i)&&keys(i,['id','title','description','occurredAt'])&&text(i.id,64)&&text(i.title,160)&&(i.description===undefined||text(i.description,160))&&(i.occurredAt===undefined||date(i.occurredAt)))&&new Set(value.items.map(i=>i.id)).size===value.items.length;
}

/** App-owned scopes are reused for counts and previews in one read-only batch/lease. */
export async function readAppDashboard(options:{
 readBatch:(operations:readonly AppDataRead[],signal?:AbortSignal)=>Promise<unknown>;
 table:string;scope:Pick<AppDataListOptions,'anyOf'>;filters:NonNullable<AppDataListOptions['filters']>;
 previewColumns:readonly string[];
 previewFilters?:NonNullable<AppDataListOptions['filters']>;
 done:NonNullable<AppDataListOptions['filters']>;excluded?:NonNullable<AppDataListOptions['filters']>;
 labels:[string,string,string];unit:string;
 preview:(row:Record<string,unknown>)=>AppDashboardSnapshot['items'][number];
 clock?:()=>Date;
},signal?:AbortSignal):Promise<AppDashboardSnapshot>{
 const base={table:options.table,...options.scope,filters:options.filters};
 const total:AppDataCount={...base,kind:'count'};
 const operations:AppDataRead[]=[total,{...total,filters:[...options.filters,...options.done]},
  {...base,columns:options.previewColumns,filters:[...options.filters,...(options.previewFilters??[])],pageSize:1,order:{column:'created_at',direction:'desc'}}];
 if(options.excluded)operations.push({...total,filters:[...options.filters,...options.excluded]});
 const result=await options.readBatch(operations,signal) as {results:({count:number}|{rows:Record<string,unknown>[]})[]};
 const counts=result.results.slice(0,2).map(r=>(r as {count:number}).count);
 const all=counts[0]!,done=counts[1]!,excluded=options.excluded?(result.results[3] as {count:number}).count:0;
 if(![all,done,excluded].every(count)||done+excluded>all)throw Error('INVALID_DASHBOARD_COUNTS');
 const snapshot:AppDashboardSnapshot={version:'1.0',generatedAt:(options.clock??(()=>new Date()))().toISOString(),scopeLabel:'当前授权范围 · 全部记录',
  metrics:[{id:'pending',label:options.labels[0],value:all-done-excluded,unit:options.unit},{id:'completed',label:options.labels[1],value:done,unit:options.unit},{id:'total',label:options.labels[2],value:all-excluded,unit:options.unit}],
  completion:{completed:done,total:all-excluded},items:(result.results[2] as {rows:Record<string,unknown>[]}).rows.map(options.preview)};
 if(!isAppDashboardSnapshot(snapshot))throw Error('INVALID_DASHBOARD_RESPONSE');
 return snapshot;
}
