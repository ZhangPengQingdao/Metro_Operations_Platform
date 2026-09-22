import { createHash, randomBytes } from 'node:crypto';

export interface SandboxBundlePart { text: string; bytes: number; sha256: string }
export interface SandboxDocumentInput { script: SandboxBundlePart; style?: SandboxBundlePart; platformOrigin: string; route?:string }
export interface SandboxDocument { html: string; headers: Readonly<Record<string, string>> }

function verified(part: SandboxBundlePart, max: number): string {
  if (!part || typeof part.text !== 'string' || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > max
    || Buffer.byteLength(part.text) !== part.bytes || part.text.includes('\0') || part.text.startsWith('\ufeff')
    || Buffer.from(part.text).toString('utf8') !== part.text
    || !/^[a-f0-9]{64}$/.test(part.sha256) || createHash('sha256').update(part.text).digest('hex') !== part.sha256) {
    throw new Error('SANDBOX_INVALID_ARTIFACT');
  }
  return part.text;
}

/** Trusted resource-server composition only; not a URL fetcher, installer or production route. */
export function buildSandboxDocument(input: SandboxDocumentInput): SandboxDocument {
  let origin: URL;
  try { origin = new URL(input.platformOrigin); } catch { throw new Error('SANDBOX_INVALID_PLATFORM_ORIGIN'); }
  if (origin.origin !== input.platformOrigin || origin.username || origin.password
    || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(origin.hostname)))) {
    throw new Error('SANDBOX_INVALID_PLATFORM_ORIGIN');
  }
  const script = verified(input.script, 1024 * 1024);
  const style = input.style ? verified(input.style, 256 * 1024) : '';
  const nonce = randomBytes(24).toString('base64');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  // Host-generated theme fragment contains no identity or authority. Apply before the first style/paint.
  const themeBoot = `const t=location.hash==='#mop-theme=dark'?'dark':location.hash==='#mop-theme=light'?'light':document.documentElement.dataset.theme??(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.classList.add('afc-theme-neutral');document.documentElement.dataset.theme=t;`;
  const baseStyle = 'html,body{margin:0;background:#fafafa;color:#171717;color-scheme:light}html[data-theme="dark"],html[data-theme="dark"] body{background:#121212;color:#fafafa;color-scheme:dark}';
  // No arbitrary HTML, base, handlers or metadata precedes the enforced policy.
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Platform application</title><script nonce="${nonce}">${themeBoot}</script><style nonce="${nonce}">${baseStyle}${style.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="app"></div><script nonce="${nonce}" data-app-route="${encodeURIComponent(input.route??'/')}" data-platform-origin="${origin.origin.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">${script.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
  return Object.freeze({ html, headers: Object.freeze({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `${csp}; sandbox allow-scripts; frame-ancestors ${origin.origin}`,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
  }) });
}
