import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { AppPackageError, readDeveloperFile, validateAppDirectory } from './package.js';

const identifier = z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const envelopeSchema = z.object({
  signatureVersion: z.literal('1.0'), algorithm: z.literal('Ed25519'),
  keyId: identifier, publisherId: identifier,
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();
export interface PublisherTrust {
  keyId: string;
  publisherId: string;
  publicKeyPem: string;
  revoked: boolean;
}
// Manifest has already passed the authoritative bounded JSON/schema validator.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function payload(keyId: string, publisherId: string, digest: string) {
  return Buffer.from(`AFC-APP-PACKAGE-SIGNATURE\n1.0\nEd25519\n${keyId}\n${publisherId}\n${digest}\n`, 'utf8');
}
const digestManifest = (manifest: unknown) => createHash('sha256').update(canonical(manifest)).digest('hex');

export async function signAppDirectory(directory: string, keyId: string, privateKeyFile: string, signatureFile: string) {
  if (!identifier.safeParse(keyId).success) throw new AppPackageError('INVALID_SIGNING_KEY_ID');
  const { manifest } = await validateAppDirectory(directory);
  const pem = await readDeveloperFile(privateKeyFile, 16384);
  let key;
  try { key = createPrivateKey(pem); } catch { throw new AppPackageError('INVALID_SIGNING_KEY'); }
  finally { pem.fill(0); }
  if (key.asymmetricKeyType !== 'ed25519') throw new AppPackageError('INVALID_SIGNING_KEY');
  const manifestSha256 = digestManifest(manifest);
  const envelope = { signatureVersion: '1.0', algorithm: 'Ed25519', keyId, publisherId: manifest.publisherId, manifestSha256,
    signature: sign(null, payload(keyId, manifest.publisherId, manifestSha256), key).toString('base64') };
  await writeFile(signatureFile, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { appId: manifest.id, publisherId: manifest.publisherId, keyId, manifestSha256 };
}

/** Trust is supplied by platform policy, never by the package or signature file. */
export async function verifyAppDirectory(directory: string, signatureFile: string, trusted: PublisherTrust) {
  const trust = { ...trusted };
  if (trust.revoked !== false || !identifier.safeParse(trust.keyId).success || !identifier.safeParse(trust.publisherId).success
    || typeof trust.publicKeyPem !== 'string' || Buffer.byteLength(trust.publicKeyPem) > 16384) throw new AppPackageError('UNTRUSTED_PUBLISHER_KEY');
  const envelope = await readPackageSignature(signatureFile);
  const { manifest } = await validateAppDirectory(directory);
  const digest = digestManifest(manifest);
  if (envelope.keyId !== trust.keyId || envelope.publisherId !== trust.publisherId || manifest.publisherId !== trust.publisherId
    || envelope.manifestSha256 !== digest) throw new AppPackageError('PACKAGE_SIGNATURE_MISMATCH');
  let publicKey;
  try { publicKey = createPublicKey(trust.publicKeyPem); } catch { throw new AppPackageError('UNTRUSTED_PUBLISHER_KEY'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new AppPackageError('UNTRUSTED_PUBLISHER_KEY');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.toString('base64') !== envelope.signature || !verify(null, payload(trust.keyId, trust.publisherId, digest), publicKey, signature)) throw new AppPackageError('PACKAGE_SIGNATURE_MISMATCH');
  return { manifest, keyId: trust.keyId, manifestSha256: digest };
}

/** Identity hints remain untrusted until full verification against platform policy. */
export async function readPackageSignature(signatureFile: string) {
  let input: unknown;
  try { input = JSON.parse((await readDeveloperFile(signatureFile, 4096)).toString('utf8')); }
  catch { throw new AppPackageError('INVALID_PACKAGE_SIGNATURE'); }
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) throw new AppPackageError('INVALID_PACKAGE_SIGNATURE');
  return parsed.data;
}
