/** L4 install declarations. Validation never establishes publisher identity, trust or grants. */
export const APP_MANIFEST_VERSION = '1.0' as const;

/** L4 declarative migrations; no raw SQL, expressions or cross-schema targets. */
export type AppMigrationColumnType = 'text' | 'boolean' | 'integer' | 'bigint' | 'uuid' | 'date' | 'timestamptz' | 'jsonb';
export interface AppMigrationColumn { name: string; type: AppMigrationColumnType; nullable: boolean }
export type AppMigrationOperation =
  | { kind: 'createTable'; table: string; columns: AppMigrationColumn[]; primaryKey?: string[] }
  | { kind: 'addColumn'; table: string; column: AppMigrationColumn & { nullable: true } }
  | { kind: 'createIndex'; table: string; name: string; columns: string[]; unique?: boolean };
export interface AppDeclarativeMigration { migrationVersion: '1.0'; operations: AppMigrationOperation[] }

/** SemVer without build metadata. Explicit bounds, not npm range expressions. */
export interface AppVersionRange { minInclusive: string; maxExclusive: string }
export interface AppArtifact {
  id: string;
  kind: 'frontend' | 'backend' | 'migration' | 'mcp-contribution' | 'resource';
  path: string;
  sha256: string;
  bytes: number;
}
export type AppUiDeclaration = { mode: 'none' } | {mode:'trusted';entryArtifactId:string} | {
  mode: 'sandbox'; entryArtifactId: string;
  /** Sandbox app handles host-authorized route changes without recreating its document. */
  clientRouting?: true;
};
export type AppBackendDeclaration = { mode: 'none' } | {
  mode: 'trusted' | 'isolated'; runtime: 'node'; entryArtifactId: string;
  limits: { memoryMiB: number; cpuMillis: number; timeoutSeconds: number };
} | { mode: 'external'; origin: string };
export type AppStorageDeclaration = { mode: 'none' } | {
  mode: 'managed'; migrations: { id: string; artifactId: string }[];
} | { mode: 'external'; configurationRef: string };

export interface AppManifest {
  manifestVersion: typeof APP_MANIFEST_VERSION;
  id: string;
  version: string;
  name: string;
  /** Signed, path-only SVG icon in a fixed 24 × 24 viewBox. */
  icon?: { paths: string[] };
  description: string;
  /** Unverified publisher claim; installer verifies provenance separately. */
  publisherId: string;
  compatibility: {
    platform: AppVersionRange;
    capabilities: { id: string; contractVersion: string }[];
    applications: { id: string; version: AppVersionRange }[];
  };
  permissions: { requested: string[]; defined: { code: string; description: string; scopeKinds?: ('self'|'workgroup'|'department'|'organizations'|'all')[] }[] };
  ui: AppUiDeclaration;
  backend: AppBackendDeclaration;
  storage: AppStorageDeclaration;
  routes: { id: string; path: string; permission?: string }[];
  api: { id: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; handler: string; permission?: string; businessPermission?:string; businessEntry?:true }[];
  navigation: { id: string; label: string; routeId: string; order: number }[];
  events: { publish: string[]; subscribe: { event: string; handler: string }[] };
  tools: { name: string; contributionArtifactId: string; uiResourceId?: string }[];
  jobs: { id: string; handler: string; intervalSeconds: number }[];
  network: { frontendOrigins: string[]; backendOrigins: string[] };
  health?: { path: string; timeoutSeconds: number };
  resources: { id: string; artifactId: string; kind: 'asset' | 'mcp-ui' }[];
  artifacts: AppArtifact[];
}

/** Trusted host inventory passed to compatibility checking, not supplied by the app. */
export interface AppManifestHost {
  platformVersion: string;
  capabilities: { id: string; contractVersion: string }[];
  applications: { id: string; version: string }[];
}
export interface AppManifestIssue { path: string; code: string; message: string }
export type AppManifestValidationResult =
  | { ok: true; manifest: AppManifest }
  | { ok: false; issues: AppManifestIssue[] };
