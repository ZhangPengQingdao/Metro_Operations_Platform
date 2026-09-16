import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppPackageError } from './package.js';

/** Reuse the independently accepted example as the sole scaffold source. */
export async function createAppProject(destination: string, appId: string, mode: string, publisherId: string, bundled?: { templates: URL; sdkVersion: string }) {
  const identifier = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  if (![appId, publisherId].every(value => value.length <= 64 && identifier.test(value)) || !['trusted', 'sandbox', 'backend'].includes(mode)) throw new AppPackageError('INVALID_CREATE_OPTIONS');
  const template = new URL(mode==='backend'?'backend-sdk/':'app-sdk/', bundled?.templates ?? new URL('../../../../examples/', import.meta.url));
  const files = new Map<string, string>();
  for (const path of ['app.mjs', 'test.mjs', 'build.mjs', 'package.json', '.gitignore', ...(mode==='backend'?['entry.mjs','config.mjs']:[`${mode}/entry.mjs`])]) {
    files.set(path, await readFile(new URL(bundled && path === '.gitignore' ? 'gitignore.template' : path, template), 'utf8'));
  }
  const pkg = JSON.parse(files.get('package.json')!);
  pkg.name = appId;
  pkg.dependencies['@metro/platform-sdk'] = bundled?.sdkVersion ?? JSON.parse(await readFile(new URL('../../../../packages/platform-sdk/package.json', import.meta.url), 'utf8')).version;
  files.set('package.json', JSON.stringify(pkg, null, 2) + '\n');
  // Exact template anchors fail closed on template drift instead of creating broken projects.
  function replace(path: string, anchor: string, replacement: string) {
    const source = files.get(path)!;
    if (source.split(anchor).length !== 2) throw new AppPackageError('SCAFFOLD_TEMPLATE_CHANGED');
    files.set(path, source.replace(anchor, replacement));
  }
  if(mode==='backend')replace('build.mjs', "id:'sdk-backend-sample'", `id:${JSON.stringify(appId)}`);
  else {
    replace('build.mjs', "['trusted','sandbox']", JSON.stringify([mode]));
    replace('build.mjs', 'id:`sdk-${mode}-sample`', `id:${JSON.stringify(appId)}`);
  }
  replace('build.mjs', "publisherId:'afc-examples'", `publisherId:${JSON.stringify(publisherId)}`);
  if (mode === 'sandbox') replace('sandbox/entry.mjs', "appId:'sdk-sandbox-sample'", `appId:${JSON.stringify(appId)}`);
  if(mode==='backend')files.set('README.md', `# ${appId}\n\nNode backend using the public app-backend SDK. Install the platform SDK tarball, run npm test and npm run build; output dist/. Health: /health on container loopback port 8080. API echo: POST /echo, permission sample.echo.use. No platform credential enters the process. Use mop-app validate/pack/sign/export-upload on dist and submit the signed JSON to the platform administrator; installation grants and approved runtime image are supplied by the platform. The default manager currently rejects custom API declarations. Do not write logs to stdout (reserved for stdio frames). Errors terminate the channel; no automatic retry.\n`);
  if(mode!=='backend')files.set('README.md', `# ${appId}\n\nGenerated ${mode} application; publisher declaration: ${publisherId}.\n\nInstall the platform-provided SDK tarball:\n\n\`npm install /absolute/path/metro-platform-sdk-${pkg.dependencies['@metro/platform-sdk']}.tgz --ignore-scripts\`\n\nRun \`npm test\` and \`npm run build\`. Use \`npm run dev\` for watched builds; failed rebuilds remove the stale manifest. Output: \`dist/${mode}\`. Use the platform CLI validate/pack commands on that directory.\n\nThe greeting operation uses fake data in tests. A platform host must supply the declared sample.greeting.read permission and greeting adapter. This project has no automatic production installation or grants. ${mode === 'sandbox' ? 'The resource bootstrap calls mountSandboxSample(root, approvedPlatformOrigin) inside the existing opaque-origin sandbox.' : 'The approved host calls createTrustedSample(client) and supplies React and page context.'}\n`);
  const output = resolve(destination);
  await mkdir(output);
  try {
    for (const [path, content] of files) {
      await mkdir(dirname(join(output, path)), { recursive: true });
      await writeFile(join(output, path), content, { flag: 'wx' });
    }
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  return { appId, mode, publisherId };
}
