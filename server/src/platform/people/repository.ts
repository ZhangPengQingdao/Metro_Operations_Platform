import type { QueryableClient } from '../../core/database/index.js';
import {
  PeopleDirectoryError,
  type ExternalIdentity,
  type OrganizationUnit,
  type Person,
  type PersonDirectoryProfile,
  type Position,
  type SearchPeopleInput
} from './model.js';

export interface PeopleDirectoryRepository {
  updateOrganizationUnitDetails(id: string, patch: Partial<Pick<OrganizationUnit, 'name' | 'shortName'>>, updatedAt: string): Promise<OrganizationUnit>;
  updatePositionDetails(id: string, patch: Partial<Pick<Position, 'name' | 'description'>>, updatedAt: string): Promise<Position>;
  updatePersonDetails(id: string, patch: Partial<Pick<Person, 'name' | 'phone'>>, updatedAt: string): Promise<Person>;
  createOrganizationUnit(record: OrganizationUnit): Promise<OrganizationUnit>;
  findOrganizationUnitById(id: string): Promise<OrganizationUnit | null>;
  findOrganizationUnitByCode(code: string): Promise<OrganizationUnit | null>;
  listOrganizationUnits(): Promise<OrganizationUnit[]>;
  createPosition(record: Position): Promise<Position>;
  findPositionById(id: string): Promise<Position | null>;
  findPositionByCode(code: string): Promise<Position | null>;
  listPositions(): Promise<Position[]>;
  createPerson(record: Person): Promise<Person>;
  findPersonById(id: string): Promise<Person | null>;
  findPersonByEmployeeNo(employeeNo: string): Promise<Person | null>;
  getPersonProfile(id: string): Promise<PersonDirectoryProfile | null>;
  listPersonProfiles(input: Omit<SearchPeopleInput, 'query' | 'limit'>): Promise<PersonDirectoryProfile[]>;
  searchPeople(input: SearchPeopleInput): Promise<PersonDirectoryProfile[]>;
  linkExternalIdentity(record: ExternalIdentity): Promise<ExternalIdentity>;
  findPersonByExternalIdentity(provider: string, tenantKey: string, externalUserId: string): Promise<PersonDirectoryProfile | null>;
}

export interface MemoryPeopleDirectoryRepository extends PeopleDirectoryRepository {
  records(): {
    organizationUnits: OrganizationUnit[];
    positions: Position[];
    people: Person[];
    externalIdentities: ExternalIdentity[];
  };
}

export function createMemoryPeopleDirectoryRepository(seed: {
  organizationUnits?: readonly OrganizationUnit[];
  positions?: readonly Position[];
  people?: readonly Person[];
  externalIdentities?: readonly ExternalIdentity[];
} = {}): MemoryPeopleDirectoryRepository {
  const organizationUnits = new Map((seed.organizationUnits ?? []).map((record) => [record.id, clone(record)]));
  const positions = new Map((seed.positions ?? []).map((record) => [record.id, clone(record)]));
  const people = new Map((seed.people ?? []).map((record) => [record.id, clone(record)]));
  const externalIdentities = new Map((seed.externalIdentities ?? []).map((record) => [record.id, clone(record)]));

  return {
    async updateOrganizationUnitDetails(id, patch, updatedAt) {
      const record = organizationUnits.get(id);
      if (!record) throw new PeopleDirectoryError('DIRECTORY_RECORD_NOT_FOUND', '目录记录不存在');
      const updated = { ...record, ...patch, updatedAt };
      organizationUnits.set(id, clone(updated));
      return clone(updated);
    },
    async updatePositionDetails(id, patch, updatedAt) {
      const record = positions.get(id);
      if (!record) throw new PeopleDirectoryError('DIRECTORY_RECORD_NOT_FOUND', '目录记录不存在');
      const updated = { ...record, ...patch, updatedAt };
      positions.set(id, clone(updated));
      return clone(updated);
    },
    async updatePersonDetails(id, patch, updatedAt) {
      const record = people.get(id);
      if (!record) throw new PeopleDirectoryError('DIRECTORY_RECORD_NOT_FOUND', '目录记录不存在');
      const updated = { ...record, ...patch, updatedAt };
      people.set(id, clone(updated));
      return clone(updated);
    },
    async createOrganizationUnit(record) {
      assertUniqueRecord(organizationUnits, record.id, 'DUPLICATE_ORGANIZATION_ID');
      assertUniqueValue(organizationUnits.values(), 'code', record.code, 'DUPLICATE_ORGANIZATION_CODE');
      organizationUnits.set(record.id, clone(record));
      return clone(record);
    },
    async findOrganizationUnitById(id) {
      return cloneOrNull(organizationUnits.get(id));
    },
    async findOrganizationUnitByCode(code) {
      return cloneOrNull([...organizationUnits.values()].find((record) => record.code === code));
    },
    async listOrganizationUnits() {
      return [...organizationUnits.values()].map(clone).sort(compareOrganizationUnits);
    },
    async createPosition(record) {
      assertUniqueRecord(positions, record.id, 'DUPLICATE_POSITION_ID');
      assertUniqueValue(positions.values(), 'code', record.code, 'DUPLICATE_POSITION_CODE');
      positions.set(record.id, clone(record));
      return clone(record);
    },
    async findPositionById(id) {
      return cloneOrNull(positions.get(id));
    },
    async findPositionByCode(code) {
      return cloneOrNull([...positions.values()].find((record) => record.code === code));
    },
    async listPositions() {
      return [...positions.values()].map(clone).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    },
    async createPerson(record) {
      assertUniqueRecord(people, record.id, 'DUPLICATE_PERSON_ID');
      assertUniqueValue(people.values(), 'employeeNo', record.employeeNo, 'DUPLICATE_EMPLOYEE_NO');
      people.set(record.id, clone(record));
      return clone(record);
    },
    async findPersonById(id) {
      return cloneOrNull(people.get(id));
    },
    async findPersonByEmployeeNo(employeeNo) {
      return cloneOrNull([...people.values()].find((record) => record.employeeNo === employeeNo));
    },
    async getPersonProfile(id) {
      const person = people.get(id);
      return person ? createMemoryProfile(person, organizationUnits, positions) : null;
    },
    async listPersonProfiles(input) {
      return [...people.values()]
        .filter((person) => (!input.organizationUnitId || person.organizationUnitId === input.organizationUnitId)
          && (!input.positionId || person.positionId === input.positionId)
          && (!input.employmentStatus || person.employmentStatus === input.employmentStatus))
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.employeeNo.localeCompare(right.employeeNo))
        .map((person) => createMemoryProfile(person, organizationUnits, positions));
    },
    async searchPeople(input) {
      const query = input.query?.trim().toLocaleLowerCase('zh-CN');
      return [...people.values()]
        .filter((person) => {
          if (input.organizationUnitId && person.organizationUnitId !== input.organizationUnitId) return false;
          if (input.positionId && person.positionId !== input.positionId) return false;
          if (input.employmentStatus && person.employmentStatus !== input.employmentStatus) return false;
          if (!query) return true;
          return [person.name, person.employeeNo, person.phone ?? '']
            .some((value) => value.toLocaleLowerCase('zh-CN').includes(query));
        })
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.employeeNo.localeCompare(right.employeeNo))
        .slice(0, normalizeLimit(input.limit))
        .map((person) => createMemoryProfile(person, organizationUnits, positions));
    },
    async linkExternalIdentity(record) {
      assertUniqueRecord(externalIdentities, record.id, 'DUPLICATE_EXTERNAL_IDENTITY_ID');
      const conflict = [...externalIdentities.values()].find((existing) =>
        existing.provider === record.provider
        && existing.tenantKey === record.tenantKey
        && (existing.externalUserId === record.externalUserId || existing.personId === record.personId)
      );
      if (conflict) {
        throw new PeopleDirectoryError('DUPLICATE_EXTERNAL_IDENTITY', '外部身份已关联');
      }
      externalIdentities.set(record.id, clone(record));
      return clone(record);
    },
    async findPersonByExternalIdentity(provider, tenantKey, externalUserId) {
      const identity = [...externalIdentities.values()].find((record) =>
        record.provider === provider
        && record.tenantKey === tenantKey
        && record.externalUserId === externalUserId
        && record.status === 'active'
        && record.verifiedAt !== null
      );
      if (!identity) return null;
      const person = people.get(identity.personId);
      return person ? createMemoryProfile(person, organizationUnits, positions) : null;
    },
    records() {
      return {
        organizationUnits: [...organizationUnits.values()].map(clone),
        positions: [...positions.values()].map(clone),
        people: [...people.values()].map(clone),
        externalIdentities: [...externalIdentities.values()].map(clone)
      };
    }
  };
}

export function createPostgresPeopleDirectoryRepository(client: QueryableClient): PeopleDirectoryRepository {
  return {
    async updateOrganizationUnitDetails(id, patch, updatedAt) {
      return mapOrganizationUnit(requireRow(await client.query(
        'UPDATE platform_organization_units SET name=CASE WHEN $2 THEN $3 ELSE name END, short_name=CASE WHEN $4 THEN $5 ELSE short_name END, updated_at=$6 WHERE id=$1 RETURNING *',
        [id, Object.hasOwn(patch, 'name'), patch.name ?? null, Object.hasOwn(patch, 'shortName'), patch.shortName ?? null, updatedAt]
      ), 'DIRECTORY_RECORD_NOT_FOUND'));
    },
    async updatePositionDetails(id, patch, updatedAt) {
      return mapPosition(requireRow(await client.query(
        'UPDATE platform_positions SET name=CASE WHEN $2 THEN $3 ELSE name END, description=CASE WHEN $4 THEN $5 ELSE description END, updated_at=$6 WHERE id=$1 RETURNING *',
        [id, Object.hasOwn(patch, 'name'), patch.name ?? null, Object.hasOwn(patch, 'description'), patch.description ?? null, updatedAt]
      ), 'DIRECTORY_RECORD_NOT_FOUND'));
    },
    async updatePersonDetails(id, patch, updatedAt) {
      return mapPerson(requireRow(await client.query(
        'UPDATE platform_people SET name=CASE WHEN $2 THEN $3 ELSE name END, phone=CASE WHEN $4 THEN $5 ELSE phone END, updated_at=$6 WHERE id=$1 RETURNING *',
        [id, Object.hasOwn(patch, 'name'), patch.name ?? null, Object.hasOwn(patch, 'phone'), patch.phone ?? null, updatedAt]
      ), 'DIRECTORY_RECORD_NOT_FOUND'));
    },
    async createOrganizationUnit(record) {
      const result = await client.query(
        `INSERT INTO platform_organization_units
          (id, parent_id, code, name, short_name, unit_type, status, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [record.id, record.parentId, record.code, record.name, record.shortName, record.unitType, record.status, record.sortOrder, record.createdAt, record.updatedAt]
      );
      return mapOrganizationUnit(requireRow(result, 'ORGANIZATION_INSERT_FAILED'));
    },
    async findOrganizationUnitById(id) {
      const result = await client.query('SELECT * FROM platform_organization_units WHERE id = $1', [id]);
      return optionalRow(result, mapOrganizationUnit);
    },
    async findOrganizationUnitByCode(code) {
      const result = await client.query('SELECT * FROM platform_organization_units WHERE code = $1', [code]);
      return optionalRow(result, mapOrganizationUnit);
    },
    async listOrganizationUnits() {
      const result = await client.query('SELECT * FROM platform_organization_units ORDER BY parent_id NULLS FIRST, sort_order, name, id');
      return resultRows(result).map(mapOrganizationUnit);
    },
    async createPosition(record) {
      const result = await client.query(
        `INSERT INTO platform_positions
          (id, code, name, description, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [record.id, record.code, record.name, record.description, record.status, record.createdAt, record.updatedAt]
      );
      return mapPosition(requireRow(result, 'POSITION_INSERT_FAILED'));
    },
    async findPositionById(id) {
      const result = await client.query('SELECT * FROM platform_positions WHERE id = $1', [id]);
      return optionalRow(result, mapPosition);
    },
    async findPositionByCode(code) {
      const result = await client.query('SELECT * FROM platform_positions WHERE code = $1', [code]);
      return optionalRow(result, mapPosition);
    },
    async listPositions() {
      const result = await client.query('SELECT * FROM platform_positions ORDER BY name, code');
      return resultRows(result).map(mapPosition);
    },
    async createPerson(record) {
      const result = await client.query(
        `INSERT INTO platform_people
          (id, employee_no, name, phone, organization_unit_id, position_id, employment_status, avatar_url, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [record.id, record.employeeNo, record.name, record.phone, record.organizationUnitId, record.positionId, record.employmentStatus, record.avatarUrl, record.createdAt, record.updatedAt]
      );
      return mapPerson(requireRow(result, 'PERSON_INSERT_FAILED'));
    },
    async findPersonById(id) {
      const result = await client.query('SELECT * FROM platform_people WHERE id = $1', [id]);
      return optionalRow(result, mapPerson);
    },
    async findPersonByEmployeeNo(employeeNo) {
      const result = await client.query('SELECT * FROM platform_people WHERE employee_no = $1', [employeeNo]);
      return optionalRow(result, mapPerson);
    },
    async getPersonProfile(id) {
      const result = await client.query(`${PERSON_PROFILE_SELECT} WHERE person.id = $1`, [id]);
      return optionalRow(result, mapPersonProfile);
    },
    async listPersonProfiles(input) {
      const result = await client.query(
        `${PERSON_PROFILE_SELECT}
         WHERE ($1::uuid IS NULL OR person.organization_unit_id = $1)
           AND ($2::uuid IS NULL OR person.position_id = $2)
           AND ($3::text IS NULL OR person.employment_status = $3)
         ORDER BY person.name, person.employee_no`,
        [input.organizationUnitId ?? null, input.positionId ?? null, input.employmentStatus ?? null]
      );
      return resultRows(result).map(mapPersonProfile);
    },
    async searchPeople(input) {
      const result = await client.query(
        `${PERSON_PROFILE_SELECT}
         WHERE ($1::text IS NULL OR person.name ILIKE '%' || $1 || '%' OR person.employee_no ILIKE '%' || $1 || '%' OR person.phone ILIKE '%' || $1 || '%')
           AND ($2::uuid IS NULL OR person.organization_unit_id = $2)
           AND ($3::uuid IS NULL OR person.position_id = $3)
           AND ($4::text IS NULL OR person.employment_status = $4)
         ORDER BY person.name, person.employee_no
         LIMIT $5`,
        [input.query?.trim() || null, input.organizationUnitId ?? null, input.positionId ?? null, input.employmentStatus ?? null, normalizeLimit(input.limit)]
      );
      return resultRows(result).map(mapPersonProfile);
    },
    async linkExternalIdentity(record) {
      const result = await client.query(
        `INSERT INTO platform_external_identities
          (id, person_id, provider, tenant_key, external_user_id, status, verified_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [record.id, record.personId, record.provider, record.tenantKey, record.externalUserId, record.status, record.verifiedAt, record.createdAt, record.updatedAt]
      );
      return mapExternalIdentity(requireRow(result, 'EXTERNAL_IDENTITY_INSERT_FAILED'));
    },
    async findPersonByExternalIdentity(provider, tenantKey, externalUserId) {
      const result = await client.query(
        `${PERSON_PROFILE_SELECT}
         JOIN platform_external_identities identity ON identity.person_id = person.id
         WHERE identity.provider = $1 AND identity.tenant_key = $2 AND identity.external_user_id = $3
           AND identity.status = 'active' AND identity.verified_at IS NOT NULL`,
        [provider, tenantKey, externalUserId]
      );
      return optionalRow(result, mapPersonProfile);
    }
  };
}

const PERSON_PROFILE_SELECT = `SELECT
  person.id AS person_id,
  person.employee_no,
  person.name AS person_name,
  person.phone,
  person.organization_unit_id,
  person.position_id,
  person.employment_status,
  person.avatar_url,
  person.created_at AS person_created_at,
  person.updated_at AS person_updated_at,
  organization.id AS organization_id,
  organization.parent_id AS organization_parent_id,
  organization.code AS organization_code,
  organization.name AS organization_name,
  organization.short_name AS organization_short_name,
  organization.unit_type AS organization_unit_type,
  organization.status AS organization_status,
  organization.sort_order AS organization_sort_order,
  organization.created_at AS organization_created_at,
  organization.updated_at AS organization_updated_at,
  position.id AS directory_position_id,
  position.code AS position_code,
  position.name AS position_name,
  position.description AS position_description,
  position.status AS position_status,
  position.created_at AS position_created_at,
  position.updated_at AS position_updated_at
FROM platform_people person
JOIN platform_organization_units organization ON organization.id = person.organization_unit_id
JOIN platform_positions position ON position.id = person.position_id`;

function createMemoryProfile(
  person: Person,
  organizations: Map<string, OrganizationUnit>,
  positions: Map<string, Position>
): PersonDirectoryProfile {
  const organizationUnit = organizations.get(person.organizationUnitId);
  const position = positions.get(person.positionId);
  if (!organizationUnit || !position) {
    throw new PeopleDirectoryError('BROKEN_PERSON_REFERENCE', `人员目录引用不完整: ${person.id}`);
  }
  return { person: clone(person), organizationUnit: clone(organizationUnit), position: clone(position) };
}

function assertUniqueRecord<T>(records: Map<string, T>, id: string, code: string) {
  if (records.has(id)) throw new PeopleDirectoryError(code, `目录 ID 已存在: ${id}`);
}

function assertUniqueValue<T extends object, K extends keyof T>(records: Iterable<T>, key: K, value: T[K], code: string) {
  if ([...records].some((record) => record[key] === value)) {
    throw new PeopleDirectoryError(code, `目录唯一值已存在: ${String(value)}`);
  }
}

function normalizeLimit(limit: number | undefined) {
  return Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit! : 50));
}

function compareOrganizationUnits(left: OrganizationUnit, right: OrganizationUnit) {
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id);
}

function resultRows(result: unknown): unknown[] {
  if (!result || typeof result !== 'object' || !('rows' in result) || !Array.isArray(result.rows)) return [];
  return result.rows;
}

function requireRow(result: unknown, code: string) {
  const row = resultRows(result)[0];
  if (!row) throw new PeopleDirectoryError(code, '目录写入未返回记录');
  return row;
}

function optionalRow<T>(result: unknown, mapper: (row: unknown) => T): T | null {
  const row = resultRows(result)[0];
  return row ? mapper(row) : null;
}

function mapOrganizationUnit(row: unknown): OrganizationUnit {
  const value = asRecord(row);
  return {
    id: requiredString(value.id),
    parentId: optionalString(value.parent_id),
    code: requiredString(value.code),
    name: requiredString(value.name),
    shortName: optionalString(value.short_name),
    unitType: requiredString(value.unit_type) as OrganizationUnit['unitType'],
    status: requiredString(value.status) as OrganizationUnit['status'],
    sortOrder: Number(value.sort_order ?? 0),
    createdAt: toIsoString(value.created_at),
    updatedAt: toIsoString(value.updated_at)
  };
}

function mapPosition(row: unknown): Position {
  const value = asRecord(row);
  return {
    id: requiredString(value.id),
    code: requiredString(value.code),
    name: requiredString(value.name),
    description: optionalString(value.description),
    status: requiredString(value.status) as Position['status'],
    createdAt: toIsoString(value.created_at),
    updatedAt: toIsoString(value.updated_at)
  };
}

function mapPerson(row: unknown): Person {
  const value = asRecord(row);
  return {
    id: requiredString(value.id),
    employeeNo: requiredString(value.employee_no),
    name: requiredString(value.name),
    phone: optionalString(value.phone),
    organizationUnitId: requiredString(value.organization_unit_id),
    positionId: requiredString(value.position_id),
    employmentStatus: requiredString(value.employment_status) as Person['employmentStatus'],
    avatarUrl: optionalString(value.avatar_url),
    createdAt: toIsoString(value.created_at),
    updatedAt: toIsoString(value.updated_at)
  };
}

function mapExternalIdentity(row: unknown): ExternalIdentity {
  const value = asRecord(row);
  return {
    id: requiredString(value.id),
    personId: requiredString(value.person_id),
    provider: requiredString(value.provider),
    tenantKey: requiredString(value.tenant_key),
    externalUserId: requiredString(value.external_user_id),
    status: requiredString(value.status) as ExternalIdentity['status'],
    verifiedAt: optionalDateString(value.verified_at),
    createdAt: toIsoString(value.created_at),
    updatedAt: toIsoString(value.updated_at)
  };
}

function mapPersonProfile(row: unknown): PersonDirectoryProfile {
  const value = asRecord(row);
  return {
    person: {
      id: requiredString(value.person_id),
      employeeNo: requiredString(value.employee_no),
      name: requiredString(value.person_name),
      phone: optionalString(value.phone),
      organizationUnitId: requiredString(value.organization_unit_id),
      positionId: requiredString(value.position_id),
      employmentStatus: requiredString(value.employment_status) as Person['employmentStatus'],
      avatarUrl: optionalString(value.avatar_url),
      createdAt: toIsoString(value.person_created_at),
      updatedAt: toIsoString(value.person_updated_at)
    },
    organizationUnit: {
      id: requiredString(value.organization_id),
      parentId: optionalString(value.organization_parent_id),
      code: requiredString(value.organization_code),
      name: requiredString(value.organization_name),
      shortName: optionalString(value.organization_short_name),
      unitType: requiredString(value.organization_unit_type) as OrganizationUnit['unitType'],
      status: requiredString(value.organization_status) as OrganizationUnit['status'],
      sortOrder: Number(value.organization_sort_order ?? 0),
      createdAt: toIsoString(value.organization_created_at),
      updatedAt: toIsoString(value.organization_updated_at)
    },
    position: {
      id: requiredString(value.directory_position_id),
      code: requiredString(value.position_code),
      name: requiredString(value.position_name),
      description: optionalString(value.position_description),
      status: requiredString(value.position_status) as Position['status'],
      createdAt: toIsoString(value.position_created_at),
      updatedAt: toIsoString(value.position_updated_at)
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new PeopleDirectoryError('INVALID_DATABASE_ROW', '目录数据库返回格式无效');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown) {
  if (typeof value !== 'string' || !value) throw new PeopleDirectoryError('INVALID_DATABASE_ROW', '目录数据库字段缺失');
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function optionalDateString(value: unknown): string | null {
  return value == null ? null : toIsoString(value);
}

function toIsoString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new PeopleDirectoryError('INVALID_DATABASE_ROW', '目录数据库时间字段无效');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}
