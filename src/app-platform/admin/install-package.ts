const MAX_BYTES = 92 * 1024 * 1024;
/** Compressed JSON uses the same signed package contract, without extracting filesystem paths. */
export async function readInstallPackage(file: File): Promise<unknown> {
 if (!file.size || file.size > MAX_BYTES) throw Error('请选择不超过 92MB 的应用安装包。');
 const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
 const compressed = header[0] === 0x1f && header[1] === 0x8b;
 if (compressed && typeof DecompressionStream === 'undefined') throw Error('此浏览器暂不支持压缩安装包，请更新浏览器或使用 JSON 安装包。');
 const stream = compressed ? file.stream().pipeThrough(new DecompressionStream('gzip')) : file.stream();
 const reader = stream.getReader();
 const chunks: Uint8Array[] = [];
 let size = 0;
 try {
  while (true) {
   const item = await reader.read();
   if (item.done) break;
   size += item.value.byteLength;
   if (size > MAX_BYTES) throw Error('安装包解压后超过 92MB 限制。');
   chunks.push(item.value);
  }
 } finally { await reader.cancel(); reader.releaseLock(); }
 const bytes = new Uint8Array(size);
 let offset = 0;
 for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
 return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}
