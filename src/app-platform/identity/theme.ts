export type ThemePreference='light'|'dark'|'system';
const key='mop.theme';
export function readThemePreference():ThemePreference{
 try{const value=localStorage.getItem(key);return value==='light'||value==='dark'?value:'system';}catch{return 'system';}
}
export function saveThemePreference(value:ThemePreference){try{localStorage.setItem(key,value);}catch{/* Storage is optional. */}}

export function resolveEffectiveTheme(pref: ThemePreference): 'light'|'dark' {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

const THEME_COLORS = { light: '#fafafa', dark: '#121212' } as const;

export function applyBrowserChromeTheme(effective: 'light'|'dark') {
  if (typeof document === 'undefined') return;
  const color = THEME_COLORS[effective];
  const head = document.head;
  head.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = color;
  head.appendChild(meta);
  document.documentElement.dataset.mopTheme = effective;
  document.documentElement.style.colorScheme = effective;
}
