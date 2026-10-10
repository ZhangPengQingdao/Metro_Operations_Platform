import React,{useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import type {AppManifest} from '@metro/platform-sdk/app-manifest';
import {isAppDashboardSnapshot,type AppDashboardSnapshot} from '@metro/platform-sdk/app-dashboard';
import {DashboardCustomization} from './DashboardCustomization';
import {defaultDashboardLayout,visibleDashboardLayout,dashboardTone,type LayoutOptions} from './dashboard-layout';
import {isDashboardLayout,type DashboardLayout} from '@metro/platform-sdk/app-dashboard';
import {DailyChart,CompletionChart,Sparkline} from './DashboardCharts';
import {ApplicationIcon} from '../host/ApplicationIcon';
import {employeeRequest,EmployeeRequestError} from './client';
import './dashboard.css';

export type DashboardApplication={appId:string;name:string;description:string;icon?:AppManifest['icon'];version:string;runtimeRevision:number;routes:{id:string;path:string}[];dashboard?:{routeId:string}};
type CardState={data?:AppDashboardSnapshot;error?:string};
const appHref=(app:DashboardApplication)=>`/employee/app/${app.appId}${(app.routes.find(route=>route.id===app.dashboard?.routeId)??app.routes[0])?.path??''}`;
const formatTime=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});

export function EmployeeDashboard({apps,loaded,onBusyChange,settingsOpen,onSettingsClose}:{settingsOpen:boolean;onSettingsClose:()=>void;apps:DashboardApplication[];loaded:boolean;onBusyChange:(busy:boolean)=>void}){
 const [revision,setRevision]=useState(0),[states,setStates]=useState<{key:string;cards:Record<string,CardState>}>({key:'',cards:{}}),[loading,setLoading]=useState(false);
 const [layoutState,setLayoutState]=useState<{layout:DashboardLayout|null;revision:number}|null>(null),[layoutError,setLayoutError]=useState(''),[editing,setEditing]=useState(false);
 useEffect(()=>{const controller=new AbortController();employeeRequest<{layout:DashboardLayout|null;revision:number}>('/dashboard-layout',{signal:controller.signal}).then(value=>{
  if(value.layout!==null&&!isDashboardLayout(value.layout))throw Error('INVALID_LAYOUT');
  if(!controller.signal.aborted)setLayoutState(value);
 }).catch(()=>{if(!controller.signal.aborted)setLayoutError('个人布局暂不可用，当前显示默认布局。');});return()=>controller.abort();},[]);
 useEffect(()=>{
  if(!settingsOpen)return;
  const controller=new AbortController();
  employeeRequest<{layout:DashboardLayout|null;revision:number}>('/dashboard-layout',{signal:controller.signal}).then(value=>{
   if(value.layout!==null&&!isDashboardLayout(value.layout))throw Error('INVALID_LAYOUT');
   if(!controller.signal.aborted){setLayoutState(value);setLayoutError('');setEditing(true);}
  }).catch(()=>{if(!controller.signal.aborted){setLayoutError('无法读取个人布局，请稍后再试。');onSettingsClose();}});
  return()=>controller.abort();
 },[settingsOpen,onSettingsClose]);
 async function saveLayout(layout:DashboardLayout){
  if(!layoutState)throw Error('请重新打开配置后保存。');
  try{const result=await employeeRequest<{layout:DashboardLayout;revision:number}>('/dashboard-layout',{method:'PUT',body:{layout,revision:layoutState.revision}});setLayoutState(result);}catch(error){
   throw Error(error instanceof EmployeeRequestError&&error.status===409?'布局已在其他窗口修改，请关闭后重新打开配置。':'保存未确认，请关闭后重新打开配置核对；不会自动重试。');
  }
 }
 // Catalogue polling creates new objects; only authority/version/route changes restart requests.
 const key=JSON.stringify(apps.map(app=>[app.appId,app.version,app.runtimeRevision,app.dashboard,app.routes]));
 useEffect(()=>{
  const controller=new AbortController(),sources=apps.filter(app=>app.dashboard);let next=0;
  setStates(old=>old.key===key?old:{key,cards:{}});setLoading(sources.length>0);onBusyChange(sources.length>0);
  async function worker(){
   while(next<sources.length&&!controller.signal.aborted){
    const app=sources[next++];let state:CardState;
    try{
     const value=await employeeRequest<unknown>(`/apps/${app.appId}/dashboard`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
     if(!isAppDashboardSnapshot(value))throw Error('INVALID_DASHBOARD');
     state={data:value};
    }catch(error){state={error:error instanceof EmployeeRequestError&&error.status===403?'当前无权查看此摘要':'摘要暂不可用，可打开应用查看或稍后自动更新'};}
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
 const options:LayoutOptions={cards:sources.map(app=>({id:app.appId,label:app.name})),shortcuts:apps.map(app=>({id:app.appId,label:app.name})),charts:sources.flatMap(app=>{
  const data=cards[app.appId]?.data;
  return [{id:`${app.appId}:completion`,label:`${app.name} · 完成情况`},...(data?.series||layoutState?.layout?.charts.includes(`${app.appId}:series`)?[{id:`${app.appId}:series`,label:data?.series?.label??`${app.name} · 趋势`,detail:data?.series?undefined:'摘要暂不可用'}]:[])];
 })};
 const layout=visibleDashboardLayout(layoutState?.layout??defaultDashboardLayout(options),options);
 const selectedCards=layout.cards.flatMap(id=>sources.filter(app=>app.appId===id));
 const shortcuts=layout.shortcuts.flatMap(id=>apps.filter(app=>app.appId===id));
 const renderChart=(id:string)=>{
    const [appId,kind]=id.split(':'),app=sources.find(a=>a.appId===appId)!;const state=cards[appId],data=state?.data;
    return <section className={`dashboard-panel ${kind==='series'?'dashboard-trend-panel':'dashboard-completion-panel'}`} data-tone={dashboardTone(appId)} key={id}><header><h2>{kind==='series'?(data?.series?.label??`${app.name}趋势`):`${app.name} · 完成情况`}</h2><Link to={appHref(app)}>查看记录 ↗</Link></header>
     {state?.error?<p className="dashboard-panel-empty">{state.error}</p>:kind==='series'&&data?.series?<DailyChart series={data.series}/>:kind==='completion'&&data?.completion?<><CompletionChart entries={[{id:app.appId,name:app.name,completion:data.completion}]}/><div className="dashboard-completion-stats"><span><i/>已完成 <b>{data.completion.completed}</b></span><span><i/>待完成 <b>{data.completion.total-data.completion.completed}</b></span></div></>:<p className="dashboard-panel-empty">{loading?'正在读取…':'应用暂未提供该图表'}</p>}
    </section>;
 };
 return <div className="employee-dashboard">
  <h1 className="dashboard-sr-only">工作台</h1>
  {layoutError&&<p className="dashboard-layout-error" role="status">{layoutError}</p>}
  {editing&&<DashboardCustomization layout={layout} options={options} onSave={saveLayout} onClose={()=>{setEditing(false);onSettingsClose();}}/>}

  {!loaded?<p role="status" className="afc-empty">正在读取可用应用…</p>:!sources.length?<div className="dashboard-empty"><h2>暂无业务概览</h2><p className="afc-muted">应用接入后将在这里显示统计。</p></div>:<div className="dashboard-cards">{selectedCards.map(app=>{
   const state=cards[app.appId],data=state?.data,primary=data?.metrics[0];
   return <article className="dashboard-card" data-tone={dashboardTone(app.appId)} key={app.appId} aria-busy={!state}>
    <header title={data?`${data.scopeLabel} · 更新于 ${formatTime(data.generatedAt)}`:undefined}><span className="dashboard-app-name"><ApplicationIcon appId={app.appId} icon={app.icon} size={19}/><h2>{primary?.label??app.name}</h2></span><Link to={appHref(app)} aria-label={`打开${app.name}`}>↗</Link></header>
    {data&&primary?<><div className="dashboard-kpi-body"><div className="dashboard-primary"><strong>{primary.value.toLocaleString('zh-CN')}</strong><span>{primary.unit}</span></div>{data.series&&<Sparkline series={data.series}/>}</div></>:<p className="dashboard-card-message" role="status">{state?.error??'正在读取…'}</p>}
   </article>;
  })}</div>}
  <div className="dashboard-workspace"><div className="dashboard-main-column">
   {layout.charts.length>0&&<div className="dashboard-chart-grid">{layout.charts.slice(0,2).map(renderChart)}</div>}
   {shortcuts.length>0&&<nav className="dashboard-shortcuts" aria-label="应用快捷入口">{shortcuts.map(app=><Link key={app.appId} to={appHref(app)} data-tone={dashboardTone(app.appId)}><span className="dashboard-shortcut-icon"><ApplicationIcon appId={app.appId} icon={app.icon} size={24}/></span><span>{app.name}</span></Link>)}</nav>}
   {layout.charts.length>2&&<div className="dashboard-chart-grid">{layout.charts.slice(2).map(renderChart)}</div>}
   {!layout.cards.length&&!layout.charts.length&&!layout.shortcuts.length&&loaded&&<div className="dashboard-empty"><h2>按你的习惯布置首页</h2><p className="afc-muted">通过右上角“首页设置”添加卡片、图表和快捷入口。</p></div>}
   {loaded&&!apps.length&&<p className="afc-empty">暂无可用应用，请联系管理员分配应用权限。</p>}
  </div><aside className="dashboard-side-column">
   <section className="dashboard-panel"><header><h2>重点关注</h2></header><div className="dashboard-focus">{sources.map(app=>{const data=cards[app.appId]?.data,metric=data?.metrics[0];return metric?<Link key={app.appId} to={appHref(app)}><ApplicationIcon appId={app.appId} icon={app.icon} size={18}/><span>{metric.label}</span><b>{metric.value}</b></Link>:null;})}{!sources.some(app=>cards[app.appId]?.data)&&<p className="afc-muted">{loading?'正在读取…':'暂无可用摘要'}</p>}</div></section>
   <section className="dashboard-panel"><header><h2>近期记录</h2></header><div className="dashboard-activity">{recent.map(({app,item})=><Link key={`${app.appId}:${item.id}`} to={appHref(app)}><i/><div><p>{item.title}</p>{item.description&&<small>{item.description}</small>}<span>{app.name}{item.occurredAt&&<> · <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time></>}</span></div></Link>)}{!recent.length&&<p className="afc-muted">{loading?'正在读取…':'暂无近期记录'}</p>}</div></section>
  </aside></div>
 </div>;
}
