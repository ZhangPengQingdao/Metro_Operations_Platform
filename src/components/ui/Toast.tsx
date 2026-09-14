import React, { createContext, useContext, useState, useCallback } from "react";
import { CheckCircle, Warning, WarningCircle, Info, X } from "@phosphor-icons/react";

export type ToastType = "success" | "warning" | "danger" | "info";

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

export interface ToastContextValue {
  show: (message: string, type?: ToastType, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((message: string, type: ToastType = "info", duration = 3000) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, type, message, duration }]);

    if (duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, duration);
    }
  }, [removeToast]);

  const success = useCallback((msg: string, dur?: number) => show(msg, "success", dur), [show]);
  const warning = useCallback((msg: string, dur?: number) => show(msg, "warning", dur), [show]);
  const error = useCallback((msg: string, dur?: number) => show(msg, "danger", dur), [show]);
  const info = useCallback((msg: string, dur?: number) => show(msg, "info", dur), [show]);

  const toastIcons: Record<ToastType, React.ReactNode> = {
    success: <CheckCircle size={18} className="text-emerald-400" weight="fill" />,
    warning: <Warning size={18} className="text-amber-400" weight="fill" />,
    danger: <WarningCircle size={18} className="text-rose-400" weight="fill" />,
    info: <Info size={18} className="text-blue-400" weight="fill" />
  };

  return (
    <ToastContext.Provider value={{ show, success, warning, error, info }}>
      {children}
      <div className="afc-toast-container" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`afc-toast afc-toast--${t.type}`} role="status">
            {toastIcons[t.type]}
            <span className="flex-1">{t.message}</span>
            <button
              type="button"
              className="text-gray-400 hover:text-white ml-2 transition-colors"
              onClick={() => removeToast(t.id)}
              aria-label="关闭"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      show: (msg) => console.log("[Toast]", msg),
      success: (msg) => console.log("[Toast Success]", msg),
      warning: (msg) => console.log("[Toast Warning]", msg),
      error: (msg) => console.error("[Toast Error]", msg),
      info: (msg) => console.log("[Toast Info]", msg)
    };
  }
  return ctx;
};
