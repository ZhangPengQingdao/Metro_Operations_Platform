import React from "react";
import { CheckCircle, Warning, WarningCircle, Info, X } from "@phosphor-icons/react";
import { IconButton } from "./Button";

export type AlertVariant = "success" | "warning" | "danger" | "info";

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  variant?: AlertVariant;
  title?: React.ReactNode;
  icon?: React.ReactNode;
  onClose?: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}

const defaultIcons: Record<AlertVariant, React.ReactNode> = {
  success: <CheckCircle size={20} weight="fill" />,
  warning: <Warning size={20} weight="fill" />,
  danger: <WarningCircle size={20} weight="fill" />,
  info: <Info size={20} weight="fill" />
};

export const Alert: React.FC<AlertProps> = ({
  variant = "info",
  title,
  icon,
  onClose,
  action,
  className = "",
  children,
  ...props
}) => {
  return (
    <div className={`afc-alert afc-alert--${variant} ${className}`} role="alert" {...props}>
      <div className="afc-alert__icon">
        {icon ?? defaultIcons[variant]}
      </div>
      <div className="afc-alert__content">
        {title && <div className="afc-alert__title">{title}</div>}
        <div>{children}</div>
        {action && <div className="mt-2">{action}</div>}
      </div>
      {onClose && (
        <IconButton
          label="关闭提示"
          size="sm"
          variant="ghost"
          className="afc-alert__close"
          onClick={onClose}
        >
          <X size={16} weight="bold" />
        </IconButton>
      )}
    </div>
  );
};
