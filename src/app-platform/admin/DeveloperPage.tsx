import React,{useEffect,useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {Button,FilterBar,type FilterState} from '../../components/ui';
import {PLATFORM_APP_OPERATIONS,PLATFORM_SDK_MODULES,APP_INTEGRATION_ERRORS} from '@metro/platform-sdk/app-contracts';
import metadata from '../../../package.json';
import {adminRequest} from './client';
import start from '../../../docs/developer/start.md?raw';
import identity from '../../../docs/developer/identity-permissions.md?raw';
import ui from '../../../docs/developer/ui-navigation.md?raw';
import packaging from '../../../docs/developer/packaging.md?raw';
import storage from '../../../docs/developer/storage-files.md?raw';
import notifications from '../../../docs/developer/notifications.md?raw';
import agents from '../../../docs/developer/agents.md?raw';
import tools from '../../../docs/developer/tools.md?raw';
import knowledge from '../../../docs/developer/knowledge.md?raw';
const sections=[['start','开始开发'],['sdk','平台 SDK'],['guides','开发与改造'],['downloads','工具与下载']] as const;
const guides=[{id:'identity',title:'身份与权限',content:identity},{id:'ui',title:'界面与导航',content:ui},{id:'storage',title:'存储与文件',content:storage},{id:'notifications',title:'通用通知',content:notifications},{id:'knowledge',title:'应用知识库',content:knowledge},{id:'agents',title:'统一对话与编排',content:agents},{id:'tools',title:'只读工具与 MCP',content:tools},{id:'packaging',title:'打包与升级',content:packaging}];
function Code({children}:{children:string}) {return <pre className="developer-code"><code>{children}</code></pre>;}
/** Render bundled documentation as text and code only; never interpret embedded HTML. */
export function DeveloperDocument({content}:{content:string}) {
 const blocks=content.trim().split(/(```[^\n]*\n[\s\S]*?\n```)/g).filter(Boolean);
 return <article className="developer-document">{blocks.flatMap((block,i)=>{
  if(block.startsWith('```'))return <Code key={i}>{block.replace(/^```[^\n]*\n/,'').replace(/\n```$/,'')}</Code>;
  return block.trim().split(/\n\s*\n/).filter(Boolean).map((paragraph,j)=>{
   const key=`${i}-${j}`;
   if(paragraph.startsWith('# '))return <h2 key={key}>{paragraph.slice(2)}</h2>;
   if(paragraph.startsWith('## '))return <h3 key={key}>{paragraph.slice(3)}</h3>;
   if(paragraph.startsWith('### '))return <h4 key={key}>{paragraph.slice(4)}</h4>;
   return <p key={key}>{paragraph}</p>;
  });
 })}</article>;
}
function saveFile(name:string,content:BlobPart,type='application/json') {
 const url=URL.createObjectURL(new Blob([content],{type})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function PlatformSdk(){
 const [search,setSearch]=useState(''),[filters,setFilters]=useState<FilterState>({selectedOptions:{}});
 const selected=filters.selectedOptions.group??[];
 const groups=[...new Set(PLATFORM_APP_OPERATIONS.map(op=>op.group))];
 const visible=PLATFORM_APP_OPERATIONS.filter(op=>(!selected.length||selected.includes(op.group))&&`${op.title} ${op.group} ${op.id} ${op.entrypoint} ${op.call} ${op.permission} ${op.input} ${op.output} ${op.constraints}`.toLowerCase().includes(search.toLowerCase()));
 return <><div className="developer-intro"><h2>平台 SDK</h2><p>公开 SDK 的真实调用入口。这里描述 v{metadata.version} 的支持范围；实例配置、应用授权与员工业务权限仍需分别满足。</p></div>
 <div className="developer-toolbar"><FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="搜索能力、调用方式或权限" showDateRange={false} filterGroups={[{id:'group',title:'能力分类',options:groups.map(name=>({id:name,label:name}))}]} activeFilters={filters} onApplyFilters={setFilters} onResetFilters={()=>setFilters({selectedOptions:{}})} showActiveTags onRemoveTag={(id,value)=>setFilters(current=>({selectedOptions:{...current.selectedOptions,[id]:(current.selectedOptions[id]??[]).filter(item=>item!==value)}}))} moreActions={[{id:'export',label:'导出能力参考',onClick:()=>saveFile(`platform-sdk-${metadata.version}.json`,JSON.stringify({version:metadata.version,operations:PLATFORM_APP_OPERATIONS,modules:PLATFORM_SDK_MODULES,errors:APP_INTEGRATION_ERRORS},null,2))}]}/></div>
 <p className="afc-muted">{visible.length} 项能力 · 包括后端服务、宿主通道与本地 SDK 工具。各项执行位置和权限见详情；写入不自动重试。</p>
 <div className="developer-reference-list">{visible.map(op=><details className="admin-card developer-reference" key={op.id}><summary><span><strong>{op.title}</strong><code>{op.id}</code></span><span className="afc-muted">{op.group}</span></summary><dl><dt>执行位置</dt><dd>{op.execution==='page'?'应用页面（useApp）':op.execution==='local'?'应用前端本地执行':op.execution==='build'?'应用构建阶段':op.execution==='employee-backend'?'员工触发的隔离后端':'隔离后端'} · {op.mode==='read'?'读取':op.mode==='ui'?'宿主交互':'写入或由目标契约决定'}</dd><dt>导入入口</dt><dd><code>{op.entrypoint}</code></dd><dt>所需权限</dt><dd><code>{op.permission}</code></dd><dt>参数</dt><dd>{op.input}</dd><dt>返回</dt><dd>{op.output}</dd><dt>条件与限制</dt><dd>{op.constraints}</dd></dl><h3>调用方式</h3><Code>{op.call}</Code><h3>参数示例</h3><Code>{JSON.stringify(op.example,null,2)}</Code></details>)}</div>
 {!visible.length&&<p>没有匹配的能力。</p>}
 <section className="developer-note"><h3>身份、UI 与文件</h3><p>登录注册由宿主提供；应用使用可信员工上下文。文件与图片能力已逐项列在本页；完整组合示例见“开发与改造 → 存储与文件”。内部平台模块和管理员管理接口不属于应用公开 SDK。</p></section>
 <details className="admin-card"><summary>SDK 导出入口核对（{PLATFORM_SDK_MODULES.length} 个）</summary><dl>{PLATFORM_SDK_MODULES.map(item=><React.Fragment key={item.path}><dt><code>{item.path}</code></dt><dd>{item.description}</dd></React.Fragment>)}</dl></details>
 <details className="admin-card"><summary>常见错误与恢复</summary><dl>{APP_INTEGRATION_ERRORS.map(item=><React.Fragment key={item.code}><dt><code>{item.code}</code></dt><dd>{item.description}</dd></React.Fragment>)}</dl></details></>;
}
type Downloads={available:boolean;version:string|null;downloads:{id:string;title:string;fileName:string;bytes:number;sha256:string}[]};
function DownloadsPage(){
 const [data,setData]=useState<Downloads|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[serial,setSerial]=useState(0);
 useEffect(()=>{const c=new AbortController();setError('');adminRequest<Downloads>('/developer/downloads',{signal:c.signal}).then(setData).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[serial]);
 async function download(id:string,name:string){setBusy(id);setError('');try{const response=await fetch(`/api/admin/developer/downloads/${id}`,{credentials:'same-origin'});if(!response.ok)throw Error('下载失败，请核对管理员登录状态并重试。');saveFile(name,await response.blob(),'application/gzip');}catch(e){setError(e instanceof Error?e.message:'下载失败');}finally{setBusy('');}}
 return <><div className="developer-intro"><h2>工具与下载</h2><p>将同版本资料交给开发者或编程 Agent。下载本身不包含账号、私钥或实例业务数据。</p></div>{error&&<p role="alert" className="afc-error">{error} <Button variant="secondary" size="sm" onClick={()=>setSerial(v=>v+1)}>重新读取</Button></p>}{!data&&!error&&<p role="status">正在读取下载清单…</p>}{data&&!data.available&&<p>此环境尚未构建开发资料；平台维护者需执行 npm run build:sdk、npm run build:cli、npm run build:developer。</p>}
 {data?.available&&<><p className="afc-muted">资料版本 v{data.version} · 当前界面 v{metadata.version}</p>{data.version!==metadata.version&&<p role="alert">前后端版本不一致，请核对平台部署版本后使用。</p>}<div className="developer-download-grid">{data.downloads.map(item=><section className="admin-card" key={item.id}><h3>{item.title}</h3><p>{item.fileName}</p><p className="afc-muted">{(item.bytes/1024).toFixed(0)} KiB</p><details><summary>SHA-256</summary><code>{item.sha256}</code></details><Button variant="secondary" disabled={!!busy} onClick={()=>void download(item.id,item.fileName)}>{busy===item.id?'下载中…':'下载'}</Button></section>)}</div></>}
 <section className="developer-document"><h3>使用 Agent Skill</h3><p>解压 Skill 包，得到 metro-app-development/SKILL.md 和 references/。把整个目录放入编程 Agent 支持的技能目录，或让 Agent 阅读 SKILL.md。它支持新建应用，以及先阅读项目、提出方案、经确认后改造已有应用。</p><Code>{'请使用 metro-app-development 技能评估这个项目。\n先梳理业务、身份、权限、数据和外部依赖，列出可接入的平台能力。\n将保留/替换建议及待确认事项交给我确认，再开始改造。'}</Code><p>SDK/CLI 的 .tgz 用 npm 安装；示例和 Skill 的 .tar.gz 先解压。新应用用 mop-app init 建项目、mop-app build 生成单个 .mopkg（项目内自带 Skill）；现有应用的 .mop.gz 仍由管理员上传安装。下载接口目录后，应另行提供给 Agent，并提醒其运行时重新核对开放与授权状态。</p></section></>;
}
export default function DeveloperPage(){
 const [params,setParams]=useSearchParams(),section=sections.some(([id])=>id===params.get('section'))?params.get('section')!:'start';
 const selectedGuide=guides.find(g=>g.id===params.get('guide'))??guides[0];
 return <div className="developer-center"><div className="admin-heading"><div><h1>开发者中心</h1><p className="afc-muted">平台 v{metadata.version}</p></div></div><nav className="developer-tabs" aria-label="开发者中心导航">{sections.map(([id,title])=><Button key={id} shape="rounded" size="sm" variant={section===id?'primary':'ghost'} aria-pressed={section===id} onClick={()=>setParams({section:id})}>{title}</Button>)}</nav>
 {section==='start'&&<><div className="developer-start-links">{sections.slice(1).map(([id,title])=><Button variant="secondary" shape="rounded" key={id} onClick={()=>setParams({section:id})}>{title} →</Button>)}</div><DeveloperDocument content={start}/></>}
 {section==='sdk'&&<PlatformSdk/>}{section==='downloads'&&<DownloadsPage/>}
 {section==='guides'&&<div className="developer-guide-layout"><nav aria-label="开发指南"><div className="developer-guide-links">{guides.map(guide=><Button key={guide.id} shape="rounded" variant={guide.id===selectedGuide.id?'primary':'ghost'} aria-pressed={guide.id===selectedGuide.id} onClick={()=>setParams({section:'guides',guide:guide.id})}>{guide.title}</Button>)}</div></nav><DeveloperDocument content={selectedGuide.content}/></div>}
 </div>;
}
