import { z } from 'zod';
import { MOPKG_LIMITS, MopkgError } from '@metro/platform-sdk/mopkg';

/** Request body limit for a base64-encoded `.mopkg` upload. */
export const MOPKG_BODY_LIMIT = Math.ceil(MOPKG_LIMITS.packageBytes / 3) * 4 + 1024;

/** Decodes the `{package: <base64 .mopkg>}` request body. */
export function mopkgBody(body: unknown): Uint8Array {
  const { package: encoded } = z.object({ package: z.string().min(1).max(Math.ceil(MOPKG_LIMITS.packageBytes / 3) * 4) }).strict().parse(body);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new MopkgError('MOPKG_INVALID');
  return Buffer.from(encoded, 'base64');
}
