import test from 'node:test';
import assert from 'node:assert/strict';
import {echo} from './app.mjs';
test('echo validates input and respects stop',async()=>{
 const controller=new AbortController();assert.deepEqual(await echo({message:'hello'},controller.signal),{message:'hello'});
 await assert.rejects(echo({extra:true},controller.signal));controller.abort();await assert.rejects(echo({message:'late'},controller.signal));
});
