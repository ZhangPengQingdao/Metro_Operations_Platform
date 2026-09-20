import {applicationStatus} from './application-status';
import {AppMigrationStatus} from './AppMigrationStatus';
import React,{useEffect,useState} from 'react';
import {Button,DataList,PlatformIcon} from '../../components/ui';
import {AdminDialog} from './AdminShell';
import {adminRequest,AdminRequestError} from './client';
import type {Installation} from './AdminApp';
interface RuntimeStatus {installation:Installation;owned:boolean;serving:boolean;pendingWork?:{records:{id:string;startedAt:string;context?:{kind:string;requestId?:string;apiId?:string}|null}[];hasMore:boolean}}
interface InstallStatus {state:string;revision:number;requestId:string;}
interface VersionStatus extends InstallStatus {version:string;}
const states:Record<string,string>={registered:'已注册',installing:'安装中',installed:'安装完成',recovery_required:'操作中断，待核对',recovering:'恢复中',recovered:'已恢复停用',prepared:'已准备',updating:'更新中',updated:'更新完成'};
export function ApplicationStatusDialog({appId,onClose,onChange}:{appId:string;onClose:()=>void;onChange:()=>void}){
 const [runtime,setRuntime]=useState<RuntimeStatus|null>(null),[install,setInstall]=useState<InstallStatus|null>(null),[versions,setVersions]=useState<VersionStatus[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[serial,setSerial]=useState(0),[loading,setLoading]=useState(true);
 const [section,setSection]=useState<'runtime'|'versions'|'calls'|'migrations'|'writes'>('runtime');
 const path=`/apps/${encodeURIComponent(appId)}`;
 useEffect(()=>{const c=new AbortController();setError('');setLoading(true);
  async function load(){try{
   const runtime=await adminRequest<RuntimeStatus>(`${path}/runtime-status`,{signal:c.signal});
   const install=await adminRequest<InstallStatus>(`${path}/install-status`,{signal:c.signal}).catch(e=>{if(e instanceof AdminRequestError&&e.status===404)return null;throw e;});
   const version=await adminRequest<{versions:VersionStatus[]}>(`${path}/version-status`,{signal:c.signal});
   if(!c.signal.aborted){setRuntime(runtime);setInstall(install);setVersions(version.versions);}
  }catch(e){if(!c.signal.aborted){setError(e instanceof Error?e.message:'读取失败');setRuntime(null);}}finally{if(!c.signal.aborted)setLoading(false);}}
  void load();return()=>c.abort();
 },[path,serial,section]);
 async function recover(endpoint:string,body:unknown){if(busy)return;setBusy(true);setError('');try{await adminRequest(`${path}/${endpoint}`,{method:'POST',body});onChange();setSerial(v=>v+1);}catch(e){setError(e instanceof Error?e.message:'恢复结果未确认');setRuntime(null);}finally{setBusy(false);}}
 const blocked=!!runtime?.pendingWork?.records.length;
 const pendingVersion=versions.find(v=>!['updated','recovered'].includes(v.state));
 const pendingInstall=install&&!['installed','recovered'].includes(install.state);
 const sections=[
  {id:'runtime' as const,label:'运行概况',icon:'cog' as const},
  {id:'versions' as const,label:'安装与更新',icon:'clock' as const},
  {id:'calls' as const,label:'未完成调用',icon:'clock' as const},
  ...(runtime?.installation.manifest.storage.mode==='managed'?[{id:'migrations' as const,label:'存储迁移',icon:'database' as const},{id:'writes' as const,label:'数据写入',icon:'database' as const}]:[]),
 ];
 return <AdminDialog className="afc-profile-dialog afc-sidebar-dialog" title="应用状态" onClose={()=>{if(!busy)onClose();}}>
  <div className="afc-profile-layout">
   <nav className="afc-profile-nav" aria-label="应用状态">
    {sections.map(item=><Button key={item.id} variant="ghost" shape="rounded" disabled={busy} aria-current={section===item.id?'page':undefined} leadingIcon={<PlatformIcon name={item.icon} size={18}/>} onClick={()=>setSection(item.id)}>{item.label}</Button>)}
   </nav>
   <section className="afc-profile-content" aria-label={sections.find(item=>item.id===section)?.label}>
    <h3 className="afc-profile-section-title">{sections.find(item=>item.id===section)?.label}</h3>
    {error&&<p role="alert" className="afc-error">{error}</p>}
    {!runtime&&!error&&<p role="status">正在读取状态…</p>}
    {runtime&&<>
     {section==='runtime'&&<>
      <dl className="afc-details"><dt>应用</dt><dd>{runtime.installation.manifest.name}</dd><dt>当前版本</dt><dd>{runtime.installation.manifest.version}</dd><dt>运行状态</dt><dd>{applicationStatus(runtime.installation,runtime.serving,blocked)}</dd><dt>平台能力</dt><dd>{runtime.installation.grants.filter(g=>g.status==='active'&&g.permissionCode.startsWith('platform.')).length} 项已批准</dd></dl>
      {blocked&&<p className="afc-error">存在未完成调用，请先在“未完成调用”中核对。</p>}
      {!runtime.serving&&(runtime.installation.enabled||runtime.installation.lifecycle?.status==='failed'||runtime.installation.lifecycle?.status==='running')&&<p className="afc-muted">上次操作或运行状态尚未确认。核对后安全停用，再重新启用；不会重放业务操作。</p>}
      <div className="admin-actions">
       {!pendingVersion&&!pendingInstall&&!runtime.serving&&(runtime.installation.enabled||runtime.installation.lifecycle?.status==='failed'||runtime.installation.lifecycle?.status==='running')&&<Button disabled={busy||loading||blocked} onClick={()=>void recover('recover',{revision:runtime.installation.revision})}>核对并停用</Button>}
      </div>
     </>}
     {section==='versions'&&<>
      <dl className="afc-details"><dt>首次安装</dt><dd>{install?(states[install.state]??install.state):'未找到安装记录'}</dd></dl>
      <DataList pinActions={false} emptyState={!versions.length?'暂无更新记录':undefined}><thead><tr><th>版本</th><th>状态</th></tr></thead><tbody>{versions.map(v=><tr key={v.requestId}><td>{v.version}</td><td>{states[v.state]??v.state}</td></tr>)}</tbody></DataList>
      <div className="admin-actions">{pendingVersion?<Button disabled={busy||loading||blocked} onClick={()=>void recover('version-recover',{requestId:pendingVersion.requestId})}>核对并停用</Button>:pendingInstall&&<Button disabled={busy||loading||blocked} onClick={()=>void recover('install-recover',{revision:install!.revision})}>核对并停用</Button>}</div>
     </>}
     {section==='calls'&&<>
      {blocked&&<p className="afc-error" role="alert">原调用缺少结束凭据，恢复和启用已阻断。不会自动重试或清除记录。</p>}
      <DataList pinActions={false} emptyState={!blocked?'暂无未完成调用':undefined}><thead><tr><th>开始时间</th><th>调用</th><th>核对编号</th></tr></thead><tbody>{runtime.pendingWork?.records.map(w=><tr key={w.id}><td>{new Date(w.startedAt).toLocaleString('zh-CN')}</td><td>{w.context?.apiId??'历史调用（未记录接口）'}</td><td>{w.id}</td></tr>)}</tbody></DataList>
      {runtime.pendingWork?.hasMore&&<p>仅显示前 100 条，仍有其他未完成调用。</p>}
     </>}
     {(section==='migrations'||section==='writes')&&<AppMigrationStatus key={section} kind={section} appId={appId} onBusy={setBusy} onChange={()=>{onChange();setSerial(v=>v+1);}}/>}
    </>}
   </section>
  </div>
 </AdminDialog>;
}
