import React, { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

export interface PlatformActorPersonSnapshot {
  id: string;
  employeeNo: string;
  name: string;
  avatarUrl: string | null;
  organization: { id: string; code: string; name: string; unitType: string };
  position: { id: string; code: string; name: string };
}

export interface PlatformActorSnapshot {
  actorType: 'person' | 'service';
  source: 'session' | 'wecom' | 'name' | 'service' | 'mcp_actor_token';
  execution: { type: 'platform' | 'application' | 'service'; appId?: string };
  person?: PlatformActorPersonSnapshot;
  capabilities: string[];
}

export interface PlatformActorContextValue {
  actor: PlatformActorSnapshot | null;
  hasCapability(permissionCode: string): boolean;
}

const PlatformActorReactContext = createContext<PlatformActorContextValue | undefined>(undefined);

export function createPlatformCapabilityReader(actor: PlatformActorSnapshot | null) {
  const capabilities = new Set(actor?.capabilities ?? []);
  return (permissionCode: string) => capabilities.has(permissionCode.trim());
}

export function PlatformActorProvider({ actor, children }: { actor: PlatformActorSnapshot | null; children: ReactNode }) {
  const capabilityReader = useMemo(() => createPlatformCapabilityReader(actor), [actor]);
  const hasCapability = useCallback((permissionCode: string) => capabilityReader(permissionCode), [capabilityReader]);
  const value = useMemo(() => ({ actor, hasCapability }), [actor, hasCapability]);
  return <PlatformActorReactContext.Provider value={value}>{children}</PlatformActorReactContext.Provider>;
}

export function usePlatformActor() {
  const context = useContext(PlatformActorReactContext);
  if (!context) throw new Error('usePlatformActor must be used within PlatformActorProvider');
  return context;
}
