import React from 'react';
import {Link} from 'react-router-dom';

export interface NotificationListItem { id: string; title: string; body?: string; time?: string; unread?: boolean; href?: string; actions?: React.ReactNode }

/** One notification list for the administrator and employee panels. */
export function NotificationList({ items, emptyText = '暂无消息', onNavigate }: { items: NotificationListItem[] | null; emptyText?: string; onNavigate?: () => void }) {
 if (!items) return <p className="afc-notification-empty" role="status">正在加载…</p>;
 if (!items.length) return <p className="afc-notification-empty">{emptyText}</p>;
 return <ul className="afc-notification-list">{items.map(item => {
  const content = <><span className="afc-notification-dot" aria-label={item.unread ? '未读' : undefined}/>
   <div className="afc-notification-content">
   <div className="afc-notification-head"><strong>{item.title}</strong>{item.time && <time>{item.time}</time>}</div>
   {item.body && <p>{item.body}</p>}
   </div></>;
  return <li key={item.id} className={item.unread ? 'is-unread' : undefined}>
   {item.href ? <Link className="afc-notification-row" to={item.href} onClick={onNavigate}>{content}</Link> : <div className="afc-notification-row">{content}</div>}
   {item.actions && <div className="afc-notification-actions">{item.actions}</div>}
  </li>;
 })}</ul>;
}
