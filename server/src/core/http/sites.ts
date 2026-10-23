/**
 * Employee and administrator sites. With `ADMIN_PUBLIC_BASE_URL` the console lives on its own origin, so its
 * host-only session cookie is never sent with employee-site requests (and app pages cannot reach admin APIs).
 * Without it both sites share PUBLIC_BASE_URL, as before.
 */
export interface PlatformSites { employee: string; admin: string }

/** Origin a browser write must come from: `/api/admin/*` belongs to the administrator site. */
export function expectedOrigin(url: string, sites: { origin: string; adminOrigin?: string }): string {
  return url.startsWith('/api/admin/') || url === '/api/admin' ? sites.adminOrigin ?? sites.origin : sites.origin;
}

export function resolvePlatformSites(employeeOrigin: string, adminBaseUrl: string | undefined): PlatformSites {
  if (!adminBaseUrl) return { employee: employeeOrigin, admin: employeeOrigin };
  const admin = new URL(adminBaseUrl);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(admin.hostname);
  if (admin.origin !== adminBaseUrl.replace(/\/$/, '') || admin.username || admin.password || (admin.protocol !== 'https:' && !(admin.protocol === 'http:' && local)))
    throw new Error('ADMIN_PUBLIC_BASE_URL_INVALID');
  return { employee: employeeOrigin, admin: admin.origin };
}
