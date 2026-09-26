import type {AppManifest} from '@metro/platform-sdk/app-manifest';
import {readThemePreference,saveThemePreference} from '../identity/theme';
import {SettingsSections} from './SettingsSections';
import React, {useEffect, useId, useRef, useState, type ReactNode} from 'react';
import {NavLink, useLocation} from 'react-router-dom';
import {PlatformIcon,IconButton,Select,Dialog,Button,type PlatformIconName} from '../../components/ui';

export interface AdminUser {id: string; username: string; displayName: string}
export interface AdminApplication {id: string; name: string; icon?: AppManifest['icon']; navigation: {id: string; label: string; path: string}[]}
export interface AdminShellProps {
  mode?:'admin'|'employee';
  user: AdminUser; applications: AdminApplication[]; children: ReactNode; onLogout: () => Promise<void>;
  profileContent?: ReactNode | ((onSaved:()=>void,onBusy:(busy:boolean)=>void)=>ReactNode); settingsContent?: ReactNode; notificationsContent?: ReactNode;
}
const navigation = [
  {path: '/admin', label: '系统总览', icon: 'grid' as PlatformIconName},
  {path: '/admin/apps', label: '应用管理', icon: 'cube' as PlatformIconName},
  {path: '/admin/data', label: '基础数据', icon: 'database' as PlatformIconName},
  {path: '/admin/accounts', label: '账号与权限', icon: 'users' as PlatformIconName},
  {path: '/admin/developer', label: '开发者中心', icon: 'terminal' as PlatformIconName},
];
const dataNavigation:AdminApplication={id:'platform-data',name:'基础数据',navigation:[
 ['people','人员'],['organizations','组织与工班'],['positions','岗位'],['lines','线路'],['locations','车站与位置'],['asset-systems','设备系统'],['asset-categories','设备分类'],['asset-types','设备类型'],['assets','设备'],['dictionaries','公共字典']
].map(([id,label])=>({id,label,path:`/admin/data/${id}`}))};
const accountNavigation:AdminApplication={id:'platform-accounts',name:'账号与权限',navigation:[{id:'administrators',label:'管理员账号',path:'/admin/accounts'},{id:'employees',label:'员工账号',path:'/admin/accounts/employees'},{id:'registrations',label:'注册审核',path:'/admin/accounts/registrations'}]};
export function applicationNavigation(pathname: string, applications: AdminApplication[],base='/admin') {
  const app = applications.find(item => pathname === `${base}/app/${encodeURIComponent(item.id)}` || pathname.startsWith(`${base}/app/${encodeURIComponent(item.id)}/`));
  if (!app) return undefined;
  const prefix = `${base}/app/${encodeURIComponent(app.id)}`;
  const items = app.navigation.filter(item => (item.path === prefix || item.path.startsWith(`${prefix}/`)) && !/[\\?#]/.test(item.path) && !item.path.split('/').some(segment => segment === '..' || segment === '.'));
  return items.length ? {...app, navigation: items} : undefined;
}

export function AdminDialog({title, children, onClose, className}: {title: string; children: ReactNode; onClose: () => void; className?:string}) {
  return <Dialog open title={title} onClose={onClose} size="lg" className={className}>{children}</Dialog>;
}

export function AdminShell({mode='admin',user, applications, children, onLogout, profileContent, settingsContent, notificationsContent}: AdminShellProps) {
  const {pathname} = useLocation();
  const base=mode==='admin'?'/admin':'/employee';
  const primary=mode==='admin'?navigation:[{path:'/employee',label:'工作台',icon:'grid' as PlatformIconName},{path:'/employee/apps',label:'应用管理',icon:'cube' as PlatformIconName}];
  const [collapsed, setCollapsed] = useState(false);
  const [navigationMode, setNavigationMode] = useState<'primary' | 'secondary'>('secondary');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [panel, setPanel] = useState<'profile' | 'settings' | 'preferences' | 'notifications' | null>(null);
  const [theme, setTheme] = useState(readThemePreference);
  const [confirmLogout,setConfirmLogout]=useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');
  const [panelBusy,setPanelBusy]=useState(false),[notice,setNotice]=useState('');
  const savedPanel=()=>{setPanel(null);setNotice('已保存。');};
  const account = useRef<HTMLDivElement>(null);
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const app = pathname==='/admin/data'||pathname.startsWith('/admin/data/') ? dataNavigation : pathname==='/admin/accounts'||pathname.startsWith('/admin/accounts/')?accountNavigation:applicationNavigation(pathname, applications,base);
  const secondary = Boolean(app) && navigationMode !== 'primary';
  const rail = !secondary && collapsed;
  const toggleNavigation = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (app) {setNavigationMode('secondary'); setCollapsed(false);}
  };
  useEffect(() => {setMobileOpen(false); setAccountOpen(false);}, [pathname]);
  useEffect(() => {setNavigationMode('secondary'); setCollapsed(false);}, [app?.id]);
  useEffect(() => {
    if (!accountOpen) return;
    const close = (event: PointerEvent) => {if (!account.current?.contains(event.target as Node)) setAccountOpen(false);};
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [accountOpen]);
  const openPanel = (value: typeof panel) => {setAccountOpen(false); accountTrigger.current?.focus(); setNotice('');setPanelBusy(false);setPanel(value);};
  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true); setError('');
    try {await onLogout();} catch (cause) {setError(cause instanceof Error ? cause.message : '退出登录失败，请重试');} finally {setLoggingOut(false);}
  };
  const title = app?.name || primary.find(item => item.path === base ? pathname === item.path : pathname.startsWith(item.path))?.label || '运管开放平台';
  return <div className="afc-admin afc-theme-neutral" data-theme={theme} data-rail={rail} data-secondary={secondary}>
    <a className="afc-skip-link" href="#admin-main">跳至主要内容</a>
    {mobileOpen && <button type="button" className="afc-mobile-backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)}/>}
    <aside className={`afc-sidebar-island${mobileOpen ? ' is-open' : ''}`} aria-label="平台导航" onKeyDown={event => {if (event.key === 'Escape') setMobileOpen(false);}}>
      <div className="afc-platform-sidebar">
        <div className="afc-sidebar-header">
          <button className="afc-brand" aria-label={rail ? '展开侧边栏' : '运管开放平台'} onClick={() => setCollapsed(false)}>
            <span className="afc-brand-mark"><img src="/brand/afc-logo-green.svg" alt=""/><span><PlatformIcon name="panelLeft" size={23}/></span></span>
            {!rail && <span className="afc-brand-name">运管开放平台</span>}
          </button>
          {!rail && <IconButton size="sm" type="button" label={secondary ? "返回一级菜单" : "收起侧边栏"} onClick={() => {if(secondary)setNavigationMode('primary');else setCollapsed(true);}}><PlatformIcon name={secondary ? "arrowLeft" : "panelLeft"} size={18}/></IconButton>}
        </div>
        {secondary && app ? <nav key="secondary" className="afc-sidebar-nav afc-sidebar-nav--secondary" aria-label={`${app.name}导航`}>{app.navigation.map(item => <NavLink key={item.id} to={item.path} end className={({isActive}) => `afc-nav-link${isActive ? ' is-active' : ''}`}>{item.label}</NavLink>)}</nav> : <nav key="primary" className="afc-sidebar-nav afc-sidebar-nav--primary" aria-label={mode==='admin'?'管理功能':'工作导航'}>
          {primary.map(({path, label, icon}) => <NavLink key={path} to={path} end={path === base} onClick={event => {if(path === base ? pathname === path : pathname === path || pathname.startsWith(`${path}/`)) toggleNavigation(event);}} aria-label={label} title={rail ? label : undefined} className={({isActive}) => `afc-nav-link${isActive ? ' is-active' : ''}`}><PlatformIcon name={icon} size={20}/>{!rail && <span>{label}</span>}</NavLink>)}
          {applications.length > 0 && <div className="afc-app-links">{!rail && <p>应用</p>}{applications.map(item => <NavLink key={item.id} to={applicationNavigation(`${base}/app/${encodeURIComponent(item.id)}`, [item],base)?.navigation[0]?.path || `${base}/app/${encodeURIComponent(item.id)}`} aria-label={item.name} onClick={event => {if(app?.id===item.id)toggleNavigation(event);}} title={rail ? item.name : undefined} className={`afc-nav-link${app?.id===item.id ? ' is-active' : ''}`}><ApplicationIcon icon={item.icon}/>{!rail && <span>{item.name}</span>}</NavLink>)}</div>}
        </nav>}
        <div className="afc-sidebar-bottom">
          <div className="afc-account" ref={account} onKeyDown={event => {if (event.key === 'Escape') {setAccountOpen(false); accountTrigger.current?.focus();}}}>
            <button ref={accountTrigger} type="button" className="afc-account-trigger" aria-label="个人中心" aria-expanded={accountOpen} onClick={() => setAccountOpen(!accountOpen)}><span className="afc-admin-avatar">{(user.displayName || user.username).slice(0, 1)}</span>{!rail && <span>{user.displayName || user.username}</span>}</button>
            {accountOpen && <div className="afc-account-popover"><div className="afc-account-summary"><strong>{user.displayName || user.username}</strong><span>{user.username}</span></div>
              <button onClick={() => openPanel('profile')}><PlatformIcon name="userCircle" size={18}/>个人资料</button>{mode==='admin'&&<button onClick={() => openPanel('settings')}><PlatformIcon name="cog" size={18}/>系统设置</button>}<button onClick={() => openPanel('preferences')}><PlatformIcon name="sun" size={18}/>外观偏好</button><hr/><button disabled={loggingOut} onClick={()=>{setAccountOpen(false);setError('');setConfirmLogout(true);}}><PlatformIcon name="login" size={18}/>{loggingOut ? '正在退出…' : '退出登录'}</button>{error && <p role="alert" className="afc-error">{error}</p>}
            </div>}
          </div>
          <IconButton size="sm" type="button" label="通知" onClick={() => openPanel('notifications')}><PlatformIcon name="bell" size={20}/></IconButton>
        </div>
      </div>

    </aside>
    <div className="afc-admin-workspace"><header className="afc-page-header"><IconButton size="sm" type="button" className="afc-mobile-toggle" label={mobileOpen ? '关闭导航' : '打开导航'} aria-expanded={mobileOpen} onClick={() => setMobileOpen(!mobileOpen)}><PlatformIcon name="panelLeft" size={22}/></IconButton><span>{title}</span></header><main id="admin-main" className="afc-admin-main" tabIndex={-1}>{notice&&<p role="status">{notice}</p>}{children}</main></div>
    <Dialog open={confirmLogout} title="退出登录" size="sm" onClose={()=>{if(!loggingOut)setConfirmLogout(false);}} footer={<><Button variant="secondary" disabled={loggingOut} onClick={()=>setConfirmLogout(false)}>取消</Button><Button disabled={loggingOut} onClick={logout}>{loggingOut?'正在退出…':'退出登录'}</Button></>}><p>确定退出当前账号吗？</p>{error&&<p role="alert" className="afc-error">{error}</p>}</Dialog>
    {panel && <AdminDialog className={panel==='profile'?'afc-profile-dialog':panel==='settings'?'afc-profile-dialog afc-sidebar-dialog':undefined} title={{profile: '个人中心', settings: '系统设置', preferences: '外观偏好', notifications: '通知'}[panel]} onClose={() => {if(!panelBusy)setPanel(null);}}>
      {panel === 'profile' && ((typeof profileContent==='function'?profileContent(savedPanel,setPanelBusy):profileContent) ?? <dl className="afc-details"><dt>用户名</dt><dd>{user.username}</dd><dt>显示名称</dt><dd>{user.displayName}</dd></dl>)}
      {panel === 'settings' && (settingsContent ?? <SettingsSections onSaved={savedPanel} onBusy={setPanelBusy}/>)}
      {panel === 'notifications' && (notificationsContent ?? <p className="afc-muted">通知服务暂不可用。</p>)}
      {panel === 'preferences' && <div className="afc-settings-content"><label className="afc-setting-row">外观<Select value={theme} onChange={event => (()=>{const next=event.target.value as typeof theme;saveThemePreference(next);setTheme(next);})()}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></Select></label></div>}
    </AdminDialog>}
  </div>;
}

function ApplicationIcon({icon}:{icon?:AppManifest['icon']}) {
 return icon ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icon.paths.map((d,i)=><path key={i} d={d}/>)}</svg> : <PlatformIcon name="cube" size={20}/>;
}
