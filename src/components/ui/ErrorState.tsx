import React from "react";
import { WarningCircle, ArrowsClockwise } from "@phosphor-icons/react";
import { Button } from "./Button";

export interface ErrorStateProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  retryText?: string;
  onRetry?: () => void;
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title = "加载失败或数据异常",
  description = "服务暂时无法返回有效数据，请检查网络连接或稍后重试。",
  icon,
  retryText = "重新加载",
  onRetry,
  className = "",
  ...props
}) => {
  return (
    <div className={`afc-error-state ${className}`} role="alert" {...props}>
      <div className="afc-error-state__icon">
        {icon ?? <WarningCircle size={28} weight="fill" />}
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" leadingIcon={<ArrowsClockwise size={15} />} onClick={onRetry}>
          {retryText}
        </Button>
      )}
    </div>
  );
};
