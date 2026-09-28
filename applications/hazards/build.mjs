import {hazardPages} from './workspace.mjs';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createAppImageMigrationOperations} from '@metro/platform-sdk/app-files-backend';
const root=fileURLToPath(new URL('.',import.meta.url)),out=root+'dist/';await mkdir(out,{recursive:true});
for(const [entry,file,platform,format] of [['entry.mjs','entry.cjs','node','cjs'],['ui.jsx','ui.js','browser','iife']]){
 const result=await build({entryPoints:[root+entry],outfile:out+file,bundle:true,platform,format,target:platform==='node'?'node22':'es2022',metafile:true,minify:true,define:{'process.env.NODE_ENV':'"production"'}});
 if(Object.keys(result.metafile.inputs).some(path=>path.includes('server/')||path.includes('src/app-platform/')))throw Error('PLATFORM_INTERNAL_IMPORT');
}
const migration=JSON.parse(await readFile(root+'migration-001.json','utf8'));
migration.operations.push(...createAppImageMigrationOperations());
await writeFile(out+'migration-001.json',JSON.stringify(migration,null,2)+'\n');
const artifacts=[];for(const [id,kind,path] of [['backend','backend','entry.cjs'],['frontend','frontend','ui.js'],['schema','migration','migration-001.json']]){const bytes=await readFile(out+path);artifacts.push({id,kind,path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
const pkg=JSON.parse(await readFile(root+'package.json','utf8'));
const permissions=[['read','查看隐患记录'],['cases','查看闭环案例库'],['create','提报隐患'],['update','治理和完善隐患'],['review','复审并关闭隐患'],['photo','上传隐患留证照片']].map(([code,description])=>({code:'app.hazards.'+code,description,scopeKinds:['self','workgroup','department','organizations','all']}));
const permissionsFor={session:'read',catalog:'read',list:'read',detail:'read',cases:'cases',suggest:'create',create:'create',update:'update',close:'review','photo-begin':'photo','photo-part':'photo','photo-finish':'photo','photo-read':'read'};
const exposedRead=new Set(['list','detail','cases','photo-read']);
const exposedWrite=new Set(['create','update','close']);
const api=Object.keys(permissionsFor).map(id=>({id,method:'POST',path:`/${id}`,handler:id,permission:'app.hazards.'+permissionsFor[id],...(['session','catalog','photo-begin','photo-part','photo-finish'].includes(id)?{businessEntry:true}:{businessPermission:'app.hazards.'+permissionsFor[id]}),...((exposedRead.has(id)||exposedWrite.has(id))?{expose:{contractVersion:'1.0',mode:exposedRead.has(id)?'read':'write'}}:{})}));
const manifest={manifestVersion:'1.0',id:'hazards',version:pkg.version,name:'隐患提报 · 识隐',description:'隐患识别建议、提报、治理复审与闭环案例库',publisherId:'metro-apps',compatibility:{platform:{minInclusive:'0.22.0',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:['platform.app_data.read','platform.app_data.write','platform.locations.read','platform.people.read','platform.ai.complete'],defined:permissions},ui:{mode:'sandbox',entryArtifactId:'frontend',clientRouting:true},backend:{mode:'isolated',runtime:'node',entryArtifactId:'backend',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}},health:{path:'/health',timeoutSeconds:1},storage:{mode:'managed',migrations:[{id:'initial',artifactId:'schema'}]},routes:hazardPages.map(({id,path,permission})=>({id,path,permission})),navigation:hazardPages.map(({id,label},order)=>({id,routeId:id,label,order})),api,events:{publish:[],subscribe:[]},jobs:[],tools:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},artifacts};
await writeFile(out+'manifest.json',JSON.stringify(manifest,null,2)+'\n');
