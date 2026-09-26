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
const permissions=[['read','查看检修计划'],['create','新增检修计划'],['update','编辑和完成检修'],['export','导出检修完成情况'],['delete','作废未完成计划']].map(([code,description])=>({code:`app.maintenance.${code}`,description,scopeKinds:['self','workgroup','department','organizations','all']}));
const api=['session','catalog','list','detail','create','update','delete','export'].map(id=>({id,method:'POST',path:`/${id}`,handler:id,permission:`app.maintenance.${({session:'read',catalog:'read',list:'read',detail:'read'}[id]??id)}`,...(id==='session'||id==='catalog'?{businessEntry:true}:{businessPermission:`app.maintenance.${({list:'read',detail:'read'}[id]??id)}`})}));
const manifest={manifestVersion:'1.0',id:'maintenance',version:pkg.version,name:'检修管理',description:'计划、派工、完成与检修归档',publisherId:'metro-apps',compatibility:{platform:{minInclusive:'0.13.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:['platform.app_data.read','platform.app_data.write','platform.people.read','platform.locations.read','platform.assets.read'],defined:permissions},ui:{mode:'sandbox',entryArtifactId:'frontend',downloads:true},backend:{mode:'isolated',runtime:'node',entryArtifactId:'backend',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}},health:{path:'/health',timeoutSeconds:1},storage:{mode:'managed',migrations:[{id:'initial',artifactId:'schema'}]},routes:[{id:'plans',path:'/',permission:'app.maintenance.read'}],navigation:[{id:'plans',routeId:'plans',label:'检修管理',order:0}],api,events:{publish:[],subscribe:[]},jobs:[],tools:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},artifacts};
await writeFile(out+'manifest.json',JSON.stringify(manifest,null,2)+'\n');
