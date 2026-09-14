import {build,context} from 'esbuild';
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('.',import.meta.url));
const watch=process.argv.includes('--watch');
if(process.argv.slice(2).some(arg=>arg!=='--watch'))throw Error('Unsupported build argument');
const contexts=[];
for(const mode of ['trusted','sandbox']){
 const out=join(root,'dist',mode);await mkdir(out,{recursive:true});
 const options={entryPoints:[join(root,mode,'entry.mjs')],outfile:join(out,'entry.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',external:mode==='trusted'?['react']:[],metafile:true,
 plugins:[{name:'verified-manifest',setup(builder){
 builder.onStart(async()=>{await rm(join(out,'manifest.json'),{force:true});});
 builder.onEnd(async result=>{
  if(result.errors.length){console.log(JSON.stringify({event:'build',mode,ok:false}));return;}
  if(Object.keys(result.metafile.inputs).some(path=>path.includes('server/')||path.includes('src/app-platform/')))throw Error('Application imported platform internals');
 const bytes=await readFile(join(out,'entry.js'));
 const manifest={manifestVersion:'1.0',id:`sdk-${mode}-sample`,version:'1.0.0',name:`SDK ${mode} sample`,description:'Independent no-business-data SDK example',publisherId:'afc-examples',
 compatibility:{platform:{minInclusive:'0.0.1-alpha.50',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:['sample.greeting.read'],defined:[]},ui:{mode,entryArtifactId:'entry'},backend:{mode:'none'},storage:{mode:'none'},routes:[{id:'home',path:'/',permission:'sample.greeting.read'}],navigation:[{id:'home',label:'Greeting',routeId:'home',order:0}],api:[],events:{publish:[],subscribe:[]},jobs:[],tools:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},artifacts:[{id:'entry',kind:'frontend',path:'entry.js',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
 await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({event:'build',mode,ok:true,sha256:manifest.artifacts[0].sha256}));
 });
 }}]};
 if(watch){const watcher=await context(options);contexts.push(watcher);await watcher.watch();}
 else await build(options);
}
if(watch){
 let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;await Promise.all(contexts.map(watcher=>watcher.dispose()));};
 process.once('SIGINT',()=>{void stop();});
 process.once('SIGTERM',()=>{void stop();});
}
