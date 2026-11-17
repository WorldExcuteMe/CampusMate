import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { ComposerDraftStore } from './composer-drafts';
const Context = createContext<ComposerDraftStore | null>(null);
export function ComposerDraftsProvider({ store, children }: { store: ComposerDraftStore; children: ReactNode }) {
  useEffect(() => {
    store.activate();
    const unload = (event: BeforeUnloadEvent) => { if (store.hasPendingWrites()) { event.preventDefault(); event.returnValue = ''; } };
    const focus = () => { if (document.visibilityState !== 'hidden') store.refreshLoaded(); };
    window.addEventListener('beforeunload', unload); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { store.deactivate(); window.removeEventListener('beforeunload', unload); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useComposerDraft(sessionId: string) {
  const store = useContext(Context); if (!store) throw new Error('Composer draft store missing');
  const snapshot = useSyncExternalStore(store.subscribe, () => store.snapshot(sessionId));
  useEffect(() => { void store.load(sessionId); }, [store, sessionId]);
  return { ...snapshot, setText: (text: string) => store.setText(sessionId, text), setTitleEdit: (value: string | undefined) => store.setTitleEdit(sessionId, value), finishTitle: () => store.finishTitle(sessionId),
    takeForSend: () => store.takeForSend(sessionId), resolve: (choice: 'local' | 'remote' | { version: string }) => store.resolve(sessionId, choice),
    clear: () => store.clearComposer(sessionId), removeAttachment: (id: string) => store.removeAttachment(sessionId, id), addFiles: (files: File[]) => store.addFiles(sessionId, files) };
}
