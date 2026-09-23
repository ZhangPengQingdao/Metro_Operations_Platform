import type {AppManifest} from '@metro/platform-sdk/app-manifest';
import {ManagedApplications,type ManagedApplication} from './ManagedApplications';
import {ProfileSections} from '../identity/ProfileSections';
import {createEmployeeApiBridge,type EmployeeApiRoute} from './api-bridge';
import React,{useCallback,useEffect,useMemo,useState} from 'react';
import {Link,Navigate,useLocation,useNavigate} from 'react-router-dom';
import {Button,Input} from '../../components/ui';
import {AdminShell,type AdminApplication} from '../admin/AdminShell';
import '../admin/admin.css';
import {employeeRequest,EmployeeRequestError} from './client';
import {SandboxFrame,type SandboxFrameResource} from '../host/sandbox/react';
import type {SandboxJson} from '../host/sandbox/bridge';

type Account={id:string;personId:string;username:string;name?:string};
type App={appId:string;name:string;icon?:AppManifest['icon'];description:string;version:string;navigation:{id:string;routeId:string;label:string}[];routes:{id:string;path:string}[]};
type Resource={api:EmployeeApiRoute[];appId:string;name:string;instanceKey:string;admissionKey:string;resource:SandboxFrameResource};
function EmployeeApplication({account,path,onNavigation}:{account:Account;path:string;onNavigation:(appId:string,ids:string[])=>void}){
 const [current,setCurrent]=useState<Resource|null>(null),[error,setError]=useState(''),[serial,setSerial]=useState(0);
 const match=/^\/employee\/app\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(\/.*)?$/.exec(path),appId=match?.[1];
 useEffect(()=>{
  const controller=new AbortController();let active=true;setCurrent(null);setError('');let loading=false,admissionKey:string|null=null;
  async function load(){if(loading||!active)return;if(!appId){setError('应用不存在。');return;}loading=true;
   try{
    const route=encodeURIComponent(match?.[2]??'/');
    if(admissionKey){
     const check=await employeeRequest<{admissionKey:string}>(`/apps/${appId}/ui-admission?path=${route}`,{signal:controller.signal});
     if(check.admissionKey===admissionKey)return;
    }
    const value=await employeeRequest<Resource>(`/apps/${appId}/ui?path=${route}`,{signal:controller.signal});
    if(active){admissionKey=value.admissionKey;setError('');setCurrent(old=>old?.instanceKey===value.instanceKey?old:value);}
   }catch(e){if(active){admissionKey=null;setCurrent(null);setError(e instanceof Error?e.message:'应用不可用。');}}finally{loading=false;}
  }
  void load();const timer=setInterval(()=>void load(),5000);const focus=()=>void load();window.addEventListener('focus',focus);
  return()=>{active=false;controller.abort();clearInterval(timer);window.removeEventListener('focus',focus);};
 },[path,serial,account.id]);
 const operations=useMemo(()=>{
  const invoke=async(endpoint:string,body:unknown,signal:AbortSignal)=>{try{const response=await employeeRequest<{result:SandboxJson}>(`/apps/${appId}/${endpoint}`,{method:'POST',body,signal,admissionKey:current?.admissionKey});return response.result;}catch(e){if(e instanceof EmployeeRequestError&&(e.status===401||e.status===403)){setCurrent(null);setError(e.message);}throw e;}};
  const routes=createEmployeeApiBridge(current?.api??[],(request,signal)=>invoke('api',request,signal));
  for(const operation of ['platform.locations.get','platform.assets.get','platform.locations.list','platform.assets.list'])routes.set(operation,{
   validate:(params:SandboxJson)=>operation==='platform.locations.list'||operation==='platform.assets.list'||!!params&&typeof params==='object'&&!Array.isArray(params)&&Object.keys(params).length===1&&typeof (params as {id?:unknown}).id==='string',
   authorize:async()=>true,
   execute:(params,signal)=>invoke('gateway',{version:'1.0',operation,params},signal),
  });
  routes.set('platform.ui.navigation',{validate:params=>{if(!params||typeof params!=='object'||Array.isArray(params))return false;const ids=(params as {ids?:SandboxJson}).ids;return Array.isArray(ids)&&ids.length<=32&&ids.every((id:SandboxJson)=>typeof id==='string');},authorize:async()=>true,execute:async params=>{onNavigation(appId!, (params as {ids:string[]}).ids);return {ok:true};}});
  return routes;
 },[appId,account.id,current,onNavigation]);
 return <section className="employee-application">{error?<><p className="afc-error" role="alert">{error}</p><Button variant="secondary" onClick={()=>setSerial(v=>v+1)}>重新打开</Button></>:current?<SandboxFrame key={`${account.id}:${current.instanceKey}`} appId={current.appId} instanceKey={`${account.id}:${current.instanceKey}`} resource={current.resource} operations={operations} enabled title={current.name}/>:<p role="status">正在加载应用…</p>}</section>;
}
export default function EmployeeApp(){
 const [owned,setOwned]=useState<ManagedApplication[]>([]);
 const [menus,setMenus]=useState<Record<string,string[]>>({});
 const onNavigation=useCallback((appId:string,ids:string[])=>setMenus(old=>JSON.stringify(old[appId])===JSON.stringify(ids)?old:{...old,[appId]:ids}),[]);
 const {pathname}=useLocation(),navigate=useNavigate();const [account,setAccount]=useState<Account|null>(null),[loading,setLoading]=useState(true),[apps,setApps]=useState<App[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;const expired=()=>{setAccount(null);setApps([]);setOwned([]);};window.addEventListener('mop-employee-session-expired',expired);employeeRequest<Account>('/profile').then(v=>{if(active)setAccount(v);}).catch(e=>{if(active&&!(e instanceof EmployeeRequestError&&e.status===401))setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;window.removeEventListener('mop-employee-session-expired',expired);};},[]);
 useEffect(()=>{if(!account)return;let active=true;const c=new AbortController();let running=false;async function refresh(){if(running)return;running=true;try{const [value,managed]=await Promise.all([employeeRequest<{applications:App[]}>('/apps',{signal:c.signal}),employeeRequest<{applications:typeof owned}>('/managed-apps',{signal:c.signal})]);if(active){setOwned(managed.applications);setApps(value.applications);setError('');}}catch(e){if(active){setApps([]);setOwned([]);setError(e instanceof Error?e.message:'读取失败');}}finally{running=false;}}void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},30000);const focus=()=>void refresh();window.addEventListener('focus',focus);return()=>{active=false;c.abort();clearInterval(timer);window.removeEventListener('focus',focus);};},[account?.id]);
 async function logout(){if(busy)return;setBusy(true);try{await employeeRequest('/auth/logout',{method:'POST'});setAccount(null);setApps([]);setOwned([]);navigate('/login');}catch(e){setError(e instanceof Error?e.message:'退出失败');}finally{setBusy(false);}}
 if(loading)return <main className="afc-admin"><p role="status">正在检查员工会话…</p></main>;
 if(!account)return <Navigate to="/login" replace/>;
 const visibleApps=apps;
 const applications:AdminApplication[]=apps.map(app=>({id:app.appId,name:app.name,icon:app.icon,navigation:app.navigation.filter(item=>!menus[app.appId]||menus[app.appId].includes(item.id)).flatMap(item=>{const route=app.routes.find(r=>r.id===item.routeId);return route?[{id:item.id,label:item.label,path:`/employee/app/${app.appId}${route.path==='/'?'':route.path}`}]:[]})}));
 return <AdminShell mode="employee" user={{id:account.id,username:account.username,displayName:account.name??account.username}} applications={applications} onLogout={logout} profileContent={<EmployeeProfile/>} notificationsContent={<EmployeeMessages/>}>
 {error&&<p role="alert" className="afc-error">{error}</p>}
 {/^\/employee\/app\/[^/]+\/~management$/.test(pathname)?<Navigate replace to={`/employee/apps/${pathname.split('/')[3]}`}/>:pathname.startsWith('/employee/apps/')?<Navigate replace to="/employee/apps"/>:pathname==='/employee/apps'?<ManagedApplications applications={owned}/>:pathname.startsWith('/employee/app/')?<EmployeeApplication key={`${account.id}:${pathname}`} account={account} path={pathname} onNavigation={onNavigation}/>:pathname==='/employee/messages'?<><h1>消息</h1><EmployeeMessages/></>:<><div className="admin-heading"><h1>{pathname==='/employee/apps'?'应用管理':'工作台'}</h1></div>{pathname!=='/employee/apps'&&<h2>应用</h2>}<div className="employee-app-list">{visibleApps.map(app=><Link className="employee-app-link" key={app.appId} to={`/employee/app/${app.appId}${app.routes[0]?.path??'/~management'}`}><span className="employee-app-icon">{app.name.slice(0,1)}</span><span><strong>{app.name}</strong><span className="afc-muted">{app.description}</span></span><span aria-hidden>→</span></Link>)}</div>{!visibleApps.length&&!error&&<p className="afc-empty">暂无可用应用，请联系管理员分配应用权限。</p>}</>}
 </AdminShell>;
}
function EmployeeProfile(){
 const [profile,setProfile]=useState<Record<string,string>|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [currentPassword,setCurrent]=useState(''),[newPassword,setNew]=useState(''),[confirm,setConfirm]=useState('');
 useEffect(()=>{const c=new AbortController();employeeRequest<Record<string,string>>('/profile',{signal:c.signal}).then(setProfile).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[]);
 async function save(password:boolean){
  if(busy||!profile)return;setError('');setNotice('');
  if(password&&newPassword!==confirm){setError('两次输入的新密码不一致。');return;}
  setBusy(true);try{
   await employeeRequest(password?'/auth/password':'/profile',{method:'PATCH',body:password?{currentPassword,newPassword}:{phone:profile.phone??'',wecomUserId:profile.wecomUserId??''}});
   if(password){setCurrent('');setNew('');setConfirm('');window.dispatchEvent(new Event('mop-employee-session-expired'));}
   else setNotice('个人资料已保存。');
  }catch(e){setError(e instanceof Error?e.message:'保存未确认');}finally{setBusy(false);}
 }
 return <>{error&&<p role="alert" className="afc-error">{error}</p>}{notice&&<p role="status">{notice}</p>}{profile?<ProfileSections busy={busy} basic={<form className="admin-form" onSubmit={e=>{e.preventDefault();void save(false);}}>
 <div className="afc-details"><span>工号</span><span>{profile.employeeNo}</span><span>姓名</span><span>{profile.name}</span></div>
 <label>手机号<Input type="tel" maxLength={50} disabled={busy} value={profile.phone??''} onChange={e=>setProfile({...profile,phone:e.target.value})}/></label>
 <label>企业微信 UserID<Input maxLength={255} disabled={busy} value={profile.wecomUserId??''} onChange={e=>setProfile({...profile,wecomUserId:e.target.value})}/></label>
 <div className="afc-profile-actions"><Button type="submit" disabled={busy}>保存资料</Button></div></form>} password={
 <form className="admin-form" onSubmit={e=>{e.preventDefault();void save(true);}}>
 <label>当前密码<Input required type="password" autoComplete="current-password" disabled={busy} value={currentPassword} onChange={e=>setCurrent(e.target.value)}/></label>
 <label>新密码<Input required type="password" minLength={12} maxLength={72} autoComplete="new-password" disabled={busy} value={newPassword} onChange={e=>setNew(e.target.value)}/></label>
 <label>确认新密码<Input required type="password" minLength={12} maxLength={72} autoComplete="new-password" disabled={busy} value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>
 <p className="afc-muted">修改后需要重新登录，其他设备的登录也会失效。</p><div className="afc-profile-actions"><Button type="submit" disabled={busy}>修改密码</Button></div></form>}/>:!error&&<p role="status">正在读取个人资料…</p>}</>;
}
function EmployeeMessages(){
 const [messages,setMessages]=useState<{id:string;display:{title:string;body?:string;summary?:string};createdAt:string}[]|null>(null),[error,setError]=useState('');
 useEffect(()=>{const c=new AbortController();employeeRequest<{notifications:NonNullable<typeof messages>}>('/notifications',{signal:c.signal}).then(v=>setMessages(v.notifications)).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[]);
 return error?<p role="alert" className="afc-error">{error}</p>:messages?messages.length?<div className="employee-message-list">{messages.map(item=><article key={item.id}><h2>{item.display.title}</h2><p>{item.display.body??item.display.summary}</p><time className="afc-muted">{new Date(item.createdAt).toLocaleString()}</time></article>)}</div>:<p className="afc-empty">暂无消息</p>:<p role="status">正在读取消息…</p>;
}
