import {resolve} from 'node:path';
import metadata from '../package.json';
import {buildProject,checkProject,CliError,devProject,initProject} from './v2.js';

const USAGE_V2=`mop-app — 运管平台应用工具

  mop-app init <目录> [--id <应用ID>] [--name <应用名称>]   新建应用项目
  mop-app check [目录]                                     校验 app.json、图标、迁移与源码入口
  mop-app build [目录]                                     构建并输出 dist/<id>-<版本>.mopkg
  mop-app dev [目录] [--out <目录>]                         改动后自动构建到开发目录，本地平台自动安装`;

function option(args:string[],name:string){
 const index=args.indexOf(name);
 if(index<0)return undefined;
 const value=args[index+1];
 if(!value||value.startsWith('--'))throw new CliError(`${name} 需要一个值`);
 args.splice(index,2);return value;
}

async function runV2(command:string,args:string[]){
 try{
  if(command==='init'){
   const id=option(args,'--id'),name=option(args,'--name');
   if(args.length!==1)throw new CliError('用法：mop-app init <目录> [--id <应用ID>] [--name <应用名称>]');
   const result=await initProject(args[0]!,{id,name,templates:new URL('./templates/',import.meta.url),platformVersion:metadata.version});
   console.log(`已创建 ${result.name}（${result.id}）：${result.root}\n下一步：cd ${args[0]} && npm install && npm test && npm run build`);
  }else{
   if(args.length>1)throw new CliError(`用法：mop-app ${command} [目录]`);
   if(command==='check'){
    const result=await checkProject(args[0]??'.');
    for(const warning of result.warnings)console.warn(`提示：${warning}`);
    console.log(`检查通过：${result.manifest.name} ${result.manifest.version}`);
   }else{
    const result=await buildProject(args[0]??'.');
    for(const warning of result.warnings)console.warn(`提示：${warning}`);
    console.log(`已生成 ${result.output}（${(result.bytes/1024).toFixed(1)} KB，sha256 ${result.sha256}）`);
    for(const file of result.files)console.log(`  ${file.path}  ${file.bytes} B`);
   }
  }
  return 0;
 }catch(error){
  if(!(error instanceof CliError))throw error;
  console.error(`错误：${error.message}`);
  for(const issue of error.issues)console.error(`  ${issue.path}：${issue.message}`);
  return 1;
 }
}

const [command,...args]=process.argv.slice(2);
if(command==='dev'){
 try{
  const out=option(args,'--out')??process.env.MOP_DEV_APPS_DIR??'.mop/dev';
  if(args.length>1)throw new CliError('用法：mop-app dev [目录] [--out <目录>]');
  const time=()=>new Date().toLocaleTimeString();
  await devProject(args[0]??'.',{out,onEvent:event=>{
   if(event.type==='built')console.log(`[${time()}] 已构建 ${event.result.manifest.name} ${event.result.manifest.version} → ${event.target}`);
   else if(event.error instanceof CliError){console.error(`[${time()}] ${event.error.message}`);for(const issue of event.error.issues)console.error(`  ${issue.path}：${issue.message}`);}
   else console.error(`[${time()}] 构建失败：${event.error instanceof Error?event.error.message:String(event.error)}`);
  }});
  console.log(`正在监听改动（Ctrl+C 退出）。本地平台以 MOP_DEV_APPS_DIR=${resolve(out)} 启动即可自动安装。`);
 }catch(error){console.error(`错误：${error instanceof Error?error.message:String(error)}`);process.exit(1);}
}else if(command==='init'||command==='check'||command==='build'){
 // build loads server.js; exit explicitly so timers started at module load cannot keep the CLI alive.
 process.exit(await runV2(command,args).catch(error=>{console.error(`错误：${error instanceof Error?error.message:String(error)}`);return 1;}));
}
else{
 console.error(USAGE_V2);process.exitCode=command?2:0;
}
