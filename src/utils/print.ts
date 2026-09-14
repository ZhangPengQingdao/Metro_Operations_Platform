/**
 * Platform - Shared Engineering Print Foundation (PLATFORM-L2-005)
 * 纯净浏览器与 A4 分页打印控制工具。
 */

export interface PrintOptions {
  title?: string;
  customStyle?: string;
}

/**
 * 触发指定 DOM 区域或整页的 A4 标准格式打印
 */
export function triggerPrint(
  target?: HTMLElement | string | null,
  options: PrintOptions = {}
): void {
  const { title, customStyle = '' } = options;

  if (!target) {
    window.print();
    return;
  }

  const element = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  if (!element) {
    window.print();
    return;
  }

  // 创建隔离的隐藏打印 iframe，避免污染当前页 DOM 结构与滚动位置
  const printIframe = document.createElement('iframe');
  printIframe.style.position = 'fixed';
  printIframe.style.right = '0';
  printIframe.style.bottom = '0';
  printIframe.style.width = '0';
  printIframe.style.height = '0';
  printIframe.style.border = '0';

  document.body.appendChild(printIframe);

  const iframeDoc = printIframe.contentWindow?.document;
  if (!iframeDoc) {
    window.print();
    document.body.removeChild(printIframe);
    return;
  }

  const defaultPrintCss = `
    @page { size: A4; margin: 15mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif; color: #17211d; background: #fff; margin: 0; padding: 0; }
    table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
    tr { page-break-inside: avoid; page-break-after: auto; }
    th, td { border: 1px solid #d1d5db; padding: 8px 10px; font-size: 12px; }
    th { background: #f3f4f6; font-weight: 600; }
    img { max-width: 100%; height: auto; }
    .no-print { display: none !important; }
  `;

  iframeDoc.open();
  iframeDoc.write('<!DOCTYPE html><html><head><title></title></head><body></body></html>');
  iframeDoc.close();
  iframeDoc.title = title || document.title;

  const style = iframeDoc.createElement('style');
  style.textContent = `${defaultPrintCss}\n${customStyle}`;
  iframeDoc.head.appendChild(style);
  iframeDoc.body.appendChild(iframeDoc.importNode(element, true));

  printIframe.contentWindow?.focus();
  setTimeout(() => {
    printIframe.contentWindow?.print();
    setTimeout(() => {
      document.body.removeChild(printIframe);
    }, 1000);
  }, 250);
}
