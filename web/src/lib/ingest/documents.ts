import { ATTACHMENT_LIMITS, AttachmentPolicyError, validateDocumentText } from './limits';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type ZipLibrary from 'jszip';

export async function parsePdf(buffer: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  // Inside our outer worker PDF.js cannot use window.location to create its
  // worker. Give it an explicit port, rather than falling back to importing
  // pdf.worker into this scope (which emits PDF protocol messages to our UI).
  const port = typeof document === 'undefined' ? new Worker(pdfWorkerUrl, { type: 'module' }) : undefined;
  let worker: InstanceType<typeof pdfjs.PDFWorker> | undefined;
  let loading: ReturnType<typeof pdfjs.getDocument> | undefined;
  try {
    worker = port ? pdfjs.PDFWorker.fromPort({ port }) : undefined;
    loading = pdfjs.getDocument({ data: buffer, isEvalSupported: false, worker });
    const doc = await loading.promise;
    if (doc.numPages > ATTACHMENT_LIMITS.pdfPages) throw new AttachmentPolicyError('PDF超过50页，请拆分后添加；不会只取前50页。');
    const parts: string[] = []; let chars = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent(); const words: string[] = [];
        for (const item of content.items) if ('str' in item) {
          chars += item.str.length + (words.length ? 1 : 0);
          if (chars > ATTACHMENT_LIMITS.textChars) throw new AttachmentPolicyError('文档超过10万字符，请拆分后添加；不会截断内容。');
          words.push(item.str);
        }
        if (parts.length) chars++;
        if (chars > ATTACHMENT_LIMITS.textChars) throw new AttachmentPolicyError('文档超过10万字符，请拆分后添加；不会截断内容。');
        parts.push(words.join(' '));
      } finally { page.cleanup(); }
    }
    return validateDocumentText(parts.join('\n'));
  } finally { try { await loading?.destroy(); } finally { worker?.destroy(); port?.terminate(); } }
}

export async function parseDocx(buffer: ArrayBuffer): Promise<string> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  if (entries.length > ATTACHMENT_LIMITS.zipEntries) throw new AttachmentPolicyError('DOCX内部文件过多，请简化或另存为TXT后添加。');
  if (!zip.file('word/document.xml') || !zip.file('[Content_Types].xml')) throw new AttachmentPolicyError('文件不是有效DOCX，请使用Word另存为DOCX或TXT后添加。');
  const bounded = new JSZip(); let expanded = 0;
  // Bound REAL decompressed bytes, not untrusted ZIP size headers. Repack
  // STORE-only content so Mammoth cannot decompress the original again.
  for (const entry of entries) {
    if (entry.dir) continue;
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Uint8Array[] = []; let length = 0, stopped = false;
      // JSZip 3.10.x exposes this streaming API but omits it on JSZipObject's
      // bundled declaration (async() itself uses it). Pin and test that API.
      const stream = (entry as typeof entry & { internalStream(type: 'uint8array'): ZipLibrary.JSZipStreamHelper<Uint8Array> }).internalStream('uint8array');
      stream.on('data', chunk => {
        if (stopped) return;
        expanded += chunk.length; length += chunk.length;
        if (expanded > ATTACHMENT_LIMITS.zipBytes) { stopped = true; stream.pause(); chunks.length = 0; reject(new AttachmentPolicyError('DOCX解压内容超过20MB，请简化文档或另存为TXT后添加。')); return; }
        chunks.push(chunk);
      }).on('error', reject).on('end', () => {
        if (stopped) return;
        const result = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        resolve(result);
      }).resume();
    });
    bounded.file(entry.name, bytes);
  }
  const safeBuffer = await bounded.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
  const mammoth = await import('mammoth');
  return validateDocumentText((await mammoth.extractRawText({ arrayBuffer: safeBuffer })).value);
}
