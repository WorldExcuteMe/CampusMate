// DSML is an internal tool envelope, never evidence that an operation ran.
// Do not parse arbitrary assistant text into executable calls: require native
// tool_calls or the existing allowlisted JSON protocol in the runtime.
export const TOOL_PROTOCOL_ERROR = '模型返回了未解析的工具调用标记，本条没有可靠的执行结果，不能视为已完成。工具协议修复后，请重新发送这条请求。';
export function hasRawToolMarkup(content: string): boolean {
  return /<\s*\/?\s*[|｜]+\s*DSML\s*[|｜]+/i.test(content);
}

// Hold a small suffix so a DSML marker split across streaming chunks cannot
// flash in the draft UI. Ordinary prose still streams; raw tool markup doesn't.
export function protocolSafeStream(emit: ((text: string) => void) | undefined) {
  let tail = '', blocked = false;
  return {
    push(text: string) {
      if (blocked || !emit) return;
      tail += text;
      if (hasRawToolMarkup(tail)) { blocked = true; tail = ''; return; }
      const safe = Math.max(0, tail.length - 128);
      if (safe) { emit(tail.slice(0, safe)); tail = tail.slice(safe); }
    },
    finish() { if (!blocked && emit && tail) emit(tail); tail = ''; },
  };
}
