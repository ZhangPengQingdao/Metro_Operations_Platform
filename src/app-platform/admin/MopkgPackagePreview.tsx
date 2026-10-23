import React from 'react';
import type {AppDataScope,AppManifestV2} from '@metro/platform-sdk/manifest';

const MAX_BYTES=50*1024*1024;
// App icons are white line art on a coloured tile.
const DEFAULT_TILE='#2563EB',UNKNOWN_TILE='#64748B';
export interface MopkgPreview {
 format:'mopkg';sha256:string;bytes:number;manifest:AppManifestV2|null;icon:{contentType:string;dataUrl:string}|null;
 readme:string|null;changelog:string|null;files:{path:string;bytes:number}[];
 migrations:{id:string;file:string;bytes:number;sha256:string;statements:number}[];
 issues:{path:string;message:string}[];platform:{version:string;compatible:boolean};
 installed:{version:string;model:'v1'|'v2'}|null;
 change:{kind:'install'|'upgrade'|'reinstall'|'downgrade';addedPermissions:string[];removedPermissions:string[];addedPlatformAccess:string[]}|null;
 installable:false;blockedReason:string;
}

/** A `.mopkg` is a zip: detect by extension or local-file header. */
export async function isMopkgFile(file:File):Promise<boolean>{
 if(file.name.toLowerCase().endsWith('.mopkg'))return true;
 const header=new Uint8Array(await file.slice(0,4).arrayBuffer());
 return header[0]===0x50&&header[1]===0x4b&&header[2]===0x03&&header[3]===0x04;
}
export function readMopkgFile(file:File):Promise<string>{
 if(!file.size||file.size>MAX_BYTES)return Promise.reject(Error('请选择不超过 50MB 的 .mopkg 安装包。'));
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onerror=()=>reject(Error('读取安装包失败，请重新选择文件。'));
  reader.onload=()=>{const value=String(reader.result??'');resolve(value.slice(value.indexOf(',')+1));};
  reader.readAsDataURL(file);
 });
}

const ACCESS_LABELS:Record<string,string>={
 'people.read':'读取人员与组织','locations.read':'读取线路与车站','assets.read':'读取设备','ai.complete':'调用 AI 文本模型',
 'attachments.create':'上传附件','attachments.read':'读取附件','notifications.create':'发送通知','notifications.manage':'管理通知',
 'signatures.create':'发起签字','signatures.read':'查看签字','signatures.sign':'执行签字','webhook.send':'调用外部 Webhook',
};
const SCOPE_LABELS:Record<AppDataScope,string>={self:'本人',workgroup:'工班',department:'部门',organizations:'指定组织',all:'全部'};
const CHANGE_LABELS={install:'新安装',upgrade:'升级',reinstall:'同版本重装',downgrade:'降级'};
const size=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;

export function MopkgPreviewDetails({preview}:{preview:MopkgPreview}){
 const manifest=preview.manifest;
 const permissionName=(code:string)=>manifest?.permissions.find(permission=>permission.code===code)?.name??code;
 return <div className="mopkg-preview">
  <header className="mopkg-preview-head">
   <span className="mopkg-preview-tile" style={{background:manifest?(manifest.color??DEFAULT_TILE):UNKNOWN_TILE}}>{preview.icon&&manifest?<img src={preview.icon.dataUrl} alt=""/>:<span>{manifest?.name.slice(0,1)??'?'}</span>}</span>
   <div>
    <strong>{manifest?.name??'无法识别的应用'}</strong>
    <p>{manifest?<>{manifest.id} · {preview.installed?`${preview.installed.version} → `:''}{manifest.version}{preview.change&&<> · {CHANGE_LABELS[preview.change.kind]}</>}</>:'app.json 未通过校验'}</p>
    {manifest&&<p>{manifest.description}</p>}
   </div>
  </header>
  {preview.issues.length>0&&<div className="mopkg-preview-issues" role="alert"><strong>安装包存在 {preview.issues.length} 个问题</strong><ul>{preview.issues.map((issue,index)=><li key={index}><code>{issue.path}</code> {issue.message}</li>)}</ul></div>}
  {manifest&&<dl className="afc-details">
   <dt>平台版本</dt><dd>要求 {manifest.platform}，当前 {preview.platform.version}{preview.platform.compatible?'，兼容':'，不兼容'}</dd>
   <dt>权限</dt><dd>{manifest.permissions.length?<ul className="mopkg-preview-list">{manifest.permissions.map(permission=><li key={permission.code}>{permission.name} <code>{permission.code}</code>{permission.scopes&&<span className="afc-muted"> · 范围：{permission.scopes.map(scope=>SCOPE_LABELS[scope]).join('、')}</span>}</li>)}</ul>:'无'}</dd>
   <dt>平台能力</dt><dd>{manifest.platformAccess.length?manifest.platformAccess.map(code=>ACCESS_LABELS[code]??code).join('、'):'无'}{preview.change&&preview.change.addedPlatformAccess.length>0&&preview.installed&&<p className="afc-muted">新增：{preview.change.addedPlatformAccess.map(code=>ACCESS_LABELS[code]??code).join('、')}</p>}</dd>
   {preview.change&&preview.installed&&<><dt>权限变化</dt><dd>新增：{preview.change.addedPermissions.join('、')||'无'}；移除：{preview.change.removedPermissions.join('、')||'无'}</dd></>}
   <dt>页面</dt><dd>{manifest.pages.length?<ul className="mopkg-preview-list">{manifest.pages.map(page=><li key={page.path}>{page.title} <code>{page.path}</code>{page.nav&&<span className="afc-muted"> · 侧栏</span>}{page.permission&&<span className="afc-muted"> · {permissionName(page.permission)}</span>}</li>)}</ul>:'无'}</dd>
   <dt>接口</dt><dd>{manifest.api.length?<ul className="mopkg-preview-list">{manifest.api.map(api=><li key={api.id}><code>{api.id}</code>{api.permission&&<span className="afc-muted"> · {permissionName(api.permission)}</span>}{api.dashboard&&<span className="afc-muted"> · 工作台摘要</span>}</li>)}</ul>:'无'}</dd>
   <dt>数据迁移</dt><dd>{preview.migrations.length?<ul className="mopkg-preview-list">{preview.migrations.map(migration=><li key={migration.id}><code>{migration.id}</code><span className="afc-muted"> · {migration.statements} 条结构语句</span></li>)}</ul>:'无'}</dd>
   <dt>文件</dt><dd>{preview.files.map(file=>`${file.path}（${size(file.bytes)}）`).join('、')}</dd>
   <dt>安装包</dt><dd>{size(preview.bytes)} · <code title={preview.sha256}>sha256 {preview.sha256.slice(0,16)}…</code></dd>
  </dl>}
  {preview.changelog&&<details className="mopkg-preview-text"><summary>更新记录</summary><pre>{preview.changelog}</pre></details>}
  {preview.readme&&<details className="mopkg-preview-text"><summary>应用说明</summary><pre>{preview.readme}</pre></details>}
  <p className="mopkg-preview-blocked" role="status">{preview.blockedReason}</p>
 </div>;
}
