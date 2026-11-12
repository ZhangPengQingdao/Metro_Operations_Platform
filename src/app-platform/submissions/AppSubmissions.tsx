import React,{useEffect,useRef,useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {Button,Dialog,DataList,Field,ListPagination,TableActionButton,TableBody,TableCell,TableHead,TableHeader,TableRow} from '../../components/ui';
import {ShieldCheck} from '@phosphor-icons/react';
import {employeeRequest} from '../employee/client';
import {adminRequest} from '../admin/client';
import {isMopkgFile,readMopkgFile,MopkgPreviewDetails,type MopkgPreview} from '../admin/MopkgPackagePreview';

const labels:Record<string,string>={pending:'待审核',processing:'正在安装',completed:'已完成',rejected:'已驳回',uncertain:'需核对'};
type Item={id:string;appId:string;name:string;version:string;kind:'new'|'update';status:string;revision:string;reason:string|null;createdAt:string;submittedBy?:string};
type ReviewPage={submissions:Item[];total:number;page:number;pageSize:number;selected:Item|null};
const errorMessage=(error:unknown)=>error instanceof Error?error.message:'操作未确认，请刷新核对。';

export function SubmitApplication({appId,onClose,onDone}:{appId?:string;onClose:()=>void;onDone:()=>void}){
 const input=useRef<HTMLInputElement>(null),[upload,setUpload]=useState<{file:File;requestId:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(){
  if(!upload||busy)return;
  setBusy(true);setError('');
  try{
   if(!await isMopkgFile(upload.file))throw Error('请上传 mop-app build 生成的 .mopkg 文件');
   await employeeRequest('/app-submissions',{method:'POST',body:{kind:appId?'update':'new',appId,requestId:upload.requestId,package:await readMopkgFile(upload.file)}});
   onDone();
  }catch(error){setError(errorMessage(error));}finally{setBusy(false);}
 }
 return <Dialog open size="sm" title={appId?'提交应用更新':'申请上架应用'} onClose={()=>{if(!busy)onClose();}} footer={<>
  <Button variant="secondary" disabled={busy} onClick={()=>input.current?.click()}>{upload?'重新上传':'上传安装包'}</Button>
  <Button disabled={!upload||busy} onClick={()=>void submit()}>{busy?'正在提交…':'提交审核'}</Button>
 </>}>
  <input hidden ref={input} type="file" accept=".mopkg,application/zip" onChange={event=>{const file=event.target.files?.[0];setUpload(file?{file,requestId:crypto.randomUUID()}:null);setError('');}}/>
  <p className="app-package-filename">{upload?.file.name??'选择 .mopkg 安装包（由 mop-app build 生成）'}</p>
  {error&&<p role="alert" className="afc-error">{error}</p>}
 </Dialog>;
}

function SubmissionList({items,inspect,pagination}:{items:Item[]|null;inspect?:(item:Item)=>void;pagination?:React.ReactNode}){
 return <DataList aria-busy={items===null} emptyState={items?.length===0?'暂无申请':undefined} pagination={pagination}>
  <TableHeader><TableRow><TableHead>应用</TableHead><TableHead>版本</TableHead><TableHead>申请类型</TableHead>
   {inspect&&<><TableHead>申请人</TableHead><TableHead>提交时间</TableHead></>}<TableHead>状态</TableHead>{inspect&&<TableHead>操作</TableHead>}
  </TableRow></TableHeader>
  <TableBody>{items?.map(item=><TableRow key={item.id}>
   <TableCell><div className="app-name-cell"><strong>{item.name}</strong><span className="afc-muted">{item.appId}</span></div></TableCell>
   <TableCell>{item.version}</TableCell><TableCell>{item.kind==='new'?'首次上架':'版本更新'}</TableCell>
   {inspect&&<><TableCell>{item.submittedBy}</TableCell><TableCell>{new Date(item.createdAt).toLocaleString('zh-CN',{hour12:false})}</TableCell></>}
   <TableCell>{labels[item.status]}{item.reason&&<p className="admin-submission-reason">{item.reason}</p>}</TableCell>
   {inspect&&<TableCell>{item.status==='pending'&&<TableActionButton icon={<ShieldCheck size={18}/>} onClick={()=>inspect(item)}>审核</TableActionButton>}</TableCell>}
  </TableRow>)}</TableBody>
 </DataList>;
}

export function AppSubmissions({onClose}:{onClose:()=>void}){
 const [items,setItems]=useState<Item[]|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  const controller=new AbortController();
  employeeRequest<{submissions:Item[]}>('/app-submissions',{signal:controller.signal}).then(result=>{
   if(!controller.signal.aborted)setItems(result.submissions);
  }).catch(error=>{if(!controller.signal.aborted)setError(errorMessage(error));});
  return ()=>controller.abort();
 },[]);
 return <Dialog open size="xl" title="我的申请" onClose={onClose}>
  {error?<p role="alert" className="afc-error">{error}</p>:items===null?<p role="status">正在读取申请…</p>:<SubmissionList items={items}/>}
 </Dialog>;
}

export function ApplicationReviewPage({onReviewed}:{onReviewed:()=>void}){
 const [params,setParams]=useSearchParams(),submission=params.get('submission');
 const [data,setData]=useState<ReviewPage|null>(null),[page,setPage]=useState(1),[serial,setSerial]=useState(0),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const query=new URLSearchParams({page:String(page),...(submission?{submission}:{})}).toString();
 useEffect(()=>{
  const controller=new AbortController();
  setError('');
  adminRequest<ReviewPage>('/app-submissions?'+query,{signal:controller.signal}).then(result=>{
   if(!controller.signal.aborted)setData(result);
  }).catch(error=>{if(!controller.signal.aborted)setError(errorMessage(error));});
  return ()=>controller.abort();
 },[query,serial]);
 const selected=data?.selected?.id===submission?data.selected:null;
 const close=()=>setParams({}, {replace:true});
 function reviewed(status:string){
  close();setSerial(value=>value+1);onReviewed();
  setNotice(status==='completed'?'审核通过，应用已安装或更新。':status==='rejected'?'已驳回申请。':'安装结果需核对。请到应用列表检查当前版本和运行状态。');
 }
 return <section>
  <div className="admin-heading"><h1>应用审核</h1><Button size="sm" variant="secondary" onClick={()=>setSerial(value=>value+1)}>刷新</Button></div>
  {notice&&<p role="status">{notice}</p>}
  {error&&<p role="alert" className="afc-error">{error}</p>}
  {!data&&!error&&<p role="status">正在读取申请…</p>}
  {data&&<SubmissionList items={data.submissions} inspect={item=>{setNotice('');setParams({submission:item.id});}} pagination={data.total>data.pageSize?<ListPagination
   page={data.page} total={data.total} hasNext={data.page*data.pageSize<data.total} onPrevious={()=>setPage(data.page-1)} onNext={()=>setPage(data.page+1)}/>:undefined}/>}
  {selected&&<ReviewSubmission key={selected.id+selected.revision} item={selected} onClose={close} onReviewed={reviewed}/>}
 </section>;
}

function ReviewSubmission({item,onClose,onReviewed}:{item:Item;onClose:()=>void;onReviewed:(status:string)=>void}){
 const [preview,setPreview]=useState<MopkgPreview|null>(null),[loading,setLoading]=useState(item.status==='pending'),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[rejecting,setRejecting]=useState(false),[reason,setReason]=useState('');
 useEffect(()=>{
  if(item.status!=='pending')return;
  const controller=new AbortController();
  adminRequest<MopkgPreview>(`/app-submissions/${item.id}/preview`,{method:'POST',body:{},signal:controller.signal}).then(result=>{
   if(!controller.signal.aborted)setPreview(result);
  }).catch(error=>{if(!controller.signal.aborted)setError(errorMessage(error));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return ()=>controller.abort();
 },[item.id,item.status]);
 async function decide(decision:'approve'|'reject'){
  if(busy||loading||decision==='approve'&&!preview?.installable)return;
  setBusy(true);setError('');
  try{
   const result=await adminRequest<{status:string}>(`/app-submissions/${item.id}/review`,{method:'POST',body:{
    revision:item.revision,decision,...(decision==='approve'?{digest:preview!.sha256}:{reason})
   }});
   onReviewed(result.status);
  }catch(error){setError(errorMessage(error));}finally{setBusy(false);}
 }
 return <Dialog open closeOnBackdropClick={false} size="lg" title={`审核 ${item.name}`} onClose={()=>{if(!busy)onClose();}} footer={<>
  {item.status!=='pending'?<Button variant="secondary" onClick={onClose}>关闭</Button>:rejecting?<>
   <Button variant="secondary" disabled={busy} onClick={()=>setRejecting(false)}>返回</Button>
   <Button variant="danger" loading={busy} onClick={()=>void decide('reject')}>确认驳回</Button>
  </>:<>
   <Button variant="secondary" disabled={busy||loading} onClick={()=>setRejecting(true)}>驳回</Button>
   <Button loading={busy} disabled={loading||!preview?.installable} onClick={()=>void decide('approve')}>批准并{item.kind==='new'?'安装':'更新'}</Button>
  </>}
 </>}>
  <p>{item.kind==='new'?'首次上架':'版本更新'} · {item.version} · {item.submittedBy}</p>
  {item.status!=='pending'&&<p role="status">当前状态：{labels[item.status]}</p>}
  {loading&&<p role="status">正在读取安装包预览…</p>}
  {rejecting?<Field label="驳回原因（可选）" htmlFor="app-reject-reason"><textarea id="app-reject-reason" className="afc-control afc-control--textarea" maxLength={500} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></Field>:preview&&<MopkgPreviewDetails preview={preview}/>}
  {error&&<p role="alert" className="afc-error">{error}</p>}
 </Dialog>;
}
