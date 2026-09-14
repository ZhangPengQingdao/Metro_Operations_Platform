import React, { type AnchorHTMLAttributes } from 'react';
import type { WorkItemReference } from '@metro/platform-sdk';

export interface WorkItemLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  workItem: WorkItemReference;
  href: string;
}

export function WorkItemLink({ workItem, href, children, ...props }: WorkItemLinkProps) {
  if (!isPlatformRelativePath(href)) throw new TypeError('WorkItemLink href must be a platform-relative absolute path.');
  const label = workItem.label?.trim() || workItem.code?.trim() || workItem.id;
  return <a href={href} data-work-item-id={workItem.id} {...props}>{children ?? label}</a>;
}

function isPlatformRelativePath(href: string) {
  if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return false;
  try {
    return new URL(href, 'https://platform.invalid').origin === 'https://platform.invalid';
  } catch {
    return false;
  }
}
