import { parseFile, type Attachment } from '@/lib/ingest/files';
import { attachmentSetError, attachmentSendError, validateAttachmentFile, AttachmentPolicyError } from '../ingest/limits';
import { createDraftPersistence, emptyDraft, sameDraft, validDraft, type DraftPersistence, type DraftRecord, type DraftVersion, type DraftWrite } from './draft-persistence';
export { createDraftPersistence } from './draft-persistence';
export type { DraftPersistence } from './draft-persistence';
export interface DraftAttachment extends Attachment { id: string; status: 'parsing' | 'ready' | 'error'; file?: File; error?: string; }
export interface ComposerDraft { text: string; attachments: DraftAttachment[]; titleEdit?: string; }
export interface DraftSnapshot { draft: ComposerDraft; ready: boolean; saving: boolean; resolving: boolean; error: string | null; conflict?: DraftRecord; versions: DraftVersion[]; }
export const draftHasContent = (draft: ComposerDraft) => Boolean(draft.text.length || draft.attachments.length || draft.titleEdit !== undefined);
interface Entry {
  snapshot: DraftSnapshot; storageId: string; load?: Promise<void>; queue: Promise<void>; revision: number; savedRevision: number;
  base: number; branch: string; readFailed: boolean; jobs: Set<string>; controllers: Map<string, AbortController>; refresh?: Promise<void>; resolution?: Promise<unknown>;
}
export class ComposerDraftStore {
  private accepting = true;
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private rawFiles = new Map<string, File>();
  private stopChanges?: () => void;
  private writer = crypto.randomUUID();
  constructor(private owner: string, private exists: (id: string) => boolean, private mark: (id: string, hasDraft: boolean) => void,
    private persistence: DraftPersistence = createDraftPersistence(), private parse: (file: File, signal?: AbortSignal) => Promise<Attachment> = parseFile, private storageKey: (id: string) => string = id => id) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate() {
    this.accepting = true; this.stopChanges?.();
    this.stopChanges = this.persistence.subscribe?.(this.owner, notice => { if (notice.writer !== this.writer) for (const [id, e] of this.entries) if (e.storageId === notice.sessionId) void this.refresh(id); });
    for (const [id, entry] of this.entries) if (entry.snapshot.ready) this.startParses(id, entry.snapshot.draft);
  }
  deactivate() { this.accepting = false; this.stopChanges?.(); this.stopChanges = undefined; for (const entry of this.entries.values()) for (const controller of entry.controllers.values()) controller.abort(); }
  private notify() { for (const listener of this.listeners) listener(); }
  private markEntry(id: string, entry: Entry) { this.mark(id, draftHasContent(entry.snapshot.draft) || entry.snapshot.versions.some(v => draftHasContent(v.draft))); }
  private entry(id: string) {
    let entry = this.entries.get(id);
    if (!entry) {
      let storageId = id; try { storageId = this.storageKey(id); } catch { /* local-only fallback */ }
      entry = { snapshot: { draft: emptyDraft(), ready: false, saving: false, resolving: false, error: null, versions: [] }, storageId, queue: Promise.resolve(), revision: 0, savedRevision: 0, base: 0, branch: crypto.randomUUID(), readFailed: false, jobs: new Set(), controllers: new Map() }; this.entries.set(id, entry);
    }
    return entry;
  }
  snapshot = (id: string) => this.entry(id).snapshot;
  rawFile = (id: string): File | undefined => this.rawFiles.get(id);
  private current(id: string, entry: Entry) { return this.accepting && this.exists(id) && this.entries.get(id) === entry; }
  private cancelRemoved(entry: Entry, draft: ComposerDraft) { for (const [id, controller] of entry.controllers) if (!draft.attachments.some(a => a.id === id)) controller.abort(); }
  private startParses(id: string, draft: ComposerDraft) { this.cancelRemoved(this.entry(id), draft); for (const attachment of draft.attachments) if (attachment.status === 'parsing') this.process(id, attachment); }
  load(id: string): Promise<void> {
    const entry = this.entry(id); if (entry.load) return entry.load;
    entry.load = (async () => {
      try {
        let state = await this.persistence.read(this.owner, entry.storageId), migrationConflict: ComposerDraft | undefined;
        if (entry.storageId !== id && !state.current.deleted) {
          const legacy = await this.persistence.read(this.owner, id);
          if (draftHasContent(legacy.current.draft) && !legacy.current.deleted) {
            if (!sameDraft(state.current.draft, legacy.current.draft)) {
              const empty = state.current.revision === 0 && !draftHasContent(state.current.draft) && !state.versions.length;
              const result = await this.persistence.write(this.owner, entry.storageId, legacy.current.draft, empty ? 0 : -1, entry.branch, this.writer, { strict: true });
              state = result; if (result.kind === 'conflict') migrationConflict = legacy.current.draft;
            }
            // Only retire the old alias AFTER a successful commit/backup. Otherwise
            // an old local copy would reappear as a conflict on every refresh.
            await this.persistence.remove(this.owner, id, this.writer);
          }
        }
        if (!this.current(id, entry)) return;
        if (!validDraft(state.current.draft)) throw new Error('Invalid draft');
        entry.base = migrationConflict ? -1 : state.current.revision; if (migrationConflict) entry.revision++;
        entry.snapshot = { ...entry.snapshot, draft: migrationConflict ?? state.current.draft, ready: true, versions: state.versions, error: state.current.deleted ? '草稿已在其他标签页删除，请新建会话。' : null, conflict: state.current.deleted || migrationConflict ? state.current : undefined };
        this.markEntry(id, entry); this.notify(); this.startParses(id, entry.snapshot.draft);
      } catch {
        if (!this.current(id, entry)) return;
        entry.readFailed = true; entry.snapshot = { ...entry.snapshot, ready: true, error: '本地草稿存储不可用，当前内容仅暂存在内存；刷新可能丢失，请先复制备份。' }; this.notify();
      }
    })(); return entry.load;
  }
  private apply(id: string, entry: Entry, result: DraftWrite, sequence: number, adopt = false) {
    if (this.entries.get(id) !== entry) return;
    if (result.kind === 'saved') {
      entry.base = result.current.revision; entry.savedRevision = sequence;
      entry.snapshot = { ...entry.snapshot, ...(adopt ? { draft: result.current.draft } : {}), conflict: undefined, versions: result.versions, saving: sequence !== entry.revision, error: null };
    } else entry.snapshot = { ...entry.snapshot, conflict: result.current, versions: result.versions, saving: sequence !== entry.revision,
      error: result.kind === 'deleted' ? '草稿已在其他标签页删除，当前内容未重新写入；请复制备份或新建会话。' : null };
    if (this.accepting) { this.markEntry(id, entry); this.notify(); }
  }
  private save(id: string, entry: Entry, draft: ComposerDraft, sequence: number) {
    if (entry.readFailed) return;
    entry.queue = entry.queue.catch(() => {}).then(async () => {
      if (this.entries.get(id) !== entry) return;
      const result = await this.persistence.write(this.owner, entry.storageId, draft, entry.base, entry.branch, this.writer);
      this.apply(id, entry, result, sequence);
    }).catch(() => { if (this.entries.get(id) === entry && sequence === entry.revision) { entry.snapshot = { ...entry.snapshot, saving: false, error: '草稿未能保存到本机，可能是空间不足或权限受限；当前内容仍在，请先复制备份，刷新可能丢失。' }; this.notify(); } });
  }
  private change(id: string, update: (draft: ComposerDraft) => ComposerDraft) {
    if (!this.accepting || !this.exists(id)) return;
    const entry = this.entry(id); if (!entry.snapshot.ready || entry.snapshot.resolving) return;
    const draft = update(entry.snapshot.draft), sequence = ++entry.revision;
    entry.snapshot = { ...entry.snapshot, draft, saving: !entry.readFailed };
    this.cancelRemoved(entry, draft);
    this.markEntry(id, entry); this.notify(); this.save(id, entry, draft, sequence);
  }
  async refresh(id: string) {
    const entry = this.entries.get(id); if (!entry?.snapshot.ready || entry.readFailed || entry.snapshot.resolving || !this.current(id, entry)) return;
    if (entry.refresh) return entry.refresh;
    entry.refresh = (async () => {
      await entry.queue; const sequence = entry.revision;
      const state = await this.persistence.read(this.owner, entry.storageId);
      if (!this.current(id, entry) || sequence !== entry.revision || entry.snapshot.resolving || state.current.revision < entry.base) return;
      if (state.current.deleted) { entry.snapshot = { ...entry.snapshot, conflict: state.current, versions: state.versions, error: '草稿已在其他标签页删除，请新建会话。' }; this.notify(); return; }
      if (entry.revision === entry.savedRevision && !entry.snapshot.conflict || sameDraft(entry.snapshot.draft, state.current.draft)) {
        entry.base = state.current.revision; entry.savedRevision = sequence;
        entry.snapshot = { ...entry.snapshot, draft: state.current.draft, versions: state.versions, conflict: undefined, error: null }; this.markEntry(id, entry); this.notify(); this.startParses(id, state.current.draft);
      } else if (state.current.revision !== entry.base) {
        entry.snapshot = { ...entry.snapshot, conflict: state.current, versions: state.versions, saving: true }; this.notify(); this.save(id, entry, entry.snapshot.draft, sequence);
      } else { entry.snapshot = { ...entry.snapshot, versions: state.versions }; this.notify(); }
    })().catch(() => { /* next write still checks the authoritative revision */ }).finally(() => { entry.refresh = undefined; });
    return entry.refresh;
  }
  refreshLoaded() { for (const id of this.entries.keys()) void this.refresh(id); }
  setText(id: string, text: string) { this.change(id, draft => ({ ...draft, text })); }
  setTitleEdit(id: string, titleEdit: string | undefined) { this.change(id, draft => ({ ...draft, titleEdit })); }
  private async transition(id: string, kind: 'send' | 'title'): Promise<ComposerDraft | undefined> {
    const entry = this.entry(id); if (!this.current(id, entry) || !entry.snapshot.ready || entry.snapshot.resolving) return;
    entry.snapshot = { ...entry.snapshot, resolving: true }; this.notify();
    const action = (async () => {
      await entry.queue;
      if (!this.current(id, entry) || entry.snapshot.conflict || entry.readFailed) return;
      const original = entry.snapshot.draft;
      // Older/restored drafts may predate the picker limit. Keep the entire
      // draft intact instead of consuming it and letting the API reject it.
      const imageError = kind === 'send' ? attachmentSendError(original.text, original.attachments) : undefined;
      if (imageError) { entry.snapshot = { ...entry.snapshot, error: imageError }; this.notify(); return; }
      if (kind === 'send' && !original.text.trim() && !original.attachments.length) return;
      if (kind === 'send' && original.attachments.some(a => a.status !== 'ready') || kind === 'title' && original.titleEdit === undefined) return;
      const next = kind === 'send' ? { ...original, text: '', attachments: [] } : { ...original, titleEdit: undefined };
      const sequence = ++entry.revision;
      const result = await this.persistence.write(this.owner, entry.storageId, next, entry.base, entry.branch, this.writer, { strict: true, backupDraft: original, archiveCurrent: true });
      this.apply(id, entry, result, sequence, result.kind === 'saved');
      if (result.kind === 'saved') { entry.branch = crypto.randomUUID(); return original; }
    })().catch(() => { entry.snapshot = { ...entry.snapshot, error: '草稿未能安全提交，本页内容已保留；请先解决存储问题或复制备份。' }; this.notify(); return undefined; }).finally(() => { entry.resolution = undefined; entry.snapshot = { ...entry.snapshot, resolving: false }; this.notify(); });
    entry.resolution = action; return action;
  }
  takeForSend(id: string) { return this.transition(id, 'send'); }
  async finishTitle(id: string) { return (await this.transition(id, 'title'))?.titleEdit; }
  async resolve(id: string, choice: 'local' | 'remote' | { version: string }) {
    const entry = this.entry(id); if (!this.current(id, entry) || entry.snapshot.resolving) return;
    entry.snapshot = { ...entry.snapshot, resolving: true }; this.notify();
    const action = (async () => {
      await entry.queue; if (!this.current(id, entry) || entry.readFailed) return;
      const expected = entry.snapshot.conflict?.revision ?? entry.base, sequence = ++entry.revision;
      const result = await this.persistence.resolve(this.owner, entry.storageId, entry.snapshot.draft, choice, expected, entry.branch, this.writer);
      this.apply(id, entry, result, sequence, result.kind === 'saved');
      if (result.kind === 'saved') { entry.branch = crypto.randomUUID(); this.startParses(id, result.current.draft); }
    })().catch(() => { entry.snapshot = { ...entry.snapshot, error: '草稿版本选择未保存，两份内容未被覆盖，请稍后重试。' }; this.notify(); }).finally(() => { entry.resolution = undefined; entry.snapshot = { ...entry.snapshot, resolving: false }; this.notify(); this.startParses(id, entry.snapshot.draft); });
    entry.resolution = action; return action;
  }
  clearComposer(id: string) { const entry = this.entries.get(id); for (const attachment of entry?.snapshot.draft.attachments ?? []) this.rawFiles.delete(attachment.id); this.change(id, draft => ({ ...draft, text: '', attachments: [] })); }
  removeAttachment(id: string, attachmentId: string) { this.rawFiles.delete(attachmentId); this.change(id, draft => ({ ...draft, attachments: draft.attachments.filter(a => a.id !== attachmentId) })); this.entries.get(id)?.controllers.get(attachmentId)?.abort(); }
  async addFiles(id: string, files: File[]) {
    await this.load(id); const entry = this.entry(id); if (!this.current(id, entry) || entry.snapshot.resolving) return;
    // Reject the whole selection before parsing/persisting, including mixed
    // selections, repeated paste/drop and files already being parsed.
    const attachments: DraftAttachment[] = files.map(file => ({ id: crypto.randomUUID(), name: file.name, kind: validateAttachmentFile(file) === 'image' ? 'image' : 'doc', sizeBytes: file.size, status: 'parsing', file }));
    for (const [index, attachment] of attachments.entries()) this.rawFiles.set(attachment.id, files[index]);
    const error = attachmentSetError([...entry.snapshot.draft.attachments, ...attachments]);
    if (error) throw new AttachmentPolicyError(error);
    this.change(id, draft => ({ ...draft, attachments: [...draft.attachments, ...attachments] }));
    for (const attachment of attachments) this.process(id, attachment);
  }
  private process(id: string, attachment: DraftAttachment) {
    const entry = this.entry(id); if (entry.jobs.has(attachment.id)) return; entry.jobs.add(attachment.id);
    const controller = new AbortController(); entry.controllers.set(attachment.id, controller);
    const replace = async (value: DraftAttachment, validate = true) => {
      if (entry.resolution) await entry.resolution;
      if (!this.current(id, entry) || !entry.snapshot.draft.attachments.some(a => a.id === attachment.id)) return;
      this.change(id, draft => {
        const attachments = draft.attachments.map(a => a.id === attachment.id ? value : a);
        const error = validate ? attachmentSetError(attachments) : undefined;
        if (error) throw new AttachmentPolicyError(error);
        return { ...draft, attachments };
      });
    };
    void Promise.resolve().then(() => {
      if (!this.current(id, entry) || !entry.snapshot.draft.attachments.some(a => a.id === attachment.id)) return undefined;
      const error = attachmentSetError(entry.snapshot.draft.attachments); if (error) throw new AttachmentPolicyError(error);
      if (!attachment.file) throw new Error('File missing');
      validateAttachmentFile(attachment.file); return this.parse(attachment.file, controller.signal);
    }).then(parsed => { if (parsed && !controller.signal.aborted) return replace({ ...parsed, sizeBytes: attachment.file!.size, id: attachment.id, status: 'ready' }); })
      .catch(error => { if (!controller.signal.aborted) return replace({ ...attachment, status: 'error', error: error instanceof AttachmentPolicyError ? error.message : '附件解析失败，请检查文件格式后重新添加；不会发送不完整附件。' }, false); })
      .finally(() => {
        entry.jobs.delete(attachment.id); entry.controllers.delete(attachment.id);
        if (controller.signal.aborted && this.current(id, entry)) { const pending = entry.snapshot.draft.attachments.find(a => a.id === attachment.id && a.status === 'parsing'); if (pending) this.process(id, pending); }
      });
  }
  remove(id: string, storageId?: string) {
    const entry = this.entries.get(id);
    for (const attachment of entry?.snapshot.draft.attachments ?? []) this.rawFiles.delete(attachment.id); this.entries.delete(id);
    for (const controller of entry?.controllers.values() ?? []) controller.abort();
    const target = storageId ?? entry?.storageId ?? this.storageKey(id);
    void (entry?.queue ?? Promise.resolve()).catch(() => {}).then(async () => { await entry?.resolution; await this.persistence.remove(this.owner, target, this.writer); if (target !== id) await this.persistence.remove(this.owner, id, this.writer); }).catch(() => {}); this.notify();
  }
  hasPendingWrites() { return [...this.entries.values()].some(e => e.snapshot.saving || e.snapshot.resolving || Boolean(e.snapshot.error && e.revision !== e.savedRevision)); }
  async flush(id: string) { await this.entries.get(id)?.queue; }
}
