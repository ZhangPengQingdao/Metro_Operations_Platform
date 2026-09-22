import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {readInstallPackage} from '../../src/app-platform/admin/install-package.ts';
test('installation reader accepts legacy JSON and compressed packages without altering their signed content',async()=>{
 const payload={requestId:'test-request',manifest:{name:'晨会交接',icon:{paths:['M5 4h14v16H5z']}},signature:'signed',artifacts:[]};
 const json=JSON.stringify(payload);
 for(const bytes of [Buffer.from(json),gzipSync(json)])assert.deepEqual(await readInstallPackage(new File([bytes],'app.mop.gz')),payload);
});
test('installation reader rejects corrupt compressed data and invalid JSON',async()=>{
 await assert.rejects(readInstallPackage(new File([Buffer.from([0x1f,0x8b,0,0])],'broken.gz')));
 await assert.rejects(readInstallPackage(new File(['not json'],'broken.json')));
 await assert.rejects(readInstallPackage(new File([],'empty.json')));
});
test('installation reader stops compressed expansion above the upload limit',async()=>{
 const compressed=gzipSync(Buffer.alloc(92*1024*1024+1,32));
 await assert.rejects(readInstallPackage(new File([compressed],'oversized.mop.gz')),/解压后超过/);
});
