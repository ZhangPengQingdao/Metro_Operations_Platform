import {build} from 'esbuild';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import config from './app.json' with {type:'json'};
const root=fileURLToPath(new URL('.',import.meta.url)),out=root+'dist/';
await mkdir(out,{recursive:true});await rm(out+'manifest.json',{force:true});
for(const [source,path,platform,format] of [['ui.jsx','ui.js','browser','iife'],['entry.mjs','entry.cjs','node','cjs']]){
 const result=await build({entryPoints:[root+source],outfile:out+path,bundle:true,platform,format,target:platform==='node'?'node22':'es2022',minify:true,metafile:true,define:{'process.env.NODE_ENV':'"production"'}});
 if(Object.keys(result.metafile.inputs).some(path=>/server\/|src\/app-platform\//.test(path)))throw Error('PLATFORM_INTERNAL_IMPORT');
}
const artifacts=[];for(const [id,kind,path] of [['frontend','frontend','ui.js'],['backend','backend','entry.cjs']]){const data=await readFile(out+path);artifacts.push({id,kind,path,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});}
const permission=`app.${config.id}.read`;
const manifest={manifestVersion:'1.0',...config,description:'公开 SDK 标准应用示例',icon:{paths:['M4 4h16v16H4z','M8 8h8M8 12h8M8 16h4']},compatibility:{platform:{minInclusive:'0.24.0',maxExclusive:'1.0.0'},capabilities:[],applications:[]},permissions:{requested:['platform.people.read'],defined:[{code:permission,description:'查看当前工班人员',scopeKinds:['workgroup','department','organizations','all']}]},ui:{mode:'sandbox',entryArtifactId:'frontend',clientRouting:true},backend:{mode:'isolated',runtime:'node',entryArtifactId:'backend',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}},health:{path:'/health',timeoutSeconds:1},storage:{mode:'none'},routes:[{id:'home',path:'/',permission}],navigation:[{id:'home',label:'工班人员',routeId:'home',order:0}],api:[{id:'members',method:'POST',path:'/members',handler:'members',permission,businessPermission:permission}],events:{publish:[],subscribe:[]},jobs:[],tools:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},artifacts};
await writeFile(out+'manifest.json',JSON.stringify(manifest,null,2)+'\n');
