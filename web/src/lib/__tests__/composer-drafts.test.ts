import { expect, it, vi } from 'vitest';
import { ComposerDraftStore, type ComposerDraft, type DraftPersistence } from '../agent/composer-drafts';
import type { Attachment } from '../ingest/files';
import { memoryDraftPersistence } from '@/test-utils/draft-persistence';
import { ATTACHMENT_LIMITS as L, AttachmentPolicyError } from '../ingest/limits';
function disk() {
  const storage = memoryDraftPersistence(); vi.spyOn(storage, 'write'); vi.spyOn(storage, 'remove');
  return storage;
}
const parser = async (file: File): Promise<Attachment> => ({ name: file.name, kind: 'doc', text: 'fixture content' });
function fixture(owner = 'alice', storage = disk(), parse = parser) {
  const ids = new Set(['A', 'B']), mark = vi.fn();
  return { ids, mark, storage, store: new ComposerDraftStore(owner, id => ids.has(id), mark, storage, parse) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
it('文字、附件、名称编辑按账号+会话隔离，重新创建Store可恢复', async () => {
  const { store, storage } = fixture(); await store.load('A'); await store.load('B');
  store.setText('A', 'A的文字'); store.setText('B', 'B的文字'); store.setTitleEdit('A', 'A的新名称');
  await store.addFiles('A', [new File(['fixture'], 'A.txt')]);
  await vi.waitFor(() => expect(store.snapshot('A').draft.attachments[0].status).toBe('ready'));
  await store.flush('A'); await store.flush('B');
  const restored = fixture('alice', storage).store; await restored.load('A'); await restored.load('B');
  expect(restored.snapshot('A').draft).toEqual(expect.objectContaining({ text: 'A的文字', titleEdit: 'A的新名称', attachments: [expect.objectContaining({ name: 'A.txt', text: 'fixture content' })] }));
  expect(restored.snapshot('B').draft.text).toBe('B的文字'); expect(restored.snapshot('B').draft.attachments).toEqual([]);
  const bob = fixture('bob', storage).store; await bob.load('A'); expect(bob.snapshot('A').draft.text).toBe('');
});
it('A的附件迟到解析不会进入B；移除附件后不会被异步结果复活', async () => {
  const gate = deferred<Attachment>(), { store } = fixture('alice', disk(), () => gate.promise);
  await store.load('A'); await store.load('B'); await store.addFiles('A', [new File(['x'], 'slow.txt')]);
  const id = store.snapshot('A').draft.attachments[0].id;
  store.setText('B', '保持B'); store.removeAttachment('A', id);
  gate.resolve({ name: 'slow.txt', kind: 'doc', text: 'late' });
  await Promise.resolve(); await Promise.resolve();
  expect(store.snapshot('A').draft.attachments).toEqual([]); expect(store.snapshot('B').draft).toEqual({ text: '保持B', attachments: [] });
});
it('解析中的File先保存，刷新能继续解析；已离开的账号不写入迟到结果', async () => {
  const gate = deferred<Attachment>(), storage = disk(), old = fixture('alice', storage, () => gate.promise).store;
  await old.load('A'); await old.addFiles('A', [new File(['x'], 'resume.txt')]); await old.flush('A'); old.deactivate();
  const parse = vi.fn(parser), restored = fixture('alice', storage, parse).store; await restored.load('A');
  await vi.waitFor(() => expect(restored.snapshot('A').draft.attachments[0].status).toBe('ready'));
  expect(parse).toHaveBeenCalledOnce(); restored.setText('A', '回到账号后的新草稿'); await restored.flush('A');
  gate.resolve({ name: 'resume.txt', kind: 'doc', text: '旧的迟到结果' }); await Promise.resolve();
  expect((await storage.read('alice', 'A')).current.draft.text).toBe('回到账号后的新草稿');
  expect((await storage.read('alice', 'A')).current.draft.attachments[0].text).toBe('fixture content');
});
it('清空发送内容不清除名称编辑；Enter+blur只取出名称一次', async () => {
  const { store } = fixture(); await store.load('A'); store.setText('A', '发送内容'); store.setTitleEdit('A', '新名称'); store.clearComposer('A');
  expect(store.snapshot('A').draft).toEqual({ text: '', attachments: [], titleEdit: '新名称' });
  expect(await store.finishTitle('A')).toBe('新名称'); expect(await store.finishTitle('A')).toBeUndefined();
});
it('删除会话后迟到解析不复活，排队中的旧保存先结束再清理', async () => {
  const gate = deferred<Attachment>(), { store, ids, storage } = fixture('alice', disk(), () => gate.promise);
  await store.load('A'); store.setText('A', '将删除'); await store.addFiles('A', [new File(['x'], 'slow.txt')]);
  ids.delete('A'); store.remove('A'); gate.resolve({ name: 'slow.txt', kind: 'doc', text: 'late' });
  await vi.waitFor(() => expect(storage.remove).toHaveBeenCalledWith('alice', 'A', expect.any(String)));
  expect((await storage.read('alice', 'A')).current.deleted).toBe(true);
});
it('解析失败保留可移除的错误状态，不产生未处理reject或假附件', async () => {
  const { store } = fixture('alice', disk(), async () => { throw Error('malformed'); }); await store.load('A');
  await store.addFiles('A', [new File(['bad'], 'bad.pdf')]);
  await vi.waitFor(() => expect(store.snapshot('A').draft.attachments[0].status).toBe('error'));
  expect(store.snapshot('A').draft.attachments[0].error).toMatch(/解析失败/);
});
it('存储配额失败保留内存并明确警告；读取失败不覆盖未读旧稿', async () => {
  const storage = disk(); vi.mocked(storage.write).mockRejectedValue(new Error('quota'));
  const { store } = fixture('alice', storage); await store.load('A'); store.setText('A', '不能静默丢失'); await store.flush('A');
  expect(store.snapshot('A').draft.text).toBe('不能静默丢失'); expect(store.snapshot('A').error).toMatch(/刷新可能丢失/); expect(store.snapshot('A').saving).toBe(false);
  const readFailed = { ...disk(), read: async () => { throw Error('blocked'); } }, other = fixture('alice', readFailed).store;
  await other.load('A'); other.setText('A', '内存草稿'); await other.flush('A');
  expect(other.snapshot('A').error).toMatch(/存储不可用/); expect(readFailed.write).not.toHaveBeenCalled();
});
it('损坏的历史草稿不导致页面崩溃，也不拿空记录覆盖原始数据', async () => {
  const storage = { ...disk(), read: async () => ({ current: { draft: { text: '旧稿', attachments: [null] }, revision: 0 }, versions: [] }) as any };
  const { store } = fixture('alice', storage); await store.load('A');
  expect(store.snapshot('A').draft.attachments).toEqual([]); expect(store.snapshot('A').error).not.toBeNull();
  store.setText('A', '暂存内容'); await store.flush('A'); expect(storage.write).not.toHaveBeenCalled();
});

const imageFiles = (count: number) => Array.from({ length: count }, (_, i) => new File(['image'], `image-${i}.png`, { type: 'image/png' }));
const imageParser = async (file: File): Promise<Attachment> => file.type.startsWith('image/') ? { name: file.name, kind: 'image', dataUrl: 'data:image/png;base64,Zml4dHVyZQ==' } : parser(file);
it('一次选6张图片整批拒绝，不解析、不持久化、不改动已有文字', async () => {
  const parse = vi.fn(imageParser), { store, storage } = fixture('alice', disk(), parse);
  await store.load('A'); store.setText('A', '保留文字'); await store.flush('A');
  const writes = vi.mocked(storage.write).mock.calls.length;
  await expect(store.addFiles('A', imageFiles(6))).rejects.toThrow(/最多 4 张图片.*6 张/);
  expect(parse).not.toHaveBeenCalled(); expect(storage.write).toHaveBeenCalledTimes(writes);
  expect(store.snapshot('A').draft).toEqual({ text: '保留文字', attachments: [] });
});
it('累计图片含解析中附件；超限混合选择全部拒绝，移除后可补足4张并完整发送', async () => {
  const gate = deferred<Attachment>(), parse = vi.fn(() => gate.promise), { store } = fixture('alice', disk(), parse);
  await store.addFiles('A', imageFiles(3));
  await expect(store.addFiles('A', [new File(['doc'], 'notice.txt'), ...imageFiles(2)])).rejects.toThrow(/当前共 5 张/);
  expect(store.snapshot('A').draft.attachments).toHaveLength(3);
  expect(parse).toHaveBeenCalledTimes(3);
  store.removeAttachment('A', store.snapshot('A').draft.attachments[0].id);
  await store.addFiles('A', imageFiles(2));
  gate.resolve({ name: 'image.png', kind: 'image', dataUrl: 'data:image/png;base64,Zml4dHVyZQ==' });
  await vi.waitFor(() => expect(store.snapshot('A').draft.attachments.every(a => a.status === 'ready')).toBe(true));
  expect((await store.takeForSend('A'))?.attachments).toHaveLength(4);
});
it('并发粘贴/拖拽不能绕过累计上限，文档不占图片名额', async () => {
  const { store } = fixture('alice', disk(), imageParser);
  const result = await Promise.allSettled([store.addFiles('A', imageFiles(3)), store.addFiles('A', imageFiles(2))]);
  expect(result.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
  await store.addFiles('A', [new File(['doc'], 'notice.txt'), ...imageFiles(1)]);
  await vi.waitFor(() => expect(store.snapshot('A').draft.attachments.every(a => a.status === 'ready')).toBe(true));
  const sent = await store.takeForSend('A');
  expect(sent?.attachments.filter(a => a.kind === 'image')).toHaveLength(4);
  expect(sent?.attachments.filter(a => a.kind === 'doc')).toHaveLength(1);
});
it('旧版超限草稿恢复后发送被拦截，文字和图片不被清空；手动移除后可发送', async () => {
  const storage = disk();
  const original: ComposerDraft = { text: '旧草稿', attachments: imageFiles(5).map((f, i) => ({ id: `old-${i}`, name: f.name, kind: 'image', status: 'ready', dataUrl: 'data:image/png;base64,Zml4dHVyZQ==' })) };
  await storage.write('alice', 'A', original, 0, 'seed', 'seed');
  const { store } = fixture('alice', storage); await store.load('A');
  expect(await store.takeForSend('A')).toBeUndefined();
  expect(store.snapshot('A').error).toMatch(/最多 4 张图片/);
  expect(store.snapshot('A').draft).toEqual(original);
  expect((await storage.read('alice', 'A')).current.draft).toEqual(original);
  store.removeAttachment('A', 'old-4');
  expect((await store.takeForSend('A'))?.attachments).toHaveLength(4);
});

it('混入不支持文件、超大文件或超数量时整批不解析，保留原稿', async () => {
  const parse = vi.fn(parser), { store } = fixture('alice', disk(), parse);
  await store.load('A'); store.setText('A', '原稿');
  await expect(store.addFiles('A', [new File(['valid'], 'ok.txt'), new File(['bad'], 'app.exe')])).rejects.toThrow(/不支持/);
  await expect(store.addFiles('A', [new File([new Uint8Array(L.fileBytes + 1)], 'large.txt')])).rejects.toThrow(/5MB/);
  await expect(store.addFiles('A', Array.from({ length: 9 }, () => new File(['x'], 'tiny.txt')))).rejects.toThrow(/最多8个/);
  expect(parse).not.toHaveBeenCalled(); expect(store.snapshot('A').draft).toEqual({ text: '原稿', attachments: [] });
});
it('累计大小包含解析完附件，刷新后大小元数据不丢，不能分次绕过', async () => {
  const storage = disk(), { store } = fixture('alice', storage, parser);
  await store.addFiles('A', [new File([new Uint8Array(L.fileBytes)], 'one.txt'), new File([new Uint8Array(L.fileBytes)], 'two.txt')]);
  await vi.waitFor(() => expect(store.snapshot('A').draft.attachments.every(a => a.status === 'ready')).toBe(true)); await store.flush('A');
  const restored = fixture('alice', storage, parser).store; await restored.load('A');
  await expect(restored.addFiles('A', [new File(['x'], 'three.txt')])).rejects.toThrow(/合计超过10MB/);
  expect(restored.snapshot('A').draft.attachments).toHaveLength(2);
});
it('异步文档累计超20万字符保留可移除错误，不把过长正文存为ready或发送', async () => {
  const { store } = fixture('alice', disk(), async file => ({ name: file.name, kind: 'doc', text: 'x'.repeat(L.textChars) }));
  await store.load('A'); store.setText('A', '保留文字');
  await store.addFiles('A', ['a.txt', 'b.txt', 'c.txt'].map(name => new File(['source'], name)));
  await vi.waitFor(() => expect(store.snapshot('A').draft.attachments.some(a => a.status === 'error')).toBe(true));
  const attachments = store.snapshot('A').draft.attachments;
  expect(attachments.filter(a => a.status === 'ready')).toHaveLength(2);
  expect(attachments.find(a => a.status === 'error')?.error).toMatch(/合计超过20万/);
  expect(attachments.find(a => a.status === 'error')?.file).toBeInstanceOf(File);
  expect(await store.takeForSend('A')).toBeUndefined(); expect(store.snapshot('A').draft.text).toBe('保留文字');
});
it('超限旧文本草稿不清空，政策错误明确展示而非含糊解析失败', async () => {
  const storage = disk(), original: ComposerDraft = { text: '保留', attachments: [{ id: 'old', kind: 'doc', name: 'old.txt', status: 'ready', text: 'x'.repeat(L.textChars + 1) }] };
  await storage.write('alice', 'A', original, 0, 'seed', 'seed');
  const { store } = fixture('alice', storage); await store.load('A');
  expect(await store.takeForSend('A')).toBeUndefined(); expect(store.snapshot('A').error).toMatch(/10万字符/);
  expect(store.snapshot('A').draft).toEqual(original);
  const other = fixture('alice', disk(), async () => { throw new AttachmentPolicyError('PDF超过50页，请拆分'); }).store;
  await other.addFiles('A', [new File(['pdf'], 'too-many.pdf')]);
  await vi.waitFor(() => expect(other.snapshot('A').draft.attachments[0].error).toMatch(/PDF超过50页/));
});

it('移除附件与离开账号会取消解析；原始待解析File仍可在重新进入时恢复', async () => {
  const signals: AbortSignal[] = [];
  const parse = vi.fn((_file: File, signal?: AbortSignal) => new Promise<Attachment>((_resolve, reject) => {
    signals.push(signal!); signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  }));
  const { store } = fixture('alice', disk(), parse);
  await store.addFiles('A', [new File(['source'], 'one.txt')]); await vi.waitFor(() => expect(signals).toHaveLength(1));
  store.removeAttachment('A', store.snapshot('A').draft.attachments[0].id);
  expect(signals[0].aborted).toBe(true);
  await store.addFiles('A', [new File(['source'], 'two.txt')]); await vi.waitFor(() => expect(signals).toHaveLength(2));
  store.deactivate(); expect(signals[1].aborted).toBe(true);
  expect(store.snapshot('A').draft.attachments[0]).toMatchObject({ status: 'parsing', file: expect.any(File) });
  store.activate(); await vi.waitFor(() => expect(signals).toHaveLength(3));
  store.deactivate(); await store.flush('A');
});
