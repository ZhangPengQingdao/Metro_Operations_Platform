import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createAppSandboxClient,createAppApiClient} from '@metro/platform-sdk/app-sandbox';
import {QueryList,TableHeader,TableBody,TableRow,TableHead,TableCell} from '@metro/platform-sdk/ui';
import {platformUiCss} from '@metro/platform-sdk/ui-styles';
import config from './app.json';
const script=document.currentScript,origin=script?.dataset.platformOrigin;
if(!origin)throw Error('PLATFORM_ORIGIN_REQUIRED');
const style=document.createElement('style');style.nonce=script.nonce;style.textContent=platformUiCss+'\nhtml,body{margin:0;background:transparent}main{padding:20px;color:var(--afc-color-ink)}@media(max-width:640px){main{padding:12px}}';document.head.append(style);
document.documentElement.classList.add('afc-theme-neutral');
const sandbox=createAppSandboxClient({appId:config.id,platformOrigin:origin,port:{parent:window.parent,send:(value,target)=>window.parent.postMessage(value,target),listen:listener=>{window.addEventListener('message',listener);return()=>window.removeEventListener('message',listener);}}});
const api=createAppApiClient(sandbox);
function App(){
 const [ready,setReady]=useState(false),[route,setRoute]=useState(decodeURIComponent(script.dataset.appRoute??'/'));
 const [search,setSearch]=useState(''),[rows,setRows]=useState([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{const off=sandbox.onRouteChange(setRoute),deadline=Date.now()+10000;const timer=setInterval(()=>{if(sandbox.ready()){clearInterval(timer);setReady(true);}else if(Date.now()>deadline){clearInterval(timer);setError('宿主连接未就绪，请重新打开应用');setLoading(false);}},25);return()=>{off();clearInterval(timer);};},[]);
 useEffect(()=>{if(!ready||route!=='/')return;let active=true;const controller=new AbortController();setLoading(true);setError('');const timer=setTimeout(async()=>{try{const reply=await api.invoke('members',{search},controller.signal);if(!reply.ok)throw Error(reply.error.code==='ACCESS_DENIED'?'没有当前工班的读取权限':'读取失败，请核对平台能力授权');if(active)setRows(reply.result.rows);}catch(e){if(active)setError(e.message);}finally{if(active)setLoading(false);}},250);return()=>{active=false;clearTimeout(timer);controller.abort();};},[ready,route,search]);
 return <main><h2>{config.name}</h2><p>使用平台身份、目录和共享组件。最多显示50人，可搜索缩小范围。</p>{route!=='/'?<p>页面不存在</p>:<QueryList pinActions={false} query={{showDateRange:false,searchValue:search,onSearchChange:setSearch,searchPlaceholder:'搜索姓名或工号'}} notice={error?<p role="alert">{error}</p>:loading?<p role="status">正在读取…</p>:undefined} emptyState={!loading&&!error&&!rows.length?'暂无人员':undefined}><TableHeader><TableRow><TableHead>姓名</TableHead><TableHead>工号</TableHead></TableRow></TableHeader><TableBody>{!loading&&!error&&rows.map(row=><TableRow key={row.id}><TableCell>{row.name}</TableCell><TableCell>{row.employeeNo}</TableCell></TableRow>)}</TableBody></QueryList>}</main>;
}
createRoot(document.getElementById('root')??document.body.appendChild(document.createElement('div'))).render(<App/>);
window.addEventListener('pagehide',()=>sandbox.close(),{once:true});
