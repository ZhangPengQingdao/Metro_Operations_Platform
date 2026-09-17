export type ThemePreference='light'|'dark'|'system';
const key='mop.theme';
export function readThemePreference():ThemePreference{
 try{const value=localStorage.getItem(key);return value==='light'||value==='dark'?value:'system';}catch{return 'system';}
}
export function saveThemePreference(value:ThemePreference){try{localStorage.setItem(key,value);}catch{/* Storage is optional. */}}
