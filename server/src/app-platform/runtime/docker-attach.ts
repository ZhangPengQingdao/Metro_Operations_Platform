import { request } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import type { Duplex } from 'node:stream';
import { posix } from 'node:path';
import type { AppDockerExecutor, AppDockerImageApproval } from './docker-executor.js';
import type { AppDockerPolicy } from './docker-policy.js';

export class AppDockerAttachError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppDockerAttachError'; }
}
export interface AppDockerAttachment {
  stdout: PassThrough;
  stdin: Writable;
  close(): void;
}
/** A single local Engine attachment, no reconnect/log replay. Caller owns streams and must stop/drain
 * its Gateway bridge before replacement. stdin writes may have been delivered on disconnect.
 */
export async function attachAppDocker(options: {
  socketPath: string; executor: Pick<AppDockerExecutor,'observe'>; policy: AppDockerPolicy;
  approval: AppDockerImageApproval; containerId: string;
}): Promise<AppDockerAttachment> {
  const { socketPath, containerId, executor } = options;
  const policy = structuredClone(options.policy), approval = structuredClone(options.approval);
  if (!posix.isAbsolute(socketPath) || posix.normalize(socketPath) !== socketPath || /[\x00-\x1f\x7f]/.test(socketPath)
    || !/^[0-9a-f]{64}$/.test(containerId) || !policy.body.OpenStdin || !policy.body.AttachStdin || !policy.body.AttachStdout || policy.body.Tty) throw new AppDockerAttachError('ATTACH_INPUT_INVALID');
  const before = await executor.observe(policy,approval,containerId);
  if (!before || !['created','running'].includes(before.State.Status)) throw new AppDockerAttachError('ATTACH_CONTAINER_INVALID');
  const attachment = await new Promise<AppDockerAttachment>((resolve,reject) => {
    let settled = false;
    const req = request({socketPath,path:`/v1.54/containers/${containerId}/attach?stream=1&stdin=1&stdout=1&stderr=0&logs=0`,
      method:'POST',agent:false,maxHeaderSize:8192,headers:{Connection:'Upgrade',Upgrade:'tcp'}});
    const fail = () => { if (settled) return; settled=true; clearTimeout(timer); req.destroy(); reject(new AppDockerAttachError('ATTACH_FAILED')); };
    const timer = setTimeout(fail,10_000);
    req.once('error',fail); req.once('response',response=>{response.destroy();fail();});
    req.once('upgrade',(response,socket,head)=>{
      if (settled) {socket.destroy();return;}
      if (response.statusCode!==101 || response.headers.upgrade?.toLowerCase()!=='tcp') {socket.destroy();fail();return;}
      settled=true;clearTimeout(timer);
      resolve(demultiplex(socket,head));
    });
    req.end();
  });
  try {
    const after = await executor.observe(policy,approval,containerId);
    if (!after || !['created','running'].includes(after.State.Status)) throw new AppDockerAttachError('ATTACH_CONTAINER_INVALID');
    return attachment;
  } catch(error) {attachment.close();throw error;}
}

function demultiplex(socket: Duplex, head: Buffer): AppDockerAttachment {
  const stdout = new PassThrough({highWaterMark:65536});
  // Keep an error listener even before the bridge is attached; consumers observe close/end.
  stdout.on('error',()=>undefined);
  let closed=false, buffer=Buffer.alloc(0), remaining=0;
  const close=()=>{if(closed)return;closed=true;socket.destroy();stdout.destroy();stdin.destroy();};
  const stdin = new Writable({highWaterMark:65536,write(chunk,encoding,callback){
    if(closed){callback(new AppDockerAttachError('ATTACH_CLOSED'));return;}
    socket.write(chunk,encoding,error=>callback(error ? new AppDockerAttachError('ATTACH_WRITE_UNCERTAIN') : undefined));
  }});
  stdin.on('error',close);stdin.on('finish',close);stdin.on('close',close);
  stdout.on('close',close);socket.on('error',close);socket.on('close',close);
  const parse=()=>{
    if(closed)return;
    while(buffer.length){
      if(!remaining){
        if(buffer.length<8)return;
        if(buffer[0]!==1 || buffer[1]!==0 || buffer[2]!==0 || buffer[3]!==0){close();return;}
        remaining=buffer.readUInt32BE(4);buffer=buffer.subarray(8);
        if(remaining>1024*1024){close();return;}
        if(!remaining)continue;
      }
      const length=Math.min(buffer.length,remaining);
      const chunk=buffer.subarray(0,length);buffer=buffer.subarray(length);remaining-=length;
      if(!stdout.write(chunk)){socket.pause();return;}
    }
  };
  stdout.on('drain',()=>{parse();if(!closed && stdout.writableLength<65536)socket.resume();});
  socket.on('data',(chunk:Buffer)=>{
    if(buffer.length+chunk.length>2*1024*1024){close();return;}
    buffer=Buffer.concat([buffer,chunk]);parse();
  });
  socket.on('end',()=>{if(remaining || buffer.length)close();else stdout.end();});
  if(head.length){buffer=Buffer.from(head);parse();}
  return {stdout,stdin,close};
}
