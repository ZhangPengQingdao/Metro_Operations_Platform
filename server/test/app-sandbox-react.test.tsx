import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'react-dom/server';
import { SandboxFrame, validateSandboxResource } from '../../src/app-platform/host/sandbox/index.ts';
test('sandbox frame enforces isolated origin and opaque sandbox, local fixture cannot become production fallback',()=>{
  assert.equal(validateSandboxResource({mode:'isolated-origin',platformOrigin:'https://platform.example.com',url:'https://platform.example.com:444/app'}),false);
  assert.equal(validateSandboxResource({mode:'local-demo',platformOrigin:'https://platform.example.com',html:'x'}),false);
  assert.equal(validateSandboxResource({mode:'isolated-origin',platformOrigin:'https://platform.example.com',url:'https://sandbox.example.net/app'}),true);
  const props={appId:'demo',instanceKey:'1',enabled:true,title:'Sandbox',operations:new Map(),resource:{mode:'local-demo' as const,platformOrigin:'http://127.0.0.1:5173',html:'<!doctype html><p>demo</p>'}};
  const html=renderToString(<SandboxFrame {...props}/>);
  assert.match(html,/sandbox="allow-scripts"/);assert.doesNotMatch(html,/allow-same-origin|allow-popups|allow-forms|allow-top-navigation/);
  assert.match(html,/referrerPolicy="no-referrer"/i);
  assert.doesNotMatch(renderToString(<SandboxFrame {...props} enabled={false}/>),/<iframe/);
});
test('frame refuses forged loopback configuration when actual parent origin is production',()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{origin:'https://platform.example.com'}}});
  try {
    const html=renderToString(<SandboxFrame appId="demo" instanceKey="1" enabled title="demo" operations={new Map()}
      resource={{mode:'local-demo',platformOrigin:'http://127.0.0.1:5173',html:'<p>demo</p>'}}/>);
    assert.doesNotMatch(html,/<iframe/);assert.match(html,/role="alert"/);
  } finally {
    if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');
  }
});
