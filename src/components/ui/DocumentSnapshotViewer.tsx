import React, { useRef } from 'react';
import { Badge, type BadgeVariant } from './Badge';
import { Button } from './Button';
import { triggerPrint } from '../../utils/print';

export type SnapshotSectionType = 'list' | 'kpi-grid' | 'timeline' | 'key-value' | 'quiz' | 'custom';

export interface DocumentMetadataItem {
  label: string;
  value: React.ReactNode;
  colSpan?: number;
}

export interface DocumentSignatureItem {
  name: string;
  role?: string;
  signTime?: string;
  status?: string;
  statusVariant?: 'success' | 'warning' | 'info' | 'neutral' | 'danger';
  signText?: string;
  signatureUrl?: string;
  remark?: string;
}

export interface DocumentSection {
  id?: string;
  title: string;
  type?: SnapshotSectionType;
  icon?: React.ReactNode;
  borderTone?: 'emerald' | 'amber' | 'blue' | 'gray';
  listItems?: (string | React.ReactNode)[];
  kpiItems?: { label: string; value: string | number; rating?: string; tone?: 'emerald' | 'amber' | 'blue' | 'red' }[];
  timelineItems?: { time: string; title: string; desc?: string }[];
  keyValuePairs?: { key: string; value: React.ReactNode }[];
  quizItems?: { question: string; answer: string; note?: string }[];
  content?: React.ReactNode;
}

export interface DocumentSnapshotSchema {
  title: string;
  subtitle?: string;
  orgName?: string;
  docCode?: string;
  statusBadge?: { text: string; variant?: BadgeVariant };
  metadata?: DocumentMetadataItem[];
  sections: DocumentSection[];
  signatures?: DocumentSignatureItem[];
  footerNote?: string;
}

export interface DocumentSnapshotViewerProps {
  data: DocumentSnapshotSchema;
  className?: string;
  showToolbar?: boolean;
  onPrint?: () => void;
  onExportPdf?: () => void;
  onExportWord?: () => void;
  customActions?: React.ReactNode;
}

export const DocumentSnapshotViewer: React.FC<DocumentSnapshotViewerProps> = ({
  data,
  className = '',
  showToolbar = true,
  onPrint,
  onExportPdf,
  onExportWord,
  customActions
}) => {
  const printableRef = useRef<HTMLDivElement>(null);
  const {
    title,
    subtitle,
    orgName,
    docCode,
    statusBadge,
    metadata = [],
    sections = [],
    signatures = [],
    footerNote
  } = data;

  const handleDefaultPrint = () => {
    if (onPrint) {
      onPrint();
      return;
    }

    triggerPrint(printableRef.current, { title });
  };

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Optional Top Action Toolbar */}
      {showToolbar && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 bg-[#f8faf9] rounded-2xl border border-[#e3ece7]">
          <div className="flex items-center gap-2 min-w-0">
            {statusBadge && (
              <Badge variant={statusBadge.variant || 'success'} size="sm">
                {statusBadge.text}
              </Badge>
            )}
            <span className="text-xs text-gray-700 font-semibold truncate">
              {docCode ? `[${docCode}] ` : ''}{title}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {customActions}
            <Button
              variant="secondary"
              size="sm"
              onClick={handleDefaultPrint}
            >
              🖨️ A4 纯净打印预览
            </Button>
            {onExportPdf && (
              <Button
                variant="primary"
                size="sm"
                onClick={onExportPdf}
              >
                导出 PDF
              </Button>
            )}
            {onExportWord && (
              <Button
                variant="primary"
                size="sm"
                onClick={onExportWord}
              >
                导出 Word
              </Button>
            )}
          </div>
        </div>
      )}

      {/* High-Fidelity Paper Document Canvas */}
      <div ref={printableRef} className="bg-white p-6 sm:p-8 rounded-2xl border border-[#d0ded6] shadow-sm space-y-6">
        {/* Document Header */}
        <div className="text-center border-b border-[#e3ece7] pb-5">
          {orgName && (
            <div className="text-[11px] font-bold text-emerald-800 tracking-wider uppercase mb-1">
              {orgName}
            </div>
          )}
          <h2 className="text-xl sm:text-2xl font-black text-gray-900 tracking-tight">
            {title}
          </h2>
          {subtitle && (
            <p className="text-xs text-gray-500 mt-1">
              {subtitle}
            </p>
          )}

          {/* Metadata Row / Grid */}
          {metadata.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mt-3.5 text-xs text-gray-600 font-mono">
              {metadata.map((item, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="text-gray-400">{item.label}:</span>
                  <strong className="text-gray-800 font-medium">{item.value}</strong>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Dynamic Sections */}
        <div className="space-y-5">
          {sections.map((section, sIdx) => {
            const borderClass =
              section.borderTone === 'amber'
                ? 'border-amber-500 text-amber-950'
                : section.borderTone === 'blue'
                ? 'border-blue-500 text-blue-950'
                : section.borderTone === 'gray'
                ? 'border-gray-400 text-gray-900'
                : 'border-emerald-600 text-emerald-950';

            return (
              <div key={section.id || sIdx} className="space-y-3">
                <div className={`text-xs font-bold border-l-4 pl-2.5 flex items-center gap-2 ${borderClass}`}>
                  {section.icon}
                  <span>{section.title}</span>
                </div>

                {/* Section Type: list */}
                {section.type === 'list' && section.listItems && (
                  <div className="p-4 bg-[#f8faf9] rounded-xl border border-[#e3ece7]">
                    <ul className="text-xs text-gray-700 space-y-1.5 list-disc list-inside">
                      {section.listItems.map((item, i) => (
                        <li key={i} className="leading-relaxed">{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Section Type: kpi-grid */}
                {section.type === 'kpi-grid' && section.kpiItems && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                    {section.kpiItems.map((kpi, i) => (
                      <div key={i} className="p-3 bg-[#f8faf9] rounded-xl border border-[#e3ece7] text-center space-y-1">
                        <div className="text-[11px] text-gray-500">{kpi.label}</div>
                        <div className="text-xs font-bold text-emerald-800 font-mono">{kpi.value}</div>
                        {kpi.rating && (
                          <div className="text-[10px] text-gray-400">{kpi.rating}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Section Type: timeline */}
                {section.type === 'timeline' && section.timelineItems && (
                  <div className="space-y-2">
                    {section.timelineItems.map((step, i) => (
                      <div key={i} className="flex items-start gap-3 p-3 bg-[#f8faf9] rounded-xl border border-[#e3ece7]">
                        <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[11px] font-mono font-bold shrink-0">
                          {step.time}
                        </span>
                        <div className="text-xs">
                          <span className="font-bold text-gray-900 mr-2">{step.title}</span>
                          {step.desc && <span className="text-gray-600">{step.desc}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Section Type: quiz */}
                {section.type === 'quiz' && section.quizItems && (
                  <div className="space-y-2.5">
                    {section.quizItems.map((q, i) => (
                      <div key={i} className="p-3.5 bg-emerald-50/50 rounded-xl border border-emerald-100 space-y-1.5 text-xs">
                        <div className="font-bold text-emerald-950">Q: {q.question}</div>
                        <div className="text-gray-700 bg-white p-2.5 rounded-lg border border-emerald-200/60">
                          A: {q.answer}
                        </div>
                        {q.note && <div className="text-[11px] text-gray-400">备注: {q.note}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Section Type: key-value */}
                {section.type === 'key-value' && section.keyValuePairs && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {section.keyValuePairs.map((kv, i) => (
                      <div key={i} className="p-3 bg-[#f8faf9] rounded-xl border border-[#e3ece7] text-xs flex items-center justify-between">
                        <span className="text-gray-500">{kv.key}</span>
                        <strong className="text-gray-900">{kv.value}</strong>
                      </div>
                    ))}
                  </div>
                )}

                {/* Custom Content Slot */}
                {section.content}
              </div>
            );
          })}
        </div>

        {/* Signatures Grid */}
        {signatures.length > 0 && (
          <div className="space-y-3 pt-2">
            <div className="text-xs font-bold text-gray-800 border-l-4 border-emerald-600 pl-2.5">
              签名记录
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {signatures.map((sig, i) => (
                <div key={i} className="p-3.5 bg-[#f8faf9] rounded-xl border border-[#e3ece7] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-gray-900">{sig.name}</span>
                    {sig.status && (
                      <Badge variant={sig.statusVariant || 'success'} size="sm">
                        {sig.status}
                      </Badge>
                    )}
                  </div>
                  {sig.role && <div className="text-[11px] text-gray-500">{sig.role}</div>}
                  <div className="h-10 bg-white rounded-lg border border-dashed border-emerald-300 flex items-center justify-center text-emerald-800 font-serif italic text-base">
                    {sig.signText || sig.name}
                  </div>
                  {sig.signTime && (
                    <div className="text-[10px] text-gray-400 font-mono text-right">{sig.signTime}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer Note */}
        {footerNote && (
          <div className="border-t border-[#e3ece7] pt-3 text-right text-[11px] text-gray-400 font-mono">
            {footerNote}
          </div>
        )}
      </div>
    </div>
  );
};
