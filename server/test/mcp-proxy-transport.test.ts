import test from 'node:test';
import assert from 'node:assert/strict';
import {createMcpProxyTransport} from '../../src/app-platform/host/mcp-apps/transport.ts';

function fixture() {
 const events=new EventTarget();const sent: unknown[][]=[];
 const host=Object.assign(events,{location:{origin:'https://platform.example'}}) as unknown as Window;
 const proxy={postMessage:(...args:unknown[])=>sent.push(args)} as unknown as Window;
 const transport=createMcpProxyTransport(host,proxy,'https://isolated.example');
 const emit=(data:unknown,source:Window=proxy,origin='https://isolated.example')=>{
  const event=new Event('message');Object.assign(event,{data,source,origin});events.dispatchEvent(event);
 };
 return {transport,emit,host,proxy,sent};
}
const ping={jsonrpc:'2.0' as const,method:'ping',id:1};

test('proxy transport requires exact source and origin and pins outgoing destination',async()=>{
 const f=fixture();const received:unknown[]=[];f.transport.onmessage=m=>received.push(m);
 await f.transport.start();f.emit(ping,f.host);f.emit(ping,f.proxy,'null');f.emit(ping);
 assert.deepEqual(received,[ping]);await f.transport.send(ping);
 assert.deepEqual(f.sent,[[ping,'https://isolated.example']]);
 await f.transport.close();f.emit(ping);assert.equal(received.length,1);
 await assert.rejects(f.transport.send(ping));await assert.rejects(f.transport.start());
});

test('invalid and oversized proxy messages revoke the channel',async()=>{
 for(const message of [{invalid:true},{...ping,params:{text:'x'.repeat(1024*1024)}}]){
  const f=fixture();let closed=0;let errors=0;
  f.transport.onclose=()=>closed++;f.transport.onerror=()=>errors++;
  await f.transport.start();f.emit(message);f.emit(ping);
  assert.equal(closed,1);assert.equal(errors,1);await assert.rejects(f.transport.send(ping));
 }
});

test('session message budget is finite and closing is idempotent',async()=>{
 const f=fixture();let received=0;let closed=0;f.transport.onmessage=()=>received++;
 f.transport.onclose=()=>closed++;
 await f.transport.start();for(let i=0;i<513;i++)f.emit({...ping,id:i});
 assert.equal(received,512);assert.equal(closed,1);await f.transport.close();assert.equal(closed,1);
});

test('duplicate request IDs revoke transport rather than replaying a write',async()=>{
 const f=fixture();let received=0,closed=0;f.transport.onmessage=()=>received++;f.transport.onclose=()=>closed++;
 await f.transport.start();f.emit(ping);f.emit(ping);assert.equal(received,1);assert.equal(closed,1);
});

test('proxy origin must be canonical HTTPS on a different hostname',()=>{
 const f=fixture();
 for(const origin of ['https://platform.example:444','http://isolated.example','https://isolated.example/path','https://u:p@isolated.example','null']){
  assert.throws(()=>createMcpProxyTransport(f.host,f.proxy,origin));
 }
});

test('UTF-8 byte size and total bidirectional bytes are bounded',async()=>{
 const large=fixture();await large.transport.start();
 await assert.rejects(large.transport.send({...ping,params:{text:'中'.repeat(400_000)}}));
 assert.equal(large.sent.length,0);
 const f=fixture();await f.transport.start();
 const message={jsonrpc:'2.0' as const,method:'ui/notifications/log',params:{text:'x'.repeat(700_000)}};
 for(let i=0;i<5;i++){f.emit(message);await f.transport.send(message);}
 f.emit(message);
 await assert.rejects(f.transport.send(message));
 assert.equal(f.sent.length,5);
});
