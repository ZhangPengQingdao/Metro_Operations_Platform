import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { attachAppDocker } from '../src/app-platform/runtime/docker-attach.ts';
import type { AppDockerPolicy } from '../src/app-platform/runtime/docker-policy.ts';
import type { AppDockerExecutor } from '../src/app-platform/runtime/docker-executor.ts';

async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'afc-attach-')),socketPath=join(root,'engine.sock');
 const server=createServer();server.on('upgrade',(_req,socket)=>socket.on('end',()=>socket.destroy()));server.listen(socketPath);await once(server,'listening');
 const options={socketPath,containerId:'a'.repeat(64),policy:{body:{OpenStdin:true,AttachStdin:true,AttachStdout:true,Tty:false}} as AppDockerPolicy,
  approval:{imageId:`sha256:${'b'.repeat(64)}`,config:{}},executor:{observe:async()=>({State:{Status:'created'}})} as unknown as Pick<AppDockerExecutor,'observe'>};
 return {server,options,async close(){server.close();await once(server,'close');await rm(root,{recursive:true,force:true});}};
}
function frame(text:string){const data=Buffer.from(text),header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(data.length,4);return Buffer.concat([header,data]);}
test('attach pins immutable ID and no replay, decodes split Engine frames and writes raw stdin',async()=>{
 const f=await fixture();try{
  let incoming='';
  f.server.on('upgrade',(req,socket)=>{
   assert.equal(req.url,`/v1.54/containers/${'a'.repeat(64)}/attach?stream=1&stdin=1&stdout=1&stderr=0&logs=0`);
   socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
   const data=frame('hello\n');socket.write(data.subarray(0,3));socket.write(data.subarray(3));
   socket.on('data',chunk=>{incoming+=chunk.toString();socket.write(frame('ack\n'));});
  });
  const a=await attachAppDocker(f.options);
  let result='';a.stdout.on('data',chunk=>{result+=chunk.toString();});
  await new Promise<void>((resolve,reject)=>a.stdin.write('reply\n',error=>error?reject(error):resolve()));
  while(!result.includes('ack'))await once(a.stdout,'data');
  assert.equal(incoming,'reply\n');assert.equal(result,'hello\nack\n');a.close();
 }finally{await f.close();}
});
test('unexpected channels and oversized frames close attachment without forwarding',async()=>{
 for(const oversized of [false,true]){
  const f=await fixture();try{
   f.server.on('upgrade',(_req,socket)=>{
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    const data=Buffer.alloc(8);data[0]=oversized?1:2;data.writeUInt32BE(oversized?1048577:1,4);socket.write(data);
   });
   const a=await attachAppDocker(f.options);if(!a.stdout.destroyed)await once(a.stdout,'close');assert.equal(a.stdout.destroyed,true);
  }finally{await f.close();}
 }
});
test('identity check after attachment fails closed and normal HTTP is rejected',async()=>{
 for(const normal of [false,true]){
  const f=await fixture();try{
   if(normal)f.server.on('upgrade',(_req,socket)=>socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
   else f.server.on('upgrade',(_req,socket)=>socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'));
   let calls=0;f.options.executor={observe:async()=>++calls===1?{State:{Status:'created'}}:null} as unknown as Pick<AppDockerExecutor,'observe'>;
   await assert.rejects(attachAppDocker(f.options),normal?/ATTACH_FAILED/:/ATTACH_CONTAINER_INVALID/);
  }finally{await f.close();}
 }
});

test('large stdout frames resume after backpressure without dropping bytes', {timeout:5000},async()=>{
 const f=await fixture();try{
  const content='a'.repeat(300000)+'END';
  f.server.on('upgrade',(_req,socket)=>{
   socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
   socket.write(frame(content));socket.write(frame('NEXT'));
  });
  const a=await attachAppDocker(f.options);
  // Attachment starts with no stdout consumer; large data must pause upstream safely.
  const chunks:Buffer[]=[];let size=0;
  await new Promise<void>((resolve,reject)=>{
   a.stdout.on('error',reject);
   a.stdout.on('data',(chunk:Buffer)=>{chunks.push(chunk);size+=chunk.length;if(size===content.length+4)resolve();});
  });
  assert.equal(Buffer.concat(chunks).toString(),content+'NEXT');a.close();
 }finally{await f.close();}
});
