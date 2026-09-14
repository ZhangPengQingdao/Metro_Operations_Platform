import React from 'react';
import { X } from '@phosphor-icons/react';
import { IconButton, type IconButtonProps } from './Button';

export interface DialogCloseButtonProps
  extends Omit<IconButtonProps, 'children' | 'label' | 'variant'> {
  label?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
}

export const DialogCloseButton = React.forwardRef<HTMLButtonElement, DialogCloseButtonProps>(
  function DialogCloseButton({ label = '关闭弹窗', size = 'sm', className, ...props }, ref) {
    return (
      <IconButton
        ref={ref}
        label={label}
        size={size}
        variant="ghost"
        className={['afc-dialog-close', className].filter(Boolean).join(' ')}
        {...props}
      >
        <X size={18} weight="bold" aria-hidden="true" />
      </IconButton>
    );
  }
);
