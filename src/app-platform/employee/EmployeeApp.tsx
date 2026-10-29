import {PasswordChangeRequired} from '../identity/PasswordChangeRequired';
import {PasswordInput,PasswordConfirmInput} from '../identity/PasswordInput';
import {NotificationList} from '../host/NotificationList';
import {isPasswordCompliant,PASSWORD_POLICY_MESSAGE} from '../identity/password-policy';
import type {ManagedApplication} from './ManagedApplications';
import {ProfileSections} from '../identity/ProfileSections';
import {lazy,Suspense,useCallback,useEffect,useState} from 'react';
import {Link,Navigate,useLocation,useNavigate} from 'react-router-dom';
import {Button,Input,IconButton,PlatformIcon} from '../../components/ui';
import {AdminShell,type AdminApplication} from '../admin/AdminShell';
import '../admin/admin.css';
import {employeeRequest,EmployeeRequestError} from './client';
import {readThemePreference} from '../identity/theme';
import {AppErrorBoundary,AppPageV2} from '../host/v2/AppPage';

const ChatPage=lazy(()=>import('./ChatPage').then(module=>({default:module.ChatPage})));
const EmployeeDashboard=lazy(()=>import('./EmployeeDashboard').then(module=>({default:module.EmployeeDashboard})));
const ManagedApplications=lazy(()=>import('./ManagedApplications').then(module=>({default:module.ManagedApplications})));

type Account={id:string;personId:string;username:string;name?:string;passwordChangeRequired?:boolean};
type App={dashboard?:{routeId:string};appId:string;name:string;description:string;version:string;runtimeRevision:number;v2:{sha256:string;color:string|null;pages:{path:string;title:string;permission?:string}[]};navigation:{id:string;routeId:string;label:string}[];routes:{id:string;path:string}[]};
export default function EmployeeApp(){
 const [dashboardBusy,setDashboardBusy]=useState(true);
 const [dashboardSettingsOpen,setDashboardSettingsOpen]=useState(false);
 const closeDashboardSettings=useCallback(()=>setDashboardSettingsOpen(false),[]);
 const [owned,setOwned]=useState<ManagedApplication[]>([]);
 const [sessionError,setSessionError]=useState(''),[sessionAttempt,setSessionAttempt]=useState(0);
 const [catalogError,setCatalogError]=useState(''),[managedError,setManagedError]=useState(''),[catalogAttempt,setCatalogAttempt]=useState(0);
 const {pathname,search,key:locationKey}=useLocation(),navigate=useNavigate();const [account,setAccount]=useState<Account|null>(null),[loading,setLoading]=useState(true),[apps,setApps]=useState<App[]>([]),[appsLoaded,setAppsLoaded]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[unreadNotifications,setUnreadNotifications]=useState(0);
 useEffect(()=>setDashboardSettingsOpen(false),[pathname]);
 const activeApp=pathname.startsWith('/employee/app/')&&!/^\/employee\/app\/[^/]+\/~management$/.test(pathname);
 const activeAppId=activeApp?pathname.split('/')[3]:null;
 const activeEntry=activeAppId?apps.find(app=>app.appId===activeAppId):undefined;
 const openAppPath=useCallback((path:string)=>{if(activeAppId)navigate(`/employee/app/${activeAppId}${path==='/'?'':path}`);},[activeAppId,navigate]);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setSessionError('');
  const expired=()=>{controller.abort();setLoading(false);setSessionError('');setAccount(null);setApps([]);setAppsLoaded(false);setOwned([]);};
  window.addEventListener('mop-employee-session-expired',expired);
  employeeRequest<Account>('/auth/me',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setAccount(value);})
   .catch(e=>{if(!controller.signal.aborted&&!(e instanceof EmployeeRequestError&&e.status===401))setSessionError(e instanceof Error?e.message:'登录状态暂时无法读取。');})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>{controller.abort();window.removeEventListener('mop-employee-session-expired',expired);};
 },[sessionAttempt]);
 useEffect(()=>{
  if(!account||account.passwordChangeRequired)return;
  const controller=new AbortController();
  // Each catalogue settles independently; optional management data must not block app entry.
  let appsRunning=false,managedRunning=false;
  async function refreshApps(){
   if(appsRunning||controller.signal.aborted)return;appsRunning=true;
   try{const value=await employeeRequest<{applications:App[]}>('/apps',{signal:controller.signal});if(!controller.signal.aborted){setApps(value.applications);setAppsLoaded(true);setCatalogError('');}}
   catch(e){if(!controller.signal.aborted){if(e instanceof EmployeeRequestError&&[401,403].includes(e.status)){setApps([]);setAppsLoaded(false);}setCatalogError(e instanceof Error?e.message:'应用列表暂时无法读取。');}}
   finally{appsRunning=false;}
  }
  async function refreshManaged(){
   if(managedRunning||controller.signal.aborted)return;managedRunning=true;
   try{const value=await employeeRequest<{applications:ManagedApplication[]}>('/managed-apps',{signal:controller.signal});if(!controller.signal.aborted){setOwned(value.applications);setManagedError('');}}
   catch(e){if(!controller.signal.aborted){if(e instanceof EmployeeRequestError&&[401,403].includes(e.status))setOwned([]);setManagedError(e instanceof Error?e.message:'应用管理列表暂时无法读取。');}}
   finally{managedRunning=false;}
  }
  const refresh=()=>{void refreshApps();void refreshManaged();},expired=()=>controller.abort();
  refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')refresh();},30000);
  window.addEventListener('focus',refresh);window.addEventListener('mop-employee-session-expired',expired);
  return()=>{controller.abort();clearInterval(timer);window.removeEventListener('focus',refresh);window.removeEventListener('mop-employee-session-expired',expired);};
 },[account?.id,account?.passwordChangeRequired,catalogAttempt]);
 useEffect(()=>{if(!account||account.passwordChangeRequired){setUnreadNotifications(0);return;}let active=true;let running=false;const controller=new AbortController();async function refresh(){if(running)return;running=true;try{const value=await employeeRequest<{notifications:{readAt?:string|null;readBehavior?:string;navigation?:{href?:string|null}|null}[]}>('/notifications',{signal:controller.signal});if(active)setUnreadNotifications(value.notifications.filter(item=>item.readBehavior==='state_bound'||!item.readAt).length);}catch(error){if(active&&!controller.signal.aborted)console.warn('读取通知失败',error);}finally{running=false;}}void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},30000);const focus=()=>void refresh();window.addEventListener('focus',focus);window.addEventListener('mop-notification-read',focus);return()=>{active=false;controller.abort();clearInterval(timer);window.removeEventListener('focus',focus);window.removeEventListener('mop-notification-read',focus);};},[account?.id]);
 async function logout(){if(busy)return;setBusy(true);try{await employeeRequest('/auth/logout',{method:'POST'});setAccount(null);setApps([]);setAppsLoaded(false);setOwned([]);navigate('/login');}catch(e){setError(e instanceof Error?e.message:'退出失败');}finally{setBusy(false);}}
 if(loading)return <main className="afc-admin afc-theme-neutral afc-auth-loading" data-theme={readThemePreference()}><p role="status">正在加载…</p></main>;
 if(sessionError)return <main className="afc-admin afc-theme-neutral afc-auth-loading" data-theme={readThemePreference()}><p role="alert">{sessionError}</p><Button onClick={()=>setSessionAttempt(value=>value+1)}>重试读取登录状态</Button></main>;
 if(!account)return <Navigate to="/login" state={{returnTo:pathname+search}} replace/>;
 if(account.passwordChangeRequired)return <PasswordChangeRequired kind="employee" onChanged={()=>{setAccount(null);setApps([]);navigate('/login',{replace:true});}}/>;
 const visibleApps=apps;
 const applications:AdminApplication[]=apps.map(app=>({id:app.appId,name:app.name,iconUrl:`/api/employee/apps/${app.appId}/icon`,color:app.v2.color,navigation:(app.navigation.length?app.navigation:app.routes.slice(0,1).map(route=>({id:route.id,routeId:route.id,label:app.name}))).flatMap(item=>{const route=app.routes.find(r=>r.id===item.routeId);return route?[{id:item.id,label:item.label,path:`/employee/app/${app.appId}${route.path==='/'?'':route.path}`}]:[]})}));
 return <AdminShell mode="employee" headerActions={(pathname==='/employee'||pathname==='/employee/')?<IconButton className="dashboard-settings-trigger" label="首页设置" title="首页设置" aria-haspopup="dialog" disabled={!appsLoaded||dashboardBusy||dashboardSettingsOpen} onClick={()=>setDashboardSettingsOpen(true)}><PlatformIcon name="cog" size={21}/></IconButton>:undefined} user={{id:account.id,username:account.username,displayName:account.name??account.username}} applications={applications} onLogout={logout} profileContent={(onSaved,onBusy)=><EmployeeProfile onSaved={onSaved} onBusy={onBusy}/>} notificationsContent={onNavigate=><EmployeeMessages onNavigate={onNavigate}/>} notificationCount={unreadNotifications}>
 {error&&<p role="alert" className="afc-error">{error}</p>}
 {(catalogError||(pathname==='/employee/apps'&&managedError))&&<div role="alert" className="afc-error">{catalogError||managedError}<Button variant="secondary" onClick={()=>setCatalogAttempt(value=>value+1)}>重试读取应用列表</Button></div>}
 <AppErrorBoundary key={pathname} onRetry={()=>window.location.reload()}><Suspense fallback={<p role="status">正在加载页面…</p>}>
 {/^\/employee\/app\/[^/]+\/~management$/.test(pathname)?<Navigate replace to={`/employee/apps/${pathname.split('/')[3]}`}/>:pathname.startsWith('/employee/apps/')?<Navigate replace to="/employee/apps"/>:pathname==='/employee/apps'?<ManagedApplications applications={owned}/>:pathname==='/employee/chat'||pathname.startsWith('/employee/chat/')?<ChatPage key={`${account.id}:${locationKey}`} name={account.name??account.username}/>:activeApp?null:pathname==='/employee/messages'?<><h1>消息</h1><EmployeeMessages/></>:<EmployeeDashboard key={account.id} apps={visibleApps} loaded={appsLoaded} onBusyChange={setDashboardBusy} settingsOpen={dashboardSettingsOpen} onSettingsClose={closeDashboardSettings}/>}
 </Suspense></AppErrorBoundary>
 {activeEntry&&<AppPageV2 key={`${account.id}:${activeEntry.appId}`} app={{appId:activeEntry.appId,name:activeEntry.name,runtimeRevision:activeEntry.runtimeRevision,v2:activeEntry.v2}} path={pathname.slice(`/employee/app/${activeEntry.appId}`.length)||'/'} onNavigate={openAppPath}/>}
 {activeAppId&&!activeEntry&&!catalogError&&<p role="status">{appsLoaded?'应用不可用或访问权限已变更。':'正在加载应用…'}</p>}
 </AdminShell>;
}
function EmployeeProfile({onSaved,onBusy}:{onSaved:()=>void;onBusy:(busy:boolean)=>void}){
 const [profile,setProfile]=useState<Record<string,string>|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [currentPassword,setCurrent]=useState(''),[newPassword,setNew]=useState(''),[confirm,setConfirm]=useState('');
 useEffect(()=>{const c=new AbortController();employeeRequest<Record<string,string>>('/profile',{signal:c.signal}).then(setProfile).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[]);
 async function save(password:boolean){
  if(busy||!profile)return;setError('');setNotice('');
  if(password&&!isPasswordCompliant(newPassword)){setError(PASSWORD_POLICY_MESSAGE);return;}
  if(password&&newPassword!==confirm){setError('两次输入的新密码不一致。');return;}
  setBusy(true);onBusy(true);try{
   await employeeRequest(password?'/auth/password':'/profile',{method:'PATCH',body:password?{currentPassword,newPassword}:{phone:profile.phone??'',wecomUserId:profile.wecomUserId??''}});
   if(password){setCurrent('');setNew('');setConfirm('');window.dispatchEvent(new Event('mop-employee-session-expired'));}
   else {setNotice('个人资料已保存。');onSaved();}
  }catch(e){setError(e instanceof Error?e.message:'保存未确认');}finally{setBusy(false);onBusy(false);}
 }
 return <>{error&&<p role="alert" className="afc-error">{error}</p>}{notice&&<p role="status">{notice}</p>}{profile?<ProfileSections busy={busy} basic={<form className="admin-form" onSubmit={e=>{e.preventDefault();void save(false);}}>
 <div className="afc-details"><span>工号</span><span>{profile.employeeNo}</span><span>姓名</span><span>{profile.name}</span></div>
 <label>手机号<Input type="tel" maxLength={50} disabled={busy} value={profile.phone??''} onChange={e=>setProfile({...profile,phone:e.target.value})}/></label>
 <label>企业微信 UserID<Input maxLength={255} disabled={busy} value={profile.wecomUserId??''} onChange={e=>setProfile({...profile,wecomUserId:e.target.value})}/></label>
 <div className="afc-profile-actions"><Button type="submit" loading={busy} disabled={busy}>{busy?'保存中…':'保存资料'}</Button></div></form>} password={
 <form className="admin-form" onSubmit={e=>{e.preventDefault();void save(true);}}>
 <label>当前密码<Input required type="password" autoComplete="current-password" disabled={busy} value={currentPassword} onChange={e=>setCurrent(e.target.value)}/></label>
 <label>新密码<PasswordInput required autoComplete="new-password" disabled={busy} value={newPassword} onChange={e=>setNew(e.target.value)}/></label>
 <label>确认新密码<PasswordConfirmInput required password={newPassword} disabled={busy} value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>
 <p className="afc-muted">修改后需重新登录。</p><div className="afc-profile-actions"><Button type="submit" disabled={busy}>修改密码</Button></div></form>}/>:!error&&<p role="status">正在读取个人资料…</p>}</>;
}
function safeNotificationHref(value:string|null|undefined){
 if(!value)return null;
 return /^\/employee\/app\/[a-z][a-z0-9-]*(?:\/[a-zA-Z0-9_-]+)*$/.test(value)?value:null;
}
function EmployeeMessages({onNavigate}:{onNavigate?:()=>void}={}){
 const [messages,setMessages]=useState<{id:string;display:{title:string;body?:string;summary?:string};navigation?:{href?:string|null}|null;createdAt:string;readAt?:string|null;readBehavior?:string}[]|null>(null),[error,setError]=useState(''),[reading,setReading]=useState('');
 useEffect(()=>{const c=new AbortController();employeeRequest<{notifications:NonNullable<typeof messages>}>('/notifications',{signal:c.signal}).then(v=>setMessages(v.notifications)).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[]);
 async function markRead(id:string){setReading(id);try{const result=await employeeRequest<{readAt:string}>(`/notifications/${id}/read`,{method:'POST'});setMessages(rows=>rows?.map(row=>row.id===id?{...row,readAt:result.readAt}:row)??null);window.dispatchEvent(new Event('mop-notification-read'));}catch(e){setError(e instanceof Error?e.message:'结果未确认，请重新打开消息核对');}finally{setReading('');}}
 const items=messages?.map(item=>{const href=safeNotificationHref(item.navigation?.href);return {id:item.id,href:href??undefined,title:item.display.title,body:item.display.body??item.display.summary,time:new Date(item.createdAt).toLocaleString('zh-CN',{hour12:false}),unread:item.readBehavior==='state_bound'||!item.readAt,
  actions:item.readBehavior==='mark_read'&&!item.readAt?<button type="button" className="afc-auth-link" disabled={!!reading} onClick={()=>void markRead(item.id)}>标为已读</button>:undefined};})??null;
 return <>{error&&<p role="alert" className="afc-error">{error}</p>}{!error&&<NotificationList items={items} onNavigate={onNavigate}/>}</>;
}
