import {build} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url)),out=root+'dist/';await mkdir(out,{recursive:true});
for(const [entry,file,platform,format] of [['entry.mjs','entry.cjs','node','cjs'],['ui.jsx','ui.js','browser','iife']]){
 const result=await build({entryPoints:[root+entry],outfile:out+file,bundle:true,platform,format,target:platform==='node'?'node22':'es2022',metafile:true,minify:true,define:{'process.env.NODE_ENV':'"production"'}});
 if(Object.keys(result.metafile.inputs).some(path=>path.includes('server/')||path.includes('src/app-platform/')))throw Error('PLATFORM_INTERNAL_IMPORT');
}
await copyFile(root+'migration-001.json',out+'migration-001.json');
const artifacts=[];for(const [id,kind,path] of [['backend','backend','entry.cjs'],['frontend','frontend','ui.js'],['schema','migration','migration-001.json']]){const bytes=await readFile(out+path);artifacts.push({id,kind,path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
const pkg=JSON.parse(await readFile(root+'package.json','utf8'));
const permissions=[['read','查看签字任务',['self','workgroup','department','organizations','all']],['create','创建签字任务',['workgroup','department','organizations','all']],['sign','本人签字',['self']]].map(([code,description,scopeKinds])=>({code:'app.signatures.'+code,description,scopeKinds}));
const pages=[['list','/','签字列表','read'],['templates','/templates','签字模板','create']];
const api=['session','templates','members','list','detail','evidence','create','sign'].map(id=>({id,method:'POST',path:`/${id}`,handler:id,permission:'app.signatures.'+({create:'create',sign:'sign',templates:'create',members:'create'}[id]??'read'),...(['session','list','detail','evidence','members'].includes(id)?{businessEntry:true}:{businessPermission:'app.signatures.'+({templates:'create',create:'create',sign:'sign'}[id]??'read')})}));
const manifest={manifestVersion:'1.0',id:'signatures',version:pkg.version,name:'在线签字',description:'四种业务模板、签字列表与本人电子签名',publisherId:'metro-apps',compatibility:{platform:{minInclusive:'0.21.0',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:['platform.app_data.read','platform.app_data.write','platform.people.read','platform.notifications.create','platform.notifications.manage','platform.signatures.create','platform.signatures.read','platform.signatures.sign'],defined:permissions},ui:{mode:'sandbox',entryArtifactId:'frontend',clientRouting:true},backend:{mode:'isolated',runtime:'node',entryArtifactId:'backend',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}},health:{path:'/health',timeoutSeconds:1},storage:{mode:'managed',migrations:[{id:'initial',artifactId:'schema'}]},routes:[...pages.map(([id,path,_label,permission])=>({id,path,permission:'app.signatures.'+permission})),{id:'sign-entry',path:'/sign',permission:'app.signatures.sign'}],navigation:pages.map(([id,_path,label],order)=>({id,routeId:id,label,order})),api,events:{publish:[],subscribe:[]},jobs:[],tools:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},artifacts};
await writeFile(out+'manifest.json',JSON.stringify(manifest,null,2)+'\n');
