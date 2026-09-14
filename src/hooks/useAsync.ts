/**
 * Platform - Shared Engineering useAsync Hook (PLATFORM-L2-004)
 * 纯净通用异步状态机 Hook。
 */
import { useState, useCallback, useRef, useEffect } from 'react';

export interface UseAsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export interface UseAsyncReturn<T, Args extends any[]> extends UseAsyncState<T> {
  execute: (...args: Args) => Promise<T>;
  reset: () => void;
  setData: React.Dispatch<React.SetStateAction<T | null>>;
}

export function useAsync<T, Args extends any[] = []>(
  asyncFn: (...args: Args) => Promise<T>,
  immediate = false,
  initialData: T | null = null
): UseAsyncReturn<T, Args> {
  const [data, setData] = useState<T | null>(initialData);
  const [loading, setLoading] = useState<boolean>(immediate);
  const [error, setError] = useState<Error | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = useCallback(
    async (...args: Args): Promise<T> => {
      setLoading(true);
      setError(null);
      try {
        const result = await asyncFn(...args);
        if (mountedRef.current) {
          setData(result);
          setLoading(false);
        }
        return result;
      } catch (err: any) {
        const parsedError = err instanceof Error ? err : new Error(String(err));
        if (mountedRef.current) {
          setError(parsedError);
          setLoading(false);
        }
        throw parsedError;
      }
    },
    [asyncFn]
  );

  const reset = useCallback(() => {
    setData(initialData);
    setLoading(false);
    setError(null);
  }, [initialData]);

  useEffect(() => {
    if (immediate) {
      void execute(...([] as unknown as Args)).catch(() => {});
    }
  }, [immediate, execute]);

  return { data, loading, error, execute, reset, setData };
}
