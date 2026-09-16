import React,{useEffect,useState} from 'react';
import {Button,Input,Select,Table,FilterBar,type FilterState} from '../../components/ui';
import {AdminDialog} from './AdminShell';
import {adminRequest} from './client';

type Account={id:string;personId:string;username:string;status:'active'|'disabled';personName:string;employeeNo:string;employmentStatus:string};
type Person={id:string;name:string;employeeNo:string;employmentStatus:string};
export function EmployeeAccounts(){
 const [search,setSearch]=useState(''),[filters,setFilters]=useState<FilterState>({selectedOptions:{}}),[page,setPage]=useState(1),[serial,setSerial]=useState(0);
 const [data,setData]=useState<{accounts:Account[];total:number}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [edit,setEdit]=useState<{account?:Account;action:'create'|'password'|'status'}|null>(null),[people,setPeople]=useState<Person[]>([]),[personSearch,setPersonSearch]=useState('');
 const [personId,setPersonId]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[failure,setFailure]=useState('');
 const status=filters.selectedOptions.status?.[0];
 useEffect(()=>{const c=new AbortController();setData(null);setError('');adminRequest<{accounts:Account[];total:number}>(`/employee-accounts?search=${encodeURIComponent(search)}&page=${page}&pageSize=20${status?`&status=${status}`:''}`,{signal:c.signal}).then(setData).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[search,status,page,serial]);
 useEffect(()=>{if(edit?.action!=='create')return;const c=new AbortController();setPeople([]);adminRequest<{records:Person[]}>(`/data/people?q=${encodeURIComponent(personSearch)}&status=active`,{signal:c.signal}).then(v=>setPeople(v.records)).catch(e=>{if(!c.signal.aborted)setFailure(e.message);});return()=>c.abort();},[edit,personSearch]);
 function open(value:NonNullable<typeof edit>){setEdit(value);setPersonId('');setPersonSearch('');setUsername('');setPassword('');setFailure('');}
 async function save(event:React.FormEvent){event.preventDefault();if(!edit||busy)return;setBusy(true);setFailure('');try{
  const body=edit.action==='create'?{personId,username,password}:edit.action==='password'?{password}:{status:edit.account!.status==='active'?'disabled':'active'};
  await adminRequest(`/employee-accounts${edit.account?`/${edit.account.id}`:''}`,{method:edit.action==='create'?'POST':'PATCH',body});setEdit(null);setPassword('');setSerial(v=>v+1);
 }catch(e){setFailure(e instanceof Error?e.message:'操作未确认，请刷新核对。');}finally{setBusy(false);}}
 return <><h1>员工账号</h1><FilterBar searchValue={search} onSearchChange={v=>{setSearch(v);setPage(1);}} searchPlaceholder="搜索姓名、工号或用户名" showDateRange={false} filterGroups={[{id:'status',title:'账号状态',isMulti:false,options:[{id:'active',label:'启用'},{id:'disabled',label:'停用'}]}]} activeFilters={filters} onApplyFilters={v=>{setFilters(v);setPage(1);}} onResetFilters={()=>{setFilters({selectedOptions:{}});setPage(1);}} rightAction={<Button onClick={()=>open({action:'create'})}>创建员工账号</Button>}/>
 {error&&<p role="alert" className="afc-error">{error}</p>}<Table variant="directory" emptyState={data?.accounts.length===0?'暂无员工账号':undefined}><thead><tr><th>姓名</th><th>工号</th><th>用户名</th><th>状态</th><th>操作</th></tr></thead><tbody>{data?.accounts.map(a=><tr key={a.id}><td>{a.personName}</td><td>{a.employeeNo}</td><td>{a.username}</td><td>{a.employmentStatus!=='active'?'已离职':a.status==='active'?'启用':'停用'}</td><td><div className="admin-actions"><Button variant="secondary" onClick={()=>open({account:a,action:'password'})}>重置密码</Button><Button variant="secondary" disabled={a.status==='disabled'&&a.employmentStatus!=='active'} onClick={()=>open({account:a,action:'status'})}>{a.status==='active'?'停用':'启用'}</Button></div></td></tr>)}</tbody></Table>
 {!data&&!error&&<p role="status">正在读取…</p>}<div className="admin-actions"><Button variant="secondary" disabled={page===1} onClick={()=>setPage(v=>v-1)}>上一页</Button><span>第 {page} 页 · 共 {data?.total??0} 项</span><Button variant="secondary" disabled={!data||page*20>=data.total} onClick={()=>setPage(v=>v+1)}>下一页</Button><Button variant="secondary" onClick={()=>setSerial(v=>v+1)}>刷新</Button></div>
 {edit&&<AdminDialog title={edit.action==='create'?'创建员工账号':`${edit.account!.personName} · ${edit.action==='password'?'重置密码':edit.account!.status==='active'?'停用账号':'启用账号'}`} onClose={()=>{if(!busy){setEdit(null);setPassword('');}}}><form className="admin-form" onSubmit={save}>
 {edit.action==='create'&&<><label>查找人员<Input value={personSearch} onChange={e=>setPersonSearch(e.target.value)} disabled={busy} placeholder="姓名或工号"/></label><label>关联人员<Select required value={personId} onChange={e=>setPersonId(e.target.value)} disabled={busy}><option value="">请选择在职人员</option>{people.map(p=><option key={p.id} value={p.id}>{p.name} · {p.employeeNo}</option>)}</Select></label><label>用户名<Input required minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,63}" value={username} onChange={e=>setUsername(e.target.value)} disabled={busy} autoComplete="off"/></label></>}
 {edit.action!=='status'?<label>新密码<Input required type="password" minLength={12} maxLength={72} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy} autoComplete="new-password"/></label>:null}
 {edit.action!=='create'&&<p>此操作将使已有登录会话失效。</p>}{failure&&<p className="afc-error" role="alert">{failure}</p>}<Button type="submit" disabled={busy}>{busy?'处理中…':'确认'}</Button></form></AdminDialog>}</>;
}
