import React from 'react';
import { readThemePreference } from './theme';

/** Sign-in, registration and password screens: brand panel and a form column. */
export function AuthLayout({ title, subtitle, wide = false, children }: { title: string; subtitle?: string; wide?: boolean; children: React.ReactNode }) {
 return <main className="afc-admin afc-theme-neutral afc-auth" data-theme={readThemePreference()}>
  <aside className="afc-auth-brand" aria-hidden="true">
   <span className="afc-auth-logo afc-auth-brand__mark"/>
   <div className="afc-auth-brand__name">运管开放平台</div>
   <div className="afc-auth-brand__en">Metro Operations Platform</div>
  </aside>
  <section className="afc-auth-panel">
   <div className={`afc-auth-card${wide ? ' afc-auth-card--wide' : ''}`}>
    <header className="afc-auth-heading"><span className="afc-auth-logo afc-auth-heading__logo" aria-hidden="true"/><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</header>
    {children}
   </div>
  </section>
 </main>;
}
