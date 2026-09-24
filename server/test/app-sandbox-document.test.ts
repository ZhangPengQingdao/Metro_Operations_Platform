import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { buildSandboxDocument } from '../src/app-platform/sandbox/document.ts';
const part=(text:string)=>({text,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});
test('sandbox document validates bytes/hash and emits restrictive response policy before executable content',()=>{
  const a=buildSandboxDocument({script:part('document.getElementById("app").textContent="hello"'),platformOrigin:'https://platform.example.com'});
  assert.match(a.headers['Content-Security-Policy'],/sandbox allow-scripts; frame-ancestors https:\/\/platform.example.com/);
  assert.match(a.html,/connect-src 'none'/);assert.ok(a.html.indexOf('Content-Security-Policy')<a.html.indexOf('<script'));
  assert.doesNotMatch(a.headers['Content-Security-Policy'],/allow-same-origin|unsafe-inline|unsafe-eval/);
  const b=buildSandboxDocument({script:part('0'),platformOrigin:'https://platform.example.com'});
  assert.notEqual(a.headers['Content-Security-Policy'],b.headers['Content-Security-Policy']);
  assert.equal(a.headers['Cache-Control'],'no-store');
});
test('sandbox builder rejects tampered/oversized/unencodable artifacts and origin injection; closing tags cannot escape',()=>{
  for(const script of [{...part('0'),bytes:2},{...part('0'),sha256:'0'.repeat(64)},part('a'.repeat(1024*1024+1)),part('\ud800')]) {
    assert.throws(()=>buildSandboxDocument({script,platformOrigin:'https://platform.example.com'}),/SANDBOX_INVALID_ARTIFACT/);
  }
  for(const platformOrigin of ['https://platform.example.com/path','https://u:p@example.com','http://platform.example.com',"https://example.com;script-src *"]) {
    assert.throws(()=>buildSandboxDocument({script:part('0'),platformOrigin}),/SANDBOX_INVALID_PLATFORM_ORIGIN/);
  }
  const html=buildSandboxDocument({script:part('const s="</script><img src=x>"'),style:part('/* </style><script> */'),platformOrigin:'http://127.0.0.1:5173'}).html;
  assert.equal((html.match(/<script nonce=/g)||[]).length,2);assert.equal((html.match(/<\/script>/g)||[]).length,2);
});

test('production sandbox applies explicit host theme before CSS and app code, independently of system preference',()=>{
 const html=buildSandboxDocument({script:part('appBoot()'),platformOrigin:'https://platform.example.com'}).html;
 const boot=html.match(/<script nonce="[^"]+">([^<]+)<\/script>/)![1];
 assert.ok(html.indexOf(boot)<html.indexOf('<style'));
 for(const [hash,systemDark,expected] of [['#mop-theme=dark',false,'dark'],['#mop-theme=light',true,'light'],['',true,'dark'],['#mop-theme=invalid',false,'light']] as const){
  const classes=new Set<string>(),dataset:Record<string,string>={};
  const documentElement={dataset,classList:{add:(v:string)=>classes.add(v)}};
  runInNewContext(boot,{location:{hash},document:{documentElement},matchMedia:()=>({matches:systemDark})});
  assert.equal(dataset.theme,expected);assert.ok(classes.has('afc-theme-neutral'));
 }
});
test('trusted document keeps admission HTML small and references only its verified hash bundle',()=>{
 const script=part('document.body.textContent="large";');
 const result=buildSandboxDocument({platformOrigin:'https://platform.example.com',script,trusted:{appId:'materials'}});
 assert.match(result.html,new RegExp(`/assets/materials/${script.sha256}/ui\\.js`));
 assert.doesNotMatch(result.html,/document\.body\.textContent/);
 assert.match(result.headers['Content-Security-Policy'],/script-src 'nonce-[^']+' 'self'/);
 assert.match(result.headers['Content-Security-Policy'],/sandbox allow-scripts allow-same-origin/);
 assert.equal(result.headers['Cache-Control'],'no-store');
});
