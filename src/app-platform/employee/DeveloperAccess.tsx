import {useEffect,useRef,useState} from 'react';
import {Button,Input,Select,Textarea,Dialog,Table,TableActionButton,Badge} from '../../components/ui';
import type {AppApiDocumentation} from '@metro/platform-sdk/app-api-documentation';
import {employeeRequest} from './client';
const print=(value:unknown)=>JSON.stringify(value,null,2);
const message=(e:unknown)=>e instanceof Error?e.message:'读取失败，请重试。';
const date=(value:string)=>new Date(value).toLocaleString('zh-CN');
function Json({value}:{value:unknown}){return <pre className="developer-code"><code>{print(value)}</code></pre>;}
function download(name:string,value:unknown){const url=URL.createObjectURL(new Blob([print(value)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

type Key={id:string;name:string;prefix:string;scopes:string[];createdAt:string;expiresAt:string|null;revokedAt:string|null};
export function DeveloperKeys(){
 const pending=useRef<{signature:string;requestId:string}|null>(null);
 const [keys,setKeys]=useState<Key[]>([]),[name,setName]=useState('本地开发'),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[formError,setFormError]=useState(''),[notice,setNotice]=useState(''),[attempt,setAttempt]=useState(0),[loading,setLoading]=useState(true),[open,setOpen]=useState(false);
 useEffect(()=>{const c=new AbortController();setLoading(true);setError('');employeeRequest<{keys:Key[]}>('/developer/keys',{signal:c.signal}).then(v=>{if(!c.signal.aborted)setKeys(v.keys);}).catch(e=>{if(!c.signal.aborted)setError(message(e));}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>c.abort();},[attempt]);
 function close(){if(busy)return;setOpen(false);setToken('');setFormError('');}
 async function create(){
  setBusy(true);setFormError('');setNotice('');
  try{
   const fields={name},signature=print(fields);if(pending.current?.signature!==signature)pending.current={signature,requestId:crypto.randomUUID()};
   const v=await employeeRequest<{token:string|null}>('/developer/keys',{method:'POST',body:{requestId:pending.current.requestId,...fields}});
   pending.current=null;setToken(v.token??'');setAttempt(x=>x+1);
   if(!v.token){setOpen(false);setNotice('创建请求已完成，完整密钥不能再次获取。请核对列表，作废后重新新增。');}
  }catch(e){setFormError(message(e));}finally{setBusy(false);}
 }
 async function revoke(id:string){setBusy(true);setError('');try{await employeeRequest(`/developer/keys/${id}/revoke`,{method:'POST',body:{requestId:crypto.randomUUID()}});setNotice('密钥已作废。');setAttempt(x=>x+1);}catch(e){setError(message(e));}finally{setBusy(false);}}
 return <>
  <div className="developer-key-heading"><div className="developer-intro"><h2>我的开发凭证</h2><p>新密钥可读取公共目录和你有权限的应用接口，长期有效，最多保留 5 个。请勿放入网页、应用包或代码仓库。</p></div><Button disabled={busy} onClick={()=>{setFormError('');setToken('');setOpen(true);}}>新增密钥</Button></div>
  {error&&<p role="alert" className="afc-error">{error} <Button size="sm" onClick={()=>setAttempt(x=>x+1)}>刷新列表</Button></p>}{notice&&<p role="status">{notice}</p>}
  <Table compact className="developer-key-table" emptyState={!keys.length?(loading?'正在读取密钥…':'暂无密钥，点击“新增密钥”开始使用。'):undefined}>
   <thead><tr><th scope="col">密钥</th><th scope="col" className="developer-key-created">创建时间</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
   <tbody>{keys.map(k=>{const expired=!!k.expiresAt&&new Date(k.expiresAt).getTime()<=Date.now();return <tr key={k.id}>
    <td><div className="developer-key-identity"><strong>{k.name}</strong><code>{k.prefix}…</code></div></td>
    <td className="developer-key-created">{date(k.createdAt)}</td>
    <td><Badge size="sm" variant={k.revokedAt||expired?'neutral':'success'}>{k.revokedAt?'已作废':expired?'已过期':'有效'}</Badge></td>
    <td>{!k.revokedAt?<TableActionButton disabled={busy} aria-label={`作废 ${k.name}`} onClick={()=>void revoke(k.id)}>作废</TableActionButton>:<span className="afc-muted">—</span>}</td>
   </tr>;})}</tbody>
  </Table>
  <h3 className="developer-key-usage">调用方法</h3><pre className="developer-code"><code>{`# 将密钥存入 MOP_DEV_KEY 环境变量\ncurl -H "Authorization: Bearer $MOP_DEV_KEY" \\\n  '${window.location.origin}/api/developer/directory?resource=stations'\n\n# 查询我有权限的应用接口\ncurl -H "Authorization: Bearer $MOP_DEV_KEY" \\\n  '${window.location.origin}/api/developer/interfaces'`}</code></pre>
  <Dialog open={open} title={token?'密钥已创建':'新增密钥'} size="sm" onClose={close} closeOnBackdropClick={!token} description={token?'完整密钥仅显示一次，请立即保存到本地环境变量。':'默认可读取公共目录和你有权限的应用接口，无需设置有效期。'} footer={token?<Button onClick={close}>已保存，关闭</Button>:<><Button variant="secondary" disabled={busy} onClick={close}>取消</Button><Button type="submit" form="developer-create-key" disabled={busy||!name.trim()}>{busy?'创建中…':'创建密钥'}</Button></>}>
   {token?<pre className="developer-code"><code>{token}</code></pre>:<form id="developer-create-key" className="admin-form developer-key-form" onSubmit={e=>{e.preventDefault();if(!busy)void create();}}><label>名称<Input required maxLength={60} value={name} disabled={busy} onChange={e=>setName(e.target.value)}/></label>{formError&&<p role="alert" className="afc-error">{formError}</p>}</form>}
  </Dialog>
 </>;
}

export function PublicDirectories(){
 const [directories,setDirectories]=useState<{id:string;title:string}[]>([]),[resource,setResource]=useState('stations'),[search,setSearch]=useState(''),[data,setData]=useState<{rows:unknown[];nextCursor:string|null}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{const c=new AbortController();employeeRequest<{directories:{id:string;title:string}[]}>('/developer/directories',{signal:c.signal}).then(v=>setDirectories(v.directories)).catch(e=>{if(!c.signal.aborted)setError(message(e));});return()=>c.abort();},[]);
 async function read(next=false){setBusy(true);setError('');try{const q=new URLSearchParams({resource,search,pageSize:'50',...(next&&data?.nextCursor?{afterId:data.nextCursor}:{})});const value=await employeeRequest<{rows:unknown[];nextCursor:string|null}>(`/developer/directory?${q}`);setData(value);}catch(e){setData(null);setError(message(e));}finally{setBusy(false);}}
 return <><div className="developer-intro"><h2>公共数据</h2><p>真实的启用目录，每页 50 条。ID 可用于应用关联；公共目录可见性不会授予业务数据权限。人员、具体设备和业务记录仍按授权读取。</p></div><form className="developer-query-form" onSubmit={e=>{e.preventDefault();void read();}}><label>目录<Select disabled={busy} value={resource} onChange={e=>{setResource(e.target.value);setData(null);}}>{directories.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</Select></label><label>查找<Input placeholder="名称或编号" disabled={busy} value={search} onChange={e=>{setSearch(e.target.value);setData(null);}}/></label><Button type="submit" disabled={busy}>{busy?'读取中…':'读取数据'}</Button></form>{error&&<p role="alert" className="afc-error">{error}</p>}{data&&<><div className="admin-actions"><span>{data.rows.length} 条</span><Button variant="secondary" onClick={()=>download(`${resource}.json`,data)}>下载本页 JSON</Button><Button variant="secondary" disabled={busy||!data.nextCursor} onClick={()=>void read(true)}>下一页</Button></div>{!data.rows.length&&<p>没有匹配的启用数据。</p>}<Json value={data}/></>}</>;
}

type Entry={appId:string;appName:string;version:string;apiId:string;permission:string;expose:{title:string;mode:'read';documentation:AppApiDocumentation}};
export function ApplicationInterfaces(){
 const [entries,setEntries]=useState<Entry[]>([]),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[loading,setLoading]=useState(true);
 useEffect(()=>{const c=new AbortController();setLoading(true);setError('');employeeRequest<{interfaces:Entry[]}>('/developer/interfaces',{signal:c.signal}).then(v=>setEntries(v.interfaces)).catch(e=>{if(!c.signal.aborted){setEntries([]);setError(message(e));}}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>c.abort();},[attempt]);
 return <><div className="developer-intro"><h2>应用接口</h2><p>仅列出已安装应用明确开放、且你有业务权限的查询接口。每次调用都会重新鉴权，返回的数据范围与目标应用一致。</p></div><div className="admin-actions"><Button variant="secondary" disabled={loading} onClick={()=>setAttempt(x=>x+1)}>刷新目录</Button><Button variant="secondary" disabled={loading||!entries.length} onClick={()=>download('application-interfaces.json',{interfaces:entries})}>下载接口文档</Button></div>{error&&<p role="alert" className="afc-error">{error}</p>}{loading?<p role="status">读取接口…</p>:!entries.length&&!error?<p>暂无可用接口。应用需声明开放接口并安装更新，你还需具备相应业务角色。</p>:null}<div className="developer-reference-list">{entries.map(entry=><Interface key={`${entry.appId}/${entry.apiId}/${entry.version}`} entry={entry}/>)}</div></>;
}
function Interface({entry}:{entry:Entry}){
 const doc=entry.expose.documentation;const [input,setInput]=useState(print(doc.examples[0]?.params??{})),[result,setResult]=useState<unknown>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function call(){setBusy(true);setError('');setResult(undefined);try{const v=await employeeRequest<{result:unknown}>('/developer/call',{method:'POST',body:{appId:entry.appId,apiId:entry.apiId,input:JSON.parse(input)}});setResult(v.result);}catch(e){setError(e instanceof SyntaxError?'参数必须是有效 JSON。':message(e));}finally{setBusy(false);}}
 return <details className="admin-card developer-reference"><summary><span><strong>{entry.appName} · {entry.expose.title}</strong><code>{entry.appId}/{entry.apiId} · v{entry.version}</code></span><span>只读</span></summary><p>{doc.description}</p><p>所需业务权限：{entry.permission}</p><details><summary>参数、返回值、示例与错误</summary><Json value={doc}/></details><pre className="developer-code"><code>{`// 调用方 app.json 声明 appAccess 并申请 apps.read\nawait ctx.apps.call('${entry.appId}', '${entry.apiId}', ${print(doc.examples[0]?.params??{})});`}</code></pre><label>调试参数<Textarea aria-label={`${entry.expose.title}调试参数`} rows={6} value={input} disabled={busy} onChange={e=>setInput(e.target.value)}/></label><Button disabled={busy} onClick={()=>void call()}>{busy?'查询中…':'执行查询'}</Button>{error&&<p role="alert" className="afc-error">{error}</p>}{result!==undefined&&<Json value={result}/>}</details>;
}
