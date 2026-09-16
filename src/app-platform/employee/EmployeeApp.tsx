import {createEmployeeApiBridge,type EmployeeApiRoute} from './api-bridge';
import React,{useEffect,useMemo,useState} from 'react';
import {Link,useLocation,useNavigate} from 'react-router-dom';
import {Button} from '../../components/ui';
import {AdminLogin} from '../admin/AdminLogin';
import '../admin/admin.css';
import {employeeRequest,EmployeeRequestError} from './client';
import {SandboxFrame,type SandboxFrameResource} from '../host/sandbox/react';
import type {SandboxJson} from '../host/sandbox/bridge';

type Account={id:string;personId:string;username:string};
type App={appId:string;name:string;description:string;version:string;routes:{path:string}[]};
type Resource={api:EmployeeApiRoute[];appId:string;name:string;instanceKey:string;admissionKey:string;resource:SandboxFrameResource};
function EmployeeApplication({account,path}:{account:Account;path:string}){
 const [current,setCurrent]=useState<Resource|null>(null),[error,setError]=useState(''),[serial,setSerial]=useState(0);
 const match=/^\/employee\/app\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(\/.*)?$/.exec(path),appId=match?.[1];
 useEffect(()=>{
  const controller=new AbortController();let active=true;setCurrent(null);setError('');let loading=false;
  async function load(){if(loading||!active)return;if(!appId){setError('应用不存在。');return;}loading=true;
   try{const value=await employeeRequest<Resource>(`/apps/${appId}/ui?path=${encodeURIComponent(match?.[2]??'/')}`,{signal:controller.signal});if(active){setError('');setCurrent(old=>old?.instanceKey===value.instanceKey?old:value);}}
   catch(e){if(active){setCurrent(null);setError(e instanceof Error?e.message:'应用不可用。');}}finally{loading=false;}
  }
  void load();const timer=setInterval(()=>void load(),5000);const focus=()=>void load();window.addEventListener('focus',focus);
  return()=>{active=false;controller.abort();clearInterval(timer);window.removeEventListener('focus',focus);};
 },[path,serial,account.id]);
 const operations=useMemo(()=>{
  const invoke=async(endpoint:string,body:unknown,signal:AbortSignal)=>{try{const response=await employeeRequest<{result:SandboxJson}>(`/apps/${appId}/${endpoint}`,{method:'POST',body,signal,admissionKey:current?.admissionKey});return response.result;}catch(e){if(e instanceof EmployeeRequestError&&(e.status===401||e.status===403)){setCurrent(null);setError(e.message);}throw e;}};
  const routes=createEmployeeApiBridge(current?.api??[],(request,signal)=>invoke('api',request,signal));
  for(const operation of ['platform.locations.get','platform.assets.get','platform.locations.list'])routes.set(operation,{
   validate:(params:SandboxJson)=>operation==='platform.locations.list'||!!params&&typeof params==='object'&&!Array.isArray(params)&&Object.keys(params).length===1&&typeof (params as {id?:unknown}).id==='string',
   authorize:async()=>true,
   execute:(params,signal)=>invoke('gateway',{version:'1.0',operation,params},signal),
  });
  return routes;
 },[appId,account.id,current]);
 return <section className="admin-card">{error?<><p className="afc-error" role="alert">{error}</p><Button variant="secondary" onClick={()=>setSerial(v=>v+1)}>重新打开</Button></>:current?<SandboxFrame key={`${account.id}:${current.instanceKey}`} appId={current.appId} instanceKey={`${account.id}:${current.instanceKey}`} resource={current.resource} operations={operations} enabled title={current.name}/>:<p role="status">正在加载应用…</p>}</section>;
}
export default function EmployeeApp(){
 const {pathname}=useLocation(),navigate=useNavigate();const [account,setAccount]=useState<Account|null>(null),[loading,setLoading]=useState(true),[apps,setApps]=useState<App[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;const expired=()=>{setAccount(null);setApps([]);};window.addEventListener('mop-employee-session-expired',expired);employeeRequest<Account>('/auth/me').then(v=>{if(active)setAccount(v);}).catch(e=>{if(active&&!(e instanceof EmployeeRequestError&&e.status===401))setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;window.removeEventListener('mop-employee-session-expired',expired);};},[]);
 useEffect(()=>{if(!account)return;let active=true;const c=new AbortController();let running=false;async function refresh(){if(running)return;running=true;try{const value=await employeeRequest<{applications:App[]}>('/apps',{signal:c.signal});if(active){setApps(value.applications);setError('');}}catch(e){if(active){setApps([]);setError(e instanceof Error?e.message:'读取失败');}}finally{running=false;}}void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{active=false;c.abort();clearInterval(timer);};},[account?.id]);
 async function logout(){if(busy)return;setBusy(true);try{await employeeRequest('/auth/logout',{method:'POST'});setAccount(null);setApps([]);navigate('/employee/login');}catch(e){setError(e instanceof Error?e.message:'退出失败');}finally{setBusy(false);}}
 if(loading)return <main className="afc-admin"><p role="status">正在检查员工会话…</p></main>;
 if(!account)return <><AdminLogin title="员工登录" onLogin={async(username,password)=>{setAccount(await employeeRequest<Account>('/auth/login',{method:'POST',body:{username,password}}));setError('');navigate('/employee');}}/><Link to="/admin/login">管理员登录</Link></>;
 return <div className="afc-admin afc-theme-neutral" data-theme="light"><main className="employee-workspace"><header className="admin-heading"><Link to="/employee">运管开放平台 · 我的应用</Link><div className="admin-actions"><span>{account.username}</span><Button variant="secondary" disabled={busy} onClick={()=>void logout()}>退出登录</Button></div></header>{error&&<p role="alert" className="afc-error">{error}</p>}{pathname.startsWith('/employee/app/')?<EmployeeApplication key={`${account.id}:${pathname}`} account={account} path={pathname}/>:<><h1>我的应用</h1><div className="admin-app-grid">{apps.map(a=><section className="admin-card" key={a.appId}><h2>{a.name}</h2><p>{a.description}</p><Link className="afc-button afc-button--secondary afc-button--md afc-button--pill" to={`/employee/app/${a.appId}${a.routes[0]?.path??'/'}`}>打开应用</Link></section>)}</div>{apps.length===0&&!error&&<p>暂无可用应用。</p>}</>}</main></div>;
}
