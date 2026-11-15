import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ owner: 'alice' }));
vi.mock('@/app/auth', () => ({ useAuth: () => ({ session: { user: { id: auth.owner } } }) }));
vi.mock('@/app/config', () => ({ supabaseClient: null }));
vi.mock('../agent/session-sync', async original => ({ ...await original<object>(), listRemoteSessions: vi.fn(), getRemoteHistory: vi.fn(), createRemoteSession: vi.fn(), patchRemoteSession: vi.fn(), removeRemoteSession: vi.fn(), importRemoteHistory: vi.fn() }));
import * as api from '../agent/session-sync';
import { SessionsProvider, useSessions } from '../agent/sessions-context';
import { newSession, saveSessions, loadSessions } from '../agent/sessions';
import type { RemoteSession, RemoteHistory } from '../agent/session-sync';
let remotes: RemoteSession[], histories: Map<string, RemoteHistory>;
function Probe({ name = 'A' }: { name?: string }) {
  const s = useSessions(); const first = s.sessions.find(x => x.backendId);
  return <section aria-label={name}><p data-testid={name+'-loading'}>{String(s.initialLoading)}</p><div data-testid={name+'-list'}>{s.sessions.filter(x => x.backendId).map(x => <p key={x.id}>{x.name}:{x.archived ? 'archived' : 'active'}</p>)}</div><div data-testid={name+'-messages'}>{s.active.messages.map((m,i) => <p key={i}>{m.content}</p>)}</div><p>{s.syncError}</p><button onClick={() => first && s.rename(first.id, '同步后的名称')}>{name}-rename</button><button onClick={() => first && s.archive(first.id)}>{name}-archive</button><button onClick={() => first && s.restore(first.id)}>{name}-restore</button><button onClick={() => first && s.remove(first.id)}>{name}-delete</button><button onClick={s.refresh}>{name}-refresh</button></section>;
}
beforeEach(() => {
  vi.stubEnv('VITE_BACKEND_URL', 'http://backend.test'); auth.owner = 'alice'; localStorage.clear(); vi.clearAllMocks();
  remotes = [{ id: 'server-session', title: '云端会话', mode: 'auto', archived: false, revision: 0, createdAt: 1, updatedAt: 1 }];
  histories = new Map([['server-session', { session: remotes[0], messages: [{ role: 'user', content: '完整问题', turnId: 'turn' }, { role: 'assistant', content: '完整回答', taskId: 'task', turnId: 'turn' }], tasks: [] }]]);
  vi.mocked(api.listRemoteSessions).mockImplementation(async () => structuredClone(remotes));
  vi.mocked(api.getRemoteHistory).mockImplementation(async id => structuredClone({ ...histories.get(id)!, session: remotes.find(r => r.id === id)! }));
  vi.mocked(api.createRemoteSession).mockImplementation(async input => { let r = remotes.find(r => r.id === input.id); if (!r) { r = { ...input, revision: 0, createdAt: 2, updatedAt: 2 }; remotes.push(r); histories.set(r.id, { session: r, messages: [], tasks: [] }); } return structuredClone(r); });
  vi.mocked(api.patchRemoteSession).mockImplementation(async (id, patch) => { const r = remotes.find(r => r.id === id)!; if ((r.revision ?? 0) !== patch.expectedRevision) throw Error('409 stale revision'); Object.assign(r, patch, { revision: patch.expectedRevision+1 }); return structuredClone(r); });
  vi.mocked(api.removeRemoteSession).mockImplementation(async id => { const r = remotes.find(r => r.id === id)!; r.deletedAt = 3; r.revision = (r.revision ?? 0)+1; return structuredClone(r); });
  vi.mocked(api.importRemoteHistory).mockImplementation(async (id, messages) => { histories.get(id)!.messages = messages.map(m => ({ ...m, imported: true })); });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
it('有未发送草稿的本地空会话不被后台同步删除或自动切走', async () => {
  const local = { ...newSession(), hasDraft: true }; saveSessions([local], 'alice');
  render(<SessionsProvider><Probe /></SessionsProvider>);
  await waitFor(() => expect(screen.getByTestId('A-loading')).toHaveTextContent('false'));
  expect(loadSessions('alice').some(s => s.id === local.id && s.hasDraft)).toBe(true);
  expect(localStorage.getItem('campusmate.active-session.v1:alice')).toBe(local.id);
  expect(api.createRemoteSession).not.toHaveBeenCalled();
});
it('空浏览器从后端恢复名称、完整对话，不新建重复空会话', async () => {
  render(<SessionsProvider><Probe /></SessionsProvider>);
  await waitFor(() => expect(screen.getByTestId('A-list')).toHaveTextContent('云端会话:active'));
  await waitFor(() => expect(screen.getByTestId('A-messages')).toHaveTextContent('完整回答'));
  expect(api.createRemoteSession).not.toHaveBeenCalled(); expect(loadSessions('alice')).toHaveLength(1);
});
it('两个窗口同步重命名、归档、恢复和删除，旧缓存不复活已删除会话', async () => {
  render(<><SessionsProvider><Probe name="A" /></SessionsProvider><SessionsProvider><Probe name="B" /></SessionsProvider></>);
  await waitFor(() => expect(screen.getByTestId('B-messages')).toHaveTextContent('完整回答'));
  fireEvent.click(screen.getByText('A-rename')); await waitFor(() => expect(screen.getByTestId('A-list')).toHaveTextContent('同步后的名称'));
  fireEvent.click(screen.getByText('B-refresh')); await waitFor(() => expect(screen.getByTestId('B-list')).toHaveTextContent('同步后的名称'));
  fireEvent.click(screen.getByText('A-archive')); await waitFor(() => expect(screen.getByTestId('A-list')).toHaveTextContent('archived'));
  fireEvent.click(screen.getByText('B-refresh')); await waitFor(() => expect(screen.getByTestId('B-list')).toHaveTextContent('archived'));
  fireEvent.click(screen.getByText('B-restore')); await waitFor(() => expect(screen.getByTestId('B-list')).toHaveTextContent('active'));
  fireEvent.click(screen.getByText('A-refresh')); await waitFor(() => expect(screen.getByTestId('A-list')).toHaveTextContent('active'));
  fireEvent.click(screen.getByText('A-delete')); await waitFor(() => expect(screen.getByTestId('A-list')).toBeEmptyDOMElement());
  fireEvent.click(screen.getByText('B-refresh')); await waitFor(() => expect(screen.getByTestId('B-list')).toBeEmptyDOMElement());
  expect(api.createRemoteSession).not.toHaveBeenCalled();
});
it('保存失败不显示假成功，原名称和本地记录仍在', async () => {
  render(<SessionsProvider><Probe /></SessionsProvider>); await waitFor(() => expect(screen.getByTestId('A-loading')).toHaveTextContent('false'));
  vi.mocked(api.patchRemoteSession).mockRejectedValueOnce(Error('disk fixture failure'));
  fireEvent.click(screen.getByText('A-rename'));
  await waitFor(() => expect(api.patchRemoteSession).toHaveBeenCalled());
  expect(screen.getByTestId('A-list')).toHaveTextContent('云端会话'); expect(screen.getByTestId('A-list')).not.toHaveTextContent('同步后的名称');
});
it('纯浏览器旧会话先备份再导入，不重复消息，清缓存后仍可恢复', async () => {
  remotes = []; histories.clear();
  const s = { ...newSession(), name: '本地旧会话', messages: [{ role: 'user' as const, content: '旧问题', turnId: 'local-turn' }, { role: 'assistant' as const, content: '旧回答', taskId: 'local:old' }] }; saveSessions([s], 'alice');
  const first = render(<SessionsProvider><Probe /></SessionsProvider>);
  await waitFor(() => expect(screen.getByTestId('A-messages')).toHaveTextContent('旧回答'));
  await waitFor(() => expect(api.importRemoteHistory).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(loadSessions('alice')[0].remoteRevision).toBeDefined());
  expect(loadSessions('alice')[0].messages).toHaveLength(2);
  expect(localStorage.getItem('campusmate.sessions.before-cloud.v1:alice')).toContain('旧回答');
  first.unmount(); localStorage.clear();
  render(<SessionsProvider><Probe /></SessionsProvider>);
  await waitFor(() => expect(screen.getByTestId('A-messages')).toHaveTextContent('旧问题'));
  expect(api.importRemoteHistory).toHaveBeenCalledTimes(1);
});
it('旧账号的迟到响应不能写入新账号缓存，所有请求绑定预期owner', async () => {
  let release!: (value: RemoteSession[]) => void;
  vi.mocked(api.listRemoteSessions).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = render(<SessionsProvider><Probe /></SessionsProvider>);
  await waitFor(() => expect(api.listRemoteSessions).toHaveBeenCalled());
  auth.owner = 'bob'; remotes = []; view.rerender(<SessionsProvider><Probe /></SessionsProvider>);
  await act(async () => release([{ id: 'alice-private', title: '不应出现在Bob', mode: 'auto', createdAt: 1, updatedAt: 1 }]));
  await waitFor(() => expect(screen.getByTestId('A-loading')).toHaveTextContent('false'));
  expect(screen.getByTestId('A-list')).not.toHaveTextContent('不应出现在Bob');
  expect(api.listRemoteSessions).toHaveBeenCalledWith(expect.any(AbortSignal), 'bob');
  expect(JSON.stringify(loadSessions('bob'))).not.toContain('alice-private');
});
