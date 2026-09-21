import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Clock, X } from '@phosphor-icons/react';
import { FloatingPortal } from './FloatingPortal';

export interface TimePickerProps {
  value?: string; // 'HH:mm'
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  minuteStep?: number; // 1, 5, 10, 15, 30
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const pad = (n: number) => String(n).padStart(2, '0');

const getNowTimeStr = () => {
  const now = new Date();
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
};

export const TimePicker: React.FC<TimePickerProps> = ({
  value = '',
  onChange,
  placeholder = '选择时间',
  disabled = false,
  clearable = true,
  minuteStep = 5,
  className = '',
  size = 'md'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hourListRef = useRef<HTMLDivElement>(null);
  const minuteListRef = useRef<HTMLDivElement>(null);

  // 解析当前时分
  const [selectedHour, selectedMinute] = useMemo(() => {
    if (!value) return [8, 30];
    const parts = value.split(':').map(Number);
    if (parts.length === 2 && !parts.some(isNaN)) {
      return [parts[0], parts[1]];
    }
    return [8, 30];
  }, [value]);

  // 打开弹窗时自动平滑滚动到当前选中的时与分
  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => {
      hourListRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'center' });
      minuteListRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = useMemo(() => {
    const list: number[] = [];
    for (let i = 0; i < 60; i += minuteStep) {
      list.push(i);
    }
    return list;
  }, [minuteStep]);

  const handleSelectHour = (h: number) => {
    const newTime = `${pad(h)}:${pad(selectedMinute)}`;
    onChange?.(newTime);
  };

  const handleSelectMinute = (m: number) => {
    const newTime = `${pad(selectedHour)}:${pad(m)}`;
    onChange?.(newTime);
  };

  const handleSelectNow = () => {
    onChange?.(getNowTimeStr());
    setIsOpen(false);
  };

  const handleClear = () => {
    onChange?.('');
  };

  const sizeClasses = {
    sm: 'h-8 text-xs px-2.5 gap-1.5',
    md: 'h-10 text-xs px-3 gap-2',
    lg: 'h-11 text-sm px-3.5 gap-2.5'
  }[size];

  return (
    <div ref={containerRef} className={`relative inline-block w-full ${className}`}>
      {/* 触发输入框 */}
      <button
        type="button"
        disabled={disabled}
        aria-label={value ? `已选择时间 ${value}` : placeholder}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between border rounded-xl bg-white text-left transition-all duration-150 select-none ${sizeClasses} ${clearable && value ? 'pr-9' : ''} ${
          disabled
            ? 'opacity-50 cursor-not-allowed bg-gray-50 border-gray-200 text-gray-400'
            : isOpen
            ? 'border-neutral-900 ring-2 ring-neutral-900/10 shadow-sm'
            : 'border-neutral-300 hover:border-neutral-900 text-neutral-900'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Clock size={16} className={isOpen ? 'text-neutral-900' : 'text-gray-400'} />
          <span className={`truncate font-mono ${value ? 'text-[#17211d] font-semibold' : 'text-gray-400'}`}>
            {value || placeholder}
          </span>
        </div>

      </button>
      {clearable && value && !disabled && (
        <button
          type="button"
          aria-label="清除时间"
          onClick={handleClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-1 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        >
          <X size={12} weight="bold" />
        </button>
      )}

      {/* 时间滚轮弹出面板 */}
      <FloatingPortal
        open={isOpen}
        anchorRef={containerRef}
        onDismiss={() => setIsOpen(false)}
        width={230}
        ariaLabel="时间选择器"
        className="p-3 overflow-y-auto bg-white rounded-2xl border border-neutral-200 shadow-2xl shadow-black/10 select-none animation-fade-in"
      >
          {/* 面板头部 */}
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-neutral-100">
            <span className="text-xs font-bold text-[#17211d]">选择时间</span>
            <span className="text-xs font-mono font-bold text-neutral-900 bg-neutral-100 px-2 py-0.5 rounded-md">
              {value || `${pad(selectedHour)}:${pad(selectedMinute)}`}
            </span>
          </div>

          {/* 双列时/分选择区 */}
          <div className="grid grid-cols-2 gap-1.5 h-[180px]">
            {/* 小时列 */}
            <div
              ref={hourListRef}
              className="overflow-y-auto pr-1 space-y-1 scrollbar-thin scrollbar-thumb-gray-200"
            >
              {hours.map((h) => {
                const isSel = selectedHour === h;
                return (
                  <button
                    key={h}
                    type="button"
                    data-selected={isSel}
                    onClick={() => handleSelectHour(h)}
                    className={`w-full py-1 rounded-lg text-xs font-mono transition-colors text-center cursor-pointer ${
                      isSel
                        ? 'bg-neutral-900 text-white font-bold shadow-sm'
                        : 'text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900'
                    }`}
                  >
                    {pad(h)}
                  </button>
                );
              })}
            </div>

            {/* 分钟列 */}
            <div
              ref={minuteListRef}
              className="overflow-y-auto pr-1 space-y-1 scrollbar-thin scrollbar-thumb-gray-200"
            >
              {minutes.map((m) => {
                const isSel = selectedMinute === m;
                return (
                  <button
                    key={m}
                    type="button"
                    data-selected={isSel}
                    onClick={() => handleSelectMinute(m)}
                    className={`w-full py-1 rounded-lg text-xs font-mono transition-colors text-center cursor-pointer ${
                      isSel
                        ? 'bg-neutral-900 text-white font-bold shadow-sm'
                        : 'text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900'
                    }`}
                  >
                    {pad(m)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 底部快捷操作 */}
          <div className="flex items-center justify-between pt-2.5 mt-2 border-t border-neutral-100">
            <button
              type="button"
              onClick={handleSelectNow}
              className="text-[11px] font-semibold text-neutral-900 hover:text-neutral-700 transition-colors bg-transparent border-0 p-0 cursor-pointer"
            >
              此时
            </button>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-[11px] font-semibold text-gray-500 hover:text-gray-800 transition-colors bg-transparent border-0 p-0 cursor-pointer"
            >
              完成
            </button>
          </div>
      </FloatingPortal>
    </div>
  );
};
