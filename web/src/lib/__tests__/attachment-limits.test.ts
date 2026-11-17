import { describe, expect, it, vi, afterEach } from 'vitest';
import { ATTACHMENT_LIMITS as L, attachmentSetError, attachmentSendError, validateAttachmentFile, validateDocumentText } from '../ingest/limits';
import { parseFile } from '../ingest/files';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('附件白名单与读取前预算', () => {
  it.each(['app.exe', 'archive.zip', 'page.html', 'script.svg', 'old.doc', 'x.constructor', 'x.__proto__'])('拒绝不支持格式 %s', name => {
    expect(() => validateAttachmentFile({ name, type: '', size: 1 })).toThrow(/不支持/);
  });
  it('允许空MIME的已知扩展名、大小写与剪贴板图片；拒绝MIME冲突和空文件', () => {
    expect(validateAttachmentFile({ name: 'REPORT.PDF', type: '', size: 1 })).toBe('pdf');
    expect(validateAttachmentFile({ name: 'image', type: 'image/png', size: 1 })).toBe('image');
    expect(() => validateAttachmentFile({ name: 'fake.exe', type: 'image/png', size: 1 })).toThrow(/不支持/);
    expect(() => validateAttachmentFile({ name: 'fake.txt', type: 'application/pdf', size: 1 })).toThrow(/不一致/);
    expect(() => validateAttachmentFile({ name: 'empty.txt', type: '', size: 0 })).toThrow(/为空/);
  });
  it('32MB文件及EXE在任何内容读取之前拒绝，5MB边界允许', async () => {
    const read = vi.fn();
    await expect(parseFile({ name: 'big.txt', type: 'text/plain', size: 32 * 1024 ** 2, arrayBuffer: read } as unknown as File)).rejects.toThrow(/5MB/);
    await expect(parseFile({ name: 'program.exe', type: 'application/octet-stream', size: 3, arrayBuffer: read } as unknown as File)).rejects.toThrow(/不支持/);
    expect(read).not.toHaveBeenCalled();
    expect(validateAttachmentFile({ name: 'valid.txt', type: '', size: L.fileBytes })).toBe('text');
  });
  it('附件个数、累计原始大小和图片base64开销均有上限', () => {
    const doc = { name: 'doc.txt', kind: 'doc' as const, sizeBytes: 1 };
    expect(attachmentSetError(Array(8).fill(doc))).toBeUndefined();
    expect(attachmentSetError(Array(9).fill(doc))).toMatch(/最多8个/);
    expect(attachmentSetError([{ ...doc, sizeBytes: L.fileBytes }, { ...doc, sizeBytes: L.fileBytes }])).toBeUndefined();
    expect(attachmentSetError([{ ...doc, sizeBytes: L.fileBytes }, { ...doc, sizeBytes: L.fileBytes }, doc])).toMatch(/合计超过10MB/);
    const img = { name: 'i.png', kind: 'image' as const, sizeBytes: 2 * 1024 ** 2 };
    expect(attachmentSetError([img, img])).toBeUndefined();
    expect(attachmentSetError([img, img, { ...img, sizeBytes: 1 }])).toMatch(/图片合计超过4MB/);
  });
  it('字符阈值不截断，UTF-8与JSON转义以真实字节计算请求预算', () => {
    expect(validateDocumentText('中'.repeat(L.textChars))).toHaveLength(L.textChars);
    expect(() => validateDocumentText('x'.repeat(L.textChars + 1))).toThrow(/10万字符/);
    expect(() => validateDocumentText(' \n')).toThrow(/没有可提取/);
    const a = { name: 'text.txt', kind: 'doc' as const, text: 'x'.repeat(L.textChars) };
    expect(attachmentSetError([a, a])).toBeUndefined();
    expect(attachmentSetError([a, a, { ...a, text: 'x' }])).toMatch(/合计超过20万/);
    expect(attachmentSendError('中'.repeat(3 * 1024 ** 2), [])).toMatch(/编码后超过7MB/);
    expect(attachmentSendError('\u0000'.repeat(2 * 1024 ** 2), [])).toMatch(/编码后超过7MB/);
  });
  it('UTF-8文本正常解析，二进制/非法UTF-8/空文本/过长文本整份报错', async () => {
    expect(await parseFile(new File(['正文\n第二行'], 'notice.md', { type: 'text/markdown' }))).toMatchObject({ kind: 'doc', text: '正文\n第二行', sizeBytes: 16 });
    await expect(parseFile(new File([new Uint8Array([0, 1])], 'fake.txt'))).rejects.toThrow(/二进制/);
    await expect(parseFile(new File([new Uint8Array([255, 254])], 'bad.txt'))).rejects.toThrow(/UTF-8/);
    await expect(parseFile(new File([' '], 'empty.txt'))).rejects.toThrow(/没有可提取/);
    await expect(parseFile(new File(['x'.repeat(L.textChars + 1)], 'long.txt'))).rejects.toThrow(/10万字符/);
  });
  it('图片先检查签名；空MIME的正常PNG仍生成正确图片dataURL', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    expect(await parseFile(new File([bytes], 'image.png'))).toMatchObject({ kind: 'image', dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
    await expect(parseFile(new File(['not-a-png'], 'fake.png', { type: 'image/png' }))).rejects.toThrow(/图片内容与格式不符/);
  });
  it('旧草稿无大小元数据时按base64解码字节计数，虚假元数据不能绕过图片总量', () => {
    const exact = `data:image/png;base64,${'a'.repeat(4 * Math.ceil(L.imageBytes / 3)).slice(0, -2)}==`;
    expect(attachmentSetError([{ name: 'old.png', kind: 'image', dataUrl: exact }])).toBeUndefined();
    expect(attachmentSetError([{ name: 'old.png', kind: 'image', dataUrl: exact, sizeBytes: 1 }, { name: 'other.png', kind: 'image', sizeBytes: 3 }])).toMatch(/合计超过4MB/);
  });
});

it('文档解析并发最多2个；20秒超时真正终止Worker并释放队列', async () => {
  vi.useFakeTimers();
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (e: { data: { text: string } }) => void; onerror?: unknown;
    terminate = vi.fn(); postMessage = vi.fn();
    constructor() { workers.push(this); }
  }
  vi.stubGlobal('Worker', FakeWorker);
  const file = () => ({ name: 'doc.pdf', type: 'application/pdf', size: 10, arrayBuffer: async () => new ArrayBuffer(10) }) as File;
  const results = [parseFile(file()), parseFile(file()), parseFile(file())].map(p => p.then(value => value, error => error as Error));
  await vi.advanceTimersByTimeAsync(0); expect(workers).toHaveLength(2);
  workers[0].onmessage!({ data: { text: '正常正文' } });
  await vi.advanceTimersByTimeAsync(0); expect(workers).toHaveLength(3); expect(workers[0].terminate).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(L.parseMs);
  const settled = await Promise.all(results);
  expect(settled[0]).toMatchObject({ text: '正常正文' });
  expect((settled[1] as Error).message).toMatch(/超过20秒/); expect((settled[2] as Error).message).toMatch(/超过20秒/);
  expect(workers[1].terminate).toHaveBeenCalledOnce(); expect(workers[2].terminate).toHaveBeenCalledOnce();
});

it('移除排队文件不启动Worker，取消运行任务立即终止并让出并发位', async () => {
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (e: { data: { text: string } }) => void; onerror?: unknown;
    terminate = vi.fn(); postMessage = vi.fn(); constructor() { workers.push(this); }
  }
  vi.stubGlobal('Worker', FakeWorker);
  const file = () => ({ name: 'doc.pdf', type: 'application/pdf', size: 10, arrayBuffer: async () => new ArrayBuffer(10) }) as File;
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const results = controllers.map(c => parseFile(file(), c.signal).catch(error => error as Error));
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  controllers[2].abort(); controllers[0].abort();
  workers[1].onmessage!({ data: { text: '仍在使用的文件' } });
  const settled = await Promise.all(results);
  expect((settled[0] as Error).name).toBe('AbortError'); expect((settled[2] as Error).name).toBe('AbortError');
  expect(settled[1]).toMatchObject({ text: '仍在使用的文件' }); expect(workers).toHaveLength(2);
  expect(workers[0].terminate).toHaveBeenCalledOnce(); expect(workers[1].terminate).toHaveBeenCalledOnce();
});
