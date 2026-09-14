import { env } from '../../config/env.js';

export type ConfigSourceKind = 'environment' | 'default' | 'runtime';

export interface ConfigSource {
  readonly kind: ConfigSourceKind;
  readonly name: string;
}

export interface ConfigValue<T> {
  readonly value: T;
  readonly source: ConfigSource;
}

export interface SecretValue {
  readonly masked: string;
  readonly source: ConfigSource;
  readonly isConfigured: boolean;
  reveal(): string | undefined;
  toJSON(): string;
  toString(): string;
}

export interface FeatureFlag {
  readonly enabled: boolean;
  readonly source: ConfigSource;
}

export interface FeatureFlags {
  has(name: string): boolean;
  isEnabled(name: string): boolean;
  get(name: string): FeatureFlag;
  entries(): ReadonlyArray<readonly [string, FeatureFlag]>;
}

export interface RuntimeConfig {
  readonly nodeEnv: ConfigValue<'development' | 'test' | 'production'>;
  readonly port: ConfigValue<number>;
  readonly releaseVersion: ConfigValue<string>;
}

export interface DatabaseConfig {
  readonly url: SecretValue;
}

export interface HttpConfig {
  readonly publicBaseUrl: ConfigValue<string | undefined>;
  readonly corsOrigin: ConfigValue<string>;
  readonly trustedProxyCidrs: ConfigValue<readonly string[]>;
  readonly cookieSecure: ConfigValue<boolean>;
}

export interface SessionConfig {
  readonly secret: SecretValue;
  readonly maxAgeDays: ConfigValue<number>;
  readonly internalApiToken: SecretValue;
}

export interface StorageConfig {
  readonly uploadDir: ConfigValue<string>;
}

export interface IntegrationConfig {
  readonly wecomAiBotGatewayUrl: ConfigValue<string | undefined>;
  readonly mcpActorSigningSecret: SecretValue;
  readonly afcMcpUrl: ConfigValue<string | undefined>;
  readonly afcMcpApiKey: SecretValue;
  readonly aiProviderEncryptionKey: SecretValue;
}

export interface CoreConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly http: HttpConfig;
  readonly session: SessionConfig;
  readonly storage: StorageConfig;
  readonly integrations: IntegrationConfig;
  readonly features: FeatureFlags;
}

type LegacyEnv = typeof env;

export type CoreConfigInput = Pick<LegacyEnv,
  | 'NODE_ENV'
  | 'PORT'
  | 'RELEASE_VERSION'
  | 'DATABASE_URL'
  | 'PUBLIC_BASE_URL'
  | 'CORS_ORIGIN'
  | 'TRUSTED_PROXY_CIDRS'
  | 'COOKIE_SECURE'
  | 'SESSION_SECRET'
  | 'SESSION_MAX_AGE_DAYS'
  | 'INTERNAL_API_TOKEN'
  | 'UPLOAD_DIR'
  | 'WECOM_AIBOT_GATEWAY_URL'
  | 'MCP_ACTOR_SIGNING_SECRET'
  | 'AFC_MCP_URL'
  | 'AFC_MCP_API_KEY'
  | 'AI_PROVIDER_ENCRYPTION_KEY'
>;

type RawConfigSourceMap = Partial<Record<keyof CoreConfigInput | 'FEATURE_FLAGS', ConfigSource>>;

export interface BuildCoreConfigOptions {
  readonly featureFlags?: string;
  readonly sourceMap?: RawConfigSourceMap;
}

export function sourceFromEnvironment(name: string): ConfigSource {
  return {
    kind: 'environment',
    name
  };
}

export function sourceFromDefault(name: string): ConfigSource {
  return {
    kind: 'default',
    name
  };
}

export function valueFrom<T>(value: T, source: ConfigSource): ConfigValue<T> {
  return {
    value,
    source
  };
}

export function maskSecret(value: string | undefined): string {
  if (!value) {
    return 'unset';
  }

  if (value.length <= 8) {
    return 'configured';
  }

  return `${value.slice(0, 2)}…${value.slice(-2)} (${value.length})`;
}

export function secretFrom(value: string | undefined, source: ConfigSource): SecretValue {
  const masked = maskSecret(value);

  return {
    masked,
    source,
    isConfigured: Boolean(value),
    reveal: () => value,
    toJSON: () => masked,
    toString: () => masked
  };
}

export function createFeatureFlags(
  flags: Record<string, boolean>,
  source: ConfigSource = sourceFromDefault('FEATURE_FLAGS')
): FeatureFlags {
  const normalized = new Map<string, FeatureFlag>();

  for (const [name, enabled] of Object.entries(flags)) {
    const key = normalizeFeatureFlagName(name);

    if (key) {
      normalized.set(key, {
        enabled,
        source
      });
    }
  }

  const disabledDefault: FeatureFlag = {
    enabled: false,
    source: sourceFromDefault('unknown')
  };

  return {
    has: (name) => normalized.has(normalizeFeatureFlagName(name)),
    isEnabled: (name) => normalized.get(normalizeFeatureFlagName(name))?.enabled ?? false,
    get: (name) => normalized.get(normalizeFeatureFlagName(name)) ?? disabledDefault,
    entries: () => [...normalized.entries()]
  };
}

export function parseFeatureFlags(value: string | undefined): Record<string, boolean> {
  if (!value?.trim()) {
    return {};
  }

  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, boolean>>((flags, part) => {
      const [rawName, rawValue] = part.split('=');
      const name = normalizeFeatureFlagName(rawName);

      if (!name) {
        return flags;
      }

      flags[name] = rawValue === undefined ? true : parseBooleanFlagValue(rawValue);
      return flags;
    }, {});
}

export function buildCoreConfig(
  legacyEnv: CoreConfigInput,
  options: BuildCoreConfigOptions = {}
): CoreConfig {
  const sourceMap = options.sourceMap ?? {};
  const sourceFor = (name: keyof CoreConfigInput | 'FEATURE_FLAGS') => sourceMap[name] ?? sourceFromEnvironment(name);

  return {
    runtime: {
      nodeEnv: valueFrom(legacyEnv.NODE_ENV, sourceFor('NODE_ENV')),
      port: valueFrom(legacyEnv.PORT, sourceFor('PORT')),
      releaseVersion: valueFrom(legacyEnv.RELEASE_VERSION, sourceFor('RELEASE_VERSION'))
    },
    database: {
      url: secretFrom(legacyEnv.DATABASE_URL, sourceFor('DATABASE_URL'))
    },
    http: {
      publicBaseUrl: valueFrom(legacyEnv.PUBLIC_BASE_URL, sourceFor('PUBLIC_BASE_URL')),
      corsOrigin: valueFrom(legacyEnv.CORS_ORIGIN, sourceFor('CORS_ORIGIN')),
      trustedProxyCidrs: valueFrom(legacyEnv.TRUSTED_PROXY_CIDRS, sourceFor('TRUSTED_PROXY_CIDRS')),
      cookieSecure: valueFrom(legacyEnv.COOKIE_SECURE, sourceFor('COOKIE_SECURE'))
    },
    session: {
      secret: secretFrom(legacyEnv.SESSION_SECRET, sourceFor('SESSION_SECRET')),
      maxAgeDays: valueFrom(legacyEnv.SESSION_MAX_AGE_DAYS, sourceFor('SESSION_MAX_AGE_DAYS')),
      internalApiToken: secretFrom(legacyEnv.INTERNAL_API_TOKEN, sourceFor('INTERNAL_API_TOKEN'))
    },
    storage: {
      uploadDir: valueFrom(legacyEnv.UPLOAD_DIR, sourceFor('UPLOAD_DIR'))
    },
    integrations: {
      wecomAiBotGatewayUrl: valueFrom(legacyEnv.WECOM_AIBOT_GATEWAY_URL, sourceFor('WECOM_AIBOT_GATEWAY_URL')),
      mcpActorSigningSecret: secretFrom(legacyEnv.MCP_ACTOR_SIGNING_SECRET, sourceFor('MCP_ACTOR_SIGNING_SECRET')),
      afcMcpUrl: valueFrom(legacyEnv.AFC_MCP_URL, sourceFor('AFC_MCP_URL')),
      afcMcpApiKey: secretFrom(legacyEnv.AFC_MCP_API_KEY, sourceFor('AFC_MCP_API_KEY')),
      aiProviderEncryptionKey: secretFrom(legacyEnv.AI_PROVIDER_ENCRYPTION_KEY, sourceFor('AI_PROVIDER_ENCRYPTION_KEY'))
    },
    features: createFeatureFlags(parseFeatureFlags(options.featureFlags), sourceFor('FEATURE_FLAGS'))
  };
}

export function getCoreConfig(): CoreConfig {
  return buildCoreConfig(env, {
    featureFlags: process.env.FEATURE_FLAGS
  });
}

export function getRuntimeConfig(): RuntimeConfig {
  return getCoreConfig().runtime;
}

function normalizeFeatureFlagName(name: string | undefined): string {
  return (name ?? '').trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-');
}

function parseBooleanFlagValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  if (['true', '1', 'yes', 'y', 'on', 'enabled'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'off', 'disabled'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid feature flag boolean value: ${value}`);
}
