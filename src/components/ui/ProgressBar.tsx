import React, { useId, ReactNode } from 'react';

export type ProgressTone = 'primary' | 'success' | 'info' | 'warning' | 'danger' | 'purple' | 'neutral' | 'gradient';
export type ProgressSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type ProgressLabelPosition = 'top' | 'right' | 'inside' | 'bottom';

export interface ProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 当前数值 (0 到 max) */
  value?: number;
  /** 最大数值，默认 100 */
  max?: number;
  /** 最小数值，默认 0 */
  min?: number;
  /** 尺寸: xs(4px), sm(6px), md(8px), lg(12px), xl(16px) */
  size?: ProgressSize;
  /** 色系/主题 */
  tone?: ProgressTone;
  /** 别名：色系/主题 */
  variant?: ProgressTone;
  /** 是否展示数值文本 */
  showLabel?: boolean;
  /** 顶部或底部标题/描述 */
  label?: ReactNode;
  /** 标签展示位置: top | right | inside | bottom */
  labelPosition?: ProgressLabelPosition;
  /** 自定义格式化标签文本 */
  formatLabel?: (value: number, max: number, percent: number) => ReactNode;
  /** 是否带斑马斜条纹 */
  striped?: boolean;
  /** 斑马斜条纹或光泽动画 */
  animated?: boolean;
  /** 无限循环加载态 (未定进度) */
  indeterminate?: boolean;
  /** 圆角风格 */
  rounded?: 'none' | 'sm' | 'md' | 'full';
  /** 轨道自定义样式 */
  trackClassName?: string;
  /** 进度条填充层自定义样式 */
  barClassName?: string;
}

const SIZE_MAP: Record<ProgressSize, { height: string; fontSize: string }> = {
  xs: { height: 'h-1', fontSize: 'text-[10px]' },
  sm: { height: 'h-1.5', fontSize: 'text-[11px]' },
  md: { height: 'h-2', fontSize: 'text-xs' },
  lg: { height: 'h-3.5', fontSize: 'text-xs' },
  xl: { height: 'h-5', fontSize: 'text-xs' }
};

const TONE_BAR_CLASSES: Record<ProgressTone, string> = {
  primary: 'bg-emerald-600',
  success: 'bg-emerald-500',
  info: 'bg-sky-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  purple: 'bg-purple-600',
  neutral: 'bg-slate-500',
  gradient: 'bg-gradient-to-r from-emerald-600 via-teal-500 to-sky-500'
};

const TONE_TEXT_CLASSES: Record<ProgressTone, string> = {
  primary: 'text-emerald-700 font-semibold',
  success: 'text-emerald-600 font-semibold',
  info: 'text-sky-600 font-semibold',
  warning: 'text-amber-700 font-semibold',
  danger: 'text-red-600 font-semibold',
  purple: 'text-purple-600 font-semibold',
  neutral: 'text-slate-600 font-semibold',
  gradient: 'text-emerald-700 font-semibold'
};

const ROUNDED_MAP: Record<string, string> = {
  none: 'rounded-none',
  sm: 'rounded',
  md: 'rounded-md',
  full: 'rounded-full'
};

export const ProgressBar = React.forwardRef<HTMLDivElement, ProgressBarProps>(({
  value = 0,
  max = 100,
  min = 0,
  size = 'md',
  tone,
  variant = 'primary',
  showLabel = false,
  label,
  labelPosition,
  formatLabel,
  striped = false,
  animated = false,
  indeterminate = false,
  rounded = 'full',
  className = '',
  trackClassName = '',
  barClassName = '',
  'aria-label': ariaLabel,
  ...rest
}, ref) => {
  const currentTone = tone || variant;
  const clampedValue = Math.min(Math.max(value, min), max);
  const range = Math.max(max - min, 1);
  const percent = Math.round(((clampedValue - min) / range) * 100);

  let resolvedPosition: ProgressLabelPosition = labelPosition || (label ? 'top' : (showLabel ? 'right' : 'top'));
  if (resolvedPosition === 'inside' && size !== 'lg' && size !== 'xl') {
    resolvedPosition = 'right';
  }

  const labelContent = formatLabel
    ? formatLabel(clampedValue, max, percent)
    : `${percent}%`;

  const sizeCfg = SIZE_MAP[size];
  const roundedClass = ROUNDED_MAP[rounded] || 'rounded-full';
  const barBgClass = TONE_BAR_CLASSES[currentTone] || TONE_BAR_CLASSES.primary;
  const textClass = TONE_TEXT_CLASSES[currentTone] || TONE_TEXT_CLASSES.primary;

  const barStyle: React.CSSProperties = indeterminate
    ? { width: '100%' }
    : { width: `${percent}%` };

  return (
    <div
      ref={ref}
      className={`afc-progress-root w-full flex flex-col gap-1.5 ${className}`}
      {...rest}
    >
      {resolvedPosition === 'top' && (label || showLabel) && (
        <div className="flex items-center justify-between gap-2 text-xs">
          {label ? (
            <span className="font-medium text-gray-700 truncate">{label}</span>
          ) : (
            <span className="sr-only">Progress</span>
          )}
          {showLabel && (
            <span className={`font-mono text-xs tabular-nums ml-auto shrink-0 ${textClass}`}>
              {labelContent}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <div
          role="progressbar"
          aria-valuenow={indeterminate ? undefined : clampedValue}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-label={ariaLabel || (typeof label === 'string' ? label : undefined)}
          className={`afc-progress-track relative w-full overflow-hidden bg-[#e4ede7] transition-all ${sizeCfg.height} ${roundedClass} ${trackClassName}`}
        >
          <div
            style={barStyle}
            className={`afc-progress-bar h-full transition-all duration-300 ease-out flex items-center justify-center ${roundedClass} ${barBgClass} ${
              striped ? 'afc-progress-bar--striped' : ''
            } ${animated ? 'afc-progress-bar--animated' : ''} ${
              indeterminate ? 'afc-progress-bar--indeterminate' : ''
            } ${barClassName}`}
          >
            {resolvedPosition === 'inside' && (size === 'lg' || size === 'xl') && percent >= 15 && (
              <span className="text-[10px] font-bold text-white font-mono tabular-nums px-1.5 select-none truncate">
                {labelContent}
              </span>
            )}
          </div>
        </div>

        {resolvedPosition === 'right' && showLabel && (
          <span className={`font-mono text-xs tabular-nums shrink-0 ${textClass}`}>
            {labelContent}
          </span>
        )}
      </div>

      {resolvedPosition === 'bottom' && (label || showLabel) && (
        <div className="flex items-center justify-between gap-2 text-xs text-gray-500 mt-0.5">
          {label && <span className="truncate">{label}</span>}
          {showLabel && (
            <span className={`font-mono text-xs tabular-nums ml-auto shrink-0 ${textClass}`}>
              {labelContent}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

ProgressBar.displayName = 'ProgressBar';

export interface CircularProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
  min?: number;
  size?: number;
  strokeWidth?: number;
  tone?: ProgressTone;
  variant?: ProgressTone;
  showLabel?: boolean;
  formatLabel?: (value: number, max: number, percent: number) => ReactNode;
  indeterminate?: boolean;
  trackColor?: string;
  children?: ReactNode;
}

const TONE_STROKE_COLORS: Record<ProgressTone, string> = {
  primary: '#0ba66a',
  success: '#10b981',
  info: '#0ea5e9',
  warning: '#f59e0b',
  danger: '#ef4444',
  purple: '#8b5cf6',
  neutral: '#64748b',
  gradient: '#0ba66a'
};

export const CircularProgress = React.forwardRef<HTMLDivElement, CircularProgressProps>(({
  value = 0,
  max = 100,
  min = 0,
  size = 56,
  strokeWidth = 5,
  tone,
  variant = 'primary',
  showLabel = true,
  formatLabel,
  indeterminate = false,
  trackColor = '#e4ede7',
  children,
  className = '',
  ...rest
}, ref) => {
  const gradientId = useId();
  const currentTone = tone || variant;
  const clampedValue = Math.min(Math.max(value, min), max);
  const range = Math.max(max - min, 1);
  const percent = Math.round(((clampedValue - min) / range) * 100);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = indeterminate ? circumference * 0.25 : circumference - (percent / 100) * circumference;

  const strokeColor = TONE_STROKE_COLORS[currentTone] || TONE_STROKE_COLORS.primary;
  const textClass = TONE_TEXT_CLASSES[currentTone] || TONE_TEXT_CLASSES.primary;

  const labelContent = formatLabel
    ? formatLabel(clampedValue, max, percent)
    : `${percent}%`;

  return (
    <div
      ref={ref}
      className={`inline-flex items-center justify-center relative select-none ${className}`}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : clampedValue}
      aria-valuemin={min}
      aria-valuemax={max}
      {...rest}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={indeterminate ? 'animate-spin' : '-rotate-90 transform'}
      >
        {currentTone === 'gradient' && (
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#0ba66a" />
              <stop offset="50%" stopColor="#14b8a6" />
              <stop offset="100%" stopColor="#0284c7" />
            </linearGradient>
          </defs>
        )}

        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={trackColor}
          strokeWidth={strokeWidth}
        />

        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={currentTone === 'gradient' ? `url(#${gradientId})` : strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          className="transition-all duration-300 ease-out"
        />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-1">
        {children ? (
          children
        ) : (
          showLabel && (
            <span className={`text-[11px] font-mono font-bold tabular-nums leading-none ${textClass}`}>
              {labelContent}
            </span>
          )
        )}
      </div>
    </div>
  );
});

CircularProgress.displayName = 'CircularProgress';

export interface StepItem {
  title: string;
  description?: string;
}

export interface StepProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  steps: StepItem[];
  currentStep: number;
  tone?: ProgressTone;
}

export const StepProgress: React.FC<StepProgressProps> = ({
  steps,
  currentStep,
  tone = 'primary',
  className = '',
  ...rest
}) => {
  return (
    <div className={`w-full ${className}`} {...rest}>
      <div className="flex items-center w-full">
        {steps.map((step, idx) => {
          const isCompleted = idx < currentStep;
          const isCurrent = idx === currentStep;
          const isLast = idx === steps.length - 1;

          return (
            <React.Fragment key={idx}>
              <div className="flex flex-col items-center relative group flex-1">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-mono font-bold transition-all z-10 ${
                    isCompleted
                      ? 'bg-emerald-600 text-white shadow-sm ring-4 ring-emerald-50'
                      : isCurrent
                      ? 'bg-white text-emerald-700 border-2 border-emerald-600 ring-4 ring-emerald-50'
                      : 'bg-[#f1f5f3] text-gray-400 border border-gray-200'
                  }`}
                >
                  {isCompleted ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    idx + 1
                  )}
                </div>

                <div className="mt-2 text-center max-w-[100px]">
                  <div className={`text-xs font-medium truncate ${
                    isCompleted || isCurrent ? 'text-gray-900 font-semibold' : 'text-gray-400'
                  }`}>
                    {step.title}
                  </div>
                  {step.description && (
                    <div className="text-[10px] text-gray-400 truncate mt-0.5">
                      {step.description}
                    </div>
                  )}
                </div>
              </div>

              {!isLast && (
                <div
                  className={`flex-1 h-0.5 -mt-6 transition-all ${
                    idx < currentStep ? 'bg-emerald-600' : 'bg-gray-200'
                  }`}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default ProgressBar;
