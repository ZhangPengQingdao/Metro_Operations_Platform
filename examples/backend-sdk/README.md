# Node backend example

This independent, non-business application uses only `@metro/platform-sdk/app-backend` and Node built-ins. Install the platform SDK tarball and build dependencies, then run `npm test` and `npm run build`. The resulting `dist/entry.cjs` bundles the SDK; the runtime needs no npm install or application-specific platform source changes.

- Health: `GET /health`, container loopback port 8080.
- API: `POST /echo`, handler `echo`, declared permission `sample.echo.use`.
- Non-secret configuration: `config.mjs`, included in the immutable, hashed artifact.
- Run through the platform CLI validate/pack/sign/install workflow and existing lifecycle host. Installation grants, image approval and runtime infrastructure are supplied by platform composition, never by this package.
- Stdout is reserved for the platform protocol. No raw log forwarding, environment secrets or platform service credentials. Gateway requests use `backend.gateway.invoke` and retain host-side authorization.
- Shutdown closes ingress and aborts handlers, then waits for actual work settlement. Handlers must respect the signal. No automatic write retry or reconnect.

Scaffold a project with `app-cli create <new-directory> <app-id> backend <publisher-id>`. Generated `dist` contains only the manifest and verified backend artifact. Production deployment remains separately authorized.
