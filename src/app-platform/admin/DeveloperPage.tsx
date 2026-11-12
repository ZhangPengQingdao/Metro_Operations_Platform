import {ApplicationInterfaces,DeveloperKeys,PublicDirectories} from '../employee/DeveloperAccess';
import {employeeRequest} from '../employee/client';
import sharedApi from '../../../docs/developer/shared-api.md?raw';
import toolchain from '../../../docs/developer/toolchain.md?raw';
import testing from '../../../docs/developer/testing.md?raw';
import integration from '../../../docs/developer/integration.md?raw';
import ai from '../../../docs/developer/ai.md?raw';
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
const sections=[['start','开始开发'],['sdk','平台 SDK'],['guides','开发与改造'],['downloads','Skill 与工具']] as const;
const guides=[{id:'shared-api',title:'统一接口与调用入口',content:sharedApi},{id:'toolchain',title:'工具安装与平台连接',content:toolchain},{id:'testing',title:'测试与验收',content:testing},{id:'integration',title:'公共数据与跨应用调用',content:integration},{id:'ai',title:'AI 能力总览',content:ai},{id:'identity',title:'身份与权限',content:identity},{id:'ui',title:'界面与导航',content:ui},{id:'storage',title:'存储与文件',content:storage},{id:'notifications',title:'通用通知',content:notifications},{id:'knowledge',title:'应用知识库',content:knowledge},{id:'agents',title:'统一对话与编排',content:agents},{id:'tools',title:'只读工具与 MCP',content:tools},{id:'packaging',title:'打包与升级',content:packaging}];
function Code({children}:{children:string}) {return <pre className="developer-code"><code>{children}</code></pre>;}
/** Render bundled Markdown without HTML or arbitrary URL execution. */
export function DeveloperDocument({content}:{content:string}) {
 const [,setParams]=useSearchParams();
 function inline(value:string):React.ReactNode[]{return value.split(/(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*)/g).map((part,i)=>{
  if(part.startsWith('`'))return <code key={i}>{part.slice(1,-1)}</code>;
  if(part.startsWith('**'))return <strong key={i}>{part.slice(2,-2)}</strong>;
  const link=/^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
  if(link){const id=link[2].replace(/\.md(?:#.*)?$/,'');const known=guides.some(g=>g.id===id)||id==='start';return known?<a key={i} href={`?section=${id==='start'?'start':`guides&guide=${id}`}`} onClick={e=>{e.preventDefault();setParams(id==='start'?{section:'start'}:{section:'guides',guide:id});}}>{link[1]}</a>:<span key={i}>{link[1]}</span>;}
  return part;
 });}
 const blocks=content.trim().split(/(```[^\n]*\n[\s\S]*?\n```)/g).filter(Boolean);
 return <article className="developer-document">{blocks.flatMap((block,i)=>{
  if(block.startsWith('```'))return <Code key={i}>{block.replace(/^```[^\n]*\n/,'').replace(/\n```$/,'')}</Code>;
  return block.trim().split(/\n\s*\n/).filter(Boolean).map((paragraph,j)=>{
   const key=`${i}-${j}`,lines=paragraph.split('\n');
   if(paragraph.startsWith('# '))return <h2 key={key}>{inline(paragraph.slice(2))}</h2>;
   if(paragraph.startsWith('## '))return <h3 key={key}>{inline(paragraph.slice(3))}</h3>;
   if(paragraph.startsWith('### '))return <h4 key={key}>{inline(paragraph.slice(4))}</h4>;
   if(lines.length>1&&lines[0].startsWith('|')&&/^\|[\s:|+-]+\|$/.test(lines[1])){
    const cells=(line:string)=>line.slice(1,-1).split('|').map(cell=>cell.trim());
    return <div className="developer-document-table" key={key}><table><thead><tr>{cells(lines[0]).map((cell,k)=><th key={k}>{inline(cell)}</th>)}</tr></thead><tbody>{lines.slice(2).map((line,k)=><tr key={k}>{cells(line).map((cell,n)=><td key={n}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>;
   }
   if(lines.every(line=>/^[-*] /.test(line)))return <ul key={key}>{lines.map((line,k)=><li key={k}>{inline(line.slice(2))}</li>)}</ul>;
   if(lines.every(line=>/^\d+\. /.test(line)))return <ol key={key}>{lines.map((line,k)=><li key={k}>{inline(line.replace(/^\d+\. /,''))}</li>)}</ol>;
   return <p key={key}>{inline(paragraph)}</p>;
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
function DownloadsPage({employee=false}:{employee?:boolean}){
 const request=employee?employeeRequest:adminRequest;
 const [data,setData]=useState<Downloads|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[serial,setSerial]=useState(0);
 useEffect(()=>{const c=new AbortController();setError('');request<Downloads>('/developer/downloads',{signal:c.signal}).then(setData).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[serial,employee]);
 async function download(id:string,name:string){setBusy(id);setError('');try{const response=await fetch(`/api/${employee?'employee':'admin'}/developer/downloads/${id}`,{credentials:'same-origin'});if(!response.ok)throw Error('下载失败，请核对登录状态并重试。');saveFile(name,await response.blob(),'application/gzip');}catch(e){setError(e instanceof Error?e.message:'下载失败');}finally{setBusy('');}}
 return <><div className="developer-intro"><h2>Skill 与工具</h2><p>从完整 Skill 包开始：内含开发指引、SDK、CLI 和建项目脚本。Agent 可据此开发、测试并打包应用。开发机器需要 Node.js 22+、npm，普通依赖需要网络或缓存。</p></div>{error&&<p role="alert" className="afc-error">{error} <Button variant="secondary" size="sm" onClick={()=>setSerial(v=>v+1)}>重新读取</Button></p>}{!data&&!error&&<p role="status">正在读取下载清单…</p>}{data&&!data.available&&<p>此环境尚未构建开发资料；平台维护者需执行 npm run build:sdk、npm run build:cli、npm run build:developer。</p>}
 {data?.available&&<><p className="afc-muted">资料版本 v{data.version} · 当前界面 v{metadata.version}</p>{data.version!==metadata.version&&<p role="alert">前后端版本不一致，请核对平台部署版本后使用。</p>}<div className="developer-download-grid">{[...data.downloads].sort((a,b)=>Number(b.id==='skill')-Number(a.id==='skill')).map(item=><section className="admin-card" key={item.id}><h3>{item.title}{item.id==='skill'?' · 推荐起点':''}</h3><p>{item.id==='skill'?'一包包含指引、参考文档、SDK、CLI 和建项目脚本。':item.id==='sdk'||item.id==='cli'?'完整 Skill 已包含此工具，也可单独下载更新已有项目。':'可单独查阅或用于参考。'}</p><p>{item.fileName}</p><p className="afc-muted">{(item.bytes/1024).toFixed(0)} KiB</p><details><summary>SHA-256</summary><code>{item.sha256}</code></details><Button variant="secondary" disabled={!!busy} onClick={()=>void download(item.id,item.fileName)}>{busy===item.id?'下载中…':'下载'}</Button></section>)}</div></>}
 <section className="developer-document"><h3>让 Agent 开始开发</h3><p>解压 Skill 包，安装其中的 metro-app-development 目录到 Agent 支持的技能目录，或让它直接读取 SKILL.md。</p><Code>{'请读取 /absolute/path/metro-app-development/SKILL.md。\n使用包内工具创建应用，按统一接口契约开发，完成测试、检查和 .mopkg 打包。'}</Code><h3>连接当前平台</h3><p>本地开发和打包无需凭证。读取真实目录或在线获取工具时，在“我的凭证”创建密钥并在本机设置 MOP_DEV_KEY。正式应用通过平台身份调用接口。</p><Code>{`# 将平台根地址设为 MOP_URL，密钥设为 MOP_DEV_KEY\n# 当前页面所在地址：${window.location.origin}\ncurl --fail -H "Authorization: Bearer $MOP_DEV_KEY" "$MOP_URL/api/developer/downloads"\ncurl --fail -H "Authorization: Bearer $MOP_DEV_KEY" "$MOP_URL/api/developer/catalog"`}</Code><p>清单提供版本和 SHA-256。完整安装、测试与跨应用示例见“开发与改造”。</p></section></>;

}
export default function DeveloperPage({employee=false}:{employee?:boolean}){
 const tabs:readonly (readonly [string,string])[]=employee?[...sections,['directory','公共数据'],['interfaces','应用接口'],['keys','我的凭证']]:sections;
 const [params,setParams]=useSearchParams(),section=tabs.some(([id])=>id===params.get('section'))?params.get('section')!:'start';
 const selectedGuide=guides.find(g=>g.id===params.get('guide'))??guides[0];
 return <div className="developer-center"><div className="admin-heading"><div><h1>开发者中心</h1><p className="afc-muted">平台 v{metadata.version}</p></div></div><nav className="developer-tabs" aria-label="开发者中心导航">{tabs.map(([id,title])=><Button key={id} shape="rounded" size="sm" variant={section===id?'primary':'ghost'} aria-pressed={section===id} onClick={()=>setParams({section:id})}>{title}</Button>)}</nav>
 {section==='start'&&<DeveloperDocument content={start}/>}
 {section==='sdk'&&<PlatformSdk/>}{section==='downloads'&&<DownloadsPage employee={employee}/>}
 {employee&&section==='directory'&&<PublicDirectories/>}{employee&&section==='interfaces'&&<ApplicationInterfaces/>}{employee&&section==='keys'&&<DeveloperKeys/>}
 {section==='guides'&&<div className="developer-guide-layout"><nav aria-label="开发指南"><div className="developer-guide-links">{guides.map(guide=><Button key={guide.id} shape="rounded" variant={guide.id===selectedGuide.id?'primary':'ghost'} aria-pressed={guide.id===selectedGuide.id} onClick={()=>setParams({section:'guides',guide:guide.id})}>{guide.title}</Button>)}</div></nav><DeveloperDocument content={selectedGuide.content}/></div>}
 </div>;
}
