/**
 * Platform - Shared Engineering usePolling Hook (PLATFORM-L2-004)
 * 纯净自适应轮询 Hook，支持页面可见性感知与自动休眠。
 */
import { useEffect, useRef, useState, useCallback } from 'react';

export interface UsePollingOptions {
  interval?: number;
  enabled?: boolean;
  runImmediately?: boolean;
  pauseOnTabHidden?: boolean;
}

export interface UsePollingReturn {
  isPolling: boolean;
  start: () => void;
  stop: () => void;
  triggerNow: () => Promise<void>;
}

export function usePolling(
  callback: () => Promise<any> | void,
  options: UsePollingOptions = {}
): UsePollingReturn {
  const {
    interval = 5000,
    enabled = true,
    runImmediately = true,
    pauseOnTabHidden = true
  } = options;

  const [isPolling, setIsPolling] = useState<boolean>(enabled);
  const callbackRef = useRef(callback);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const triggerNow = useCallback(async () => {
    try {
      await callbackRef.current();
    } catch {
      // 避免轮询异常中断
    }
  }, []);

  const scheduleNext = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(async () => {
      if (pauseOnTabHidden && typeof document !== 'undefined' && document.hidden) {
        // Tab 隐藏时延迟检查
        scheduleNext();
        return;
      }
      await triggerNow();
      scheduleNext();
    }, interval);
  }, [interval, pauseOnTabHidden, triggerNow]);

  const start = useCallback(() => {
    setIsPolling(true);
  }, []);

  const stop = useCallback(() => {
    setIsPolling(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isPolling) {
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    if (runImmediately) {
      void triggerNow();
    }

    scheduleNext();

    const handleVisibilityChange = () => {
      if (pauseOnTabHidden && !document.hidden && isPolling) {
        void triggerNow();
        scheduleNext();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [isPolling, interval, pauseOnTabHidden, runImmediately, scheduleNext, triggerNow]);

  return { isPolling, start, stop, triggerNow };
}
