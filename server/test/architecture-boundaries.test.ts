import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

type Layer = 1 | 2 | 3 | 4;

interface SourceFile {
  file: string;
  source: string;
}

interface Violation {
  file: string;
  importPath?: string;
  code: string;
  message: string;
}

const root = new URL('../..', import.meta.url);
const rootPath = path.resolve(root.pathname);
const targetRoots = [
  'server/src/core',
  'server/src/shared',
  'server/src/platform',
  'server/src/apps',
  'server/src/app-platform',
  'src/core',
  'src/shared',
  'src/components/ui',
  'src/hooks',
  'src/utils',
  'src/platform',
  'src/apps',
  'packages'
];

const currentExceptionRows = [
  ['server/src/config/env.ts', 'MIG-001'],
  ['server/src/db/client.ts', 'MIG-002'],
  ['server/src/modules/auth/session.ts', 'MIG-004'],
  ['server/src/modules/agent-runtime/context.ts', 'MIG-005'],
  ['server/src/modules/ai-runtime/mcp-client.ts', 'MIG-006'],
  ['deploy/wecom-agent-gateway', 'MIG-007'],
  ['server/src/modules/cloud-documents/client.ts', 'MIG-008'],
  ['server/src/modules/files/routes.ts', 'MIG-009'],
  ['server/src/modules/todos/scheduler.ts', 'MIG-010'],
  ['server/src/modules/webhooks/service.ts', 'MIG-011'],
  ['services/afc-ops-mcp/core.js', 'MIG-026'],
  ['server/src/modules/ai-runtime/external-agent.ts', 'MIG-027'],
  ['src/hooks/usePermissions.ts', 'MIG-020']
] as const;

const currentReferenceFiles = new Set<string>(currentExceptionRows.map(([file]) => file));
const requiredL1Entrypoints = [
  'server/src/core/runtime/index.ts',
  'server/src/core/config/index.ts',
  'server/src/core/identity/index.ts',
  'server/src/core/http/index.ts',
  'server/src/core/database/index.ts',
  'server/src/core/migrations/index.ts',
  'server/src/core/storage/index.ts',
  'server/src/core/jobs/index.ts',
  'server/src/core/time/index.ts',
  'server/src/core/events/index.ts',
  'server/src/core/integrations/wecom/index.ts',
  'server/src/core/integrations/mcp/index.ts',
  'server/src/core/integrations/ai/index.ts',
  'server/src/core/observability/index.ts',
  'server/src/core/security/index.ts',
  'src/core/runtime/index.ts',
  'src/core/http/index.ts'
] as const;
const requiredL3Entrypoints = [
  'server/src/platform/people/index.ts',
  'server/src/platform/locations/index.ts',
  'server/src/platform/assets/index.ts',
  'server/src/platform/responsibility/index.ts',
  'server/src/platform/authorization/index.ts',
  'server/src/platform/context/index.ts',
  'server/src/platform/entity-resolution/index.ts',
  'server/src/platform/work-items/index.ts',
  'server/src/platform/notifications/index.ts',
  'server/src/platform/signatures/index.ts',
  'server/src/platform/attachments/index.ts',
  'server/src/platform/audit/index.ts',
  'server/src/platform/duty/index.ts',
  'server/src/platform/data-alignment/index.ts',
  'server/src/platform/mcp/index.ts',
  'src/platform/context/index.tsx',
  'src/platform/index.ts',
  'packages/platform-sdk/src/index.ts'
] as const;

const importPattern =
  /(?:import(?:\s+type)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"])|(?:export(?:\s+type)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"])|(?:import\(\s*['"]([^'"]+)['"]\s*\))|(?:require\(\s*['"]([^'"]+)['"]\s*\))/g;
const modelVisibleIdentityPattern =
  /(inputSchema|parameters)\s*[:=][\s\S]{0,500}\b(actor_token|actor_wecom_userid|actor_name)\b/;

function toPosix(value: string) {
  return value.split(path.sep).join('/');
}

function sourceLayer(file: string): Layer | null {
  if (file.startsWith('server/src/app-platform/') || /^packages\/platform-sdk\/(?:src|dist)\/app-manifest(?:\.|\/)/.test(file)) return 4;
  if (file.startsWith('server/src/core/') || file.startsWith('src/core/')) return 1;
  if (
    file.startsWith('server/src/shared/')
    || file.startsWith('src/shared/')
    || file.startsWith('src/components/ui/')
    || file.startsWith('src/hooks/')
    || file.startsWith('src/utils/')
    || file.startsWith('packages/platform-ui/')
  ) return 2;
  if (file.startsWith('server/src/platform/') || file.startsWith('src/platform/') || file.startsWith('packages/platform-sdk/')) return 3;
  if (file.startsWith('server/src/apps/') || file.startsWith('src/apps/') || file.startsWith('apps/') || file.startsWith('packages/app-manifest/')) return 4;
  return null;
}

function targetLayer(targetFile: string): Layer | null {
  return sourceLayer(targetFile);
}

function isLayerEntrypoint(targetFile: string) {
  return /\/index\.(?:ts|tsx|js|mjs|cjs)$/.test(targetFile);
}

function appId(file: string) {
  const match = /^(?:server\/src|src)\/apps\/([^/]+)\//.exec(file) || /^apps\/([^/]+)\//.exec(file);
  return match?.[1] ?? null;
}

function resolveImport(sourceFile: string, importPath: string) {
  if (importPath === '@metro/platform-sdk/app-manifest') return 'packages/platform-sdk/src/app-manifest';
  if (importPath.startsWith('node:') || !importPath.startsWith('.') && !importPath.startsWith('@/')) {
    return null;
  }

  const sourceDir = path.posix.dirname(sourceFile);
  const normalized = importPath.startsWith('@/')
    ? path.posix.normalize(importPath.slice(2))
    : path.posix.normalize(path.posix.join(sourceDir, importPath));

  return normalized.replace(/\.(?:js|jsx|ts|tsx|mjs|cjs)$/, '');
}

function analyzeArchitecture(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];

  for (const { file, source } of files) {
    const fromLayer = sourceLayer(file);
    if (!fromLayer) continue;

    if (modelVisibleIdentityPattern.test(source) && !file.includes('/core/identity/')) {
      violations.push({
        file,
        code: 'MODEL_VISIBLE_TRUSTED_IDENTITY',
        message: 'Model-visible schemas must not expose trusted actor identity fields.'
      });
    }

    for (const match of source.matchAll(importPattern)) {
      const importPath = match[1] ?? match[2] ?? match[3] ?? match[4];
      const resolved = resolveImport(file, importPath);
      if (!resolved) continue;

      if (fromLayer === 1 && (resolved.startsWith('server/src/modules/') || resolved.startsWith('src/modules/'))) {
        violations.push({
          file,
          importPath,
          code: 'CORE_IMPORTS_LEGACY_BUSINESS',
          message: 'Layer 1 Core must not import legacy business modules.'
        });
      }

      if (fromLayer === 2 && /^(?:src|server\/src)\/(?:app|context|modules|services)\//.test(resolved)) {
        violations.push({
          file,
          importPath,
          code: 'SHARED_IMPORTS_BUSINESS',
          message: 'Layer 2 shared code must not import application, context, service, or business modules.'
        });
      }

      const toLayer = targetLayer(`${resolved}/index.ts`) ?? targetLayer(`${resolved}.ts`) ?? targetLayer(`${resolved}.tsx`);
      if (toLayer && toLayer > fromLayer) {
        violations.push({
          file,
          importPath,
          code: 'UPWARD_LAYER_IMPORT',
          message: `Layer ${fromLayer} must not import Layer ${toLayer}.`
        });
      }

      if (fromLayer !== toLayer && /\/(implementation|repository|private)(?:\/|$)/.test(resolved)) {
        violations.push({
          file,
          importPath,
          code: 'DEEP_PRIVATE_IMPORT',
          message: 'Cross-layer imports must use public entrypoints, not implementation, repository, or private folders.'
        });
      }

      const sourceApp = appId(file);
      const targetApp = appId(`${resolved}.ts`);
      if (sourceApp && targetApp && sourceApp !== targetApp && /\/(backend|frontend|model|orchestration|repository|events|tools|migrations|tests|private)(?:\/|$)/.test(resolved)) {
        violations.push({
          file,
          importPath,
          code: 'APP_PRIVATE_IMPORT',
          message: 'An application must not import another application private implementation.'
        });
      }

      if (sourceApp && (
        resolved === 'server/src/db/client'
        || resolved.startsWith('server/src/db/schema/')
        || resolved === 'server/src/db/schema'
      )) {
        violations.push({
          file,
          importPath,
          code: 'APP_RAW_DATABASE_IMPORT',
          message: 'Applications must use platform/core contracts instead of raw database clients or tables.'
        });
      }

      if (fromLayer !== toLayer && toLayer && !isLayerEntrypoint(`${resolved}.ts`) && /^(?:server\/src|src)\/(?:core|shared|platform|apps)\//.test(resolved)) {
        violations.push({
          file,
          importPath,
          code: 'NON_ENTRYPOINT_LAYER_IMPORT',
          message: 'Cross-layer imports must target a public index entrypoint.'
        });
      }
    }
  }

  return violations;
}

async function collectTargetFiles() {
  const files: SourceFile[] = [];

  async function walk(relativeDir: string) {
    let entries;
    try {
      entries = await readdir(path.join(rootPath, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(relativePath);
        continue;
      }
      if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
      if (currentReferenceFiles.has(relativePath)) continue;
      files.push({
        file: toPosix(relativePath),
        source: await readFile(path.join(rootPath, relativePath), 'utf8')
      });
    }
  }

  for (const targetRoot of targetRoots) {
    await walk(targetRoot);
  }

  return files;
}

test('architecture analyzer rejects seeded layer and security violations', () => {
  const files: SourceFile[] = [
    {
      file: 'server/src/core/runtime/index.ts',
      source: "import { authorize } from '../../platform/authorization/index.js';"
    },
    {
      file: 'server/src/core/http/index.ts',
      source: "import { requireRequestAccessContext } from '../../modules/auth/session.js';"
    },
    {
      file: 'src/shared/format/index.ts',
      source: "import { getActor } from '../../platform/context/index.js';"
    },
    {
      file: 'server/src/platform/work-items/index.ts',
      source: "import { createFault } from '../../apps/faults/backend/index.js';"
    },
    {
      file: 'server/src/apps/todo/backend/index.ts',
      source: "import { createWorkItem } from '../../../platform/work-items/service.js';"
    },
    {
      file: 'server/src/apps/faults/backend/index.ts',
      source: "import { helper } from '../../maintenance/repository/private-helper.js';"
    },
    {
      file: 'server/src/apps/faults/backend/repository.ts',
      source: "import { getPool } from '../../../db/client.js';"
    },
    {
      file: 'server/src/apps/agent/tools/index.ts',
      source: "export const tool = { inputSchema: { properties: { actor_token: { type: 'string' } } } };"
    }
  ];

  assert.deepEqual(
    analyzeArchitecture(files).map((violation) => violation.code),
    [
      'UPWARD_LAYER_IMPORT',
      'CORE_IMPORTS_LEGACY_BUSINESS',
      'UPWARD_LAYER_IMPORT',
      'UPWARD_LAYER_IMPORT',
      'NON_ENTRYPOINT_LAYER_IMPORT',
      'APP_PRIVATE_IMPORT',
      'APP_RAW_DATABASE_IMPORT',
      'MODEL_VISIBLE_TRUSTED_IDENTITY'
    ]
  );
});

test('architecture analyzer accepts public downward entrypoints', () => {
  const files: SourceFile[] = [
    {
      file: 'server/src/platform/work-items/index.ts',
      source: "import { withTransaction } from '../../core/database/index.js';"
    },
    {
      file: 'server/src/apps/todo/backend/index.ts',
      source: [
        "import { workItems } from '../../../platform/work-items/index.js';",
        "import { formatDate } from '../../../shared/date/index.js';",
        "import { apiRuntime } from '../../../core/http/index.js';"
      ].join('\n')
    },
    {
      file: 'src/apps/todo/frontend/index.tsx',
      source: "import { Button } from '../../../shared/ui/index.js';"
    }
  ];

  assert.deepEqual(analyzeArchitecture(files), []);
});

test('L4 manifest subpath cannot leak into the L3 SDK root or lower layers', () => {
  assert.deepEqual(analyzeArchitecture([
    { file: 'packages/platform-sdk/src/index.ts', source: "export * from './app-manifest.js';" },
    { file: 'server/src/platform/context/index.ts', source: "import { validateAppManifest } from '../../app-platform/manifest/index.js';" },
    { file: 'server/src/core/runtime/index.ts', source: "import type { AppManifest } from '@metro/platform-sdk/app-manifest';" }
  ]).map((x) => x.code), ['UPWARD_LAYER_IMPORT', 'UPWARD_LAYER_IMPORT', 'UPWARD_LAYER_IMPORT']);
});

test('L4 manifest exposes dedicated server and SDK entrypoints', async () => {
  for (const entrypoint of ['server/src/app-platform/manifest/index.ts', 'server/src/app-platform/registry/index.ts', 'server/src/app-platform/storage/index.ts', 'packages/platform-sdk/src/app-manifest.ts']) {
    assert.ok((await readFile(path.join(rootPath, entrypoint), 'utf8')).trim());
  }
});

test('target folders currently satisfy architecture boundaries', async () => {
  const files = await collectTargetFiles();
  assert.deepEqual(analyzeArchitecture(files), []);
});

test('implemented L1 capabilities expose their required public entrypoints', async () => {
  for (const entrypoint of requiredL1Entrypoints) {
    const source = await readFile(path.join(rootPath, entrypoint), 'utf8');
    assert.ok(source.trim(), `${entrypoint} must be a non-empty public entrypoint`);
  }
});

test('implemented L3 capabilities expose their required public entrypoints', async () => {
  for (const entrypoint of requiredL3Entrypoints) {
    const source = await readFile(path.join(rootPath, entrypoint), 'utf8');
    assert.ok(source.trim(), `${entrypoint} must be a non-empty public entrypoint`);
  }
});
