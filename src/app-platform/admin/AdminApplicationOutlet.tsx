import React,{useEffect,useState} from 'react';
import {Link,useLocation} from 'react-router-dom';
import {Button} from '../../components/ui';
import {SandboxFrame,type SandboxFrameResource} from '../host/sandbox/react';
import {adminRequest} from './client';

interface HostedApplication {appId:string;name:string;instanceKey:string;resource:SandboxFrameResource;}
const operations=new Map();

/** Administrator control-plane session admits the signed resource; it never impersonates an employee. */
export function AdminApplicationOutlet(){
 const {pathname}=useLocation();
 const [resource,setResource]=useState<{path:string;value:HostedApplication}|null>(null),[error,setError]=useState(''),[serial,setSerial]=useState(0);
 useEffect(()=>{
  let controller:AbortController|undefined;let active=true;
  const load=()=>{
   controller?.abort();controller=new AbortController();const signal=controller.signal;
   setResource(null);setError('');
   const match=/^\/admin\/app\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(\/.*)?$/.exec(pathname);
   if(!match){setError('应用页面不存在。');return;}
   adminRequest<HostedApplication>(`/apps/${match[1]}/ui?path=${encodeURIComponent(match[2]??'/')}`,{signal})
    .then(value=>{if(active&&!signal.aborted)setResource({path:pathname,value});})
    .catch(reason=>{if(active&&!signal.aborted)setError(reason instanceof Error?reason.message:'应用暂时无法打开。');});
  };
  const visible=()=>{if(document.visibilityState==='visible')load();};
  load();window.addEventListener('focus',load);document.addEventListener('visibilitychange',visible);
  return()=>{active=false;controller?.abort();window.removeEventListener('focus',load);document.removeEventListener('visibilitychange',visible);};
 },[pathname,serial]);
 const current=resource?.path===pathname?resource.value:null;
 return <section className="admin-card">{error?<><p className="afc-error" role="alert">{error}</p><div className="admin-actions"><Button variant="secondary" onClick={()=>setSerial(v=>v+1)}>重新打开</Button><Link to="/admin/apps">返回应用管理</Link></div></>:current?<SandboxFrame key={current.instanceKey} appId={current.appId} instanceKey={current.instanceKey} resource={current.resource} operations={operations} enabled title={current.name}/>:<p role="status">正在加载应用…</p>}</section>;
}
