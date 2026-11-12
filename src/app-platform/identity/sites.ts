/** Employee and administrator sites (`GET /api/platform/sites`); identical unless ADMIN_PUBLIC_BASE_URL is configured. */
export interface PlatformSites { employee: string; admin: string }

let sites: PlatformSites | null = null;
let pending: Promise<PlatformSites> | null = null;
export function loadPlatformSites(): Promise<PlatformSites> {
  if (sites) return Promise.resolve(sites);
  if (!pending) pending = fetchSites().finally(() => { pending = null; });
  return pending;
}

async function fetchSites(): Promise<PlatformSites> {
  const fallback = { employee: window.location.origin, admin: window.location.origin };
  try {
    const response = await fetch('/api/platform/sites', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
    if (response.status === 404) return sites = fallback;
    if (response.ok) {
      const value = await response.json() as PlatformSites;
      if (typeof value?.employee === 'string' && typeof value?.admin === 'string') return sites = value;
    }
  } catch { /* Retry on the next navigation after a transient failure. */ }
  return fallback;
}

/** The site a hash route belongs to, or null when both sites serve it (login, registration). */
function siteFor(hash: string, value: PlatformSites): string | null {
  if (value.admin === value.employee) return null;
  if (/^#\/admin(\/|$)/.test(hash)) return value.admin;
  if (/^#\/employee(\/|$)/.test(hash)) return value.employee;
  return null;
}

/** Sends the browser to the site that owns the current route. Returns true when a redirect was started. */
export async function redirectToOwningSite(): Promise<boolean> {
  const value = await loadPlatformSites(), target = siteFor(window.location.hash, value);
  if (!target || target === window.location.origin) return false;
  window.location.replace(`${target}/${window.location.hash}`);
  return true;
}
