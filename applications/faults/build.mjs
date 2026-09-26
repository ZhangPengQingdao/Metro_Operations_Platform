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
const permissions=[['read','查看故障记录'],['create','新增故障记录'],['update','编辑和处置故障'],['export','导出故障记录'],['delete','作废故障记录']].map(([code,description])=>({code:'app.faults.'+code,description,scopeKinds:['self','workgroup','department','organizations','all']}));
const api=['session','catalog','list','detail','create','update','delete','export'].map(id=>({id,method:'POST',path:`/${id}`,handler:id,permission:'app.faults.'+({session:'read',catalog:'read',list:'read',detail:'read'}[id]??id),...(id==='session'||id==='catalog'?{businessEntry:true}:{businessPermission:'app.faults.'+({list:'read',detail:'read'}[id]??id)})}));
const manifest={manifestVersion:'1.0',id:'faults',version:pkg.version,name:'故障记录',description:'登记、查询、处置与导出设备故障',publisherId:'metro-apps',compatibility:{platform:{minInclusive:'0.13.0',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:['platform.app_data.read','platform.app_data.write','platform.people.read','platform.locations.read'],defined:permissions},ui:{mode:'sandbox',entryArtifactId:'frontend',downloads:true},backend:{mode:'isolated',runtime:'node',entryArtifactId:'backend',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}},health:{path:'/health',timeoutSeconds:1},storage:{mode:'managed',migrations:[{id:'initial',artifactId:'schema'}]},routes:[{id:'records',path:'/',permission:'app.faults.read'}],navigation:[{id:'records',routeId:'records',label:'故障记录',order:0}],api,events:{publish:[],subscribe:[]},jobs:[],tools:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},artifacts};
await writeFile(out+'manifest.json',JSON.stringify(manifest,null,2)+'\n');
