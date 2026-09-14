import React from 'react';
import { CaretDown } from '@phosphor-icons/react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const joinClasses = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

const buttonVariantClass: Record<ButtonVariant, string> = {
  primary: 'afc-button--primary',
  secondary: 'afc-button--secondary',
  ghost: 'afc-button--ghost',
  danger: 'afc-button--danger',
  soft: 'afc-button--soft'
};

const buttonSizeClass: Record<ButtonSize, string> = {
  xs: 'afc-button--xs',
  sm: 'afc-button--sm',
  md: 'afc-button--md',
  lg: 'afc-button--lg'
};

export type ButtonShape = 'pill' | 'rounded';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  fullWidth?: boolean;
  loading?: boolean;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'primary',
  size = 'md',
  shape = 'pill',
  fullWidth = false,
  loading = false,
  leadingIcon,
  trailingIcon,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={joinClasses(
        'afc-button',
        buttonVariantClass[variant],
        buttonSizeClass[size],
        `afc-button--${shape}`,
        fullWidth && 'afc-button--full',
        className
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <span className="afc-button__spinner" aria-hidden="true" /> : leadingIcon}
      <span className="afc-button__label">{children}</span>
      {!loading && trailingIcon}
    </button>
  );
});

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  label,
  size = 'md',
  variant = 'ghost',
  className,
  children,
  type = 'button',
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={joinClasses(
        'afc-icon-button',
        {
          xs: 'afc-icon-button--xs',
          sm: 'afc-icon-button--sm',
          md: 'afc-icon-button--md',
          lg: 'afc-icon-button--lg'
        }[size],
        {
          primary: 'afc-icon-button--primary',
          secondary: 'afc-icon-button--secondary',
          ghost: 'afc-icon-button--ghost',
          danger: 'afc-icon-button--danger',
          soft: 'afc-icon-button--soft'
        }[variant],
        className
      )}
      aria-label={label}
      title={props.title ?? label}
      {...props}
    >
      {children}
    </button>
  );
});

export interface ButtonGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  shape?: ButtonShape;
  children: React.ReactNode;
}

export const ButtonGroup: React.FC<ButtonGroupProps> = ({ shape = 'pill', className, children, ...props }) => {
  return (
    <div className={joinClasses('afc-button-group', `afc-button-group--${shape}`, className)} role="group" {...props}>
      {children}
    </div>
  );
};

export interface NavItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  label: string;
  active?: boolean;
  badge?: React.ReactNode;
  open?: boolean;
  isGroup?: boolean;
}

export const NavItem = React.forwardRef<HTMLButtonElement, NavItemProps>(function NavItem({
  icon,
  label,
  active = false,
  badge,
  open = false,
  isGroup = false,
  className = '',
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={joinClasses(
        'afc-nav-item',
        active && 'is-active',
        className
      )}
      {...props}
    >
      {icon && <span className="afc-nav-item__icon">{icon}</span>}
      <span className="afc-nav-item__label">{label}</span>
      {badge !== undefined && badge !== null && (
        React.isValidElement(badge) ? (
          badge
        ) : (
          <span className="afc-nav-item__badge">{badge}</span>
        )
      )}
      {isGroup && (
        <CaretDown
          size={14}
          weight="bold"
          className={joinClasses('afc-nav-item__caret', open && 'rotate-180', 'transition-transform duration-200')}
        />
      )}
    </button>
  );
});

export interface NavSubItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export const NavSubItem = React.forwardRef<HTMLButtonElement, NavSubItemProps>(function NavSubItem({
  label,
  active = false,
  className = '',
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={joinClasses(
        'afc-nav-sub-item',
        active && 'is-active',
        className
      )}
      {...props}
    >
      <span>{label}</span>
    </button>
  );
});
