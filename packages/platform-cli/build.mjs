import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {chmod, cp, rm, writeFile} from 'node:fs/promises';
const entry=fileURLToPath(new URL('./src/cli.ts',import.meta.url)),output=fileURLToPath(new URL('./dist/cli.mjs',import.meta.url));
await rm(new URL('./dist/',import.meta.url),{recursive:true,force:true});
// esbuild is the only runtime dependency (native binary, used by `mop-app build`); everything else is bundled.
await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',target:'node22',format:'esm',banner:{js:'#!/usr/bin/env node'},sourcemap:false,legalComments:'inline',metafile:true,external:['esbuild']}).then(result=>{
 if(Object.keys(result.metafile.outputs).some(path=>result.metafile.outputs[path].imports.some(item=>item.external&&!item.path.startsWith('node:')&&item.path!=='esbuild')))throw Error('CLI_RUNTIME_DEPENDENCY_NOT_BUNDLED');
});
await chmod(output,0o755);

// Application model v2 project template (mop-app init).
await cp(new URL('./templates/v2/',import.meta.url),new URL('./dist/templates/v2/',import.meta.url),{recursive:true});

// Keep the generated project's Skill usable without a platform checkout.
await cp(new URL('../../docs/developer/',import.meta.url),new URL('./dist/templates/v2/skill/references/',import.meta.url),{recursive:true});

const {PLATFORM_APP_OPERATIONS}=await import('../platform-sdk/dist/app-contracts.js');
await writeFile(new URL('./dist/templates/v2/skill/references/platform-sdk.md',import.meta.url),'# 平台 SDK 参考\n\n'+PLATFORM_APP_OPERATIONS.map(op=>`## ${op.title}\n\n入口：${op.entrypoint}\n\n调用：${op.call}\n\n权限：${op.permission}；执行位置：${op.execution}；模式：${op.mode}\n\n参数：${op.input}\n\n返回：${op.output}\n\n限制：${op.constraints}\n`).join('\n'));
