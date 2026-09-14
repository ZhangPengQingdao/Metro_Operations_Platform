import React,{useEffect,useState} from 'react';
import {Button} from '../../components/ui';
import {AdminDialog} from './AdminShell';
import {adminRequest,AdminRequestError} from './client';
import type {Installation} from './AdminApp';
interface InstallStatus {state:string;revision:number;requestId:string;}
interface VersionStatus extends InstallStatus {version:string;}
const states:Record<string,string>={registered:'已注册',installing:'安装中',installed:'安装完成',recovery_required:'需要恢复',recovering:'恢复中',recovered:'已恢复停用',prepared:'已准备',updating:'更新中',updated:'更新完成'};
export function ApplicationStatusDialog({appId,onClose,onChange}:{appId:string;onClose:()=>void;onChange:()=>void}){
 const [runtime,setRuntime]=useState<{installation:Installation;owned:boolean;serving:boolean}|null>(null),[install,setInstall]=useState<InstallStatus|null>(null),[versions,setVersions]=useState<VersionStatus[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[serial,setSerial]=useState(0);
 const path=`/apps/${encodeURIComponent(appId)}`;
 useEffect(()=>{const c=new AbortController();setError('');setRuntime(null);setInstall(null);setVersions([]);
  async function load(){try{
   const runtime=await adminRequest<{installation:Installation;owned:boolean;serving:boolean}>(`${path}/runtime-status`,{signal:c.signal});
   const install=await adminRequest<InstallStatus>(`${path}/install-status`,{signal:c.signal}).catch(e=>{if(e instanceof AdminRequestError&&e.status===404)return null;throw e;});
   const version=await adminRequest<{versions:VersionStatus[]}>(`${path}/version-status`,{signal:c.signal});
   if(!c.signal.aborted){setRuntime(runtime);setInstall(install);setVersions(version.versions);}
  }catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:'读取失败');}}
  void load();return()=>c.abort();
 },[path,serial]);
 async function recover(endpoint:string,body:unknown){if(busy)return;setBusy(true);setError('');try{await adminRequest(`${path}/${endpoint}`,{method:'POST',body});onChange();setSerial(v=>v+1);}catch(e){setError(e instanceof Error?e.message:'恢复结果未确认');}finally{setBusy(false);}}
 const pendingVersion=versions.find(v=>!['updated','recovered'].includes(v.state));
 const pendingInstall=install&&!['installed','recovered'].includes(install.state);
 return <AdminDialog title="应用状态" onClose={()=>{if(!busy)onClose();}}>{error&&<p role="alert" className="afc-error">{error}</p>}{runtime?<><dl className="afc-details"><dt>当前版本</dt><dd>{runtime.installation.manifest.version}</dd><dt>运行状态</dt><dd>{runtime.serving?'正在运行':runtime.installation.enabled?'需要恢复运行状态':'已停用'}</dd><dt>安装记录</dt><dd>{install?(states[install.state]??install.state):'未找到'}</dd>{versions[0]&&<><dt>最近更新</dt><dd>{versions[0].version} · {states[versions[0].state]??versions[0].state}</dd></>}</dl><div className="admin-actions">{!runtime.installation.enabled&&runtime.installation.manifest.backend.mode==='isolated'&&!pendingVersion&&!pendingInstall&&<Button disabled={busy} onClick={()=>void recover('prepare-credential',{revision:runtime.installation.revision})}>重新准备运行身份</Button>}{pendingVersion?<Button disabled={busy} onClick={()=>void recover('version-recover',{requestId:pendingVersion.requestId})}>恢复为停用</Button>:pendingInstall?<Button disabled={busy} onClick={()=>void recover('install-recover',{revision:install!.revision})}>恢复为停用</Button>:(!runtime.serving&&(runtime.installation.enabled||runtime.installation.lifecycle?.status==='failed'||runtime.installation.lifecycle?.status==='running'))&&<Button disabled={busy} onClick={()=>void recover('recover',{revision:runtime.installation.revision})}>恢复为停用</Button>}</div></>:!error&&<p role="status">正在读取状态…</p>}<div className="admin-actions"><Button variant="secondary" disabled={busy} onClick={()=>setSerial(v=>v+1)}>重新核对</Button></div></AdminDialog>;
}
