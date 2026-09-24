import {Plus,ShieldSlash} from '@phosphor-icons/react';
import {AppOwner} from './AppOwner';
import {Alert,Badge,Button,PlatformIcon,SidebarDialog} from '../../components/ui';
import React, {useEffect, useState, type ReactNode} from 'react';
import {adminRequest} from './client';
import type {Installation} from './AdminApp';


const scopeLabels: Record<string, string> = {self:'本人', organization:'所在组织', organization_tree:'组织及下级', responsibility:'责任范围', explicit:'指定对象', all:'全部'};

// 平台网关能力随平台同仓发布，标签取自 platform_permissions 种子值；未知 code 回退显示原始代码。
const platformCapabilityLabels: Record<string, string> = {
 'platform.app_data.read':'读取应用自身数据',
 'platform.app_data.write':'写入应用自身数据',
 'platform.people.read':'读取工班成员',
 'platform.locations.read':'读取线路与车站目录',
 'platform.assets.read':'读取设备目录',
};
type Capability = {code:string;name:string};
function capabilityList(app:Installation):Capability[]{
 return app.manifest.permissions.requested.filter(code=>code.startsWith('platform.')).map(code=>({code,name:platformCapabilityLabels[code]??code}));
}

const modeLabel=(mode:string)=>mode==='service'?'应用服务身份':'当前使用者';
type Section='owner'|'grants';

export function AppGrantsDialog({appId, onClose, onChange}: {appId:string; onClose:()=>void; onChange:()=>void}) {
 const [app,setApp]=useState<Installation|null>(null), [error,setError]=useState(''), [busy,setBusy]=useState(false);
 const [panel,setPanel]=useState<string|null>(null), [panelMode,setPanelMode]=useState<'delegated_user'|'service'>('delegated_user');
 const [revoke,setRevoke]=useState<string|null>(null);
 const [section,setSection]=useState<Section>('grants');
 const path=`/apps/${encodeURIComponent(appId)}`;
 useEffect(()=>{
  const abort=new AbortController();setApp(null);setRevoke(null);setPanel(null);
  adminRequest<Installation>(path,{signal:abort.signal}).then(value=>{if(!abort.signal.aborted)setApp(value);}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'读取授权失败');});
  return()=>abort.abort();
 },[path]);
 async function save(change:{grantId?:string;permissionCode?:string;mode?:string;scope?:string}):Promise<boolean> {
  if(!app||busy)return false;
  setBusy(true);setError('');
  try {
   let current=app;
   if(!change.grantId&&change.mode==='service'&&!current.serviceIdentityId){
    current=await adminRequest<Installation>(`${path}/prepare-credential`,{method:'POST',body:{revision:current.revision}});
   }
   const updated=await adminRequest<Installation>(`${path}/grants${change.grantId?`/${encodeURIComponent(change.grantId)}`:''}`,{method:change.grantId?'DELETE':'POST',body:change.grantId?{revision:current.revision}:{revision:current.revision,permissionCode:change.permissionCode!,mode:change.mode!,...(change.mode==='service'?{serviceIdentityId:current.serviceIdentityId}:{}),scope:{kind:change.scope!,targets:[]}}});
   setApp(updated);setRevoke(null);setPanel(null);onChange();return true;
  } catch(e) {
   setError(e instanceof Error?e.message:'操作未确认完成，请刷新核对。');
   // Require an explicit reload and review before another mutation, including ambiguous network outcomes.
   setApp(null);setRevoke(null);setPanel(null);onChange();
   return false;
  } finally {setBusy(false);}
 }
 function openPanel(code:string){setError('');setRevoke(null);setPanel(code);setPanelMode(app?.manifest.backend.mode==='none'?'delegated_user':'service');}
 async function submitPanel(code:string){if(!app)return;await save({permissionCode:code,mode:panelMode,scope:'all'});}
 const sections:{id:Section;label:string;icon:ReactNode}[]=[
  {id:'owner',label:'应用负责人',icon:<PlatformIcon name="user" size={18}/>},

  {id:'grants',label:'平台能力',icon:<PlatformIcon name="lock" size={18}/>},
 ];
 const active=sections.some(item=>item.id===section)?section:'grants';
 function renderCard(cap:Capability){
  if(!app)return null;
  const grants=app.grants.filter(g=>g.permissionCode===cap.code&&g.status==='active');
  const replacing=panel===cap.code&&grants.some(g=>g.mode===panelMode);
  return <section className="afc-grant-card" key={cap.code}>
   <div className="afc-grant-card__head">
    <div className="afc-grant-card__title">
     <strong>{cap.name}</strong>
     <span className="afc-muted">{cap.code}</span>
    </div>
    <div className="afc-grant-card__meta">
     {grants.length===0?<Badge size="sm">未授权</Badge>:<Badge variant="success" size="sm" dot>已授权</Badge>}
     {grants.length===0&&<Button size="sm" leadingIcon={<Plus size={16}/>} disabled={busy} onClick={()=>openPanel(cap.code)}>授权</Button>}
    </div>
   </div>
   {grants.map(grant=><div className="afc-grant-row" key={grant.grantId}>
    <span>{modeLabel(grant.mode)}{grant.mode!=='service'&&` · ${scopeLabels[grant.scope.kind]??grant.scope.kind}`}{grant.scope.targets.map(target=><span key={`${target.type}:${target.id}`} className="afc-muted">（{target.type}: {target.id}）</span>)}</span>
    {revoke===grant.grantId
     ?<span className="afc-grant-confirm">确认撤销 {cap.name}？应用将无法继续使用这项授权。<Button size="sm" variant="secondary" disabled={busy} onClick={()=>setRevoke(null)}>取消</Button><Button size="sm" variant="secondary" disabled={busy} onClick={()=>void save({grantId:grant.grantId})}>确认撤销</Button></span>
     :<span className="afc-grant-row__actions">
       <Button size="sm" variant="secondary" leadingIcon={<ShieldSlash size={16}/>} disabled={busy} onClick={()=>setRevoke(grant.grantId)}>撤销</Button>
      </span>}
   </div>)}
   {panel===cap.code&&<div className="afc-grant-panel"><p>{modeLabel(panelMode)} · 平台能力范围：全部</p>
    {replacing&&<Alert variant="warning">保存后将替换该能力当前的「{modeLabel(panelMode)}」授权。</Alert>}
    {panelMode==='service'&&!app.serviceIdentityId&&app.enabled&&<Alert variant="warning">请先停用应用，再保存授权。</Alert>}
    <div className="afc-grant-panel__actions">
     <Button variant="primary" disabled={busy||panelMode==='service'&&!app.serviceIdentityId&&app.enabled} onClick={()=>void submitPanel(cap.code)}>{busy?'正在处理…':'保存授权'}</Button>
     <Button variant="secondary" disabled={busy} onClick={()=>setPanel(null)}>取消</Button>
    </div>
   </div>}
  </section>;
 }
 const capabilities=app?capabilityList(app):[];
 const platformCaps=capabilities;

 return <SidebarDialog open title="应用接入管理" onClose={()=>{if(!busy)onClose();}} navigationLabel="应用授权" sections={sections.map(item=>({...item,disabled:busy}))} activeSection={active} onSectionChange={setSection}>
    {error&&<p className="afc-error" role="alert">{error}</p>}
    <div hidden={active!=='owner'}><AppOwner appId={appId}/></div>

    <div hidden={active!=='grants'}>
     {!app&&!error&&<p role="status">正在读取授权…</p>}
     {app&&<>{capabilities.length===0&&<p className="afc-muted">该应用未声明任何能力，无需授权。</p>}
      {platformCaps.length>0&&<><h4 className="afc-grant-group-title">平台服务能力</h4><p className="afc-grant-group-desc afc-muted">应用调用平台提供的公共服务时所需的能力，业务操作与数据范围由应用负责人配置。</p><div className="afc-grant-list">{platformCaps.map(renderCard)}</div></>}

     </>}
    </div>
 </SidebarDialog>;
}
