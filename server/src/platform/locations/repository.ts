import type { QueryableClient } from '../../core/database/index.js';
import {
  LocationDirectoryError,
  type ExternalLocationReference,
  type Line,
  type LineStation,
  type Location,
  type LocationAlias,
  type LocationDirectoryProfile,
  type SearchLocationsInput,
  type StationLineMembership
} from './model.js';

export interface LocationDirectoryRepository {
  updateLocationDetails(id: string, patch: Partial<Pick<Location, 'name' | 'shortName'>>, updatedAt: string): Promise<Location>;
  updateLineDetails(id: string, patch: Partial<Pick<Line, 'name' | 'shortName'>>, updatedAt: string): Promise<Line>;
  createLocation(record: Location): Promise<Location>;
  findLocationById(id: string): Promise<Location | null>;
  findLocationByCode(code: string): Promise<Location | null>;
  findLocationByOrganizationUnitId(organizationUnitId: string): Promise<Location | null>;
  listLocations(): Promise<Location[]>;
  createLine(record: Line): Promise<Line>;
  findLineById(id: string): Promise<Line | null>;
  findLineByCode(code: string): Promise<Line | null>;
  listLines(): Promise<Line[]>;
  createLineStation(record: LineStation): Promise<LineStation>;
  findLineStation(lineId: string, stationId: string): Promise<LineStation | null>;
  findLineStationByCode(lineId: string, stationCode: string): Promise<LineStation | null>;
  findLineStationByOrder(lineId: string, sortOrder: number): Promise<LineStation | null>;
  listLineStationsByLine(lineId: string): Promise<LineStation[]>;
  listLineStationsByStation(stationId: string): Promise<StationLineMembership[]>;
  createAlias(record: LocationAlias): Promise<LocationAlias>;
  findAlias(locationId: string, alias: string): Promise<LocationAlias | null>;
  listAliases(locationId: string): Promise<LocationAlias[]>;
  createExternalReference(record: ExternalLocationReference): Promise<ExternalLocationReference>;
  findLocationByExternalReference(provider: string, tenantKey: string, externalLocationId: string): Promise<LocationDirectoryProfile | null>;
  getLocationProfile(id: string): Promise<LocationDirectoryProfile | null>;
  listLocationProfiles(input: Omit<SearchLocationsInput, 'query' | 'limit'>): Promise<LocationDirectoryProfile[]>;
  searchLocations(input: SearchLocationsInput): Promise<LocationDirectoryProfile[]>;
}

export interface MemoryLocationDirectoryRepository extends LocationDirectoryRepository {
  records(): {
    locations: Location[];
    lines: Line[];
    lineStations: LineStation[];
    aliases: LocationAlias[];
    externalReferences: ExternalLocationReference[];
  };
}

export function createMemoryLocationDirectoryRepository(seed: {
  locations?: readonly Location[];
  lines?: readonly Line[];
  lineStations?: readonly LineStation[];
  aliases?: readonly LocationAlias[];
  externalReferences?: readonly ExternalLocationReference[];
} = {}): MemoryLocationDirectoryRepository {
  const locations = toMap(seed.locations);
  const lines = toMap(seed.lines);
  const lineStations = toMap(seed.lineStations);
  const aliases = toMap(seed.aliases);
  const externalReferences = toMap(seed.externalReferences);

  return {
    async updateLocationDetails(id, patch, updatedAt) {
      const record = locations.get(id);
      if (!record) throw new LocationDirectoryError('DIRECTORY_RECORD_NOT_FOUND', '目录记录不存在');
      const updated = { ...record, ...patch, updatedAt };
      locations.set(id, clone(updated));
      return clone(updated);
    },
    async updateLineDetails(id, patch, updatedAt) {
      const record = lines.get(id);
      if (!record) throw new LocationDirectoryError('DIRECTORY_RECORD_NOT_FOUND', '目录记录不存在');
      const updated = { ...record, ...patch, updatedAt };
      lines.set(id, clone(updated));
      return clone(updated);
    },
    async createLocation(record) {
      assertUniqueId(locations, record.id, 'DUPLICATE_LOCATION_ID');
      assertUnique(locations.values(), (item) => item.code === record.code, 'DUPLICATE_LOCATION_CODE');
      if (record.organizationUnitId) {
        assertUnique(locations.values(), (item) => item.organizationUnitId === record.organizationUnitId, 'DUPLICATE_ORGANIZATION_LOCATION');
      }
      locations.set(record.id, clone(record));
      return clone(record);
    },
    async findLocationById(id) {
      return cloneOrNull(locations.get(id));
    },
    async findLocationByCode(code) {
      return cloneOrNull([...locations.values()].find((item) => item.code === code));
    },
    async findLocationByOrganizationUnitId(organizationUnitId) {
      return cloneOrNull([...locations.values()].find((item) => item.organizationUnitId === organizationUnitId));
    },
    async listLocations() {
      return [...locations.values()].map(clone).sort(compareLocations);
    },
    async createLine(record) {
      assertUniqueId(lines, record.id, 'DUPLICATE_LINE_ID');
      assertUnique(lines.values(), (item) => item.code === record.code, 'DUPLICATE_LINE_CODE');
      lines.set(record.id, clone(record));
      return clone(record);
    },
    async findLineById(id) {
      return cloneOrNull(lines.get(id));
    },
    async findLineByCode(code) {
      return cloneOrNull([...lines.values()].find((item) => item.code === code));
    },
    async listLines() {
      return [...lines.values()].map(clone).sort(compareLines);
    },
    async createLineStation(record) {
      assertUniqueId(lineStations, record.id, 'DUPLICATE_LINE_STATION_ID');
      assertUnique(lineStations.values(), (item) => item.lineId === record.lineId && item.stationId === record.stationId, 'DUPLICATE_LINE_STATION');
      assertUnique(lineStations.values(), (item) => item.lineId === record.lineId && item.stationCode === record.stationCode, 'DUPLICATE_LINE_STATION_CODE');
      assertUnique(lineStations.values(), (item) => item.lineId === record.lineId && item.sortOrder === record.sortOrder, 'DUPLICATE_LINE_SORT_ORDER');
      lineStations.set(record.id, clone(record));
      return clone(record);
    },
    async findLineStation(lineId, stationId) {
      return cloneOrNull([...lineStations.values()].find((item) => item.lineId === lineId && item.stationId === stationId));
    },
    async findLineStationByCode(lineId, stationCode) {
      return cloneOrNull([...lineStations.values()].find((item) => item.lineId === lineId && item.stationCode === stationCode));
    },
    async findLineStationByOrder(lineId, sortOrder) {
      return cloneOrNull([...lineStations.values()].find((item) => item.lineId === lineId && item.sortOrder === sortOrder));
    },
    async listLineStationsByLine(lineId) {
      return [...lineStations.values()]
        .filter((item) => item.lineId === lineId)
        .map(clone)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.stationCode.localeCompare(right.stationCode));
    },
    async listLineStationsByStation(stationId) {
      return [...lineStations.values()]
        .filter((item) => item.stationId === stationId)
        .map((lineStation) => {
          const line = lines.get(lineStation.lineId);
          if (!line) throw new LocationDirectoryError('BROKEN_LINE_REFERENCE', `线路车站缺少线路: ${lineStation.id}`);
          return { line: clone(line), lineStation: clone(lineStation) };
        })
        .sort(compareMemberships);
    },
    async createAlias(record) {
      assertUniqueId(aliases, record.id, 'DUPLICATE_ALIAS_ID');
      const normalized = record.alias.toLocaleLowerCase('zh-CN');
      assertUnique(aliases.values(), (item) => item.locationId === record.locationId && item.alias.toLocaleLowerCase('zh-CN') === normalized, 'DUPLICATE_LOCATION_ALIAS');
      aliases.set(record.id, clone(record));
      return clone(record);
    },
    async findAlias(locationId, alias) {
      const normalized = alias.toLocaleLowerCase('zh-CN');
      return cloneOrNull([...aliases.values()].find((item) => item.locationId === locationId && item.alias.toLocaleLowerCase('zh-CN') === normalized));
    },
    async listAliases(locationId) {
      return [...aliases.values()].filter((item) => item.locationId === locationId).map(clone).sort((left, right) => left.alias.localeCompare(right.alias, 'zh-CN'));
    },
    async createExternalReference(record) {
      assertUniqueId(externalReferences, record.id, 'DUPLICATE_EXTERNAL_LOCATION_ID');
      assertUnique(externalReferences.values(), (item) =>
        item.provider === record.provider
        && item.tenantKey === record.tenantKey
        && (item.externalLocationId === record.externalLocationId || item.locationId === record.locationId),
      'DUPLICATE_EXTERNAL_LOCATION_REFERENCE');
      externalReferences.set(record.id, clone(record));
      return clone(record);
    },
    async findLocationByExternalReference(provider, tenantKey, externalLocationId) {
      const reference = [...externalReferences.values()].find((item) =>
        item.provider === provider
        && item.tenantKey === tenantKey
        && item.externalLocationId === externalLocationId
        && item.status === 'active'
        && item.verifiedAt !== null
      );
      if (!reference || locations.get(reference.locationId)?.status !== 'active') return null;
      return createMemoryProfile(reference.locationId, locations, lines, lineStations, aliases);
    },
    async getLocationProfile(id) {
      return locations.has(id) ? createMemoryProfile(id, locations, lines, lineStations, aliases) : null;
    },
    async listLocationProfiles(input) {
      const lineStationIds = input.lineId
        ? new Set([...lineStations.values()].filter((item) => item.lineId === input.lineId && item.status === 'active').map((item) => item.stationId))
        : null;
      return [...locations.values()]
        .filter((location) => (!input.locationType || location.locationType === input.locationType)
          && (!input.status || location.status === input.status)
          && (!lineStationIds || lineStationIds.has(location.id)))
        .sort(compareLocations)
        .map((location) => createMemoryProfile(location.id, locations, lines, lineStations, aliases));
    },
    async searchLocations(input) {
      const query = input.query?.trim().toLocaleLowerCase('zh-CN');
      const lineStationIds = input.lineId
        ? new Set([...lineStations.values()].filter((item) => item.lineId === input.lineId && item.status === 'active').map((item) => item.stationId))
        : null;
      return [...locations.values()]
        .filter((location) => {
          if (input.locationType && location.locationType !== input.locationType) return false;
          if (input.status && location.status !== input.status) return false;
          if (lineStationIds && !lineStationIds.has(location.id)) return false;
          if (!query) return true;
          const locationAliases = [...aliases.values()].filter((alias) => alias.locationId === location.id && alias.status === 'active');
          return [location.name, location.shortName ?? '', location.code, ...locationAliases.map((alias) => alias.alias)]
            .some((value) => value.toLocaleLowerCase('zh-CN').includes(query));
        })
        .sort(compareLocations)
        .slice(0, normalizeLimit(input.limit))
        .map((location) => createMemoryProfile(location.id, locations, lines, lineStations, aliases));
    },
    records() {
      return {
        locations: [...locations.values()].map(clone),
        lines: [...lines.values()].map(clone),
        lineStations: [...lineStations.values()].map(clone),
        aliases: [...aliases.values()].map(clone),
        externalReferences: [...externalReferences.values()].map(clone)
      };
    }
  };
}

export function createPostgresLocationDirectoryRepository(client: QueryableClient): LocationDirectoryRepository {
  return {
    async updateLocationDetails(id, patch, updatedAt) {
      return mapLocation(requireRow(await client.query(
        'UPDATE platform_locations SET name=CASE WHEN $2 THEN $3 ELSE name END, short_name=CASE WHEN $4 THEN $5 ELSE short_name END, updated_at=$6 WHERE id=$1 RETURNING *',
        [id, Object.hasOwn(patch, 'name'), patch.name ?? null, Object.hasOwn(patch, 'shortName'), patch.shortName ?? null, updatedAt]
      ), 'DIRECTORY_RECORD_NOT_FOUND'));
    },
    async updateLineDetails(id, patch, updatedAt) {
      return mapLine(requireRow(await client.query(
        'UPDATE platform_lines SET name=CASE WHEN $2 THEN $3 ELSE name END, short_name=CASE WHEN $4 THEN $5 ELSE short_name END, updated_at=$6 WHERE id=$1 RETURNING *',
        [id, Object.hasOwn(patch, 'name'), patch.name ?? null, Object.hasOwn(patch, 'shortName'), patch.shortName ?? null, updatedAt]
      ), 'DIRECTORY_RECORD_NOT_FOUND'));
    },
    async createLocation(record) {
      const result = await client.query(
        `INSERT INTO platform_locations
          (id, parent_id, organization_unit_id, code, name, short_name, location_type, status, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [record.id, record.parentId, record.organizationUnitId, record.code, record.name, record.shortName, record.locationType, record.status, record.sortOrder, record.createdAt, record.updatedAt]
      );
      return mapLocation(requireRow(result, 'LOCATION_INSERT_FAILED'));
    },
    async findLocationById(id) {
      return optionalRow(await client.query('SELECT * FROM platform_locations WHERE id = $1', [id]), mapLocation);
    },
    async findLocationByCode(code) {
      return optionalRow(await client.query('SELECT * FROM platform_locations WHERE code = $1', [code]), mapLocation);
    },
    async findLocationByOrganizationUnitId(organizationUnitId) {
      return optionalRow(await client.query('SELECT * FROM platform_locations WHERE organization_unit_id = $1', [organizationUnitId]), mapLocation);
    },
    async listLocations() {
      return resultRows(await client.query('SELECT * FROM platform_locations ORDER BY parent_id NULLS FIRST, sort_order, name, id')).map(mapLocation);
    },
    async createLine(record) {
      const result = await client.query(
        `INSERT INTO platform_lines (id, code, name, short_name, status, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [record.id, record.code, record.name, record.shortName, record.status, record.sortOrder, record.createdAt, record.updatedAt]
      );
      return mapLine(requireRow(result, 'LINE_INSERT_FAILED'));
    },
    async findLineById(id) {
      return optionalRow(await client.query('SELECT * FROM platform_lines WHERE id = $1', [id]), mapLine);
    },
    async findLineByCode(code) {
      return optionalRow(await client.query('SELECT * FROM platform_lines WHERE code = $1', [code]), mapLine);
    },
    async listLines() {
      return resultRows(await client.query('SELECT * FROM platform_lines ORDER BY sort_order, name, id')).map(mapLine);
    },
    async createLineStation(record) {
      const result = await client.query(
        `INSERT INTO platform_line_stations
          (id, line_id, station_id, station_code, sort_order, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [record.id, record.lineId, record.stationId, record.stationCode, record.sortOrder, record.status, record.createdAt, record.updatedAt]
      );
      return mapLineStation(requireRow(result, 'LINE_STATION_INSERT_FAILED'));
    },
    async findLineStation(lineId, stationId) {
      return optionalRow(await client.query('SELECT * FROM platform_line_stations WHERE line_id = $1 AND station_id = $2', [lineId, stationId]), mapLineStation);
    },
    async findLineStationByCode(lineId, stationCode) {
      return optionalRow(await client.query('SELECT * FROM platform_line_stations WHERE line_id = $1 AND station_code = $2', [lineId, stationCode]), mapLineStation);
    },
    async findLineStationByOrder(lineId, sortOrder) {
      return optionalRow(await client.query('SELECT * FROM platform_line_stations WHERE line_id = $1 AND sort_order = $2', [lineId, sortOrder]), mapLineStation);
    },
    async listLineStationsByLine(lineId) {
      return resultRows(await client.query('SELECT * FROM platform_line_stations WHERE line_id = $1 ORDER BY sort_order, station_code', [lineId])).map(mapLineStation);
    },
    async listLineStationsByStation(stationId) {
      const result = await client.query(
        `SELECT
           line.id AS line_record_id, line.code AS line_code, line.name AS line_name,
           line.short_name AS line_short_name, line.status AS line_status, line.sort_order AS line_sort_order,
           line.created_at AS line_created_at, line.updated_at AS line_updated_at,
           relation.id AS relation_id, relation.line_id, relation.station_id, relation.station_code,
           relation.sort_order AS relation_sort_order, relation.status AS relation_status,
           relation.created_at AS relation_created_at, relation.updated_at AS relation_updated_at
         FROM platform_line_stations relation
         JOIN platform_lines line ON line.id = relation.line_id
         WHERE relation.station_id = $1
         ORDER BY line.sort_order, line.name`,
        [stationId]
      );
      return resultRows(result).map(mapStationLineMembership);
    },
    async createAlias(record) {
      const result = await client.query(
        `INSERT INTO platform_location_aliases
          (id, location_id, alias, alias_type, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [record.id, record.locationId, record.alias, record.aliasType, record.status, record.createdAt, record.updatedAt]
      );
      return mapAlias(requireRow(result, 'LOCATION_ALIAS_INSERT_FAILED'));
    },
    async findAlias(locationId, alias) {
      return optionalRow(await client.query('SELECT * FROM platform_location_aliases WHERE location_id = $1 AND lower(alias) = lower($2)', [locationId, alias]), mapAlias);
    },
    async listAliases(locationId) {
      return resultRows(await client.query('SELECT * FROM platform_location_aliases WHERE location_id = $1 ORDER BY alias', [locationId])).map(mapAlias);
    },
    async createExternalReference(record) {
      const result = await client.query(
        `INSERT INTO platform_external_location_references
          (id, location_id, provider, tenant_key, external_location_id, status, verified_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [record.id, record.locationId, record.provider, record.tenantKey, record.externalLocationId, record.status, record.verifiedAt, record.createdAt, record.updatedAt]
      );
      return mapExternalReference(requireRow(result, 'EXTERNAL_LOCATION_INSERT_FAILED'));
    },
    async findLocationByExternalReference(provider, tenantKey, externalLocationId) {
      const result = await client.query(
        `SELECT location.* FROM platform_locations location
         JOIN platform_external_location_references reference ON reference.location_id = location.id
         WHERE reference.provider = $1 AND reference.tenant_key = $2 AND reference.external_location_id = $3
           AND reference.status = 'active' AND reference.verified_at IS NOT NULL AND location.status = 'active'`,
        [provider, tenantKey, externalLocationId]
      );
      const location = optionalRow(result, mapLocation);
      return location ? loadProfile(client, location) : null;
    },
    async getLocationProfile(id) {
      const location = optionalRow(await client.query('SELECT * FROM platform_locations WHERE id = $1', [id]), mapLocation);
      return location ? loadProfile(client, location) : null;
    },
    async listLocationProfiles(input) {
      const result = await client.query(
        `SELECT location.*
         FROM platform_locations location
         WHERE ($1::text IS NULL OR location.location_type = $1)
           AND ($2::text IS NULL OR location.status = $2)
           AND ($3::uuid IS NULL OR EXISTS (
             SELECT 1 FROM platform_line_stations relation
             WHERE relation.station_id = location.id AND relation.line_id = $3 AND relation.status = 'active'
           ))
         ORDER BY location.sort_order, location.name, location.id`,
        [input.locationType ?? null, input.status ?? null, input.lineId ?? null]
      );
      return loadProfiles(client, resultRows(result).map(mapLocation));
    },
    async searchLocations(input) {
      const result = await client.query(
        `SELECT DISTINCT location.*
         FROM platform_locations location
         LEFT JOIN platform_location_aliases alias ON alias.location_id = location.id AND alias.status = 'active'
         WHERE ($1::text IS NULL OR location.name ILIKE '%' || $1 || '%' OR location.short_name ILIKE '%' || $1 || '%'
           OR location.code ILIKE '%' || $1 || '%' OR alias.alias ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR location.location_type = $2)
           AND ($3::text IS NULL OR location.status = $3)
           AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM platform_line_stations relation
             WHERE relation.station_id = location.id AND relation.line_id = $4 AND relation.status = 'active'
           ))
         ORDER BY location.sort_order, location.name, location.id
         LIMIT $5`,
        [input.query?.trim() || null, input.locationType ?? null, input.status ?? null, input.lineId ?? null, normalizeLimit(input.limit)]
      );
      return loadProfiles(client, resultRows(result).map(mapLocation));
    }
  };
}

async function loadProfile(client: QueryableClient, location: Location): Promise<LocationDirectoryProfile> {
  return (await loadProfiles(client, [location]))[0];
}

async function loadProfiles(client: QueryableClient, locations: readonly Location[]): Promise<LocationDirectoryProfile[]> {
  if (locations.length === 0) return [];
  const ids = locations.map((location) => location.id);
  const [aliasResult, membershipResult] = await Promise.all([
    client.query("SELECT * FROM platform_location_aliases WHERE location_id = ANY($1::uuid[]) AND status = 'active' ORDER BY alias", [ids]),
    client.query(
      `SELECT
         line.id AS line_record_id, line.code AS line_code, line.name AS line_name,
         line.short_name AS line_short_name, line.status AS line_status, line.sort_order AS line_sort_order,
         line.created_at AS line_created_at, line.updated_at AS line_updated_at,
         relation.id AS relation_id, relation.line_id, relation.station_id, relation.station_code,
         relation.sort_order AS relation_sort_order, relation.status AS relation_status,
         relation.created_at AS relation_created_at, relation.updated_at AS relation_updated_at
       FROM platform_line_stations relation
       JOIN platform_lines line ON line.id = relation.line_id
       WHERE relation.station_id = ANY($1::uuid[]) AND relation.status = 'active' AND line.status = 'active'
       ORDER BY line.sort_order, line.name`,
      [ids]
    )
  ]);
  const aliasesByLocation = groupBy(resultRows(aliasResult).map(mapAlias), (alias) => alias.locationId);
  const membershipsByStation = groupBy(resultRows(membershipResult).map(mapStationLineMembership), (membership) => membership.lineStation.stationId);
  return locations.map((location) => {
    const stationLines = membershipsByStation.get(location.id) ?? [];
    return {
      location,
      aliases: aliasesByLocation.get(location.id) ?? [],
      stationLines,
      isInterchange: stationLines.length > 1
    };
  });
}

function createMemoryProfile(
  locationId: string,
  locations: Map<string, Location>,
  lines: Map<string, Line>,
  lineStations: Map<string, LineStation>,
  aliases: Map<string, LocationAlias>
): LocationDirectoryProfile {
  const location = locations.get(locationId);
  if (!location) throw new LocationDirectoryError('LOCATION_NOT_FOUND', `位置不存在: ${locationId}`);
  const stationLines = [...lineStations.values()]
    .filter((relation) => relation.stationId === locationId && relation.status === 'active')
    .map((lineStation) => {
      const line = lines.get(lineStation.lineId);
      if (!line) throw new LocationDirectoryError('BROKEN_LINE_REFERENCE', `线路不存在: ${lineStation.lineId}`);
      if (line.status !== 'active') return null;
      return { line: clone(line), lineStation: clone(lineStation) };
    })
    .filter((membership): membership is StationLineMembership => membership !== null)
    .sort(compareMemberships);
  return {
    location: clone(location),
    aliases: [...aliases.values()].filter((alias) => alias.locationId === locationId && alias.status === 'active').map(clone).sort((a, b) => a.alias.localeCompare(b.alias, 'zh-CN')),
    stationLines,
    isInterchange: stationLines.length > 1
  };
}

function mapLocation(row: unknown): Location {
  const value = asRecord(row);
  return {
    id: requiredString(value.id),
    parentId: optionalString(value.parent_id),
    organizationUnitId: optionalString(value.organization_unit_id),
    code: requiredString(value.code),
    name: requiredString(value.name),
    shortName: optionalString(value.short_name),
    locationType: requiredString(value.location_type) as Location['locationType'],
    status: requiredString(value.status) as Location['status'],
    sortOrder: Number(value.sort_order ?? 0),
    createdAt: toIsoString(value.created_at),
    updatedAt: toIsoString(value.updated_at)
  };
}

function mapLine(row: unknown): Line {
  const value = asRecord(row);
  return {
    id: requiredString(value.id),
    code: requiredString(value.code),
    name: requiredString(value.name),
    shortName: optionalString(value.short_name),
    status: requiredString(value.status) as Line['status'],
    sortOrder: Number(value.sort_order ?? 0),
    createdAt: toIsoString(value.created_at),
    updatedAt: toIsoString(value.updated_at)
  };
}

function mapLineStation(row: unknown): LineStation {
  const value = asRecord(row);
  return {
    id: requiredString(value.id),
    lineId: requiredString(value.line_id),
    stationId: requiredString(value.station_id),
    stationCode: requiredString(value.station_code),
    sortOrder: Number(value.sort_order),
    status: requiredString(value.status) as LineStation['status'],
    createdAt: toIsoString(value.created_at),
    updatedAt: toIsoString(value.updated_at)
  };
}

function mapAlias(row: unknown): LocationAlias {
  const value = asRecord(row);
  return {
    id: requiredString(value.id),
    locationId: requiredString(value.location_id),
    alias: requiredString(value.alias),
    aliasType: requiredString(value.alias_type) as LocationAlias['aliasType'],
    status: requiredString(value.status) as LocationAlias['status'],
    createdAt: toIsoString(value.created_at),
    updatedAt: toIsoString(value.updated_at)
  };
}

function mapExternalReference(row: unknown): ExternalLocationReference {
  const value = asRecord(row);
  return {
    id: requiredString(value.id),
    locationId: requiredString(value.location_id),
    provider: requiredString(value.provider),
    tenantKey: requiredString(value.tenant_key),
    externalLocationId: requiredString(value.external_location_id),
    status: requiredString(value.status) as ExternalLocationReference['status'],
    verifiedAt: value.verified_at == null ? null : toIsoString(value.verified_at),
    createdAt: toIsoString(value.created_at),
    updatedAt: toIsoString(value.updated_at)
  };
}

function mapStationLineMembership(row: unknown): StationLineMembership {
  const value = asRecord(row);
  return {
    line: {
      id: requiredString(value.line_record_id),
      code: requiredString(value.line_code),
      name: requiredString(value.line_name),
      shortName: optionalString(value.line_short_name),
      status: requiredString(value.line_status) as Line['status'],
      sortOrder: Number(value.line_sort_order ?? 0),
      createdAt: toIsoString(value.line_created_at),
      updatedAt: toIsoString(value.line_updated_at)
    },
    lineStation: {
      id: requiredString(value.relation_id),
      lineId: requiredString(value.line_id),
      stationId: requiredString(value.station_id),
      stationCode: requiredString(value.station_code),
      sortOrder: Number(value.relation_sort_order),
      status: requiredString(value.relation_status) as LineStation['status'],
      createdAt: toIsoString(value.relation_created_at),
      updatedAt: toIsoString(value.relation_updated_at)
    }
  };
}

function toMap<T extends { id: string }>(values: readonly T[] | undefined) {
  return new Map((values ?? []).map((value) => [value.id, clone(value)]));
}

function compareLocations(left: Location, right: Location) {
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id);
}

function compareLines(left: Line, right: Line) {
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id);
}

function compareMemberships(left: StationLineMembership, right: StationLineMembership) {
  return compareLines(left.line, right.line) || left.lineStation.sortOrder - right.lineStation.sortOrder;
}

function normalizeLimit(limit: number | undefined) {
  return Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit! : 50));
}

function assertUniqueId<T>(records: Map<string, T>, id: string, code: string) {
  if (records.has(id)) throw new LocationDirectoryError(code, `目录 ID 已存在: ${id}`);
}

function assertUnique<T>(records: Iterable<T>, predicate: (record: T) => boolean, code: string) {
  if ([...records].some(predicate)) throw new LocationDirectoryError(code, '目录唯一值已存在');
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
  if (!row) throw new LocationDirectoryError(code, '目录写入未返回记录');
  return row;
}

function optionalRow<T>(result: unknown, mapper: (row: unknown) => T): T | null {
  const row = resultRows(result)[0];
  return row ? mapper(row) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new LocationDirectoryError('INVALID_DATABASE_ROW', '位置目录数据库返回格式无效');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown) {
  if (typeof value !== 'string' || !value) throw new LocationDirectoryError('INVALID_DATABASE_ROW', '位置目录数据库字段缺失');
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function toIsoString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new LocationDirectoryError('INVALID_DATABASE_ROW', '位置目录数据库时间字段无效');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}
