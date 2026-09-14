import React from 'react';

const joinClasses = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

export interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

export const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(function Surface({
  padding = 'md',
  className,
  ...props
}, ref) {
  return <div ref={ref} className={joinClasses('afc-surface', `afc-surface--${padding}`, className)} {...props} />;
});

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: React.ReactNode;
  title?: React.ReactNode;
  description: React.ReactNode;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div className={joinClasses('afc-empty-state', className)} {...props}>
      {icon && <span className="afc-empty-state__icon">{icon}</span>}
      {title && <h3>{title}</h3>}
      <p>{description}</p>
      {action && <div className="afc-empty-state__action">{action}</div>}
    </div>
  );
}
