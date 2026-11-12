import test from 'node:test';
import assert from 'node:assert/strict';
import {get} from 'node:http';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {registerEmployeeRoutes} from '../src/app-platform/employee/routes.ts';
import {GatewayError} from '../src/app-platform/gateway/model.ts';

test('disconnecting a dashboard HTTP request cancels its app invocation',{timeout:3000},async()=>{
 const app=Fastify();
 let started!:()=>void,aborted!:()=>void,signal:AbortSignal|undefined;
 const pending=new Promise<void>(resolve=>{started=resolve;}),cancelled=new Promise<void>(resolve=>{aborted=resolve;});
 await app.register(cookie);
 registerEmployeeRoutes(app,{origin:'http://127.0.0.1:3100',resolveAdmin:async()=>{throw Error('unused');},
  service:{authenticate:async()=>({id:'account',personId:'person'})} as any,
  management:{employeeDashboard:async(_appId:string,_identity:unknown,input:AbortSignal)=>{
   signal=input;started();
   return new Promise((_resolve,reject)=>input.addEventListener('abort',()=>{aborted();reject(new GatewayError('ABORTED',499));},{once:true}));
  }} as any});
 try{
  const address=await app.listen({host:'127.0.0.1',port:0});
  const request=get(`${address}/api/employee/apps/demo/dashboard`);request.on('error',()=>{});
  try{
   await pending;assert.equal(signal?.aborted,false);request.destroy();
   await cancelled;assert.equal(signal?.aborted,true);
  }finally{request.destroy();}
 }finally{await app.close();}
});
