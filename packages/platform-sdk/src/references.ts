export type PlatformReferenceKind =
  | 'person'
  | 'organization_unit'
  | 'position'
  | 'location'
  | 'station'
  | 'asset'
  | 'device'
  | 'work_item'
  | 'notification'
  | 'signature_request'
  | 'attachment'
  | 'duty_period';

export interface PlatformReference<TKind extends PlatformReferenceKind = PlatformReferenceKind> {
  kind: TKind;
  id: string;
  code?: string | null;
  label?: string | null;
}

export type PersonReference = PlatformReference<'person'>;
export type OrganizationUnitReference = PlatformReference<'organization_unit'>;
export type PositionReference = PlatformReference<'position'>;
export type LocationReference = PlatformReference<'location'>;
export type StationReference = PlatformReference<'station'>;
export type AssetReference = PlatformReference<'asset'>;
export type DeviceReference = PlatformReference<'device'>;
export type WorkItemReference = PlatformReference<'work_item'>;
export type NotificationReference = PlatformReference<'notification'>;
export type SignatureRequestReference = PlatformReference<'signature_request'>;
export type AttachmentReference = PlatformReference<'attachment'>;
export type DutyPeriodReference = PlatformReference<'duty_period'>;
export type AssigneeReference = PersonReference | OrganizationUnitReference;

export interface PlatformSourceReference {
  appId: string;
  entityType: string;
  entityId: string;
}

export interface PlatformEntityReference {
  entityType: string;
  entityId: string;
  label?: string | null;
}
