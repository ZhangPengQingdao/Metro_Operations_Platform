# Independent SDK application samples

Run from the repository root (dependencies must already be installed):

```sh
npm run build:sdk
node --test examples/app-sdk/test.mjs
node examples/app-sdk/build.mjs
```

Output: `dist/trusted/{entry.js,manifest.json}` and `dist/sandbox/{entry.js,manifest.json}` within this example directory. Artifacts have measured byte lengths and SHA-256 digests. No platform server or host internals enter either bundle. Application logic lives in `app.mjs` and uses only an injected public Gateway client.

The trusted entry exports `createTrustedSample(client)` returning the existing `{pages:{home}}` module shape. The approved platform loader injects its authorized client and supplies React; the application does not create a second router or login screen.

The sandbox entry exports `mountSandboxSample(root, platformOrigin)`. The platform resource bootstrap imports this module and calls it with the approved platform origin. Call the returned cleanup on unmount. It accepts only the existing broker's messages from the pinned parent window and exact origin; the platform must still serve the document with its approved CSP and opaque-origin sandbox. Do not load this as a same-origin replacement for sandbox hosting.

Both apps request `sample.greeting` using `{name:'AFC'}`. A local test host provides explicit fake data. A live host must approve the declared `sample.greeting.read` permission and supply a resource-aware operation adapter; this sample never auto-grants permission. There is no backend, storage, business data or deployment.

The SDK sandbox adapter allows at most8 pending calls and128 calls per session, matching the broker. A new session requires closing and recreating the client. Response loss has unknown outcome, with no retries. Existing `test.mjs` verifies shared application behavior; the platform tests separately validate built manifests and actual broker interoperability. These command-line checks do not prove browser isolation or visual layout.

## Local dual-host preview

`npm run dev -- --host 127.0.0.1 --port 3010` builds the SDK and both examples before starting Vite. Open `http://127.0.0.1:3010/#/platform/developer-center/sdk-preview` (or the same route on your selected port).

The platform imports the fixed trusted build with shared React, injects a fake Gateway client, and mounts the sandbox build as an inline module in the existing opaque-origin frame. Only HTTP loopback addresses are accepted. This fixture is not an installer or production artifact approval mechanism.

Check that the trusted greeting appears, click the sandbox greeting button, then stop/re-enable and reload both apps. Unloading closes the trusted client and the frame broker; reloading creates fresh instances. Automated host/protocol checks do not replace this interactive acceptance.

## Build outside the platform repository

This folder includes its own package manifest with React and esbuild dependencies. Build and pack the SDK from the repository root:

```sh
npm run build:sdk
npm pack ./packages/platform-sdk --pack-destination /tmp
```

Copy this example folder (without `dist` or `node_modules`) to a separate directory. Inside that copy, install the generated SDK tarball instead of looking for the unpublished alpha in a registry:

```sh
npm install /tmp/afc-platform-sdk-0.1.0-alpha.8.tgz --ignore-scripts
npm test
npm run build
```

The generated local lockfile records the tarball source; replace it with your published SDK version for distribution. No platform repository paths or host code are needed to compile either application. Hosting and real authorization remain platform responsibilities.

## Watch builds

`npm run dev` watches the two entry graphs and regenerates artifact digests on successful changes. Failed builds remove the affected manifest, preventing validation/packing of stale output. Fix the source to recover; stop with Ctrl+C. This is build watching, not a web server or host installation. Restart after changing the build script or package dependencies.
