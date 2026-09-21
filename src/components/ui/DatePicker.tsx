import React, { useState, useRef, useEffect, useMemo } from 'react';
import { CalendarDots, CaretLeft, CaretRight, X } from '@phosphor-icons/react';
import { FloatingPortal } from './FloatingPortal';

export interface DatePickerProps {
  value?: string; // 'YYYY-MM-DD'
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  minDate?: string;
  maxDate?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const pad = (n: number) => String(n).padStart(2, '0');
const toDateStr = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

const getTodayStr = () => {
  const now = new Date();
  return toDateStr(now.getFullYear(), now.getMonth(), now.getDate());
};

export const DatePicker: React.FC<DatePickerProps> = ({
  value = '',
  onChange,
  placeholder = '选择日期',
  disabled = false,
  clearable = true,
  minDate,
  maxDate,
  className = '',
  size = 'md'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 解析当前选中的年月日
  const parsedValue = useMemo(() => {
    if (!value) return null;
    const parts = value.split('-').map(Number);
    if (parts.length === 3 && !parts.some(isNaN)) {
      return { year: parts[0], month: parts[1] - 1, day: parts[2] };
    }
    return null;
  }, [value]);

  // 当前日历视图所在的年与月
  const [viewDate, setViewDate] = useState(() => {
    if (parsedValue) {
      return new Date(parsedValue.year, parsedValue.month, 1);
    }
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });

  // 当外部 value 变更且有效时，同步视图年月
  useEffect(() => {
    if (parsedValue) {
      setViewDate(new Date(parsedValue.year, parsedValue.month, 1));
    }
  }, [parsedValue]);

  const viewYear = viewDate.getFullYear();
  const viewMonth = viewDate.getMonth();
  const todayStr = getTodayStr();

  // 月份导航
  const handlePrevMonth = () => {
    setViewDate(new Date(viewYear, viewMonth - 1, 1));
  };
  const handleNextMonth = () => {
    setViewDate(new Date(viewYear, viewMonth + 1, 1));
  };
  const handlePrevYear = () => {
    setViewDate(new Date(viewYear - 1, viewMonth, 1));
  };
  const handleNextYear = () => {
    setViewDate(new Date(viewYear + 1, viewMonth, 1));
  };

  // 生成 42 天日历网格
  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const dayOfWeek = firstDay.getDay(); // 0 = 周日
    const startDate = new Date(viewYear, viewMonth, 1 - dayOfWeek);

    const days = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const dateStr = toDateStr(d.getFullYear(), d.getMonth(), d.getDate());
      const isCurrentMonth = d.getMonth() === viewMonth;
      const isToday = dateStr === todayStr;
      const isSelected = dateStr === value;
      const isDisabled = Boolean((minDate && dateStr < minDate) || (maxDate && dateStr > maxDate));

      days.push({
        date: d,
        dateStr,
        dayNum: d.getDate(),
        isCurrentMonth,
        isToday,
        isSelected,
        isDisabled
      });
    }
    return days;
  }, [viewYear, viewMonth, value, todayStr, minDate, maxDate]);

  const handleSelectDay = (dateStr: string, disabledDay?: boolean) => {
    if (disabledDay || disabled) return;
    onChange?.(dateStr);
    setIsOpen(false);
  };

  const handleSelectToday = () => {
    if (disabled) return;
    onChange?.(todayStr);
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
        aria-label={value ? `已选择日期 ${value}` : placeholder}
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
          <CalendarDots size={16} className={isOpen ? 'text-neutral-900' : 'text-gray-400'} />
          <span className={`truncate font-mono ${value ? 'text-[#17211d] font-semibold' : 'text-gray-400'}`}>
            {value || placeholder}
          </span>
        </div>

      </button>
      {clearable && value && !disabled && (
        <button
          type="button"
          aria-label="清除日期"
          onClick={handleClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-1 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        >
          <X size={12} weight="bold" />
        </button>
      )}

      {/* 日历弹出面板 */}
      <FloatingPortal
        open={isOpen}
        anchorRef={containerRef}
        onDismiss={() => setIsOpen(false)}
        width={292}
        ariaLabel="日期选择器"
        className="p-3.5 overflow-y-auto bg-white rounded-2xl border border-neutral-200 shadow-2xl shadow-black/10 select-none animation-fade-in"
      >
          {/* 头部年份与月份切换 */}
          <div className="flex items-center justify-between pb-2.5 mb-2 border-b border-neutral-100">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handlePrevYear}
                title="上一年"
                className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              >
                <CaretLeft size={13} weight="bold" />
              </button>
              <button
                type="button"
                onClick={handlePrevMonth}
                title="上个月"
                className="p-1 rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
              >
                <CaretLeft size={15} weight="bold" />
              </button>
            </div>

            <div className="font-bold text-xs text-[#17211d] tracking-wide">
              {viewYear}年 {viewMonth + 1}月
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleNextMonth}
                title="下个月"
                className="p-1 rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
              >
                <CaretRight size={15} weight="bold" />
              </button>
              <button
                type="button"
                onClick={handleNextYear}
                title="下一年"
                className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              >
                <CaretRight size={13} weight="bold" />
              </button>
            </div>
          </div>

          {/* 星期行 */}
          <div className="grid grid-cols-7 gap-1 text-center mb-1.5">
            {['日', '一', '二', '三', '四', '五', '六'].map((day, idx) => (
              <span
                key={day}
                className="text-[11px] font-semibold text-neutral-400"
              >
                {day}
              </span>
            ))}
          </div>

          {/* 日期数字网格 (7x6) */}
          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((item) => {
              let btnClass = 'text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900';

              if (item.isSelected) {
                btnClass = 'bg-neutral-900 text-white font-bold shadow-sm hover:bg-neutral-800';
              } else if (item.isToday) {
                btnClass = 'border border-neutral-900 font-bold text-neutral-900 hover:bg-neutral-100';
              } else if (!item.isCurrentMonth) {
                btnClass = 'text-neutral-300 hover:bg-neutral-50 hover:text-neutral-500';
              }

              if (item.isDisabled) {
                btnClass = 'text-neutral-200 cursor-not-allowed opacity-40 hover:bg-transparent';
              }

              return (
                <button
                  key={item.dateStr}
                  type="button"
                  disabled={item.isDisabled}
                  aria-label={item.dateStr}
                  aria-pressed={item.isSelected}
                  onClick={() => handleSelectDay(item.dateStr, item.isDisabled)}
                  className={`w-8 h-8 rounded-full text-xs font-mono flex items-center justify-center transition-all duration-100 cursor-pointer ${btnClass}`}
                >
                  {item.dayNum}
                </button>
              );
            })}
          </div>

          {/* 底部快捷操作栏 */}
          <div className="flex items-center justify-between pt-2.5 mt-2.5 border-t border-neutral-100">
            <button
              type="button"
              onClick={handleSelectToday}
              className="text-[11px] font-semibold text-neutral-900 hover:text-neutral-700 transition-colors bg-transparent border-0 p-0 cursor-pointer"
            >
              今天
            </button>
            {value && (
              <button
                type="button"
                onClick={() => onChange?.('')}
                className="text-[11px] font-semibold text-gray-400 hover:text-red-500 transition-colors bg-transparent border-0 p-0 cursor-pointer"
              >
                清空
              </button>
            )}
          </div>
      </FloatingPortal>
    </div>
  );
};
