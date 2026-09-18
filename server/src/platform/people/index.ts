import { randomUUID } from 'node:crypto';
import {
  ORGANIZATION_UNIT_TYPES,
  PeopleDirectoryError,
  type CreateOrganizationUnitInput,
  type CreatePersonInput,
  type CreatePositionInput,
  type LegacyDirectoryIssue,
  type LegacyDirectoryReconciliation,
  type LegacyDirectorySnapshot,
  type LinkExternalIdentityInput,
  type OrganizationTreeNode,
  type OrganizationUnit,
  type Person,
  type PersonDirectoryProfile,
  type Position,
  type SearchPeopleInput
} from './model.js';
import type { PeopleDirectoryRepository } from './repository.js';

export * from './model.js';
export * from './migration.js';
export * from './repository.js';

export interface PeopleDirectoryServiceOptions {
  clock?: () => Date;
  createId?: () => string;
}

export class PeopleDirectoryService {
  private readonly clock: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly repository: PeopleDirectoryRepository,
    options: PeopleDirectoryServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async updateOrganizationUnitDetails(id: string, input: Partial<Pick<OrganizationUnit, 'name' | 'shortName' | 'status'>>) {
    const patch: Partial<Pick<OrganizationUnit, 'name' | 'shortName' | 'status'>> = {};
    if (input.name !== undefined) patch.name = normalizeText(input.name, 'name', 200);
    if (input.shortName !== undefined) patch.shortName = normalizeOptionalText(input.shortName, 100);
    if (input.status !== undefined) { if (!['active','inactive'].includes(input.status)) throw new PeopleDirectoryError('INVALID_STATUS','状态无效'); patch.status = input.status; }
    if (!Object.keys(patch).length) throw new PeopleDirectoryError('EMPTY_DIRECTORY_UPDATE', '请填写需要更新的字段');
    return this.repository.updateOrganizationUnitDetails(normalizeUuid(id, 'record id'), patch, this.clock().toISOString());
  }

  async updatePositionDetails(id: string, input: Partial<Pick<Position, 'name' | 'description' | 'status'>>) {
    const patch: Partial<Pick<Position, 'name' | 'description' | 'status'>> = {};
    if (input.name !== undefined) patch.name = normalizeText(input.name, 'name', 200);
    if (input.description !== undefined) patch.description = normalizeOptionalText(input.description, 1000);
    if (input.status !== undefined) { if (!['active','inactive'].includes(input.status)) throw new PeopleDirectoryError('INVALID_STATUS','状态无效'); patch.status = input.status; }
    if (!Object.keys(patch).length) throw new PeopleDirectoryError('EMPTY_DIRECTORY_UPDATE', '请填写需要更新的字段');
    return this.repository.updatePositionDetails(normalizeUuid(id, 'record id'), patch, this.clock().toISOString());
  }

  async updatePersonDetails(id: string, input: Partial<Pick<Person, 'name' | 'phone' | 'organizationUnitId' | 'positionId'>>) {
    const patch: Partial<Pick<Person, 'name' | 'phone' | 'organizationUnitId' | 'positionId'>> = {};
    if (input.name !== undefined) patch.name = normalizeText(input.name, 'name', 100);
    if (input.phone !== undefined) patch.phone = normalizeOptionalText(input.phone, 50);
    if (input.organizationUnitId !== undefined) {
      const value = normalizeUuid(input.organizationUnitId, 'organization unit id');
      const organization = await this.repository.findOrganizationUnitById(value);
      if (!organization) throw new PeopleDirectoryError('ORGANIZATION_NOT_FOUND', '人员所属组织不存在');
      if (organization.status !== 'active') throw new PeopleDirectoryError('ORGANIZATION_INACTIVE', '人员所属组织未启用');
      patch.organizationUnitId = value;
    }
    if (input.positionId !== undefined) {
      const value = normalizeUuid(input.positionId, 'position id');
      const position = await this.repository.findPositionById(value);
      if (!position) throw new PeopleDirectoryError('POSITION_NOT_FOUND', '人员岗位不存在');
      if (position.status !== 'active') throw new PeopleDirectoryError('POSITION_INACTIVE', '人员岗位未启用');
      patch.positionId = value;
    }
    if (!Object.keys(patch).length) throw new PeopleDirectoryError('EMPTY_DIRECTORY_UPDATE', '请填写需要更新的字段');
    return this.repository.updatePersonDetails(normalizeUuid(id, 'record id'), patch, this.clock().toISOString());
  }

  async createOrganizationUnit(input: CreateOrganizationUnitInput): Promise<OrganizationUnit> {
    const id = normalizeUuid(input.id ?? this.createId(), 'organization unit id');
    const parentId = input.parentId ? normalizeUuid(input.parentId, 'parent organization unit id') : null;
    const code = normalizeCode(input.code, 'organization code');
    const name = normalizeText(input.name, 'organization name', 200);
    const shortName = normalizeOptionalText(input.shortName, 100);
    const status = input.status ?? 'active';
    const sortOrder = normalizeSortOrder(input.sortOrder);

    if (!ORGANIZATION_UNIT_TYPES.includes(input.unitType)) {
      throw new PeopleDirectoryError('INVALID_ORGANIZATION_TYPE', `无效组织类型: ${input.unitType}`);
    }
    if (input.unitType === 'company' && parentId) {
      throw new PeopleDirectoryError('COMPANY_CANNOT_HAVE_PARENT', '公司组织节点不能设置上级组织');
    }
    if (input.unitType !== 'company' && !parentId) {
      throw new PeopleDirectoryError('ORGANIZATION_PARENT_REQUIRED', '非公司组织节点必须设置上级组织');
    }
    if (parentId === id) {
      throw new PeopleDirectoryError('ORGANIZATION_SELF_PARENT', '组织节点不能以自身为上级');
    }
    if (await this.repository.findOrganizationUnitByCode(code)) {
      throw new PeopleDirectoryError('DUPLICATE_ORGANIZATION_CODE', `组织编码已存在: ${code}`);
    }
    if (parentId) {
      const parent = await this.repository.findOrganizationUnitById(parentId);
      if (!parent) throw new PeopleDirectoryError('ORGANIZATION_PARENT_NOT_FOUND', '上级组织不存在');
      if (parent.status !== 'active') throw new PeopleDirectoryError('ORGANIZATION_PARENT_INACTIVE', '上级组织未启用');
    }

    const now = this.clock().toISOString();
    return this.repository.createOrganizationUnit({
      id,
      parentId,
      code,
      name,
      shortName,
      unitType: input.unitType,
      status,
      sortOrder,
      createdAt: now,
      updatedAt: now
    });
  }

  async createPosition(input: CreatePositionInput): Promise<Position> {
    const id = normalizeUuid(input.id ?? this.createId(), 'position id');
    const code = normalizeCode(input.code, 'position code');
    const name = normalizeText(input.name, 'position name', 200);
    if (await this.repository.findPositionByCode(code)) {
      throw new PeopleDirectoryError('DUPLICATE_POSITION_CODE', `岗位编码已存在: ${code}`);
    }
    const now = this.clock().toISOString();
    return this.repository.createPosition({
      id,
      code,
      name,
      description: normalizeOptionalText(input.description, 1000),
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now
    });
  }

  async createPerson(input: CreatePersonInput) {
    const id = normalizeUuid(input.id ?? this.createId(), 'person id');
    const employeeNo = normalizeText(input.employeeNo, 'employee number', 50);
    const organizationUnitId = normalizeUuid(input.organizationUnitId, 'organization unit id');
    const positionId = normalizeUuid(input.positionId, 'position id');
    if (await this.repository.findPersonByEmployeeNo(employeeNo)) {
      throw new PeopleDirectoryError('DUPLICATE_EMPLOYEE_NO', `工号已存在: ${employeeNo}`);
    }
    const [organizationUnit, position] = await Promise.all([
      this.repository.findOrganizationUnitById(organizationUnitId),
      this.repository.findPositionById(positionId)
    ]);
    if (!organizationUnit) throw new PeopleDirectoryError('ORGANIZATION_NOT_FOUND', '人员所属组织不存在');
    if (organizationUnit.status !== 'active') throw new PeopleDirectoryError('ORGANIZATION_INACTIVE', '人员所属组织未启用');
    if (!position) throw new PeopleDirectoryError('POSITION_NOT_FOUND', '人员岗位不存在');
    if (position.status !== 'active') throw new PeopleDirectoryError('POSITION_INACTIVE', '人员岗位未启用');

    const now = this.clock().toISOString();
    return this.repository.createPerson({
      id,
      employeeNo,
      name: normalizeText(input.name, 'person name', 100),
      phone: normalizeOptionalText(input.phone, 50),
      organizationUnitId,
      positionId,
      employmentStatus: input.employmentStatus ?? 'active',
      avatarUrl: normalizeOptionalText(input.avatarUrl, 2000),
      createdAt: now,
      updatedAt: now
    });
  }

  async linkExternalIdentity(input: LinkExternalIdentityInput) {
    const personId = normalizeUuid(input.personId, 'person id');
    const person = await this.repository.findPersonById(personId);
    if (!person) throw new PeopleDirectoryError('PERSON_NOT_FOUND', '人员不存在');
    const now = this.clock().toISOString();
    const status = input.status ?? 'active';
    return this.repository.linkExternalIdentity({
      id: normalizeUuid(input.id ?? this.createId(), 'external identity id'),
      personId,
      provider: normalizeCode(input.provider, 'external identity provider'),
      tenantKey: normalizeCode(input.tenantKey ?? 'default', 'external identity tenant'),
      externalUserId: normalizeText(input.externalUserId, 'external user id', 255),
      status,
      verifiedAt: input.verifiedAt?.toISOString() ?? (status === 'active' ? now : null),
      createdAt: now,
      updatedAt: now
    });
  }

  async getOrganizationTree(): Promise<OrganizationTreeNode[]> {
    return buildOrganizationTree(await this.repository.listOrganizationUnits());
  }

  async listPositions() {
    return this.repository.listPositions();
  }

  async getPersonProfile(id: string) {
    return this.repository.getPersonProfile(normalizeUuid(id, 'person id'));
  }

  async searchPeople(input: SearchPeopleInput = {}): Promise<PersonDirectoryProfile[]> {
    return this.repository.searchPeople({
      query: input.query?.trim() || undefined,
      organizationUnitId: input.organizationUnitId ? normalizeUuid(input.organizationUnitId, 'organization unit id') : undefined,
      positionId: input.positionId ? normalizeUuid(input.positionId, 'position id') : undefined,
      employmentStatus: input.employmentStatus,
      limit: normalizeSearchLimit(input.limit)
    });
  }

  async resolveExternalIdentity(provider: string, externalUserId: string, tenantKey = 'default') {
    return this.repository.findPersonByExternalIdentity(
      normalizeCode(provider, 'external identity provider'),
      normalizeCode(tenantKey, 'external identity tenant'),
      normalizeText(externalUserId, 'external user id', 255)
    );
  }
}

export function createPeopleDirectoryService(
  repository: PeopleDirectoryRepository,
  options: PeopleDirectoryServiceOptions = {}
) {
  return new PeopleDirectoryService(repository, options);
}

export function buildOrganizationTree(units: readonly OrganizationUnit[]): OrganizationTreeNode[] {
  const nodes = new Map(units.map((unit) => [unit.id, { ...structuredClone(unit), children: [] as OrganizationTreeNode[] }]));
  if (nodes.size !== units.length) {
    throw new PeopleDirectoryError('DUPLICATE_ORGANIZATION_ID', '组织树包含重复 ID');
  }
  const roots: OrganizationTreeNode[] = [];

  for (const unit of units) {
    const node = nodes.get(unit.id)!;
    if (!unit.parentId) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(unit.parentId);
    if (!parent) throw new PeopleDirectoryError('ORPHAN_ORGANIZATION', `组织节点缺少上级: ${unit.id}`);
    parent.children.push(node);
  }

  const sortNodes = (items: OrganizationTreeNode[]) => {
    items.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id));
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  const visited = new Set<string>();
  const visit = (items: readonly OrganizationTreeNode[]) => {
    for (const item of items) {
      if (visited.has(item.id)) throw new PeopleDirectoryError('CYCLIC_ORGANIZATION', '组织树存在循环关系');
      visited.add(item.id);
      visit(item.children);
    }
  };
  visit(roots);
  if (visited.size !== units.length) {
    throw new PeopleDirectoryError('CYCLIC_ORGANIZATION', '组织树存在无法连接到公司根节点的循环关系');
  }
  return roots;
}

export function reconcileLegacyDirectory(snapshot: LegacyDirectorySnapshot): LegacyDirectoryReconciliation {
  const organizationIds = new Set(snapshot.organizations.map((record) => record.id));
  const employeeNos = new Map<string, string>();
  const wecomUserIds = new Map<string, string>();
  const issues: LegacyDirectoryIssue[] = [];
  let wecomBindingCount = 0;

  for (const user of snapshot.users) {
    const employeeNo = user.employeeNo.trim();
    const existingEmployee = employeeNos.get(employeeNo);
    if (existingEmployee) {
      issues.push({ code: 'DUPLICATE_EMPLOYEE_NO', personId: user.id, value: employeeNo });
    } else {
      employeeNos.set(employeeNo, user.id);
    }

    const wecomUserId = user.wecomUserId?.trim();
    if (wecomUserId) {
      wecomBindingCount += 1;
      const existingWecom = wecomUserIds.get(wecomUserId);
      if (existingWecom) {
        issues.push({ code: 'DUPLICATE_WECOM_USER_ID', personId: user.id, value: wecomUserId });
      } else {
        wecomUserIds.set(wecomUserId, user.id);
      }
    }

    if (!user.organizationUnitId || !organizationIds.has(user.organizationUnitId)) {
      issues.push({ code: 'MISSING_ORGANIZATION', personId: user.id, value: user.organizationUnitId ?? undefined });
    }
    if (!user.positionName?.trim()) {
      issues.push({ code: 'MISSING_POSITION', personId: user.id });
    }
  }

  return {
    personCount: snapshot.users.length,
    organizationCount: snapshot.organizations.length,
    wecomBindingCount,
    preservedPersonIds: snapshot.users.map((record) => record.id),
    preservedOrganizationUnitIds: snapshot.organizations.map((record) => record.id),
    issues
  };
}

function normalizeText(value: string, label: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized) throw new PeopleDirectoryError('MISSING_DIRECTORY_VALUE', `${label} 不能为空`);
  if (normalized.length > maxLength) throw new PeopleDirectoryError('DIRECTORY_VALUE_TOO_LONG', `${label} 超过长度限制`);
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined, maxLength: number): string | null {
  if (value == null || !value.trim()) return null;
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new PeopleDirectoryError('DIRECTORY_VALUE_TOO_LONG', '目录字段超过长度限制');
  return normalized;
}

function normalizeCode(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(normalized)) {
    throw new PeopleDirectoryError('INVALID_DIRECTORY_CODE', `${label} 必须是稳定 ASCII 编码`);
  }
  return normalized;
}

function normalizeUuid(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new PeopleDirectoryError('INVALID_DIRECTORY_ID', `${label} 必须是 UUID`);
  }
  return normalized;
}

function normalizeSortOrder(value: number | undefined) {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized)) throw new PeopleDirectoryError('INVALID_SORT_ORDER', '组织排序值必须是整数');
  return normalized;
}

function normalizeSearchLimit(value: number | undefined) {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new PeopleDirectoryError('INVALID_SEARCH_LIMIT', '人员查询数量必须在 1 到 100 之间');
  }
  return value;
}
