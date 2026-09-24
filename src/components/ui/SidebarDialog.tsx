import React from 'react';
import {Button} from './Button';
import {Dialog,type DialogProps} from './Dialog';

export interface SidebarDialogSection<Id extends string=string> {
  id: Id;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}
export interface SidebarDialogProps<Id extends string=string> extends Omit<DialogProps,'size'> {
  sections: readonly SidebarDialogSection<Id>[];
  activeSection: Id;
  onSectionChange: (id:Id)=>void;
  navigationLabel?: string;
  sectionTitle?: React.ReactNode;
  contentClassName?: string;
}

/** A modal with fixed navigation and independently scrolling content. */
export function SidebarDialog<Id extends string>({sections,activeSection,onSectionChange,navigationLabel,sectionTitle,contentClassName='',className='',children,...dialog}:SidebarDialogProps<Id>){
  const active=sections.find(section=>section.id===activeSection);
  return <Dialog {...dialog} size="xl" className={`afc-sidebar-dialog ${className}`}>
    <div className="afc-sidebar-dialog__layout">
      <nav className="afc-sidebar-dialog__nav" aria-label={navigationLabel??String(dialog.title)}>
        {sections.map(section=><Button key={section.id} type="button" variant="ghost" shape="rounded" disabled={section.disabled} aria-current={activeSection===section.id?'page':undefined} leadingIcon={section.icon} onClick={()=>onSectionChange(section.id)}>{section.label}</Button>)}
      </nav>
      <section className={`afc-sidebar-dialog__content ${contentClassName}`} aria-label={active?.label}>
        <h3 className="afc-sidebar-dialog__title">{sectionTitle??active?.label}</h3>
        {children}
      </section>
    </div>
  </Dialog>;
}
