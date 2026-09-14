import type { AssetLifecycleState } from '../assets/index.js';
import type { LocationType } from '../locations/index.js';
import type { OrganizationUnitType } from '../people/index.js';

export type EntityType = 'person' | 'organization' | 'location' | 'asset';
export type ResolutionSource = 'web' | 'import' | 'agent' | 'mcp';
export type EntityMatchType = 'id' | 'external_id' | 'code' | 'name' | 'alias' | 'normalized' | 'contains' | 'typo';

export type EntityLookup =
  | { type: 'id'; id: string }
  | { type: 'external_id'; provider: string; tenantKey?: string; externalId: string }
  | { type: 'text'; text: string };

export interface PersonResolutionFilters {
  organizationUnitId?: string;
  positionId?: string;
}

export interface OrganizationResolutionFilters {
  unitTypes?: OrganizationUnitType[];
  parentOrganizationUnitId?: string;
}

export interface LocationResolutionFilters {
  locationType?: LocationType;
  lineId?: string;
}

export interface AssetResolutionFilters {
  systemId?: string;
  typeId?: string;
  locationId?: string;
  lifecycleStates?: AssetLifecycleState[];
}

interface ResolutionRequestBase {
  source: ResolutionSource;
  lookup: EntityLookup;
  maxCandidates?: number;
}

export type EntityResolutionRequest =
  | ResolutionRequestBase & { entityType: 'person'; filters?: PersonResolutionFilters }
  | ResolutionRequestBase & { entityType: 'organization'; filters?: OrganizationResolutionFilters }
  | ResolutionRequestBase & { entityType: 'location'; filters?: LocationResolutionFilters }
  | ResolutionRequestBase & { entityType: 'asset'; filters?: AssetResolutionFilters };

export interface PersonReference {
  entityType: 'person';
  id: string;
  displayName: string;
  employeeNo: string;
  organization: { id: string; code: string; name: string };
  position: { id: string; code: string; name: string };
}

export interface OrganizationReference {
  entityType: 'organization';
  id: string;
  displayName: string;
  code: string;
  shortName: string | null;
  unitType: OrganizationUnitType;
  parentId: string | null;
}

export type TeamReference = OrganizationReference & { unitType: 'workgroup' };

export interface LocationReference {
  entityType: 'location';
  id: string;
  displayName: string;
  code: string;
  shortName: string | null;
  locationType: LocationType;
  lineCodes: string[];
  stationCodes: string[];
}

export interface AssetReference {
  entityType: 'asset';
  id: string;
  displayName: string;
  assetCode: string | null;
  system: { id: string; code: string; name: string };
  type: { id: string; code: string; name: string };
  locationId: string;
  lifecycleState: AssetLifecycleState;
}

export type EntityReference = PersonReference | OrganizationReference | LocationReference | AssetReference;

export interface EntityMatchEvidence {
  type: EntityMatchType;
  score: number;
  matchedField: 'id' | 'external_id' | 'code' | 'name' | 'alias';
  matchedValue: string;
}

export interface EntityResolutionCandidate {
  reference: EntityReference;
  match: EntityMatchEvidence;
}

interface ResolutionResultBase {
  entityType: EntityType;
  source: ResolutionSource;
  input: string;
  normalizedInput: string;
  candidateCount: number;
  candidates: EntityResolutionCandidate[];
}

export type EntityResolutionResult =
  | ResolutionResultBase & { status: 'resolved'; resolved: EntityResolutionCandidate }
  | ResolutionResultBase & { status: 'ambiguous'; resolved: null }
  | ResolutionResultBase & { status: 'not_found'; resolved: null };

export class EntityResolutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EntityResolutionError';
    this.code = code;
  }
}
