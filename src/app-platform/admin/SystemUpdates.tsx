import React,{useEffect,useRef,useState} from 'react';
import {Button,ConfirmDialog} from '../../components/ui';
import {adminRequest,AdminRequestError} from './client';
type Task={applications?:{phase:string;total?:number;stopped?:number;restored?:number;unchanged?:number};id:string;action:string;version:string;phase:string;error:string|null;failedPhase?:string;pull?:{image:string;state:string;completed:number;total:number};download?:{receivedBytes:number;totalBytes:number}};
type Status={configured:boolean;automaticApplications?:boolean;currentVersion?:string;task?:Task|null};
const phases:Record<string,string>={queued:'等待处理',downloading:'下载更新包',verifying:'校验更新包',loading:'导入并校验镜像',verified:'校验通过，准备镜像',downloaded:'已就绪，等待安装',draining:'保存应用快照并暂停',restoring_apps:'恢复原先运行的应用',preflight:'升级预检',maintenance:'进入维护',backing_up:'正在备份',migrating:'数据库迁移',switching:'切换版本',health_check:'健康检查',completed:'更新完成',cancelled:'已恢复原版本',failed:'操作失败',recovery_required:'需要服务器核对'};
const bytes=(value:number)=>`${(value/1024/1024).toFixed(1)} MB`;
export function SystemUpdates(){
 const pendingRequest=useRef<string|null>(null);
 const [uncertain,setUncertain]=useState(false);
 const [status,setStatus]=useState<Status|null>(null),[available,setAvailable]=useState<{version:string;available:boolean;url:string}|null>(null),[error,setError]=useState(''),[connectionError,setConnectionError]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false);
 async function refresh(){try{const next=await adminRequest<Status>('/updates/status');setStatus(next);setConnectionError('');if(pendingRequest.current&&next.task?.id===pendingRequest.current){pendingRequest.current=null;setUncertain(false);setError('');setConfirm(false);}}catch{setConnectionError('暂时无法读取更新状态。升级期间服务可能重启，正在自动重新连接。');}}
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),2000);return()=>clearInterval(timer);},[]);
 const task=status?.task;const running=!!task&&!['downloaded','completed','cancelled','failed','recovery_required'].includes(task.phase);
 async function check(){setBusy(true);setError('');try{setAvailable(await adminRequest('/updates/check',{method:'POST',body:{}}));}catch(e){setError(e instanceof Error?e.message:'检查失败');}finally{setBusy(false);}}
 async function run(action:'download'|'install',version:string){
  if(pendingRequest.current)return;
  const requestId=crypto.randomUUID();pendingRequest.current=requestId;setBusy(true);setError('');
  try{const accepted=await adminRequest<Task>('/updates/tasks',{method:'POST',body:{action,version,requestId}});setStatus(previous=>({...previous,configured:true,task:accepted}));pendingRequest.current=null;setConfirm(false);}
  catch(cause){if(pendingRequest.current!==requestId)return;if(cause instanceof AdminRequestError&&[400,401,403,409].includes(cause.status)){pendingRequest.current=null;setError(cause.status===409?'更新请求未被接受，请关闭弹窗并核对最新任务状态。':cause.message);await refresh();return;}setUncertain(true);setError('请求结果未确认，正在自动核对任务状态，请勿重复提交。');await refresh();}
  finally{setBusy(false);}
 }
 const blocked=busy||uncertain||running||task?.phase==='recovery_required'||!!connectionError;
 const progress=task?.download;
 const percent=progress&&progress.totalBytes>0?Math.min(100,Math.max(0,progress.receivedBytes/progress.totalBytes*100)):undefined;
 const ready=task?.phase==='downloaded'&&task.version===available?.version;
 return <div className="system-updates">
 {(error||connectionError)&&<p role="alert" className="afc-error">{error||connectionError}</p>}
 <section className="admin-card">
  <div className="system-update-heading"><div><h2>平台版本</h2><p className="system-update-version">{status?.currentVersion??'—'}</p></div>
  {status?.configured!==false&&<Button variant="secondary" disabled={!status||!!blocked} onClick={()=>void check()}>{busy?'处理中…':'检查更新'}</Button>}</div>
  <p className="afc-muted">先下载并校验更新包，确认安装后才会进入维护、备份和升级。</p>
  {status?.configured===false&&<p className="afc-muted">此部署尚未配置更新服务。</p>}
  {available&&<div className="system-update-available"><div><strong>{available.available?`发现新版本 ${available.version}`:'当前已是最新版本'}</strong><p><a href={available.url} target="_blank" rel="noreferrer">查看更新说明 ↗</a></p></div>
   {available.available&&!ready&&<Button variant="primary" disabled={!!blocked} onClick={()=>void run('download',available.version)}>下载更新</Button>}</div>}
 </section>
 {task&&<section className="admin-card">
  <div className="system-update-heading"><h2>更新至 {task.version}</h2><span className="admin-status" role="status">{phases[task.phase]??task.phase}</span></div>
  {task.applications&&<p role="status">应用运行快照：{task.applications.phase==='unknown'?'暂时无法核对，请勿重复安装':`共 ${task.applications.total} 个应用，已暂停 ${task.applications.stopped} 个，已恢复 ${task.applications.restored} 个，原先停用 ${task.applications.unchanged} 个。`}</p>}
  {task.phase==='queued'&&<p role="status">{task.action==='install'?'安装请求已受理，正在等待升级预检。':'下载请求已受理，正在等待处理。'}</p>}
  {task.pull&&task.phase==='downloading'&&<p role="status">正在准备镜像 {task.pull.image}：{task.pull.state==='cached'?'复用本机镜像':task.pull.state==='downloaded'?'已下载':'拉取缺失镜像层'}（{task.pull.completed}/{task.pull.total}）</p>}
  {task.phase==='downloading'&&!task.pull&&<div className="system-update-progress"><div><span>{percent===undefined?'正在获取更新包…':`${bytes(progress!.receivedBytes)} / ${bytes(progress!.totalBytes)}`}</span><strong>{percent===undefined?'下载中':`${percent.toFixed(0)}%`}</strong></div><progress aria-label="更新包下载进度" max={100} value={percent}/><p className="afc-muted">下载完成后还需校验文件并导入镜像，请保持耐心。</p></div>}
  {['verified','verifying','loading'].includes(task.phase)&&<p className="afc-muted">更新包已下载，正在校验内容或导入 Docker 镜像；此步骤可能需要几分钟。</p>}
  {task.failedPhase&&<p>失败阶段：{phases[task.failedPhase]??task.failedPhase}</p>}
  {task.error&&<div className="system-update-error" role="alert"><strong>更新未完成</strong><p>{task.error==='COMMAND_FAILED'?'服务器命令执行失败。请核对宿主更新器日志；此错误码未提供具体失败原因。':task.error}</p>{task.error==='COMMAND_FAILED'&&<p>错误代码：COMMAND_FAILED</p>}{task.failedPhase==='preflight'&&<p>升级预检未通过，尚未进入维护、数据库备份或迁移。请先确认业务应用已停用，并由管理员核对未完成工作及服务器状态。</p>}{(/IMAGE_|image.*inspect/.test(task.error))&&<p>镜像包与本机 Docker 镜像标识可能不兼容，请核对发行包和宿主更新器版本。</p>}</div>}
  {task.phase==='downloaded'&&<div className="admin-actions"><Button variant="primary" disabled={!!blocked} onClick={()=>setConfirm(true)}>安装更新</Button><span className="afc-muted">安装期间平台暂时不可用。</span></div>}
  {task.phase==='recovery_required'&&<p>请在服务器核对备份、迁移和服务状态，勿重复安装。</p>}
  <p className="system-update-task afc-muted">任务编号：{task.id}</p>
 </section>}
 <ConfirmDialog isOpen={confirm&&!!task} onClose={()=>setConfirm(false)} onConfirm={()=>{if(task)void run('install',task.version);}} title={`安装 ${task?.version??''}`} message={<><p>{status?.automaticApplications?'将保存应用运行快照，暂停应用并备份数据库。升级完成后恢复此前正常运行的应用，原先停用的应用保持停用。':'当前平台版本尚不支持自动暂停应用，请先停用业务应用。本次升级将备份数据库，期间平台暂时不可用。'}</p>{(busy||uncertain)&&<p role="status">{busy?'正在提交安装请求，请稍候…':'正在核对请求结果，请勿重复提交。'}</p>}{error&&<p role="alert" className="afc-error">{error}</p>}</>} confirmText={busy?'正在提交…':uncertain?'正在核对…':'确认备份并安装'} loading={busy||uncertain}/>
 </div>;
}
