import React from "react";

export type AvatarSize = "sm" | "md" | "lg";
export type AvatarShape = "circle" | "rounded";

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string;
  name?: string;
  size?: AvatarSize | number;
  shape?: AvatarShape;
  alt?: string;
}

const AVATAR_SIZE_MAP: Record<AvatarSize, number> = {
  sm: 28,
  md: 36,
  lg: 48
};

export const Avatar: React.FC<AvatarProps> = ({
  src,
  name,
  size = "md",
  shape = "circle",
  alt,
  className = "",
  style,
  ...props
}) => {
  const getInitials = (text?: string) => {
    if (!text) return "";
    const trimmed = text.trim();
    if (!trimmed) return "";
    // 默认展示姓氏单字（首字）
    return trimmed.slice(0, 1).toUpperCase();
  };

  const pixelSize =
    typeof size === "number"
      ? size
      : AVATAR_SIZE_MAP[size as AvatarSize] || AVATAR_SIZE_MAP.md;
  const fontSize = Math.max(10, Math.round(pixelSize * 0.45));

  const customStyle: React.CSSProperties = {
    ...style,
    ["--afc-avatar-size" as string]: `${pixelSize}px`,
    width: `${pixelSize}px`,
    height: `${pixelSize}px`,
    minWidth: `${pixelSize}px`,
    minHeight: `${pixelSize}px`,
    maxWidth: `${pixelSize}px`,
    maxHeight: `${pixelSize}px`,
    fontSize: `${fontSize}px`
  };

  const classes = [
    "afc-avatar",
    typeof size === "string" ? `afc-avatar--${size}` : "",
    `afc-avatar--${shape}`,
    className
  ].filter(Boolean).join(" ");

  return (
    <div className={classes} title={name} style={customStyle} {...props}>
      {src ? (
        <img src={src} alt={alt || name || "Avatar"} className="afc-avatar__img" />
      ) : (
        <span>{getInitials(name) || "?"}</span>
      )}
    </div>
  );
};

export interface AvatarGroupProps {
  children: React.ReactNode;
  max?: number;
  size?: AvatarSize;
  className?: string;
}

export const AvatarGroup: React.FC<AvatarGroupProps> = ({
  children,
  max,
  size = "md",
  className = ""
}) => {
  const childArray = React.Children.toArray(children);
  const visibleChildren = max ? childArray.slice(0, max) : childArray;
  const overflow = max ? childArray.length - max : 0;

  const spaceClass = size === "sm" ? "-space-x-1.5" : size === "lg" ? "-space-x-2.5" : "-space-x-2";

  return (
    <div className={`flex items-center ${spaceClass} ${className}`}>
      {visibleChildren.map((child, index) => {
        if (React.isValidElement<AvatarProps>(child)) {
          return React.cloneElement(child, {
            size: child.props.size || size,
            key: child.key || index
          });
        }
        return child;
      })}
      {overflow > 0 && (
        <Avatar
          name={`+${overflow}`}
          size={size}
          className="bg-emerald-100 text-emerald-850 font-bold border-2 border-white select-none"
        />
      )}
    </div>
  );
};
