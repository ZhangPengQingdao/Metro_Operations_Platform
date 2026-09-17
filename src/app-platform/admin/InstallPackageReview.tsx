import React,{useState} from 'react';
import {Button,Input,Field} from '../../components/ui';
import {adminRequest} from './client';
import type {AppManifest} from '@metro/platform-sdk/app-manifest';
type Preview={manifest:AppManifest;digest:string;policyRevision:number;approved:boolean;supported:boolean;compatible:boolean;keyId:string;installed:{version:string;revision:number;enabled:boolean}|null;changes:{addedPermissions:string[];removedPermissions:string[];addedMigrations:string[]}};
export function InstallPackageReview({target,onDone,onBusy}:{target?:{appId:string;revision:number};onDone:(message:string)=>void;onBusy:(busy:boolean)=>void}){
 const [file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<Preview|null>(null),[bundle,setBundle]=useState<unknown>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 function processing(value:boolean){setBusy(value);onBusy(value);}
 async function inspect(){if(busy)return;processing(true);setPreview(null);setBundle(null);setError('');try{
  if(!file||file.size>92*1024*1024)throw Error('请选择不超过 92MB 的签名安装 JSON 包。');
  const payload=JSON.parse(await file.text()),value=await adminRequest<Preview>('/install-preview',{method:'POST',body:payload});
  if(target&&value.manifest.id!==target.appId)throw Error('安装包与当前应用不一致。');
  if(!target&&value.installed)throw Error('应用已经安装，请使用“更新”。');
  if(target&&value.installed?.revision!==target.revision)throw Error('应用状态已变化，请重新打开更新窗口。');
  setBundle(payload);setPreview(value);
 }catch(e){setError(e instanceof Error?e.message:'校验失败');}finally{processing(false);}}
 async function install(){if(!preview||!bundle||busy)return;processing(true);setError('');try{
  // Approval binds the verified manifest, which includes every artifact digest. No employee grant is implied.
  await adminRequest('/install-approve',{method:'POST',body:{revision:preview.policyRevision,digest:preview.digest,package:bundle}});
  const outcome=await adminRequest<{state:string}>(target?`/apps/${target.appId}/upgrade`:'/install',{method:'POST',body:target?{revision:target.revision,package:bundle}:bundle});
  onDone(outcome.state==='installed'?'安装已完成，请核对运行状态并分配授权。':outcome.state==='updated'?'更新已完成，应用保持停用。':`操作状态：${outcome.state}，请在应用状态中核对。`);
 }catch(e){setError(e instanceof Error?e.message:'操作结果未确认，请核对应用状态。');setPreview(null);setBundle(null);}finally{processing(false);}}
 return <div className="admin-form"><div className="app-package-upload"><Field label={target?"上传更新包":"上传安装包"} htmlFor="app-install-file" hint="签名 JSON 安装包 · 最大 92 MB"><Input id="app-install-file" type="file" accept="application/json,.json" disabled={busy} onChange={e=>{setFile(e.target.files?.[0]??null);setPreview(null);setBundle(null);setError('');}}/></Field><div className="app-package-actions"><Button size="sm" variant="secondary" disabled={busy||!file} onClick={()=>void inspect()}>{busy&&!preview?"正在校验…":"校验并预览"}</Button></div></div>{error&&<p className="afc-error" role="alert">{error}</p>}{preview&&<><dl className="afc-details"><dt>应用</dt><dd>{preview.manifest.name} · {preview.manifest.id}</dd><dt>版本</dt><dd>{preview.installed?`${preview.installed.version} → `:''}{preview.manifest.version}</dd><dt>发布者</dt><dd>{preview.manifest.publisherId} · {preview.keyId}</dd><dt>签名</dt><dd>已通过可信公钥校验</dd><dt>申请权限</dt><dd>{preview.manifest.permissions.requested.join('、')||'无'}</dd><dt>自定义权限</dt><dd>{preview.manifest.permissions.defined.map(p=>p.code).join('、')||'无'}</dd><dt>运行方式</dt><dd>{preview.manifest.ui.mode} / {preview.manifest.backend.mode}</dd><dt>存储需求</dt><dd>{preview.manifest.storage.mode}</dd><dt>新增迁移</dt><dd>{preview.changes.addedMigrations.join('、')||'无'}</dd><dt>权限变化</dt><dd>新增：{preview.changes.addedPermissions.join('、')||'无'}；移除：{preview.changes.removedPermissions.join('、')||'无'}</dd><dt>扩展声明</dt><dd>接口 {preview.manifest.api.length} · 工具 {preview.manifest.tools.length} · 任务 {preview.manifest.jobs.length} · 事件 {preview.manifest.events.publish.length+preview.manifest.events.subscribe.length}</dd><dt>外联域名</dt><dd>{[...preview.manifest.network.frontendOrigins,...preview.manifest.network.backendOrigins].join('、')||'无'}</dd><dt>产物大小</dt><dd>{preview.manifest.artifacts.reduce((n,a)=>n+a.bytes,0).toLocaleString()} 字节</dd><dt>版本审批</dt><dd>{preview.approved?'已批准':'待批准'}</dd></dl>{(!preview.supported||!preview.compatible)&&<p className="afc-error" role="alert">此安装包包含尚未接通的能力或不兼容的存储变更，无法批准。</p>}<p className="afc-muted">版本审批不授予员工使用权或数据权限。</p><div className="app-package-actions"><Button disabled={busy||!preview.supported||!preview.compatible} onClick={()=>void install()}>{busy?'正在处理…':target?'批准此版本并更新':'批准此版本并安装'}</Button></div></>}</div>;
}
