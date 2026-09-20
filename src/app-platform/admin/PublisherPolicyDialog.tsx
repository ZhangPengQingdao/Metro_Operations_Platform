import {AppSubmissions} from '../submissions/AppSubmissions';
import {ShieldCheck,ShieldSlash,Plus} from '@phosphor-icons/react';
import React,{useEffect,useState,type ReactNode} from 'react';
import {Button,Input,DataList,PlatformIcon,TableActionButton} from '../../components/ui';
import {AdminDialog} from './AdminShell';
import {adminRequest} from './client';
type Key={keyId:string;publisherId:string;publicKeyPem:string;revoked:boolean;appIds:string[];validFrom:string;validUntil:string};
type Policy={revision:number;policy:{keys:Key[]};approvedManifestDigests:string[]};
type Section='submissions'|'keys'|'versions';
const SECTIONS:{id:Section;label:string;icon:ReactNode}[]=[
 {id:'submissions',label:'申请审核',icon:<ShieldCheck size={18}/>},
 {id:'keys',label:'已登记密钥',icon:<PlatformIcon name="lock" size={18}/>},
 {id:'versions',label:'已批准版本',icon:<PlatformIcon name="cube" size={18}/>},
];
export function PublisherPolicyDialog({onClose,installConfigured=true}:{onClose:()=>void;installConfigured?:boolean}){
 const [section,setSection]=useState<Section>('submissions');
 const [data,setData]=useState<Policy|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [reviewBusy,setReviewBusy]=useState(false);
 const blocked=busy||reviewBusy;
 const [formOpen,setFormOpen]=useState(false);
 const [publisher,setPublisher]=useState(''),[keyId,setKeyId]=useState(''),[pem,setPem]=useState(''),[apps,setApps]=useState(''),[until,setUntil]=useState('');
 useEffect(()=>{if(section==='submissions'||!installConfigured)return;const c=new AbortController();setData(null);setError('');adminRequest<Policy>('/publisher-policy',{signal:c.signal}).then(v=>{if(!c.signal.aborted)setData(v);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[section,installConfigured]);
 async function save(keys:Key[]):Promise<boolean>{if(!data||busy)return false;setBusy(true);setError('');try{setData(await adminRequest<Policy>('/publisher-policy',{method:'PUT',body:{revision:data.revision,keys}}));setPem('');return true;}catch(e){setData(null);setError(e instanceof Error?e.message:'操作未确认，请刷新核对');return false;}finally{setBusy(false);}}
 async function revoke(digest:string){if(!data||busy)return;setBusy(true);setError('');try{setData(await adminRequest<Policy>('/version-approval/revoke',{method:'POST',body:{revision:data.revision,digest}}));}catch(e){setData(null);setError(e instanceof Error?e.message:'操作未确认');}finally{setBusy(false);}}
 async function submit(event:React.FormEvent){event.preventDefault();if(!data)return;
  const added=await save([...data.policy.keys,{publisherId:publisher,keyId,publicKeyPem:pem.trim(),appIds:apps.split(',').map(v=>v.trim()).filter(Boolean),revoked:false,validFrom:new Date().toISOString(),validUntil:new Date(until).toISOString()}]);
  if(added){setFormOpen(false);setPublisher('');setKeyId('');setApps('');setUntil('');}}
 const label=(text:string,node:ReactNode)=><label>{text}{node}</label>;
 return <AdminDialog className="afc-profile-dialog afc-sidebar-dialog" title="审核与发布" onClose={()=>{if(!blocked)onClose();}}>
  <div className="afc-profile-layout">
   <nav className="afc-profile-nav" aria-label="审核与发布">
    {SECTIONS.map(item=><Button key={item.id} variant="ghost" shape="rounded" disabled={blocked||(!installConfigured&&item.id!=='submissions')} aria-current={section===item.id?'page':undefined} leadingIcon={item.icon} onClick={()=>setSection(item.id)}>{item.label}</Button>)}
   </nav>
   <section className="afc-profile-content" aria-label={SECTIONS.find(item=>item.id===section)?.label}>
    <h3 className="afc-profile-section-title">{section==='submissions'?'上架与更新审核':SECTIONS.find(item=>item.id===section)?.label}</h3>
    {section==='submissions'&&<AppSubmissions admin embedded onClose={onClose} onBusyChange={setReviewBusy}/>}
    {section!=='submissions'&&error&&<p role="alert" className="afc-error">{error}</p>}
    <div hidden={section!=='keys'}>
     <div className="app-toolbar-actions" style={{marginBottom:12}}>

      <Button size="sm" variant="secondary" leadingIcon={<Plus size={16}/>} disabled={busy} onClick={()=>setFormOpen(value=>!value)}>{formOpen?'收起表单':'新增公钥'}</Button>
     </div>
     {data&&<DataList><thead><tr><th>发布者 / 密钥</th><th>应用范围</th><th>有效期</th><th>操作</th></tr></thead><tbody>{data.policy.keys.map((k,i)=><tr key={`${k.publisherId}/${k.keyId}`}><td>{k.publisherId} / {k.keyId}{k.revoked?'（已撤销）':''}</td><td>{k.appIds.join('、')}</td><td>{k.validUntil}</td><td><TableActionButton icon={k.revoked?<ShieldCheck size={18}/>:<ShieldSlash size={18}/>} disabled={busy} onClick={()=>void save(data.policy.keys.map((v,index)=>index===i?{...v,revoked:!v.revoked}:v))}>{k.revoked?'恢复信任':'撤销信任'}</TableActionButton></td></tr>)}</tbody></DataList>}
     {formOpen&&<form className="admin-form" style={{marginTop:20}} onSubmit={e=>{void submit(e);}}>
      <h3>新增发布者公钥</h3>
      {label('发布者 ID',<Input required value={publisher} onChange={e=>setPublisher(e.target.value)} disabled={busy}/>)}
      {label('密钥 ID',<Input required value={keyId} onChange={e=>setKeyId(e.target.value)} disabled={busy}/>)}
      {label('允许的应用 ID',<Input required value={apps} placeholder="多个 ID 用英文逗号分隔" onChange={e=>setApps(e.target.value)} disabled={busy}/>)}
      {label('有效期至',<Input required type="datetime-local" value={until} onChange={e=>setUntil(e.target.value)} disabled={busy}/>)}
      {label('Ed25519 公钥（PEM）',<textarea required rows={4} value={pem} onChange={e=>setPem(e.target.value)} disabled={busy}/>)}
      <Button disabled={busy||!data} type="submit">保存公钥信任</Button>
     </form>}
    </div>
    <div hidden={section!=='versions'}>
     {data?.approvedManifestDigests.length
      ?data.approvedManifestDigests.map(d=><div className="admin-actions" key={d}><code style={{overflowWrap:'anywhere'}}>{d}</code><Button variant="secondary" disabled={busy} onClick={()=>void revoke(d)}>撤销审批</Button></div>)
      :<p className="afc-muted">暂无已批准的版本摘要。安装应用并批准后会在这里登记。</p>}
    </div>
   </section>
  </div>
 </AdminDialog>;
}
