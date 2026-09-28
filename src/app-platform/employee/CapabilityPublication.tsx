import React,{useEffect,useState} from 'react';
import {Globe} from '@phosphor-icons/react';
import {Button,DataList,Dialog,TableActionButton} from '../../components/ui';
import {employeeRequest} from './client';

type Capability={apiId:string;description:string;mode:'read'|'write';enabled:boolean;revision:string|null};
type State={appId:string;version:string;capabilities:Capability[]};

export function CapabilityPublication({appId,name,onClose}:{appId:string;name:string;onClose:()=>void}){
 const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const path=`/apps/${encodeURIComponent(appId)}/capabilities`;
 async function reload(){setError('');try{setState(await employeeRequest<State>(path));}catch(e){setError(e instanceof Error?e.message:'读取开放状态失败。');}}
 useEffect(()=>{void reload();},[path]);
 async function toggle(cap:Capability){if(busy)return;setBusy(true);setError('');try{
  setState(await employeeRequest<State>(path,{method:'PUT',body:{apiId:cap.apiId,enabled:!cap.enabled,revision:cap.revision}}));
 }catch(e){setState(null);setError(e instanceof Error?e.message:'状态未确认，请重新读取后核对。');}finally{setBusy(false);}}
 return <Dialog open title={`${name} · 开放业务接口`} size="lg" onClose={()=>{if(!busy)onClose();}} footer={<Button variant="secondary" disabled={busy} onClick={onClose}>关闭</Button>}>
  <p className="afc-muted">仅能开放已由应用包声明并通过审核的业务接口。员工实际可操作的数据仍受该应用的角色和范围限制；应用更新后需要重新确认开放。</p>
  {error&&<p className="afc-error" role="alert">{error} <Button size="sm" variant="secondary" onClick={()=>void reload()}>重新读取</Button></p>}
  {!state&&!error&&<p role="status">正在读取接口…</p>}
  {state&&<DataList emptyState={!state.capabilities.length?'当前版本没有可开放的业务接口，请由开发者更新应用包。':undefined}><thead><tr><th>业务接口</th><th>类型</th><th>状态</th><th>操作</th></tr></thead><tbody>{state.capabilities.map(cap=><tr key={cap.apiId}><td><strong>{cap.description}</strong><br/><code>{appId}.{cap.apiId}</code></td><td>{cap.mode==='write'?'写入':'读取'}</td><td>{cap.enabled?'已开放':'未开放'}</td><td><TableActionButton icon={<Globe size={18}/>} disabled={busy} onClick={()=>void toggle(cap)}>{cap.enabled?'关闭':'开放'}</TableActionButton></td></tr>)}</tbody></DataList>}
 </Dialog>;
}
