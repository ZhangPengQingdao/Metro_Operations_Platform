import React, { createContext, useContext } from "react";

export type TabsVariant = "line" | "pill";

interface TabsContextValue {
  value: string;
  onChange: (val: string) => void;
  variant: TabsVariant;
}

const TabsContext = createContext<TabsContextValue | null>(null);

export interface TabsProps {
  value: string;
  onChange: (value: string) => void;
  variant?: TabsVariant;
  className?: string;
  children: React.ReactNode;
}

export const Tabs: React.FC<TabsProps> = ({
  value,
  onChange,
  variant = "line",
  className = "",
  children
}) => {
  return (
    <TabsContext.Provider value={{ value, onChange, variant }}>
      <div className={`afc-tabs ${className}`}>{children}</div>
    </TabsContext.Provider>
  );
};

export const TabList: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = "", children }) => {
  const ctx = useContext(TabsContext);
  const variant = ctx?.variant || "line";
  return (
    <div className={`afc-tab-list ${variant === "pill" ? "afc-tab-list--pill" : ""} ${className}`} role="tablist">
      {children}
    </div>
  );
};

export interface TabTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
  badge?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export const TabTrigger: React.FC<TabTriggerProps> = ({
  value,
  badge,
  icon,
  className = "",
  children,
  disabled,
  ...props
}) => {
  const ctx = useContext(TabsContext);
  const isSelected = ctx?.value === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isSelected}
      disabled={disabled}
      className={`afc-tab-trigger ${disabled ? "opacity-40 cursor-not-allowed" : ""} ${className}`}
      onClick={() => ctx?.onChange(value)}
      {...props}
    >
      {icon}
      <span>{children}</span>
      {badge !== undefined && (
        <span className="afc-segment__badge">{badge}</span>
      )}
    </button>
  );
};

export const TabContent: React.FC<{ value: string; className?: string; children: React.ReactNode }> = ({
  value,
  className = "",
  children
}) => {
  const ctx = useContext(TabsContext);
  if (ctx?.value !== value) return null;

  return (
    <div role="tabpanel" className={className}>
      {children}
    </div>
  );
};
