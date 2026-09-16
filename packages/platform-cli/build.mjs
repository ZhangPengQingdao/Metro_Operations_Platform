import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {chmod, mkdir, copyFile, rm} from 'node:fs/promises';
const entry=fileURLToPath(new URL('./src/cli.ts',import.meta.url)),output=fileURLToPath(new URL('./dist/cli.mjs',import.meta.url));
await rm(new URL('./dist/',import.meta.url),{recursive:true,force:true});
// Share the platform's package validator at build time; shipped CLI has no repository dependencies.
await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',target:'node22',format:'esm',banner:{js:'#!/usr/bin/env node'},sourcemap:false,legalComments:'inline',metafile:true}).then(result=>{
 if(Object.keys(result.metafile.outputs).some(path=>result.metafile.outputs[path].imports.some(item=>item.external&&!item.path.startsWith('node:'))))throw Error('CLI_RUNTIME_DEPENDENCY_NOT_BUNDLED');
});
await chmod(output,0o755);

// Ship only the template sources, never local builds or dependencies.
for (const [name, paths] of Object.entries({
 'app-sdk':['app.mjs','test.mjs','build.mjs','package.json','.gitignore','sandbox/entry.mjs','trusted/entry.mjs'],
 'backend-sdk':['app.mjs','test.mjs','build.mjs','package.json','.gitignore','entry.mjs','config.mjs'],
})) {
 for (const path of paths) {
  const target=new URL(`./dist/templates/${name}/${path === '.gitignore' ? 'gitignore.template' : path}`,import.meta.url);
  await mkdir(new URL('.',target),{recursive:true});
  await copyFile(new URL(`../../examples/${name}/${path}`,import.meta.url),target);
 }
}
