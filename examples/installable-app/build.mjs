import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const version=process.argv[2]??'1.0.0';
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Expected version x.y.z');
const backend=process.argv[3]==='--backend';
const root=new URL(`./dist/${backend?'backend-':''}${version}/`,import.meta.url);await mkdir(root,{recursive:true});
const script=`(()=>{const root=document.getElementById('app');const style=document.createElement('style');style.nonce=document.currentScript.nonce;style.textContent=':root{color-scheme:light dark}body{margin:0;padding:24px;font:14px/1.6 system-ui,sans-serif}h1{font-size:22px}button{font:inherit;border:1px solid #888;border-radius:999px;padding:8px 18px;background:transparent;color:inherit;cursor:pointer}';document.head.append(style);const title=document.createElement('h1');title.textContent='应用接入示例';const version=document.createElement('p');version.textContent='版本 ${version}';const output=document.createElement('p');output.textContent='已从签名安装包加载';const button=document.createElement('button');button.textContent='检查页面交互';button.onclick=()=>{output.textContent='页面交互正常 · ${version}'};root.append(title,version,output,button);})();`;
const bytes=Buffer.from(script);await writeFile(new URL('entry.js',root),bytes);
const manifest={manifestVersion:'1.0',id:'installation-sample',version,name:'应用接入示例',description:'用于验证签名安装、更新和页面装载',publisherId:'afc-examples',compatibility:{platform:{minInclusive:'0.0.1-alpha.50',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:[],defined:[]},ui:{mode:'sandbox',entryArtifactId:'entry'},backend:{mode:'none'},storage:{mode:'none'},routes:[{id:'home',path:'/'}],navigation:[{id:'home',label:'应用首页',routeId:'home',order:0}],api:[],events:{publish:[],subscribe:[]},jobs:[],tools:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},artifacts:[{id:'entry',kind:'frontend',path:'entry.js',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
if(backend){
 const source=Buffer.from(`const http=require('node:http');const server=http.createServer((req,res)=>{if(req.url!=='/health'){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'application/json'});res.end('{"status":"ready"}');});server.listen(8080,'127.0.0.1');process.on('SIGTERM',()=>server.close());`);
 await writeFile(new URL('backend.cjs',root),source);
 manifest.id='installation-backend-sample';manifest.name='独立后端接入示例';
 manifest.backend={mode:'isolated',runtime:'node',entryArtifactId:'backend',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}};
 manifest.health={path:'/health',timeoutSeconds:1};
 manifest.artifacts.push({id:'backend',kind:'backend',path:'backend.cjs',bytes:source.length,sha256:createHash('sha256').update(source).digest('hex')});
}
await writeFile(new URL('manifest.json',root),JSON.stringify(manifest,null,2)+'\n');
console.log(`Built installation-sample ${version}`);
