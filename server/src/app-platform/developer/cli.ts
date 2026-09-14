import { callInstallEndpoint } from '../install/client.js';
import { encodeInstallPackage } from '../install/wire.js';
import { InstallError } from '../install/journal.js';
import { loadPublisherPolicy, verifyAppWithPublisherPolicy } from './publisher-policy.js';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { AppPackageError, packAppDirectory, readDeveloperFile, validateAppDirectory } from './package.js';
import { signAppDirectory, verifyAppDirectory } from './signature.js';
import { createAppProject } from './scaffold.js';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'install' && args.length === 5) {
    const body = await encodeInstallPackage(args[0]!, args[1]!, args[4]!);
    const result = await callInstallEndpoint(args[2]!, args[3]!, '/api/v1/app-installations', body);
    console.log(JSON.stringify(result));
    if (result.state !== 'installed') process.exitCode = 1;
  } else if (command === 'install-status' && args.length === 3) {
    console.log(JSON.stringify(await callInstallEndpoint(args[1]!, args[2]!, `/api/v1/app-installations/${args[0]}`)));
  } else if (command === 'install-recover' && args.length === 4 && Number.isSafeInteger(Number(args[1])) && Number(args[1]) > 0) {
    console.log(JSON.stringify(await callInstallEndpoint(args[2]!, args[3]!, `/api/v1/app-installations/${args[0]}`, { operation: 'recover', revision: Number(args[1]) })));
  } else if (command === 'create' && args.length === 4) {
    console.log(JSON.stringify({ ok: true, ...await createAppProject(args[0]!, args[1]!, args[2]!, args[3]!) }));
  } else if ((command === 'test' || command === 'dev') && args.length === 1) {
    // Explicit local test execution. No shell interpolation or implicit npm lifecycle hooks.
    process.exitCode = await new Promise<number>((done, reject) => {
      const env = { ...process.env };
      // A caller running inside node:test must not turn the child runner into an embedded test.
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, command === 'test' ? ['--test', 'test.mjs'] : ['build.mjs', '--watch'], { cwd: resolve(args[0]!), stdio: 'inherit', env });
      const interrupt = () => { child.kill('SIGINT'); };
      const terminate = () => { child.kill('SIGTERM'); };
      const cleanup = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); };
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', code => { cleanup(); done(code ?? 1); });
    });
  } else if (command === 'sign' && args.length === 4) {
    console.log(JSON.stringify({ ok: true, ...await signAppDirectory(args[0]!, args[1]!, args[2]!, args[3]!) }));
  } else if (command === 'verify-policy' && args.length === 3) {
    const result = await verifyAppWithPublisherPolicy(args[0]!, args[1]!, () => loadPublisherPolicy(args[2]!));
    console.log(JSON.stringify({ ok: true, appId: result.manifest.id, keyId: result.keyId, policyRevision: result.policyRevision, policySha256: result.policySha256 }));
  } else if (command === 'verify' && args.length === 5) {
    const result = await verifyAppDirectory(args[0]!, args[1]!, { keyId: args[2]!, publisherId: args[3]!, publicKeyPem: (await readDeveloperFile(args[4]!, 16384)).toString('utf8'), revoked: false });
    console.log(JSON.stringify({ ok: true, appId: result.manifest.id, keyId: result.keyId, manifestSha256: result.manifestSha256 }));
  } else if (command === 'validate' && args.length === 1) {
    const result = await validateAppDirectory(args[0]!);
    console.log(JSON.stringify({ ok: true, appId: result.manifest.id, version: result.manifest.version, artifactBytes: result.artifactBytes }));
  } else if (command === 'pack' && args.length === 2) {
    console.log(JSON.stringify({ ok: true, ...await packAppDirectory(args[0]!, args[1]!) }));
  } else {
    console.error('Usage: app-cli install <built-dir> <signature-file> <platform-origin> <token-file> <request-id> | install-status <app-id> <origin> <token-file> | install-recover <app-id> <revision> <origin> <token-file> | create <new-directory> <app-id> <trusted|sandbox|backend> <publisher-id> | test <project-directory> | dev <project-directory> | validate <built-directory> | pack <built-directory> <new-output-directory> | verify-policy <built-directory> <signature-file> <platform-policy-file> | sign <built-directory> <key-id> <private-key-file> <new-signature-file> | verify <built-directory> <signature-file> <trusted-key-id> <trusted-publisher-id> <trusted-public-key-file>');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error instanceof AppPackageError || error instanceof InstallError ? error.code : 'PACKAGE_IO_FAILED' }));
  process.exitCode = 1;
}
