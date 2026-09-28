import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {migration} from './schema.mjs';

const root=fileURLToPath(new URL('.',import.meta.url)),out=root+'dist/';
await mkdir(out,{recursive:true});
for(const [entry,file,platform,format] of [['entry.mjs','entry.cjs','node','cjs'],['ui.jsx','ui.js','browser','iife']]){
 const result=await build({entryPoints:[root+entry],outfile:out+file,bundle:true,platform,format,target:platform==='node'?'node22':'es2022',metafile:true,minify:true,define:{'process.env.NODE_ENV':'"production"'}});
 if(Object.keys(result.metafile.inputs).some(path=>path.includes('server/')||path.includes('src/app-platform/')))throw Error('PLATFORM_INTERNAL_IMPORT');
}
await writeFile(out+'migration-001.json',JSON.stringify(migration,null,2)+'\n');
const artifacts=[];
for(const [id,kind,path] of [['backend','backend','entry.cjs'],['frontend','frontend','ui.js'],['schema','migration','migration-001.json']]){
 const bytes=await readFile(out+path);artifacts.push({id,kind,path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const pkg=JSON.parse(await readFile(root+'package.json','utf8'));
const permissionCodes=[['read','查看本部门计划'],['fill','填报本人计划'],['review','归口审核计划'],['manage','管理周期与计划']];
const permissions=permissionCodes.map(([code,description])=>({code:`app.huicetong.${code}`,description,scopeKinds:['self','workgroup','department','organizations','all']}));
const apiPermissions={session:'read',members:'read','cycle-list':'read','cycle-get':'read','cycle-create':'manage','category-list':'read','category-upsert':'manage','item-list':'read','item-get':'read','item-create':'fill','item-update':'fill'};
const exposedRead=new Set(['cycle-list','cycle-get','category-list','item-list','item-get']);
const exposedWrite=new Set(['cycle-create','category-upsert']);
const api=Object.entries(apiPermissions).map(([id,permission])=>({id,method:'POST',path:`/${id}`,handler:id,permission:`app.huicetong.${permission}`,...(['session','item-create','item-update'].includes(id)?{businessEntry:true}:{businessPermission:`app.huicetong.${permission}`}),...((exposedRead.has(id)||exposedWrite.has(id))?{expose:{contractVersion:'1.0',mode:exposedRead.has(id)?'read':'write'}}:{})}));
const pages=[['items','/','计划条目'],['categories','/categories','分类字典']];
const manifest={manifestVersion:'1.0',id:'huicetong',version:pkg.version,name:'慧策通·计划督办',icon:JSON.parse(await readFile(root+'icon.json','utf8')),description:'月度工作计划编制与督办',publisherId:'metro-apps',compatibility:{platform:{minInclusive:'0.22.0',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:['platform.app_data.read','platform.app_data.write','platform.people.read'],defined:permissions},ui:{mode:'sandbox',entryArtifactId:'frontend',clientRouting:true},backend:{mode:'isolated',runtime:'node',entryArtifactId:'backend',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}},health:{path:'/health',timeoutSeconds:1},storage:{mode:'managed',migrations:[{id:'initial',artifactId:'schema'}]},routes:pages.map(([id,path])=>({id,path,permission:'app.huicetong.read'})),navigation:pages.map(([id,_path,label],order)=>({id,routeId:id,label,order})),api,events:{publish:[],subscribe:[]},jobs:[],tools:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},artifacts};
await writeFile(out+'manifest.json',JSON.stringify(manifest,null,2)+'\n');
