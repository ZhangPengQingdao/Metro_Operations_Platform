/** Hands a file the page generated (e.g. an Excel export) to the browser's save dialog. */
export function saveAs(contents: Blob, fileName: string): void {
  if (typeof fileName !== 'string' || !fileName || fileName.length > 180 || fileName.trim() !== fileName || /[\\/\u0000-\u001f\u007f<>:"|?*]/.test(fileName) || fileName === '.' || fileName === '..') throw new TypeError('INVALID_FILE_NAME');
  const url = URL.createObjectURL(contents), link = document.createElement('a');
  link.href = url; link.download = fileName; link.style.display = 'none';
  document.body.append(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
