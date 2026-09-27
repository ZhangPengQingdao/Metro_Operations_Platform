/** Browser-side file helpers for signed sandbox apps. Files never cross the Bridge. */
import type {AppGatewayJson} from './app-gateway.js';
export class AppFileError extends Error {
  constructor(readonly code: 'INVALID_FILE' | 'FILE_TOO_LARGE' | 'UNSUPPORTED_FILE' | 'INVALID_TEXT' | 'INVALID_DOWNLOAD' | 'INVALID_IMAGE' | 'IMAGE_TOO_LARGE') {
    super(code);
    this.name = 'AppFileError';
  }
}

export interface SandboxFileOptions {
  /** Maximum bytes to read; the SDK hard limit is 16 MiB. */
  maxBytes: number;
  /** File extension checks are a UI guard, not proof of the file format. */
  extensions?: readonly string[];
}

const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const APP_IMAGE_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const APP_IMAGE_MAX_BYTES = 220_000;
export const APP_IMAGE_PART_BYTES = 22_000;
const safeName = (name: string) => typeof name === 'string' && name.length > 0 && name.length <= 180
  && name.trim() === name && !/[\\/\u0000-\u001f\u007f<>:"|?*]/.test(name) && name !== '.' && name !== '..';

function validateFile(file: Blob & {name: string}, options: SandboxFileOptions) {
  if (!file || !options || typeof file.arrayBuffer !== 'function' || !safeName(file.name)
    || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > MAX_READ_BYTES
    || !Number.isSafeInteger(file.size) || file.size < 0) throw new AppFileError('INVALID_FILE');
  if (file.size > options.maxBytes) throw new AppFileError('FILE_TOO_LARGE');
  if (options.extensions) {
    if (!options.extensions.length || options.extensions.some(extension => !/^\.[a-z0-9]{1,12}$/i.test(extension))) throw new AppFileError('INVALID_FILE');
    if (!options.extensions.some(extension => file.name.toLowerCase().endsWith(extension.toLowerCase()))) throw new AppFileError('UNSUPPORTED_FILE');
  }
}

/** Read a user-selected File locally, with explicit size and extension bounds. */
export async function readSandboxFile(file: Blob & {name: string}, options: SandboxFileOptions): Promise<Uint8Array> {
  validateFile(file, options);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > options.maxBytes) throw new AppFileError('FILE_TOO_LARGE');
  return bytes;
}

/** Decode text strictly so malformed bytes cannot silently alter imported records. */
export async function readSandboxTextFile(file: Blob & {name: string}, options: SandboxFileOptions): Promise<string> {
  const bytes = await readSandboxFile(file, options);
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/^\ufeff/, ''); }
  catch { throw new AppFileError('INVALID_TEXT'); }
}

/** Trigger an authorized sandbox download. The signed manifest must declare ui.downloads. */
export function downloadSandboxFile(name: string, contents: Blob | Uint8Array | ArrayBuffer, contentType = 'application/octet-stream'): void {
  if (!safeName(name) || !/^[-\w.+]+\/[-\w.+]+$/.test(contentType)) throw new AppFileError('INVALID_DOWNLOAD');
  const blob = contents instanceof Blob ? contents : new Blob([contents], {type: contentType});
  if (!Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > MAX_DOWNLOAD_BYTES) throw new AppFileError('INVALID_DOWNLOAD');
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') throw new AppFileError('INVALID_DOWNLOAD');
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.style.display = 'none';
    document.body.append(link);
    try { link.click(); } finally { link.remove(); }
  } finally {
    // Revoking in the same task can cancel a browser download.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** Turn a user-selected JPEG, PNG or WebP into a bounded JPEG without retaining the source file. */
export async function prepareSandboxImage(file: Blob & {name: string}): Promise<Uint8Array> {
  await readSandboxFile(file, {maxBytes: APP_IMAGE_SOURCE_MAX_BYTES, extensions: ['.jpg','.jpeg','.png','.webp']});
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') throw new AppFileError('INVALID_IMAGE');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new AppFileError('INVALID_IMAGE'); }
  try {
    if (!bitmap.width || !bitmap.height) throw new AppFileError('INVALID_IMAGE');
    const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new AppFileError('INVALID_IMAGE');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82,0.70,0.58,0.46,0.34]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= APP_IMAGE_MAX_BYTES) return new Uint8Array(await blob.arrayBuffer());
    }
    throw new AppFileError('IMAGE_TOO_LARGE');
  } finally { bitmap.close(); }
}

export interface SandboxImageOperations {begin: string; part: string; finish: string; read: string}
export type SandboxImageInvoke = (operation: string, payload: AppGatewayJson, write: boolean) => Promise<unknown>;
const imageId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const encodeBase64 = (bytes: Uint8Array) => { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); };
const decodeBase64 = (value: unknown) => {
  if (typeof value !== 'string' || value.length > 30_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) throw new AppFileError('INVALID_IMAGE');
  const decoded = atob(value), bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  if (encodeBase64(bytes) !== value) throw new AppFileError('INVALID_IMAGE');
  return bytes;
};
const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Uses app-defined API handlers; each write has a fresh intent ID and is never retried after an unknown result. */
export function createSandboxImageClient(invoke: SandboxImageInvoke, operations: SandboxImageOperations) {
  if (typeof invoke !== 'function' || !operations || Object.values(operations).some(value => typeof value !== 'string' || !value)) throw new AppFileError('INVALID_IMAGE');
  async function uploadPrepared(bytes: Uint8Array, input: {organizationId: string; kind: string}): Promise<string> {
    if (!(bytes instanceof Uint8Array) || bytes.length < 5 || bytes.length > APP_IMAGE_MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9
      || !imageId(input?.organizationId) || !/^[a-z][a-z0-9_-]{0,31}$/.test(input.kind)) throw new AppFileError('INVALID_IMAGE');
    const id = crypto.randomUUID(), parts = Math.ceil(bytes.length / APP_IMAGE_PART_BYTES);
    await invoke(operations.begin, {requestId: crypto.randomUUID(), id, organizationId: input.organizationId, kind: input.kind, bytes: bytes.length, sha256: await sha256(bytes), parts}, true);
    for (let index = 0; index < parts; index++) await invoke(operations.part, {requestId: crypto.randomUUID(), id: crypto.randomUUID(), photoId: id, index, data: encodeBase64(bytes.slice(index * APP_IMAGE_PART_BYTES, (index + 1) * APP_IMAGE_PART_BYTES))}, true);
    await invoke(operations.finish, {requestId: crypto.randomUUID(), photoId: id}, true);
    return id;
  }
  return Object.freeze({
    async upload(file: Blob & {name: string}, input: {organizationId: string; kind: string}) { return uploadPrepared(await prepareSandboxImage(file), input); },
    uploadPrepared,
    async read(input: {recordId: string; photoId: string}): Promise<Blob> {
      if (!imageId(input?.recordId) || !imageId(input?.photoId)) throw new AppFileError('INVALID_IMAGE');
      const first = await invoke(operations.read, {...input, index: 0}, false) as {data: string; index: number; parts: number; mime: string; bytes: number; sha256: string};
      if (first?.index !== 0 || !Number.isInteger(first.parts) || first.parts < 1 || first.parts > 16 || !Number.isInteger(first.bytes) || first.bytes < 5 || first.bytes > APP_IMAGE_MAX_BYTES || first.mime !== 'image/jpeg' || !/^[0-9a-f]{64}$/.test(first.sha256)) throw new AppFileError('INVALID_IMAGE');
      const chunks = [decodeBase64(first.data)];
      for (let index = 1; index < first.parts; index++) {
        const part = await invoke(operations.read, {...input, index}, false) as {data: string; index: number; parts: number; bytes: number; sha256: string};
        if (part?.index !== index || part.parts !== first.parts || part.bytes !== first.bytes || part.sha256 !== first.sha256) throw new AppFileError('INVALID_IMAGE');
        chunks.push(decodeBase64(part.data));
      }
      const bytes = new Uint8Array(chunks.reduce((size, part) => size + part.length, 0));
      let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (bytes.length !== first.bytes || await sha256(bytes) !== first.sha256) throw new AppFileError('INVALID_IMAGE');
      return new Blob([bytes], {type: first.mime});
    }
  });
}
