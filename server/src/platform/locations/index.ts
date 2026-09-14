import { randomUUID } from 'node:crypto';
import {
  LOCATION_TYPES,
  LocationDirectoryError,
  type AddLocationAliasInput,
  type CreateLineInput,
  type CreateLocationInput,
  type ExternalLocationReference,
  type LegacyLocationIssue,
  type LegacyLocationReconciliation,
  type LegacyStationSnapshot,
  type Line,
  type LineStation,
  type LinkExternalLocationInput,
  type LinkStationToLineInput,
  type Location,
  type LocationAlias,
  type LocationDirectoryProfile,
  type LocationTreeNode,
  type SearchLocationsInput
} from './model.js';
import type { LocationDirectoryRepository } from './repository.js';

export * from './model.js';
export * from './migration.js';
export * from './repository.js';

export interface LocationDirectoryServiceOptions {
  clock?: () => Date;
  createId?: () => string;
  findOrganizationUnit?: (id: string) => Promise<{
    unitType: string;
    status: string;
  } | null>;
}

export class LocationDirectoryService {
  private readonly clock: () => Date;
  private readonly createId: () => string;
  private readonly findOrganizationUnit?: LocationDirectoryServiceOptions['findOrganizationUnit'];

  constructor(
    private readonly repository: LocationDirectoryRepository,
    options: LocationDirectoryServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.findOrganizationUnit = options.findOrganizationUnit;
  }

  async updateLocationDetails(id: string, input: Partial<Pick<Location, 'name' | 'shortName'>>) {
    const patch: Partial<Pick<Location, 'name' | 'shortName'>> = {};
    if (input.name !== undefined) patch.name = normalizeText(input.name, 'name', 200);
    if (input.shortName !== undefined) patch.shortName = normalizeOptionalText(input.shortName, 100);
    if (!Object.keys(patch).length) throw new LocationDirectoryError('EMPTY_DIRECTORY_UPDATE', '请填写需要更新的字段');
    return this.repository.updateLocationDetails(normalizeUuid(id, 'record id'), patch, this.clock().toISOString());
  }

  async updateLineDetails(id: string, input: Partial<Pick<Line, 'name' | 'shortName'>>) {
    const patch: Partial<Pick<Line, 'name' | 'shortName'>> = {};
    if (input.name !== undefined) patch.name = normalizeText(input.name, 'name', 100);
    if (input.shortName !== undefined) patch.shortName = normalizeOptionalText(input.shortName, 100);
    if (!Object.keys(patch).length) throw new LocationDirectoryError('EMPTY_DIRECTORY_UPDATE', '请填写需要更新的字段');
    return this.repository.updateLineDetails(normalizeUuid(id, 'record id'), patch, this.clock().toISOString());
  }

  async createLocation(input: CreateLocationInput): Promise<Location> {
    const id = normalizeUuid(input.id ?? this.createId(), 'location id');
    const parentId = input.parentId ? normalizeUuid(input.parentId, 'parent location id') : null;
    const organizationUnitId = input.organizationUnitId
      ? normalizeUuid(input.organizationUnitId, 'organization unit id')
      : null;
    const code = normalizeLocationCode(input.code);

    if (!LOCATION_TYPES.includes(input.locationType)) {
      throw new LocationDirectoryError('INVALID_LOCATION_TYPE', `无效位置类型: ${input.locationType}`);
    }
    if (parentId === id) throw new LocationDirectoryError('LOCATION_SELF_PARENT', '位置不能以自身为上级');
    if (organizationUnitId && input.locationType !== 'station') {
      throw new LocationDirectoryError('ORGANIZATION_LINK_REQUIRES_STATION', '只有物理车站可以关联车站组织节点');
    }
    if (organizationUnitId) {
      if (!this.findOrganizationUnit) {
        throw new LocationDirectoryError('ORGANIZATION_LOOKUP_REQUIRED', '关联车站组织节点需要组织目录校验器');
      }
      const organizationUnit = await this.findOrganizationUnit(organizationUnitId);
      if (!organizationUnit) throw new LocationDirectoryError('ORGANIZATION_UNIT_NOT_FOUND', '车站组织节点不存在');
      if (organizationUnit.unitType !== 'station_organization') {
        throw new LocationDirectoryError('ORGANIZATION_UNIT_IS_NOT_STATION', '物理车站只能关联车站组织节点');
      }
      if (organizationUnit.status !== 'active') {
        throw new LocationDirectoryError('ORGANIZATION_UNIT_INACTIVE', '车站组织节点未启用');
      }
    }
    if (await this.repository.findLocationByCode(code)) {
      throw new LocationDirectoryError('DUPLICATE_LOCATION_CODE', `位置编码已存在: ${code}`);
    }
    if (organizationUnitId && await this.repository.findLocationByOrganizationUnitId(organizationUnitId)) {
      throw new LocationDirectoryError('DUPLICATE_ORGANIZATION_LOCATION', '车站组织节点已关联其他物理车站');
    }
    if (parentId) {
      const parent = await this.repository.findLocationById(parentId);
      if (!parent) throw new LocationDirectoryError('LOCATION_PARENT_NOT_FOUND', '上级位置不存在');
      if (parent.status !== 'active') throw new LocationDirectoryError('LOCATION_PARENT_INACTIVE', '上级位置未启用');
    }

    const now = this.clock().toISOString();
    return this.repository.createLocation({
      id,
      parentId,
      organizationUnitId,
      code,
      name: normalizeText(input.name, 'location name', 200),
      shortName: normalizeOptionalText(input.shortName, 100),
      locationType: input.locationType,
      status: input.status ?? 'active',
      sortOrder: normalizeSortOrder(input.sortOrder),
      createdAt: now,
      updatedAt: now
    });
  }

  async createLine(input: CreateLineInput): Promise<Line> {
    const code = normalizeLineCode(input.code);
    if (await this.repository.findLineByCode(code)) {
      throw new LocationDirectoryError('DUPLICATE_LINE_CODE', `线路编码已存在: ${code}`);
    }
    const now = this.clock().toISOString();
    return this.repository.createLine({
      id: normalizeUuid(input.id ?? this.createId(), 'line id'),
      code,
      name: normalizeText(input.name, 'line name', 100),
      shortName: normalizeOptionalText(input.shortName, 100),
      status: input.status ?? 'active',
      sortOrder: normalizeSortOrder(input.sortOrder),
      createdAt: now,
      updatedAt: now
    });
  }

  async linkStationToLine(input: LinkStationToLineInput): Promise<LineStation> {
    const lineId = normalizeUuid(input.lineId, 'line id');
    const stationId = normalizeUuid(input.stationId, 'station id');
    const stationCode = normalizeLineStationCode(input.stationCode);
    const sortOrder = normalizePositiveSortOrder(input.sortOrder);
    const [line, station] = await Promise.all([
      this.repository.findLineById(lineId),
      this.repository.findLocationById(stationId)
    ]);
    if (!line) throw new LocationDirectoryError('LINE_NOT_FOUND', '线路不存在');
    if (line.status !== 'active') throw new LocationDirectoryError('LINE_INACTIVE', '线路未启用');
    if (!station) throw new LocationDirectoryError('STATION_NOT_FOUND', '物理车站不存在');
    if (station.locationType !== 'station') throw new LocationDirectoryError('LOCATION_IS_NOT_STATION', '只有物理车站可以加入线路');
    if (station.status !== 'active') throw new LocationDirectoryError('STATION_INACTIVE', '物理车站未启用');
    const [sameStation, sameCode, sameOrder] = await Promise.all([
      this.repository.findLineStation(lineId, stationId),
      this.repository.findLineStationByCode(lineId, stationCode),
      this.repository.findLineStationByOrder(lineId, sortOrder)
    ]);
    if (sameStation) throw new LocationDirectoryError('DUPLICATE_LINE_STATION', '物理车站已加入该线路');
    if (sameCode) throw new LocationDirectoryError('DUPLICATE_LINE_STATION_CODE', '线路车站编码已存在');
    if (sameOrder) throw new LocationDirectoryError('DUPLICATE_LINE_SORT_ORDER', '线路站序已存在');

    const now = this.clock().toISOString();
    return this.repository.createLineStation({
      id: normalizeUuid(input.id ?? this.createId(), 'line station id'),
      lineId,
      stationId,
      stationCode,
      sortOrder,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now
    });
  }

  async addAlias(input: AddLocationAliasInput): Promise<LocationAlias> {
    const locationId = normalizeUuid(input.locationId, 'location id');
    if (!await this.repository.findLocationById(locationId)) {
      throw new LocationDirectoryError('LOCATION_NOT_FOUND', '位置不存在');
    }
    const alias = normalizeText(input.alias, 'location alias', 200);
    if (await this.repository.findAlias(locationId, alias)) {
      throw new LocationDirectoryError('DUPLICATE_LOCATION_ALIAS', '位置别名已存在');
    }
    const now = this.clock().toISOString();
    return this.repository.createAlias({
      id: normalizeUuid(input.id ?? this.createId(), 'location alias id'),
      locationId,
      alias,
      aliasType: input.aliasType ?? 'common',
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now
    });
  }

  async linkExternalReference(input: LinkExternalLocationInput): Promise<ExternalLocationReference> {
    const locationId = normalizeUuid(input.locationId, 'location id');
    if (!await this.repository.findLocationById(locationId)) {
      throw new LocationDirectoryError('LOCATION_NOT_FOUND', '位置不存在');
    }
    const now = this.clock().toISOString();
    const status = input.status ?? 'active';
    return this.repository.createExternalReference({
      id: normalizeUuid(input.id ?? this.createId(), 'external location reference id'),
      locationId,
      provider: normalizeProvider(input.provider),
      tenantKey: normalizeProvider(input.tenantKey ?? 'default'),
      externalLocationId: normalizeText(input.externalLocationId, 'external location id', 255),
      status,
      verifiedAt: input.verifiedAt?.toISOString() ?? (status === 'active' ? now : null),
      createdAt: now,
      updatedAt: now
    });
  }

  async getLocationTree(): Promise<LocationTreeNode[]> {
    return buildLocationTree(await this.repository.listLocations());
  }

  async listLines() {
    return this.repository.listLines();
  }

  async listLineStations(lineId: string) {
    return this.repository.listLineStationsByLine(normalizeUuid(lineId, 'line id'));
  }

  async getLocationProfile(id: string) {
    return this.repository.getLocationProfile(normalizeUuid(id, 'location id'));
  }

  async searchLocations(input: SearchLocationsInput = {}): Promise<LocationDirectoryProfile[]> {
    return this.repository.searchLocations({
      query: input.query?.trim() || undefined,
      locationType: input.locationType,
      lineId: input.lineId ? normalizeUuid(input.lineId, 'line id') : undefined,
      status: input.status,
      limit: normalizeSearchLimit(input.limit)
    });
  }

  async resolveExternalReference(provider: string, externalLocationId: string, tenantKey = 'default') {
    return this.repository.findLocationByExternalReference(
      normalizeProvider(provider),
      normalizeProvider(tenantKey),
      normalizeText(externalLocationId, 'external location id', 255)
    );
  }
}

export function createLocationDirectoryService(
  repository: LocationDirectoryRepository,
  options: LocationDirectoryServiceOptions = {}
) {
  return new LocationDirectoryService(repository, options);
}

export function buildLocationTree(locations: readonly Location[]): LocationTreeNode[] {
  const nodes = new Map(locations.map((location) => [location.id, { ...structuredClone(location), children: [] as LocationTreeNode[] }]));
  if (nodes.size !== locations.length) throw new LocationDirectoryError('DUPLICATE_LOCATION_ID', '位置树包含重复 ID');
  const roots: LocationTreeNode[] = [];

  for (const location of locations) {
    const node = nodes.get(location.id)!;
    if (!location.parentId) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(location.parentId);
    if (!parent) throw new LocationDirectoryError('ORPHAN_LOCATION', `位置节点缺少上级: ${location.id}`);
    parent.children.push(node);
  }

  const sortNodes = (items: LocationTreeNode[]) => {
    items.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id));
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  const visited = new Set<string>();
  const visit = (items: readonly LocationTreeNode[]) => {
    for (const item of items) {
      if (visited.has(item.id)) throw new LocationDirectoryError('CYCLIC_LOCATION', '位置树存在循环关系');
      visited.add(item.id);
      visit(item.children);
    }
  };
  visit(roots);
  if (visited.size !== locations.length) {
    throw new LocationDirectoryError('CYCLIC_LOCATION', '位置树存在无法连接到根节点的循环关系');
  }
  return roots;
}

export function reconcileLegacyStations(snapshot: LegacyStationSnapshot): LegacyLocationReconciliation {
  const lineNames = new Set<string>();
  const lineCodes = new Set<string>();
  const lineOrders = new Set<string>();
  const issues: LegacyLocationIssue[] = [];
  let lineStationCount = 0;
  let aliasCount = 0;
  let responsibilitySourceCount = 0;

  for (const station of snapshot.stations) {
    const line = station.line?.trim();
    const code = station.code?.trim().toUpperCase();
    const sortOrder = station.sortOrder;
    if (!line) {
      issues.push({ code: 'MISSING_LINE', stationId: station.id });
    } else {
      lineNames.add(line);
    }
    if (!code) {
      issues.push({ code: 'MISSING_STATION_CODE', stationId: station.id });
    }
    if (!Number.isSafeInteger(sortOrder) || Number(sortOrder) < 1) {
      issues.push({ code: 'MISSING_SORT_ORDER', stationId: station.id });
    }
    if (line && code) {
      const key = `${line}::${code}`;
      if (lineCodes.has(key)) issues.push({ code: 'DUPLICATE_LINE_STATION_CODE', stationId: station.id, value: key });
      lineCodes.add(key);
    }
    if (line && Number.isSafeInteger(sortOrder) && Number(sortOrder) > 0) {
      const key = `${line}::${sortOrder}`;
      if (lineOrders.has(key)) issues.push({ code: 'DUPLICATE_LINE_SORT_ORDER', stationId: station.id, value: key });
      lineOrders.add(key);
    }
    if (line && code && Number.isSafeInteger(sortOrder) && Number(sortOrder) > 0) lineStationCount += 1;
    aliasCount += splitLegacyAliases(station.alias).length;
    if (station.workgroupId) responsibilitySourceCount += 1;
  }

  return {
    stationCount: new Set(snapshot.stations.map((station) => station.id)).size,
    lineCount: lineNames.size,
    lineStationCount,
    aliasCount,
    preservedStationIds: [...new Set(snapshot.stations.map((station) => station.id))],
    responsibilitySourceCount,
    issues
  };
}

export function legacyStationLocationCode(stationId: string) {
  return `station:${normalizeUuid(stationId, 'station id')}`;
}

export function splitLegacyAliases(value: string | null | undefined) {
  return [...new Set((value ?? '').split(/[,，、]/).map((alias) => alias.trim()).filter(Boolean))];
}

function normalizeText(value: string, label: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized) throw new LocationDirectoryError('MISSING_DIRECTORY_VALUE', `${label} 不能为空`);
  if (normalized.length > maxLength) throw new LocationDirectoryError('DIRECTORY_VALUE_TOO_LONG', `${label} 超过长度限制`);
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined, maxLength: number): string | null {
  if (value == null || !value.trim()) return null;
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new LocationDirectoryError('DIRECTORY_VALUE_TOO_LONG', '目录字段超过长度限制');
  return normalized;
}

function normalizeLocationCode(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(normalized)) {
    throw new LocationDirectoryError('INVALID_LOCATION_CODE', '位置编码必须是稳定 ASCII 编码');
  }
  return normalized;
}

function normalizeLineCode(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]{0,49}$/.test(normalized)) {
    throw new LocationDirectoryError('INVALID_LINE_CODE', '线路编码必须是稳定 ASCII 编码');
  }
  return normalized;
}

function normalizeLineStationCode(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]{0,49}$/.test(normalized)) {
    throw new LocationDirectoryError('INVALID_LINE_STATION_CODE', '线路车站编码必须是稳定 ASCII 编码');
  }
  return normalized;
}

function normalizeProvider(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(normalized)) {
    throw new LocationDirectoryError('INVALID_EXTERNAL_PROVIDER', '外部位置来源必须是稳定 ASCII 编码');
  }
  return normalized;
}

function normalizeUuid(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new LocationDirectoryError('INVALID_DIRECTORY_ID', `${label} 必须是 UUID`);
  }
  return normalized;
}

function normalizeSortOrder(value: number | undefined) {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized)) throw new LocationDirectoryError('INVALID_SORT_ORDER', '位置排序必须是整数');
  return normalized;
}

function normalizePositiveSortOrder(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new LocationDirectoryError('INVALID_LINE_SORT_ORDER', '线路站序必须是正整数');
  return value;
}

function normalizeSearchLimit(value: number | undefined) {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new LocationDirectoryError('INVALID_SEARCH_LIMIT', '位置查询数量必须在 1 到 100 之间');
  }
  return value;
}
