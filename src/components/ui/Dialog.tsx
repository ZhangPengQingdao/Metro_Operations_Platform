import React, { useEffect, useId, useRef } from 'react';
import { DialogCloseButton } from './DialogCloseButton';

const joinClasses = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  closeLabel?: string;
  className?: string;
  closeOnBackdropClick?: boolean;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  icon,
  headerAction,
  children,
  footer,
  size = 'md',
  closeLabel = '关闭弹窗',
  className,
  closeOnBackdropClick = true
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      className={joinClasses('afc-dialog', `afc-dialog--${size}`, className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (!closeOnBackdropClick) return;
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const clickedInside = event.clientX >= bounds.left
          && event.clientX <= bounds.right
          && event.clientY >= bounds.top
          && event.clientY <= bounds.bottom;
        if (!clickedInside) onClose();
      }}
    >
      <header className="afc-dialog__header">
        <div className="afc-dialog__heading">
          {icon && <span className="afc-dialog__icon">{icon}</span>}
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {headerAction}
          <DialogCloseButton label={closeLabel} onClick={onClose} />
        </div>
      </header>
      <div className="afc-dialog__body">{children}</div>
      {footer && <footer className="afc-dialog__footer">{footer}</footer>}
    </dialog>
  );
}
