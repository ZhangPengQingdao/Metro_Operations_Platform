import { isDeepStrictEqual } from 'node:util';
import { rm } from 'node:fs/promises';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import { stageAppArtifacts } from '../runtime/artifacts.js';
import { AppPackageError, snapshotPackage } from './package.js';
import { verifyAppWithPublisherPolicy } from './publisher-policy.js';

/** Platform composition only: no paths, policy loader or actor accepted from application metadata. */
export interface AppInstallPreparationOptions {
  directory: string;
  signatureFile: string;
  artifactRoot: string;
  context: PlatformManagementContext;
  loadPublisherPolicy(): Promise<unknown>;
  clock?: () => Date;
}
async function requireAdministrator(context: PlatformManagementContext) {
  if (!isNativeManagementActor(context)
    || !(await context.authorize('platform.authorization.manage', {})).allowed) throw new AppPackageError('INSTALL_ACCESS_DENIED');
}
/** Prepare immutable bytes only. Does not register, grant, enable, migrate, or execute an application.
 * Returned evidence is not an authorization token; installation must recheck at its commit boundary. */
export async function prepareAppInstallation(options: AppInstallPreparationOptions) {
  const { context, directory, signatureFile, artifactRoot, loadPublisherPolicy, clock } = options;
  await requireAdministrator(context);
  const verified = await verifyAppWithPublisherPolicy(directory, signatureFile, loadPublisherPolicy, clock);
  const snapshot = await snapshotPackage(directory);
  if (!isDeepStrictEqual(snapshot.manifest, verified.manifest)) throw new AppPackageError('INSTALL_PACKAGE_CHANGED');
  await requireAdministrator(context);
  const staged = await stageAppArtifacts({ root: artifactRoot, manifest: snapshot.manifest,
    read: async (artifactId, maxBytes) => {
      const artifact = snapshot.manifest.artifacts.find(item => item.id === artifactId);
      const bytes = artifact && snapshot.files.get(artifact.path);
      if (!bytes || bytes.length !== maxBytes) throw new AppPackageError('INSTALL_PACKAGE_CHANGED');
      return bytes;
    },
  });
  try {
    const current = await verifyAppWithPublisherPolicy(directory, signatureFile, loadPublisherPolicy, clock);
    if (current.manifestSha256 !== verified.manifestSha256 || current.keyId !== verified.keyId
      || current.policySha256 !== verified.policySha256) throw new AppPackageError('INSTALL_ADMISSION_CHANGED');
    await requireAdministrator(context);
    return { status: 'prepared' as const, path: staged.path, manifest: snapshot.manifest,
      manifestDigest: staged.manifestDigest, signatureManifestSha256: verified.manifestSha256,
      publisherKeyId: verified.keyId, publisherPolicyRevision: verified.policyRevision,
      publisherPolicySha256: verified.policySha256 };
  } catch (error) {
    // This fresh bundle is owned by this attempt and has never been handed to a runtime.
    await rm(staged.path, { recursive: true, force: true });
    throw error;
  }
}
