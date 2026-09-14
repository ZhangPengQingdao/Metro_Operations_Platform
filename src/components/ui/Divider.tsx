import React from "react";

export interface DividerProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
  orientation?: "horizontal" | "vertical";
}

export const Divider: React.FC<DividerProps> = ({
  label,
  orientation = "horizontal",
  className = "",
  ...props
}) => {
  if (orientation === "vertical") {
    return <div className={`inline-block w-px self-stretch bg-gray-200 mx-3 ${className}`} role="separator" {...props} />;
  }

  return (
    <div className={`afc-divider ${className}`} role="separator" {...props}>
      {label && <span className="afc-divider__label">{label}</span>}
    </div>
  );
};
