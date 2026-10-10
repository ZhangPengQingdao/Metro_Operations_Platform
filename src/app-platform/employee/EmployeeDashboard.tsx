import React,{useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import type {AppManifest} from '@metro/platform-sdk/app-manifest';
import {isAppDashboardSnapshot,type AppDashboardSnapshot} from '@metro/platform-sdk/app-dashboard';
import {Button} from '../../components/ui';
import {ApplicationIcon} from '../host/ApplicationIcon';
import {employeeRequest,EmployeeRequestError} from './client';
import './dashboard.css';

export type DashboardApplication={appId:string;name:string;description:string;icon?:AppManifest['icon'];version:string;runtimeRevision:number;routes:{id:string;path:string}[];dashboard?:{routeId:string}};
type CardState={data?:AppDashboardSnapshot;error?:string};
const appHref=(app:DashboardApplication)=>`/employee/app/${app.appId}${(app.routes.find(route=>route.id===app.dashboard?.routeId)??app.routes[0])?.path??''}`;
const formatTime=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});

export function EmployeeDashboard({name,apps,loaded,onBusyChange}:{name:string;apps:DashboardApplication[];loaded:boolean;onBusyChange:(busy:boolean)=>void}){
 const [revision,setRevision]=useState(0),[states,setStates]=useState<{key:string;cards:Record<string,CardState>}>({key:'',cards:{}}),[loading,setLoading]=useState(false);
 // Catalogue polling creates new objects; only authority/version/route changes restart requests.
 const key=JSON.stringify(apps.map(app=>[app.appId,app.version,app.runtimeRevision,app.dashboard,app.routes]));
 useEffect(()=>{
  const controller=new AbortController(),sources=apps.filter(app=>app.dashboard);let next=0;
  setStates({key,cards:{}});setLoading(sources.length>0);onBusyChange(sources.length>0);
  async function worker(){
   while(next<sources.length&&!controller.signal.aborted){
    const app=sources[next++];let state:CardState;
    try{
     const value=await employeeRequest<unknown>(`/apps/${app.appId}/dashboard`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
     if(!isAppDashboardSnapshot(value))throw Error('INVALID_DASHBOARD');
     state={data:value};
    }catch(error){state={error:error instanceof EmployeeRequestError&&error.status===403?'当前无权查看此摘要':'摘要暂不可用，可打开应用查看或稍后刷新'};}
    if(!controller.signal.aborted)setStates(old=>({key,cards:{...old.cards,[app.appId]:state}}));
   }
  }
  void Promise.all(Array.from({length:Math.min(2,sources.length)},()=>worker())).finally(()=>{if(!controller.signal.aborted){setLoading(false);onBusyChange(false);}});
  return()=>controller.abort();
 },[key,revision,onBusyChange]);
 useEffect(()=>{const refresh=()=>{if(document.visibilityState==='visible')setRevision(v=>v+1);};const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',refresh);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[]);
 const cards=states.key===key?states.cards:{};
 const sources=apps.filter(app=>app.dashboard);
 const recent=sources.flatMap(app=>(cards[app.appId]?.data?.items??[]).map(item=>({app,item}))).sort((a,b)=>(b.item.occurredAt??'').localeCompare(a.item.occurredAt??'')).slice(0,5);
 return <div className="employee-dashboard">
  <div className="dashboard-heading"><div><p className="afc-muted">工作台 / 运营概览</p><h1>{name}，欢迎回来</h1><p className="afc-muted">把需要关注的工作放在一起。</p></div><Button variant="secondary" disabled={loading||!sources.length} onClick={()=>setRevision(v=>v+1)}>{loading?'更新中…':'刷新数据'}</Button></div>
  <div className="dashboard-section-title"><h2>业务概览</h2><span className="afc-muted">统计范围由应用权限决定</span></div>
  {!loaded?<p role="status" className="afc-empty">正在读取可用应用…</p>:!sources.length?<div className="dashboard-empty"><h3>等待应用接入业务概览</h3><p className="afc-muted">应用提供工作台摘要后，这里将显示实时统计。你仍可从下方打开应用。</p></div>:<div className="dashboard-cards">{sources.map(app=>{
   const state=cards[app.appId],data=state?.data,primary=data?.metrics[0],completion=data?.completion;
   const percent=completion&&completion.total>0?Math.round(completion.completed/completion.total*100):null;
   return <article className="dashboard-card" key={app.appId} aria-busy={!state}>
    <header><span className="dashboard-app-name"><ApplicationIcon appId={app.appId} icon={app.icon} size={20}/><h3>{app.name}</h3></span><Link to={appHref(app)} aria-label={`打开${app.name}`}>↗</Link></header>
    {data&&primary?<><div className="dashboard-primary"><span className="afc-muted">{primary.label}</span><p><strong>{primary.value.toLocaleString('zh-CN')}</strong><span>{primary.unit}</span></p></div><dl className="dashboard-secondary">{data.metrics.slice(1).map(metric=><div key={metric.id}><dt>{metric.label}</dt><dd>{metric.value.toLocaleString('zh-CN')} <small>{metric.unit}</small></dd></div>)}</dl>{completion&&<div className="dashboard-completion"><span>完成率 <b>{percent===null?'暂无记录':`${percent}%`}</b></span><progress max={100} value={percent??0} aria-label={`${app.name}完成率`}/></div>}<footer><span>{data.scopeLabel}</span><time dateTime={data.generatedAt}>更新于 {formatTime(data.generatedAt)}</time></footer></>:state?.error?<p className="dashboard-card-message" role="status">{state.error}</p>:<p className="dashboard-card-message" role="status">正在读取业务摘要…</p>}
   </article>;
  })}</div>}
  <div className="dashboard-lower"><section><div className="dashboard-section-title"><h2>应用入口</h2><span className="afc-muted">{apps.length} 个可用应用</span></div><div className="dashboard-apps">{apps.map(app=><Link className="dashboard-app-link" key={app.appId} to={appHref(app)}><span className="employee-app-icon"><ApplicationIcon appId={app.appId} icon={app.icon} size={22}/></span><span><strong>{app.name}</strong><small>{app.description}</small></span><span aria-hidden>→</span></Link>)}</div>{loaded&&!apps.length&&<p className="afc-empty">暂无可用应用，请联系管理员分配应用权限。</p>}</section>
   <section><div className="dashboard-section-title"><h2>近期记录</h2><span className="afc-muted">来自应用摘要</span></div><div className="dashboard-activity">{recent.map(({app,item})=><Link key={`${app.appId}:${item.id}`} to={appHref(app)}><span className="dashboard-activity-dot"/><div><p>{item.title}</p>{item.description&&<small>{item.description}</small>}<span>{app.name}{item.occurredAt&&<> · <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time></>}</span></div></Link>)}{!recent.length&&<p className="afc-muted">{loading?'正在读取近期记录…':'暂无可展示的近期记录。'}</p>}</div></section>
  </div>
 </div>;
}
