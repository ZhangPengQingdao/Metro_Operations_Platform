import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {App} from '@modelcontextprotocol/ext-apps';
import {createMcpViewSession} from '../../src/app-platform/host/mcp-apps/session.ts';

test('official App initializes and receives input before the completed result exactly once', async () => {
  const [host, view] = InMemoryTransport.createLinkedPair();
  const result = {content: [{type: 'text' as const, text: 'Already executed'}]};
  const session = createMcpViewSession({transport: host, arguments: {id: 1}, result});
  result.content[0].text = 'mutated';
  const app = new App({name: 'conformance', version: '1'}, {}, {autoResize: false});
  const events: unknown[] = [];
  app.ontoolinput = value => events.push(value);
  app.ontoolresult = value => events.push(value);
  try {
    await app.connect(view);
    assert.equal(await session.ready, 'delivered');
    assert.deepEqual(events, [{arguments: {id: 1}}, {content: [{type: 'text', text: 'Already executed'}]}]);
    await app.notification({method: 'ui/notifications/initialized'});
    assert.equal(events.length, 2);
    await assert.rejects(app.callServerTool({name: 'undeclared', arguments: {}}));
  } finally { await session.close(); await app.close(); }
  assert.equal(session.closed, true);
  assert.deepEqual(session.fallback.content, [{type: 'text', text: 'Already executed'}]);
});

test('close before initialization settles as text and is idempotent', async () => {
  const [host] = InMemoryTransport.createLinkedPair();
  const session = createMcpViewSession({transport: host, arguments: {}, result: {content: []}});
  await Promise.all([session.close(), session.close()]);
  assert.equal(await session.ready, 'text');
  assert.equal(session.closed, true);
});

test('transport startup failure preserves the original result', async () => {
  const session = createMcpViewSession({
    transport: {async start() { throw new Error('offline'); }, async send() {}, async close() {}},
    arguments: {}, result: {content: [{type: 'text', text: 'Keep this'}]},
  });
  assert.equal(await session.ready, 'text');
  assert.deepEqual(session.fallback, {content: [{type: 'text', text: 'Keep this'}]});
  assert.equal(session.closed, true);
});

test('revocation while input is being sent prevents late result delivery', async () => {
  const [host, view] = InMemoryTransport.createLinkedPair();
  const send = host.send.bind(host);
  const session = createMcpViewSession({transport: host, arguments: {}, result: {content: []}});
  host.send = async (message, options) => {
    await send(message, options);
    if ('method' in message && message.method === 'ui/notifications/tool-input') await session.close();
  };
  const app = new App({name: 'conformance', version: '1'}, {}, {autoResize: false});
  let results = 0;
  app.ontoolresult = () => { results++; };
  try {
    await app.connect(view);
    assert.equal(await session.ready, 'text');
    assert.equal(results, 0);
  } finally { await session.close(); await app.close(); }
});

test('official proxy handshake sends immutable HTML once and rejects a second readiness', async()=>{
  const [host,proxy]=InMemoryTransport.createLinkedPair();
  const options={transport:host,arguments:{},result:{content:[]},html:'<!doctype html><html>Original</html>'};
  const session=createMcpViewSession(options);
  options.html='changed';
  const resource=new Promise<unknown>(resolve=>{proxy.onmessage=resolve;});
  await proxy.start();
  await proxy.send({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready'});
  assert.deepEqual(await resource,{jsonrpc:'2.0',method:'ui/notifications/sandbox-resource-ready',params:{html:'<!doctype html><html>Original</html>',sandbox:'allow-scripts'}});
  await proxy.send({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready'});
  assert.equal(await session.ready,'text');assert.equal(session.closed,true);
  await session.close();await proxy.close();
});

test('app calls require initialization and sanitize failures without retry',async()=>{
 const [host,view]=InMemoryTransport.createLinkedPair();let calls=0;
 const session=createMcpViewSession({transport:host,arguments:{},result:{content:[]},callTool:async()=>{calls++;throw Error('secret-token');}});
 const response=new Promise<unknown>(resolve=>{view.onmessage=resolve;});await view.start();
 await view.send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'fixtureecho',arguments:{}}});
 assert.match(JSON.stringify(await response),/CARD_UNAVAILABLE/);assert.equal(calls,0);
 const app=new App({name:'conformance',version:'1'},{},{autoResize:false});
 await app.connect(view);await session.ready;
 try {await assert.rejects(app.callServerTool({name:'fixtureecho',arguments:{}}),error=>String(error).includes('CARD_UNAVAILABLE')&&!String(error).includes('secret-token'));assert.equal(calls,1);}
 finally {await session.close();await app.close();}
});
