import { useEffect, useRef, useState } from 'react';
import { Bot, Check, Copy, Pencil, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MockBadge } from '@/components/shared';
import { cn } from '@/lib/utils';
import type { SessionMsg } from '@/lib/agent/sessions';
import { hasRawToolMarkup, TOOL_PROTOCOL_ERROR } from '../../../../shared/tool-protocol';
import { AssistantMessage } from './AssistantMessage';

export function ChatMessageRow({ message, ordinal, busy, onResend }: { message: SessionMsg; ordinal: number; busy: boolean; onResend: (content: string) => void }) {
  const user = message.role === 'user';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (copyState !== 'copied') return; const timer = setTimeout(() => setCopyState('idle'), 2000); return () => clearTimeout(timer); }, [copyState]);
  async function copy() {
    setCopyState('copying');
    try {
      const content = !user && hasRawToolMarkup(message.content) ? TOOL_PROTOCOL_ERROR : message.content;
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      // Copy original Markdown as plain text, not rendered HTML or hidden metadata.
      await navigator.clipboard.writeText(content);
      if (alive.current) setCopyState('copied');
    } catch { if (alive.current) setCopyState('failed'); }
  }
  return <div className={cn('group/message flex gap-3', user ? 'justify-end' : 'justify-start')}>
    {!user && <Bot className="mt-1 size-5 shrink-0 text-primary" />}
    <div className={cn('min-w-0 max-w-[85%]', editing && 'w-full')}>
      {editing && user ? <form aria-label={`编辑第 ${ordinal} 条消息`} className="space-y-2 rounded-xl border border-primary/30 bg-muted/40 p-3" onSubmit={event => { event.preventDefault(); const text = draft.trim(); if (!text || busy) return; setEditing(false); onResend(text); }}>
        <label className="text-xs font-medium" htmlFor={`edit-message-${ordinal}`}>编辑消息</label>
        <Textarea id={`edit-message-${ordinal}`} aria-label="编辑消息内容" autoFocus value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Escape') { event.preventDefault(); setEditing(false); } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} className="min-h-24 resize-y bg-background text-sm" />
        <p className="text-xs leading-5 text-muted-foreground">重发会作为新消息再次执行，原消息和已完成的操作不会撤销。图片需重新添加；Ctrl/⌘ + Enter 重发，Esc 取消。</p>
        <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>取消编辑</Button><Button type="submit" size="sm" disabled={busy || !draft.trim()}>保存并重发</Button></div>
      </form> : <>
        <div className={cn('whitespace-pre-wrap text-sm leading-relaxed', user ? 'rounded-2xl rounded-br-sm bg-secondary px-4 py-2.5 text-secondary-foreground' : '')}>
          {user ? message.content : <AssistantMessage content={message.content} />}
          {message.editedFrom && <p className="mt-2 text-xs text-muted-foreground">由第 {message.editedFrom} 条消息编辑后重发</p>}
          {message.imported && <p className="mt-2 text-xs text-muted-foreground">历史导入记录 · 未重放操作</p>}
          {message.mock && <div className="mt-2"><MockBadge /></div>}
          {message.failed && <div className="mt-2"><span className="inline-flex items-center rounded-md border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">执行失败 · 可重发重试</span></div>}
        </div>
        <div role="group" aria-label={`第 ${ordinal} 条消息操作`} className={cn('mt-1 flex min-h-7 items-center gap-1 transition-opacity md:opacity-0 md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100', user && 'justify-end', copyState !== 'idle' && 'md:opacity-100')}>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`复制第 ${ordinal} 条消息`} title={copyState === 'copied' ? '已复制' : '复制消息'} disabled={copyState === 'copying'} onClick={() => void copy()}>{copyState === 'copied' ? <Check className="size-3.5 text-teal-600" /> : <Copy className="size-3.5" />}</Button>
          {user && <Button type="button" variant="ghost" size="icon-xs" aria-label={`编辑第 ${ordinal} 条消息`} title={busy ? '任务执行中，暂不可编辑' : '编辑消息'} disabled={busy} onClick={() => { setDraft(message.content); setEditing(true); }}><Pencil className="size-3.5" /></Button>}
          <span role="status" className="text-xs text-muted-foreground">{copyState === 'copied' ? '已复制' : copyState === 'copying' ? '正在复制…' : ''}</span>
        </div>
        {copyState === 'failed' && <p role="alert" className="mt-1 text-xs text-destructive">复制失败，请选中文字手动复制。</p>}
      </>}
    </div>
    {user && <User className="mt-1 size-5 shrink-0 text-muted-foreground" />}
  </div>;
}
