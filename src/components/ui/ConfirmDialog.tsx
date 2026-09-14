import React from "react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title?: string;
  message: React.ReactNode;
  icon?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "primary";
  loading?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title = "操作确认",
  message,
  icon,
  confirmText = "确定",
  cancelText = "取消",
  variant = "primary",
  loading = false
}) => {
  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      icon={icon}
      footer={
        <>
          <Button
            variant="ghost"
            className="bg-[#f1f5f3] text-[#2d3b33] hover:bg-[#e4ebe7] font-semibold px-5"
            onClick={onClose}
            disabled={loading}
          >
            {cancelText}
          </Button>
          <Button
            variant={variant === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="text-sm text-[#526159] leading-relaxed">
        {message}
      </div>
    </Dialog>
  );
};
