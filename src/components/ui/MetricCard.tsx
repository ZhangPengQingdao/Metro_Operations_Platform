import React, { useMemo } from "react";

export type MetricCardTone =
  | "danger"
  | "green"
  | "blue"
  | "warm"
  | "neutral"
  | "success"
  | "warning"
  | "info"
  | "purple";

export interface MetricCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: string;
  title?: string;
  value: React.ReactNode;
  unit?: string;
  icon?: React.ReactNode;
  delta?: React.ReactNode;
  subtitle?: React.ReactNode;
  tone?: MetricCardTone;
  trend?: number[];
  sparkline?: number[];
  stroke?: string;
}

const defaultStrokes: Record<string, string> = {
  danger: "#e84a3a",
  green: "#0ba66a",
  success: "#0ba66a",
  blue: "#367fd3",
  info: "#367fd3",
  warm: "#93623f",
  warning: "#e6a11b",
  neutral: "#66736c",
  purple: "#8b5cf6"
};

const Sparkline: React.FC<{ values?: number[]; stroke: string }> = ({ values = [2, 3, 2, 5, 3, 6, 5], stroke }) => {
  const path = useMemo(() => {
    const normalized = values && values.length ? values : [2, 3, 2, 5, 3, 6, 5];
    const max = Math.max(...normalized);
    const min = Math.min(...normalized);
    const range = Math.max(max - min, 1);
    const points = normalized.map((value, index) => {
      const x = normalized.length === 1 ? 30 : 2 + index * (56 / (normalized.length - 1));
      const y = 18 - ((value - min) / range) * 14;
      return { x, y };
    });
    return points.slice(1).reduce((result, point, index) => {
      const previous = points[index];
      const middleX = (previous.x + point.x) / 2;
      return `${result} C${middleX.toFixed(1)} ${previous.y.toFixed(1)}, ${middleX.toFixed(1)} ${point.y.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    }, `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`);
  }, [values]);

  return (
    <svg className="afc-metric-card__sparkline" viewBox="0 0 60 20" aria-hidden="true">
      <path d={path} fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

export const MetricCard: React.FC<MetricCardProps> = ({
  label,
  title,
  value,
  unit,
  icon,
  delta,
  subtitle,
  tone = "green",
  trend,
  sparkline,
  stroke,
  className = "",
  ...props
}) => {
  const displayLabel = label || title || "";
  const displayDelta = delta || subtitle;
  const cardStroke = stroke || defaultStrokes[tone] || "#0ba66a";
  const trendData = sparkline || trend;

  return (
    <div
      className={`afc-metric-card afc-metric-card--${tone} ${className}`}
      role="article"
      tabIndex={props.onClick ? 0 : undefined}
      {...props}
    >
      {/* 1. Left circular solid badge icon */}
      <div className="afc-metric-card__icon">
        {icon}
      </div>

      {/* 2. Middle title, value+unit, delta */}
      <div className="afc-metric-card__copy">
        <span className="afc-metric-card__label" title={typeof displayLabel === 'string' ? displayLabel : undefined}>
          {displayLabel}
        </span>
        <div className="afc-metric-card__value-wrap">
          <span className="afc-metric-card__value">{value}</span>
          {unit && <small className="afc-metric-card__unit">{unit}</small>}
        </div>
        {displayDelta && (
          <span className="afc-metric-card__delta" title={typeof displayDelta === 'string' ? displayDelta : undefined}>
            {displayDelta}
          </span>
        )}
      </div>

      {/* 3. Right side smooth sparkline wave */}
      {trendData && trendData.length > 0 && (
        <Sparkline values={trendData} stroke={cardStroke} />
      )}
    </div>
  );
};
