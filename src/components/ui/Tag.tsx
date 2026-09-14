import React from "react";
import { X } from "@phosphor-icons/react";

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  selected?: boolean;
  interactive?: boolean;
  onRemove?: () => void;
  children: React.ReactNode;
}

export const Tag: React.FC<TagProps> = ({
  selected = false,
  interactive = false,
  onRemove,
  className = "",
  children,
  onClick,
  onKeyDown,
  ...props
}) => {
  const isInteractive = interactive || Boolean(onClick);
  const classes = [
    "afc-tag",
    selected ? "afc-tag--selected" : "",
    isInteractive ? "afc-tag--interactive" : "",
    className
  ].filter(Boolean).join(" ");

  return (
    <span
      className={classes}
      onClick={onClick}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented && isInteractive && onClick && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      {...props}
    >
      <span>{children}</span>
      {onRemove && (
        <button
          type="button"
          className="afc-tag__close"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="移除标签"
        >
          <X size={12} weight="bold" />
        </button>
      )}
    </span>
  );
};
