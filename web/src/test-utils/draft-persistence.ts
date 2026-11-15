import type { ComposerDraft } from '../lib/agent/composer-drafts';
import type { DraftPersistence, DraftRecord, DraftState, DraftVersion, DraftWrite } from '../lib/agent/draft-persistence';
const copyDraft = (d: ComposerDraft): ComposerDraft => ({ ...d, attachments: d.attachments.map(a => ({ ...a })) });
const clone = (s: DraftState): DraftState => ({ current: { ...s.current, draft: copyDraft(s.current.draft) }, versions: s.versions.map(v => ({ ...v, draft: copyDraft(v.draft) })) });
const same = (a: ComposerDraft, b: ComposerDraft) => ![...a.attachments, ...b.attachments].some(x => x.file) && JSON.stringify(a) === JSON.stringify(b);
export function memoryDraftPersistence(): DraftPersistence {
  const rows = new Map<string, DraftState>();
  const key = (owner: string, id: string) => JSON.stringify([owner, id]);
  const get = (owner: string, id: string) => rows.get(key(owner, id)) ?? { current: { draft: { text: '', attachments: [] }, revision: 0 }, versions: [] };
  const backup = (state: DraftState, draft: ComposerDraft, scope: string, branch: string, source: DraftVersion['source']) => {
    const version = { key: scope + ':' + branch, scope, draft: copyDraft(draft), basedOn: state.current.revision, createdAt: Date.now(), source };
    state.versions = [version, ...state.versions.filter(v => v.key !== version.key)];
  };
  const commit = (owner: string, id: string, state: DraftState, kind: DraftWrite['kind']): DraftWrite => { rows.set(key(owner, id), clone(state)); return { ...clone(state), kind }; };
  return {
    read: async (owner, id) => clone(get(owner, id)),
    write: async (owner, id, draft, expected, branch, _writer, options = {}) => {
      const state = clone(get(owner, id)); if (state.current.deleted) return { ...state, kind: 'deleted' };
      if (state.current.revision !== expected && (options.strict || !same(state.current.draft, draft))) { backup(state, options.backupDraft ?? draft, key(owner, id), branch, 'conflict'); return commit(owner, id, state, 'conflict'); }
      if (!options.strict && same(state.current.draft, draft)) return { ...state, kind: 'saved' };
      if (options.archiveCurrent) backup(state, state.current.draft, key(owner, id), crypto.randomUUID(), 'history');
      state.current = { draft: copyDraft(draft), revision: state.current.revision + 1 }; return commit(owner, id, state, 'saved');
    },
    resolve: async (owner, id, local, choice, expected, branch) => {
      const state = clone(get(owner, id)); if (state.current.deleted) return { ...state, kind: 'deleted' };
      backup(state, local, key(owner, id), branch, 'conflict');
      if (state.current.revision !== expected) return commit(owner, id, state, 'conflict');
      if (choice === 'remote') return commit(owner, id, state, 'saved');
      const draft = choice === 'local' ? local : state.versions.find(v => v.key === choice.version)?.draft; if (!draft) throw Error('Version unavailable');
      backup(state, state.current.draft, key(owner, id), crypto.randomUUID(), 'history');
      state.current = { draft: copyDraft(draft), revision: state.current.revision + 1 }; return commit(owner, id, state, 'saved');
    },
    remove: async (owner, id) => { const old = get(owner, id); rows.set(key(owner, id), { current: { draft: { text: '', attachments: [] }, revision: old.current.revision + 1, deleted: true }, versions: [] }); },
  };
}
let uiStorage = memoryDraftPersistence();
export const uiDraftPersistence = () => uiStorage;
export const resetUIDrafts = () => { uiStorage = memoryDraftPersistence(); };
