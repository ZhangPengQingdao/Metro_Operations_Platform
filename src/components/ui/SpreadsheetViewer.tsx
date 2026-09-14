import React, { useRef, useState } from 'react';
import { Button } from './Button';
import { Badge } from './Badge';
import { exportToExcel } from '../../utils/excel';
import { triggerPrint } from '../../utils/print';

export interface SpreadsheetSheetData {
  name: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

export interface SpreadsheetViewerProps {
  filename?: string;
  fileSize?: string;
  fileType?: 'xlsx' | 'csv' | 'xls';
  sheets: Record<string, SpreadsheetSheetData> | SpreadsheetSheetData[];
  defaultSheet?: string;
  onSheetChange?: (sheetName: string) => void;
  onUploadFile?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  showUploadButton?: boolean;
  showExportButton?: boolean;
  showPrintButton?: boolean;
  isUploading?: boolean;
  maxHeight?: string;
  className?: string;
}

export const SpreadsheetViewer: React.FC<SpreadsheetViewerProps> = ({
  filename = '数据工作簿.xlsx',
  fileSize,
  fileType = 'xlsx',
  sheets,
  defaultSheet,
  onSheetChange,
  onUploadFile,
  showUploadButton = false,
  showExportButton = true,
  showPrintButton = true,
  isUploading = false,
  maxHeight = '420px',
  className = ''
}) => {
  const printableRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  // Normalize sheets to record
  const sheetsRecord: Record<string, SpreadsheetSheetData> = React.useMemo(() => {
    if (Array.isArray(sheets)) {
      const rec: Record<string, SpreadsheetSheetData> = {};
      sheets.forEach(s => {
        rec[s.name] = s;
      });
      return rec;
    }
    return sheets;
  }, [sheets]);

  const sheetNames = Object.keys(sheetsRecord);
  const [activeSheetName, setActiveSheetName] = useState<string>(
    defaultSheet && sheetsRecord[defaultSheet] ? defaultSheet : sheetNames[0] || 'Sheet1'
  );

  // Sync if defaultSheet changes
  React.useEffect(() => {
    if (defaultSheet && sheetsRecord[defaultSheet]) {
      setActiveSheetName(defaultSheet);
    } else if (sheetNames.length > 0 && !sheetsRecord[activeSheetName]) {
      setActiveSheetName(sheetNames[0]);
    }
  }, [defaultSheet, sheetsRecord]);

  const currentSheet = sheetsRecord[activeSheetName] || {
    name: activeSheetName,
    headers: [],
    rows: []
  };

  const colLabels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

  const handleTabClick = (sName: string) => {
    setActiveSheetName(sName);
    onSheetChange?.(sName);
  };

  const handleExport = () => {
    const exportData = currentSheet.rows.map((row) => {
      const obj: Record<string, any> = {};
      currentSheet.headers.forEach((h, i) => {
        obj[h] = row[i] ?? '';
      });
      return obj;
    });

    const baseName = filename.replace(/\.[^/.]+$/, '');
    exportToExcel({
      filename: `${baseName}_${currentSheet.name}.xlsx`,
      sheetName: currentSheet.name,
      data: exportData,
      columns: currentSheet.headers.map((h) => ({ key: h, header: h, width: 16 }))
    });
  };

  const handlePrint = () => {
    triggerPrint(printableRef.current, { title: `${filename}_${currentSheet.name}` });
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Optional Upload / Switcher Header */}
      {showUploadButton && (
        <div className="flex items-center justify-between gap-3 p-3 bg-[#f8faf9] rounded-2xl border border-[#e3ece7]">
          <div className="flex items-center gap-2">
            <Badge variant="success" size="sm">
              {fileType.toUpperCase()} 工作簿
            </Badge>
            <span className="text-xs text-gray-700 font-bold truncate">{filename}</span>
          </div>

          <div>
            <input
              ref={uploadInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={onUploadFile}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={isUploading}
              onClick={() => uploadInputRef.current?.click()}
            >
              {isUploading ? '解析中...' : '上传本地文件在线预览'}
            </Button>
          </div>
        </div>
      )}

      {/* Main Excel Workbench Frame */}
      <div ref={printableRef} className="border border-[#d0ded6] rounded-2xl overflow-hidden bg-white shadow-sm">
        {/* Top Status Toolbar */}
        <div className="bg-[#f2f7f4] border-b border-[#d0ded6] px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-bold text-xs shadow-2xs shrink-0 font-mono">
              {fileType === 'xlsx' ? 'X' : fileType === 'csv' ? 'C' : 'S'}
            </div>
            <div className="min-w-0 truncate">
              <div className="text-xs font-bold text-gray-900 truncate flex items-center gap-2">
                <span>{filename}</span>
                {fileSize && <span className="text-[11px] font-normal text-gray-400">({fileSize})</span>}
              </div>
              <div className="text-[11px] text-gray-500 flex items-center gap-2 mt-0.5">
                <span>当前工作表: <strong className="text-emerald-700 font-medium">{currentSheet.name}</strong></span>
                <span>•</span>
                <span>共 {currentSheet.rows.length} 行数据</span>
                <span>•</span>
                <span>共 {currentSheet.headers.length} 列</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {showPrintButton && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handlePrint}
              >
                🖨️ A4 打印预览
              </Button>
            )}
            {showExportButton && (
              <Button
                variant="primary"
                size="sm"
                onClick={handleExport}
              >
                导出当前工作表 (.xlsx)
              </Button>
            )}
          </div>
        </div>

        {/* Spreadsheet Table Grid */}
        <div
          className="overflow-x-auto overflow-y-auto no-scrollbar"
          style={{ maxHeight }}
        >
          <table className="w-full text-xs text-left border-collapse font-mono">
            {/* Column Letter Headers (A, B, C...) */}
            <thead>
              <tr className="bg-[#f0f4f2] border-b border-[#d0ded6] text-gray-500 select-none">
                <th className="w-12 px-2 py-1.5 text-center bg-[#e8efec] border-r border-[#d0ded6] font-bold text-[11px] text-gray-400">
                  fx
                </th>
                {currentSheet.headers.map((_, colIdx) => (
                  <th
                    key={colIdx}
                    className="px-3 py-1.5 text-center border-r border-[#d0ded6] font-bold text-[11px] text-gray-500 min-w-[120px]"
                  >
                    {colLabels[colIdx] || `C${colIdx + 1}`}
                  </th>
                ))}
              </tr>
              {/* Row 1: Field Names */}
              <tr className="bg-[#f7faf8] border-b-2 border-[#b8cdc1] font-bold text-gray-800">
                <td className="px-2 py-2 text-center bg-[#e8efec] border-r border-[#d0ded6] text-gray-400 font-bold select-none text-[11px]">
                  1
                </td>
                {currentSheet.headers.map((h, colIdx) => (
                  <td
                    key={colIdx}
                    className="px-3 py-2 border-r border-[#d0ded6] bg-[#eef7f2] text-emerald-950 font-bold whitespace-nowrap"
                  >
                    {h}
                  </td>
                ))}
              </tr>
            </thead>

            {/* Data Rows */}
            <tbody className="divide-y divide-[#e3ece7]">
              {currentSheet.rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="hover:bg-[#f2faf5] transition-colors">
                  <td className="px-2 py-2 text-center bg-[#f4f7f5] border-r border-[#d0ded6] text-gray-400 font-medium select-none text-[11px]">
                    {rowIdx + 2}
                  </td>
                  {currentSheet.headers.map((_, colIdx) => {
                    const cellVal = row[colIdx];
                    return (
                      <td
                        key={colIdx}
                        className="px-3 py-2 border-r border-[#e3ece7] text-gray-700 whitespace-nowrap font-sans"
                      >
                        {cellVal !== undefined && cellVal !== null ? String(cellVal) : '-'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Excel Multi-Sheet Tab Bar at Bottom */}
        <div className="bg-[#eef4f0] border-t border-[#d0ded6] px-3 py-1.5 flex items-center justify-between gap-3 select-none">
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
            {sheetNames.map((sName) => {
              const isTabActive = activeSheetName === sName;
              return (
                <button
                  key={sName}
                  type="button"
                  onClick={() => handleTabClick(sName)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs font-semibold transition-all ${
                    isTabActive
                      ? 'bg-white text-emerald-800 shadow-2xs border-t-2 border-emerald-600 font-bold -mb-1.5 pb-2'
                      : 'bg-transparent text-gray-600 hover:bg-white/60 hover:text-gray-900'
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: isTabActive ? '#0ba66a' : '#94a3b8' }}
                  />
                  <span>{sName}</span>
                </button>
              );
            })}
          </div>

          <div className="text-[11px] text-gray-400 font-mono hidden sm:block">
            Ready • {currentSheet.rows.length} rows loaded
          </div>
        </div>
      </div>
    </div>
  );
};
