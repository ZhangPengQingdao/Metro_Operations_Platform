import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateAppManifest} from '../src/app-platform/manifest/index.ts';
test('independent trusted and sandbox bundles pass the authoritative manifest validator',async()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 execFileSync(process.execPath,['examples/app-sdk/build.mjs'],{cwd:root,stdio:'pipe'});
 for(const mode of ['trusted','sandbox']){
  const path=new URL(`../../examples/app-sdk/dist/${mode}/`,import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('manifest.json',path),'utf8'));
  const parsed=validateAppManifest(manifest);assert.equal(parsed.ok,true,JSON.stringify(parsed));
  const bytes=await readFile(new URL('entry.js',path));assert.equal(bytes.length,manifest.artifacts[0].bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.artifacts[0].sha256);
  assert.equal(manifest.ui.mode,mode);
 }
});

test('built trusted sample loads through the existing host and loses its client on unload', async () => {
 const {createSdkPreviewSession}=await import('../../src/app-platform/samples/sdk-preview/session.ts');
 const {createTrustedSample}=await import('../../examples/app-sdk/dist/trusted/entry.js');
 const manifest=JSON.parse(await readFile(new URL('../../examples/app-sdk/dist/trusted/manifest.json',import.meta.url),'utf8'));
 let client: ReturnType<typeof import('@metro/platform-sdk/app-gateway').createAppGatewayClient> | undefined;
 const session=createSdkPreviewSession(manifest,async injected=>{client=injected;return createTrustedSample(injected);});
 await session.host.open(manifest.id,'/');
 const ready=session.host.getSnapshot();assert.equal(ready.status,'ready');
 const result=await client!.invoke('sample.greeting',{name:'AFC'});
 assert.ok(result && typeof result==='object' && 'message' in result);
 assert.equal(result.message,'你好，AFC（本地模拟数据）');
 session.close();await session.drain();
 assert.equal(session.host.getSnapshot().status,'idle');
 if(ready.status==='ready')assert.equal(ready.context.signal.aborted,true);
 await assert.rejects(client!.invoke('sample.greeting',{name:'stale'}));
});
