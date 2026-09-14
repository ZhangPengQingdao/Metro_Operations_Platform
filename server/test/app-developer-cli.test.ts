import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packAppDirectory, validateAppDirectory } from '../src/app-platform/developer/package.ts';

test('backend scaffold builds a self-contained Node artifact and packs without platform edits',async()=>{
 const {createAppProject}=await import('../src/app-platform/developer/scaffold.ts');
 const root=await mkdtemp(join(tmpdir(),'afc-backend-cli-'));
 try {
  const project=join(root,'backend');await createAppProject(project,'my-backend','backend','publisher');
  await symlink(fileURLToPath(new URL('../../node_modules',import.meta.url)),join(project,'node_modules'),'dir');
  const tests=spawnSync(process.execPath,['--test','test.mjs'],{cwd:project,encoding:'utf8'});assert.equal(tests.status,0,tests.stderr);
  const built=spawnSync(process.execPath,['build.mjs'],{cwd:project,encoding:'utf8'});assert.equal(built.status,0,built.stderr);
  const input=join(project,'dist');const validated=await validateAppDirectory(input);assert.equal(validated.manifest.id,'my-backend');assert.equal(validated.manifest.backend.mode,'isolated');
  assert.equal(validated.manifest.publisherId,'publisher');await packAppDirectory(input,join(root,'package'));
  assert.deepEqual((await readdir(join(root,'package'))).sort(),['entry.cjs','manifest.json']);
  const entry=await readFile(join(root,'package/entry.cjs'),'utf8');assert.ok(!entry.includes("require(\"@metro/platform-sdk"));
 }finally{await rm(root,{recursive:true,force:true});}
});

async function fixture(run: (root: string, input: string) => Promise<void>) {
 const root=await mkdtemp(join(tmpdir(),'afc-cli-'));
 const input=join(root,'input');
 try { await cp(new URL('../../examples/app-sdk/dist/trusted/',import.meta.url),input,{recursive:true});await run(root,input); }
 finally { await rm(root,{recursive:true,force:true}); }
}
test('validate and pack verified sample, excluding undeclared files and preserving existing output',async()=>fixture(async(root,input)=>{
 await writeFile(join(input,'secret.env'),'never-copy');
 const valid=await validateAppDirectory(input);assert.equal(valid.manifest.id,'sdk-trusted-sample');
 const output=join(root,'output');await packAppDirectory(input,output);
 assert.deepEqual((await readdir(output)).sort(),['entry.js','manifest.json']);
 assert.equal((await validateAppDirectory(output)).artifactBytes,valid.artifactBytes);
 await assert.rejects(packAppDirectory(input,output));
 assert.equal((await validateAppDirectory(output)).artifactBytes,valid.artifactBytes);
 await assert.rejects(packAppDirectory(input,join(input,'nested')),/OUTPUT_INSIDE_INPUT/);
}));
test('tampered, missing and symlink artifacts fail before output creation',async()=>fixture(async(root,input)=>{
 const entry=join(input,'entry.js');const original=await readFile(entry);
 const changed=Buffer.from(original);changed[0]=changed[0]===65?66:65;await writeFile(entry,changed);
 await assert.rejects(packAppDirectory(input,join(root,'bad')),/ARTIFACT_INTEGRITY_MISMATCH/);
 assert.deepEqual((await readdir(root)).sort(),['input']);
 await rm(entry);await assert.rejects(validateAppDirectory(input));
 await writeFile(join(root,'outside.js'),original);await symlink(join(root,'outside.js'),entry);
 await assert.rejects(validateAppDirectory(input),/NON_REGULAR_ARTIFACT/);
}));
test('reject invalid manifests, reserved output paths and oversized declared packages',async()=>fixture(async(_root,input)=>{
 const file=join(input,'manifest.json');const manifest=JSON.parse(await readFile(file,'utf8'));
 await writeFile(file,JSON.stringify({...manifest,unknown:true}));await assert.rejects(validateAppDirectory(input),/INVALID_MANIFEST/);
 manifest.artifacts[0].path='MANIFEST.JSON';await writeFile(file,JSON.stringify(manifest));await assert.rejects(validateAppDirectory(input),/PACKAGE_PATH_COLLISION/);
 manifest.artifacts[0].path='entry.js';manifest.artifacts[0].bytes=65*1024*1024;
 await writeFile(file,JSON.stringify(manifest));await assert.rejects(validateAppDirectory(input),/PACKAGE_TOO_LARGE/);
}));
test('CLI has machine-readable success and nonzero usage/failure without raw input leakage',async()=>fixture(async(_root,input)=>{
 const cli=fileURLToPath(new URL('../src/app-platform/developer/cli.ts',import.meta.url));
 const run=(args:string[])=>spawnSync(process.execPath,['--import','tsx',cli,...args],{encoding:'utf8'});
 const valid=run(['validate',input]);assert.equal(valid.status,0,valid.stderr);assert.equal(JSON.parse(valid.stdout).ok,true);
 assert.equal(run(['sign',input]).status,2);
 await writeFile(join(input,'manifest.json'),'private-secret');
 const failed=run(['validate',input]);assert.equal(failed.status,1);assert.ok(!failed.stderr.includes('private-secret'));assert.match(failed.stderr,/INVALID_MANIFEST/);
}));

test('create custom trusted and sandbox projects from accepted templates without overwrite',async()=>fixture(async(root)=>{
 const {createAppProject}=await import('../src/app-platform/developer/scaffold.ts');
 for(const mode of ['trusted','sandbox']){
  const output=join(root,mode);
  await createAppProject(output,`my-${mode}`,mode,'my-publisher');
  const pkg=JSON.parse(await readFile(join(output,'package.json'),'utf8'));assert.equal(pkg.name,`my-${mode}`);
  const build=await readFile(join(output,'build.mjs'),'utf8');assert.ok(build.includes(`id:"my-${mode}"`));assert.ok(build.includes('publisherId:"my-publisher"'));
  if(mode==='sandbox')assert.ok((await readFile(join(output,mode,'entry.mjs'),'utf8')).includes('appId:"my-sandbox"'));
  await assert.rejects(createAppProject(output,'other-app',mode,'publisher'));
  assert.equal(JSON.parse(await readFile(join(output,'package.json'),'utf8')).name,`my-${mode}`);
 }
 await assert.rejects(createAppProject(join(root,'invalid'),'../escape','sandbox','publisher'),/INVALID_CREATE_OPTIONS/);
}));
test('CLI create is executable and test propagates failures without running npm hooks',async()=>fixture(async(root)=>{
 const cli=fileURLToPath(new URL('../src/app-platform/developer/cli.ts',import.meta.url));
 const project=join(root,'new-project');
 const run=(args:string[])=>spawnSync(process.execPath,['--import','tsx',cli,...args],{encoding:'utf8'});
 const created=run(['create',project,'new-app','trusted','publisher']);assert.equal(created.status,0,created.stderr);
 await writeFile(join(project,'test.mjs'),"import test from 'node:test'; test('ok',()=>{});\n");
 assert.equal(run(['test',project]).status,0);
 await writeFile(join(project,'test.mjs'),"import test from 'node:test'; test('failure',()=>{throw Error('expected')});\n");
 assert.equal(run(['test',project]).status,1);
}));

test('dev rebuilds generated app, invalidates failed build and exits with child', {timeout:20000}, async()=>fixture(async(root)=>{
 const {createAppProject}=await import('../src/app-platform/developer/scaffold.ts');
 const {spawn}=await import('node:child_process');
 const project=join(root,'watch-app');await createAppProject(project,'watch-app','sandbox','publisher');
 await symlink(fileURLToPath(new URL('../../node_modules',import.meta.url)),join(project,'node_modules'),'dir');
 const cli=fileURLToPath(new URL('../src/app-platform/developer/cli.ts',import.meta.url));
 const child=spawn(process.execPath,['--import','tsx',cli,'dev',project],{stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
 const closed=new Promise(resolve=>child.once('close',resolve));
 const waitFor=async(predicate:()=>boolean)=>{
  const deadline=Date.now()+10000;
  while(!predicate()){
   if(Date.now()>deadline)throw Error(`watch timeout: ${stdout} ${stderr}`);
   await new Promise(resolve=>setTimeout(resolve,25));
  }
 };
 try {
  await waitFor(()=>stdout.includes('"ok":true'));
  const original=await readFile(join(project,'app.mjs'),'utf8');
  const before=await validateAppDirectory(join(project,'dist/sandbox'));
  stdout='';await writeFile(join(project,'app.mjs'),'export const = invalid syntax;');
  await waitFor(()=>stdout.includes('"ok":false'));
  await assert.rejects(validateAppDirectory(join(project,'dist/sandbox')));
  stdout='';await writeFile(join(project,'app.mjs'),original+'\nconsole.log("changed build");\n');
  await waitFor(()=>stdout.includes('"ok":true'));
  const after=await validateAppDirectory(join(project,'dist/sandbox'));
  assert.notEqual(after.manifest.artifacts[0].sha256,before.manifest.artifacts[0].sha256);
  child.kill('SIGTERM');
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('dev did not stop')),3000).unref())]);
  assert.equal(child.exitCode,0,stderr);
 } finally { if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;} }
}));

test('detached Ed25519 signature binds manifest and artifacts to an explicitly trusted publisher',async()=>fixture(async(root,input)=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const {signAppDirectory,verifyAppDirectory}=await import('../src/app-platform/developer/signature.ts');
 const keys=generateKeyPairSync('ed25519');
 const privateFile=join(root,'private.pem'),signatureFile=join(root,'signature.json');
 await writeFile(privateFile,keys.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
 const publicKeyPem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
 const trust={keyId:'key-one',publisherId:'afc-examples',publicKeyPem,revoked:false};
 await signAppDirectory(input,trust.keyId,privateFile,signatureFile);
 assert.equal((await verifyAppDirectory(input,signatureFile,trust)).manifest.id,'sdk-trusted-sample');
 await assert.rejects(signAppDirectory(input,trust.keyId,privateFile,signatureFile));
 await assert.rejects(verifyAppDirectory(input,signatureFile,{...trust,revoked:true}),/UNTRUSTED_PUBLISHER_KEY/);
 await assert.rejects(verifyAppDirectory(input,signatureFile,{...trust,publisherId:'different-publisher'}),/PACKAGE_SIGNATURE_MISMATCH/);
 const other=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString();
 await assert.rejects(verifyAppDirectory(input,signatureFile,{...trust,publicKeyPem:other}),/PACKAGE_SIGNATURE_MISMATCH/);
 const file=join(input,'manifest.json');const manifest=JSON.parse(await readFile(file,'utf8'));
 // Object serialization order and whitespace are not part of the semantic manifest signature.
 await writeFile(file,JSON.stringify(Object.fromEntries(Object.entries(manifest).reverse())));
 await verifyAppDirectory(input,signatureFile,trust);
 manifest.name='Changed signed metadata';await writeFile(file,JSON.stringify(manifest));
 await assert.rejects(verifyAppDirectory(input,signatureFile,trust),/PACKAGE_SIGNATURE_MISMATCH/);
}));
test('signature rejects tampered artifacts, embedded trust and unsupported private key algorithms',async()=>fixture(async(root,input)=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const {signAppDirectory,verifyAppDirectory}=await import('../src/app-platform/developer/signature.ts');
 const keys=generateKeyPairSync('ed25519');const key=join(root,'key.pem'),sig=join(root,'sig.json');
 await writeFile(key,keys.privateKey.export({format:'pem',type:'pkcs8'}));
 const trust={keyId:'key-one',publisherId:'afc-examples',publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),revoked:false};
 await signAppDirectory(input,trust.keyId,key,sig);
 const envelope=JSON.parse(await readFile(sig,'utf8'));
 await writeFile(sig,JSON.stringify({...envelope,publicKey:trust.publicKeyPem}));
 await assert.rejects(verifyAppDirectory(input,sig,trust),/INVALID_PACKAGE_SIGNATURE/);
 await writeFile(sig,JSON.stringify(envelope));
 const entry=join(input,'entry.js');const bytes=await readFile(entry);bytes[0]^=1;await writeFile(entry,bytes);
 await assert.rejects(verifyAppDirectory(input,sig,trust),/ARTIFACT_INTEGRITY_MISMATCH/);
 bytes[0]^=1;await writeFile(entry,bytes);
 const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'});await writeFile(key,ec.privateKey.export({format:'pem',type:'pkcs8'}));
 await assert.rejects(signAppDirectory(input,trust.keyId,key,join(root,'other.json')),/INVALID_SIGNING_KEY/);
}));

test('CLI sign and verify use explicit key files and never print private key material',async()=>fixture(async(root,input)=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const keys=generateKeyPairSync('ed25519');const privateFile=join(root,'private.pem'),publicFile=join(root,'public.pem'),sig=join(root,'sig.json');
 await writeFile(privateFile,keys.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
 await writeFile(publicFile,keys.publicKey.export({format:'pem',type:'spki'}));
 const cli=fileURLToPath(new URL('../src/app-platform/developer/cli.ts',import.meta.url));
 const run=(args:string[])=>spawnSync(process.execPath,['--import','tsx',cli,...args],{encoding:'utf8'});
 const signed=run(['sign',input,'key-one',privateFile,sig]);assert.equal(signed.status,0,signed.stderr);
 assert.equal(JSON.parse(signed.stdout).keyId,'key-one');assert.ok(!signed.stdout.includes('PRIVATE KEY'));
 const verified=run(['verify',input,sig,'key-one','afc-examples',publicFile]);assert.equal(verified.status,0,verified.stderr);
 assert.equal(run(['verify',input,sig,'key-one','other-publisher',publicFile]).status,1);
 assert.equal(run(['sign',input,'key-one',privateFile,sig]).status,1);
}));

test('publisher policy enforces app ownership, validity, revocation and stable policy across verification',async()=>fixture(async(root,input)=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const {signAppDirectory}=await import('../src/app-platform/developer/signature.ts');
 const {verifyAppWithPublisherPolicy,loadPublisherPolicy}=await import('../src/app-platform/developer/publisher-policy.ts');
 const keys=generateKeyPairSync('ed25519'),keyFile=join(root,'key.pem'),sig=join(root,'sig.json');
 await writeFile(keyFile,keys.privateKey.export({format:'pem',type:'pkcs8'}));
 await signAppDirectory(input,'release-key',keyFile,sig);
 const policy={policyVersion:'1.0',revision:1,keys:[{keyId:'release-key',publisherId:'afc-examples',publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),revoked:false,appIds:['sdk-trusted-sample'],validFrom:'2026-01-01T00:00:00Z',validUntil:'2027-01-01T00:00:00Z'}]};
 const clock=()=>new Date('2026-09-13T00:00:00Z');
 const check=(value:unknown)=>verifyAppWithPublisherPolicy(input,sig,async()=>value,clock);
 assert.equal((await check(policy)).policyRevision,1);
 for(const change of [{revoked:true},{validUntil:'2026-09-13T00:00:00Z'},{validFrom:'2026-12-01T00:00:00Z'},{publisherId:'other'}]){
  await assert.rejects(check({...policy,keys:[{...policy.keys[0],...change}]}),/UNTRUSTED_PUBLISHER_KEY/);
 }
 await assert.rejects(check({...policy,keys:[{...policy.keys[0],appIds:['other-app']}]}),/PUBLISHER_APP_DENIED/);
 await assert.rejects(check({...policy,keys:[policy.keys[0],policy.keys[0]]}),/INVALID_PUBLISHER_POLICY/);
 await assert.rejects(check({...policy,keys:[{...policy.keys[0],publicKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString()}]}),/INVALID_PUBLISHER_POLICY/);
 let reads=0;
 await assert.rejects(verifyAppWithPublisherPolicy(input,sig,async()=>++reads===1?policy:{...policy,revision:2},clock),/PUBLISHER_POLICY_CHANGED/);
 reads=0;
 await assert.rejects(verifyAppWithPublisherPolicy(input,sig,async()=>++reads===1?policy:{...policy,keys:[{...policy.keys[0],revoked:true}]},clock),/PUBLISHER_POLICY_CHANGED/);
 let ticks=0;
 await assert.rejects(verifyAppWithPublisherPolicy(input,sig,async()=>policy,()=>++ticks===1?clock():new Date('2027-01-01T00:00:00Z')),/UNTRUSTED_PUBLISHER_KEY/);
 const file=join(root,'policy.json');await writeFile(file,JSON.stringify(policy));assert.equal((await loadPublisherPolicy(file)).revision,1);
 const cli=fileURLToPath(new URL('../src/app-platform/developer/cli.ts',import.meta.url));
 // Use policy validity around real wall clock for CLI regardless of when regression runs.
 const actual=Date.now();policy.keys[0].validFrom=new Date(actual-60000).toISOString();policy.keys[0].validUntil=new Date(actual+60000).toISOString();await writeFile(file,JSON.stringify(policy));
 const current=spawnSync(process.execPath,['--import','tsx',cli,'verify-policy',input,sig,file],{encoding:'utf8'});
 assert.equal(current.status,0,current.stderr);assert.equal(JSON.parse(current.stdout).policyRevision,1);
}));

test('install preparation stages signed bytes only after admin checks and cleans up on late revocation',async()=>fixture(async(root,input)=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const {prepareAppInstallation}=await import('../src/app-platform/developer/install-preparation.ts');
 const {signAppDirectory}=await import('../src/app-platform/developer/signature.ts');
 const keys=generateKeyPairSync('ed25519'),key=join(root,'key.pem'),sig=join(root,'sig.json'),artifactRoot=join(root,'staged');
 await writeFile(key,keys.privateKey.export({format:'pem',type:'pkcs8'}));await signAppDirectory(input,'key-one',key,sig);
 const policy={policyVersion:'1.0',revision:1,keys:[{keyId:'key-one',publisherId:'afc-examples',publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),revoked:false,appIds:['sdk-trusted-sample'],validFrom:'2026-01-01T00:00:00Z',validUntil:'2027-01-01T00:00:00Z'}]};
 let checks=0,denyAt=Infinity;
 const context={actorType:'person',execution:{type:'platform'},authorize:async(code:string)=>{assert.equal(code,'platform.authorization.manage');return {allowed:++checks<denyAt};}} as unknown as Parameters<typeof prepareAppInstallation>[0]['context'];
 let policyReads=0,changeAt=Infinity;
 const options={directory:input,signatureFile:sig,artifactRoot,context,clock:()=>new Date('2026-09-13T00:00:00Z'),loadPublisherPolicy:async()=>++policyReads>=changeAt?{...policy,revision:2}:policy};
 denyAt=1;await assert.rejects(prepareAppInstallation(options),/INSTALL_ACCESS_DENIED/);assert.equal(policyReads,0);
 assert.ok(!(await readdir(root)).includes('staged'));
 checks=0;denyAt=Infinity;const prepared=await prepareAppInstallation(options);
 assert.equal(prepared.status,'prepared');assert.equal(checks,3);assert.equal(prepared.publisherPolicyRevision,1);
 assert.deepEqual(await readFile(join(prepared.path,'entry.js')),await readFile(join(input,'entry.js')));
 const originalDirectories=await readdir(artifactRoot);
 checks=0;denyAt=3;await assert.rejects(prepareAppInstallation(options),/INSTALL_ACCESS_DENIED/);
 assert.deepEqual(await readdir(artifactRoot),originalDirectories);
 checks=0;denyAt=Infinity;policyReads=0;changeAt=3;
 await assert.rejects(prepareAppInstallation(options),/INSTALL_ADMISSION_CHANGED/);
 assert.deepEqual(await readdir(artifactRoot),originalDirectories);
 const service={...context,actorType:'service'} as typeof context;
 await assert.rejects(prepareAppInstallation({...options,context:service}),/INSTALL_ACCESS_DENIED/);
}));
