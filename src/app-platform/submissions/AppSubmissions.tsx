import React,{useEffect,useRef,useState} from 'react';
import {Button,Dialog,DataList,TableActionButton} from '../../components/ui';
import {ShieldCheck} from '@phosphor-icons/react';
import {employeeRequest} from '../employee/client';
import {adminRequest} from '../admin/client';
import {isMopkgFile,readMopkgFile,MopkgPreviewDetails,type MopkgPreview} from '../admin/MopkgPackagePreview';
const labels:Record<string,string>={pending:'待审核',processing:'正在安装',completed:'已完成',rejected:'已驳回',uncertain:'需核对'};
type Item={id:string;appId:string;name:string;version:string;kind:string;status:string;revision:string;reason:string|null};
export function SubmitApplication({appId,onClose,onDone}:{appId?:string;onClose:()=>void;onDone:()=>void}){
 const input=useRef<HTMLInputElement>(null),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(){if(!file||busy)return;setBusy(true);setError('');try{if(!await isMopkgFile(file))throw Error('请上传 mop-app build 生成的 .mopkg 文件');await employeeRequest('/app-submissions',{method:'POST',body:{kind:appId?'update':'new',requestId:crypto.randomUUID(),package:await readMopkgFile(file)}});onDone();}catch(e){setError(e instanceof Error?e.message:'提交未确认');}finally{setBusy(false)}}
 return <Dialog open size="sm" title={appId?'提交应用更新':'申请上架应用'} onClose={()=>{if(!busy)onClose()}} footer={<><Button variant="secondary" disabled={busy} onClick={()=>input.current?.click()}>{file?'重新上传':'上传安装包'}</Button><Button disabled={!file||busy} onClick={()=>void submit()}>{busy?'正在提交…':'提交审核'}</Button></>}><input hidden ref={input} type="file" accept=".mopkg,application/zip" onChange={e=>{setFile(e.target.files?.[0]??null);setError('')}}/><p className="app-package-filename">{file?.name??'选择 .mopkg 安装包（由 mop-app build 生成）'}</p>{error&&<p role="alert" className="afc-error">{error}</p>}</Dialog>;
}
export function AppSubmissions({admin=false,onClose,embedded=false,onBusyChange}:{admin?:boolean;onClose:()=>void;embedded?:boolean;onBusyChange?:(busy:boolean)=>void}){
 const request=admin?adminRequest:employeeRequest;
 const [items,setItems]=useState<Item[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<Item|null>(null),[preview,setPreview]=useState<MopkgPreview|null>(null);
 useEffect(()=>{onBusyChange?.(busy);},[busy,onBusyChange]);
 async function load(){try{setItems((await request<{submissions:Item[]}>('/app-submissions')).submissions)}catch(e){setError((e as Error).message)}}
 useEffect(()=>{void load()},[]);
 async function inspect(item:Item){setSelected(item);setPreview(null);setError('');setBusy(true);try{setPreview(await adminRequest(`/app-submissions/${item.id}/preview`,{method:'POST',body:{}}))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function decide(decision:'approve'|'reject'){if(!selected||busy)return;setBusy(true);setError('');try{await adminRequest(`/app-submissions/${selected.id}/review`,{method:'POST',body:{revision:selected.revision,decision,...(decision==='approve'&&preview?{digest:preview.sha256}:{})}});setSelected(null);await load()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const content=<><DataList emptyState={!items.length?'暂无申请':undefined}><thead><tr><th>应用</th><th>版本</th><th>申请</th><th>状态</th>{admin&&<th>操作</th>}</tr></thead><tbody>{items.map(item=><tr key={item.id}><td>{item.name}</td><td>{item.version}</td><td>{item.kind==='new'?'上架':'更新'}</td><td>{labels[item.status]}{item.reason&&<p>{item.reason}</p>}</td>{admin&&<td><TableActionButton icon={<ShieldCheck size={18}/>} disabled={busy||item.status!=='pending'} onClick={()=>void inspect(item)}>审核</TableActionButton></td>}</tr>)}</tbody></DataList>{!selected&&error&&<p role="alert" className="afc-error">{error}</p>}{selected&&<Dialog open title={`审核 ${selected.name}`} onClose={()=>{if(!busy)setSelected(null)}} footer={<><Button variant="secondary" disabled={busy} onClick={()=>void decide('reject')}>驳回</Button><Button disabled={busy||!preview?.installable} onClick={()=>void decide('approve')}>批准并{selected.kind==='new'?'安装':'更新'}</Button></>}><p>版本：{selected.version}</p>{busy&&<p role="status">处理中…</p>}{preview&&<><MopkgPreviewDetails preview={preview}/><p className="afc-muted">批准后即安装该应用。</p></>}{error&&<p role="alert" className="afc-error">{error}</p>}</Dialog>}</>;
 return embedded?content:<Dialog open size="xl" title={admin?'应用上架与更新审核':'我的申请'} onClose={()=>{if(!busy)onClose()}}>{content}</Dialog>;
}
