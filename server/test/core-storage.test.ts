import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const uploadRoot = await mkdtemp(path.join(tmpdir(), 'afc-core-storage-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  SESSION_SECRET: 'core-storage-test-secret',
  PUBLIC_BASE_URL: 'https://ops.552588.xyz',
  PORT: '3001',
  UPLOAD_DIR: uploadRoot
});

const {
  buildSignedPublicStoragePath,
  buildSignedPublicStorageUrl,
  createLocalStorageAdapter,
  createMemoryStorageAdapter,
  createMemoryStorageMetadataRepository,
  isPublicStorageUrl,
  parsePublicStorageReference,
  sha256Bytes,
  storagePreviewCacheFileName,
  verifyPublicStorageSignature
} = await import('../src/core/storage/index.ts');

after(async () => {
  assert.ok(uploadRoot.startsWith(path.join(tmpdir(), 'afc-core-storage-')));
  await rm(uploadRoot, { recursive: true });
});

function signatureFrom(value: string) {
  return new URL(value, 'https://ops.552588.xyz').searchParams.get('sig');
}

test('Core Storage signs, parses, and normalizes public file references without business policy', () => {
  const signedPath = buildSignedPublicStoragePath('media', 'a b.jpg');
  const signedUrl = buildSignedPublicStorageUrl('https://ops.552588.xyz/base', 'documents', 'signed.png');

  assert.match(signedPath, /^\/api\/files\/public\/media\/a%20b\.jpg\?sig=/);
  assert.equal(verifyPublicStorageSignature('media', 'a b.jpg', signatureFrom(signedPath)), true);
  assert.deepEqual(parsePublicStorageReference(signedPath), {
    route: 'public',
    kind: 'media',
    fileName: 'a b.jpg'
  });
  assert.equal(signedUrl.startsWith('https://ops.552588.xyz/api/files/public/documents/signed.png?sig='), true);
  assert.equal(isPublicStorageUrl('/api/files/preview/media/a.jpg?sig=old'), true);
  assert.equal(parsePublicStorageReference('/api/files/public/media/%2e%2e%2fsecret.txt'), null);
  assert.throws(() => buildSignedPublicStoragePath('../media', 'a.jpg'), /Unsafe storage namespace/);
});

test('Core Storage local adapter writes bytes, hashes content, and deletes objects safely', async () => {
  const adapter = createLocalStorageAdapter({ rootDir: uploadRoot });
  await adapter.ensureLayout();

  const metadata = await adapter.writeObject('media', 'photo.jpg', Buffer.from('hello'), {
    contentType: 'image/jpeg',
    now: new Date('2026-08-30T00:00:00.000Z')
  });

  assert.equal(metadata.sizeBytes, 5);
  assert.equal(metadata.sha256, sha256Bytes(Buffer.from('hello')));
  assert.equal(metadata.createdAt, '2026-08-30T00:00:00.000Z');
  assert.equal(metadata.contentType, 'image/jpeg');
  assert.equal((await stat(adapter.filePath('media', 'photo.jpg'))).isFile(), true);
  assert.equal(await adapter.exists('media', 'photo.jpg'), true);
  assert.equal(path.basename(adapter.previewPath('photo.jpg')), storagePreviewCacheFileName('photo.jpg'));

  await assert.rejects(
    () => adapter.writeObject('media', '../bad.jpg', Buffer.from('bad')),
    /Unsafe storage file name/
  );

  await adapter.deleteObject('media', 'photo.jpg');
  assert.equal(await adapter.exists('media', 'photo.jpg'), false);
});

test('Core Storage memory adapter and metadata repository support isolated tests', async () => {
  const adapter = createMemoryStorageAdapter({
    now: () => new Date('2026-08-30T01:00:00.000Z')
  });
  const metadataRepository = createMemoryStorageMetadataRepository();

  const metadata = await adapter.writeObject('audio', 'voice.webm', Buffer.from('audio'));
  await metadataRepository.save(metadata);

  assert.equal((await adapter.readObject('audio', 'voice.webm'))?.toString('utf8'), 'audio');
  assert.equal(await adapter.exists('audio', 'voice.webm'), true);
  await assert.rejects(
    () => adapter.writeObject('audio', 'voice.webm', Buffer.from('duplicate')),
    /Storage object already exists/
  );

  const stored = await metadataRepository.find('audio', 'voice.webm');
  assert.equal(stored?.sha256, metadata.sha256);

  await metadataRepository.remove('audio', 'voice.webm');
  assert.equal(await metadataRepository.find('audio', 'voice.webm'), null);
});
