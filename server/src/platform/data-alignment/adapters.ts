import type { QueryableClient } from '../../core/database/index.js';
import { DataAlignmentError, type DataAlignmentListInput, type DirectoryEntityType, type DirectoryReferenceAdapter, type ExternalEntityReference } from './model.js';

export interface PersonExternalReferenceSource { personId: string; provider: string; tenantKey: string; externalUserId: string; status: 'active' | 'inactive'; verifiedAt: string | null; }
export interface LocationExternalReferenceSource { locationId: string; provider: string; tenantKey: string; externalLocationId: string; status: 'active' | 'inactive'; verifiedAt: string | null; }
export interface AssetExternalReferenceSource { assetId: string; provider: string; tenantKey: string; externalAssetId: string; status: 'active' | 'inactive'; verifiedAt: string | null; }

export function createMemoryDirectoryReferenceAdapter(source: {
  people?: readonly PersonExternalReferenceSource[];
  locations?: readonly LocationExternalReferenceSource[];
  assets?: readonly AssetExternalReferenceSource[];
} = {}): DirectoryReferenceAdapter {
  const references: ExternalEntityReference[] = [
    ...(source.people ?? []).map((item) => normalize('person', item.personId, item.provider, item.tenantKey, item.externalUserId, item.status, item.verifiedAt)),
    ...(source.locations ?? []).map((item) => normalize('location', item.locationId, item.provider, item.tenantKey, item.externalLocationId, item.status, item.verifiedAt)),
    ...(source.assets ?? []).map((item) => normalize('asset', item.assetId, item.provider, item.tenantKey, item.externalAssetId, item.status, item.verifiedAt))
  ];
  return {
    async list(entityType, input) { return bounded(references.filter((item) => !entityType || item.entityType === entityType), input).map(clone); },
    async resolve(entityType, externalSystemCode, tenantKey, externalId) {
      const found = references.find((item) => item.entityType === entityType && item.externalSystemCode === externalSystemCode && item.tenantKey === tenantKey && item.externalId === externalId && item.status === 'active' && item.verifiedAt !== null);
      return found ? clone(found) : null;
    }
  };
}

export function createPostgresDirectoryReferenceAdapter(client: QueryableClient): DirectoryReferenceAdapter {
  return {
    async list(entityType, input) {
      const result = await client.query(`${REFERENCE_UNION} WHERE ($1::text IS NULL OR entity_type=$1) ORDER BY entity_type,external_system_code,tenant_key,external_id LIMIT $2`, [entityType ?? null, limit(input)]);
      return rows(result).map(mapReference);
    },
    async resolve(entityType, externalSystemCode, tenantKey, externalId) {
      const result = await client.query(`${REFERENCE_UNION} WHERE entity_type=$1 AND external_system_code=$2 AND tenant_key=$3 AND external_id=$4 AND status='active' AND verified_at IS NOT NULL LIMIT 1`, [entityType, externalSystemCode, tenantKey, externalId]);
      const row = rows(result)[0];
      return row ? mapReference(row) : null;
    }
  };
}

const REFERENCE_UNION = `SELECT * FROM (
  SELECT 'person'::text AS entity_type,person_id AS entity_id,provider AS external_system_code,tenant_key,external_user_id AS external_id,status,verified_at
  FROM platform_external_identities
  UNION ALL
  SELECT 'location'::text,location_id,provider,tenant_key,external_location_id,status,verified_at
  FROM platform_external_location_references
  UNION ALL
  SELECT 'asset'::text,asset_id,provider,tenant_key,external_asset_id,status,verified_at
  FROM platform_external_asset_references
) reference`;

function normalize(entityType: DirectoryEntityType, entityId: string, externalSystemCode: string, tenantKey: string, externalId: string, status: 'active' | 'inactive', verifiedAt: string | null): ExternalEntityReference { return { entityType, entityId, externalSystemCode, tenantKey, externalId, status, verifiedAt }; }
function mapReference(value: unknown): ExternalEntityReference { const row = object(value); return normalize(text(row.entity_type) as DirectoryEntityType, text(row.entity_id), text(row.external_system_code), text(row.tenant_key), text(row.external_id), text(row.status) as 'active' | 'inactive', row.verified_at == null ? null : instant(row.verified_at)); }
function bounded<T>(values: T[], input?: DataAlignmentListInput) { return values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))).slice(0, limit(input)); }
function limit(input?: DataAlignmentListInput) { const value = input?.limit ?? 100; if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new DataAlignmentError('INVALID_LIST_LIMIT', '列表数量必须介于 1 与 500'); return value; }
function rows(result: unknown): unknown[] { const row = object(result); return Array.isArray(row.rows) ? row.rows : []; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DataAlignmentError('INVALID_DATABASE_ROW', '数据库返回行无效'); return value as Record<string, unknown>; }
function text(value: unknown) { if (typeof value !== 'string') throw new DataAlignmentError('INVALID_DATABASE_ROW', '数据库文本字段无效'); return value; }
function instant(value: unknown) { if (value instanceof Date) return value.toISOString(); if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString(); throw new DataAlignmentError('INVALID_DATABASE_ROW', '数据库时间字段无效'); }
function clone<T>(value: T): T { return structuredClone(value); }
