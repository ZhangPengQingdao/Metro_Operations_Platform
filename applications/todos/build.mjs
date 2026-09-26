import {build} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('.',import.meta.url)),out=root+'dist/';
await mkdir(out,{recursive:true});await rm(out+'manifest.json',{force:true});
for(const [entry,file,platform,format] of [['entry.mjs','entry.cjs','node','cjs'],['ui.jsx','ui.js','browser','iife']]){
 const result=await build({entryPoints:[root+entry],outfile:out+file,bundle:true,platform,format,target:platform==='node'?'node22':'es2022',metafile:true,minify:true,define:{'process.env.NODE_ENV':'"production"'}});
 if(Object.keys(result.metafile.inputs).some(path=>path.includes('server/')||path.includes('src/app-platform/')))throw Error('PLATFORM_INTERNAL_IMPORT');
}
await copyFile(root+'migration-001.json',out+'migration-001.json');
const artifacts=[];
for(const [id,kind,path] of [['backend','backend','entry.cjs'],['frontend','frontend','ui.js'],['schema','migration','migration-001.json']]){
 const bytes=await readFile(out+path);artifacts.push({id,kind,path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const pkg=JSON.parse(await readFile(root+'package.json','utf8'));
const names={read:'查看待办',create:'发布普通待办',handle:'办理待办子项',manage:'修改及删除待办',recurring:'管理周期模板',score:'设置任务分值'};
const permissions=Object.entries(names).map(([name,description])=>({code:`app.todos.${name}`,description,scopeKinds:['read','handle','manage'].includes(name)?['self','workgroup','department','organizations','all']:['workgroup','department','organizations','all']}));
const api=['session','directory','list','detail','create-task','update-task','delete-task','handle-item','save-template','template-state','trigger'].map(id=>({id,method:'POST',path:`/${id}`,handler:id,permission:'app.todos.read',businessEntry:true}));
const manifest={manifestVersion:'1.0',id:'todos',version:pkg.version,name:'待办事项',icon:JSON.parse(await readFile(root+'icon.json','utf8')),description:'工班待办、车站和人员子项、周期自动任务',publisherId:'metro-apps',compatibility:{platform:{minInclusive:'0.11.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:['platform.app_data.read','platform.app_data.write','platform.people.read','platform.locations.read'],defined:permissions},ui:{mode:'sandbox',entryArtifactId:'frontend',clientRouting:true},backend:{mode:'isolated',runtime:'node',entryArtifactId:'backend',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}},health:{path:'/health',timeoutSeconds:1},storage:{mode:'managed',migrations:[{id:'initial',artifactId:'schema'}]},routes:[{id:'tasks',path:'/',permission:'app.todos.read'},{id:'recurring',path:'/recurring',permission:'app.todos.recurring'}],navigation:[{id:'tasks',routeId:'tasks',label:'待办事项',order:0},{id:'recurring',routeId:'recurring',label:'周期待办',order:1}],api,events:{publish:[],subscribe:[]},jobs:[],tools:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},artifacts};
await writeFile(out+'manifest.json',JSON.stringify(manifest,null,2)+'\n');
