import test from 'node:test';
import assert from 'node:assert/strict';
import {AppFileError,readSandboxFile,readSandboxTextFile,downloadSandboxFile} from '@metro/platform-sdk/app-files';

const selectedFile = (name: string, bytes: Uint8Array) => Object.assign(new Blob([bytes]), {name});

test('sandbox file reader enforces size and extension before parsing', async () => {
  const file = selectedFile('检修计划.CSV', new TextEncoder().encode('\ufeff日期,车站\n2026-09-27,测试站'));
  assert.equal(await readSandboxTextFile(file, {maxBytes: 100, extensions: ['.csv']}), '日期,车站\n2026-09-27,测试站');
  assert.deepEqual(await readSandboxFile(file, {maxBytes: 100, extensions: ['.csv']}), new Uint8Array(await file.arrayBuffer()));
  await assert.rejects(readSandboxFile(file, {maxBytes: 4, extensions: ['.csv']}), (error: unknown) => error instanceof AppFileError && error.code === 'FILE_TOO_LARGE');
  await assert.rejects(readSandboxFile(file, {maxBytes: 100, extensions: ['.xlsx']}), (error: unknown) => error instanceof AppFileError && error.code === 'UNSUPPORTED_FILE');
  await assert.rejects(readSandboxFile(selectedFile('../bad.csv', new Uint8Array([1])), {maxBytes: 100}), (error: unknown) => error instanceof AppFileError && error.code === 'INVALID_FILE');
  await assert.rejects(readSandboxTextFile(selectedFile('bad.csv', new Uint8Array([0xff])), {maxBytes: 100}), (error: unknown) => error instanceof AppFileError && error.code === 'INVALID_TEXT');
});

test('sandbox file reader verifies bytes after an untrusted size report', async () => {
  const file = {name: 'large.csv', size: 1, arrayBuffer: async () => new Uint8Array(101).buffer} as Blob & {name: string};
  await assert.rejects(readSandboxFile(file, {maxBytes: 100}), (error: unknown) => error instanceof AppFileError && error.code === 'FILE_TOO_LARGE');
});

test('sandbox download rejects invalid filenames and oversized output before DOM use', () => {
  assert.throws(() => downloadSandboxFile('../records.csv', 'x' as unknown as Uint8Array), (error: unknown) => error instanceof AppFileError && error.code === 'INVALID_DOWNLOAD');
  assert.throws(() => downloadSandboxFile('records.csv', new Uint8Array(32 * 1024 * 1024 + 1)), (error: unknown) => error instanceof AppFileError && error.code === 'INVALID_DOWNLOAD');
});
