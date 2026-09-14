import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getCoreConfig } from '../config/index.js';

export type StorageNamespace = string;
export type PublicStorageRoute = 'public' | 'preview';

export interface PublicStorageReference {
  route: PublicStorageRoute;
  kind: StorageNamespace;
  fileName: string;
}

export interface StorageObjectReference {
  kind: StorageNamespace;
  fileName: string;
}

export interface StorageObjectMetadata extends StorageObjectReference {
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  contentType?: string;
}

export interface StorageMetadataRepository {
  save(metadata: StorageObjectMetadata): Promise<void>;
  find(kind: StorageNamespace, fileName: string): Promise<StorageObjectMetadata | null>;
  remove(kind: StorageNamespace, fileName: string): Promise<void>;
}

export interface StorageAdapter {
  ensureLayout(kinds?: readonly StorageNamespace[]): Promise<void>;
  folderPath(kind: StorageNamespace): string;
  filePath(kind: StorageNamespace, fileName: string): string;
  previewFolderPath(): string;
  previewPath(fileName: string): string;
  writeObject(
    kind: StorageNamespace,
    fileName: string,
    bytes: Buffer,
    options?: { exclusive?: boolean; contentType?: string; now?: Date }
  ): Promise<StorageObjectMetadata>;
  createObjectReadStream(kind: StorageNamespace, fileName: string): NodeJS.ReadableStream;
  exists(kind: StorageNamespace, fileName: string): Promise<boolean>;
  deleteObject(kind: StorageNamespace, fileName: string): Promise<void>;
  deletePreview(fileName: string): Promise<void>;
}

export class StoragePathError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoragePathError';
    this.code = code;
  }
}

export class StorageSignatureError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StorageSignatureError';
    this.code = code;
  }
}

export function getDefaultStorageRootDir() {
  return getCoreConfig().storage.uploadDir.value;
}

export function getDefaultPublicStorageBaseUrl() {
  const config = getCoreConfig();
  return config.http.publicBaseUrl.value ?? `http://127.0.0.1:${config.runtime.port.value}`;
}

export function getDefaultStorageSigningSecret() {
  const secret = getCoreConfig().session.secret.reveal();

  if (!secret) {
    throw new StorageSignatureError('STORAGE_SIGNING_SECRET_MISSING', 'Storage signed URLs require a configured signing secret.');
  }

  return secret;
}

export function isSafeStorageNamespace(value: unknown): value is StorageNamespace {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

export function assertSafeStorageNamespace(value: string) {
  if (!isSafeStorageNamespace(value)) {
    throw new StoragePathError('UNSAFE_STORAGE_NAMESPACE', `Unsafe storage namespace: ${value}`);
  }
}

export function isSafeStorageFileName(fileName: string) {
  return Boolean(fileName) && path.basename(fileName) === fileName;
}

export function assertSafeStorageFileName(fileName: string) {
  if (!isSafeStorageFileName(fileName)) {
    throw new StoragePathError('UNSAFE_STORAGE_FILE_NAME', `Unsafe storage file name: ${fileName}`);
  }
}

export function sha256Bytes(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function storagePreviewCacheFileName(fileName: string) {
  return `${sha256Bytes(fileName)}.webp`;
}

export function createPublicStorageSignature(kind: StorageNamespace, fileName: string, secret = getDefaultStorageSigningSecret()) {
  assertSafeStorageNamespace(kind);
  assertSafeStorageFileName(fileName);

  return createHmac('sha256', secret)
    .update(`${kind}/${fileName}`, 'utf8')
    .digest('base64url');
}

export function verifyPublicStorageSignature(
  kind: StorageNamespace,
  fileName: string,
  signature: unknown,
  secret = getDefaultStorageSigningSecret()
) {
  if (typeof signature !== 'string' || !signature || !isSafeStorageNamespace(kind) || !isSafeStorageFileName(fileName)) {
    return false;
  }

  const expected = Buffer.from(createPublicStorageSignature(kind, fileName, secret));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function buildSignedPublicStoragePath(
  kind: StorageNamespace,
  fileName: string,
  options: { route?: PublicStorageRoute; secret?: string } = {}
) {
  assertSafeStorageNamespace(kind);
  assertSafeStorageFileName(fileName);
  const route = options.route ?? 'public';
  const signature = createPublicStorageSignature(kind, fileName, options.secret);
  return `/api/files/${route}/${kind}/${encodeURIComponent(fileName)}?sig=${signature}`;
}

export function buildSignedPublicStorageUrl(
  baseUrl: string,
  kind: StorageNamespace,
  fileName: string,
  options: { route?: PublicStorageRoute; secret?: string } = {}
) {
  return new URL(buildSignedPublicStoragePath(kind, fileName, options), `${baseUrl.replace(/\/$/, '')}/`).toString();
}

export function parsePublicStorageReference(value: string, baseUrl = getDefaultPublicStorageBaseUrl()): PublicStorageReference | null {
  try {
    const url = new URL(value, baseUrl);
    const match = url.pathname.match(/^\/api\/files\/(public|preview)\/([^/]+)\/(.+)$/);
    if (!match) return null;

    const kind = decodeURIComponent(match[2]);
    const fileName = decodeURIComponent(match[3]);
    if (!isSafeStorageNamespace(kind) || !isSafeStorageFileName(fileName)) return null;

    return {
      route: match[1] as PublicStorageRoute,
      kind,
      fileName
    };
  } catch {
    return null;
  }
}

export function isPublicStorageUrl(value: string) {
  return parsePublicStorageReference(value) !== null;
}

export function normalizePublicStorageUrl(value: string) {
  const reference = parsePublicStorageReference(value);
  if (!reference) return value;
  return buildSignedPublicStoragePath(reference.kind, reference.fileName, { route: reference.route });
}

export function normalizePublicStorageReferences<T>(value: T): T {
  if (typeof value === 'string') {
    return normalizePublicStorageUrl(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizePublicStorageReferences(item)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizePublicStorageReferences(item)])
    ) as T;
  }

  return value;
}

export function createLocalStorageAdapter(options: { rootDir?: string } = {}): StorageAdapter {
  const rootDir = path.resolve(options.rootDir ?? getDefaultStorageRootDir());
  const folderPath = (kind: StorageNamespace) => {
    assertSafeStorageNamespace(kind);
    return path.resolve(rootDir, kind);
  };
  const filePath = (kind: StorageNamespace, fileName: string) => {
    assertSafeStorageFileName(fileName);
    return path.join(folderPath(kind), fileName);
  };
  const previewFolderPath = () => path.resolve(rootDir, 'previews');
  const previewPath = (fileName: string) => {
    assertSafeStorageFileName(fileName);
    return path.join(previewFolderPath(), storagePreviewCacheFileName(fileName));
  };

  return {
    async ensureLayout(kinds = []) {
      await fs.mkdir(rootDir, { recursive: true });
      await fs.mkdir(previewFolderPath(), { recursive: true });

      for (const kind of kinds) {
        await fs.mkdir(folderPath(kind), { recursive: true });
      }
    },
    folderPath,
    filePath,
    previewFolderPath,
    previewPath,
    async writeObject(kind, fileName, bytes, options = {}) {
      const target = filePath(kind, fileName);
      await fs.mkdir(folderPath(kind), { recursive: true });
      await fs.writeFile(target, bytes, { flag: options.exclusive === false ? 'w' : 'wx' });
      return {
        kind,
        fileName,
        sizeBytes: bytes.byteLength,
        sha256: sha256Bytes(bytes),
        createdAt: (options.now ?? new Date()).toISOString(),
        contentType: options.contentType
      };
    },
    createObjectReadStream(kind, fileName) {
      return createReadStream(filePath(kind, fileName));
    },
    async exists(kind, fileName) {
      try {
        await fs.access(filePath(kind, fileName));
        return true;
      } catch {
        return false;
      }
    },
    async deleteObject(kind, fileName) {
      await fs.rm(filePath(kind, fileName), { force: true });
    },
    async deletePreview(fileName) {
      await fs.rm(previewPath(fileName), { force: true });
    }
  };
}

export function createMemoryStorageMetadataRepository(
  seed: readonly StorageObjectMetadata[] = []
): StorageMetadataRepository {
  const records = new Map<string, StorageObjectMetadata>();
  const key = (kind: StorageNamespace, fileName: string) => {
    assertSafeStorageNamespace(kind);
    assertSafeStorageFileName(fileName);
    return `${kind}/${fileName}`;
  };

  for (const record of seed) {
    records.set(key(record.kind, record.fileName), record);
  }

  return {
    async save(metadata) {
      records.set(key(metadata.kind, metadata.fileName), metadata);
    },
    async find(kind, fileName) {
      return records.get(key(kind, fileName)) ?? null;
    },
    async remove(kind, fileName) {
      records.delete(key(kind, fileName));
    }
  };
}

export function createMemoryStorageAdapter(
  options: { now?: () => Date } = {}
): StorageAdapter & { readObject(kind: StorageNamespace, fileName: string): Promise<Buffer | null> } {
  const objects = new Map<string, Buffer>();
  const key = (kind: StorageNamespace, fileName: string) => {
    assertSafeStorageNamespace(kind);
    assertSafeStorageFileName(fileName);
    return `${kind}/${fileName}`;
  };
  const now = options.now ?? (() => new Date());

  return {
    async ensureLayout() {
      // Memory adapter has no directory layout.
    },
    folderPath(kind) {
      assertSafeStorageNamespace(kind);
      return `/memory/${kind}`;
    },
    filePath(kind, fileName) {
      assertSafeStorageNamespace(kind);
      assertSafeStorageFileName(fileName);
      return `/memory/${kind}/${fileName}`;
    },
    previewFolderPath() {
      return '/memory/previews';
    },
    previewPath(fileName) {
      assertSafeStorageFileName(fileName);
      return `/memory/previews/${storagePreviewCacheFileName(fileName)}`;
    },
    async writeObject(kind, fileName, bytes, writeOptions = {}) {
      assertSafeStorageNamespace(kind);
      assertSafeStorageFileName(fileName);
      const objectKey = key(kind, fileName);

      if (writeOptions.exclusive !== false && objects.has(objectKey)) {
        throw new StoragePathError('STORAGE_OBJECT_EXISTS', `Storage object already exists: ${objectKey}`);
      }

      objects.set(objectKey, Buffer.from(bytes));
      return {
        kind,
        fileName,
        sizeBytes: bytes.byteLength,
        sha256: sha256Bytes(bytes),
        createdAt: (writeOptions.now ?? now()).toISOString(),
        contentType: writeOptions.contentType
      };
    },
    createObjectReadStream(kind, fileName) {
      return createReadStream(this.filePath(kind, fileName));
    },
    async exists(kind, fileName) {
      assertSafeStorageNamespace(kind);
      assertSafeStorageFileName(fileName);
      return objects.has(key(kind, fileName));
    },
    async deleteObject(kind, fileName) {
      assertSafeStorageNamespace(kind);
      assertSafeStorageFileName(fileName);
      objects.delete(key(kind, fileName));
    },
    async deletePreview() {
      // Preview bytes are outside the memory object map for now.
    },
    async readObject(kind, fileName) {
      assertSafeStorageNamespace(kind);
      assertSafeStorageFileName(fileName);
      return objects.get(key(kind, fileName)) ?? null;
    }
  };
}
