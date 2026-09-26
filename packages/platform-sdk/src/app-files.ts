/** Browser-side file helpers for signed sandbox apps. Files never cross the Bridge. */
export class AppFileError extends Error {
  constructor(readonly code: 'INVALID_FILE' | 'FILE_TOO_LARGE' | 'UNSUPPORTED_FILE' | 'INVALID_TEXT' | 'INVALID_DOWNLOAD') {
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
