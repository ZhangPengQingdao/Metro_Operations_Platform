export const ASSET_LIFECYCLE_STATES = ['planned', 'active', 'suspended', 'retired'] as const;
export const ASSET_DATA_QUALITY_STATUSES = ['unverified', 'verified', 'needs_review'] as const;

export type AssetRecordStatus = 'active' | 'inactive';
export type AssetLifecycleState = typeof ASSET_LIFECYCLE_STATES[number];
export type AssetDataQualityStatus = typeof ASSET_DATA_QUALITY_STATUSES[number];
export type AssetAliasType = 'display' | 'historical' | 'external';

export interface AssetSystem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: AssetRecordStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssetCategory {
  id: string;
  systemId: string;
  code: string;
  name: string;
  description: string | null;
  status: AssetRecordStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssetType {
  id: string;
  systemId: string;
  categoryId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: AssetRecordStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: string;
  systemId: string;
  categoryId: string | null;
  typeId: string;
  locationId: string;
  displayName: string;
  assetCode: string | null;
  lifecycleState: AssetLifecycleState;
  dataQualityStatus: AssetDataQualityStatus;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetAlias {
  id: string;
  assetId: string;
  alias: string;
  aliasType: AssetAliasType;
  status: AssetRecordStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAssetReference {
  id: string;
  assetId: string;
  provider: string;
  tenantKey: string;
  externalAssetId: string;
  status: AssetRecordStatus;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetReference {
  assetId: string;
}

export interface AssetDirectoryProfile {
  asset: Asset;
  system: AssetSystem;
  category: AssetCategory | null;
  type: AssetType;
  aliases: AssetAlias[];
}

export interface CreateAssetSystemInput {
  id?: string;
  code: string;
  name: string;
  description?: string | null;
  status?: AssetRecordStatus;
  sortOrder?: number;
}

export interface CreateAssetCategoryInput {
  id?: string;
  systemId: string;
  code: string;
  name: string;
  description?: string | null;
  status?: AssetRecordStatus;
  sortOrder?: number;
}

export interface CreateAssetTypeInput {
  id?: string;
  systemId: string;
  categoryId?: string | null;
  code: string;
  name: string;
  description?: string | null;
  status?: AssetRecordStatus;
  sortOrder?: number;
}

export interface CreateAssetInput {
  id?: string;
  systemId: string;
  categoryId?: string | null;
  typeId: string;
  locationId: string;
  displayName: string;
  assetCode?: string | null;
  lifecycleState?: AssetLifecycleState;
  dataQualityStatus?: AssetDataQualityStatus;
  remark?: string | null;
}

export interface AddAssetAliasInput {
  id?: string;
  assetId: string;
  alias: string;
  aliasType?: AssetAliasType;
  status?: AssetRecordStatus;
}

export interface LinkExternalAssetInput {
  id?: string;
  assetId: string;
  provider: string;
  tenantKey?: string;
  externalAssetId: string;
  status?: AssetRecordStatus;
  verifiedAt?: Date | null;
}

export interface SearchAssetsInput {
  query?: string;
  systemId?: string;
  categoryId?: string;
  typeId?: string;
  locationId?: string;
  lifecycleState?: AssetLifecycleState;
  dataQualityStatus?: AssetDataQualityStatus;
  limit?: number;
}

export interface LegacyDeviceTypeReference {
  id: string;
  name: string;
}

export interface LegacyDeviceReference {
  id: string;
  locationId?: string | null;
  typeId?: string | null;
  displayName?: string | null;
  assetCode?: string | null;
  workgroupId?: string | null;
  ipAddress?: string | null;
  subnetMask?: string | null;
  gateway?: string | null;
  sourceKey?: string | null;
  sourceFile?: string | null;
  sourceRow?: number | null;
}

export interface LegacyAssetSnapshot {
  deviceTypes: readonly LegacyDeviceTypeReference[];
  devices: readonly LegacyDeviceReference[];
  faultDeviceReferenceCount?: number;
  resolutionAuditCount?: number;
}

export type LegacyAssetIssueCode =
  | 'DUPLICATE_DEVICE_TYPE_NAME'
  | 'MISSING_LOCATION'
  | 'MISSING_TYPE'
  | 'MISSING_DISPLAY_NAME'
  | 'DUPLICATE_LOCATION_TYPE_NAME'
  | 'DUPLICATE_ASSET_CODE';

export interface LegacyAssetIssue {
  code: LegacyAssetIssueCode;
  assetId: string;
  value?: string;
}

export interface LegacyAssetReconciliation {
  targetSystemCode: 'AFC';
  assetCount: number;
  assetTypeCount: number;
  preservedAssetIds: string[];
  preservedAssetTypeIds: string[];
  codedAssetCount: number;
  responsibilitySourceCount: number;
  deferredNetworkFieldCount: number;
  importEvidenceCount: number;
  faultDeviceReferenceCount: number;
  resolutionAuditCount: number;
  issues: LegacyAssetIssue[];
}

export class AssetDirectoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AssetDirectoryError';
    this.code = code;
  }
}
