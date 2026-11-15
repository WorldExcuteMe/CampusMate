import { expect, it, vi } from 'vitest';
import { ComposerDraftStore, type ComposerDraft, type DraftPersistence } from '../agent/composer-drafts';
import type { Attachment } from '../ingest/files';
import { memoryDraftPersistence } from '@/test-utils/draft-persistence';
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
