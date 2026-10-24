import React,{useRef,useState} from 'react';
import {Button,Dialog} from '../../components/ui';
import {adminRequest} from './client';
import {isMopkgFile,readMopkgFile,MopkgPreviewDetails,type MopkgPreview} from './MopkgPackagePreview';

/** Upload a `.mopkg`, review the read-only preview, then install (new app, upgrade or repair). */
export function InstallPackageReview({target,onDone,onBusy,onClose}:{onClose:()=>void;target?:{appId:string;revision:number};onDone:(message:string)=>void;onBusy:(busy:boolean)=>void}){
 const fileInput=useRef<HTMLInputElement>(null);
 const [file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [checked,setChecked]=useState<{preview:MopkgPreview;encoded:string}|null>(null);
 function processing(value:boolean){setBusy(value);onBusy(value);}
 async function inspect(){if(busy)return;processing(true);setChecked(null);setError('');try{
  if(!file)throw Error('请先选择应用安装包。');
  if(!await isMopkgFile(file))throw Error('请上传 mop-app build 生成的 .mopkg 文件。');
  const encoded=await readMopkgFile(file);
  const preview=await adminRequest<MopkgPreview>('/app-packages/preview',{method:'POST',body:{package:encoded}});
  if(target&&preview.manifest&&preview.manifest.id!==target.appId)throw Error('安装包与当前应用不一致。');
  setChecked({preview,encoded});
 }catch(e){setError(e instanceof Error?e.message:'解析失败，请重新上传。');}finally{processing(false);}}
 async function install(){if(!checked||busy)return;processing(true);setError('');try{
  const outcome=await adminRequest<{state:'installed'|'updated'|'repaired';enabled:boolean}>('/app-packages/install',{method:'POST',body:{package:checked.encoded}});
  onDone(outcome.state==='installed'?'应用已安装并启用。请在“设置”中指定应用负责人，由负责人配置角色和使用人员后，员工即可看到此应用。':outcome.state==='updated'?`应用已更新${outcome.enabled?'并重新启用':'，保持停用'}。`:'应用已修复并重新启用。');
 }catch(e){setError(e instanceof Error?e.message:'安装结果未确认，请刷新应用列表核对。');}finally{processing(false);}}
 return <Dialog open closeOnBackdropClick={false} title={target?'更新应用':'安装应用'} size={checked?'lg':'sm'} onClose={()=>{if(!busy)onClose();}} footer={<><Button variant="secondary" disabled={busy} onClick={()=>fileInput.current?.click()}>{file?'重新上传':'上传安装包'}</Button>{checked?<Button disabled={busy||!checked.preview.installable} onClick={()=>void install()}>{busy?'正在安装…':checked.preview.installed?'更新应用':'安装应用'}</Button>:<Button disabled={busy||!file} onClick={()=>void inspect()}>{busy?'正在解析…':'解析安装包'}</Button>}</>}>
  <div className="admin-form"><div className="app-package-upload"><input ref={fileInput} id="app-install-file" type="file" accept=".mopkg,application/zip" hidden disabled={busy} onClick={e=>e.stopPropagation()} onChange={e=>{setFile(e.target.files?.[0]??null);setChecked(null);setError('');}}/><p className="app-package-filename" title={file?.name}>{file?file.name:'选择 .mopkg 安装包（由 mop-app build 生成）'}</p></div>
  {error&&<p className="afc-error" role="alert">{error}</p>}{checked&&<MopkgPreviewDetails preview={checked.preview}/>}</div>
 </Dialog>;
}
