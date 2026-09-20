import {applicationStatus} from './application-status';
import {RegistrationReview} from './RegistrationReview';
import {Pulse,ShieldCheck,UploadSimple,Pause,Play,Plus} from '@phosphor-icons/react';
import {ProfileSections} from '../identity/ProfileSections';
import {InstallPackageReview} from './InstallPackageReview';
import {PublisherPolicyDialog} from './PublisherPolicyDialog';
import {EmployeeAccounts} from './EmployeeAccounts';
import metadata from '../../../package.json';
import {Button,Input,DataList,TableActions,TableActionButton,TableHeader,TableBody,TableRow,TableHead,TableCell,FilterBar} from '../../components/ui';
import React,{useCallback,useEffect,useState} from 'react';
import {Link,Navigate,useLocation,useNavigate} from 'react-router-dom';
import type {AppManifest} from '@metro/platform-sdk/app-manifest';
import {AdminShell,AdminDialog,type AdminUser,type AdminApplication} from './AdminShell';
import {AdminLogin} from './AdminLogin';
import {adminRequest,AdminRequestError} from './client';
import {DataPage,AccountsPage,PasswordPanel} from './AdminPages';
import './admin.css';
import {AdminApplicationOutlet} from './AdminApplicationOutlet';
import {ApplicationStatusDialog} from './ApplicationStatusDialog';
import {AppGrantsDialog} from './AppGrantsDialog';
export interface Installation {serviceIdentityId?:string|null;id:string;appId:string;manifest:AppManifest;enabled:boolean;revision:number;grants:{grantId:string;permissionCode:string;mode:string;status:string;scope:{kind:string;targets:{type:string;id:string}[]}}[];lifecycle?:{action:string;status:string};}
function useRead<T>(path:string){const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[serial,setSerial]=useState(0);useEffect(()=>{const controller=new AbortController();setData(null);setError('');adminRequest<T>(path,{signal:controller.signal}).then(setData).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'读取失败');});return()=>controller.abort();},[path,serial]);return {data,error,reload:()=>setSerial(v=>v+1)};}
function ErrorNotice({error,reload}:{error:string;reload?:()=>void}){return <div className="afc-error" role="alert">{error}{reload&&<Button variant="secondary" onClick={reload}>重试读取</Button>}</div>;}
function Overview(){const {data,error,reload}=useRead<{installed:number;enabled:number;attention:number;runtimeConfigured:boolean;installConfigured:boolean}>('/overview');return <><h1>系统总览</h1>{error?<ErrorNotice error={error} reload={reload}/>:!data?<p role="status">正在读取平台状态…</p>:<><div className="admin-metrics">{[['已注册应用',data.installed],['已启用应用',data.enabled],['需核对的操作',data.attention]].map(([label,value])=><section className="admin-card" key={label}><span>{label}</span><strong>{value}</strong></section>)}</div><section className="admin-card"><h2>平台服务</h2><dl className="afc-details"><dt>平台版本</dt><dd>{metadata.version}</dd><dt>应用安装服务</dt><dd>{data.installConfigured?'已接入':'尚未配置'}</dd><dt>应用运行宿主</dt><dd>{data.runtimeConfigured?'已接入':'尚未配置'}</dd></dl></section></>}<section className="admin-card"><h2>快捷管理</h2><div className="admin-links"><Link to="/admin/apps">应用安装与更新 →</Link><Link to="/admin/data">人员、车站与设备 →</Link><Link to="/admin/accounts">管理员账号 →</Link></div></section></>;}
function RuntimeStatus({app}:{app:Installation}){
 const [runtime,setRuntime]=useState<{installation:Installation;serving:boolean;pendingWork?:{records:unknown[]}}|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{const c=new AbortController();setRuntime(null);setFailed(false);let pending=false;const load=async()=>{if(pending)return;pending=true;try{const result=await adminRequest<{installation:Installation;serving:boolean;pendingWork?:{records:unknown[]}}>(`/apps/${app.appId}/runtime-status`,{signal:c.signal});if(!c.signal.aborted){setRuntime(result);setFailed(false);}}catch{if(!c.signal.aborted)setFailed(true);}finally{pending=false;}};void load();const timer=setInterval(()=>void load(),5000);return()=>{c.abort();clearInterval(timer);};},[app.appId,app.revision]);
 return <span className="admin-status">{failed?'状态读取失败':!runtime?'检查中…':applicationStatus(runtime.installation,runtime.serving,!!runtime.pendingWork?.records.length)}</span>;
}
function AppsPage({onChange}:{onChange:()=>void}){
 const {data,error,reload}=useRead<{applications:Installation[];runtimeConfigured:boolean;installConfigured:boolean}>('/apps');
 const [search,setSearch]=useState('');
 const [selected,setSelected]=useState<{app:Installation;action:'enable'|'disable'|'upgrade'}|null>(null),[grantApp,setGrantApp]=useState<string|null>(null),[install,setInstall]=useState(false),[policyOpen,setPolicyOpen]=useState(false),[statusApp,setStatusApp]=useState<string|null>(null),[result,setResult]=useState(''),[busy,setBusy]=useState(false),[failure,setFailure]=useState('');
 async function run(){if(busy||!selected||selected.action==='upgrade')return;setBusy(true);setFailure('');try{
  await adminRequest(`/apps/${encodeURIComponent(selected.app.appId)}/lifecycle`,{method:'POST',body:{revision:selected.app.revision,action:selected.action}});
  setResult(selected.action==='enable'?'应用已启用。':'应用已停用。');setSelected(null);onChange();
 }catch(e){setFailure(e instanceof Error?e.message:'操作未确认，请核对状态。');}finally{setBusy(false);reload();}}

 return <><div className="admin-heading"><h1>应用管理</h1></div>

 {result&&<p role="status">{result}</p>}{error&&<ErrorNotice error={error} reload={reload}/>}{!data&&!error&&<p role="status">正在读取应用…</p>}
 {data&&<DataList toolbar={<FilterBar showDateRange={false} searchValue={search} onSearchChange={setSearch} searchPlaceholder="搜索应用名称" rightAction={<div className="app-toolbar-actions"><Button size="sm" variant="secondary" onClick={()=>setPolicyOpen(true)}>审核与发布</Button><Button size="sm" leadingIcon={<Plus size={18}/>} disabled={!data?.installConfigured} onClick={()=>{setInstall(true);setFailure('');setResult('');}}>安装应用</Button></div>}/>} emptyState={!data.applications.length?'尚未安装应用':undefined}><TableHeader><TableRow><TableHead>应用</TableHead><TableHead>版本</TableHead><TableHead>运行状态</TableHead><TableHead>平台能力</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{data.applications.filter(app=>`${app.manifest.name} ${app.appId}`.toLowerCase().includes(search.toLowerCase())).map(app=><TableRow key={app.id}><TableCell><div className="app-name-cell"><strong>{app.manifest.name}</strong><span className="afc-muted">{app.appId}</span></div></TableCell><TableCell>{app.manifest.version}</TableCell><TableCell><RuntimeStatus app={app}/></TableCell><TableCell>{app.grants.filter(g=>g.status==='active'&&g.permissionCode.startsWith('platform.')).length} 项</TableCell><TableCell><TableActions><TableActionButton icon={<Pulse size={18}/>} onClick={()=>setStatusApp(app.appId)}>状态</TableActionButton><TableActionButton icon={<ShieldCheck size={18}/>} onClick={()=>setGrantApp(app.appId)}>授权</TableActionButton><TableActionButton icon={<UploadSimple size={18}/>} disabled={!data.runtimeConfigured} onClick={()=>{setSelected({app,action:'upgrade'});setFailure('');}}>更新</TableActionButton><TableActionButton icon={app.enabled?<Pause size={18}/>:<Play size={18}/>} disabled={!data.runtimeConfigured} onClick={()=>{setSelected({app,action:app.enabled?'disable':'enable'});setFailure('');}}>{app.enabled?'停用':'启用'}</TableActionButton></TableActions></TableCell></TableRow>)}</TableBody></DataList>}

 {policyOpen&&<PublisherPolicyDialog installConfigured={!!data?.installConfigured} onClose={()=>{setPolicyOpen(false);reload();onChange();}}/>}
 {statusApp&&<ApplicationStatusDialog appId={statusApp} onClose={()=>setStatusApp(null)} onChange={()=>{reload();onChange();}}/>}
 {grantApp&&<AppGrantsDialog appId={grantApp} onClose={()=>setGrantApp(null)} onChange={()=>{reload();onChange();}}/>}
 {(install||selected?.action==='upgrade')?<InstallPackageReview target={selected?{appId:selected.app.appId,revision:selected.app.revision}:undefined} onClose={()=>{setSelected(null);setInstall(false);}} onBusy={setBusy} onDone={message=>{setResult(message);setSelected(null);setInstall(false);reload();onChange();}}/>:selected&&<AdminDialog title={`${selected.app.manifest.name} · ${selected.action==='enable'?'启用':'停用'}`} onClose={()=>{if(!busy)setSelected(null);}}><div className="admin-form"><p>确认执行此应用操作？</p>{failure&&<ErrorNotice error={failure}/>}<Button disabled={busy} onClick={()=>void run()}>{busy?'正在处理…':'确认'}</Button></div></AdminDialog>}

 </>;
}
function DeveloperPage(){const {data,error,reload}=useRead<{capabilities:{id:string;contractVersion:string;permissions:string[]}[]}>('/capabilities');return <><h1>开发者中心</h1><a className="afc-button afc-button--secondary afc-button--md afc-button--pill" href="https://github.com/ZhangPengQingdao/Metro_Operations_Platform/tree/main/docs" target="_blank" rel="noreferrer">查看 SDK 与接入文档</a>{error&&<ErrorNotice error={error} reload={reload}/>}<div className="admin-app-grid">{data?.capabilities.map(c=><section className="admin-card" key={c.id}><h2>{c.id}</h2><p>契约版本 {c.contractVersion}</p><p className="afc-muted">{c.permissions.join(' · ')||'由接入入口控制访问'}</p></section>)}</div></>;}
function NotificationsPanel(){const {data,error}=useRead<{notifications:{id:string;title:string;description:string;path:string}[]}>('/notifications');return <><FailureNotifications error={error}/>{data?.notifications.map(item=><section className="admin-card" key={item.id}><h3>{item.title}</h3><p>{item.description}</p><Link to="/admin/apps">查看应用</Link></section>)}{data?.notifications.length===0&&<p className="afc-muted">暂无需要处理的应用通知。</p>}</>;}
function FailureNotifications({error}:{error:string}){return error?<ErrorNotice error={error}/>:null;}
export default function AdminApp(){
 const location=useLocation(),navigate=useNavigate();const [user,setUser]=useState<AdminUser|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[applications,setApplications]=useState<AdminApplication[]>([]);
 useEffect(()=>{const expire=()=>{setUser(null);setApplications([]);};window.addEventListener('afc-admin-session-expired',expire);return()=>window.removeEventListener('afc-admin-session-expired',expire);},[]);
 const reloadApps=useCallback(()=>{adminRequest<{applications:Installation[]}>('/apps').then(({applications:rows})=>setApplications(rows.filter(a=>a.enabled&&a.manifest.ui.mode!=='none').map(a=>({id:a.appId,name:a.manifest.name,navigation:a.manifest.navigation.flatMap(n=>{const route=a.manifest.routes.find(r=>r.id===n.routeId);return route?[{id:n.id,label:n.label,path:`/admin/app/${a.appId}${route.path==='/'?'':route.path}`}]:[]})})))).catch(()=>setApplications([]));},[]);
 useEffect(()=>{let active=true;adminRequest<AdminUser>('/auth/me').then(value=>{if(active)setUser(value);}).catch(e=>{if(active&&!(e instanceof AdminRequestError&&e.status===401))setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
 useEffect(()=>{if(user)reloadApps();},[user,reloadApps]);
 async function logout(){await adminRequest('/auth/logout',{method:'POST'});setUser(null);setApplications([]);navigate('/login');}
 if(loading)return <div className="afc-admin"><p role="status">正在检查管理员会话…</p></div>;
 if(!user)return <Navigate to="/login" replace/>;
 if(location.pathname==='/admin/login'||location.pathname==='/admin/updates'||location.pathname==='/admin/audit')return <Navigate to="/admin" replace/>;
 const path=location.pathname;const content=path==='/admin'?<Overview/>:path==='/admin/apps'?<AppsPage onChange={reloadApps}/>:(path==='/admin/data'||path.startsWith('/admin/data/'))?<DataPage/>:path==='/admin/accounts/registrations'?<RegistrationReview/>:path==='/admin/accounts/employees'?<EmployeeAccounts/>:path==='/admin/accounts'?<AccountsPage/>:path==='/admin/developer'?<DeveloperPage/>:path.startsWith('/admin/app/')?<AdminApplicationOutlet/>:<section className="admin-card"><h1>页面不存在</h1><Link to="/admin">返回系统总览</Link></section>;
 return <AdminShell user={user} applications={applications} onLogout={logout} profileContent={<ProfileSections basic={<dl className="afc-details"><dt>账号</dt><dd>{user.username}</dd><dt>名称</dt><dd>{user.displayName}</dd></dl>} password={<PasswordPanel onChanged={()=>{setUser(null);navigate('/login');}}/>}/>} notificationsContent={<NotificationsPanel/>}>{content}</AdminShell>;
}
