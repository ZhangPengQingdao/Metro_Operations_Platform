#!/usr/bin/env node
// Run from a downloaded Skill bundle. Only creates a new, empty application directory.
import {readFile,mkdir,mkdtemp,readdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,join,basename} from 'node:path';
import {tmpdir} from 'node:os';
const skillRoot=fileURLToPath(new URL('../',import.meta.url));
const run=(command,args,cwd)=>{const r=spawnSync(command,args,{cwd,stdio:'inherit',shell:false});if(r.error)throw r.error;if(r.status!==0)throw Error(`${command} exited ${r.status}`);};
async function main(){
 const [target,name,...extra]=process.argv.slice(2);
 if(!target||extra.length)throw Error('Usage: node scripts/create-app.mjs <empty-project-directory> [application-name]');
 if(Number(process.versions.node.split('.')[0])<22)throw Error('Node.js 22+ required');
 const project=resolve(target);
 let existing=[];try{existing=await readdir(project);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(existing.length)throw Error('Project directory must be empty; existing projects must install the SDK/CLI explicitly.');
 const metadata=JSON.parse(await readFile(join(skillRoot,'tools/toolchain.json'),'utf8'));
 if(!/^\d+\.\d+\.\d+$/.test(metadata.version))throw Error('Invalid toolchain version');
 for(const id of ['sdk','cli']){
  const asset=metadata.downloads.find(item=>item.id===id);
  if(!asset||asset.fileName!==`metro-platform-${id}-${metadata.version}.tgz`)throw Error(`Invalid ${id} archive`);
  const bytes=await readFile(join(skillRoot,'tools',asset.fileName));
  if(bytes.length!==asset.bytes||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error(`${id} archive checksum mismatch`);
 }
 const runtime=await mkdtemp(join(tmpdir(),'mop-toolchain-'));
 try{
  run('npm',['install','--prefix',runtime,'--no-audit','--no-fund',join(skillRoot,'tools',`metro-platform-cli-${metadata.version}.tgz`)],skillRoot);
  run(process.execPath,[join(runtime,'node_modules/@metro/platform-cli/dist/cli.mjs'),'init',project,'--name',name??basename(project)],skillRoot);
  const local=join(project,'.mop/toolchain');await mkdir(local,{recursive:true});
  const pkg=JSON.parse(await readFile(join(project,'package.json'),'utf8'));
  for(const id of ['sdk','cli']){
   const filename=`metro-platform-${id}-${metadata.version}.tgz`;
   await copyFile(join(skillRoot,'tools',filename),join(local,filename));
   pkg[id==='sdk'?'dependencies':'devDependencies'][`@metro/platform-${id}`]=`file:.mop/toolchain/${filename}`;
  }
  await writeFile(join(project,'package.json'),JSON.stringify(pkg,null,2)+'\n');
  run('npm',['install','--no-audit','--no-fund'],project);
  console.log(`Ready: ${project}\nRun npm test, npm run check and npm run build in that directory.\nTool archives are in ignored .mop/toolchain; restore them from this version of the Skill on another machine.`);
 }finally{await rm(runtime,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
