/**
 * Platform - Shared Engineering Excel / XLSX Export & Parse Foundation (PLATFORM-L2-005)
 * 通用电子表格导出与解析底座，完全纯净，不绑定具体业务模版。
 */
import * as XLSX from 'xlsx';

export interface ExcelColumn<T> {
  key: keyof T;
  header: string;
  width?: number;
  formatter?: (value: any, row: T) => any;
}

export interface ExportExcelOptions<T> {
  data: readonly T[];
  filename?: string;
  sheetName?: string;
  columns?: readonly ExcelColumn<T>[];
}

/**
 * 将结构化 JSON 数据转换为标准 Excel 文件的 Blob 对象
 */
export function jsonToExcelBlob<T extends Record<string, any>>(
  options: ExportExcelOptions<T>
): Blob {
  const { data, sheetName = 'Sheet1', columns } = options;

  let sheetData: any[];

  if (columns && columns.length > 0) {
    sheetData = data.map((row) => {
      const formattedRow: Record<string, any> = {};
      for (const col of columns) {
        const rawVal = row[col.key];
        formattedRow[col.header] = col.formatter ? col.formatter(rawVal, row) : (rawVal ?? '');
      }
      return formattedRow;
    });
  } else {
    sheetData = data.slice();
  }

  const worksheet = XLSX.utils.json_to_sheet(sheetData);

  // 自动计算并设置列宽
  if (columns && columns.length > 0) {
    worksheet['!cols'] = columns.map((col) => ({
      wch: col.width || Math.max(col.header.length * 2 + 4, 12)
    }));
  } else if (data.length > 0) {
    const keys = Object.keys(data[0]);
    worksheet['!cols'] = keys.map((k) => ({
      wch: Math.max(k.length * 2 + 4, 14)
    }));
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

  const arrayBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

/**
 * 触发浏览器直接下载生成的 Excel 文件
 */
export function exportToExcel<T extends Record<string, any>>(
  options: ExportExcelOptions<T>
): void {
  const { filename = 'export.xlsx' } = options;
  const blob = jsonToExcelBlob(options);
  const url = URL.createObjectURL(blob);

  const downloadLink = document.createElement('a');
  downloadLink.href = url;
  downloadLink.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);
  URL.revokeObjectURL(url);
}

/**
 * 解析上传的 Excel 文件为结构化 JSON 数组
 */
export async function parseExcelFile<T = Record<string, any>>(
  fileInput: File | Blob | ArrayBuffer
): Promise<T[]> {
  let arrayBuffer: ArrayBuffer;

  if (fileInput instanceof ArrayBuffer) {
    arrayBuffer = fileInput;
  } else if (fileInput instanceof Blob) {
    arrayBuffer = await fileInput.arrayBuffer();
  } else {
    throw new Error('Unsupported file input type for Excel parsing');
  }

  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json<T>(worksheet);
}

export interface ParsedSheet {
  name: string;
  data: any[][];
  jsonData: Record<string, any>[];
  headers: string[];
  rowCount: number;
  colCount: number;
}

export interface ParsedWorkbook {
  fileName?: string;
  sheetNames: string[];
  sheets: Record<string, ParsedSheet>;
}

/**
 * 深度解析 Excel 工作簿，提取所有 Sheet 原始行列网格与 JSON 数据（用于在线文件预览）
 */
export async function parseExcelWorkbook(
  fileInput: File | Blob | ArrayBuffer,
  fileName = 'workbook.xlsx'
): Promise<ParsedWorkbook> {
  let arrayBuffer: ArrayBuffer;

  if (fileInput instanceof ArrayBuffer) {
    arrayBuffer = fileInput;
  } else if (fileInput instanceof Blob) {
    arrayBuffer = await fileInput.arrayBuffer();
  } else {
    throw new Error('Unsupported file input type for Excel parsing');
  }

  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const result: ParsedWorkbook = {
    fileName,
    sheetNames: workbook.SheetNames,
    sheets: {}
  };

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const data2d = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1 }) || [];
    const jsonData = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet) || [];
    const headers = data2d.length > 0 ? (data2d[0] as any[]).map((h) => String(h ?? '')) : [];

    result.sheets[sheetName] = {
      name: sheetName,
      data: data2d,
      jsonData,
      headers,
      rowCount: data2d.length,
      colCount: headers.length
    };
  }

  return result;
}
