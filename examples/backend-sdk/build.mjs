import {build,context} from 'esbuild';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('.',import.meta.url)),out=join(root,'dist');
const watch=process.argv.includes('--watch');if(process.argv.slice(2).some(arg=>arg!=='--watch'))throw Error('Unsupported build argument');
await mkdir(out,{recursive:true});
const options={entryPoints:[join(root,'entry.mjs')],outfile:join(out,'entry.cjs'),bundle:true,format:'cjs',platform:'node',target:'node22',metafile:true,
 plugins:[{name:'manifest',setup(builder){
  builder.onStart(()=>rm(join(out,'manifest.json'),{force:true}));
  builder.onEnd(async result=>{
   if(result.errors.length)return;
   if(Object.keys(result.metafile.inputs).some(path=>path.includes('server/')||path.includes('src/app-platform/')))throw Error('Platform internal import');
   const bytes=await readFile(join(out,'entry.cjs'));
   const manifest={manifestVersion:'1.0',id:'sdk-backend-sample',version:'1.0.0',name:'SDK backend sample',description:'Non-business Node backend',publisherId:'afc-examples',compatibility:{platform:{minInclusive:'0.0.1-alpha.54',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:['sample.echo.use'],defined:[]},ui:{mode:'none'},backend:{mode:'isolated',runtime:'node',entryArtifactId:'entry',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}},health:{path:'/health',timeoutSeconds:1},storage:{mode:'none'},routes:[],navigation:[],api:[{id:'echo',method:'POST',path:'/echo',handler:'echo',permission:'sample.echo.use'}],events:{publish:[],subscribe:[]},jobs:[],tools:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},artifacts:[{id:'entry',kind:'backend',path:'entry.cjs',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
   await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  });
 }}]};
if(watch){const builder=await context(options);await builder.watch();const stop=()=>void builder.dispose();process.once('SIGINT',stop);process.once('SIGTERM',stop);}else await build(options);
