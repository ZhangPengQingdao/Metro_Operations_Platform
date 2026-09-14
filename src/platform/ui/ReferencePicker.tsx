import React, { useId } from 'react';
import type {
  AssetReference,
  AssigneeReference,
  DeviceReference,
  LocationReference,
  OrganizationUnitReference,
  PersonReference,
  PlatformReference,
  PlatformReferenceKind,
  PositionReference,
  StationReference
} from '@metro/platform-sdk';
import { Field, Select } from '../../components/ui/index.js';

export interface ReferencePickerProps<TReference extends PlatformReference> {
  label: React.ReactNode;
  options: readonly TReference[];
  value: TReference | null;
  onChange(reference: TReference | null): void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  emptyLabel?: string;
  className?: string;
}

export function ReferencePicker<TReference extends PlatformReference>({
  label, options, value, onChange, id, placeholder = '请选择', disabled, required, hint, error,
  emptyLabel = '暂无可选项', className
}: ReferencePickerProps<TReference>) {
  const generatedId = useId();
  const controlId = id ?? `platform-reference-${generatedId.replaceAll(':', '')}`;
  return (
    <Field label={label} htmlFor={controlId} required={required} hint={hint} error={error} className={className}>
      <Select
        id={controlId}
        value={value ? referenceKey(value) : ''}
        disabled={disabled || options.length === 0}
        required={required}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(options.find((option) => referenceKey(option) === event.target.value) ?? null)}
      >
        <option value="">{options.length === 0 ? emptyLabel : placeholder}</option>
        {options.map((option) => <option key={referenceKey(option)} value={referenceKey(option)}>{referenceLabel(option)}</option>)}
      </Select>
    </Field>
  );
}

export type TypedReferencePickerProps<TReference extends PlatformReference> = Omit<ReferencePickerProps<TReference>, 'options'> & { options: readonly TReference[] };

export const UserPicker = (props: TypedReferencePickerProps<PersonReference>) => <ReferencePicker {...props} options={onlyKind(props.options, 'person')} />;
export const OrganizationUnitPicker = (props: TypedReferencePickerProps<OrganizationUnitReference>) => <ReferencePicker {...props} options={onlyKind(props.options, 'organization_unit')} />;
export const PositionPicker = (props: TypedReferencePickerProps<PositionReference>) => <ReferencePicker {...props} options={onlyKind(props.options, 'position')} />;
export const LocationPicker = (props: TypedReferencePickerProps<LocationReference>) => <ReferencePicker {...props} options={onlyKind(props.options, 'location')} />;
export const StationPicker = (props: TypedReferencePickerProps<StationReference>) => <ReferencePicker {...props} options={onlyKind(props.options, 'station')} />;
export const AssetPicker = (props: TypedReferencePickerProps<AssetReference>) => <ReferencePicker {...props} options={onlyKind(props.options, 'asset')} />;
export const DevicePicker = (props: TypedReferencePickerProps<DeviceReference>) => <ReferencePicker {...props} options={onlyKind(props.options, 'device')} />;
export const AssigneePicker = (props: TypedReferencePickerProps<AssigneeReference>) => <ReferencePicker {...props} options={props.options.filter((option) => option.kind === 'person' || option.kind === 'organization_unit')} />;

function onlyKind<TReference extends PlatformReference<TKind>, TKind extends PlatformReferenceKind>(options: readonly TReference[], kind: TKind) { return options.filter((option) => option.kind === kind); }
function referenceKey(reference: PlatformReference) { return `${reference.kind}:${reference.id}`; }
function referenceLabel(reference: PlatformReference) { const label = reference.label?.trim() || reference.code?.trim() || reference.id; const code = reference.code?.trim(); return code && code !== label ? `${label} (${code})` : label; }
