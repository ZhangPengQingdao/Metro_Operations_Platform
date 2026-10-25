import test from 'node:test';
import assert from 'node:assert/strict';
import {employeeLoginDestination} from '../../src/app-platform/identity/login-destination.ts';

const task = 'da9ed501-5274-44b8-82cf-707cb15f94b4';
const path = `/employee/app/signatures/sign/${task}`;

test('employee sign-in resumes current signature task links and normalizes legacy links', () => {
 assert.equal(employeeLoginDestination(path), path);
 assert.equal(employeeLoginDestination(`/employee/app/signatures/sign?task=${task}`), path);
});

test('employee sign-in rejects external, malformed and unrelated return destinations', () => {
 for (const requested of [undefined, null, {}, '/admin', '/employee/app/todos', `https://example.com${path}`, `//example.com${path}`, path + '/extra', path + '?next=/admin', path + '#extra', path + '\n', path.replace(task, 'invalid'), path.replace('/sign/', '/sign/%2f')]) {
  assert.equal(employeeLoginDestination(requested), '/employee', String(requested));
 }
});
