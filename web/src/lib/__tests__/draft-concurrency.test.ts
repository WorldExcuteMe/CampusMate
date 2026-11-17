import { expect, it, vi } from 'vitest';
import { ComposerDraftStore } from '../agent/composer-drafts';
import { memoryDraftPersistence } from '@/test-utils/draft-persistence';
const make = (disk = memoryDraftPersistence(), owner = 'alice', key = (id: string) => id) => new ComposerDraftStore(owner, () => true, vi.fn(), disk, async file => ({ name: file.name, kind: 'doc', text: '完整附件正文' }), key);
it('双写冲突保存两份；选择本页后另一份仍可恢复，刷新不会丢冲突副本', async () => {
  const disk = memoryDraftPersistence(), a = make(disk), b = make(disk); await a.load('s'); await b.load('s');
  a.setText('s', 'A文字'); await a.flush('s'); await a.addFiles('s', [new File(['a'], 'A.txt')]);
  await vi.waitFor(() => expect(a.snapshot('s').draft.attachments[0].status).toBe('ready')); await a.flush('s');
  b.setText('s', 'B文字'); await b.flush('s');
  expect(b.snapshot('s').conflict?.draft.text).toBe('A文字'); expect(b.snapshot('s').draft.text).toBe('B文字');
  expect((await disk.read('alice', 's')).versions.some(v => v.draft.text === 'B文字')).toBe(true);
  await b.resolve('s', 'local'); expect((await disk.read('alice', 's')).current.draft.text).toBe('B文字');
  const restored = make(disk); await restored.load('s'); const versionA = restored.snapshot('s').versions.find(v => v.draft.text === 'A文字')!;
  expect(versionA.draft.attachments[0].text).toBe('完整附件正文');
  await restored.resolve('s', { version: versionA.key }); expect(restored.snapshot('s').draft.text).toBe('A文字');
  expect(restored.snapshot('s').versions.some(v => v.draft.text === 'B文字')).toBe(true);
});
it('选择远端保留本页副本，冲突期间继续输入只更新自己的分支', async () => {
  const disk = memoryDraftPersistence(), a = make(disk), b = make(disk); await a.load('s'); await b.load('s');
  a.setText('s', 'A'); await a.flush('s'); b.setText('s', 'B'); await b.flush('s'); b.setText('s', 'B继续编辑'); await b.flush('s');
  expect((await disk.read('alice', 's')).current.draft.text).toBe('A');
  await b.resolve('s', 'remote'); expect(b.snapshot('s').draft.text).toBe('A');
  expect(b.snapshot('s').versions.some(v => v.draft.text === 'B继续编辑')).toBe(true);
});
it('选择过程中主版本又更新，拒绝旧确认并刷新冲突预览，不盲目覆盖', async () => {
  const disk = memoryDraftPersistence(), a = make(disk), b = make(disk); await a.load('s'); await b.load('s');
  a.setText('s', 'A1'); await a.flush('s'); b.setText('s', 'B'); await b.flush('s');
  a.setText('s', 'A2'); await a.flush('s'); await b.resolve('s', 'local');
  expect(b.snapshot('s').conflict?.draft.text).toBe('A2'); expect((await disk.read('alice', 's')).current.draft.text).toBe('A2');
  await b.resolve('s', 'local'); expect((await disk.read('alice', 's')).current.draft.text).toBe('B');
});
it('空闲标签页跟随最新稿；有本地改动时不被刷新覆盖', async () => {
  const disk = memoryDraftPersistence(), a = make(disk), b = make(disk); await a.load('s'); await b.load('s');
  a.setText('s', 'A'); await a.flush('s'); await b.refresh('s'); expect(b.snapshot('s').draft.text).toBe('A');
  b.setText('s', 'B'); a.setText('s', 'A2'); await Promise.all([a.flush('s'), b.flush('s')]);
  expect(a.snapshot('s').draft.text).toBe('A2'); expect(b.snapshot('s').draft.text).toBe('B');
  expect(Boolean(a.snapshot('s').conflict) || Boolean(b.snapshot('s').conflict)).toBe(true);
});
it('两个标签页同时取走发送稿，只有一个成功；失败一方保留原文，不清掉别人的新稿', async () => {
  const disk = memoryDraftPersistence(), seed = make(disk); await seed.load('s'); seed.setText('s', '共同待发稿'); await seed.flush('s');
  const a = make(disk), b = make(disk); await a.load('s'); await b.load('s');
  const taken = await Promise.all([a.takeForSend('s'), b.takeForSend('s')]); expect(taken.filter(Boolean)).toHaveLength(1);
  const loser = taken[0] ? b : a; expect(loser.snapshot('s').draft.text).toBe('共同待发稿'); expect(loser.snapshot('s').conflict).toBeDefined();
  expect((await disk.read('alice', 's')).versions.some(v => v.draft.text === '共同待发稿')).toBe(true);
});
it('删除墓碑阻止旧标签页复活草稿，冲突副本不会跨账号读取', async () => {
  const disk = memoryDraftPersistence(), a = make(disk), b = make(disk); await a.load('s'); await b.load('s');
  a.setText('s', '私有'); await a.flush('s'); await disk.remove('alice', 's'); b.setText('s', '旧标签页迟到'); await b.flush('s');
  expect((await disk.read('alice', 's')).current.deleted).toBe(true); expect(b.snapshot('s').error).toMatch(/删除/);
  expect((await disk.read('bob', 's')).versions).toEqual([]); expect((await disk.read('bob', 's')).current.draft.text).toBe('');
});
it('以同一后端ID识别不同本地别名，并迁移旧本地ID草稿而不覆盖已存在的新稿', async () => {
  const disk = memoryDraftPersistence(), old = make(disk); await old.load('local-A'); old.setText('local-A', '升级前旧稿'); await old.flush('local-A');
  const a = make(disk, 'alice', () => 'server'), b = make(disk, 'alice', () => 'server');
  await a.load('local-A'); expect(a.snapshot('local-A').draft.text).toBe('升级前旧稿'); await b.load('local-B');
  a.setText('local-A', 'A'); await a.flush('local-A'); b.setText('local-B', 'B'); await b.flush('local-B'); expect(b.snapshot('local-B').conflict?.draft.text).toBe('A');
});
it('迁移时后端ID已有另一份稿：旧本地稿也显式保留，旧别名仅在备份成功后停用', async () => {
  const disk = memoryDraftPersistence(), old = make(disk); await old.load('local'); old.setText('local', '本地旧稿'); await old.flush('local');
  const remote = make(disk); await remote.load('server'); remote.setText('server', '新版本主稿'); await remote.flush('server');
  const migrated = make(disk, 'alice', () => 'server'); await migrated.load('local');
  expect(migrated.snapshot('local').draft.text).toBe('本地旧稿'); expect(migrated.snapshot('local').conflict?.draft.text).toBe('新版本主稿');
  expect((await disk.read('alice', 'server')).current.draft.text).toBe('新版本主稿'); expect((await disk.read('alice', 'local')).current.deleted).toBe(true);
  const reloaded = make(disk, 'alice', () => 'server'); await reloaded.load('local'); expect(reloaded.snapshot('local').conflict).toBeUndefined(); expect(reloaded.snapshot('local').versions.some(v => v.draft.text === '本地旧稿')).toBe(true);
});
