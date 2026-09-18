import {ShieldSlash} from '@phosphor-icons/react';
import {AppOwner} from './AppOwner';
import {Button,Select,DataList,PlatformIcon,TableActionButton} from '../../components/ui';
import React, {useEffect, useState, type ReactNode} from 'react';
import {AdminDialog} from './AdminShell';
import {adminRequest} from './client';
import type {Installation} from './AdminApp';
import {EmployeeAppAccess} from './EmployeeAppAccess';

const scopeLabels: Record<string, string> = {self:'本人', organization:'所在组织', organization_tree:'组织及下级', responsibility:'责任范围', explicit:'指定对象', all:'全部'};
type Section='owner'|'access'|'grants';

export function AppGrantsDialog({appId, onClose, onChange}: {appId:string; onClose:()=>void; onChange:()=>void}) {
 const [app,setApp]=useState<Installation|null>(null), [error,setError]=useState(''), [busy,setBusy]=useState(false);
 const [permission,setPermission]=useState(''), [scope,setScope]=useState('all'),[mode,setMode]=useState('delegated_user'), [revoke,setRevoke]=useState<string|null>(null);
 const [refresh,setRefresh]=useState(0),[authorizationMode,setAuthorizationMode]=useState<string|null>(null);
 const [section,setSection]=useState<Section>('grants');
 const path=`/apps/${encodeURIComponent(appId)}`;
 useEffect(()=>{
  const abort=new AbortController();setApp(null);setRevoke(null);
  adminRequest<Installation>(path,{signal:abort.signal}).then(value=>{if(!abort.signal.aborted){setApp(value);setPermission(value.manifest.permissions.requested[0]??value.manifest.permissions.defined[0]?.code??'');}}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'读取授权失败');});
  return()=>abort.abort();
 },[path,refresh]);
 async function save(grantId?:string) {
  if(!app||busy)return;
  setBusy(true);setError('');
  try {
   const updated=await adminRequest<Installation>(`${path}/grants${grantId?`/${encodeURIComponent(grantId)}`:''}`,{method:grantId?'DELETE':'POST',body:grantId?{revision:app.revision}:{revision:app.revision,permissionCode:permission,mode,...(mode==='service'?{serviceIdentityId:app.serviceIdentityId}:{}),scope:{kind:scope,targets:[]}}});
   setApp(updated);setRevoke(null);onChange();
  } catch(e) {
   setError(e instanceof Error?e.message:'操作未确认完成，请刷新核对。');
   // Require an explicit reload and review before another mutation, including ambiguous network outcomes.
   setApp(null);setRevoke(null);onChange();
  } finally {setBusy(false);}
 }
 async function prepare(){if(!app||busy)return;setBusy(true);try{setApp(await adminRequest<Installation>(`${path}/prepare-credential`,{method:'POST',body:{revision:app.revision}}));onChange();}catch(e){setError((e as Error).message);setApp(null);}finally{setBusy(false);}}
 const permissions=app?[...new Set([...app.manifest.permissions.requested,...app.manifest.permissions.defined.map(p=>p.code)])]:[];
 const sections:{id:Section;label:string;icon:ReactNode}[]=[
  {id:'owner',label:'应用负责人',icon:<PlatformIcon name="user" size={18}/>},
  ...(authorizationMode==='legacy'?[{id:'access' as Section,label:'员工使用范围',icon:<PlatformIcon name="users" size={18}/>}]:[]),
  {id:'grants',label:'能力授权',icon:<PlatformIcon name="lock" size={18}/>},
 ];
 const active=sections.some(item=>item.id===section)?section:'grants';
 const activeLabel=sections.find(item=>item.id===active)?.label??'';
 return <AdminDialog className="afc-profile-dialog afc-sidebar-dialog" title="应用授权" onClose={()=>{if(!busy)onClose();}}>
  <div className="afc-profile-layout">
   <nav className="afc-profile-nav" aria-label="应用授权">
    {sections.map(item=><Button key={item.id} variant="ghost" shape="rounded" disabled={busy} aria-current={active===item.id?'page':undefined} leadingIcon={item.icon} onClick={()=>setSection(item.id)}>{item.label}</Button>)}
   </nav>
   <section className="afc-profile-content" aria-label={activeLabel}>
    <h3 className="afc-profile-section-title">{activeLabel}</h3>
    {error&&<p className="afc-error" role="alert">{error}</p>}
    <div hidden={active!=='owner'}><AppOwner appId={appId} onMode={setAuthorizationMode}/></div>
    {authorizationMode==='legacy'&&<div hidden={active!=='access'}><EmployeeAppAccess appId={appId}/></div>}
    <div hidden={active!=='grants'}>
     <div className="app-toolbar-actions" style={{marginBottom:12}}>
      <Button size="sm" variant="secondary" disabled={busy} onClick={()=>{setError('');setRefresh(v=>v+1);}}>刷新授权</Button>
     </div>
     {!app&&!error&&<p role="status">正在读取授权…</p>}
     {app&&<><DataList emptyState={app.grants.length===0?"尚未授予能力":undefined}><thead><tr><th>能力 / 执行身份</th><th>范围</th><th>状态</th><th>操作</th></tr></thead><tbody>
      {app.grants.map(grant=><tr key={grant.grantId}><td>{grant.permissionCode}<br/>{grant.mode==='service'?'应用服务身份':'当前使用者'}</td><td>{scopeLabels[grant.scope.kind]??grant.scope.kind}{grant.scope.targets.map(target=><div key={`${target.type}:${target.id}`}>{target.type}: {target.id}</div>)}</td><td>{grant.status==='active'?'已授权':'已撤销'}</td><td>{grant.status==='active'&&<TableActionButton icon={<ShieldSlash size={18}/>} disabled={busy} onClick={()=>setRevoke(grant.grantId)}>撤销</TableActionButton>}</td></tr>)}
     </tbody></DataList>
     {revoke&&<div role="group" aria-label="确认撤销授权" style={{marginTop:20}}><p>确认撤销 {app.grants.find(g=>g.grantId===revoke)?.permissionCode}？应用将无法继续使用这项授权。</p><Button variant="secondary" disabled={busy} onClick={()=>setRevoke(null)}>取消</Button><Button variant="secondary" disabled={busy} onClick={()=>void save(revoke)}>确认撤销</Button></div>}
     <form className="admin-form" style={{marginTop:20}} onSubmit={e=>{e.preventDefault();void save();}}><h3>授予应用能力</h3><label>执行身份<Select value={mode} disabled={busy} onChange={e=>{setMode(e.target.value);setScope('all');}}><option value="delegated_user">当前使用者</option><option value="service">应用服务身份</option></Select></label>{mode==='service'&&!app.serviceIdentityId&&<Button type="button" variant="secondary" disabled={busy||app.enabled} onClick={()=>void prepare()}>准备服务身份（需停用应用）</Button>}<label>能力<Select required value={permission} disabled={busy} onChange={e=>setPermission(e.target.value)}>{permissions.map(code=><option key={code}>{code}</option>)}</Select></label><label>数据范围<Select value={scope} disabled={busy} onChange={e=>setScope(e.target.value)}>{(mode==='service'?['all']:['self','organization','organization_tree','responsibility','all']).map(kind=><option key={kind} value={kind}>{scopeLabels[kind]}</option>)}</Select></label><p className="afc-muted">同一能力的新授权将替换原有使用者授权。使用者自身权限仍须通过服务端检查。</p><Button variant="primary" type="submit" disabled={busy||!permission||!!revoke||mode==='service'&&!app.serviceIdentityId}>{busy?'正在处理…':'保存授权'}</Button></form></>}
    </div>
   </section>
  </div>
 </AdminDialog>;
}
