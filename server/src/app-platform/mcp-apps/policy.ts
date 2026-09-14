import {createHash} from 'node:crypto';
import type {PlatformMcpUiMetadata} from '../../platform/mcp/index.js';
import type {AppInstallation} from '../registry/index.js';

const domainKeys = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const;
const devices = ['camera', 'microphone', 'geolocation', 'clipboardWrite'] as const;
export interface McpViewPolicy {
  csp: Record<typeof domainKeys[number], string[]>;
  permissions: (typeof devices[number])[];
}
export const emptyMcpViewPolicy = (): McpViewPolicy => ({csp: {connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: []}, permissions: []});
function origins(values: readonly string[]) {
  if (values.length > 32) throw new Error('INVALID_VIEW_POLICY');
  return [...new Set(values.map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.hostname.includes('*')) throw new Error('INVALID_VIEW_POLICY');
    return value;
  }))].sort();
}
/** Approval is a trusted installation-bound policy decision, never supplied by View/model. */
export function decideMcpViewPolicy(installation: AppInstallation, requested: PlatformMcpUiMetadata | undefined,
  approval: {installationId: string; revision: number; policy: McpViewPolicy}, hostPolicy: McpViewPolicy) {
  if (!installation.enabled || approval.installationId !== installation.id || approval.revision !== installation.revision) throw new Error('STALE_VIEW_POLICY');
  const policy = emptyMcpViewPolicy();
  const manifest = origins(installation.manifest.network.frontendOrigins);
  for (const key of domainKeys) {
    const granted = origins(approval.policy.csp[key]);
    const host = origins(hostPolicy.csp[key]);
    policy.csp[key] = origins(requested?.csp?.[key] ?? []).filter(origin => manifest.includes(origin) && granted.includes(origin) && host.includes(origin));
  }
  policy.permissions = devices.filter(device => requested?.permissions?.[device] !== undefined && approval.policy.permissions.includes(device) && hostPolicy.permissions.includes(device));
  const id = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  return {id, policy};
}

export function mcpViewPolicyHeaders(policy: McpViewPolicy, hostOrigin: string) {
  const csp = Object.fromEntries(domainKeys.map(key => [key, origins(policy.csp[key])])) as McpViewPolicy['csp'];
  const sources = (items: string[]) => items.length ? items.join(' ') : "'none'";
  const inner = `default-src 'none'; script-src 'unsafe-inline' ${csp.resourceDomains.join(' ')}; style-src 'unsafe-inline' ${csp.resourceDomains.join(' ')}; img-src data: ${csp.resourceDomains.join(' ')}; font-src ${sources(csp.resourceDomains)}; media-src ${sources(csp.resourceDomains)}; connect-src ${sources(csp.connectDomains)}; frame-src ${sources(csp.frameDomains)}; object-src 'none'; base-uri ${sources(csp.baseUriDomains)}; form-action 'none'`;
  const outer = inner.replace(`frame-src ${sources(csp.frameDomains)}`, `frame-src 'self' ${csp.frameDomains.join(' ')}`) + `; frame-ancestors ${hostOrigin}`;
  const mapping = {camera:'camera', microphone:'microphone', geolocation:'geolocation', clipboardWrite:'clipboard-write'};
  const allow = devices.map(device => `${mapping[device]} ${policy.permissions.includes(device) ? '*' : "'none'"}`).join('; ') + "; fullscreen 'none'; payment 'none'; usb 'none'";
  const permissions = devices.map(device => `${mapping[device]}=${policy.permissions.includes(device) ? '*' : '()'}`).join(', ') + ', fullscreen=(), payment=(), usb=()';
  return {inner, outer, allow, permissions};
}
