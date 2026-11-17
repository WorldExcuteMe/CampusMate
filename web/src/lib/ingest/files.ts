import { ATTACHMENT_LIMITS, AttachmentPolicyError, attachmentImageMime, validateAttachmentFile, validateDocumentText } from './limits';
export interface Attachment {
  name: string; kind: 'image' | 'doc'; sizeBytes?: number; text?: string; dataUrl?: string;
}

// Bound reads/workers too, including pending files restored after refresh.
let active = 0;
const waiting: (() => void)[] = [];
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('附件解析已取消', 'AbortError'); }
async function limited<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  cancelled(signal);
  if (active >= ATTACHMENT_LIMITS.concurrency) await new Promise<void>((resolve, reject) => {
    const resume = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { const index = waiting.indexOf(resume); if (index >= 0) waiting.splice(index, 1); reject(new DOMException('附件解析已取消', 'AbortError')); };
    waiting.push(resume); signal?.addEventListener('abort', abort, { once: true });
  });
  else active++;
  try { cancelled(signal); return await work(); }
  finally { const next = waiting.shift(); if (next) next(); else active--; }
}
export async function parseFile(file: File, signal?: AbortSignal): Promise<Attachment> {
  const format = validateAttachmentFile(file); // Before reads, imports or workers.
  return limited(async () => {
    const base = { name: file.name, sizeBytes: file.size };
    if (format === 'image') {
      const mime = attachmentImageMime(file), head = new Uint8Array(await readBuffer(file.slice(0, 64) as File));
      const ascii = String.fromCharCode(...head);
      const valid = mime === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => head[i] === n)
        : mime === 'image/jpeg' ? head[0] === 255 && head[1] === 216 && head[2] === 255
        : mime === 'image/gif' ? /^GIF8[79]a/.test(ascii)
        : mime === 'image/webp' ? ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP'
        : mime === 'image/avif' && ascii.slice(4, 8) === 'ftyp' && /avif|avis/.test(ascii.slice(8));
      if (!valid) throw new AttachmentPolicyError('图片内容与格式不符或文件损坏，请使用正确格式的图片。');
      const url = await readAsDataURL(file);
      cancelled(signal);
      return { ...base, kind: 'image', dataUrl: `data:${mime};base64,${url.slice(url.indexOf(',') + 1)}` };
    }
    if (format === 'text') {
      const buf = await readBuffer(file); let text: string;
      cancelled(signal);
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch { throw new AttachmentPolicyError('文本不是有效UTF-8编码，请转为UTF-8 TXT/MD后添加。'); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new AttachmentPolicyError('文件包含二进制内容，不是可读取的TXT/MD文档。');
      return { ...base, kind: 'doc', text: validateDocumentText(text) };
    }
    return { ...base, kind: 'doc', text: validateDocumentText(await parseDocumentWorker(await readBuffer(file), format, signal)) };
  }, signal);
}
function readBuffer(file: File): Promise<ArrayBuffer> {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('附件读取失败，请重新添加。')); reader.readAsArrayBuffer(file);
  });
}
function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败，请重新添加。')); reader.readAsDataURL(file);
  });
}
function parseDocumentWorker(buffer: ArrayBuffer, format: 'pdf' | 'docx', signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    cancelled(signal);
    const worker = new Worker(new URL('./document-worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (error?: Error, text?: string) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate(); error ? reject(error) : resolve(text!); };
    const abort = () => finish(new DOMException('附件解析已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new AttachmentPolicyError('附件解析超过20秒，已停止；请拆分文档后重新添加。')), ATTACHMENT_LIMITS.parseMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ text?: string; error?: string; policy?: boolean }>) => {
      const data = event.data;
      if (data.error) finish(data.policy ? new AttachmentPolicyError(data.error) : new Error('文档损坏、加密或格式不支持，请检查后重新添加。'));
      else if (typeof data.text !== 'string') finish(new Error('附件解析结果无效，请重新添加。'));
      else finish(undefined, data.text);
    };
    worker.onerror = event => { event.preventDefault(); finish(new Error('文档解析器未能运行，请刷新后重试。')); };
    try { worker.postMessage({ buffer, format }, [buffer]); } catch (error) { finish(error instanceof Error ? error : new Error('附件读取失败')); }
  });
}
