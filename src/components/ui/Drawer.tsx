import React, { useEffect } from "react";
import { X } from "@phosphor-icons/react";
import { IconButton } from "./Button";

export interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const Drawer: React.FC<DrawerProps> = ({
  isOpen,
  onClose,
  title,
  description,
  footer,
  children,
  className = ""
}) => {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => {
        document.body.style.overflow = "";
        window.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="afc-drawer-backdrop" onClick={onClose} aria-modal="true" role="dialog">
      <div className={`afc-drawer ${className}`} onClick={(e) => e.stopPropagation()}>
        <div className="afc-drawer__header">
          <div>
            <h2 className="afc-drawer__title">{title}</h2>
            {description && <p className="text-xs text-gray-500 mt-1">{description}</p>}
          </div>
          <IconButton
            label="关闭抽屉"
            size="sm"
            variant="ghost"
            className="text-gray-400 hover:text-gray-700 p-1 rounded-lg transition-colors"
            onClick={onClose}
          >
            <X size={20} weight="bold" />
          </IconButton>
        </div>
        <div className="afc-drawer__body">
          {children}
        </div>
        {footer && (
          <div className="afc-drawer__footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
