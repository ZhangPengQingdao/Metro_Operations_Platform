import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('platform restores appearance before the React entry or first stylesheet, including unavailable storage',()=>{
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 const boot=html.match(/<script>([^<]+)<\/script>/)![1];
 assert.ok(html.indexOf(boot)<html.indexOf('<style>'));
 assert.ok(html.indexOf(boot)<html.indexOf('/src/main.tsx'));
 for(const [value,expected] of [['dark','dark'],['light','light'],['system','system'],['invalid','system'],[null,'system']] as const){
  const dataset:Record<string,string>={};
  runInNewContext(boot,{localStorage:{getItem:()=>value},document:{documentElement:{dataset}}});
  assert.equal(dataset.theme,expected);
 }
 const dataset:Record<string,string>={};
 runInNewContext(boot,{localStorage:{getItem:()=>{throw Error('unavailable');}},document:{documentElement:{dataset}}});
 assert.equal(dataset.theme,'system');
});
