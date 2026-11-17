import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatMessageRow } from '../ChatMessageRow';
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => { cleanup(); if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard); else Reflect.deleteProperty(navigator, 'clipboard'); });
function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } }); return writeText; }
it('复制用户消息和模型原始Markdown，并显示复制反馈', async () => {
  const write = clipboard(); const noop = vi.fn();
  render(<><ChatMessageRow message={{ role: 'user', content: '班会\n19:00' }} ordinal={1} busy={false} onResend={noop} /><ChatMessageRow message={{ role: 'assistant', content: '**安排**\n- 班会' }} ordinal={2} busy={false} onResend={noop} /></>);
  fireEvent.click(screen.getByRole('button', { name: '复制第 1 条消息' }));
  expect(await screen.findByText('已复制')).toBeVisible(); expect(write).toHaveBeenLastCalledWith('班会\n19:00');
  fireEvent.click(screen.getByRole('button', { name: '复制第 2 条消息' }));
  await waitFor(() => expect(screen.getAllByText('已复制')).toHaveLength(2));
  expect(write).toHaveBeenLastCalledWith('**安排**\n- 班会');
  expect(screen.queryByRole('button', { name: '编辑第 2 条消息' })).toBeNull();
});
it('复制权限失败明确提示，不冒充已复制', async () => {
  clipboard(vi.fn().mockRejectedValue(new Error('NotAllowed')));
  render(<ChatMessageRow message={{ role: 'user', content: '测试' }} ordinal={1} busy={false} onResend={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '复制第 1 条消息' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('复制失败'); expect(screen.queryByText('已复制')).toBeNull();
});
it('复制历史协议异常只复制可见提示，不复制隐藏DSML', async () => {
  const write = clipboard();
  render(<ChatMessageRow message={{ role: 'assistant', content: '<｜｜DSML｜｜ calls>隐藏内容</｜｜DSML｜｜ calls>' }} ordinal={2} busy={false} onResend={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '复制第 2 条消息' }));
  await screen.findByText('已复制'); expect(write.mock.calls[0][0]).not.toContain('DSML'); expect(write.mock.calls[0][0]).toContain('不能视为已完成');
});
it('编辑预填原文、取消不发送；保存重发只回调修改后的文字', () => {
  const resend = vi.fn(); const message = { role: 'user' as const, content: '原来的班会安排' };
  render(<ChatMessageRow message={message} ordinal={1} busy={false} onResend={resend} />);
  fireEvent.click(screen.getByRole('button', { name: '编辑第 1 条消息' }));
  expect(screen.getByRole('textbox', { name: '编辑消息内容' })).toHaveValue(message.content);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '修改后' } });
  fireEvent.click(screen.getByRole('button', { name: '取消编辑' })); expect(resend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '编辑第 1 条消息' }));
  expect(screen.getByRole('textbox')).toHaveValue(message.content);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  修改后班会安排  ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并重发' }));
  expect(resend).toHaveBeenCalledExactlyOnceWith('修改后班会安排'); expect(message.content).toBe('原来的班会安排');
  expect(screen.queryByRole('textbox')).toBeNull();
});
it('任务运行时不能编辑但仍能复制；空白不能提交，Esc取消', () => {
  const resend = vi.fn(); const props = { message: { role: 'user' as const, content: '测试' }, ordinal: 1, onResend: resend };
  const view = render(<ChatMessageRow {...props} busy />);
  expect(screen.getByRole('button', { name: '编辑第 1 条消息' })).toBeDisabled(); expect(screen.getByRole('button', { name: '复制第 1 条消息' })).toBeEnabled();
  view.rerender(<ChatMessageRow {...props} busy={false} />); fireEvent.click(screen.getByRole('button', { name: '编辑第 1 条消息' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } }); expect(screen.getByRole('button', { name: '保存并重发' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); expect(screen.queryByRole('textbox')).toBeNull(); expect(resend).not.toHaveBeenCalled();
});
