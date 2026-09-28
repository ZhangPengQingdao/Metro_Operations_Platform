import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AppFileError,readSandboxFile,readSandboxTextFile,downloadSandboxFile,createSandboxImageClient,APP_IMAGE_MAX_BYTES,APP_IMAGE_MAX_PARTS,APP_IMAGE_PART_BYTES} from '@metro/platform-sdk/app-files';

const selectedFile = (name: string, bytes: Uint8Array) => Object.assign(new Blob([bytes]), {name});

test('sandbox file reader enforces size and extension before parsing', async () => {
  const file = selectedFile('检修计划.CSV', new TextEncoder().encode('\ufeff日期,车站\n2026-09-27,测试站'));
  assert.equal(await readSandboxTextFile(file, {maxBytes: 100, extensions: ['.csv']}), '日期,车站\n2026-09-27,测试站');
  assert.deepEqual(await readSandboxFile(file, {maxBytes: 100, extensions: ['.csv']}), new Uint8Array(await file.arrayBuffer()));
  assert.deepEqual(await readSandboxFile(file, {maxBytes: 50 * 1024 * 1024}), new Uint8Array(await file.arrayBuffer()));
  await assert.rejects(readSandboxFile(file, {maxBytes: 50 * 1024 * 1024 + 1}), (error: unknown) => error instanceof AppFileError && error.code === 'INVALID_FILE');
  await assert.rejects(readSandboxFile(file, {maxBytes: 4, extensions: ['.csv']}), (error: unknown) => error instanceof AppFileError && error.code === 'FILE_TOO_LARGE');
  await assert.rejects(readSandboxFile(file, {maxBytes: 100, extensions: ['.xlsx']}), (error: unknown) => error instanceof AppFileError && error.code === 'UNSUPPORTED_FILE');
  await assert.rejects(readSandboxFile(selectedFile('../bad.csv', new Uint8Array([1])), {maxBytes: 100}), (error: unknown) => error instanceof AppFileError && error.code === 'INVALID_FILE');
  await assert.rejects(readSandboxTextFile(selectedFile('bad.csv', new Uint8Array([0xff])), {maxBytes: 100}), (error: unknown) => error instanceof AppFileError && error.code === 'INVALID_TEXT');
});

test('sandbox file reader verifies bytes after an untrusted size report', async () => {
  const file = {name: 'large.csv', size: 1, arrayBuffer: async () => new Uint8Array(101).buffer} as Blob & {name: string};
  await assert.rejects(readSandboxFile(file, {maxBytes: 100}), (error: unknown) => error instanceof AppFileError && error.code === 'FILE_TOO_LARGE');
});

test('sandbox download rejects invalid filenames and oversized output before DOM use', () => {
  assert.throws(() => downloadSandboxFile('../records.csv', 'x' as unknown as Uint8Array), (error: unknown) => error instanceof AppFileError && error.code === 'INVALID_DOWNLOAD');
  class OversizedBlob extends Blob { override get size() { return 50 * 1024 * 1024 + 1; } }
  assert.throws(() => downloadSandboxFile('records.csv', new OversizedBlob()), (error: unknown) => error instanceof AppFileError && error.code === 'INVALID_DOWNLOAD');
});

test('image client sends bounded chunks with independent write intents and verifies readback', async () => {
  const organizationId='11111111-1111-4111-8111-111111111111',recordId='22222222-2222-4222-8222-222222222222';
  const bytes=new Uint8Array(APP_IMAGE_PART_BYTES+6);bytes.set([0xff,0xd8],0);bytes.set([0xff,0xd9],bytes.length-2);
  const hash=createHash('sha256').update(bytes).digest('hex');
  const seen:{name:string;payload:Record<string,unknown>;write:boolean}[]=[];
  const client=createSandboxImageClient(async(name,payload,write)=>{
    seen.push({name,payload,write});
    if(name==='read'){
      const index=payload.index as number,part=bytes.slice(index*APP_IMAGE_PART_BYTES,(index+1)*APP_IMAGE_PART_BYTES);
      return {data:Buffer.from(part).toString('base64'),index,parts:2,mime:'image/jpeg',bytes:bytes.length,sha256:hash};
    }
    return {};
  },{begin:'begin',part:'part',finish:'finish',read:'read'});
  const photoId=await client.uploadPrepared(bytes,{organizationId,kind:'before'});
  assert.deepEqual(seen.map(call=>call.name),['begin','part','part','finish']);
  assert.ok(seen.every(call=>call.write));
  assert.equal(new Set(seen.map(call=>call.payload.requestId)).size,4);
  assert.equal(seen[0]?.payload.sha256,hash);
  assert.equal(seen[0]?.payload.parts,2);
  assert.equal(seen[1]?.payload.photoId,photoId);
  assert.equal(seen[2]?.payload.index,1);
  const read=await client.read({recordId,photoId});
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()),bytes);
  assert.equal(read.type,'image/jpeg');
  assert.deepEqual(seen.slice(4).map(call=>call.write),[false,false]);
});

test('image client rejects corrupt readback instead of displaying bytes', async () => {
  const id='11111111-1111-4111-8111-111111111111';
  const client=createSandboxImageClient(async()=>({data:Buffer.from([0xff,0xd8,0x12,0x34,0xff,0xd9]).toString('base64'),index:0,parts:1,mime:'image/jpeg',bytes:6,sha256:'0'.repeat(64)}),
    {begin:'begin',part:'part',finish:'finish',read:'read'});
  await assert.rejects(client.read({recordId:id,photoId:id}), (error:unknown)=>error instanceof AppFileError&&error.code==='INVALID_IMAGE');
});

test('maximum image upload fits managed write size and part count', async () => {
  const id='11111111-1111-4111-8111-111111111111';
  const bytes=new Uint8Array(APP_IMAGE_MAX_BYTES);
  bytes.set([0xff,0xd8],0);bytes.set([0xff,0xd9],bytes.length-2);
  const writes:{name:string;payload:Record<string,unknown>}[]=[];
  const client=createSandboxImageClient(async(name,payload)=>{writes.push({name,payload:payload as Record<string,unknown>});return {};},
    {begin:'begin',part:'part',finish:'finish',read:'read'});
  await client.uploadPrepared(bytes,{organizationId:id,kind:'before'});
  assert.equal(writes[0]?.payload.parts,APP_IMAGE_MAX_PARTS);
  assert.equal(writes.filter(write=>write.name==='part').length,APP_IMAGE_MAX_PARTS);
  const largest=Buffer.alloc(APP_IMAGE_PART_BYTES).toString('base64');
  const request={requestId:id,operations:[{action:'insert',table:'photo_parts',id,values:{photo_id:id,organization_id:id,created_by:id,part_index:APP_IMAGE_MAX_PARTS-1,data:largest}}]};
  assert.ok(Buffer.byteLength(JSON.stringify(request))<=16_384);
});
