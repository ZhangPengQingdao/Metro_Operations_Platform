import { randomUUID } from 'node:crypto';
import {
  ASSET_DATA_QUALITY_STATUSES,
  ASSET_LIFECYCLE_STATES,
  AssetDirectoryError,
  type AddAssetAliasInput,
  type Asset,
  type AssetAlias,
  type AssetCategory,
  type AssetDirectoryProfile,
  type AssetSystem,
  type AssetType,
  type CreateAssetCategoryInput,
  type CreateAssetInput,
  type CreateAssetSystemInput,
  type CreateAssetTypeInput,
  type ExternalAssetReference,
  type LegacyAssetIssue,
  type LegacyAssetReconciliation,
  type LegacyAssetSnapshot,
  type LinkExternalAssetInput,
  type SearchAssetsInput
} from './model.js';
import type { AssetDirectoryRepository } from './repository.js';

export * from './model.js';
export * from './migration.js';
export * from './repository.js';

export interface AssetDirectoryServiceOptions {
  clock?: () => Date;
  createId?: () => string;
  findLocation?: (id: string) => Promise<{
    status: string;
  } | null>;
}

export class AssetDirectoryService {
  private readonly clock: () => Date;
  private readonly createId: () => string;
  private readonly findLocation?: AssetDirectoryServiceOptions['findLocation'];

  constructor(
    private readonly repository: AssetDirectoryRepository,
    options: AssetDirectoryServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.findLocation = options.findLocation;
  }

  async updateSystemDetails(id: string, input: Partial<Pick<AssetSystem, 'name' | 'description'>>) {
    const patch: Partial<Pick<AssetSystem, 'name' | 'description'>> = {};
    if (input.name !== undefined) patch.name = normalizeText(input.name, 'name', 200);
    if (input.description !== undefined) patch.description = normalizeOptionalText(input.description, 1000);
    if (!Object.keys(patch).length) throw new AssetDirectoryError('EMPTY_DIRECTORY_UPDATE', '请填写需要更新的字段');
    return this.repository.updateSystemDetails(normalizeUuid(id, 'record id'), patch, this.clock().toISOString());
  }

  async updateCategoryDetails(id: string, input: Partial<Pick<AssetCategory, 'name' | 'description'>>) {
    const patch: Partial<Pick<AssetCategory, 'name' | 'description'>> = {};
    if (input.name !== undefined) patch.name = normalizeText(input.name, 'name', 200);
    if (input.description !== undefined) patch.description = normalizeOptionalText(input.description, 1000);
    if (!Object.keys(patch).length) throw new AssetDirectoryError('EMPTY_DIRECTORY_UPDATE', '请填写需要更新的字段');
    return this.repository.updateCategoryDetails(normalizeUuid(id, 'record id'), patch, this.clock().toISOString());
  }

  async updateTypeDetails(id: string, input: Partial<Pick<AssetType, 'name' | 'description'>>) {
    const patch: Partial<Pick<AssetType, 'name' | 'description'>> = {};
    if (input.name !== undefined) patch.name = normalizeText(input.name, 'name', 200);
    if (input.description !== undefined) patch.description = normalizeOptionalText(input.description, 1000);
    if (!Object.keys(patch).length) throw new AssetDirectoryError('EMPTY_DIRECTORY_UPDATE', '请填写需要更新的字段');
    return this.repository.updateTypeDetails(normalizeUuid(id, 'record id'), patch, this.clock().toISOString());
  }

  async createSystem(input: CreateAssetSystemInput): Promise<AssetSystem> {
    const code = normalizeClassificationCode(input.code, 'asset system code');
    if (await this.repository.findSystemByCode(code)) {
      throw new AssetDirectoryError('DUPLICATE_ASSET_SYSTEM_CODE', `资产系统编码已存在: ${code}`);
    }
    const now = this.clock().toISOString();
    return this.repository.createSystem({
      id: normalizeUuid(input.id ?? this.createId(), 'asset system id'),
      code,
      name: normalizeText(input.name, 'asset system name', 100),
      description: normalizeOptionalText(input.description, 1000),
      status: input.status ?? 'active',
      sortOrder: normalizeSortOrder(input.sortOrder),
      createdAt: now,
      updatedAt: now
    });
  }

  async createCategory(input: CreateAssetCategoryInput): Promise<AssetCategory> {
    const systemId = normalizeUuid(input.systemId, 'asset system id');
    const system = await this.repository.findSystemById(systemId);
    if (!system) throw new AssetDirectoryError('ASSET_SYSTEM_NOT_FOUND', '资产系统不存在');
    if (system.status !== 'active') throw new AssetDirectoryError('ASSET_SYSTEM_INACTIVE', '资产系统未启用');
    const code = normalizeClassificationCode(input.code, 'asset category code');
    if (await this.repository.findCategoryByCode(systemId, code)) {
      throw new AssetDirectoryError('DUPLICATE_ASSET_CATEGORY_CODE', `资产类别编码已存在: ${code}`);
    }
    const now = this.clock().toISOString();
    return this.repository.createCategory({
      id: normalizeUuid(input.id ?? this.createId(), 'asset category id'),
      systemId,
      code,
      name: normalizeText(input.name, 'asset category name', 150),
      description: normalizeOptionalText(input.description, 1000),
      status: input.status ?? 'active',
      sortOrder: normalizeSortOrder(input.sortOrder),
      createdAt: now,
      updatedAt: now
    });
  }

  async createType(input: CreateAssetTypeInput): Promise<AssetType> {
    const systemId = normalizeUuid(input.systemId, 'asset system id');
    const categoryId = input.categoryId ? normalizeUuid(input.categoryId, 'asset category id') : null;
    const [system, category] = await Promise.all([
      this.repository.findSystemById(systemId),
      categoryId ? this.repository.findCategoryById(categoryId) : Promise.resolve(null)
    ]);
    if (!system) throw new AssetDirectoryError('ASSET_SYSTEM_NOT_FOUND', '资产系统不存在');
    if (system.status !== 'active') throw new AssetDirectoryError('ASSET_SYSTEM_INACTIVE', '资产系统未启用');
    if (categoryId && !category) throw new AssetDirectoryError('ASSET_CATEGORY_NOT_FOUND', '资产类别不存在');
    if (category && category.systemId !== systemId) throw new AssetDirectoryError('ASSET_CATEGORY_SYSTEM_MISMATCH', '资产类别不属于所选系统');
    if (category && category.status !== 'active') throw new AssetDirectoryError('ASSET_CATEGORY_INACTIVE', '资产类别未启用');
    const code = normalizeClassificationCode(input.code, 'asset type code');
    if (await this.repository.findTypeByCode(systemId, code)) {
      throw new AssetDirectoryError('DUPLICATE_ASSET_TYPE_CODE', `资产类型编码已存在: ${code}`);
    }
    const now = this.clock().toISOString();
    return this.repository.createType({
      id: normalizeUuid(input.id ?? this.createId(), 'asset type id'),
      systemId,
      categoryId,
      code,
      name: normalizeText(input.name, 'asset type name', 150),
      description: normalizeOptionalText(input.description, 1000),
      status: input.status ?? 'active',
      sortOrder: normalizeSortOrder(input.sortOrder),
      createdAt: now,
      updatedAt: now
    });
  }

  async createAsset(input: CreateAssetInput): Promise<Asset> {
    const systemId = normalizeUuid(input.systemId, 'asset system id');
    const typeId = normalizeUuid(input.typeId, 'asset type id');
    const locationId = normalizeUuid(input.locationId, 'asset location id');
    const [system, type, location] = await Promise.all([
      this.repository.findSystemById(systemId),
      this.repository.findTypeById(typeId),
      this.requireLocation(locationId)
    ]);
    if (!system) throw new AssetDirectoryError('ASSET_SYSTEM_NOT_FOUND', '资产系统不存在');
    if (system.status !== 'active') throw new AssetDirectoryError('ASSET_SYSTEM_INACTIVE', '资产系统未启用');
    if (!type) throw new AssetDirectoryError('ASSET_TYPE_NOT_FOUND', '资产类型不存在');
    if (type.status !== 'active') throw new AssetDirectoryError('ASSET_TYPE_INACTIVE', '资产类型未启用');
    if (type.systemId !== systemId) throw new AssetDirectoryError('ASSET_TYPE_SYSTEM_MISMATCH', '资产类型不属于所选系统');
    if (location.status !== 'active') throw new AssetDirectoryError('ASSET_LOCATION_INACTIVE', '资产位置未启用');

    const inputCategoryId = input.categoryId ? normalizeUuid(input.categoryId, 'asset category id') : null;
    const categoryId = input.categoryId === undefined ? type.categoryId : inputCategoryId;
    if (categoryId !== type.categoryId) {
      throw new AssetDirectoryError('ASSET_TYPE_CATEGORY_MISMATCH', '资产类别必须与资产类型一致');
    }
    if (categoryId) {
      const category = await this.repository.findCategoryById(categoryId);
      if (!category) throw new AssetDirectoryError('ASSET_CATEGORY_NOT_FOUND', '资产类别不存在');
      if (category.systemId !== systemId) throw new AssetDirectoryError('ASSET_CATEGORY_SYSTEM_MISMATCH', '资产类别不属于所选系统');
      if (category.status !== 'active') throw new AssetDirectoryError('ASSET_CATEGORY_INACTIVE', '资产类别未启用');
    }

    const displayName = normalizeText(input.displayName, 'asset display name', 150);
    if (await this.repository.findAssetByScopedName(locationId, typeId, displayName)) {
      throw new AssetDirectoryError('DUPLICATE_ASSET_SCOPED_NAME', '同一位置和类型下已存在同名资产');
    }
    const assetCode = normalizeOptionalAssetCode(input.assetCode);
    if (assetCode && await this.repository.findAssetByCode(assetCode)) {
      throw new AssetDirectoryError('DUPLICATE_ASSET_CODE', `资产编码已存在: ${assetCode}`);
    }
    const lifecycleState = input.lifecycleState ?? 'active';
    const dataQualityStatus = input.dataQualityStatus ?? 'unverified';
    if (!ASSET_LIFECYCLE_STATES.includes(lifecycleState)) throw new AssetDirectoryError('INVALID_ASSET_LIFECYCLE', '资产生命周期无效');
    if (!ASSET_DATA_QUALITY_STATUSES.includes(dataQualityStatus)) throw new AssetDirectoryError('INVALID_ASSET_DATA_QUALITY', '资产质量状态无效');

    const now = this.clock().toISOString();
    return this.repository.createAsset({
      id: normalizeUuid(input.id ?? this.createId(), 'asset id'),
      systemId,
      categoryId,
      typeId,
      locationId,
      displayName,
      assetCode,
      lifecycleState,
      dataQualityStatus,
      remark: normalizeOptionalText(input.remark, 2000),
      createdAt: now,
      updatedAt: now
    });
  }

  async relocateAsset(assetId: string, locationId: string) {
    const id = normalizeUuid(assetId, 'asset id');
    const targetLocationId = normalizeUuid(locationId, 'asset location id');
    const [asset, location] = await Promise.all([
      this.repository.findAssetById(id),
      this.requireLocation(targetLocationId)
    ]);
    if (!asset) throw new AssetDirectoryError('ASSET_NOT_FOUND', '资产不存在');
    if (location.status !== 'active') throw new AssetDirectoryError('ASSET_LOCATION_INACTIVE', '资产位置未启用');
    const conflict = await this.repository.findAssetByScopedName(targetLocationId, asset.typeId, asset.displayName);
    if (conflict && conflict.id !== id) throw new AssetDirectoryError('DUPLICATE_ASSET_SCOPED_NAME', '目标位置已存在同类型同名资产');
    return this.repository.updateAssetLocation(id, targetLocationId, this.clock().toISOString());
  }

  async setLifecycleState(assetId: string, lifecycleState: Asset['lifecycleState']) {
    const id = normalizeUuid(assetId, 'asset id');
    if (!ASSET_LIFECYCLE_STATES.includes(lifecycleState)) {
      throw new AssetDirectoryError('INVALID_ASSET_LIFECYCLE', '资产生命周期无效');
    }
    if (!await this.repository.findAssetById(id)) throw new AssetDirectoryError('ASSET_NOT_FOUND', '资产不存在');
    return this.repository.updateAssetLifecycle(id, lifecycleState, this.clock().toISOString());
  }

  async setDataQualityStatus(assetId: string, dataQualityStatus: Asset['dataQualityStatus']) {
    const id = normalizeUuid(assetId, 'asset id');
    if (!ASSET_DATA_QUALITY_STATUSES.includes(dataQualityStatus)) {
      throw new AssetDirectoryError('INVALID_ASSET_DATA_QUALITY', '资产质量状态无效');
    }
    if (!await this.repository.findAssetById(id)) throw new AssetDirectoryError('ASSET_NOT_FOUND', '资产不存在');
    return this.repository.updateAssetDataQuality(id, dataQualityStatus, this.clock().toISOString());
  }

  async addAlias(input: AddAssetAliasInput): Promise<AssetAlias> {
    const assetId = normalizeUuid(input.assetId, 'asset id');
    if (!await this.repository.findAssetById(assetId)) throw new AssetDirectoryError('ASSET_NOT_FOUND', '资产不存在');
    const alias = normalizeText(input.alias, 'asset alias', 200);
    if (await this.repository.findAlias(assetId, alias)) throw new AssetDirectoryError('DUPLICATE_ASSET_ALIAS', '资产别名已存在');
    const now = this.clock().toISOString();
    return this.repository.createAlias({
      id: normalizeUuid(input.id ?? this.createId(), 'asset alias id'),
      assetId,
      alias,
      aliasType: input.aliasType ?? 'display',
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now
    });
  }

  async linkExternalReference(input: LinkExternalAssetInput): Promise<ExternalAssetReference> {
    const assetId = normalizeUuid(input.assetId, 'asset id');
    if (!await this.repository.findAssetById(assetId)) throw new AssetDirectoryError('ASSET_NOT_FOUND', '资产不存在');
    const now = this.clock().toISOString();
    const status = input.status ?? 'active';
    return this.repository.createExternalReference({
      id: normalizeUuid(input.id ?? this.createId(), 'external asset reference id'),
      assetId,
      provider: normalizeProvider(input.provider),
      tenantKey: normalizeProvider(input.tenantKey ?? 'default'),
      externalAssetId: normalizeText(input.externalAssetId, 'external asset id', 255),
      status,
      verifiedAt: input.verifiedAt?.toISOString() ?? (status === 'active' ? now : null),
      createdAt: now,
      updatedAt: now
    });
  }

  async listSystems() {
    return this.repository.listSystems();
  }

  async listCategories(systemId?: string) {
    return this.repository.listCategories(systemId ? normalizeUuid(systemId, 'asset system id') : undefined);
  }

  async listTypes(systemId?: string) {
    return this.repository.listTypes(systemId ? normalizeUuid(systemId, 'asset system id') : undefined);
  }

  async getAssetProfile(id: string) {
    return this.repository.getAssetProfile(normalizeUuid(id, 'asset id'));
  }

  async searchAssets(input: SearchAssetsInput = {}): Promise<AssetDirectoryProfile[]> {
    return this.repository.searchAssets({
      query: input.query?.trim() || undefined,
      systemId: input.systemId ? normalizeUuid(input.systemId, 'asset system id') : undefined,
      categoryId: input.categoryId ? normalizeUuid(input.categoryId, 'asset category id') : undefined,
      typeId: input.typeId ? normalizeUuid(input.typeId, 'asset type id') : undefined,
      locationId: input.locationId ? normalizeUuid(input.locationId, 'asset location id') : undefined,
      lifecycleState: input.lifecycleState,
      dataQualityStatus: input.dataQualityStatus,
      limit: normalizeSearchLimit(input.limit)
    });
  }

  async resolveExternalReference(provider: string, externalAssetId: string, tenantKey = 'default') {
    return this.repository.findAssetByExternalReference(
      normalizeProvider(provider),
      normalizeProvider(tenantKey),
      normalizeText(externalAssetId, 'external asset id', 255)
    );
  }

  private async requireLocation(id: string) {
    if (!this.findLocation) throw new AssetDirectoryError('LOCATION_LOOKUP_REQUIRED', '资产目录需要位置目录校验器');
    const location = await this.findLocation(id);
    if (!location) throw new AssetDirectoryError('ASSET_LOCATION_NOT_FOUND', '资产位置不存在');
    return location;
  }
}

export function createAssetDirectoryService(repository: AssetDirectoryRepository, options: AssetDirectoryServiceOptions = {}) {
  return new AssetDirectoryService(repository, options);
}

export function reconcileLegacyAssets(snapshot: LegacyAssetSnapshot): LegacyAssetReconciliation {
  const typeNames = new Map<string, string>();
  const scopedNames = new Set<string>();
  const assetCodes = new Set<string>();
  const issues: LegacyAssetIssue[] = [];
  let codedAssetCount = 0;
  let responsibilitySourceCount = 0;
  let deferredNetworkFieldCount = 0;
  let importEvidenceCount = 0;

  for (const type of snapshot.deviceTypes) {
    const name = type.name.trim().toLocaleLowerCase('zh-CN');
    if (typeNames.has(name)) issues.push({ code: 'DUPLICATE_DEVICE_TYPE_NAME', assetId: type.id, value: type.name.trim() });
    else typeNames.set(name, type.id);
  }

  for (const device of snapshot.devices) {
    const locationId = device.locationId?.trim();
    const typeId = device.typeId?.trim();
    const displayName = device.displayName?.trim();
    const assetCode = device.assetCode?.trim().toUpperCase();
    if (!locationId) issues.push({ code: 'MISSING_LOCATION', assetId: device.id });
    if (!typeId) issues.push({ code: 'MISSING_TYPE', assetId: device.id });
    if (!displayName) issues.push({ code: 'MISSING_DISPLAY_NAME', assetId: device.id });
    if (locationId && typeId && displayName) {
      const key = `${locationId}::${typeId}::${displayName.toLocaleLowerCase('zh-CN')}`;
      if (scopedNames.has(key)) issues.push({ code: 'DUPLICATE_LOCATION_TYPE_NAME', assetId: device.id, value: key });
      scopedNames.add(key);
    }
    if (assetCode) {
      codedAssetCount += 1;
      if (assetCodes.has(assetCode)) issues.push({ code: 'DUPLICATE_ASSET_CODE', assetId: device.id, value: assetCode });
      assetCodes.add(assetCode);
    }
    if (device.workgroupId) responsibilitySourceCount += 1;
    if (device.ipAddress || device.subnetMask || device.gateway) deferredNetworkFieldCount += 1;
    if (device.sourceKey || device.sourceFile || Number.isSafeInteger(device.sourceRow)) importEvidenceCount += 1;
  }

  return {
    targetSystemCode: 'AFC',
    assetCount: new Set(snapshot.devices.map((device) => device.id)).size,
    assetTypeCount: new Set(snapshot.deviceTypes.map((type) => type.id)).size,
    preservedAssetIds: [...new Set(snapshot.devices.map((device) => device.id))],
    preservedAssetTypeIds: [...new Set(snapshot.deviceTypes.map((type) => type.id))],
    codedAssetCount,
    responsibilitySourceCount,
    deferredNetworkFieldCount,
    importEvidenceCount,
    faultDeviceReferenceCount: snapshot.faultDeviceReferenceCount ?? 0,
    resolutionAuditCount: snapshot.resolutionAuditCount ?? 0,
    issues
  };
}

export function legacyAssetTypeCode(typeId: string) {
  return `legacy-type:${normalizeUuid(typeId, 'asset type id')}`;
}

function normalizeText(value: string, label: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized) throw new AssetDirectoryError('MISSING_DIRECTORY_VALUE', `${label} 不能为空`);
  if (normalized.length > maxLength) throw new AssetDirectoryError('DIRECTORY_VALUE_TOO_LONG', `${label} 超过长度限制`);
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined, maxLength: number): string | null {
  if (value == null || !value.trim()) return null;
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new AssetDirectoryError('DIRECTORY_VALUE_TOO_LONG', '目录字段超过长度限制');
  return normalized;
}

function normalizeClassificationCode(value: string, label: string) {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]{0,99}$/.test(normalized)) {
    throw new AssetDirectoryError('INVALID_CLASSIFICATION_CODE', `${label} 必须是稳定 ASCII 编码`);
  }
  return normalized;
}

function normalizeOptionalAssetCode(value: string | null | undefined) {
  if (value == null || !value.trim()) return null;
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]{0,99}$/.test(normalized)) {
    throw new AssetDirectoryError('INVALID_ASSET_CODE', '资产编码必须是稳定 ASCII 编码');
  }
  return normalized;
}

function normalizeProvider(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(normalized)) {
    throw new AssetDirectoryError('INVALID_EXTERNAL_PROVIDER', '外部资产来源必须是稳定 ASCII 编码');
  }
  return normalized;
}

function normalizeUuid(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new AssetDirectoryError('INVALID_DIRECTORY_ID', `${label} 必须是 UUID`);
  }
  return normalized;
}

function normalizeSortOrder(value: number | undefined) {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized)) throw new AssetDirectoryError('INVALID_SORT_ORDER', '资产分类排序必须是整数');
  return normalized;
}

function normalizeSearchLimit(value: number | undefined) {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new AssetDirectoryError('INVALID_SEARCH_LIMIT', '资产查询数量必须在 1 到 100 之间');
  }
  return value;
}
