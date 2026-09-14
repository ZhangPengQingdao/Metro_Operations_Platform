/**
 * Platform - Shared Engineering useClipboard Hook (PLATFORM-L2-004)
 * 响应式剪贴板复制 Hook。
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { copyToClipboard } from '../utils/clipboard';

export interface UseClipboardReturn {
  copied: boolean;
  copy: (text: string) => Promise<boolean>;
}

export function useClipboard(timeout = 2000): UseClipboardReturn {
  const [copied, setCopied] = useState<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      const success = await copyToClipboard(text);
      if (success) {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          setCopied(false);
        }, timeout);
      }
      return success;
    },
    [timeout]
  );

  return { copied, copy };
}
