import React,{useEffect,useState} from 'react';
import {Button,Input,Select} from '../../components/ui';
import {adminRequest} from './client';
export function AppOwner({appId,onMode,onSaved,onBusy}:{appId:string;onMode?:(mode:string)=>void;onSaved?:()=>void;onBusy?:(busy:boolean)=>void}){
 const [state,setState]=useState<{owner:{id:string;name:string}|null;revision:string|null;mode:string}|null>(null),[people,setPeople]=useState<{id:string;name:string;employeeNo:string}[]>([]),[search,setSearch]=useState(''),[person,setPerson]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const path=`/apps/${encodeURIComponent(appId)}/owner`;
 useEffect(()=>{const c=new AbortController();adminRequest<typeof state>(path,{signal:c.signal}).then(s=>{setState(s);if(s)onMode?.(s.mode);setPerson(s?.owner?.id??'');}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[path]);
 useEffect(()=>{const c=new AbortController();adminRequest<{records:typeof people}>(`/data/people?q=${encodeURIComponent(search)}&status=active`,{signal:c.signal}).then(v=>setPeople(v.records)).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[search]);
 return <section><h3>应用负责人</h3>{error&&<p role="alert" className="afc-error">{error}</p>}<form className="admin-form" onSubmit={async e=>{e.preventDefault();if(!state||busy)return;setBusy(true);onBusy?.(true);setError('');try{setState(await adminRequest(path,{method:'PUT',body:{personId:person||null,revision:state.revision}}));onSaved?.();}catch(e){setError((e as Error).message);}finally{setBusy(false);onBusy?.(false);}}}>
 <label>查找人员<Input value={search} placeholder="姓名或工号" onChange={e=>setSearch(e.target.value)}/></label><label>负责人<Select value={person} disabled={busy} onChange={e=>setPerson(e.target.value)}><option value="">未指定</option>{state?.owner&&!people.some(p=>p.id===state.owner!.id)&&<option value={state.owner.id}>{state.owner.name}</option>}{people.map(p=><option key={p.id} value={p.id}>{p.name} · {p.employeeNo}</option>)}</Select></label><Button type="submit" disabled={!state||busy||person===(state.owner?.id??'')}>{busy?'保存中…':'保存负责人'}</Button></form></section>;
}
