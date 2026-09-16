import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {withInstallUpload} from '../src/app-platform/install/wire.ts';
import {verifyAppDirectory} from '../src/app-platform/developer/signature.ts';
const exec=promisify(execFile);
test('packed CLI installs outside repository and exports a signed administrator upload without server dependencies',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mop-standalone-cli-'));
 try{
  const pkg=await exec('npm',['pack','--ignore-scripts','--json','--pack-destination',root],{cwd:new URL('../../packages/platform-cli/',import.meta.url)});
  const artifact=JSON.parse(pkg.stdout)[0];assert.ok(artifact.files.every((f:{path:string})=>!f.path.startsWith('src/')&&!f.path.includes('server/')));
  await writeFile(join(root,'package.json'),JSON.stringify({name:'independent-developer',private:true}));
  await exec('npm',['install','--ignore-scripts','--no-audit','--no-fund','--prefer-offline',join(root,artifact.filename)],{cwd:root});
  const cli=join(root,'node_modules/@metro/platform-cli/dist/cli.mjs');
  assert.ok(!(await readFile(cli,'utf8')).includes('/Users/'));
  const directory=join(root,'app');await cp(new URL('../../examples/app-sdk/dist/sandbox/',import.meta.url),directory,{recursive:true});
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  const keys=generateKeyPairSync('ed25519');await writeFile(join(root,'private.pem'),keys.privateKey.export({format:'pem',type:'pkcs8'}));await writeFile(join(root,'public.pem'),keys.publicKey.export({format:'pem',type:'spki'}));
  const run=(...args:string[])=>exec(process.execPath,[cli,...args],{cwd:root});
  const sdkPack=await exec('npm',['pack','--ignore-scripts','--json','--pack-destination',root],{cwd:new URL('../../packages/platform-sdk/',import.meta.url)});
  await exec('npm',['install','--ignore-scripts','--no-audit','--no-fund','--prefer-offline',join(root,JSON.parse(sdkPack.stdout)[0].filename)],{cwd:root});
  const bundlerVersion=JSON.parse(await readFile(new URL('../../node_modules/esbuild/package.json',import.meta.url),'utf8')).version;
  await exec('npm',['install','--ignore-scripts','--no-audit','--no-fund','--prefer-offline',`esbuild@${bundlerVersion}`],{cwd:root});
  for(const mode of ['sandbox','trusted','backend']){
   await run('create',`new-${mode}`,`independent-${mode}`,mode,'publisher');
   const project=join(root,`new-${mode}`),pkg=JSON.parse(await readFile(join(project,'package.json'),'utf8'));
   assert.equal(pkg.dependencies['@metro/platform-sdk'],JSON.parse(sdkPack.stdout)[0].version);
   // Module resolution finds only the installed public SDK in this isolated parent.
   await exec(process.execPath,['--test','test.mjs'],{cwd:project});
   await exec(process.execPath,['build.mjs'],{cwd:project});
   await run('validate',join(project,'dist',mode==='backend'?'':mode));
   await assert.rejects(run('create',`new-${mode}`,'another-app',mode,'publisher'));
  }
  await run('validate','app');await run('sign','app','developer-key','private.pem','signature.json');await run('verify','app','signature.json','developer-key',manifest.publisherId,'public.pem');await run('export-upload','app','signature.json','upload.json');
  const body=JSON.parse(await readFile(join(root,'upload.json'),'utf8'));
  const verified=await withInstallUpload(body,join(root,'uploads'),input=>verifyAppDirectory(input.directory,input.signatureFile,{keyId:'developer-key',publisherId:manifest.publisherId,publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),revoked:false}));
  assert.equal(verified.manifest.id,manifest.id);
  await assert.rejects(run('export-upload','app','signature.json','upload.json')); // no accidental replacement
 }finally{await rm(root,{recursive:true,force:true});}
});
