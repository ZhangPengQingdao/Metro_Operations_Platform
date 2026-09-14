import React, { type ReactNode } from 'react';
import { usePlatformActor } from '../context/index.js';

export interface PermissionGuardProps {
  permission: string;
  children: ReactNode;
  fallback?: ReactNode;
}

export function PermissionGuard({ permission, children, fallback = null }: PermissionGuardProps) {
  const { hasCapability } = usePlatformActor();
  return hasCapability(permission) ? <>{children}</> : <>{fallback}</>;
}
