import type { QueryableClient } from '../../core/database/index.js';
import {
  AssetDirectoryError,
  type Asset,
  type AssetAlias,
  type AssetCategory,
  type AssetDirectoryProfile,
  type AssetSystem,
  type AssetType,
  type ExternalAssetReference,
  type SearchAssetsInput
} from './model.js';

export interface AssetDirectoryRepository {
  updateSystemDetails(id: string, patch: Partial<Pick<AssetSystem, 'name' | 'description'>>, updatedAt: string): Promise<AssetSystem>;
  updateCategoryDetails(id: string, patch: Partial<Pick<AssetCategory, 'name' | 'description'>>, updatedAt: string): Promise<AssetCategory>;
  updateTypeDetails(id: string, patch: Partial<Pick<AssetType, 'name' | 'description'>>, updatedAt: string): Promise<AssetType>;
  createSystem(record: AssetSystem): Promise<AssetSystem>;
  findSystemById(id: string): Promise<AssetSystem | null>;
  findSystemByCode(code: string): Promise<AssetSystem | null>;
  listSystems(): Promise<AssetSystem[]>;
  createCategory(record: AssetCategory): Promise<AssetCategory>;
  findCategoryById(id: string): Promise<AssetCategory | null>;
  findCategoryByCode(systemId: string, code: string): Promise<AssetCategory | null>;
  listCategories(systemId?: string): Promise<AssetCategory[]>;
  createType(record: AssetType): Promise<AssetType>;
  findTypeById(id: string): Promise<AssetType | null>;
  findTypeByCode(systemId: string, code: string): Promise<AssetType | null>;
  listTypes(systemId?: string): Promise<AssetType[]>;
  createAsset(record: Asset): Promise<Asset>;
  findAssetById(id: string): Promise<Asset | null>;
  findAssetByCode(assetCode: string): Promise<Asset | null>;
  findAssetByScopedName(locationId: string, typeId: string, displayName: string): Promise<Asset | null>;
  updateAssetLocation(id: string, locationId: string, updatedAt: string): Promise<Asset>;
  updateAssetLifecycle(id: string, lifecycleState: Asset['lifecycleState'], updatedAt: string): Promise<Asset>;
  updateAssetDataQuality(id: string, dataQualityStatus: Asset['dataQualityStatus'], updatedAt: string): Promise<Asset>;
  createAlias(record: AssetAlias): Promise<AssetAlias>;
  findAlias(assetId: string, alias: string): Promise<AssetAlias | null>;
  listAliases(assetId: string): Promise<AssetAlias[]>;
  createExternalReference(record: ExternalAssetReference): Promise<ExternalAssetReference>;
  findAssetByExternalReference(provider: string, tenantKey: string, externalAssetId: string): Promise<AssetDirectoryProfile | null>;
  getAssetProfile(id: string): Promise<AssetDirectoryProfile | null>;
  listAssetProfiles(input: Omit<SearchAssetsInput, 'query' | 'limit'>): Promise<AssetDirectoryProfile[]>;
  searchAssets(input: SearchAssetsInput): Promise<AssetDirectoryProfile[]>;
}

export interface MemoryAssetDirectoryRepository extends AssetDirectoryRepository {
  records(): {
    systems: AssetSystem[];
    categories: AssetCategory[];
    types: AssetType[];
    assets: Asset[];
    aliases: AssetAlias[];
    externalReferences: ExternalAssetReference[];
  };
}

export function createMemoryAssetDirectoryRepository(seed: {
  systems?: readonly AssetSystem[];
  categories?: readonly AssetCategory[];
  types?: readonly AssetType[];
  assets?: readonly Asset[];
  aliases?: readonly AssetAlias[];
  externalReferences?: readonly ExternalAssetReference[];
} = {}): MemoryAssetDirectoryRepository {
  const systems = toMap(seed.systems);
  const categories = toMap(seed.categories);
  const types = toMap(seed.types);
  const assets = toMap(seed.assets);
  const aliases = toMap(seed.aliases);
  const externalReferences = toMap(seed.externalReferences);

  return {
    async updateSystemDetails(id, patch, updatedAt) {
      const record = systems.get(id);
      if (!record) throw new AssetDirectoryError('DIRECTORY_RECORD_NOT_FOUND', '目录记录不存在');
      const updated = { ...record, ...patch, updatedAt };
      systems.set(id, clone(updated));
      return clone(updated);
    },
    async updateCategoryDetails(id, patch, updatedAt) {
      const record = categories.get(id);
      if (!record) throw new AssetDirectoryError('DIRECTORY_RECORD_NOT_FOUND', '目录记录不存在');
      const updated = { ...record, ...patch, updatedAt };
      categories.set(id, clone(updated));
      return clone(updated);
    },
    async updateTypeDetails(id, patch, updatedAt) {
      const record = types.get(id);
      if (!record) throw new AssetDirectoryError('DIRECTORY_RECORD_NOT_FOUND', '目录记录不存在');
      const updated = { ...record, ...patch, updatedAt };
      types.set(id, clone(updated));
      return clone(updated);
    },
    async createSystem(record) {
      assertUniqueId(systems, record.id, 'DUPLICATE_ASSET_SYSTEM_ID');
      assertUnique(systems.values(), (item) => item.code === record.code, 'DUPLICATE_ASSET_SYSTEM_CODE');
      systems.set(record.id, clone(record));
      return clone(record);
    },
    async findSystemById(id) {
      return cloneOrNull(systems.get(id));
    },
    async findSystemByCode(code) {
      return cloneOrNull([...systems.values()].find((item) => item.code === code));
    },
    async listSystems() {
      return [...systems.values()].map(clone).sort(compareDirectoryRecords);
    },
    async createCategory(record) {
      assertUniqueId(categories, record.id, 'DUPLICATE_ASSET_CATEGORY_ID');
      assertUnique(categories.values(), (item) => item.systemId === record.systemId && item.code === record.code, 'DUPLICATE_ASSET_CATEGORY_CODE');
      categories.set(record.id, clone(record));
      return clone(record);
    },
    async findCategoryById(id) {
      return cloneOrNull(categories.get(id));
    },
    async findCategoryByCode(systemId, code) {
      return cloneOrNull([...categories.values()].find((item) => item.systemId === systemId && item.code === code));
    },
    async listCategories(systemId) {
      return [...categories.values()].filter((item) => !systemId || item.systemId === systemId).map(clone).sort(compareDirectoryRecords);
    },
    async createType(record) {
      assertUniqueId(types, record.id, 'DUPLICATE_ASSET_TYPE_ID');
      assertUnique(types.values(), (item) => item.systemId === record.systemId && item.code === record.code, 'DUPLICATE_ASSET_TYPE_CODE');
      types.set(record.id, clone(record));
      return clone(record);
    },
    async findTypeById(id) {
      return cloneOrNull(types.get(id));
    },
    async findTypeByCode(systemId, code) {
      return cloneOrNull([...types.values()].find((item) => item.systemId === systemId && item.code === code));
    },
    async listTypes(systemId) {
      return [...types.values()].filter((item) => !systemId || item.systemId === systemId).map(clone).sort(compareDirectoryRecords);
    },
    async createAsset(record) {
      assertUniqueId(assets, record.id, 'DUPLICATE_ASSET_ID');
      const normalizedName = record.displayName.toLocaleLowerCase('zh-CN');
      assertUnique(assets.values(), (item) =>
        item.locationId === record.locationId
        && item.typeId === record.typeId
        && item.displayName.toLocaleLowerCase('zh-CN') === normalizedName,
      'DUPLICATE_ASSET_SCOPED_NAME');
      if (record.assetCode) {
        assertUnique(assets.values(), (item) => item.assetCode?.toUpperCase() === record.assetCode?.toUpperCase(), 'DUPLICATE_ASSET_CODE');
      }
      assets.set(record.id, clone(record));
      return clone(record);
    },
    async findAssetById(id) {
      return cloneOrNull(assets.get(id));
    },
    async findAssetByCode(assetCode) {
      const normalized = assetCode.toUpperCase();
      return cloneOrNull([...assets.values()].find((item) => item.assetCode?.toUpperCase() === normalized));
    },
    async findAssetByScopedName(locationId, typeId, displayName) {
      const normalized = displayName.toLocaleLowerCase('zh-CN');
      return cloneOrNull([...assets.values()].find((item) =>
        item.locationId === locationId
        && item.typeId === typeId
        && item.displayName.toLocaleLowerCase('zh-CN') === normalized
      ));
    },
    async updateAssetLocation(id, locationId, updatedAt) {
      const asset = assets.get(id);
      if (!asset) throw new AssetDirectoryError('ASSET_NOT_FOUND', '资产不存在');
      const conflict = [...assets.values()].find((item) =>
        item.id !== id
        && item.locationId === locationId
        && item.typeId === asset.typeId
        && item.displayName.toLocaleLowerCase('zh-CN') === asset.displayName.toLocaleLowerCase('zh-CN')
      );
      if (conflict) throw new AssetDirectoryError('DUPLICATE_ASSET_SCOPED_NAME', '目标位置已存在同类型同名资产');
      const updated = { ...asset, locationId, updatedAt };
      assets.set(id, clone(updated));
      return clone(updated);
    },
    async updateAssetLifecycle(id, lifecycleState, updatedAt) {
      const asset = assets.get(id);
      if (!asset) throw new AssetDirectoryError('ASSET_NOT_FOUND', '资产不存在');
      const updated = { ...asset, lifecycleState, updatedAt };
      assets.set(id, clone(updated));
      return clone(updated);
    },
    async updateAssetDataQuality(id, dataQualityStatus, updatedAt) {
      const asset = assets.get(id);
      if (!asset) throw new AssetDirectoryError('ASSET_NOT_FOUND', '资产不存在');
      const updated = { ...asset, dataQualityStatus, updatedAt };
      assets.set(id, clone(updated));
      return clone(updated);
    },
    async createAlias(record) {
      assertUniqueId(aliases, record.id, 'DUPLICATE_ASSET_ALIAS_ID');
      const normalized = record.alias.toLocaleLowerCase('zh-CN');
      assertUnique(aliases.values(), (item) => item.assetId === record.assetId && item.alias.toLocaleLowerCase('zh-CN') === normalized, 'DUPLICATE_ASSET_ALIAS');
      aliases.set(record.id, clone(record));
      return clone(record);
    },
    async findAlias(assetId, alias) {
      const normalized = alias.toLocaleLowerCase('zh-CN');
      return cloneOrNull([...aliases.values()].find((item) => item.assetId === assetId && item.alias.toLocaleLowerCase('zh-CN') === normalized));
    },
    async listAliases(assetId) {
      return [...aliases.values()].filter((item) => item.assetId === assetId).map(clone).sort((a, b) => a.alias.localeCompare(b.alias, 'zh-CN'));
    },
    async createExternalReference(record) {
      assertUniqueId(externalReferences, record.id, 'DUPLICATE_EXTERNAL_ASSET_ID');
      assertUnique(externalReferences.values(), (item) =>
        item.provider === record.provider
        && item.tenantKey === record.tenantKey
        && (item.externalAssetId === record.externalAssetId || item.assetId === record.assetId),
      'DUPLICATE_EXTERNAL_ASSET_REFERENCE');
      externalReferences.set(record.id, clone(record));
      return clone(record);
    },
    async findAssetByExternalReference(provider, tenantKey, externalAssetId) {
      const reference = [...externalReferences.values()].find((item) =>
        item.provider === provider
        && item.tenantKey === tenantKey
        && item.externalAssetId === externalAssetId
        && item.status === 'active'
        && item.verifiedAt !== null
      );
      return reference ? createMemoryProfile(reference.assetId, systems, categories, types, assets, aliases) : null;
    },
    async getAssetProfile(id) {
      return assets.has(id) ? createMemoryProfile(id, systems, categories, types, assets, aliases) : null;
    },
    async listAssetProfiles(input) {
      return [...assets.values()]
        .filter((asset) => (!input.systemId || asset.systemId === input.systemId)
          && (!input.categoryId || asset.categoryId === input.categoryId)
          && (!input.typeId || asset.typeId === input.typeId)
          && (!input.locationId || asset.locationId === input.locationId)
          && (!input.lifecycleState || asset.lifecycleState === input.lifecycleState)
          && (!input.dataQualityStatus || asset.dataQualityStatus === input.dataQualityStatus))
        .sort(compareAssets)
        .map((asset) => createMemoryProfile(asset.id, systems, categories, types, assets, aliases));
    },
    async searchAssets(input) {
      const query = input.query?.trim().toLocaleLowerCase('zh-CN');
      return [...assets.values()]
        .filter((asset) => {
          if (input.systemId && asset.systemId !== input.systemId) return false;
          if (input.categoryId && asset.categoryId !== input.categoryId) return false;
          if (input.typeId && asset.typeId !== input.typeId) return false;
          if (input.locationId && asset.locationId !== input.locationId) return false;
          if (input.lifecycleState && asset.lifecycleState !== input.lifecycleState) return false;
          if (input.dataQualityStatus && asset.dataQualityStatus !== input.dataQualityStatus) return false;
          if (!query) return true;
          const activeAliases = [...aliases.values()].filter((alias) => alias.assetId === asset.id && alias.status === 'active');
          return [asset.displayName, asset.assetCode ?? '', ...activeAliases.map((alias) => alias.alias)]
            .some((value) => value.toLocaleLowerCase('zh-CN').includes(query));
        })
        .sort(compareAssets)
        .slice(0, normalizeLimit(input.limit))
        .map((asset) => createMemoryProfile(asset.id, systems, categories, types, assets, aliases));
    },
    records() {
      return {
        systems: [...systems.values()].map(clone),
        categories: [...categories.values()].map(clone),
        types: [...types.values()].map(clone),
        assets: [...assets.values()].map(clone),
        aliases: [...aliases.values()].map(clone),
        externalReferences: [...externalReferences.values()].map(clone)
      };
    }
  };
}

export function createPostgresAssetDirectoryRepository(client: QueryableClient): AssetDirectoryRepository {
  return {
    async updateSystemDetails(id, patch, updatedAt) {
      return mapSystem(requireRow(await client.query(
        'UPDATE platform_asset_systems SET name=CASE WHEN $2 THEN $3 ELSE name END, description=CASE WHEN $4 THEN $5 ELSE description END, updated_at=$6 WHERE id=$1 RETURNING *',
        [id, Object.hasOwn(patch, 'name'), patch.name ?? null, Object.hasOwn(patch, 'description'), patch.description ?? null, updatedAt]
      ), 'DIRECTORY_RECORD_NOT_FOUND'));
    },
    async updateCategoryDetails(id, patch, updatedAt) {
      return mapCategory(requireRow(await client.query(
        'UPDATE platform_asset_categories SET name=CASE WHEN $2 THEN $3 ELSE name END, description=CASE WHEN $4 THEN $5 ELSE description END, updated_at=$6 WHERE id=$1 RETURNING *',
        [id, Object.hasOwn(patch, 'name'), patch.name ?? null, Object.hasOwn(patch, 'description'), patch.description ?? null, updatedAt]
      ), 'DIRECTORY_RECORD_NOT_FOUND'));
    },
    async updateTypeDetails(id, patch, updatedAt) {
      return mapType(requireRow(await client.query(
        'UPDATE platform_asset_types SET name=CASE WHEN $2 THEN $3 ELSE name END, description=CASE WHEN $4 THEN $5 ELSE description END, updated_at=$6 WHERE id=$1 RETURNING *',
        [id, Object.hasOwn(patch, 'name'), patch.name ?? null, Object.hasOwn(patch, 'description'), patch.description ?? null, updatedAt]
      ), 'DIRECTORY_RECORD_NOT_FOUND'));
    },
    async createSystem(record) {
      return mapSystem(requireRow(await client.query(
        `INSERT INTO platform_asset_systems (id, code, name, description, status, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [record.id, record.code, record.name, record.description, record.status, record.sortOrder, record.createdAt, record.updatedAt]
      ), 'ASSET_SYSTEM_INSERT_FAILED'));
    },
    async findSystemById(id) {
      return optionalRow(await client.query('SELECT * FROM platform_asset_systems WHERE id = $1', [id]), mapSystem);
    },
    async findSystemByCode(code) {
      return optionalRow(await client.query('SELECT * FROM platform_asset_systems WHERE code = $1', [code]), mapSystem);
    },
    async listSystems() {
      return resultRows(await client.query('SELECT * FROM platform_asset_systems ORDER BY sort_order, name, id')).map(mapSystem);
    },
    async createCategory(record) {
      return mapCategory(requireRow(await client.query(
        `INSERT INTO platform_asset_categories (id, system_id, code, name, description, status, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [record.id, record.systemId, record.code, record.name, record.description, record.status, record.sortOrder, record.createdAt, record.updatedAt]
      ), 'ASSET_CATEGORY_INSERT_FAILED'));
    },
    async findCategoryById(id) {
      return optionalRow(await client.query('SELECT * FROM platform_asset_categories WHERE id = $1', [id]), mapCategory);
    },
    async findCategoryByCode(systemId, code) {
      return optionalRow(await client.query('SELECT * FROM platform_asset_categories WHERE system_id = $1 AND code = $2', [systemId, code]), mapCategory);
    },
    async listCategories(systemId) {
      return resultRows(await client.query(
        'SELECT * FROM platform_asset_categories WHERE ($1::uuid IS NULL OR system_id = $1) ORDER BY sort_order, name, id',
        [systemId ?? null]
      )).map(mapCategory);
    },
    async createType(record) {
      return mapType(requireRow(await client.query(
        `INSERT INTO platform_asset_types (id, system_id, category_id, code, name, description, status, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [record.id, record.systemId, record.categoryId, record.code, record.name, record.description, record.status, record.sortOrder, record.createdAt, record.updatedAt]
      ), 'ASSET_TYPE_INSERT_FAILED'));
    },
    async findTypeById(id) {
      return optionalRow(await client.query('SELECT * FROM platform_asset_types WHERE id = $1', [id]), mapType);
    },
    async findTypeByCode(systemId, code) {
      return optionalRow(await client.query('SELECT * FROM platform_asset_types WHERE system_id = $1 AND code = $2', [systemId, code]), mapType);
    },
    async listTypes(systemId) {
      return resultRows(await client.query(
        'SELECT * FROM platform_asset_types WHERE ($1::uuid IS NULL OR system_id = $1) ORDER BY sort_order, name, id',
        [systemId ?? null]
      )).map(mapType);
    },
    async createAsset(record) {
      return mapAsset(requireRow(await client.query(
        `INSERT INTO platform_assets
          (id, system_id, category_id, type_id, location_id, display_name, asset_code, lifecycle_state, data_quality_status, remark, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [record.id, record.systemId, record.categoryId, record.typeId, record.locationId, record.displayName, record.assetCode, record.lifecycleState, record.dataQualityStatus, record.remark, record.createdAt, record.updatedAt]
      ), 'ASSET_INSERT_FAILED'));
    },
    async findAssetById(id) {
      return optionalRow(await client.query('SELECT * FROM platform_assets WHERE id = $1', [id]), mapAsset);
    },
    async findAssetByCode(assetCode) {
      return optionalRow(await client.query('SELECT * FROM platform_assets WHERE lower(asset_code) = lower($1)', [assetCode]), mapAsset);
    },
    async findAssetByScopedName(locationId, typeId, displayName) {
      return optionalRow(await client.query(
        'SELECT * FROM platform_assets WHERE location_id = $1 AND type_id = $2 AND lower(display_name) = lower($3)',
        [locationId, typeId, displayName]
      ), mapAsset);
    },
    async updateAssetLocation(id, locationId, updatedAt) {
      return mapAsset(requireRow(await client.query(
        'UPDATE platform_assets SET location_id = $2, updated_at = $3 WHERE id = $1 RETURNING *',
        [id, locationId, updatedAt]
      ), 'ASSET_NOT_FOUND'));
    },
    async updateAssetLifecycle(id, lifecycleState, updatedAt) {
      return mapAsset(requireRow(await client.query(
        'UPDATE platform_assets SET lifecycle_state = $2, updated_at = $3 WHERE id = $1 RETURNING *',
        [id, lifecycleState, updatedAt]
      ), 'ASSET_NOT_FOUND'));
    },
    async updateAssetDataQuality(id, dataQualityStatus, updatedAt) {
      return mapAsset(requireRow(await client.query(
        'UPDATE platform_assets SET data_quality_status = $2, updated_at = $3 WHERE id = $1 RETURNING *',
        [id, dataQualityStatus, updatedAt]
      ), 'ASSET_NOT_FOUND'));
    },
    async createAlias(record) {
      return mapAlias(requireRow(await client.query(
        `INSERT INTO platform_asset_aliases (id, asset_id, alias, alias_type, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [record.id, record.assetId, record.alias, record.aliasType, record.status, record.createdAt, record.updatedAt]
      ), 'ASSET_ALIAS_INSERT_FAILED'));
    },
    async findAlias(assetId, alias) {
      return optionalRow(await client.query('SELECT * FROM platform_asset_aliases WHERE asset_id = $1 AND lower(alias) = lower($2)', [assetId, alias]), mapAlias);
    },
    async listAliases(assetId) {
      return resultRows(await client.query('SELECT * FROM platform_asset_aliases WHERE asset_id = $1 ORDER BY alias', [assetId])).map(mapAlias);
    },
    async createExternalReference(record) {
      return mapExternalReference(requireRow(await client.query(
        `INSERT INTO platform_external_asset_references
          (id, asset_id, provider, tenant_key, external_asset_id, status, verified_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [record.id, record.assetId, record.provider, record.tenantKey, record.externalAssetId, record.status, record.verifiedAt, record.createdAt, record.updatedAt]
      ), 'EXTERNAL_ASSET_INSERT_FAILED'));
    },
    async findAssetByExternalReference(provider, tenantKey, externalAssetId) {
      const result = await client.query(
        `${ASSET_PROFILE_SELECT}
         JOIN platform_external_asset_references reference ON reference.asset_id = asset.id
         WHERE reference.provider = $1 AND reference.tenant_key = $2 AND reference.external_asset_id = $3
           AND reference.status = 'active' AND reference.verified_at IS NOT NULL`,
        [provider, tenantKey, externalAssetId]
      );
      const profile = optionalRow(result, mapProfile);
      return profile ? loadAliases(client, [profile]).then((items) => items[0]) : null;
    },
    async getAssetProfile(id) {
      const profile = optionalRow(await client.query(`${ASSET_PROFILE_SELECT} WHERE asset.id = $1`, [id]), mapProfile);
      return profile ? loadAliases(client, [profile]).then((items) => items[0]) : null;
    },
    async listAssetProfiles(input) {
      const result = await client.query(
        `${ASSET_PROFILE_SELECT}
         WHERE ($1::uuid IS NULL OR asset.system_id = $1)
           AND ($2::uuid IS NULL OR asset.category_id = $2)
           AND ($3::uuid IS NULL OR asset.type_id = $3)
           AND ($4::uuid IS NULL OR asset.location_id = $4)
           AND ($5::text IS NULL OR asset.lifecycle_state = $5)
           AND ($6::text IS NULL OR asset.data_quality_status = $6)
         ORDER BY asset.display_name, asset.id`,
        [
          input.systemId ?? null,
          input.categoryId ?? null,
          input.typeId ?? null,
          input.locationId ?? null,
          input.lifecycleState ?? null,
          input.dataQualityStatus ?? null
        ]
      );
      return loadAliases(client, resultRows(result).map(mapProfile));
    },
    async searchAssets(input) {
      const result = await client.query(
        `${ASSET_PROFILE_SELECT}
         LEFT JOIN platform_asset_aliases search_alias ON search_alias.asset_id = asset.id AND search_alias.status = 'active'
         WHERE ($1::text IS NULL OR asset.display_name ILIKE '%' || $1 || '%' OR asset.asset_code ILIKE '%' || $1 || '%'
           OR search_alias.alias ILIKE '%' || $1 || '%')
           AND ($2::uuid IS NULL OR asset.system_id = $2)
           AND ($3::uuid IS NULL OR asset.category_id = $3)
           AND ($4::uuid IS NULL OR asset.type_id = $4)
           AND ($5::uuid IS NULL OR asset.location_id = $5)
           AND ($6::text IS NULL OR asset.lifecycle_state = $6)
           AND ($7::text IS NULL OR asset.data_quality_status = $7)
         GROUP BY asset.id, system.id, category.id, type.id
         ORDER BY asset.display_name, asset.id
         LIMIT $8`,
        [
          input.query?.trim() || null,
          input.systemId ?? null,
          input.categoryId ?? null,
          input.typeId ?? null,
          input.locationId ?? null,
          input.lifecycleState ?? null,
          input.dataQualityStatus ?? null,
          normalizeLimit(input.limit)
        ]
      );
      return loadAliases(client, resultRows(result).map(mapProfile));
    }
  };
}

const ASSET_PROFILE_SELECT = `SELECT
  asset.id AS asset_id, asset.system_id AS asset_system_id, asset.category_id AS asset_category_id,
  asset.type_id AS asset_type_id, asset.location_id, asset.display_name, asset.asset_code,
  asset.lifecycle_state, asset.data_quality_status, asset.remark,
  asset.created_at AS asset_created_at, asset.updated_at AS asset_updated_at,
  system.id AS system_record_id, system.code AS system_code, system.name AS system_name,
  system.description AS system_description, system.status AS system_status,
  system.sort_order AS system_sort_order, system.created_at AS system_created_at, system.updated_at AS system_updated_at,
  category.id AS category_record_id, category.system_id AS category_system_id, category.code AS category_code,
  category.name AS category_name, category.description AS category_description, category.status AS category_status,
  category.sort_order AS category_sort_order, category.created_at AS category_created_at, category.updated_at AS category_updated_at,
  type.id AS type_record_id, type.system_id AS type_system_id, type.category_id AS type_category_id,
  type.code AS type_code, type.name AS type_name, type.description AS type_description,
  type.status AS type_status, type.sort_order AS type_sort_order,
  type.created_at AS type_created_at, type.updated_at AS type_updated_at
FROM platform_assets asset
JOIN platform_asset_systems system ON system.id = asset.system_id
LEFT JOIN platform_asset_categories category ON category.id = asset.category_id
JOIN platform_asset_types type ON type.id = asset.type_id`;

async function loadAliases(client: QueryableClient, profiles: AssetDirectoryProfile[]) {
  if (profiles.length === 0) return [];
  const ids = profiles.map((profile) => profile.asset.id);
  const aliases = resultRows(await client.query(
    "SELECT * FROM platform_asset_aliases WHERE asset_id = ANY($1::uuid[]) AND status = 'active' ORDER BY alias",
    [ids]
  )).map(mapAlias);
  const grouped = groupBy(aliases, (alias) => alias.assetId);
  return profiles.map((profile) => ({ ...profile, aliases: grouped.get(profile.asset.id) ?? [] }));
}

function createMemoryProfile(
  assetId: string,
  systems: Map<string, AssetSystem>,
  categories: Map<string, AssetCategory>,
  types: Map<string, AssetType>,
  assets: Map<string, Asset>,
  aliases: Map<string, AssetAlias>
): AssetDirectoryProfile {
  const asset = assets.get(assetId);
  if (!asset) throw new AssetDirectoryError('ASSET_NOT_FOUND', '资产不存在');
  const system = systems.get(asset.systemId);
  const type = types.get(asset.typeId);
  const category = asset.categoryId ? categories.get(asset.categoryId) : null;
  if (!system || !type || (asset.categoryId && !category)) {
    throw new AssetDirectoryError('BROKEN_ASSET_REFERENCE', `资产分类引用不完整: ${asset.id}`);
  }
  return {
    asset: clone(asset),
    system: clone(system),
    category: category ? clone(category) : null,
    type: clone(type),
    aliases: [...aliases.values()].filter((alias) => alias.assetId === assetId && alias.status === 'active').map(clone).sort((a, b) => a.alias.localeCompare(b.alias, 'zh-CN'))
  };
}

function mapSystem(row: unknown): AssetSystem {
  const value = asRecord(row);
  return {
    id: requiredString(value.id), code: requiredString(value.code), name: requiredString(value.name),
    description: optionalString(value.description), status: requiredString(value.status) as AssetSystem['status'],
    sortOrder: Number(value.sort_order ?? 0), createdAt: toIsoString(value.created_at), updatedAt: toIsoString(value.updated_at)
  };
}

function mapCategory(row: unknown): AssetCategory {
  const value = asRecord(row);
  return {
    id: requiredString(value.id), systemId: requiredString(value.system_id), code: requiredString(value.code),
    name: requiredString(value.name), description: optionalString(value.description),
    status: requiredString(value.status) as AssetCategory['status'], sortOrder: Number(value.sort_order ?? 0),
    createdAt: toIsoString(value.created_at), updatedAt: toIsoString(value.updated_at)
  };
}

function mapType(row: unknown): AssetType {
  const value = asRecord(row);
  return {
    id: requiredString(value.id), systemId: requiredString(value.system_id), categoryId: optionalString(value.category_id),
    code: requiredString(value.code), name: requiredString(value.name), description: optionalString(value.description),
    status: requiredString(value.status) as AssetType['status'], sortOrder: Number(value.sort_order ?? 0),
    createdAt: toIsoString(value.created_at), updatedAt: toIsoString(value.updated_at)
  };
}

function mapAsset(row: unknown): Asset {
  const value = asRecord(row);
  return {
    id: requiredString(value.id), systemId: requiredString(value.system_id), categoryId: optionalString(value.category_id),
    typeId: requiredString(value.type_id), locationId: requiredString(value.location_id), displayName: requiredString(value.display_name),
    assetCode: optionalString(value.asset_code), lifecycleState: requiredString(value.lifecycle_state) as Asset['lifecycleState'],
    dataQualityStatus: requiredString(value.data_quality_status) as Asset['dataQualityStatus'], remark: optionalString(value.remark),
    createdAt: toIsoString(value.created_at), updatedAt: toIsoString(value.updated_at)
  };
}

function mapAlias(row: unknown): AssetAlias {
  const value = asRecord(row);
  return {
    id: requiredString(value.id), assetId: requiredString(value.asset_id), alias: requiredString(value.alias),
    aliasType: requiredString(value.alias_type) as AssetAlias['aliasType'], status: requiredString(value.status) as AssetAlias['status'],
    createdAt: toIsoString(value.created_at), updatedAt: toIsoString(value.updated_at)
  };
}

function mapExternalReference(row: unknown): ExternalAssetReference {
  const value = asRecord(row);
  return {
    id: requiredString(value.id), assetId: requiredString(value.asset_id), provider: requiredString(value.provider),
    tenantKey: requiredString(value.tenant_key), externalAssetId: requiredString(value.external_asset_id),
    status: requiredString(value.status) as ExternalAssetReference['status'],
    verifiedAt: value.verified_at == null ? null : toIsoString(value.verified_at),
    createdAt: toIsoString(value.created_at), updatedAt: toIsoString(value.updated_at)
  };
}

function mapProfile(row: unknown): AssetDirectoryProfile {
  const value = asRecord(row);
  return {
    asset: {
      id: requiredString(value.asset_id), systemId: requiredString(value.asset_system_id), categoryId: optionalString(value.asset_category_id),
      typeId: requiredString(value.asset_type_id), locationId: requiredString(value.location_id), displayName: requiredString(value.display_name),
      assetCode: optionalString(value.asset_code), lifecycleState: requiredString(value.lifecycle_state) as Asset['lifecycleState'],
      dataQualityStatus: requiredString(value.data_quality_status) as Asset['dataQualityStatus'], remark: optionalString(value.remark),
      createdAt: toIsoString(value.asset_created_at), updatedAt: toIsoString(value.asset_updated_at)
    },
    system: {
      id: requiredString(value.system_record_id), code: requiredString(value.system_code), name: requiredString(value.system_name),
      description: optionalString(value.system_description), status: requiredString(value.system_status) as AssetSystem['status'],
      sortOrder: Number(value.system_sort_order ?? 0), createdAt: toIsoString(value.system_created_at), updatedAt: toIsoString(value.system_updated_at)
    },
    category: value.category_record_id ? {
      id: requiredString(value.category_record_id), systemId: requiredString(value.category_system_id), code: requiredString(value.category_code),
      name: requiredString(value.category_name), description: optionalString(value.category_description),
      status: requiredString(value.category_status) as AssetCategory['status'], sortOrder: Number(value.category_sort_order ?? 0),
      createdAt: toIsoString(value.category_created_at), updatedAt: toIsoString(value.category_updated_at)
    } : null,
    type: {
      id: requiredString(value.type_record_id), systemId: requiredString(value.type_system_id), categoryId: optionalString(value.type_category_id),
      code: requiredString(value.type_code), name: requiredString(value.type_name), description: optionalString(value.type_description),
      status: requiredString(value.type_status) as AssetType['status'], sortOrder: Number(value.type_sort_order ?? 0),
      createdAt: toIsoString(value.type_created_at), updatedAt: toIsoString(value.type_updated_at)
    },
    aliases: []
  };
}

function compareDirectoryRecords(left: { sortOrder: number; name: string; id: string }, right: { sortOrder: number; name: string; id: string }) {
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id);
}

function compareAssets(left: Asset, right: Asset) {
  return left.displayName.localeCompare(right.displayName, 'zh-CN') || left.id.localeCompare(right.id);
}

function toMap<T extends { id: string }>(values: readonly T[] | undefined) {
  return new Map((values ?? []).map((value) => [value.id, clone(value)]));
}

function normalizeLimit(limit: number | undefined) {
  return Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit! : 50));
}

function assertUniqueId<T>(records: Map<string, T>, id: string, code: string) {
  if (records.has(id)) throw new AssetDirectoryError(code, `目录 ID 已存在: ${id}`);
}

function assertUnique<T>(records: Iterable<T>, predicate: (record: T) => boolean, code: string) {
  if ([...records].some(predicate)) throw new AssetDirectoryError(code, '目录唯一值已存在');
}

function groupBy<T>(values: readonly T[], key: (value: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const value of values) grouped.set(key(value), [...grouped.get(key(value)) ?? [], value]);
  return grouped;
}

function resultRows(result: unknown): unknown[] {
  if (!result || typeof result !== 'object' || !('rows' in result) || !Array.isArray(result.rows)) return [];
  return result.rows;
}

function requireRow(result: unknown, code: string) {
  const row = resultRows(result)[0];
  if (!row) throw new AssetDirectoryError(code, '资产目录写入未返回记录');
  return row;
}

function optionalRow<T>(result: unknown, mapper: (row: unknown) => T): T | null {
  const row = resultRows(result)[0];
  return row ? mapper(row) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new AssetDirectoryError('INVALID_DATABASE_ROW', '资产目录数据库返回格式无效');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown) {
  if (typeof value !== 'string' || !value) throw new AssetDirectoryError('INVALID_DATABASE_ROW', '资产目录数据库字段缺失');
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function toIsoString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new AssetDirectoryError('INVALID_DATABASE_ROW', '资产目录数据库时间字段无效');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}
