import {mkdir,readFile,writeFile,cp,mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {PLATFORM_APP_OPERATIONS,PLATFORM_SDK_MODULES,APP_INTEGRATION_ERRORS} from '../packages/platform-sdk/dist/app-contracts.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const output=join(root,'server/developer-assets');
await mkdir(output,{recursive:true});
const staging=await mkdtemp(join(tmpdir(),'mop-developer-'));
const run=(cmd,args,cwd=root)=>{const result=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(result.status!==0)throw Error(`${cmd} failed: ${result.stderr}`);return result.stdout;};
const downloads=[];
const record=async(id,title,fileName)=>{const bytes=await readFile(join(output,fileName));downloads.push({id,title,fileName,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});};
try{
 for(const [name,title] of [['sdk','平台 SDK'],['cli','开发 CLI']]){
  const packed=JSON.parse(run('npm',['pack','--cache',join(staging,'npm-cache'),'--workspace',`@metro/platform-${name}`,'--ignore-scripts','--json','--pack-destination',output]));
  await record(name,title,packed[0].filename);
 }
 const sdkReference=`# 平台公开能力参考\n\n平台版本 ${version}。这是版本契约，不代表实例已配置或已授权。\n\n`+PLATFORM_APP_OPERATIONS.map(op=>`## ${op.title}\n\n操作：${op.id}\n\n导入：${op.entrypoint}\n\n调用：${op.call}\n\n执行位置：${op.execution}；性质：${op.mode}；权限：${op.permission}\n\n参数：${op.input}\n\n返回：${op.output}\n\n限制：${op.constraints}\n\n参数示例：\n\n\`\`\`json\n${JSON.stringify(op.example,null,2)}\n\`\`\`\n`).join('\n')+'\n## 常见错误\n\n'+APP_INTEGRATION_ERRORS.map(e=>`${e.code}：${e.description}`).join('\n\n');
 await writeFile(join(staging,'sdk-modules.md'),PLATFORM_SDK_MODULES.map(m=>`${m.path}: ${m.description}`).join('\n\n'));
 await cp(join(root,'docs/developer'),join(staging,'developer-docs'),{recursive:true});
 await cp(join(staging,'sdk-modules.md'),join(staging,'developer-docs/sdk-modules.md'));
 await writeFile(join(staging,'developer-docs/platform-sdk.md'),sdkReference);
 await writeFile(join(staging,'developer-docs/platform-sdk.json'),JSON.stringify({version,operations:PLATFORM_APP_OPERATIONS,modules:PLATFORM_SDK_MODULES,errors:APP_INTEGRATION_ERRORS},null,2)+'\n');
 await writeFile(join(staging,'developer-docs/VERSION'),version+'\n');
 // Skill: the same SKILL.md that `mop-app init` writes into new projects, plus the offline references.
 await mkdir(join(staging,'metro-app-development'));
 await cp(join(root,'packages/platform-cli/templates/v2/skill/SKILL.md'),join(staging,'metro-app-development/SKILL.md'));
 await cp(join(staging,'developer-docs'),join(staging,'metro-app-development/references'),{recursive:true});
 // Example: a fresh project from the CLI template (app.json, icon, page, API, migration, tests).
 run(process.execPath,[join(root,'packages/platform-cli/dist/cli.mjs'),'init','example-app','--id','example-app','--name','示例应用'],staging);
 for(const [id,title,folder] of [['docs','离线开发文档','developer-docs'],['skill','应用开发 Agent Skill','metro-app-development'],['example','应用项目示例','example-app']]){
  const fileName=`metro-${id}-${version}.tar.gz`;
  run('tar',['-czf',join(output,fileName),'-C',staging,folder]);
  await record(id,title,fileName);
 }
 await writeFile(join(output,'index.json'),JSON.stringify({version,downloads},null,2)+'\n');
 // Keep only this build's explicit distribution files.
 const keep=new Set(['index.json',...downloads.map(d=>d.fileName)]);
 for(const name of await readdir(output))if(!keep.has(name))await rm(join(output,name),{force:true});
 console.log(`Developer assets ${version}: ${downloads.length} files`);
}finally{await rm(staging,{recursive:true,force:true});}
