export const LOCATION_TYPES = [
  'station',
  'depot',
  'workshop',
  'equipment_room',
  'operational_area'
] as const;

export type LocationType = typeof LOCATION_TYPES[number];
export type LocationRecordStatus = 'active' | 'inactive';
export type LocationAliasType = 'common' | 'short_name' | 'historical';

export interface Location {
  id: string;
  parentId: string | null;
  organizationUnitId: string | null;
  code: string;
  name: string;
  shortName: string | null;
  locationType: LocationType;
  status: LocationRecordStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Line {
  id: string;
  code: string;
  name: string;
  shortName: string | null;
  status: LocationRecordStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface LineStation {
  id: string;
  lineId: string;
  stationId: string;
  stationCode: string;
  sortOrder: number;
  status: LocationRecordStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LocationAlias {
  id: string;
  locationId: string;
  alias: string;
  aliasType: LocationAliasType;
  status: LocationRecordStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalLocationReference {
  id: string;
  locationId: string;
  provider: string;
  tenantKey: string;
  externalLocationId: string;
  status: LocationRecordStatus;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocationTreeNode extends Location {
  children: LocationTreeNode[];
}

export interface StationLineMembership {
  line: Line;
  lineStation: LineStation;
}

export interface LocationDirectoryProfile {
  location: Location;
  aliases: LocationAlias[];
  stationLines: StationLineMembership[];
  isInterchange: boolean;
}

export interface CreateLocationInput {
  id?: string;
  parentId?: string | null;
  organizationUnitId?: string | null;
  code: string;
  name: string;
  shortName?: string | null;
  locationType: LocationType;
  status?: LocationRecordStatus;
  sortOrder?: number;
}

export interface CreateLineInput {
  id?: string;
  code: string;
  name: string;
  shortName?: string | null;
  status?: LocationRecordStatus;
  sortOrder?: number;
}

export interface LinkStationToLineInput {
  id?: string;
  lineId: string;
  stationId: string;
  stationCode: string;
  sortOrder: number;
  status?: LocationRecordStatus;
}

export interface AddLocationAliasInput {
  id?: string;
  locationId: string;
  alias: string;
  aliasType?: LocationAliasType;
  status?: LocationRecordStatus;
}

export interface LinkExternalLocationInput {
  id?: string;
  locationId: string;
  provider: string;
  tenantKey?: string;
  externalLocationId: string;
  status?: LocationRecordStatus;
  verifiedAt?: Date | null;
}

export interface SearchLocationsInput {
  query?: string;
  locationType?: LocationType;
  lineId?: string;
  status?: LocationRecordStatus;
  limit?: number;
}

export interface LegacyStationReference {
  id: string;
  name: string;
  line?: string | null;
  code?: string | null;
  sortOrder?: number | null;
  alias?: string | null;
  workgroupId?: string | null;
}

export interface LegacyStationSnapshot {
  stations: readonly LegacyStationReference[];
}

export type LegacyLocationIssueCode =
  | 'MISSING_LINE'
  | 'MISSING_STATION_CODE'
  | 'MISSING_SORT_ORDER'
  | 'DUPLICATE_LINE_STATION_CODE'
  | 'DUPLICATE_LINE_SORT_ORDER';

export interface LegacyLocationIssue {
  code: LegacyLocationIssueCode;
  stationId: string;
  value?: string;
}

export interface LegacyLocationReconciliation {
  stationCount: number;
  lineCount: number;
  lineStationCount: number;
  aliasCount: number;
  preservedStationIds: string[];
  responsibilitySourceCount: number;
  issues: LegacyLocationIssue[];
}

export class LocationDirectoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LocationDirectoryError';
    this.code = code;
  }
}
