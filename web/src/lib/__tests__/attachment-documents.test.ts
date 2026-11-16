import { beforeEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { parsePdf, parseDocx } from '../ingest/documents';
import { ATTACHMENT_LIMITS as L } from '../ingest/limits';
const fixture = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: fixture.getDocument }));
// Vitest runs Mammoth's Node entry; Vite replaces unzip.js with the browser
// entry. Adapt only its input representation here; browser E2E tests the worker.
vi.mock('mammoth', async original => {
  const mammoth = await original<typeof import('mammoth')>();
  return { ...mammoth, extractRawText: ({ arrayBuffer }: { arrayBuffer: ArrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) }) };
});
beforeEach(() => fixture.getDocument.mockReset());
it('PDF先检查50页边界，超过时不读任何页且销毁任务', async () => {
  const getPage = vi.fn(), destroy = vi.fn(async () => {});
  fixture.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 51, getPage }), destroy });
  await expect(parsePdf(new ArrayBuffer(1))).rejects.toThrow(/超过50页/);
  expect(getPage).not.toHaveBeenCalled(); expect(destroy).toHaveBeenCalledOnce();
});
it('50页完整读取；字符超限、空文本、读取错误均清理PDF资源', async () => {
  const cleanup = vi.fn(), destroy = vi.fn(async () => {});
  const getTextContent = vi.fn(async () => ({ items: [{ str: '正文' }] }));
  const getPage = vi.fn(async () => ({ getTextContent, cleanup }));
  fixture.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 50, getPage }), destroy });
  expect((await parsePdf(new ArrayBuffer(1))).split('\n')).toHaveLength(50);
  expect(cleanup).toHaveBeenCalledTimes(50); expect(destroy).toHaveBeenCalledOnce();
  getTextContent.mockResolvedValueOnce({ items: [{ str: 'x'.repeat(L.textChars + 1) }] });
  await expect(parsePdf(new ArrayBuffer(1))).rejects.toThrow(/10万字符/);
  expect(cleanup).toHaveBeenCalledTimes(51); expect(destroy).toHaveBeenCalledTimes(2);
  fixture.getDocument.mockReturnValue({ promise: Promise.reject(new Error('bad pdf')), destroy });
  await expect(parsePdf(new ArrayBuffer(1))).rejects.toThrow('bad pdf'); expect(destroy).toHaveBeenCalledTimes(3);
});
function docx(text = '有效正文') {
  return new JSZip().file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    .file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
}
it('真实DOCX完整提取；超过文本阈值整份拒绝、不返回前缀', async () => {
  expect(await parseDocx(await docx().generateAsync({ type: 'arraybuffer' }))).toContain('有效正文');
  await expect(parseDocx(await docx('x'.repeat(L.textChars + 1)).generateAsync({ type: 'arraybuffer' }))).rejects.toThrow(/10万字符/);
});
it('DOCX必须有正确结构；过多条目和实际解压超20MB均拒绝', async () => {
  await expect(parseDocx(await new JSZip().file('random.txt', 'x').generateAsync({ type: 'arraybuffer' }))).rejects.toThrow(/不是有效DOCX/);
  const many = docx(); for (let i = 0; i <= L.zipEntries; i++) many.file(`data/${i}`, 'x');
  await expect(parseDocx(await many.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow(/内部文件过多/);
  const bomb = docx().file('padding.bin', new Uint8Array(L.zipBytes + 1));
  const buffer = await bomb.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  expect(buffer.byteLength).toBeLessThan(L.fileBytes);
  await expect(parseDocx(buffer)).rejects.toThrow(/解压内容超过20MB/);
});
