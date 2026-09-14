/**
 * Platform - Shared Engineering useThrottle Hook (PLATFORM-L2-004)
 * 纯净高频节流 Hook。
 */
import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * 获取节流延迟更新的状态值
 */
export function useThrottle<T>(value: T, interval: number): T {
  const [throttledValue, setThrottledValue] = useState<T>(value);
  const lastExecuted = useRef<number>(Date.now());

  useEffect(() => {
    if (Date.now() >= lastExecuted.current + interval) {
      lastExecuted.current = Date.now();
      setThrottledValue(value);
    } else {
      const timer = setTimeout(() => {
        lastExecuted.current = Date.now();
        setThrottledValue(value);
      }, interval);

      return () => clearTimeout(timer);
    }
  }, [value, interval]);

  return throttledValue;
}

/**
 * 获取经过节流包装的回调函数
 */
export function useThrottledCallback<T extends (...args: any[]) => any>(
  callback: T,
  interval: number
): (...args: Parameters<T>) => void {
  const callbackRef = useRef(callback);
  const lastRanRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return useCallback(
    (...args: Parameters<T>) => {
      const now = Date.now();
      if (now - lastRanRef.current >= interval) {
        lastRanRef.current = now;
        callbackRef.current(...args);
      } else {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          lastRanRef.current = Date.now();
          callbackRef.current(...args);
        }, interval - (now - lastRanRef.current));
      }
    },
    [interval]
  );
}
