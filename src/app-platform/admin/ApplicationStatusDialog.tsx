import {applicationStatus} from './application-status';
import React,{useEffect,useState} from 'react';
import {Button,PlatformIcon,SidebarDialog} from '../../components/ui';
import {adminRequest} from './client';
import type {Installation} from './AdminApp';
interface ProcessStatus {state:string;pid:number|null;startedAt:string|null;restarts:number;lastExit:{at:string;code:number|null;signal:string|null}|null;logs:string[]}
interface RuntimeStatus {installation:Installation;serving:boolean;process:ProcessStatus|null}
const processStates:Record<string,string>={starting:'启动中',running:'运行中',restarting:'异常退出，正在重启',stopped:'已停止',failed:'已停止（多次异常或启动失败）'};
export function ApplicationStatusDialog({appId,onClose,onChange}:{appId:string;onClose:()=>void;onChange:()=>void}){
 const [runtime,setRuntime]=useState<RuntimeStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[serial,setSerial]=useState(0);
 const [section,setSection]=useState<'runtime'|'logs'>('runtime');
 const path=`/apps/${encodeURIComponent(appId)}`;
 useEffect(()=>{const c=new AbortController();setError('');
  adminRequest<RuntimeStatus>(`${path}/runtime-status`,{signal:c.signal}).then(value=>{if(!c.signal.aborted)setRuntime(value);}).catch(e=>{if(!c.signal.aborted){setError(e instanceof Error?e.message:'读取失败');setRuntime(null);}});
  return()=>c.abort();
 },[path,serial]);
 async function restart(){if(busy||!runtime)return;setBusy(true);setError('');try{await adminRequest(`${path}/recover`,{method:'POST',body:{revision:runtime.installation.revision}});onChange();setSerial(v=>v+1);}catch(e){setError(e instanceof Error?e.message:'重新启动未成功');}finally{setBusy(false);}}
 const process=runtime?.process;
 return <SidebarDialog open title="应用状态" onClose={()=>{if(!busy)onClose();}} sections={[{id:'runtime' as const,label:'运行概况',icon:<PlatformIcon name="cog" size={18}/>,disabled:busy},{id:'logs' as const,label:'最近日志',icon:<PlatformIcon name="clock" size={18}/>,disabled:busy}]} activeSection={section} onSectionChange={setSection}>
  {error&&<p role="alert" className="afc-error">{error}</p>}
  {!runtime&&!error&&<p role="status">正在读取状态…</p>}
  {runtime&&section==='runtime'&&<>
   <dl className="afc-details"><dt>应用</dt><dd>{runtime.installation.manifest.name}</dd><dt>当前版本</dt><dd>{runtime.installation.manifest.version}</dd><dt>运行状态</dt><dd>{applicationStatus(runtime.installation,runtime.serving)}</dd>
    {process&&<><dt>后端进程</dt><dd>{processStates[process.state]??process.state}{process.startedAt?` · 启动于 ${new Date(process.startedAt).toLocaleString('zh-CN')}`:''}</dd><dt>自动重启</dt><dd>{process.restarts} 次</dd>{process.lastExit&&<><dt>上次退出</dt><dd>{new Date(process.lastExit.at).toLocaleString('zh-CN')} · {process.lastExit.signal??`退出码 ${process.lastExit.code}`}</dd></>}</>}
    <dt>平台能力</dt><dd>{runtime.installation.grants.filter(g=>g.status==='active'&&g.permissionCode.startsWith('platform.')).length} 项已批准</dd></dl>
   {runtime.installation.enabled&&!runtime.serving&&<><p className="afc-muted">应用未在运行，可查看最近日志后重新启动。</p><div className="admin-actions"><Button disabled={busy} onClick={()=>void restart()}>{busy?'正在启动…':'重新启动'}</Button></div></>}
  </>}
  {runtime&&section==='logs'&&(process?.logs.length?<pre className="app-process-logs">{process.logs.join('\n')}</pre>:<p className="afc-muted">暂无日志。</p>)}
 </SidebarDialog>;
}
