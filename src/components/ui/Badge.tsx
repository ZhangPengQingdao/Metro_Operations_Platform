import React from "react";

export type BadgeVariant =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral"
  | "apricot"
  | "amber";
export type BadgeSize = "sm" | "md" | "lg";

const VARIANT_MAP: Record<BadgeVariant, { bg: string; text: string }> = {
  apricot: { bg: "#fef3e7", text: "#b45309" },
  warning: { bg: "#fef3e7", text: "#b45309" },
  amber: { bg: "#fef8e7", text: "#926305" },
  info: { bg: "#eaf2fe", text: "#2563eb" },
  success: { bg: "#e8f8f0", text: "#0b7548" },
  danger: { bg: "#feeeee", text: "#c53024" },
  neutral: { bg: "#edf3f0", text: "#47564f" }
};

const SIZE_MAP: Record<BadgeSize, { height: string; padding: string; fontSize: string }> = {
  sm: { height: "22px", padding: "0 9px", fontSize: "11px" },
  md: { height: "26px", padding: "0 12px", fontSize: "12px" },
  lg: { height: "30px", padding: "0 14px", fontSize: "13px" }
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
  outline?: boolean;
  leadingIcon?: React.ReactNode;
  children: React.ReactNode;
}

export const Badge: React.FC<BadgeProps> = ({
  variant = "neutral",
  size = "md",
  dot = false,
  outline = false,
  leadingIcon,
  className = "",
  style,
  children,
  ...props
}) => {
  const vStyle = VARIANT_MAP[variant] || VARIANT_MAP.neutral;
  const sStyle = SIZE_MAP[size] || SIZE_MAP.md;

  const combinedStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "5px",
    borderRadius: "9999px",
    backgroundColor: vStyle.bg,
    color: vStyle.text,
    height: sStyle.height,
    padding: sStyle.padding,
    fontSize: sStyle.fontSize,
    fontWeight: 550,
    lineHeight: 1,
    whiteSpace: "nowrap",
    boxSizing: "border-box",
    border: "none",
    ...style
  };

  return (
    <span
      className={`afc-badge afc-badge--${size} afc-badge--${variant} ${className}`}
      style={combinedStyle}
      {...props}
    >
      {dot && (
        <span
          className="afc-badge__dot"
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            backgroundColor: "currentColor",
            flexShrink: 0
          }}
          aria-hidden="true"
        />
      )}
      {leadingIcon && (
        <span
          className="afc-badge__icon"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "13px",
            lineHeight: 1,
            flexShrink: 0
          }}
          aria-hidden="true"
        >
          {leadingIcon}
        </span>
      )}
      <span>{children}</span>
    </span>
  );
};
