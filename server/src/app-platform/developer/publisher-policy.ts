import { createPublicKey, createHash } from 'node:crypto';
import { z } from 'zod';
import { AppPackageError, readDeveloperFile } from './package.js';
import { readPackageSignature, verifyAppDirectory } from './signature.js';

const id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const instant = z.string().datetime({ offset: true });
const schema = z.object({
  policyVersion: z.literal('1.0'), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  keys: z.array(z.object({ keyId: id, publisherId: id, publicKeyPem: z.string().min(1).max(16384),
    revoked: z.boolean(), appIds: z.array(id).min(1).max(128), validFrom: instant, validUntil: instant,
  }).strict()).max(128),
}).strict();
export type PublisherPolicy = z.infer<typeof schema>;
export async function loadPublisherPolicy(file: string): Promise<PublisherPolicy> {
  let value: unknown;
  try { value = JSON.parse((await readDeveloperFile(file, 262144)).toString('utf8')); }
  catch { throw new AppPackageError('INVALID_PUBLISHER_POLICY'); }
  return parsePolicy(value);
}
export function parsePolicy(input: unknown): PublisherPolicy {
  const parsed = schema.safeParse(input);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 262144) throw new AppPackageError('INVALID_PUBLISHER_POLICY');
  const identities = new Set<string>();
  for (const key of parsed.data.keys) {
    const identity = `${key.publisherId}/${key.keyId}`;
    if (identities.has(identity) || new Set(key.appIds).size !== key.appIds.length || Date.parse(key.validUntil) <= Date.parse(key.validFrom)) throw new AppPackageError('INVALID_PUBLISHER_POLICY');
    identities.add(identity);
    try {
      // Policy must contain public material, never accept a private PEM as a public key.
      if (!key.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----') || createPublicKey(key.publicKeyPem).asymmetricKeyType !== 'ed25519') throw Error();
    } catch { throw new AppPackageError('INVALID_PUBLISHER_POLICY'); }
  }
  return parsed.data;
}

/** Read-only admission check. Caller owns policy loader and must recheck at installation commit. */
export async function verifyAppWithPublisherPolicy(directory: string, signatureFile: string,
  load: () => Promise<unknown>, clock: () => Date = () => new Date()) {
  const before = parsePolicy(await load());
  const hint = await readPackageSignature(signatureFile);
  const selected = before.keys.find(key => key.keyId === hint.keyId && key.publisherId === hint.publisherId);
  const active = (key: PublisherPolicy['keys'][number]) => {
    const now = clock().getTime();
    return Number.isFinite(now) && !key.revoked && now >= Date.parse(key.validFrom) && now < Date.parse(key.validUntil);
  };
  if (!selected || !active(selected)) throw new AppPackageError('UNTRUSTED_PUBLISHER_KEY');
  const verified = await verifyAppDirectory(directory, signatureFile, { keyId: selected.keyId, publisherId: selected.publisherId, publicKeyPem: selected.publicKeyPem, revoked: selected.revoked });
  if (!selected.appIds.includes(verified.manifest.id)) throw new AppPackageError('PUBLISHER_APP_DENIED');
  const after = parsePolicy(await load());
  // Fail closed even if policy contents changed without the required revision bump.
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new AppPackageError('PUBLISHER_POLICY_CHANGED');
  if (!active(selected)) throw new AppPackageError('UNTRUSTED_PUBLISHER_KEY');
  return { ...verified, policyRevision: before.revision,
    policySha256: createHash('sha256').update(JSON.stringify(before)).digest('hex') };
}
