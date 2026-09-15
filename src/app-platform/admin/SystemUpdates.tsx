import React,{useEffect,useState} from 'react';
import {Button} from '../../components/ui';
import {AdminDialog} from './AdminShell';
import {adminRequest} from './client';
type Task={id:string;action:string;version:string;phase:string;error:string|null};
type Status={configured:boolean;currentVersion?:string;task?:Task|null};
const phases:Record<string,string>={queued:'等待处理',downloading:'下载中',verified:'校验通过',downloaded:'已下载',preflight:'升级预检',maintenance:'进入维护',backing_up:'正在备份',migrating:'数据库迁移',switching:'切换版本',health_check:'健康检查',completed:'更新完成',cancelled:'已恢复原版本',failed:'操作失败',recovery_required:'需要服务器核对'};
export function SystemUpdates(){
 const [status,setStatus]=useState<Status|null>(null),[available,setAvailable]=useState<{version:string;available:boolean;url:string}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false);
 async function refresh(){try{setStatus(await adminRequest<Status>('/updates/status'));setError('');}catch{setError('暂时无法读取更新状态。升级期间服务可能重启，请稍后刷新。');}}
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[]);
 const task=status?.task;const running=!!task&&!['downloaded','completed','cancelled','failed','recovery_required'].includes(task.phase);
 async function check(){setBusy(true);setError('');try{setAvailable(await adminRequest('/updates/check',{method:'POST',body:{}}));}catch(e){setError(e instanceof Error?e.message:'检查失败');}finally{setBusy(false);}}
 async function run(action:'download'|'install',version:string){setBusy(true);setError('');setConfirm(false);try{await adminRequest('/updates/tasks',{method:'POST',body:{action,version,requestId:crypto.randomUUID()}});await refresh();}catch{setError('请求结果未确认，请刷新核对任务状态。');}finally{setBusy(false);}}
 const blocked=busy||running||task?.phase==='recovery_required';
 return <><div className="admin-heading"><h1>系统更新</h1><Button variant="secondary" onClick={()=>void refresh()}>刷新状态</Button></div>
 {error&&<p role="alert" className="afc-error">{error}</p>}
 <section className="admin-card"><h2>平台版本</h2><p>{status?.currentVersion??'—'}</p>{status?.configured===false?<p className="afc-muted">此部署尚未配置更新服务。</p>:<Button variant="primary" disabled={!status||!!blocked} onClick={()=>void check()}>检查更新</Button>}
 {available&&<div><p>{available.available?`可更新至 ${available.version}`:'当前已是最新版本'}</p><a href={available.url} target="_blank" rel="noreferrer">更新说明</a>{available.available&&<Button variant="secondary" disabled={!!blocked} onClick={()=>void run('download',available.version)}>下载更新</Button>}</div>}</section>
 {task&&<section className="admin-card"><h2>{task.version}</h2><p role="status">{phases[task.phase]??task.phase}</p>{task.error&&<p className="afc-muted">{task.error}</p>}{task.phase==='downloaded'&&<Button variant="primary" disabled={!!blocked} onClick={()=>setConfirm(true)}>安装更新</Button>}{task.phase==='recovery_required'&&<p>请在服务器核对备份、迁移和服务状态，勿重复安装。</p>}</section>}
 {confirm&&task&&<AdminDialog title={`安装 ${task.version}`} onClose={()=>setConfirm(false)}><p>将备份数据库并进入维护状态。请先停用业务应用，更新期间平台暂时不可用。</p><Button variant="primary" disabled={busy} onClick={()=>void run('install',task.version)}>确认备份并安装</Button></AdminDialog>}
 </>;
}
