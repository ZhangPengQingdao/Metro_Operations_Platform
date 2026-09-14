export async function copyText(value: string, emptyMessage = '复制内容为空') {
  if (!value) {
    throw new Error(emptyMessage);
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some browsers reject Clipboard API calls outside secure contexts or without permission.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error('复制失败，请长按或手动复制链接');
  }
}

/**
 * 响应式安全复制到剪贴板，返回 boolean 结果
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await copyText(value);
    return true;
  } catch {
    return false;
  }
}
