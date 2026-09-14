import test from 'node:test';
import assert from 'node:assert/strict';
import {nextVersion,checkVersions} from '../../scripts/version.mjs';
test('release increments reset lower components and metadata remains synchronized',async()=>{
 assert.equal(nextVersion('0.0.1','patch'),'0.0.2');assert.equal(nextVersion('0.0.9','minor'),'0.1.0');assert.equal(nextVersion('0.9.7','major'),'1.0.0');
 assert.throws(()=>nextVersion('invalid','patch'));assert.throws(()=>nextVersion('0.0.1','other'));
 assert.match((await checkVersions()).version,/^\d+\.\d+\.\d+$/);
});
