import type { ComposerDraft } from './composer-drafts';

export interface DraftRecord { draft: ComposerDraft; revision: number; deleted?: boolean; }
export interface DraftVersion { key: string; scope: string; draft: ComposerDraft; basedOn: number; createdAt: number; source: 'conflict' | 'history'; }
export interface DraftState { current: DraftRecord; versions: DraftVersion[]; }
export interface DraftWrite extends DraftState { kind: 'saved' | 'conflict' | 'deleted'; }
export interface DraftNotice { owner: string; sessionId: string; writer: string; }
export interface DraftWriteOptions { backupDraft?: ComposerDraft; strict?: boolean; archiveCurrent?: boolean; }
export interface DraftPersistence {
  read(owner: string, id: string): Promise<DraftState>;
  write(owner: string, id: string, draft: ComposerDraft, expected: number, branch: string, writer: string, options?: DraftWriteOptions): Promise<DraftWrite>;
  resolve(owner: string, id: string, local: ComposerDraft, choice: 'local' | 'remote' | { version: string }, expected: number, branch: string, writer: string): Promise<DraftWrite>;
  remove(owner: string, id: string, writer?: string): Promise<void>;
  subscribe?(owner: string, listener: (notice: DraftNotice) => void): () => void;
}
export const emptyDraft = (): ComposerDraft => ({ text: '', attachments: [] });
export function validDraft(value: any): value is ComposerDraft {
  return Boolean(value && typeof value.text === 'string' && Array.isArray(value.attachments) && (value.titleEdit === undefined || typeof value.titleEdit === 'string') && value.attachments.every((a: any) => a && typeof a.id === 'string' && typeof a.name === 'string' && ['image', 'doc'].includes(a.kind) && ['parsing', 'ready', 'error'].includes(a.status)));
}
export function sameDraft(a: ComposerDraft, b: ComposerDraft) {
  // Never infer Blob equality from filename/size. Ready attachments contain exact
  // text/dataURL bytes and IDs; pending blobs conservatively cause a conflict.
  if ([...a.attachments, ...b.attachments].some(item => item.file)) return false;
  const values = (d: ComposerDraft) => [d.text, d.titleEdit ?? null, d.attachments.map(x => [x.id, x.name, x.kind, x.status, x.sizeBytes ?? null, x.text ?? null, x.dataUrl ?? null, x.error ?? null])];
  return JSON.stringify(values(a)) === JSON.stringify(values(b));
}
function record(value: any): DraftRecord {
  if (value === undefined) return { draft: emptyDraft(), revision: 0 };
  // Upgrade old raw v1 records in place only when a successful CAS writes them.
  if (validDraft(value)) return { draft: value, revision: 0 };
  if (value?.format === 2 && validDraft(value.draft) && Number.isSafeInteger(value.revision) && value.revision >= 0) return { draft: value.draft, revision: value.revision, deleted: value.deleted === true };
  throw new Error('Invalid draft record');
}

export function createDraftPersistence(): DraftPersistence {
  let database: Promise<IDBDatabase> | undefined;
  const scope = (owner: string, id: string) => JSON.stringify([owner, id]);
  const listeners = new Set<(notice: DraftNotice) => void>(); let channel: BroadcastChannel | undefined;
  const notify = (notice: DraftNotice) => {
    for (const listener of listeners) listener(notice);
    try { if (channel) channel.postMessage(notice); else { const temporary = new BroadcastChannel('campusmate-drafts-v2'); temporary.postMessage(notice); temporary.close(); } } catch { /* CAS still works without notifications */ }
    try { localStorage.setItem('campusmate.drafts.changed.v2', JSON.stringify({ ...notice, nonce: crypto.randomUUID() })); } catch { /* focus reconciliation is the fallback */ }
  };
  const open = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const request = indexedDB.open('campusmate-composer-v1', 2); let abandoned = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts');
      if (!request.result.objectStoreNames.contains('versions')) request.result.createObjectStore('versions', { keyPath: 'key' }).createIndex('scope', 'scope');
    };
    request.onsuccess = () => { if (abandoned) { request.result.close(); return; } request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { abandoned = true; database = undefined; reject(new Error('Draft database blocked; refresh older tabs')); };
  });
  async function atomic<T>(mode: IDBTransactionMode, owner: string, id: string, operation: (current: DraftRecord, versions: DraftVersion[], drafts: IDBObjectStore, history: IDBObjectStore) => T): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(['drafts', 'versions'], mode), drafts = tx.objectStore('drafts'), history = tx.objectStore('versions');
      const primary = drafts.get(scope(owner, id)), backups = history.index('scope').getAll(scope(owner, id)); let result: T, failure: unknown, ran = false;
      const run = () => {
        if (ran || primary.readyState !== 'done' || backups.readyState !== 'done') return; ran = true;
        try { result = operation(record(primary.result), backups.result.filter(v => v && typeof v.key === 'string' && validDraft(v.draft)).sort((a, b) => b.createdAt - a.createdAt), drafts, history); }
        catch (error) { failure = error; tx.abort(); }
      };
      primary.onsuccess = run; backups.onsuccess = run;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('Draft transaction failed'));
    });
  }
  const keep = (owner: string, id: string, draft: ComposerDraft, revision: number, key: string, source: DraftVersion['source']): DraftVersion => ({ key: scope(owner, id) + ':' + key, scope: scope(owner, id), draft, basedOn: revision, createdAt: Date.now(), source });
  const put = (drafts: IDBObjectStore, owner: string, id: string, value: DraftRecord) => drafts.put({ ...value, format: 2 }, scope(owner, id));
  return {
    read: (owner, id) => atomic('readonly', owner, id, (current, versions) => ({ current, versions })),
    write: async (owner, id, draft, expected, branch, writer, options = {}) => {
      const result = await atomic<DraftWrite>('readwrite', owner, id, (current, versions, drafts, history) => {
        if (current.deleted) return { kind: 'deleted', current, versions };
        if (current.revision !== expected && (options.strict || !sameDraft(current.draft, draft))) {
          const backup = keep(owner, id, options.backupDraft ?? draft, expected, branch, 'conflict'); history.put(backup);
          return { kind: 'conflict', current, versions: [backup, ...versions.filter(v => v.key !== backup.key)] };
        }
        if (!options.strict && sameDraft(current.draft, draft)) return { kind: 'saved', current, versions };
        if (options.archiveCurrent) { const backup = keep(owner, id, current.draft, current.revision, crypto.randomUUID(), 'history'); history.put(backup); versions = [backup, ...versions]; }
        const next = { draft, revision: current.revision + 1 }; put(drafts, owner, id, next); return { kind: 'saved', current: next, versions };
      });
      notify({ owner, sessionId: id, writer }); return result;
    },
    resolve: async (owner, id, local, choice, expected, branch, writer) => {
      const result = await atomic<DraftWrite>('readwrite', owner, id, (current, versions, drafts, history) => {
        if (current.deleted) return { kind: 'deleted', current, versions };
        const backup = keep(owner, id, local, expected, branch, 'conflict'); history.put(backup); versions = [backup, ...versions.filter(v => v.key !== backup.key)];
        if (current.revision !== expected) return { kind: 'conflict', current, versions };
        if (choice === 'remote') return { kind: 'saved', current, versions };
        const selected = choice === 'local' ? local : versions.find(v => v.key === choice.version)?.draft;
        if (!selected || !validDraft(selected)) throw new Error('Draft version unavailable');
        const previous = keep(owner, id, current.draft, current.revision, crypto.randomUUID(), 'history'); history.put(previous);
        const next = { draft: selected, revision: current.revision + 1 }; put(drafts, owner, id, next); return { kind: 'saved', current: next, versions: [previous, ...versions] };
      });
      notify({ owner, sessionId: id, writer }); return result;
    },
    remove: async (owner, id, writer = '') => {
      await atomic('readwrite', owner, id, (current, versions, drafts, history) => { for (const version of versions) history.delete(version.key); put(drafts, owner, id, { draft: emptyDraft(), revision: current.revision + 1, deleted: true }); });
      notify({ owner, sessionId: id, writer });
    },
    subscribe: (owner, callback) => {
      const listener = (notice: DraftNotice) => { if (notice?.owner === owner && typeof notice.sessionId === 'string' && typeof notice.writer === 'string') callback(notice); };
      listeners.add(listener);
      if (!channel) try { channel = new BroadcastChannel('campusmate-drafts-v2'); channel.onmessage = event => { for (const l of listeners) l(event.data); }; } catch { /* storage/focus fallback */ }
      const storage = (event: StorageEvent) => { if (event.key === 'campusmate.drafts.changed.v2' && event.newValue) try { listener(JSON.parse(event.newValue)); } catch { /* metadata only */ } };
      window.addEventListener('storage', storage);
      return () => { listeners.delete(listener); window.removeEventListener('storage', storage); if (!listeners.size) { channel?.close(); channel = undefined; } };
    },
  };
}
