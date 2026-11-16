import { parsePdf, parseDocx } from './documents';
import { AttachmentPolicyError } from './limits';
// A real worker can be terminated on deadline; Promise.race cannot stop a
// blocked/decompressing parser running on the UI thread.
self.onmessage = async (event: MessageEvent<{ buffer: ArrayBuffer; format: 'pdf' | 'docx' }>) => {
  try {
    const text = event.data.format === 'pdf' ? await parsePdf(event.data.buffer) : await parseDocx(event.data.buffer);
    self.postMessage({ text });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '解析失败', policy: error instanceof AttachmentPolicyError });
  }
};
