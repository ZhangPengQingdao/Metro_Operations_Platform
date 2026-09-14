import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type {PlatformActorContext} from '../src/platform/context/index.ts';
import {registerAppLifecycleRoutes} from '../src/app-platform/runtime/lifecycle-routes.ts';
import {lifecycleEndpoint} from '../../src/app-platform/lifecycle/endpoint.ts';

test('console endpoint matches routed management; origin and actor denied before host lookup',async()=>{
 const app=Fastify();let calls=0,lookups=0;
 const actor={actorType:'person',execution:{type:'platform'},authorize:async()=>({allowed:true})} as unknown as PlatformActorContext;
 const installation={appId:'demo',revision:1,enabled:false,manifest:{version:'1.0.0'}};
 await registerAppLifecycleRoutes(app,{origin:'https://platform.example',resolveContext:async req=>{if(req.headers.authorization!=='fixture')throw Error();return actor;},getHost:async()=>{lookups++;return {status:async()=>({installation,owned:false,serving:false}),execute:async()=>{calls++;return installation;},recover:async()=>installation,prepareCredential:async()=>installation} as never;}});
 try{
  const url=lifecycleEndpoint('demo');assert.equal(url,'/api/v1/apps/demo/lifecycle');
  assert.equal((await app.inject({method:'GET',url})).statusCode,403);assert.equal(lookups,0);
  assert.equal((await app.inject({method:'GET',url,headers:{authorization:'fixture'}})).statusCode,200);
  const payload={operation:'execute',revision:1,action:'install'};
  assert.equal((await app.inject({method:'POST',url,headers:{authorization:'fixture',origin:'https://evil.example'},payload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url,headers:{authorization:'fixture',origin:'https://platform.example'},payload:{...payload,healthy:true}})).statusCode,400);
  assert.equal(calls,0);
  assert.equal((await app.inject({method:'POST',url,headers:{authorization:'fixture',origin:'https://platform.example'},payload})).statusCode,200);assert.equal(calls,1);
  assert.throws(()=>lifecycleEndpoint('../other'));
 }finally{await app.close();}
});
